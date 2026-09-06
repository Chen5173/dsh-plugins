## Why

在 DSH Web GUI 的输入框里，用户想重复或微调自己刚发过的消息时，目前只能手动往上翻、复制、粘贴。核心已有一个相邻手势——双击 `Escape` 触发 `rewind`，把**最近一条** human prompt 取回输入框——但它一次只能拿一条、且会顺带回退会话，无法逐条浏览更早的历史。缺的是一个终端式的历史召回：在输入框按 `↑` / `↓` 逐条把**本会话里自己发过的消息**填回草稿，编辑后自行重发。

## What Changes

- 新增一个 **纯 client 侧** DSH 插件包（cordis bundle），在 composer 区注册一个不占视觉的键盘桥接组件（复用 `conversation.input.overlay` 槽位），实现「方向键召回历史」。
- **历史来源**：当前会话已发送的用户消息——从 `useConversation` 时间线里的 `UserMessageNode` 提取文本，按发送顺序排列，最新在前。
- **触发规则**：光标位于草稿**首行**时 `↑` 取更早一条、位于**末行**时 `↓` 取更新一条；条件不满足时 `↑` / `↓` 完全交还给编辑器做常规光标移动，插件不拦截。
- **召回动作**：把选中的历史消息文本经 `inputActions.setDraft()` 填回输入框，**不自动发送**；用户编辑后自行回车发送。
- **会话内游标**：一次浏览过程内维护一个位置游标；用户手动编辑草稿、成功发送、或切换会话后游标重置。
- **不做**：不跨会话、不纳入助手消息、不新增 Host HTTP 端点、不新增模型工具、不改动 DSH 核心、不自动发送、不改变会话状态。

## Capabilities

### New Capabilities

- `composer-history-recall`: 在会话输入框内用方向键逐条召回本会话历史用户消息并填回草稿这一用户可见行为——何时触发、召回什么内容、如何与多行草稿里的光标上下移动共存、浏览游标如何推进与重置、以及无历史 / 单行 / 边界等情况的表现。

### Modified Capabilities

- 无。`openspec/specs/` 目前为空，本变更不修改任何既有能力的需求。

## Impact

- **新增**：插件包目录（`package.json` + `cordis.patch.yml` + `src/index.js` + `src/client.js`），发布为 npm 包并带 `dsh-plugin` keyword。
- **安装面**：profile `package.json` 的 `dsh.profile.bundles` 追加一项；`cordis.patch.yml` 由插件自带的 `- insert:` 行落地（与 `dsh-open-session-workdir` 同构）。
- **运行时依赖（均为核心已有、已在 web profile 内）**：
  - 槽位：`conversation.input.overlay`（渲染在常驻 composer 卡片内的浮动条目；本插件用它承载一个不渲染可见 UI、只挂键盘监听的组件）。
  - 标准 props：`useConversation`（读会话时间线里的 `UserMessageNode`）、`useInput`（读当前草稿 `draft` 与 `phase`）、`inputActions.setDraft`（把召回文本写回草稿）。
  - UI 件：`@deepseek-ai/dsh-client-ui-primitives`（可选，用于「已到最早 / 最晚」的轻量提示）。
- **不受影响**：会话日志与投影缓存、workspace 记账、Host 存储、模型工具集、其它 profile（terminal-only 无 web 表面时本插件自然不加载）。
- **已知边界**：composer 是 Lexical contenteditable，其键盘面 `ComposerKeyboard` 是**包私有**、明确「never across a plugin boundary」，插件拿不到编辑器内部的按键仲裁。因此插件只能自挂 `keydown` 监听，并严格判定「首/末行」条件；条件不满足时必须放行给编辑器，避免抢走多行草稿里的常规上下移动。
