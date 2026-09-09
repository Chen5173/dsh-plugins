## Context

- v1（已归档：`openspec/changes/archive/2026-09-09-add-composer-provider-label`，能力规格在 `openspec/specs/composer-provider-label/spec.md`）的标签是只读 `span`，挂在 `conversation.input.right`（additive 空槽，`replaceRisk: 'none'`），核心模型座位在紧邻右侧的 `conversation.input.model`（single，本设计不碰）。
- 写入路径唯一：`ctx.remote.session.selectModel({sessionId, provider, model, reasoningEffort?})`（`packages/api/session-controller/lib/typert.remote-client.d.ts:29/51`，同属 0.1.2-rc.1 已发布类型面）；宿主在该调用内**顺带**保存 profile 默认模型（`src/commands.ts:138-144`），这是宿主行为，无法规避。
- `ModelSelection` 永远是「提供方 + 模型（+可选推理档）」的完整组合（`src/types.ts:82-87`），没有"只选提供方"的状态。
- 可用 UI 原语：`@deepseek-ai/dsh-client-ui-primitives` 导出 `Menu`（自首个骨架提交 `a6a3807a07` 起）、`Tooltip` 与图标；浏览器半的 `require('@deepseek-ai/dsh-client-*')` 走客户端模块表，安全（`docs/knowledge/2026-09-09-plugin-host-half-no-core-import.md` 规则 3）。
- 宿主半禁止 `@deepseek-ai/*` import（同上规则 1）；本插件宿主半的 settings 段依赖 schemastery，实测在 `link:` 安装形态下 `import('@deepseek-ai/schemastery')` 报 `ERR_MODULE_NOT_FOUND` → v1 的 `providerAliases` 实际不生效。

## Goals / Non-Goals

**Goals:**

- 标签成为提供方/模型两级选择入口，提供方可直接点选并写入，模型列可在「全部提供方 / 仅当前提供方」间切换。
- 保留 v1 的全部只读能力（解析、别名、三类刷新信号、tooltip、主题与语言跟随）。
- 写权限收敛到单点，且可被测试审计。

**Non-Goals:**

- 不替换或隐藏核心模型座位、不做 DOM 干预（核心座位与本菜单读同一份 per-session 投影，天然同步）。
- 不实现推理档选择（只继承）、不做搜索框、不做方向键导航、不做「设为默认模型」入口。
- 不修 schemastery 解析通道，不新增 settings 键（见 D6）。
- 不改宿主半（`src/index.js` 保持不变）。

## Decisions

### D1 菜单用 `Menu` 原语 + 自管 pane，不用 submenu

`Menu` 的 `submenu` 能力实测不适合本场景：`openSubmenuId` 是内部状态、外部无法控制（`Menu.tsx:100,206-219`），因此"点完提供方自动进入模型列表"做不到；子卡片行不支持勾选（`Menu.tsx:232-244`）；只要存在 submenu 行就关闭滚动上限（`Menu.tsx:190`），长模型列表会顶出屏幕；子卡片无视口夹取（`Menu.module.css:227-234`）。
**选择**：一张卡片内由我们自己的 `pane` 状态切换 `items`（`root` / `provider` / `model`）。代价是返回行要自己加；收益是滚动上限、勾选（`selectedId`）、footer 常驻、Esc/外部点击全部由原语负责。
**备选**：完全手写菜单（观感最接近核心，但要自写定位/外部点击/Esc/滚动，脆弱面更大）。

### D2 原地渲染 + `side=top`

`Menu` 的 portal 模式只在打开/滚动/尺寸变化时重算位置（`Menu.tsx:109-155`），pane 切换导致高度变化会留下错位。核心模型座位在同一位置就是**原地渲染**（`ModelSelect.tsx:240-352`），已证明 composer 内可行。
**选择**：原地 + `side='top'`，让卡片随高度变化自动跟随。
**备选**：portal（裁剪更安全，但 pane 切换错位需要额外处理）。

### D3 写入 = 单一白名单接口，完整组合提交

`selectModel` 是唯一写路径；`provider` 与 `model` 永远一起提交。宿主连带更新默认模型属宿主行为，界面不提示（与核心座位一致）。
**审计**：能力审计从"零改状态 Remote"改为白名单 —— 只允许 `session.selectModel`（写）与 `session.modelCatalog` / `settings.describe`（读），其余改状态接口仍禁止。

### D4 点提供方的选模型规则

同 provider 且当前模型仍在该 provider 的可用列表中 → 保留；否则若目录默认模型属于该 provider → 用它；否则取该 provider 列表第一个。
**理由**：`ModelSelection` 必须完整；保留当前模型避免多余切换；默认优先贴近用户既有偏好；"当前模型已不在列表"时绝不提交可能无效的模型。

