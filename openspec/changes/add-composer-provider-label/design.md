## Context

动机见 `proposal.md - Why`；行为契约见 `specs/composer-provider-label/spec.md`。这里只记录塑造方案的核心现状与约束。

**目标槽位是现成的，不用 DOM 注入**

`conversation.input.right` 是 `conversation.composer.bar` 里声明的 **list / session** 槽位（`packages/client/ui-conversation/src/client/contract/slots.ts:135`，slot-catalog 登记 `replaceRisk: 'none'`、当前无占用者）。它在 `InputBar.tsx:461-467` 的渲染位置是：工具行右侧组 **`input.right` → `input.model`（single，核心 ModelSelect）→ 上下文表 → 停止按钮**——即紧邻模型选择器**左边一格**。注入组件能拿到 session 标准 props，其中包含 `sessionId` 与 `useProjection`（slot-catalog 对 `input.right` 的 standardProps 明确列出）。

与之对比的三条"硬路"都被排除：
- `conversation.input.model` 是 **single** 槽，被核心 `client-ui-model-selection ModelSelect` 占住（`replaceRisk: 'shadows-shipped-ui'`）。第三方注册进去等于**遮蔽并重写整个两级菜单**（`ModelSelect.tsx:365` 行：模型/推理档双菜单 + 阻塞态），风险不成比例。
- DOM 注入改写模型触发器文本：核心触发器是 CSS module（`css.triggerLabel`，hash 类名）+ `title`/`aria-label` 均随文案变化，无稳定锚点，升级即碎。
- `conversation.input.dock`（composer 卡片上方整行）与 `input.left`（工具行最左）虽然也是 list 槽，但离模型名太远，语义弱。

**数据全是公开契约，核心已算好同一份"生效路由"**

- `useProjection('modelSelection')`：session 投影，`{lastUsed, next}`，每项 `{provider, model, reasoningEffort?}`；`next = pending ?? lastUsed`，双 null = 尚未有过选择。投影订阅即响应式（切会话/切模型即时重渲染）。
- `remote.session.modelCatalog()`（`@Remote('modelCatalog')`，`packages/api/session-controller/src/index.ts:253`）：一次调用返回 `{default, routableProviders, groups:[{id,name,models[]}], failures[]}`。`group.name` 即 provider 的注册显示名（host 侧 `ctx.llm.listProviders()` 的 `name`，来源是 `displayName`：`llm-pi-ai` 用 `spec.displayName`，无则用 id；`llm-deepseek` 在 `packages/llm/llm-deepseek/src/index.ts:472` 硬编码 `displayName: 'DeepSeek'`）。
- 核心 `ModelDirectory.current` 的规则是 `projected.next ?? catalog.default`（`packages/client/ui-model-selection/src/client/directory.ts` 顶部注释）——**本插件照抄这条规则**，保证两边永远同源。
- 刷新事件：`llm/adapters-updated`、`settings/document-updated`、`connection/reset`（核心 `ModelDirectoryResolver` 监听的就是这三个，见 `packages/client/ui-model-selection/src/client/service.ts:44-49`）。

**关键版本事实**

- `conversation.input.right` 槽位：`dsh-v0.1.0-rc.7` 起存在。
- `session/modelCatalog` 与 `modelSelection` 投影：都是 `dsh-v0.1.2-alpha.1` 起才存在（`git tag --contains` 查得）。→ **peer 下限必须 ≥ 0.1.2-rc.1**（本机已装 0.1.2-rc.1）。

**配置到不了客户端半（实测形态）**

浏览器 boot 清单里 cordis-plugin 视角的行只有 `{id, inject, immediately}`（`packages/client/modules/src/client/manifest.ts:114-122` `BootPluginRow`；`WebBootEntry` 也只有 `{id,url,rev,inject,immediately,external}`），**没有 config 字段**。先例插件 `dsh-session-title-regenerate` 的 `apply(ctx, config)` 只在 **node 半**读行 config，client 半从未读过。结论：Loader 行 `config:` **不会**出现在客户端 bundle 的 `apply(ctx, config)` 里。

