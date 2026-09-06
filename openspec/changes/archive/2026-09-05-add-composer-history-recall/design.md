## Context

动机见 `proposal.md - Why`；行为契约见 `specs/composer-history-recall/spec.md`。这里只记录塑造方案的核心约束（均已在实现期核对真实运行时）：

- DSH Web 的输入框（composer）是 **Lexical contenteditable**，其根 div 带稳定属性 `data-composer-input`（`role="textbox"`、`aria-multiline="true"`）。它的键盘面 `ComposerKeyboard`（含 `arbitrate` / `caretSpan` 等）在 `@deepseek-ai/dsh-client-ui-conversation` 里被明确标注为**包私有、"never across a plugin boundary"**——插件拿不到编辑器内部的按键仲裁。
- 插件能拿到的公开面是 session-scope 槽位组件的标准 props：`useConversation`（会话时间线快照）、`useInput`（`InputState`：`draft` / `draftRev` / `phase` / `occurrences` / `queue`）、`inputActions`（`setDraft` / `submit` 等稳定回调）。`InputState` **不含光标位置**。
- 会话时间线经 `useConversation(s => s.views.get('chat'))` 取到 `ChatSnapshot`：`order`（渲染序的节点 key）+ `nodes.get(key)`；用户消息是 `kind:'user'` 节点，文本在其 `content` 的 `{kind:'text',text}` 块里。
- 已存在的相邻手势：双击 `Escape` → `rewind`，取回**最近一条** human prompt 且回退会话。本插件与之互补：只读、逐条、不回退、不发送。

## Goals / Non-Goals

**Goals:**
- 在纯 client 侧、不改核心、不新增 Host 端点的前提下，实现方向键逐条召回本会话用户历史并填回草稿。
- 与 Lexical 编辑器的常规行为（多行光标上下移动、斜杠/提及触发菜单的 ↑/↓ 选择）**和平共存**：只在明确安全时接管方向键，其余一律放行。
- 无历史、单条历史、边界、语言切换等场景有确定、可测的表现。

**Non-Goals:**
- 不做跨会话历史、不纳入助手消息（用户已确认范围）。
- 不做自动发送、不做会话回退（那是 `rewind` 的职责）。
- 不追求软换行（visual wrap）级别的"视觉行"判定——采用**逻辑行**语义（见 D2）。
- 不实现编辑器内部键位重映射，不替换 composer。

## Decisions

### D1：挂载点用 `conversation.input.overlay`，组件默认渲染 `null`
overlay 槽（`kind:'list'`、scope `session`，由 `ConversationRoot` 经 `renderSlot('conversation.input.overlay', {})` 渲染，`ui-input-trigger` 的 `MenuView` 即挂在此处）会随常驻 composer 一起挂载，并拿到 session 标准 props（`useConversation` / `useInput` / `inputActions` / `sessionId` / `t`）。组件默认返回 `null`（无常驻 UI），仅在一个 `useEffect`（deps `[]`）里向 **document 挂 capture 阶段 `keydown` 监听**；只有触发边界提示时才短暂渲染一个 `Toast`。
- 焦点判定用 `document.activeElement`：composer 的 contenteditable 根带稳定属性 `data-composer-input`，`activeElement.hasAttribute('data-composer-input')` 为真才算「在输入框内」，否则直接放行。这样无需 DOM 锚点即可渲染 `null`。
- 备选：`conversation.input.dock`（composer 卡片上方可见区）——否决，会占一块可见布局。
- 备选：向 contenteditable 根单独挂监听——否决，需要渲染一个隐藏锚点定位编辑器；document capture + `activeElement` 门控更简单且天然只在 composer 聚焦时生效。

### D2：首/末行门控用「光标所在块是编辑器的首/末个块」判定（逻辑行）
实现期核对：composer 是 Lexical，段落以**块级子元素**呈现于 `[data-composer-input]` 根下，而 `draft` 是 clipboard-text 投影（换行表示与 DOM `textContent` 不保证逐字符对齐）。故不用「文本偏移 + 草稿换行」，改用块索引：
- 从 `window.getSelection()` 取**折叠**光标（非折叠即放行）；由 `anchorNode` 上溯到 `[data-composer-input]` 根的直接子块 `block`，`line = 根.children.indexOf(block)`、`lineCount = 根.children.length`。
- `↑` 召回条件：`line === 0`（首块）。进入浏览后 `↓` 的末块条件见 D4（浏览中放宽）。
- 逻辑行语义：软换行（同一块内视觉换行）算一行，与终端一致；误判作为已知取舍记在 Risks。
- 含引用 chip 的草稿：`occurrences.length > 0` 时**不接管**方向键（放行给编辑器），避免 chip 造成的坐标错位误召回。

### D3：历史来源在 `useConversation` 时间线上派生并 memo
`useConversation(s => s.views.get('chat'))` 取 `ChatSnapshot`；历史来源是 `chat.legacy.nodes`（原始 `ConversationNode[]` 兼容切片），过滤 `kind==='user'`，把每条 `content` 里 `type:'text'` 的块拼接为一条历史文本（`ContentBlock` 以 `type` 标注、非 `kind`；实现同时兼容 `kind`；丢弃空串），得到「最新在前」的 `history`（`history[0]` = 最近一条）。注意：`chat.nodes.get(key)` 返回的是渲染视图节点（载荷在 `.data` 下），直接读 `.content` 取不到文本；实现对 `legacy.nodes` 缺失时回退到 `order`+`nodes.get` 并读 `.data.content`。派生结果用 `useMemo` 绑定到 chat 快照引用（快照不可变、变更即换引用），避免每次按键重算。

