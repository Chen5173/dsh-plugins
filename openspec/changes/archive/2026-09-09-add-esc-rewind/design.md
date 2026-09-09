## Context

动机见 `proposal.md - Why`；行为契约见 `specs/esc-rewind/spec.md`。这里只记录塑造方案的核心现状与约束。

**DSH 会话日志 append-only，客户端没有"删除消息"这种表达**

`ConversationContextOriginKind 'rewind'/'rewrite'`（`packages/client/ui-chat/src/client/model/conversation-context.ts`）在核心仓库是全仓死代码（无生产者/消费者）；`surface-replace`（`core/session/src/surface.ts`）只能"一段 → 一条新节点"，仅供 `/compact` 宿主内部使用。客户端没有任何 delete/truncate/rewind verb。因此"回退/重开"必须用核心一等公民的**非破坏组合**表达：`sessions.fork({sessionId, atSeq, increaseTitle:false})`（fork 边界 = `atSeq` 之后第一个 turn/end，只切"完整回合前缀"，见 `api/session-controller/.../contract/sessions.ts` fork 注释）+ `workspaces.archiveSession(oldId)`（归档隐藏、日志保留可恢复）+ `sessions.open(childId)` + `inputActions.setDraft(text)`。这与核心"Branch(分叉)/Archive(归档)"行菜单同源，不碰 append-only 日志。

**"真删会话"没有官方客户端通道，只有宿主半自建**

`ISessions` 客户端契约（`api/session-controller/lib/types/client/contract/sessions.d.ts`）只有 create/open/archive 相关/clear/refresh/search，无 delete；`workspaces.delete` 是删 **workspace 注册**（`api/workspace-controller/src/index.ts` 注释明言 *"Remove one Workspace registration while retaining files and Sessions"*），不是删会话。核心唯一接近的是 host 侧 `session/disposed` 生命周期（`core/session`）与 `api-session/removed` 中继——那是会话被宿主处置后的广播，不是插件可调的删除 verb。**真删（磁盘日志 + 投影缓存 + 工作区记账一并移除）必须由插件自己的宿主半实现**。现成范本：本机已装 `@huanlin/dsh-plugin-session-delete`（node 半用 `fs.rmSync` 删 `~/.dsh/sessions/<slug>/<id>/` + `storageDomain` 清 `session_projcache`/`workspace` + `ctx.agents.get` 拒绝删运行中会话；经 `webServer.register({kind:'exact', path:'/__chameleon/session/delete'})` HTTP 端点 + `tools.register(defineTool)` 双通道暴露；client 半 fetch 该端点）。本插件自建同款宿主半但**不依赖第三方**：删除端点/工具自带清理步骤，先保证新分支可用再删旧，失败降级归档。

**纯客户端可触达的服务**

plugin client `apply(ctx)` 用 `ctx.inject([name], cb)` 懒取服务（勿写死 inject 数组以免旧版本阻塞加载）：

- `sessions`（ISessions）：`binding(sessionId)` → `{session: SessionFace}`（face 含 `cancel/updateQueue/readAttachment/rename/loadOlder/loadThrough`，`getSnapshot()` 出 `running/queue`）、`fork(...)`、`open(...)`、`create(...)`；`list.getSnapshot()` 出 `{ids, byId: {title, displayTitle, origin:'subagent'}}`。
- `workspaces`（IWorkspaces）：`archiveSession`、`list.getSnapshot().items[{workspaceId, sessionIds}]`。
- `conversation`（Service 名 `'conversation'`，root 单例）：scope-addressed cancel/send/updateQueue + 无 scope 的 `createDraftImages(File[]) → ComposerAttachment[]`、`releaseDraftImage`。
- `uiConversation`（root Service）：`binding(sessionId).snapshot.get().views.get('chat')` 可命令式读会话节点快照。
- `commandUi`：`register(CommandContribution)`——纯客户端 `/`-菜单条目，`ui.kind:'popupSelect'` 的 options/onSelect 全在 client；贡献名与宿主命令冲突会 fail loud。
- `inputActions`（slot kit 公共面）：**没有** cancel/stop，只有 setDraft/addImages/removeImage/pruneImages/submit；取消必须走 `binding().session.cancel()`。排队清除：对 `snapshot.queue[]` 每个 `item.id` 调 `session.updateQueue(item.id, {kind:'remove'})`。