客户端可用的配置读法只有 `remote.settings.describe()`（`packages/api/settings-controller/src/index.ts:116`）——返回**全部已注册命名空间**的脱敏分层值 + 序列化 schema。要让"本插件的段"出现，必须先在宿主侧 `settings.installSection(ns, Schema, ...)` 注册（`llm-deepseek` 的做法，`packages/llm/llm-deepseek/src/index.ts:491`）。`settings.yaml` 现约 39KB，`describe()` 一次返回全部——只启动时读一次、按值缓存即可。

## Goals / Non-Goals

**Goals:**

- 一枚**只读** provider 标签，稳定落在模型名左侧，语义是"这条线是谁的"。
- 生效路由、显示名、可配置性全部复用核心的公开契约（投影 + modelCatalog + settings），不复制任何 host 端逻辑。
- 别名可配置（官方 `deepseek-official → office` 开箱即用），且配置段进设置页/`settings.yaml`，用户可见可改。
- 版本/能力不足时静默缺席或降级，绝不让 composer 变坏。

**Non-Goals:**

- 不做 provider/model 双级选择器（用户已确认 v1 只读，交互留给后续变更；见 Open Questions）。
- 不改核心、不遮蔽 single 槽位、不做 DOM 注入。
- 不显示 baseURL / 推理档 / 上下文窗口 / 不可路由告警——不可路由时核心会 block 输入并给出自己的原因文案，本标签不抢这个活。
- 不做"provider 与模型名重复时自动省略 provider"（用户选了照显，一致性优先）。
- 不加"本标签来自插件"的来源标识。
- 会话列表行、会话头部、`/model` 弹窗里的展示都不做。

## Decisions

### D1：注册 `conversation.input.right`，标签只显示 provider

**选择**：`ctx.slots.inject('conversation.input.right', ...)` 注册一个 list 项（`id: 'composer-provider-label'`、`order: 10`、`locale: NS`），组件只渲染一枚弱色纯文本标签（`--dsw-*` token），内容为解析后的 provider 短名；模型名由核心 ModelSelect 自己显示，整行视觉读作 `office · DeepSeek-V4-Flash · high`。

**为什么**：该槽位紧邻模型名、`replaceRisk: none`、零遮蔽、零 DOM 依赖，是唯一"看起来就是模型名前缀"且不碰核心组件的落点。参照 `dsh-composer-history-recall` 注册 `conversation.input.overlay` 的既有先例形态（`inject: ['slots']`，factory 返回 `{apply, inject}`）。

**放弃的替代方案**：遮蔽 `conversation.input.model` 重写 ModelSelect（全量重实现两级菜单）；DOM 注入改触发器文本（无稳定锚点）；放 `input.left`/`dock`（离模型名远，语义弱）。见 Context。

### D2：生效路由 = `projection.next ?? catalog.default`，与核心同规则

**选择**：`useProjection('modelSelection')` 读 `next`；`next` 为 null 时用 `remote.session.modelCatalog()` 返回的 `default` 作为"跟随 profile 默认"的路由；两者都拿不到（投影能力缺失 + 目录拉取失败）则不渲染。

**为什么**：`next` 已在核心侧折叠好"待生效/最近使用"语义（`next = pending ?? lastUsed`），`default` 是 host 给的部署默认——这正是核心 `ModelDirectory.current` 用来渲染模型名的同一份数据。照抄规则 = 标签与模型名**永远不可能对不上**，也不用在客户端重新推导"默认 provider"。

**放弃的替代方案**：用 `lastUsed`（会滞后于未消费的 pending 选择）；用会话请求头 `requestHeader().config.provider`（那是"最近一次已发请求"的线，不是"下一次会用的线"，且空会话没有 header）。

### D3：provider 短名 = catalog 的 `group.name`，剪尾部括号，内置一张只含 `deepseek-official→office` 的表

**选择**：解析顺序（高→低）：① 用户配置 `providerAliases[provider]`；② 内置覆盖表（仅 `deepseek-official → 'office'`）；③ catalog `group.name`（= 注册 displayName）；④ 什么都没有 → 用 provider **id**。第 ③ 步前先做规范化：**剪掉尾部括号段**（`ARK (Coding Plan)` → `ARK`；完整名保留给 tooltip）。别名与裁剪都只作用于**显示**，绝不改写任何 core 数据。

