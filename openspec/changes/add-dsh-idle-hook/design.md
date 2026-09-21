# Design

## Context

需求与动机见 `proposal.md`，行为契约见 `specs/idle-hook/spec.md`。这里只记录塑造实现的现状与约束：

- DSH 的智能体状态只有两种：`AgentStatus = 'idle' | 'running'`（`packages/core/agent/src/runtime-types.ts:109`）。**没有** `waiting` 之类的第三种取值。
- 「等待人类批准 / 等待人类回答」**不是状态**：这两种情形下智能体仍然处于 `running`。宿主侧**不存在**任何「这个人是否在等人」的谓词——`ApprovalService` 只有 request/setPolicy/overrideOf/effectivePolicy，`UserQuestionService` 只有 `ask()`，`Gateway` 的 `pendingRemoteEvents` 是私有的。
- `agent/status` 的 `idle` 边沿**不等于**「一轮结束」：内部的维护阶段（maintenance）也映射为 `idle`，且 `turn/end` 之后 driver 可能紧接着开始下一轮。
- 宿主插件就是 dsh 进程内的普通 Node ESM 模块（`apply/inject/name`），可以 `node:child_process`；仓库硬规则是**宿主半零 `@deepseek-ai/*` import**（`docs/knowledge/2026-09-09-plugin-host-half-no-core-import.md`），能力只能经 `inject` + `ctx` 取得。
- 设置服务支持「对象数组」形态的命名空间（`settings.installSection(owner, ns, schema, entry, hooks)`，schema 用 schemastery；仓库内已有 `allowedModels: z.array(z.object({...}))` 先例），持久化到 `<DSH_HOME 或 ~/.dsh>/settings.yaml`。注意 `mergeLayers` 对数组是**整体替换**。
- 页面只是 dsh 进程的一个客户端；关掉页面不会停止宿主插件或智能体。宿主侧**没有**「当前有没有页面连接」的公开 API，只能由插件自己维护心跳。

## Goals / Non-Goals

**Goals**

- 触发链路对 DSH 是**纯观察**：任何情况下都不改变、不延迟、不阻断批准/提问/回合推进。
- 判定「什么时候该响」所用的信号必须**精确**：宁可不响，也不要在 driver 续跑下一轮、或策略自动放行批准时误响。
- 设置页之外零配置：用户不写代码、不改 YAML 也能用；一切执行都可追溯（谁触发、结果如何）。

**Non-Goals**

- 不做浏览器原生通知（归 `dsh-notification`），不注册面向模型的工具。
- 不做脚本之间的编排/依赖/顺序（每条规则独立）。
- 不解析、不摘要对话内容；不把会话正文交给脚本。
- 不做跨机器/远程执行：脚本在本机、以 dsh 进程的身份执行。

## Decisions

### D1 触发放在宿主半，而不是客户端半

**决定**：监听与进程执行都在宿主半（`src/index.js`）。

**理由**：用户明确要「关掉页面也能收到通知」；宿主半活在 dsh 进程里，不依赖页面。客户端半只承担两件它才能做的事：设置界面、页面在场心跳。

**备选**：客户端半监听（实现更简单、与界面状态天然一致）——已否决，因为合上笔记本/关掉页面后它就不响了，而那正是最需要通知的时刻。

### D2 用 `turn/end` 而不是 `agent/status === 'idle'` 判定「一轮结束」

**决定**：订阅 `ctx.on('session/event', (session, event) => ...)`，取 `event.type === 'turn/end'`（每回合恰好一次，落在 `turn()` 的 finally 里，且**先于** driver 的 idle 边沿），按 `event.reason.kind` 套触发矩阵；再确认该智能体当前确实空闲且无排队输入（`status === 'idle'`、`inbox.nextTurn`/`nextStep` 为空）后才执行。

