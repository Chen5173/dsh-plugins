# 插件目录：每个插件做了什么、怎么用

> 本页是**用法索引**（做什么 + 在哪触发 + 前提）。每个插件的完整行为表、设计取舍与验收清单在各自的 `README.md` / `ACCEPTANCE.md`，本页只做已核对的摘要，不重复细节。
>
> 表中每条**触发方式、槽位、order、设置项、端点**都是 2026-09-11 从 `src/` 源码逐项核对过的（不是照抄旧文档）；核对方法见文末。

## 先装哪个

**只装 `dsh-plugin-manager` 一个**，其余全部在它的面板里开关——不需要、也不应该逐个 `dsh plugin add`：

```bash
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git   # 从 git
dsh plugin --profile web add <本机仓库根>                                       # 本机开发（活链接）
```

装完重启 `dsh web` → 设置 →「本地插件」→ 打开想用的插件开关 → **再刷新一次页面**（宿主侧即时生效，客户端 UI 需要一次刷新）。两种入口的差别（快照 vs 热改）见根 `README.md`「统一安装模型」。

## 一览表

| 插件 | 一句话 | 你在哪用它 | 形态 | 启用前提 |
|---|---|---|---|---|
| [`dsh-plugin-manager`](../dsh-plugin-manager/README.md) | 管理本仓库全部子插件的唯一控制台 | 设置 → **本地插件** | 宿主 + 客户端 | 装它本身即可 |
| [`dsh-composer-history-recall`](../sub-plugins/dsh-composer-history-recall/README.md) | 输入框里 `↑`/`↓` 逐条召回**本会话你发过的**消息 | composer 键盘 | 纯客户端 | 需 `conversation.input.overlay` 槽 + composer 根 `data-composer-input`；缺席则惰性不生效 |
| [`dsh-esc-rewind`](../sub-plugins/dsh-esc-rewind/README.md) | `Esc` 停止、`Esc Esc` 回退本轮重来、`/rewind` 从任意历史轮重来；旧会话可归档或真删 | composer 键盘 + `/rewind` + 会话头图标 | 客户端 + **宿主半**（删除模式） | 删除模式需要 `webServer`；无则自动降级为归档 |
| [`dsh-composer-provider-label`](../sub-plugins/dsh-composer-provider-label/README.md) | 在模型名左边显示**实际打到哪个 provider**，并给出提供方/模型两级选择菜单 | composer 右侧标签（点开即菜单） | 客户端 + 可选宿主设置段 | 核心 **≥ 0.1.2-rc.1**；无 `Menu` 原语时退化为只读标签 |
| [`dsh-session-title-regenerate`](../sub-plugins/dsh-session-title-regenerate/README.md) | 用**最低推理档**摘要本会话全部提问，重生成 ≤60 字标题 | 会话头按钮 / 侧栏行 `⋯` 菜单 / `/regenerate-title` | 客户端 + 宿主命令 | 核心 ≥ 0.1.1-rc.2 |
| [`dsh-session-time-bucket`](../sub-plugins/dsh-session-time-bucket/README.md) | 侧栏会话列表按**今天/昨天/前7天/前30天/更早**分组 | 自动：核心处于「单列表 + 最近更新」时接管观感 | 纯客户端 | 无需操作；切到按工作区/手动排序或搜索时自动退出 |
| [`dsh-open-session-workdir`](../sub-plugins/dsh-open-session-workdir/README.md) | 一键用**系统文件管理器**打开当前会话的工作目录 | 会话头文件夹图标 | 纯客户端 | 会话有 `cwd` 且宿主有桌面，否则按钮不出现 |

## 逐个怎么说"怎么用"

### dsh-plugin-manager — 本地插件管理器

- **入口**：设置页左侧一级导航「本地插件」（`settings.section`，`order: 16`）。
- **能做什么**：列出仓库 `sub-plugins/` 下全部 `dsh-*`（管理器自己不列入），每行一个主开关 + 「移除」；顶部有 **全部开启 / 全部关闭** 两个批量按钮（按钮上的数字就是本次真正会改动的项数，跳过的旧布局/仅依赖/非插件目录不计）与「一键接管/迁移」。
- **开关语义**：开 = 自动补 profile `devDependencies` 的 `link:` + 写激活行；关 = 行保留、写 `disabled: true`（可随时再开，不丢配置）；移除 = 删激活行 + 摘依赖（**仓库源码目录保留**）。
- **诊断**：`GET /__dsh-plugin-manager/status`（含 `pendingWrites` 未落盘数与 `lastFlushError`）、`GET /list`。
- **注意**：切换带界面的子插件后，面板只会**提示**你刷新，不会自动刷新页面。

### dsh-composer-history-recall — 输入框历史召回

- **怎么用**：光标停在草稿**首行**按 `↑` 进入召回，继续 `↑`/`↓` 逐条走；到最早一条再 `↑` 会停在原地并提示「已是最早一条历史」；手动编辑一下就退出浏览。
- **不会做什么**：只写草稿，**绝不自动发送**；不改动会话消息与运行状态；不写任何持久数据。
- **什么时候让路**：光标在中间行、草稿含 `@文件` chip、正在输入 `/命令` 或 `@提及`（补全菜单打开）——这些情况方向键交回编辑器/菜单。
- 按会话隔离：切换会话游标重置。