**为什么**：显示名是 provider 自己的声明（含多语言、品牌拼写），内置表只补"官方 provider 名太泛（DeepSeek）"这一个用户明确要的点，其余不预置——`codemaker` 这类没 displayName 的按规则退到 id，并在 README 里告诉用户"想改名就补 displayName 或加别名"。裁剪规则简单可测：去掉末尾 `(...)`（半角/全角括号均可）与相邻空白，空结果则保留原名。

**放弃的替代方案**：全量预置表（维护成本、覆盖不到未来 provider）；只用 displayName 不支持 office（用户已否决）；读 `llm/listConfigurableProviders`（拿不到 default 路由，且要拼第二个数据源）。

### D4：配置走"宿主注册 settings section + 客户端 describe()"，不把配置塞进客户端行 config

**选择**：node 半不再为空——`settingsCtx.settings.installSection(ctx, 'dsh-composer-provider-label', ConfigSchema, {...})` 注册命名空间，schema 只含可选字段 `providerAliases: Record<string,string>`，默认值即内置表（`deepseek-official → office`）。client 半在 apply 期注入 `remote.settings`，启动时调一次 `describe()`，从返回的 namespaces 里取本命名空间的脱敏值作为别名覆盖表，**缓存到模块级**；`describe()` 抛错、无该 ns、或该 ns 值为空 → 静默回退内置表（spec「读取用户配置失败」）。

**为什么**：已核实客户端半拿不到 Loader 行 `config`（Context）。settings section 是唯一既"宿主可写默认值"又"客户端经公开 Remote 可读"且**用户能在设置页 / settings.yaml 里直接改**的通道——顺带把未来的 GUI 配置编辑也预留了。`installSection` 是 host 侧标准做法（llm-deepseek 同款），不是新端点、不开新攻击面。

**取舍**：`describe()` 返回全部 ns（~39KB 一次），只在启动读一次并缓存；`settings/document-updated` 事件会触发重取，让"用户在设置页改了别名"也能热生效（spec「修改提供方显示名或别名」）。

**放弃的替代方案**：客户端读行 config（不存在）；localStorage（不正规、跨设备丢失）；node 半写死再经命令通道转发（为一个配置段造一条命令，过重）；用 `remote.llm.listConfigurableProviders` 的 `settingsPath` 猜段（那是 llm 的段，不是我们的）。

### D5：目录缓存与刷新 = 核心同款三事件

**选择**：client 半自持一份 `modelCatalog()` 结果的模块级缓存（`{generation, value}`）：首次需要时拉取；监听 `llm/adapters-updated` 与 `settings/document-updated` 触发重取；`connection/reset` 丢弃缓存让下次渲染重拉。目录还在途时标签用当前缓存渲染（无缓存则按 D2 只靠投影，仍可能因投影有 `next` 而显示 id——满足 spec「目录拉取失败但路由已知」）。

**为什么**：三事件正是核心 `ModelDirectoryResolver` 订阅的同一组（`service.ts:44-49`），行为对齐、不需要发明新的失效信号；`connection/reset` 换代际后旧名字绝不残留（spec「宿主连接重建」）。

**放弃的替代方案**：每次渲染都调 catalog（每帧一次网关往返）；复用 `ctx.modelDirectories`（核心 Service，`super(ctx,'modelDirectories')` → `ctx.reflect.provide` 在核心自己的作用域，外部 bundle 能否解析到未经验证，不为省一次调用赌内部可见性）。

### D6：tooltip 与无障碍