**理由**：`turn/end` 带原因、一轮一次、可区分「用户自己停的」；`agent/status` 只有 idle/running 两值，maintenance 也映射为 idle，且在「一个回合刚结束、driver 立刻开始下一轮」的场景下会给出误导性的 idle 边沿。

**备选**：只监听 `agent/status` 的 idle 边沿（`packages/schedule/schedule/src/index.ts:52-61` 的既有写法）——已否决，它无法实现 spec 里「回合紧接着继续跑时不算数」与「自己按的停止不响」两条。

### D3 「等待人类」用两个瀑布，且必须 `prepend` + 立即 `return next()`

**决定**：
- 等待批准 → `ctx.on('approval/request', (req, next) => { void fire(...); return next() }, { prepend: true })`
- 等待回答 → `ctx.on('user-questions/request', (req, next) => { void fire(...); return next() }, { prepend: true })`
- 两条都只观察：**不 await** 脚本（`void` + 内部 try/catch），**原样返回** `next()` 的结果。

**理由**：批准/提问在宿主侧唯一精确的「人正在被问」信号就是这两个瀑布。Cordis 的 waterfall 是链式 `next()`：宿主自己也注册了一个瀑布监听把请求转发给浏览器（`packages/api/remotes/src/index.ts`），而**链的顺序就是注册顺序**——注册晚了就轮不到我们（客户端一旦应答，链就结束了）。因此必须 `prepend: true`。只观察还不够：监听器若吞掉 `next()` 或不返回它的结果，批准会被规范化成 `'unavailable'`（fail-closed），提问会拿到 `undefined`——这正是 spec 里「脚本卡住也不影响批准」那条要守住的。

**备选**：读只读审计事件 `approval/asked` / `approval/decided`（经 `session/event` 到达）做「asked 未被 decided」配对——已否决为主要手段：策略自动放行时两者几乎同时落下，配对需要时间启发式，不满足「宁可不响也不误响」；且用户提问根本**没有**这类持久事件（只有瀑布）。保留它作为实现时的辅助信号（例如用于日志/去重）。

### D4 规则配置存 DSH 设置命名空间，历史存独立文件

**决定**：规则 → `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook:` 命名空间（对象数组）；执行历史 → `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`（滚动 200 条）。

**理由**：用户明确选了「跟着 DSH 设置走」；设置服务已验证支持对象数组，且能让手工编辑生效。历史是高频、可丢弃的数据，塞进设置文件会把 settings.yaml 撑大、并让每次 UI 写入都重写整份文档，所以分成两个文件。

**备选**：全部放插件自有 JSON（更自由，但用户看不进 DSH 配置体系）；全部放设置文件（写入放大）。

**已知约束**：宿主半不能静态 import schemastery（零 core import 规则）→ 采用 esc-rewind 的既有形态：**动态 `import('@deepseek-ai/schemastery')` 包在 try/catch 里 + 零依赖 fallback schema**（可调用且带 `toJSON()`），保证命名空间在任何情况下都能注册。客户端写规则时**整份替换**数组（`mergeLayers` 不逐元素合并）。

### D5 页面在场判定 = 客户端心跳，而不是任何宿主 API

**决定**：客户端半每 5 秒向 `/__idle-hook/presence` POST 一次 `{ visible, focused }`；宿主半记录 `lastSeen`，超过 30 秒没有心跳即判定「页面关着」。三档「触发前提」由规则字段决定：`any` / `page-closed` / `page-hidden-or-blurred`。

**理由**：宿主没有页面存在性 API（`pendingRemoteEvents` 私有、断线只是从投递表里移除），心跳是唯一可靠来源；阈值 30s ≫ 心跳 5s，避免刷新/重连时抖动误判。插件自有 HTTP 前缀路由有先例（dsh-plugin-manager 的 `/__dsh-plugin-manager/*`），客户端只需 `fetch`。

**备选**：不做互斥（会和 `dsh-notification` 双响）；用 `document.hidden` 单向判定（拿不到「页面已关闭」，也拿不到失焦）。