### D4：浏览游标为 per-session 模块态；进入浏览后放宽门控
维护 `{ index: number | null, savedDraft: string, lastWritten: string }`（`index === null` = 未处于浏览态）。`history` 为「最新在前」数组，`index` 是其下标。
- **进入浏览（仅此时受 D2/D5 门控约束）**：`index === null` 且按 `↑` 且光标在首块 → `savedDraft =` 当前 `draft`、`index = 0`、`setDraft(history[0])`、记 `lastWritten`。
- **浏览中推进（不再受首/末行门控）**：`↑` → `index+1`；越界则停在最早并 `Toast`「已到最早」（见 D6）。`↓` → `index-1`；减到 `-1` 退出浏览并 `setDraft(savedDraft)`（空草稿即清空）。
  - 为何放宽：`setDraft` 会把光标置于草稿末尾，若继续要求「首块」则多行历史条目召回后无法再 `↑`。故首/末行门控只用于**进入**，进入后自由上下，符合终端直觉。
- **重置触发**：① 外部编辑——每次按键先判 `index !== null && draft !== lastWritten` ⇒ 用户改过 ⇒ `index = null`（下一次 `↑` 重新走进入门控）；② 发送——发送后草稿被清空/改写，同样命中 ①，且 `history` 会纳入刚发送的消息，下一次 `↑` 从最新一条重新开始；③ 切换会话——`sessionId` 变化时在 effect 里 `index = null` 并重算 `history`。
- 用 `lastWritten` 区分「我们写的」与「用户改的」，避免自激重置。

### D5：与斜杠/提及触发菜单互斥
composer 的触发菜单（`/`、`@`）自身用 ↑/↓ 选择候选。插件在**进入浏览前** MUST 判定光标不在触发 token 内：取光标前文本 `beforeCaret`，若匹配 `/(?:^|\s)[/@]\S*$/`（光标正处在一个以 `/` 或 `@` 起始的 token 中）则**放行**给编辑器/菜单，不召回。判据用 D2 已得的 DOM 光标信息，不依赖包私有的 `menuLauncher`。浏览中（`index !== null`）不再判此条——历史条目本身可能是 `/xxx` 命令文本。

### D6：边界提示用轻量 Toast，缺席时静默
"已到最早"用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`（纯字符串横幅）。若该件不可用则降级为无提示（功能仍正确，只是少了反馈），不阻断召回。

### D7：能力缺席即整体惰性
`inputActions` 或 `useConversation` 缺失（无会话 / 非 web 表面）时，组件返回 `null` 且不挂任何监听——与未安装等价。

### D8：locale 与安装形态沿用同构插件
`ctx.locale.register(NS,{zh,en})` + 注册项声明 `locale:NS`，`locale/change` 后刷新；`src/index.js` 只导出空 `apply`（让包成为 Loader 条目），真实逻辑走 `exports["./client"]` + `package.json` 的 `dsh.client`；`cordis.patch.yml` 一行 `- insert:`。与 `dsh-open-session-workdir` 完全同构。

## Risks / Trade-offs

- **[Lexical 在编辑器内吞掉方向键]** → 监听挂在 **document capture 阶段**，先于 Lexical 处理器运行；命中接管时 `preventDefault()` + `stopPropagation()`，未命中直接 return 不干预。
- **[setDraft 后光标落到末尾，多行历史无法连续 ↑]** → D4：首/末行门控只用于进入浏览，进入后自由推进。
- **[含 chip 草稿的坐标错位]** → D2：`occurrences.length > 0` 时不接管。
- **[软换行被当作单行]** → 采用逻辑行语义（与终端一致）；视觉换行的首/末行误判作为已知取舍，不影响正确性（最多多/少一次召回，不破坏编辑）。
- **[与触发菜单抢键]** → D5 的 token 扫描互斥；拿不准时一律放行，宁可少召回不可误拦截。
- **[大历史列表每次按键重算]** → D3 的 `useMemo` 绑定 chat 快照引用，按键路径 O(1)。
- **[误覆盖用户未发送草稿]** → D4 的 `savedDraft` 在进入浏览态时快照，`↓` 越过最新即恢复。

## Migration Plan

- 安装：`dsh plugin --profile web add ./dsh-composer-history-recall`（或发布包名），重启 `dsh web`。
- 回滚：profile `cordis.patch.yml` 里把该行置 `disabled: true`，或 `dsh plugin --profile web remove dsh-composer-history-recall`，重启。插件不写任何持久数据，卸载无残留。
- 版本下限：依赖 `conversation.input.overlay` 槽与 `useConversation` / `useInput` / `inputActions` 标准 props，以及 composer 根上的 `data-composer-input` 属性；核心版本不足导致槽/props 缺席时按 D7 惰性不加载，不报错。

## Open Questions

- 是否额外提供组合键（如 `Alt+↑/↓`）作为"无视首/末行强制召回"的逃生阀——属增强项，不影响当前 spec 与任务拆分，留待实现后按反馈决定。