### D5 effort 继承

新模型若在目录中登记了推理档，且当前 effort 属于其 `efforts` → 保留；否则省略该字段（落到提供方默认）。
**理由**：不静默改变用户设置，同时不提交新模型不支持的档位。

### D6 显示范围偏好只存 localStorage，不新增 settings 键

localStorage 键 `dsh.composer-provider-label.v1`，值 `{ scope: 'all' | 'provider' }`，默认 `all`；跨会话与刷新保持。
**理由**：settings 通道在 `link:` 安装形态下不可用（schemastery 解析失败），加键会得到"半死"配置；v1 的 `providerAliases` 失效事实记入 README/ACCEPTANCE 已知限制。
**备选**：用 profile 锚定的 `createRequire` 复活 settings 通道（可行但新增对 profile 路径的依赖，且与 2026-09-09 规则精神相冲）——本次不做。

### D7 容错与降级

- 目录未就绪：不渲染占位（v1 行为）；目录失败：渲染错误态入口，点开触发重新加载。
- 菜单内失败：顶部一行「重试加载」，失败的提供方置灰并附失败说明。
- 写入中：标签半透明 + `aria-busy`；写入失败：标签内联错误指示 + tooltip 说明，路由不变。
- `Menu` 原语缺失：降级为 v1 只读标签（不报错）。
- 子代理会话（`available=false`）：菜单可开，选择项禁用并说明原因。

### D8 当前路由的提供方未广告时的合成行

提供方级列表 = 目录 `groups`（catalog 顺序）+ `failures`（置灰）；若当前路由的 provider 不在其中，顶部合成一行并标明「当前路由」。
**理由**：避免"当前项不在列表里"的错觉，也让用户能看到自己实际打在哪条线上。

### D9 文案与外观

行文案：提供方 = 别名 + displayName 副文本；模型 = 短名 + 完整 id 副文本；当前项打勾。tooltip 增加 effort 字段。全部沿用 `--dsw-*` 变量与既有语言字典（zh/en），标签文本本身不翻译。

### D10 测试与验收

逻辑测试从 26 扩到 ≥40，覆盖：写入调用与参数形状、D4 规则、D5 继承、范围开关与持久化、禁用/失败/降级、审计白名单。ACCEPTANCE 追加菜单与开关的手工清单，并保留 v1 遗留的 GUI 项（由用户走）。`npm pack` 文件清单复核，确保无多余文件泄漏。

### D11 长列表高度上限用一条作用域样式表实现

`Menu` 原语只给卡片 `max-height: calc(100vh - 24px)`，而原地渲染没有视口夹取：模型多时卡片会向上长出自己的首行（用户实测「看不到最上面的模型」）。原语没有高度 prop，卡片 DOM 也拿不到。
**选择**：给 `Menu` 传作用域 `className`，并由插件注入一条只作用于该 className 的样式，把内容区限制在 224px（五行 dense 行 34px + 返回行 + 分隔 + 内边距）并开启内部滚动；footer 常驻在卡片底部，不随内容滚动。
**备选**：改用 portal 模式（原语会夹取视口，但 pane 切换改高度时位置不重算 → 卡片错位）；把列表截断成「更多…」（与"滑动寻找"的诉求不符）。
**代价**：这是本插件唯一的 DOM 写入（一个 `<style>` 元素，选择器锚定在自己传的 className 上，不会外溢到其它菜单）；无 `document.head` 时静默跳过，退回原语自身的视口上限。

## Risks / Trade-offs

- [宿主顺带改默认模型，用户可能意外] → 与核心座位行为一致，不额外提示；若日后需要，可加次级入口。
- [Menu 原语在更老/更精简的客户端缺 `Menu`] → D7 降级为只读标签；peerDeps 保持 `^0.1.1-rc.2`，版本地板不变。
- [长模型列表顶出屏幕] → 无 submenu 行时原语自带滚动上限（`Menu.module.css:67-79`）。
- [localStorage 被清空或不可用] → 回退默认 `all`，不报错（沿用时间桶插件的 `getStorage()` 模式）。
- [子代理会话误写] → 客户端按 `available` 禁用；宿主侧本就会拒绝（`session/agent-busy`）。
- [v1 的 `providerAliases` 仍失效] → 本次记入文档已知限制，不制造"配置能改"的错觉。

## Migration Plan

无数据迁移。升级路径：替换插件目录内容 → 重启/热重载宿主 → 客户端硬刷新；回滚：还原上一版插件目录（localStorage 键可留，不影响 v1）。偏好键为新增，v1 不认识也不会读。

## Open Questions

无。