**会话节点读数与 Esc 捕获的硬约束**

- `chat` 视图快照：`{order, nodes.get(key)}` 的 view node，`node.kind`、`node.anchorSeq`（即 seq）、`node.data.content`（user/steering 的 ContentBlock[]；image 块 `{type:'image', attachment: ImageAttachmentRef{attachmentId, mediaType, name}}`）、assistant 状态在 `node.data.status`（'running'|'settled'|'interrupted'）。`legacy.nodes` 已在新版消失，须走 view node 读法并做跨版本容错。
- 核心所有 Esc 关闭逻辑是 bubble 阶段（Menu/Modal/Lightbox 等）；composer 内 Lexical keymap 在 CRITICAL 优先级处理 ESC。插件用 document **capture** keydown 先于它们，但必须硬门控：无弹层（role dialog/menu/listbox/aria-modal）+ 无外来文本框 + composer 无 `/@` trigger token 在光标前（trigger 弹层是 portal，composedPath 看不见）。
- **armed 是派生状态而非记忆**：running 可停；或尾部 assistant `status==='interrupted'`（曾被 Stop/ESC 打断；自然 settled 永不 armed）且草稿为空（改草稿即解除）；新发送/切会话天然失效。ESC-stop 与工具栏 Stop 进入同态。

**长历史 /rewind 的既定形态（v3 定稿取代早期自绘面板方案）**

- `commandUi` popupSelect **打开时只加载一次 options、不做动态追加**；早期"自绘 Modal 面板 + 按 ↓ 触发 `loadOlder()` 逐页 + 轮询节点数增长"在真实 GUI 不稳定（停在"加载中"不出新行），且用户明确要**一次性全量预读** + 原生命令选择器。
- **正确做法**：打开 `/rewind` 时在 popupSelect 的 `options()` 里先 `session.loadThrough(0)`（SessionFace 自带"跳到最早"的翻页加载器，ChatView 跳转旧回合同款，内部自动翻完全部页）把整个历史读进客户端；随后 `waitForSettled`（轮询组装节点数稳定 2 次采样且 `hasMore=false`）再一次性返回全部选项。shell 在 options pending 期间原生显示"加载中"，读完后支持本地搜索/↑↓/滚动。宿主无 `loadThrough` 时回退到 `loadOlder()` 循环（上限 400 页）。
- `/rewind` 可用性与已加载历史量**解耦**：非 subagent、非 blank（`SessionSummary.blank`）即可选。

**load-once + 缓存水位（v4）**

每次开 `/rewind` 都 `loadThrough(0)` 属多余。`refreshHistory()` 四级短路：1) 本页 `__fullLoaded` 且 `hasMore=false` → 直接读**活的会话快照**（窗口已锚定开头、新消息实时长尾，天然不丢最新）；2) `hasMore=false` 且能看到首个回合 → 认为已全覆盖；3) 有内存/localStorage 记录且 `watermarkSeq ≥` 当前最新回合 → 直接出缓存、不发请求；4) 否则才全量 `loadThrough(0)` 并写缓存。缓存条目 = 全部用户回合（seq/anchorSeq/isFirst/time/全文本/imageRefs）+ `watermarkSeq`（最新用户回合 seq），localStorage 键 `dsh-esc-rewind.history.<sessionId>`，超 2.5MB 跳过持久化只留内存。**新鲜度**：每次用"当前活窗口最新用户回合 seq"与 watermark 比较，有新内容就合并重载一次并刷新水位。

## Goals / Non-Goals

**Goals:**

- `Esc` 一次停止、`Esc` 再按撤销刚被停止的整轮；`/rewind` 从历史任意一轮（含从未渲染过的）重新开始——回退主体走核心官方非破坏机制（fork + open + restore），旧会话处置默认归档、可切换为真删。
- 回退的用户视角等于"那一轮消失了、我回到之前接着改"；归档模式下日志零丢失、原会话归档可恢复；删除模式是用户显式开启的全局偏好，真删由自建宿主半安全执行。
- armed 只由派生状态决定，防误触门控严格，绝不抢占核心"Esc 关弹层"。
- 历史预读 load-once + 缓存水位，读缓存不丢最新；版本/能力不足时静默缺席或降级。