**选择**：标签是 `button` 外观的只读元素或用 `span` + `title`？——用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`（与核心同款 hover/focus 气泡），字段：provider 完整登记名、模型 id、路由来源（`会话显式选择` / `沿用上一条请求` / `profile 默认`，由 `next` 与 `default` 的命中分支推导）。同时给元素 `aria-label`（如「模型提供方：office」）让键盘用户可读。文案走 locale NS（zh/en）。

**为什么**：spec 要求 hover 与键盘都能核对完整路由；`Tooltip` 是 primitives 里的现成件（先例 bundle 均用），`aria-label` 是廉价的无障碍底线。

**放弃的替代方案**：自绘 popover（无必要）；只 `title` 属性（无焦点样式、无法控文案语言）。

### D7：降级矩阵（对应 spec「能力不足时静默缺席或降级」）

**选择**：

| 情况 | 行为 |
| --- | --- |
| 无 `sessionId`（无会话/欢迎态） | 槽位本就不渲染（InputBar 只在有 sessionId 时 renderSlot `input.right`），无需处理 |
| 无 `useProjection` / 投影无 `next` 且无 `default` | 不渲染 |
| 投影有 `next`（路由已知）但 catalog 拉取失败/未回 | 显示 provider id |
| catalog 有值但该 provider 不在 groups | 显示 provider id（D3 规则④） |
| `describe()` 失败 / 无本插件 ns | 别名回退内置表 |
| 核心 < 0.1.2-rc.1（无 modelCatalog / modelSelection） | 投影 undefined → 不渲染；composer 其余照常 |

**为什么**：每一条都是"宁可少显示、绝不报错/变坏"，与 `dsh-composer-history-recall` 的 D7（能力缺失 = 等同未安装）同哲学。

## Risks / Trade-offs

- **[`conversation.input.right` 不是冻结的公开 API] → 版本钉 + 无声降级**：槽位缺席时 `slots.register` 不会渲染，最坏是标签消失而非白屏；升级核心后按 ACCEPTANCE 回归一条。slot-catalog 把 replaceRisk 标为 none，且该槽位 0.1.0-rc.7 就在，风险低。
- **[`group.name` 可能很长或随供应商变] → 裁剪 + 截断 + tooltip**：尾部括号段剪掉，仍超宽时 CSS 省略号，完整名在 tooltip；改名由事件刷新兜底（D5）。
- **[官方 provider 硬编码名 DeepSeek 与用户要的 office 冲突] → 内置覆盖表 + 可配置**：默认就是 office；用户可在 settings 里改成任何词。
- **[`describe()` 返回全量设置（39KB）] → 只启动一次 + 缓存**：不随每次渲染调用；`settings/document-updated` 才重取。
- **[别名段在 `settings.yaml` 里可见可手改，可能写坏] → schema 校验**：`installSection` 的 Schema 会拒绝非对象/非字符串值，写坏时按"配置读取失败"静默回退内置表。
- **[卸载后用户手写的配置段残留] → README 说明**：残留无害（无注册方时 describe 不含该 ns，插件已不在），文档写明可手动删除。
- **[与其它 composer 插件共槽位行的视觉拥挤] → order 约定 + 验收**：`input.right` 现无占用者；若未来别的插件也注册该槽，靠 order 排序，ACCEPTANCE 里与三枚既有插件共存各看一次。
- **[Trade-off] v1 是独立标签而非改写模型名文本**：牺牲"字面同一段文字"的形式，换来零遮蔽、零 DOM 依赖；视觉上靠紧邻布局补足。

## Migration Plan

**部署**

1. `dsh plugin --profile web add ./dsh-composer-provider-label` —— 写 profile `package.json` 的 `dsh.profile.bundles` 并应用包自带 `cordis.patch.yml`。
2. 重启 `dsh web`（node 半注册 settings section；client 半随 bundle 加载）。
3. 首次进设置页/`settings.yaml` 可见 `dsh-composer-provider-label: { providerAliases: { 'deepseek-official': 'office' } }`。

**回滚**：`cordis.patch.yml` 该行置 `disabled: true`（或 `dsh plugin --profile web remove dsh-composer-provider-label`）→ 重启。插件不写会话数据；卸载后 settings 里手写段残留无害（README 给出清理步骤）。

## Open Questions

- v1 之后的双级 provider/model 选择器（用户 Q4 已声明为后续）：届时可能要让本标签变为可点击入口并复用 `remote.session.selectModel`——是否挪进 `conversation.input.model` 的遮蔽位或给核心提槽位需求，等真正做交互时再评估，不影响本变更任何 spec。
- `describe()` 全量返回在极端大的 settings（数百 KB）下的启动成本：当前 39KB 可接受；若未来变大再评估"只取本 ns"的更轻读法（需要核心加 per-ns read Remote，属另一变更）。
