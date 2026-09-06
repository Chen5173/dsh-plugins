## Why

每个 DSH 会话都绑定一个工作目录（会话摘要里的 `cwd`），但 Web GUI 里没有任何入口能跳到那个目录：想看会话产出的文件、复制路径、或在里面手动开个终端，只能凭 slug 编码去磁盘上猜（`~/.dsh/sessions/--D-ChenSirDocument-Dsh-Projects-dsh-plugins--/…`）。

DSH 核心其实**已经具备**把路径交给宿主桌面打开的能力——`session.openWorkspacePath` 这个 Remote 会走到 Host 的 `openNativePath`，在 Windows 上执行 `powershell.exe -NoProfile -Command Invoke-Item -LiteralPath '<path>'`，目录因此由资源管理器打开。客户端会话摘要也已经带着 `cwd`。缺的**只是 UI 触点**：全客户端只有聊天正文里的 `openFile`（针对文件提及）用了这个 Remote，会话本身没有入口。

## What Changes

- 新增一个 DSH 插件包（**纯 client 侧** cordis bundle），在 `conversation.session.header.actions` 这个 list 槽位注册一枚「打开工作目录」图标按钮。
- 点击后把当前会话的 `cwd` 原样交给核心客户端服务 `ctx.workspaces.openPath(cwd)`（内部 `host.openPath`），由 Host 交给系统默认程序（Windows = 资源管理器打开该目录内部；不改动核心）。**不用** `remote.session.openWorkspacePath`：该方法是聊天侧共用漏斗，已被 `dsh-better-sidebar` 影子化，会把目录当文件读并报 `"<path>" is a directory`。
- 按钮可见性受双重门控：`canOpenWorkspacePath()` 为真 **且** 当前会话有非空 `cwd`；否则整枚按钮不渲染。
- 失败反馈：打开失败（目录已被删、PowerShell 报错、Remote 超时）时给出可读 Toast，并提供「复制路径」兜底；成功时给出轻量确认。
- 文案跟随客户端 locale（zh/en），复用 `locale` 服务注册命名空间。
- **不做**：不新增 Host HTTP 端点、不新增模型工具、不改 DSH 核心、不碰侧边栏会话行菜单（无官方槽位，DOM 注入留给后续变更）。

## Capabilities

### New Capabilities

- `session-workdir-open`: 从会话视图把该会话的工作目录交给宿主系统文件管理器打开这一用户可见行为——按钮何时出现、点击产生什么结果、失败如何反馈、文案如何跟随语言。

### Modified Capabilities

- 无。`openspec/specs/` 目前为空，本变更不修改任何既有能力的需求。

## Impact

- **新增**：插件包目录（`package.json` + `cordis.patch.yml` + `src/client.js`），发布为 npm 包并带 `dsh-plugin` keyword。
- **安装面**：profile 的 `package.json` → `dsh.profile.bundles` 追加一项；`cordis.patch.yml` 由插件自带的 `- insert:` 行落地（与 `@huanlin/dsh-plugin-session-delete` 同构）。
- **运行时依赖（均为核心已有、已在 web profile 内）**：
  - Remote：`session.canOpenWorkspacePath`（`@deepseek-ai/dsh-api-session-controller`，仅用于能力门控，未被任何插件影子化）
  - 客户端服务：`workspaces.openPath`（`@deepseek-ai/dsh-client-runtime` 的 `WorkspaceRuntime`，与 `dsh-client-ui-directory-picker-native` 用的 `ctx.workspaces` 同一个服务）
  - 客户端服务：`sessions`（`list.getSnapshot().byId[id].cwd`）、`locale`、`slots`
  - UI 件：`@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`、`Toast`、`IconFolderOpenOutline16`、`writeClipboard`
- **不受影响**：会话日志与投影缓存、workspace 记账、Host 存储、模型工具集、其它 profile（terminal-only 无 web 表面时按钮自然不出现）。
- **已知边界**：`openWorkspacePath` 在 **Host** 机器上执行。当浏览器与 Host 不同机（远程 Web UI）时，资源管理器开在 Host 上——本变更只负责把这个事实说清楚（Toast 提示 + 复制路径），不做转发。