**Non-Goals:**

- 不改 DSH 核心；归档模式不删改 append-only 日志（回退=归档）；删除模式只删"用户显式开启后的旧会话"，不引入任何通用删除 UI。
- 不依赖第三方删除端点（如 `@huanlin/dsh-plugin-session-delete` 的 `/__chameleon/*`）；自建宿主半，卸载/缺失不影响本插件。
- 不做 DOM 注入、不自绘长列表面板（复用原生 popupSelect/Modal 外观）。
- 不接管所有 Esc——只接管"本会话可回退且无更高优先级接收者"的那一击。
- 不做会话列表/历史侧栏里的回退入口（本变更只做 composer 键盘 + `/rewind` 命令 + 会话头处置开关）。
- 不做多轮"撤销栈"（只支持撤销最近一次被停回合、或从 `/rewind` 任选一个历史回合重开）。
- 不做删除的二次确认（用户已接受误触即永久丢失的风险，仅保留非阻塞反馈）。
- 不做"按会话记忆处置偏好"（开关是全局偏好，非 per-session）。

## Decisions

### D1：回退 = fork 分支 + 按处置策略处理旧会话 + 打开分支 + 还原问题

**选择**：`doRewind(sessionId, exchange)` 串行执行：`ensureIdle`（running 时先 `session.cancel()` 并等停稳，限时兜底）→ `clearQueue`（对快照 queue 逐项 `updateQueue(id,{kind:'remove'})`）→ 取 `exchange.anchorSeq`（目标用户回合的上一完整回合边界）→ 准备图片（对 `imageRefs` 逐项 `session.readAttachment(attachmentId)` → `new File([data], name, {type})` → `conversation.createDraftImages([file])` 取 draft id，失败单项降级跳过）→ `sessions.fork({sessionId, atSeq: anchorSeq, increaseTitle:false})` → **按处置策略处理原会话**：归档模式 = `workspaces.archiveSession(oldId)`；删除模式 = 确认新分支已打开后走宿主半真删（见 D6/D7）→ `sessions.open(childId)` → 分支挂载后把问题文本 + 图片 draft id 经 `inputActions.setDraft/addImages` 还原。fork 边界取自记录/快照中"该用户回合之前"的完整回合，保证"从上一完整回合开始"。

**为什么**：fork + 打开新分支是核心官方、非破坏、可表达"旧会话消失"的方式（Branch 行菜单同款）。旧会话处置抽成策略后，默认归档（不可破坏 + 可恢复）与用户显式开启的真删（彻底消失）共用同一回退主体，只是尾段不同；真删被严格安排在"新分支可用之后"，任何前序失败都不动旧会话。

**放弃的替代方案**：任何试图原地删除/改写消息的方案（客户端无此 verb；surface-replace 仅宿主 `/compact` 内部用，且是"段→节点"非"删除"）；"只 fork 不归档/不删"（旧会话仍占列表，用户看到两个会话，违背"那一轮消失"的直觉）；在 fork 前就删旧（open 失败则当前会话已没，见 D7 安全时序）。

### D2：armed 是派生状态，Esc 走 document capture + 硬门控

**选择**：在 `conversation.input.overlay`（list / session，ROW_ID `esc-rewind`、order 60）挂一枚无渲染桥组件 `EscBridge`，用 `useSession/useConversation/useInput` 读 running、尾部状态、草稿与弹层上下文；`document.addEventListener('keydown', fn, true)` capture 阶段接收 `Esc`，先过 `decideEsc` 门控再决定 stop/rewind/放行。门控条件：会话存在、非 subagent；`running` 为真 → stop；否则尾部 assistant `status==='interrupted'` 且草稿为空 → rewind；其余一律放行。弹层/外来文本框/IME/`/@` trigger token 用 `composedPath()`、活动元素、事件属性与 composer 光标状态判定，任一不确定都放行。