### dsh-esc-rewind — 停止 / 回退重来

- **三个触发**：① 生成中按 `Esc` = 停止（等价 Stop 按钮）；② 停止后**再按一次** `Esc` = 回退整个最后一条，`fork` 新分支 + 把原问题还原到输入框；③ 输入 `/rewind` 打开回合选择器，可从**历史任意一轮**重来。
- **旧会话怎么处置**：会话头右侧一个图标切换（档案柜 = 归档，默认；红色带叉垃圾桶 = 真删）。这是**全局偏好**，持久化在 settings 命名空间 `esc-rewind.deleteOldOnRewind`（默认 `false`），设置页也能改。删除态**没有二次确认**，且删除失败会自动降级为归档而不是让回退失败。
- **防误触**：自然正常结束的回合**不会** armed（尾部是 settled assistant 时 `Esc` 不接管）；编辑过输入框草稿、切换会话、有弹层/菜单打开时都会让路或失效。
- **`/rewind` 性能语义**：同一页面内首次打开会 `session.loadThrough(0)` 一次性读全历史（之后直接读活会话），刷新后走 localStorage 缓存 + 水位判定，过期才合并重载。
- **回退前会先清「未落定的排队消息」**：宿主的 fork 用事件种子重建子会话，父会话里刚发出、还没落盘的排队输入会被一起复制过去（子会话会先执行它、用户新发的只能排队）。所以回退前会删排队项并**等到快照确认清空**；清不掉就**放弃本次回退**并提示「该会话还有没发出的消息在排队…」。诊断：`__dsew.pendingCleared` / `pendingBlocked` / `childPendingCleared`。
- **跨核心世代的契约**（都用能力探测，不读版本号）：草稿附件族（0.1.5 起 `createDrafts`/`releaseDraftAttachment`/`addAttachments`，旧名回退）；命令描述（0.1.5 起 `description` 由字符串变函数，用 getter 在读取时定型，见 `__dsew.commandDescShape`）。
- **诊断**：宿主 `GET /__esc-rewind/status`（settings 段是否注册成功 + 当前删除模式）、删除走 `POST /__esc-rewind/session/delete`；客户端 `window.__dsew`（门控计数，不含消息内容）。
- **改宿主半（`src/index.js`）需重启 GUI host**，改 `src/client.js` 刷新页面即可。

### dsh-composer-provider-label — provider 标签与两级选择

- **在哪**：composer 工具行右侧组、**模型选择器左边一格**：`[…] [provider] [DeepSeek-V4-Flash · high] [上下文] [发送]`。
- **怎么用**：点标签弹出菜单 → 根层有「提供方」「模型」两行 → 点提供方**立即切换**（当前模型仍属于它就保留，否则优先 profile 默认模型、再否则该方第一个模型），随后自动进入模型层方便接着选；底部常驻「全部提供方 / 仅当前提供方」互斥开关。键盘 Tab/Enter/Esc。
- **只读信息**：悬停/聚焦标签 → tooltip 给出 provider 完整名 · 模型 id · 当前推理档 · **路由来源**（本会话显式选择 / 跟随 profile 默认）。
- **短名从哪来**：settings 别名 > 内置表（只预置 `deepseek-official → office`）> 注册显示名剪掉尾部括号 > provider id。
  ```yaml
  dsh-composer-provider-label:
    providerAliases:
      codemaker: cm
  ```
  ⚠️ 已知限制：settings 段只有在宿主半能解析到 `@deepseek-ai/schemastery` 时才注册，**`link:` 安装形态下解析不到**，此时 `providerAliases` 不生效（只用内置别名）。
- **注意**：`session/selectModel` 会顺带更新 profile 默认模型——一次选择既是本会话下一次请求、也成为默认。
- 显示范围偏好存浏览器 localStorage（`dsh.composer-provider-label.v1`），不写宿主配置。

### dsh-session-title-regenerate — 重新生成标题

- **三个入口，同一套逻辑**：会话头部操作区按钮 / 侧栏会话行 `⋯` 菜单项「重新生成标题」/ 宿主命令 `/regenerate-title`。
- **为什么菜单项对任意历史会话都有效**：走 `remote.commands.execute(sessionId, …)`，该 Remote 的 `agent` 查找会**自动恢复未打开的会话**，且**不切换你当前对话**。
- **产出**：单行 ≤60 字、跟随消息语言的标题，直接覆盖旧标题；成功 Toast「标题已更新：…」。**副作用**：标题以 `user` 来源固定，此后新消息不会再自动更新它，要改得再点一次。
- **配置**（写在管理器生成的 insert 项的 `config:` 上，不要另起顶层覆盖行，否则首次开关会被规范化并丢掉字段）：`provider` / `model`（必须成对）、`targetWords`、`targetCjkCharacters`、`maxInputBytes`、`maxOutputTokens`、`timeoutMs`。
- **可观测**：会话流里会留下一对 `command/run`/`command/done` 节点（`recordInput:false`，不记录参数）。

