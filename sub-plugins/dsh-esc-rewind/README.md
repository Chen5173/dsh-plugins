# dsh-esc-rewind

给 DSH Web 会话加「停止 + 回退重来」：`Esc` 一次=停止当前生成；再按一次 `Esc` = 把刚被停的**整个最后一轮**撤销重来；另有 `/rewind` 命令，可从**历史任意一轮**重新开始。重来一律走 DSH 官方机制——**fork 分支 + 打开分支 + 还原问题到输入框**；旧会话如何处置由一个**会话头开关**控制：默认**归档**（隐藏出主列表、日志保留可恢复），可切到**删除**（经宿主半真删磁盘日志，不可恢复）。

客户端为主（`sessions` binding/fork/open/create、`workspaces` archiveSession、`conversation` cancel/updateQueue/createDraftImages、`uiConversation` 节点快照、`commandUi` popupSelect 贡献）；**删除模式额外带一个宿主半**（`src/index.js`）：注册 settings 命名空间 `esc-rewind`（字段 `deleteOldOnRewind`，默认 `false`）+ 自建删除端点 `/__esc-rewind/session/delete` 与模型工具，不依赖任何第三方删除实现。架构上与核心“Branch(分叉)/Archive(归档)”行菜单同源，不碰 append-only 日志（删除模式是用户显式开启后的真删）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 生成中按 `Esc`① | 停止当前生成（同 Stop 按钮的 `session.cancel`）；toast「已停止 · 再按 Esc 回退本轮」（删除模式下为「已停止 · 再按 Esc 将删除本轮并重来（不可恢复）」） |
| 停止后再按 `Esc`② | 回退本轮：取消排队消息 → 定位“本轮开始前”的上一完整回合 → `fork` 新分支 → 保留原标题 → **按开关处置原会话（默认归档 / 开启后真删）** → 打开分支 → 把被撤销的问题文本（尽力含图片）还原到输入框，toast「已回退…」 |
| 生成中快速连按两次 | 第二击不等停稳：直接执行“停止+回退”（最终状态一致） |
| 用工具栏 Stop 按钮停止 | 同样进入“可回退”预备态（尾部是被中断的 assistant）；再按一次 `Esc` 即回退 |
| 自然正常结束的回合 | **不可回退**：尾部是 settled assistant，`Esc` 不接管（防误删）；**也不会弹「再按 Esc 回退本轮」提示**（该提示只认宿主耐久停止证据，见下） |
| 「再按 Esc 回退本轮」提示的时机 | 仅在**本会话内出现过 running→idle** **且该轮有宿主耐久停止证据**时出现：尾部 assistant 带 `interrupted`，或该轮 `turn/end` 为 `aborted`/`user`（覆盖「尚无内容即被停」）。判据在该轮**定型后**结算，因此提示可能晚于停止动作一两帧；自然结束（settled / `completed` 等）永不提示，切进历史上被中断/失败的会话也不提示 |
| 编辑了输入框草稿 | 解除预备态：再按 `Esc` 不回退（防覆盖你正在写的新内容） |
| 有新发送 / 切换会话 | 解除预备态（按会话派生，天然失效） |
| 弹层/菜单/输入补全打开 | 不接管 `Esc`（让给核心“关闭弹层”），先关弹层再谈停止/回退 |
| `/rewind` 命令 | 打开**原生命令选择器**（popupSelect）：**首次**打开时 `session.loadThrough(0)` **一次性把全部历史读进客户端**（shell 原生显示“加载中”），随后列出**每一个**“用户提问回合”，**最新在最上**，行 = 序号+截断文本+相对时间；读完后原生支持 `↑/↓` 逐条、直接打字过滤搜索、超长自动滚动——**更早内容即使从未在聊天里渲染也能选到**，不是逐页动态追加 |
| 重复打开 `/rewind` | **load-once**：同一页面内首次全量加载后直接读“活会话”（新消息实时并入，不会漏最新），**不再重复请求**；刷新页面后读**本地缓存记录**（localStorage 存该会话已读的用户回合，含水位 seq），缓存未过期就直接出列表、不发请求 |
| 有新内容（缓存过期） | 缓存水位 < 当前最新回合时，自动**合并重载一次**（`loadThrough(0)`）并更新缓存/水位——最新一条不会因读缓存而缺失 |
| `/rewind` 可用性 | 与“已加载多少历史”**解耦**：非空白、非子代理会话就永远可选（不再因更早内容未加载而消失） |
| `/rewind` 选中首轮（无前史） | 降级：按开关处置原会话（默认归档 / 开启后真删）+ 打开同工作区的新空会话 + 还原问题 |
| 子代理（subagent）会话 | 不提供回退；会话头也不显示处置开关 |
| 空白（blank）会话 | 会话头不显示处置开关 |
| 停止时在排队中的消息 | 回退时一并清掉（`updateQueue remove`） |
| **处置开关（会话头右侧图标排）** | 档案柜=归档（默认）⇄ 红色带叉垃圾桶=删除，单击切换；**全局偏好**，经 settings 命名空间 `esc-rewind.deleteOldOnRewind` 持久化（设置页可见），所有普通会话的回退都按它处置旧会话 |
| 删除模式下回退 | 先 fork 并确认新分支打开可用，**然后**才真删旧会话；删除失败自动**降级为归档**并 toast「删除失败，已改为归档」；成功 toast「旧会话已删除」 |
| 删除模式与既有删除按钮 | 本开关图标带叉/红色警示，语义是“下次回退时处理旧会话”，与 chameleon「删除当前会话」的普通垃圾桶视觉可区分 |