**为什么**：armed 不落任何"是否停过"的记忆位，只由当前快照派生——自然结束永不 armed、编辑草稿即解除、切会话天然失效，零状态同步问题。capture 阶段保证先于核心所有 bubble Esc 逻辑，但门控决定最终是否接管，把"优先服务关闭弹层"做成结构性保证。

**放弃的替代方案**：只监听 composer 焦点内（漏掉 Lexical/弹层竞争）；只监听 bubble（被核心先吃掉）；用记忆 flag 记"上一步是否 stop"（跨会话/草稿编辑易残留错态）。

### D3：/rewind 走原生 popupSelect，options 内 loadThrough(0) 全量预读

**选择**：`commandUi.register(CommandContribution)` 贡献 `rewind` 命令（`ui.kind:'popupSelect'`）。`options(signal)` 内先判可用性（非 blank、非 subagent），再调 `refreshHistory(sessionId, signal)`（v4 四级短路），不足时 `loadThrough(0)` + `waitForSettled` 后把全部用户回合映射为 option 行（序号+截断文本+相对时间），最新在前。`onSelect` 从 `knownExchangesOf()`（缓存优先，keyed by seq）找回完整 exchange（含 anchorSeq/文本/imageRefs），再交 `doRewind`。

**为什么**：popupSelect 是核心原生选择器（自带 loading/空态/搜索/↑↓/滚动），把"喂全 options"交给插件即可覆盖任意早历史，不重造 UI；options 在 open 时求值一次，天然满足"非动态追加"。此前自绘面板方案在真实 GUI 不稳定且外观非原生，已被 v3 废弃。

**放弃的替代方案**：自绘 Modal + 逐页 loadOlder（真实 GUI 停在"加载中"，且外观非原生）；popupSelect 只当启动器再开自绘列表（多余一层）；每次 open 都 loadThrough(0)（v4 起被 load-once 缓存取代）。

### D4：历史预读 load-once + 缓存水位

**选择**：`refreshHistory()` 四级短路（见 Context/v4）：活窗口已全覆盖 → 直接读活快照；`hasMore=false` 且可见首个回合 → 覆盖；记录新鲜（`watermarkSeq ≥` 当前最新）→ 出缓存；否则才 `loadThrough(0)` 并写记录。记录存 module 级 `__known` Map + localStorage（`CACHE_PREFIX + sessionId`，`CACHE_MAX_BYTES=2.5MB`，超限跳过持久化）。每次打开用"当前活窗口最新用户回合 seq"与 watermark 比较，有新增即合并重载一次并刷新水位。

**为什么**：load-through 是 O(历史) 的昂贵操作，高频 `/rewind` 不该重复付；活窗口机制（窗口锚定开头、新消息实时长尾）让同页二次打开零请求且不丢最新；跨刷新则靠持久化记录 + 水位比较保证"有新增才重载"，缓存永远不会掩盖最新内容。

**放弃的替代方案**：每次 open 都全量 load（浪费且长会话卡顿）；只信缓存不比较水位（会丢最新，违反 spec）；纯内存不持久化（刷新即失效，用户明确要求跨刷新可用）。

### D5：跨会话还原经 module 级 pending 桥

**选择**：`inputActions.setDraft/addImages` 是"当前绑定会话"的公共面；fork/open 后输入框身份变化，不能当场调用。故 `doRewind` 把还原载荷（文本 + 图片 draft id，按 child sessionId 记）写入 module 级 `__pendingRestore`（TTL 30s），`EscBridge` 在目标会话挂载且草稿为空时消费并清掉 pending。图片经 `readAttachment`（durable `attachmentId`，跨会话/跨刷新仍可读）→ File → `createDraftImages` → draft id 流转，无需持有原始 Blob。

**为什么**：解决"open 之后 inputActions 属于新会话"的时序问题；TTL 防陈旧 pending 污染未来会话。

**放弃的替代方案**：在 doRewind 内同步调 setDraft（open 未完成/绑定未切换时失效）；把还原延后到用户下一次手动聚焦（体验割裂）。

### D6：旧会话处置开关 = 会话头图标 + settings 全局偏好