### D6 进程执行用 `node:child_process.spawn`，参数数组直传，默认不过 shell

**决定**：`spawn(interpreterOrFile, args, { cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true })`；按扩展名映射解释器（`.py`→`python`、`.bat`/`.cmd`→`cmd /c`、`.ps1`→`powershell -File`、`.sh`→`bash`、其它直接执行）；`shell: true` 只由规则的显式开关开启（开启时命令与参数拼成一条字符串）。

**理由**：宿主插件是普通 Node，`node:child_process` 是内建模块、不触碰零 core import 规则；argv 数组直传让带空格的路径与参数原样到达且无注入面；跨平台一致（Windows 上 `.bat` 必须经 `cmd /c`）。

**备选**：`ctx.shell`（DSH 的 ShellExecutor）——已否决：它的语义是「执行一条 bash 命令」，会经过沙箱策略与 `@deepseek-ai` 服务注入，而本插件的目标是「执行用户指定的任意可执行文件/解释器脚本」，且我们要求宿主半零 core import。

### D7 上下文经 stdin JSON 承载全量，环境变量只给 ASCII 安全子集

**决定**：stdin 写 UTF-8 JSON：`{ sessionId, sessionTitle, cwd, reason, reasonDetail, triggeredAt, ruleId, ruleName }`；环境变量 `IDLE_HOOK_SESSION_ID / _CWD / _REASON / _TIME`。中文标题**只**走 stdin。

**理由**：Windows 的环境变量编码（GBK/代码页）会毁掉中文，而 bat 脚本读 stdin 又别扭——所以两边都给：env 保证 bat/一行命令能拿到结构化关键值，stdin 保证任何语言都能拿到完整含中文的上下文。会话标题不是 Session 的字段，需经注入的 `sessionTitle` 服务取；取不到时降级为不传标题（不影响触发）。

### D8 「试跑」不计入失败计数

**决定**：试跑走同一套调用契约与落盘历史，但**不**参与「连续失败 3 次自动停用」。

**理由**：调试一条写坏的规则会被自动停用，用户会以为插件坏了；自动停用只该由真实触发驱动。

### D9 预置示例规则默认禁用 + 全局总开关默认开

**决定**：首次打开设置页写入一条禁用的 macOS 提示音示例；总开关默认开。用户明确启用任何规则之前不执行任何进程。

**理由**：既演示字段怎么填，又满足「未经我同意不要在机器上执行东西」。

### D10 与 `dsh-notification` 互斥的具体默认

**决定**：规则的「触发前提」三档、新规则默认 `any`；**预置示例规则与 README 推荐**用 `page-closed`，从而与 `dsh-notification`（只在页面开着时响）天然不重复。用户日后删除 `dsh-notification` 时，把规则改成 `any` 即可。

**理由**：这是用户两轮回答的调和：第 2 轮要求「仅当我没在看时触发」默认关（= 字段默认 `any`），第 7 轮要求「一轮结束规则默认只在页面关着时触发」（= 示例/推荐默认 `page-closed`）。字段支持三档让两种意图都成立。

### D11 文件与命名

插件包 `dsh-idle-hook`，按 2026-09-10 起的仓库规则放在 `sub-plugins/` 下、**不声明 `dsh.bundle`、不带自带 `cordis.patch.yml`**（激活行由管理器维护，避免与包自带 patch 撞 id）；设置页标签「空闲通知」、设置命名空间 `idle-hook`、HTTP 前缀 `/__idle-hook`、设置 section 的 `order: 19`（核心占用 0/10/15/20，仓库内 16=本地插件、17=Hindsight 模型，60=dsh-notification）。

### D12 环境变量：两层配置 + 契约优先

**决定**：全局（插件级）一份 + 规则级一份；合并顺序 = 继承进程环境 → 全局 → 规则 → `IDLE_HOOK_*` 契约。`IDLE_HOOK_*` 键在合并时被显式跳过（不参与覆盖），保存时只提示不报错。变量值支持占位符；历史只记键名。

