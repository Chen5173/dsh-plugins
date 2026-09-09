## Why

DSH Web 会话一旦生成就不能在聊天里“撤掉重来”：会话日志是 append-only，客户端既没有删除消息的受支持 API，也没有现成的 rewind 入口（核心 `ConversationContextOriginKind 'rewind'` 是全仓死代码）。用户犯了一次错、或想从某个历史回合重新分叉时，只能手动 Branch（分叉）再手动删掉旧分支，过程笨重且容易把两边的上下文搞混。需要一个 Codex / Claude Code 式的一键「停止 + 回退」：按 `Esc` 停掉当前生成，再按一次 `Esc` 就把刚被停的整轮撤销；再给一个 `/rewind` 命令，可以从**历史任意一轮**（哪怕从未在聊天里渲染过）重新开始。

## What Changes

新增一个 DSH 插件包 `dsh-esc-rewind`（客户端为主；删除模式为其增加一个**宿主半**用于真删）：

- **`Esc` 停止**：生成进行中按一次 `Esc` → 停止当前生成（与 Stop 按钮同款 `session.cancel`），toast「已停止 · 再按 Esc 回退本轮」。
- **`Esc` 再按 = 回退本轮**：把刚被停止（或 Stop 按钮停掉）的**整轮**撤销——fork 于“本轮开始前”的上一完整回合、保留原标题、**按旧会话处置策略处理原会话**、打开分支、把被撤销的问题文本（含图片，尽力还原）放回输入框。
- **快速连按两次 `Esc`**：不等停稳直接执行“停止+回退”，终态一致。
- **防误触门控**：armed 是**派生状态**（running，或尾部为 `interrupted` 的 assistant 且输入框草稿为空）；自然正常结束、草稿被编辑、有新发送/切会话、弹层/菜单/输入补全打开、IME 组合中、焦点在外部文本框——一律不接管 `Esc`。
- **`/rewind` 命令**：原生命令选择器（popupSelect）列出**全部历史用户回合**，最新在最上，行 = 序号+截断文本+相对时间；选中后同样走 fork+按策略处置+打开+还原。非空白、非子代理会话永远可选（与已加载历史量解耦）。
- **全量预读 + load-once + 缓存水位**：首次打开时 `session.loadThrough(0)` 一次读空全部历史（原生显示“加载中”）；同一页面再次打开直接读活会话/记录不再重复请求；刷新后读 localStorage 记录（含水位 seq），有新内容才合并重载一次——**读缓存绝不丢最新**。
- **首轮降级**：回退目标是“第 1 轮”（无更早回合）时，按策略处置原会话 + 打开同工作区新空会话 + 还原问题。
- **旧会话处置开关（本变更新增）**：会话头 actions 排一枚**档案柜⇄红色带叉垃圾桶**图标开关，控制回退后旧会话如何处置——默认**归档**（安全侧，原会话隐藏、日志保留可恢复）；用户切到**删除**后，回退（Esc-Esc 与 `/rewind` 均生效）会**真删旧会话**（磁盘日志、投影缓存与工作区记账一并移除，不可恢复）。开关是**全局偏好**，经新增 settings 命名空间 `esc-rewind`（字段 `deleteOldOnRewind:false`）持久化，跨会话与刷新生效；普通会话头显示，子代理/空白会话隐藏。
- **真删是自建宿主半**（node 半）：注册 settings 段 + 一个删除端点/工具，安全时序 = **先 fork 并确认新分支可用，再删旧**；删除失败**降级为归档 + toast 告警**，绝不硬失败。删除动作无二次确认（已接受误触即永久丢失的风险），但**删除模式下首次 Esc 停止的 toast 带警示措辞**，切换与执行均有 toast 反馈。
- **不做**：不改 DSH 核心、不删改 append-only 日志（归档模式下原会话只隐藏、日志保留可恢复；删除模式是用户显式开启后的真删）、不做 DOM 注入、不提供历史浏览之外的任何导航交互、不依赖第三方删除端点。

## Capabilities

### New Capabilities

- `esc-rewind`: 在 DSH Web 会话里以键盘（`Esc`/`Esc Esc`）与斜杠命令（`/rewind`）表达“停止当前生成、撤销本轮、或从任意历史回合重新开始”——包括可回退状态的派生判定、回退的 fork+打开+还原语义、历史全量预读与 load-once 缓存的新鲜度保证、以及“回退后旧会话如何处置”的可切换策略（默认归档 / 可开启真删）及其安全时序。

### Modified Capabilities

- 无。既有能力 `composer-history-recall`（`openspec/specs/composer-history-recall/spec.md`）与 `composer-provider-label` 与本插件共用 composer 但与不同输入/槽位交互（方向键召回、provider 标签 vs `Esc`/`/rewind`），需求均不变；共存只作为验收项。

## Impact

- **新增**：插件包目录 `dsh-esc-rewind/`（`package.json` + `cordis.patch.yml` + `src/index.js` + `src/client.js` + `test/bundle.test.mjs` + `README.md` + `ACCEPTANCE.md`），带 `dsh-plugin` keyword。
- **安装面**：仓库聚合伞包登记（根 `package.json.dependencies` + 根 `cordis.patch.yml` 各一行）；web profile 采用 per-plugin 直连（`dependencies` `link:` + `dsh.profile.bundles` 行 + `dsh plugin --profile web add`）。Loader 行由包自带 `cordis.patch.yml` 的 `- insert:` 落地。
- **运行时依赖（核心已有、已在 web profile 内的公开契约）**：
  - 槽位：`conversation.input.overlay`（list / session，`ROW_ID 'esc-rewind'`、order 60）；`conversation.session.header.actions`（list / session，删除模式开关，新 order 不与既有占用冲突）
  - 服务（客户端）：`sessions`（binding/fork/open/create/loadThrough/loadOlder）、`workspaces`（archiveSession）、`conversation`（cancel/createDraftImages）、`uiConversation`（binding(sessionId).snapshot → chat 视图节点）、`commandUi`（register(CommandContribution)，popupSelect）
  - 服务（宿主半）：`settings`（installSection 注册 `esc-rewind` 命名空间）、`webServer`（可选，删除端点）与/或 `tools`（删除工具）
  - 输入面：`inputActions.setDraft/addImages`（slot kit）
  - 事件：document capture keydown（`Esc`）
- **新增配置面**：settings 命名空间 `esc-rewind`，字段 `deleteOldOnRewind`（默认 `false`），由宿主半注册，会出现在设置页与 `settings/describe()` 结果里。卸载插件后该段若被手写过，残留在 `settings.yaml` 中无害（README 说明）。
- **版本下限**：`@deepseek-ai/dsh-api-session-controller` / `dsh-api-workspace-controller` / `dsh-client-runtime` / `dsh-client-ui-commands` / `dsh-client-ui-conversation` ≥ `0.1.2-rc.1`，`dsh-client-ui-primitives` ≥ `0.1.1-rc.2`（peerDependencies 声明）。版本不足时插件行不加载，不报错。
- **诊断面**：`window.__dsew`（计数/最后门控，不含消息内容）。
- **已知边界**：`loadThrough(0)` 全量预读对超大会话耗时随历史线性增长（“全量预读”是被接受的策略代价）；缓存按会话持久化到 localStorage（>2.5MB 时自动退化为仅本页内存）；回退后旧会话默认**归档**（可从归档/隐藏视图恢复），仅当用户显式开启删除模式才**真删**（不可恢复，无二次确认）。