## 为什么默认是 fork+归档，删除是可选项

DSH 会话日志是 **append-only**：没有任何受支持的插件 API 能在当前会话里删消息（`/compact` 用的 surface-replace 只能“换一段为一条新节点”且为宿主内部，客户端 `'rewind'` 类型是死代码）。因此“回退”用核心一等公民表达：

1. **fork** 于目标回合的上一完整回合边界（与 Branch 按钮同款 `sessions.fork({atSeq})`，`increaseTitle:false` 后按需改回原标题）；
2. **按开关处置原会话**：默认 `workspaces.archiveSession`（归档隐藏、日志保留可恢复）；开启删除后，fork+open 新分支确认可用才经宿主半真删（磁盘日志目录 + 投影缓存 + 工作区记账一并移除）；
3. **open 分支**并还原问题文本（`inputActions.setDraft`，图片经 `readAttachment`→`createDraftImages`→`addImages` 尽力还原）。

**为什么删除不是默认**：客户端没有任何官方“删除会话”verb，真删必须宿主动盘（`src/index.js` 自建端点/工具），且**不可恢复**。因此开关默认关闭（归档=安全侧），只有用户显式打开才进入删除态；删除态下**无二次确认**（已接受误触即永久丢失的风险），防误触靠：默认关闭 + 图标红叉状态 + 切换/停止/执行的 toast 警示。

## 删除模式（宿主半）

- **settings**：node 半注册命名空间 `esc-rewind`，字段 `deleteOldOnRewind`（boolean，默认 `false`）。客户端经 `remote.settings.describe()` 读取、切换时 `update()` 写入；读取失败/缺字段一律回退 `false`（绝不因读不到配置而误开删除）。设置页可改（settings/document-updated 会即时刷新会话头图标）。
- **删除通道**（自建，无第三方依赖）：`webServer` 提供 `POST /__esc-rewind/session/delete`（校验 sessionId 格式与 POST 方法）；同时注册模型工具 `esc_rewind_session_delete`（terminal/edit-mode 可用）。`webServer`/`tools` 缺席时删除通道不可用，客户端自动降级归档。
- **只读诊断端点**：`GET /__esc-rewind/status` 回报宿主半健康度——`settingsSectionRegistered` / `settingsSectionError` / `deleteOldOnRewind`（当前删除模式）。非 GET 方法回 405。排查「图标点了没反应 / 删除模式像没生效」时先打它，判断的是宿主半有没有起来，不看会话内容。
- **客户端诊断快照**：`window.__dsew`（门控计数、最后一次决策、删除模式位；不含消息内容）。
- **删除核心** `deleteSessionCore`：拒绝运行中 agent → flush → detach → 删磁盘日志目录（两种 id 拼写）→ 清投影缓存 → 复扫磁盘（防 dispose 重建）→ 确认无残留后才清工作区/归档记账；失败抛错不碰记账（半删会话不会掉进 Ungrouped）。
- **安全时序**：删除永远在“新分支 fork+open 成功并可用之后”；删除失败 → 降级 `archiveSession` + toast，回退本身不失败。

## 键盘捕获与防误触

- 监听 `document` **capture 阶段** keydown（在核心所有 bubble 阶段 Esc 关闭逻辑之前），但**硬门控**：仅当会话处于可回退状态、无弹层/菜单/dialog/输入补全打开、且焦点不在外来文本框时才拦截；任何不确定都放行（`Esc` 永远优先服务于“关闭弹层”）。
- armed 是**派生状态**而非记忆状态：running（可停止）或尾部为 `interrupted` assistant（已停）且草稿为空；自然完成的 settled 尾部永不 armed。
- 自动提示（工具栏 Stop 路径）**不读瞬态投影**：下降沿只记「候选回合」，由**宿主耐久证据**结算（尾部 `interrupted` 或该轮 `turn/end` 为 `aborted`/`user`）。原因见 `docs/knowledge/2026-09-08-dsh-esc-rewind.md` v7.2：运行中的 assistant 行在 `chat.legacy.nodes` 里不产出节点，下降沿那一帧的尾巴是本轮刚发出的 user 提问，用「尾部非 settled」判停止会在自然结束时误弹。
- 按会话隔离：切换会话即失效；诊断快照 `window.__dsew`（计数/最后门控/删除模式位，不含消息内容），其中 `hintToasts`/`lastHint` 专用于排查「提示为什么弹/没弹」。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: esc-rewind, name: 'dsh-esc-rewind' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

**开发形态**：外部 client bundle 原样伺服，改 `src/client.js` 后**刷新页面**即可（`pnpm run dev:web` 时走 HMR）；**改 `src/index.js`（宿主半）后需重启 GUI host**。

## 开发 / 验证

```bash
node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs   # 逻辑 harness（49 条，含删除模式与提示时机的真机形态用例）
node --check sub-plugins/dsh-esc-rewind/src/client.js
node --check sub-plugins/dsh-esc-rewind/src/index.js
```

浏览器手测见 `ACCEPTANCE.md`。