**理由**：密钥类变量（`NOTIFY_ACCESS_KEY`）必须能只配一次；而「A 规则发 POPO、B 规则只发邮件」又要求规则能覆盖。契约优先是为了让脚本看到的触发上下文永远是真值——若允许覆盖，会出现「脚本收到的会话信息是假的」这类极难排查的问题，所以宁可忽略并提示。

**备选**：只做全局（无法按规则区分渠道）；只做规则级（密钥要重复填）；允许覆盖契约（自由但会制造无法自查的假上下文）。

**实现约束**：环境变量值会明文落在 `<DSH_HOME 或 ~/.dsh>/settings.yaml`（与规则参数同级），文档 MUST 讲清楚；历史与试跑回包 MUST NOT 回显变量值（历史只存键名）。

## Risks / Trade-offs

- **[瀑布截断]** 监听 `approval/request` 的工具若吞掉 `next()`，会让批准 fail-closed → **缓解**：`{ prepend: true }` + 立即 `return next()`、脚本调用包在 `void Promise.resolve().then(...)` 里（保证同步不抛）；`test/` 写「链上后续监听器仍被调用、且其返回值被原样返回」的断言；提问链路同。
- **[无页面时批准永不结算]** 批准/提问在零客户端时会一直挂着 → **缓解**：只观察、绝不 await、绝不依赖客户端应答；把这种状态当作正常触发场景（spec 有专门场景）。
- **[误响]** `turn/end` 后 driver 立即续跑 → **缓解**：触发前确认 `status === 'idle'` 且收件箱为空。
- **[schemastery 不可用]** 宿主半不能静态 import → **缓解**：动态 import + 零依赖 fallback schema；fallback 只做「注册 + 透传」，不追求强校验（客户端提交前自行校验字段）。
- **[数组整体替换]** 两个页面/多标签同时编辑规则会互相覆盖 → **缓解**：客户端在每次写前重新 `describe()` 取最新文档，且每次提交整份规则数组；文档里声明「同一时刻只在一个页面编辑规则」。
- **[自动停用误伤]** 临时故障（如 PATH 抖动）连续 3 次会停用规则 → **缓解**：规则被停用时在设置页醒目说明原因与时间；重新启用即清零；阈值固定为 3 且写进 spec。
- **[Windows 无法本机验收]** 本机是 macOS → **缓解**：解释器选择/参数拼装/占位符替换做成纯函数（`src/host-core.js`）并用 `node` 单测覆盖；ACCEPTANCE 里把 Windows 真机项显式标注为「需你在 Windows 上验」。
- **[通知风暴]** 多会话、多规则同时命中 → **缓解**：同规则去抖（默认 3s）+ 同规则并发跳过；文档建议一条规则只对一个通道。

## Migration Plan

1. 交付子插件 `sub-plugins/dsh-idle-hook/`（按 2026-09-10 起的规则：**不声明 `dsh.bundle`、不带自带 `cordis.patch.yml`**，激活行由管理器维护），在 dsh-plugin-manager 的「本地插件」面板里启用（宿主半立即生效、刷新页面后界面出现）。
2. **无数据迁移**：全新命名空间与全新历史文件；不会读写任何既有插件的配置。
3. 回滚：在面板里停用该插件（宿主半立即停止触发与执行）；如需彻底清理，删除 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`、并移除 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 中的 `idle-hook:` 段。
4. 可选后续：用户确认不再需要浏览器原生通知后再停用 `dsh-notification`（本变更不自动做这件事）。

## Open Questions

- 示例脚本里 POPO 的 `X-Notify-AccessKey` 用环境变量还是规则参数承载？（纯文档层，不影响 spec 与实现；倾向环境变量，避免密钥写进 `settings.yaml`。）
- Windows 通知示例用哪条路径（PowerShell 原生 toast vs `msg`）——两条都给、由用户选，不需要现在决定。