**选择**：新增一个宿主半（`src/index.js` 从空 host 变为真实 node apply，`inject: ['settings']`），用 `settings.installSection(NS, { deleteOldOnRewind: { type:'boolean', default:false, ... } })` 注册 `esc-rewind` 命名空间；客户端经 `remote.settings.describe()` 读取 `deleteOldOnRewind` 并缓存为 module 级 `__deleteMode`（缺省 `false`）。在 `conversation.session.header.actions`（list / session）注册一枚图标按钮（ROW_ID 如 `esc-rewind-dispose`，order 取 28，避开 schedule 10 / job-list 20 / open-workdir 25 / chameleon 30）：归档态显示档案柜图标；删除态显示红色带叉垃圾桶图标。单击切换，立即写 settings（经宿主半端点/工具）并更新图标与缓存。

**为什么**：开关语义是**全局偏好**（用户 Q2 确认）——放在会话头只是入口 UI，状态本身必须跨会话/跨刷新存活，settings 是 DSH 正轨（进设置页、可描述、与宿主一致）；客户端只缓存值，避免每次 describe。图标两态沿用"该排全是图标按钮"的既有视觉语言；删除态加叉/红色以区别于 chameleon「删除当前会话」的普通垃圾桶（用户 Q11 确认）。

**放弃的替代方案**：localStorage 仅客户端存（设置页看不到、跨机不跟随）；per-session 记住（fork 继承复杂、用户 Q2 否）；文字 toggle 或菜单项（破坏图标排一致性）。

### D7：真删走自建宿主半，安全时序 = 新分支可用后才删

**选择**：宿主半实现 `deleteSessionCore(ctx, sessionId)`（参照 chameleon 但自建、不依赖第三方）：1) `ctx.agents.get(id)` 存在则拒删（运行中会话）；2) 定位并 `fs.rmSync` 磁盘日志目录（扫描 `~/.dsh/sessions/*/<id>/` 两拼写）；3) 经 `storageDomain` 清 `session_projcache` 与 `workspace` 记账；4) 返回逐项结果。暴露通道：`webServer.register({kind:'exact', path:'/__esc-rewind/session/delete'})`（webServer 可选，出现才注册）与 `tools.register(defineTool)` 双通道（terminal-only profile 也有工具可用）。客户端在**新分支 fork+open 成功且确认可用后**才调用该端点；调用失败 → 降级执行 `workspaces.archiveSession(oldId)` + toast「删除失败，已改为归档」；成功 → toast「旧会话已删除」。

**为什么**：客户端无删除 verb（见 Context 事实），真删必须宿主半动盘；自建保证本插件自带删除能力、与第三方是否安装无关（用户 Q6 确认）。安全时序（用户 Q16 确认）保证任何前序失败都不删旧会话——删除是回退链的**最后一步**且可降级归档，绝不把回退整体变成硬失败。

**放弃的替代方案**：复用 `@huanlin` 的 `/__chameleon/session/delete`（私有端点、人家卸载即坏，用户 Q6 否）；fork 后立刻删旧（open 失败则当前会话已没，用户 Q16 否）；删除失败即中止报错（可能留下"删一半"状态，用户 Q8 选择降级归档）。

### D8：删除模式无确认，但反馈分层警示

**选择**：删除态下回退不弹二次确认（用户 Q4 确认）；反馈分三处：1) 开关切到删除态 → toast「已开启：回退将删除旧会话（不可恢复）」；2) 删除态下第一次 `Esc` 停止 → toast 用警示措辞「已停止 · 再按 Esc 将删除本轮并重来（不可恢复）」（区别于归档态的普通文案，用户 Q18 确认）；3) 真删执行完成 → toast「旧会话已删除」。这些文案走 locale 字典（zh/en）。

**为什么**：用户明确选了"完全不确认"，接受误触即永久丢失；唯一的防线是图标状态 + 分层 toast。停止提示带警示是**提前告知**下一次按键是终局的，不打断流程但消除"我不知道会删"的意外。

**放弃的替代方案**：任何二次确认弹窗（用户 Q4 否，破坏 Esc-Esc 的快速语义）；删除态与归档态完全同文案（用户无从预知，Q18 否）。

## Risks / Trade-offs

