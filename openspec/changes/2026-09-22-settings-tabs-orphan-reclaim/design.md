## Context

动机见 `proposal.md`。本节只记约束与本轮只读核对过的事实。

- **esc-rewind 现状**：客户端半是浏览器 classic-script bundle（无构建、`__ModuleLoader__.load`）已用 `slots.register` 注册会话头控件与 `/rewind` 命令，并已用 `sessions.fork/open/rename` 实现回退；宿主半是 cordis 插件（`inject: []`、只懒取注入服务、**不 import 核心包**），已提供删除通道 `POST /__esc-rewind/session/delete`、只读探针 `GET /__esc-rewind/status`、模型工具与会话头处置开关的 settings 命名空间。
- **孤儿的可达性事实**（本轮核对，均在已安装核心源码中）：侧栏不渲染子代理行——`packages/client/ui-workspace/src/client/tree.ts:146`（`session.origin !== 'subagent'`）；子代理只按**自身 header** 的 `parentSession` 被列举——`packages/subagent/subagent/src/list-children.ts:90`；完成通知投给父会话 agent——`packages/subagent/subagent/src/continuation-activation.ts:823`（`ctx.agents.get(activation.parentSession)`，父缺席即静默 return）；投递授权按 header 校验——`packages/api/session-controller/src/history.ts:346`。宿主**没有** reparent/adopt verb ⇒ 「改挂到新会话」不可实现。
- **fork 语义**（`packages/api/session-controller/src/commands.ts` 的 `fork`）：边界=第一个 `seq ≥ atSeq` 的 `turn/end`，`cut` 从边界走到下一个 `turn/start`；新会话 `parentSession = 源 id`、`isSeeded: true`、`origin` 为空、沿用源 workspace ⇒ **出现在侧栏且可继续**，这正是「找回」可用的依据；无边界时报 `session/fork-unavailable`。
- **设置页机制**：`settings.section` 是 list 槽，每次注册 = 设置左侧导航的一行；`settings.plugins.tab` 由核心 `ui-settings-plugins` 在运行期声明（`packages/client/ui-settings-plugins/src/client/index.ts`），它**独占唯一的「插件」导航行并渲染 tab chrome**，tab 首次选中时挂载、之后保持挂载（本地草稿态不丢）；贡献范式见 `packages/client/ui-settings-plugin-inventory/src/client/index.ts`。核心 slot registry 只允许注册到**父项已声明**的槽，未声明槽直接抛错（`packages/client/ui-slots/src/index.ts` 的 register 校验）。
- **本仓现状**：注册 `settings.section` 的只有 `dsh-plugin-manager`（local-plugins，order 16）、`dsh-hindsight-model`（17）、`sub-plugins/dsh-idle-hook`（19）；`dsh-idle-hook` 尚无 spec of record。

## Goals / Non-Goals

**Goals:**

- 不可达孤儿**看得见**（计数 + 列表 + 事实字段）、**可止损**（停止）、**可继续用**（找回成普通会话）。
- 本仓插件的设置内容收拢为核心「插件」页里的 tab，设置导航只留核心一行。
- 零核心改动、零新依赖、不 import 核心包；宿主半改动仅在删除/诊断同源文件里增量。
- 全手动：任何处置动作都由用户显式触发。

**Non-Goals:**

- 不提供「删除孤儿」动作（用户本轮未选；删除语义另有既有删除通道，日后需要可另开变更）。
- 不实现 reparent/改挂（核心无此能力，header 不可变）。
- 不改核心包、不改核心设置页自身（只贡献 tab）。
- 不做启动/定时自动动作（自动停止会中断仍想救回内容的子代理）。
- 不为 `dsh-idle-hook` 补建 spec（其入口迁移只记账在 README/ACCEPTANCE）。

## Decisions

**D1 入口使用核心 `settings.plugins.tab`，不自建入口。**
理由：核心已提供「一个入口 + tab」的机制，且契约注释明确「feature plugins contribute pages without competing for Settings nav rows」；有现成范式（`ui-settings-plugin-inventory`）。
否决：① 自建一级入口 —— 核心 slot registry 只允许注册到父项声明的子槽，插件无法凭空造出新的设置导航行；② 把回收面板塞进管理器面板 —— 跨 bundle 依赖，且管理器是仓库根安装外壳，不该承载业务面板；③ 会话头再挂一个图标 —— 与用户「设置里只留一个入口」的目标相反。

**D2 孤儿 = 祖先链断裂的不可达子代理（传递判定）。**
可达性判据：`origin === 'subagent'` 且（`parentSession` 不在语料中 **或** 其父自身不可达）。
理由：界面入口只挂在父会话的子代理目录上（`tree.ts` 隐藏子代理行），父不可达则整棵子树都进不去。
否决：只判「父 id 不存在」—— 会漏掉「父本身也是孤儿」的子树（真机现场里 `cbec2279` 的 24 个子代理都是一级，但同类现场可以有链）。

