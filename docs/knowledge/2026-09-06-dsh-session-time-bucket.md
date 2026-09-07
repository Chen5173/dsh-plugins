# DSH 插件：侧栏「按时间桶」分组（dsh-session-time-bucket）

> 日期：2026-09-06　产物：`dsh-session-time-bucket/`（README/ACCEPTANCE 见该目录）

## 目标与定稿（v2：跟随核心视图）

给 DSH Web 侧栏的会话列表加「按时间桶」分组：今天/昨天/前7天/前30天/更早（按 updatedAt、本地自然日），组标题带数量可折叠并记忆、行尾显示相对时间、行标题**恒**带 `[工作区名]` 前缀（未分组 `[未分组]`）。

**最终架构（v2，2026-09-06 定稿）：跟随核心视图，零独立入口**——插件读取核心持久化的视图状态 `dsh.workspace.view.v5`（localStorage，整值 JSON `{groupBy:'workspace'|'flat', orderBy:'manual'|'updated', …}`，核心每次变更同步写回），当核心处于 **单列表(flat) + 最近更新(updated)** 时自动激活：只隐藏核心 `listArea`、挂自绘时间桶列表；核心 `header`（分组方式/排序方式菜单、搜索、＋新建）原样保留；切回 按工作区/手动排序 或进入搜索（`[class*=searchExpanded]`/`[class*=searchTree]` 出现）即自动还原；窄栏 rail 不激活。1s tick 轮询 localStorage 判定。

v1 曾采用「独立入口 + 自绘弹层 + 整节接管」（commit cf8a5ad），v2 按用户要求改为跟随式，并去掉「显示工作区」开关（恒显示）。

## 可复用结论

1. **核心 ui-workspace 的“分组方式”菜单（ViewOptionsMenu）在真实运行时无法安全注入**：它是 portal + 两阶段定位渲染的 React 菜单；向其中插入/追加行会导致“菜单空/一闪即没”（本仓库多轮实测：jsdom 静态复现正常、真机必现，无 console 报错）。结论：**不要对该菜单做任何 DOM 注入**。想要类似分组/排序的自定义视图时，优先考虑「跟随核心视图 + 替换列表区域」而非加菜单项。
2. **核心视图状态可外部读取，且可靠**：`createWorkspaceViewStore()`（ui-workspace/src/client/stores.ts）`persist: 'dsh.workspace.view.v5'`；`packages/client/store/src/index.ts` 的 `attachPersistence` 把**整值 JSON 同步写 localStorage**（key 即 persist 名，每次变更都写回）。因此外部插件读该 key 即可获得 groupBy/orderBy 等视图状态，无需 DOM 推断。同型可推：其它 `defineStore(… persist: …)` 的状态（如 locale settings-store 等）都可这样读取。
3. **接管/恢复 = 纯样式开关**：接管 = 只隐藏核心 `listArea`（inline display:none）并挂自绘列表；恢复 = 还原 display。核心 React 状态不被改动，因此安全。保留 header 时用户体验最接近原生（菜单/搜索可随时切换，插件自动跟随退出）。
4. 数据通道：`sessions`/`workspaces` 客户端服务可直接 ctx.get/inject（见前篇）；归档是 workspace 快照 `archivedSessionIds` 全集；打开 = `sessions.open(id)`；新建走核心 header 的 ＋（无需插件自建）。
5. DOM 锚点：核心“视图选项”按钮 aria-label = `视图选项`/`View options`（随 locale）；CSS Modules 子串 class `[class*=headerActions]`/`[class*=sectionHeader]`/`[class*=listArea]`；无稳定 id/data-*。搜索激活检测：`[class*=searchExpanded]`（header 搜索展开）或 `[class*=searchTree]`（列表区搜索树）。
6. 外部插件 `src/client.js` 是纯 JS 被原样伺服：改后**刷新页面**即可；`pnpm run dev:web` 的 HMR 只管 H 核心 packages（`packages/*/*`），不覆盖本仓库。
7. 测试形态：`window.__DSH_TEST__` 暴露纯函数（分桶/投影/前缀/相对时间/字典/视图跟随判定），`test/bundle.test.mjs` 用 `new Function` 物化 bundle 断言逻辑，localStorage 用 stub（注意 bundle 内取 localStorage 需经 `getStorage()` 兼容 Node 无全局 localStorage）；DOM 交互留 ACCEPTANCE 手工清单。