### dsh-session-time-bucket — 侧栏时间桶分组

- **怎么用**：**没有按钮**，全自动。核心侧栏处于「单列表 + 最近更新」时激活，在核心原生列表上注入组头与 `[工作区]` 前缀；切回「按工作区」或「手动排序」、或进入搜索，自动完整退出、零残留。
- **能操作什么**：点组头的 chevron 折叠/展开该桶，折叠态持久化（刷新仍记住）。
- **明确保留的核心原生行为**：状态点、悬停提示卡、行尾 `⋯` 菜单、点行打开、拖拽排序——插件一律不接管。窄栏（rail）不激活。
- **实现约束值得知道**：它读核心的 localStorage 视图状态 `dsh.workspace.view.v5` 判定是否激活，并会按「桶序 + updatedAt」重排官方行；核心「+新会话」复用空白旧会话的特例被单独处理（始终落在「今天」且桶内最新）。

### dsh-open-session-workdir — 打开会话工作目录

- **在哪**：会话头部那一行右侧图标排，只有图标（悬停「打开工作目录」）。不在左侧列表行上，也不在右侧文件面板里。
- **怎么用**：点一下 → 系统文件管理器打开该会话 `cwd`；成功 Toast「已交给系统打开」。
- **两个容易误判的点**：① 对**同一目录**再点一次，Windows 资源管理器会复用已有窗口，**不会新开**——所以文案变成「该目录已在文件管理器中打开」，这不是坏了；② 目录开在**宿主机器**上，不是浏览器所在机器（远程 Web UI 场景的常见困惑），失败卡片里始终备着完整路径 + 复制按钮。
- **失败时**：目录不可访问 / 宿主报错 / 8s 超时都会给锚定卡片说明原因。三条打开通道全不可用时按钮**仍然出现**并给出写明三个服务名的失败卡片——故意不做成不可见，好让故障能被发现了。
- **与 `dsh-better-sidebar` 可共存**：后者会把 `openWorkspacePath` 影子化（让文件链接开在它自己的侧边栏编辑器），本插件改走 `workspaces.openPath` 绕开，两者可同时启用。

## UI 触点分布（核对过的槽位与 order）

同一槽位内按 `order` 升序排列；不同插件的 order **互不相同**，所以启用任意组合都不会互相遮蔽。

| 触点位置（槽位） | 插件行（order） |
|---|---|
| composer 覆盖层 `conversation.input.overlay` | `dsh-composer-history-recall`（50）· `dsh-esc-rewind`（60） |
| composer 右侧组 `conversation.input.right` | `dsh-composer-provider-label`（10，紧邻核心模型选择器左侧） |
| 会话头操作区 `conversation.session.header.actions` | `dsh-open-session-workdir`（25）· `dsh-session-title-regenerate`（27）· `dsh-esc-rewind` 处置开关（28）；核心自身另有 日程(10)/任务(20)/删除(30) |
| 设置页 `settings.section` | `dsh-plugin-manager`「本地插件」（16） |
| 斜杠命令 | `/rewind`（客户端 `commandUi` 贡献）· `/regenerate-title`（宿主命令） |
| 侧栏会话行 `⋯` 菜单 | `dsh-session-title-regenerate`（DOM 注入，核心无插件槽） |
| 侧栏会话列表 | `dsh-session-time-bucket`（就地注入组头 + `[工作区]` 前缀，非槽位） |
| 宿主 HTTP | `/__dsh-plugin-manager/{status,list,set-enabled,set-all-enabled,remove,migrate}` · `/__esc-rewind/{status,session/delete}` |

> ⚠️ 三个插件都往**会话头图标排**放东西（25/27/28），`dsh-open-session-workdir` 的 README 里那句「从左到右：日程(10) → 任务列表(20) → 打开的文件夹(25) → 删除会话(30)」只描述了**没装另两个插件时**的样子，别当成固定顺序。

## 核对方法（本页怎么保证不是抄来的假信息）

本仓库有过「文档声称存在、实际文件不存在」的事故（见 `docs/knowledge/2026-09-11-install-via-git-url.md`），所以整理时**没有信任旧 README**，而是：

1. 把每个 `.md` 里的 `node <path>` / `node --check <path>` 命令逐条拿去查文件是否存在 → 抓出 6 处**子插件迁进 `sub-plugins/` 之前的旧扁平路径**（已修）。
2. 扫每个 `src/client.js` 的 `slots.register` 与顶部常量，取真实 `SLOT`/`ROW_ID`/`ROW_ORDER` → 与文档逐条比对，抓出 `dsh-open-session-workdir` 会话头顺序描述不完整。
3. 扫宿主半的 `HTTP_PREFIX`/`SETTINGS_FIELD`/`DELETE_PATH`/`STATUS_PATH` 与 `DEFAULTS` 键名 → 补上 `dsh-esc-rewind` 未记载的只读端点 `/__esc-rewind/status`。
4. 抽查只有纯客户端半的插件（`history-recall`、`time-bucket`）宿主入口确实为 0，「不含宿主端点」的说法成立。