- [长会话全量预读耗时随历史线性增长] → 首次打开显示原生"加载中"并（可选）toast「正在读取全部历史…」；load-once 保证只付一次；缓存降级不阻塞功能。超长会话首开变慢是"全量预读"策略的被接受代价。
- [跨版本核心契约漂移（节点结构、fork 边界、loadThrough 存在性）] → 节点读数做跨版本容错（多字段回退）；宿主无 `loadThrough` 时回退 `loadOlder()` 循环（上限 400 页）；能力不足时命令静默不出现或降级，绝不报错/卡死。
- [Esc 误接管破坏核心"关弹层"语义] → 门控只拦截"本会话可回退"一击，任何不确定放行；armed 纯派生；capture 先听后仍由门控决定是否 `stopPropagation`。
- [缓存掩盖最新消息] → 水位比较 + 有新增强制合并重载一次；同一页面内由活窗口直接覆盖（机制 1），不依赖缓存。
- [pending 还原跨会话泄漏] → TTL 30s + 仅在目标会话挂载且草稿空时消费 + 切会话清理。
- [回退后旧会话"消失"让用户找不到] → 归档模式可恢复（ACCEPTANCE 人工项）；删除模式 README/ACCEPTANCE 明示不可恢复且无二次确认，默认关闭。
- [fork 边界与用户直觉不一致（中间被停回合）] → fork 语义 = 只切"完整回合前缀"；锚点一律取目标回合的上一完整回合，避免把半截内容带进新分支。
- [真删误触即永久丢失（无确认）] → 默认关闭；开启时图标变红叉 + 切换 toast + 停止提示带警示；删除被安排在回退链最后且失败可降级归档——误删窗口最小化但不可完全消除（用户已接受）。
- [宿主半动盘与核心存储/记账不同步（残留/复活）] → 参照 chameleon 已证步骤：删磁盘日志 + 经 `storageDomain` 清 `session_projcache`/`workspace`（用打开的 domain 设施，防 flush 复活）；运行中会话拒删；删除端点幂等可重试。
- [宿主半引入新端点/工具扩大攻击面] → 端点仅 localhost web 面、路径带私有前缀、只接受 `sessionId`、校验 id 格式；删除工具仅注册不暴露给模型工具集之外的调用方；与既有 chameleon 端点并存互不影响。
- [webServer 缺席（terminal-only）时删除无通道] → 删除工具无条件注册（工具通道始终可用）；client 半按可达性择端点/工具，都不可达时回退归档并提示。
- [settings 读取失败导致误判删除模式] → describe 失败/缺字段一律回退默认 `false`（归档），绝不因读不到配置而误开删除。

## Migration Plan

- **部署**：仓库聚合伞包登记（根 `package.json.dependencies` + 根 `cordis.patch.yml` 各一行），web profile 走 per-plugin 直连 `dsh plugin --profile web add`（或 README 的 umbrella 模型），GUI host 重启后新 Loader 行生效。**本功能新增宿主半**：`src/index.js` 从空 host 变为真实 node apply（注册 settings 段 + 删除端点/工具），改动后需 GUI host 重启才能加载 node 半（client bundle 改动仅需刷新页面）。
- **升级路径**：已装旧版（纯 client、无 settings 段）的 profile 重跑 `dsh plugin --profile web add`/install 拉取含宿主半的新包即可；旧版无 `deleteOldOnRewind` 字段 → describe 缺省 `false`，行为不变。
- **回滚**：从 profile `package.json` 移除 bundles/dependencies 行后 `dsh plugin --profile web install`（或卸载命令）。插件卸载后：settings 段若被用户手写过则残留无害（README 说明清理步骤）；已删除的会话不可恢复（删除前无备份——这是功能语义）。
- **人工验收**：`ACCEPTANCE.md`（`[B]` 项在真实 GUI 逐条勾选，含新增删除模式条目）；逻辑层由 `test/bundle.test.mjs`（harness 断言）自动覆盖。

## Open Questions

无。已实现行为与 spec 一一对应；后续如需"撤销栈/多级回退"、删除前的二次确认或按会话记忆处置偏好，属新变更，不在本设计内。