**D3 宿主半只读扫描：`sessionQuery.listSessions()` 为语料源，逐项补事实。**
- 语料：`ctx.get('sessionQuery').listSessions(signal)` 返回全部会话 header（含 `origin`/`parentSession`），一次性判定不可达集合。
- 逐项事实：`running` 取 `ctx.get('agents').get(id)`；`label` 与 `atSeq`（最后一个 `turn/end`）取 `ctx.get('sessionQuery').observeSession(id)` 的事件（label 来自该会话的 `subagent/descriptor` 事件，取不到回退 id）。
- 冷读并发上限 4；单个孤儿读取失败只降级该行（`label=id`、`canRescue=false`）不影响整次扫描。
理由：全部是官方服务，无需 import 核心包；不依赖 `subagents.listChildren`（那是单父列举，无法全局扫）。
否决：读磁盘日志自行解析（重复实现核心格式）；只查运行中会话（冷孤儿恰恰是主体）。

**D4 「停止」复用既有 `stopAgentIfRunning` 形态：cancel + 有上限地等静默，并如实回报是否确认静默。**
理由：宿主半已有该函数（删除通道使用），语义一致；超时不谎报成功。

**D5 「找回」走客户端 `sessions.fork`，宿主只提供 `atSeq`/`canRescue`。**
理由：fork 是官方客户端服务，插件已有回退经验；避免在宿主半再造一条分支通道。找回后 `rename(label)` 沿用标签、`open(childId)` 打开；**不删原孤儿**。
否决：宿主半自建 fork（重复官方能力、且要处理 workspace 归属与 preset 组合）。

**D6 运行中的孤儿「找回」先停后 fork。**
理由：fork 的种子只含已落盘事件，在跑部分进不了种子；且不停会继续烧 token 而其结果无处投递。

**D7 全手动。** 无启动钩子、无定时器；面板打开与用户点「刷新统计」才读。

**D8 tab id/order 约定**：`local-plugins` 20、`hindsight-model` 30、`idle-hook` 40、`subagents` 50（核心自带 `configurable` order 0、`all` order 10 在前；保持与原 16/17/19 的相对顺序）。

**D9 迁移只改注册行**：槽名换成 `settings.plugins.tab`、补 `id`/`order`/`label`，组件主体与其服务注入不变；若某面板依赖 `settings.section` 的 owner props（如 `t`），改用注册项 `locale: NS` 提供的 `props.t` 或 `ctx.locale.bind(NS)` —— 实施时按各插件现状做最小改动。

## Risks / Trade-offs

- [设置导航少三行会被用户当成功能消失] → 三个插件的 README/ACCEPTANCE 明确写「入口已移到 设置 → 插件」，提交信息点明用户可见位置变化。
- [tab 首次选中才挂载，面板有加载延迟] → 面板自带加载/失败/空三态（核心 tab chrome 本就懒挂载）。
- [孤儿很多时一次扫描变慢] → 冷读并发上限 4、label 读取失败即回退 id、面板先渲染列表后补细节。
- [找回会复制对话，磁盘体积翻倍] → 面板展示每个孤儿的最后活动时间与可否找回，逐项/勾选触发，原孤儿保留（用户可自行再处置）。
- [核心版本差异（无 `settings.plugins.tab`）] → 注册被捕获并跳过，诊断字段（`__dsew.orphanTabRegistered`、`/status`）可见原因。
- [running 孤儿的结果永远收不到] → 面板把「停止」置于首位并注明原因，避免用户误以为还能等结果。
- [误停正在做有价值工作的子代理] → 全手动 + 逐项按钮 + 停止前不做二次确认（与插件既有删除模式一致的用户习惯），但面板文案明确「停止=放弃其结果」。

## Migration Plan

1. 先落宿主半（扫描/停止端点）→ 重启 `dsh web`；探针 `GET /__esc-rewind/orphans` 可独立验证（只读）。
2. 再落 esc-rewind 客户端（tab + 面板）→ 刷新页面即生效。
3. 最后迁移三个既有插件的注册行（各自刷新页面即生效，互不影响）。
4. 回滚：三个插件把注册行改回 `settings.section` 即可；esc-rewind 的新 tab 停用后无副作用，宿主半只读端点残留无害。

## Open Questions

- 面板是否额外展示每个孤儿的日志体量（文件大小）？实施时按读取成本决定，不影响规格与任务边界。
- 找回后的新会话是否需要自动带上「来源：孤儿 xxx」的标记（例如标题后缀）？当前决定**不加**（标题沿用标签更贴近用户预期），如需要可后续微调文案，不影响规格。
