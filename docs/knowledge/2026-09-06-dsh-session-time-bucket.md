# DSH 插件：侧栏「按时间桶」分组（dsh-session-time-bucket）

> 日期：2026-09-06　产物：`dsh-session-time-bucket/`（README/ACCEPTANCE 见该目录）

## 目标与定稿（v3：跟随核心视图 + 就地增强）

给 DSH Web 侧栏的会话列表加「按时间桶」分组：今天/昨天/前7天/前30天/更早（按 updatedAt、本地自然日），组标题带数量可折叠并记忆、行标题**恒**带 `[工作区名]` 前缀（未分组 `[未分组]`）。

**最终架构（v3，2026-09-06 定稿）：跟随核心视图 + 对官方渲染列表做外科手术式注入，不再重绘**——插件读取核心持久化视图状态 `dsh.workspace.view.v5`（localStorage 整值 JSON `{groupBy, orderBy, …}`，核心每次变更同步写回），当核心处于 **单列表(flat) + 最近更新(updated)** 时激活，但**核心列表保持原样渲染可见**，插件只注入两类节点：

1. **时间桶组头**（button，官方 projectRow 同款几何：34px、三角在 16×20 slot、gap 6、pad 0 8px）插在每桶首行上方——核心没有时间桶概念，这是唯一自绘元素；
2. **`[工作区]` 前缀 span**（12px tertiary、max-width 40% 截断）插在每个官方标题 span 之前；官方 slot→标题的 4px 间隙从标题 margin 转移到前缀上，标题 margin-left 归零，总几何不变。

行的一切（状态点追逐动画、hover 卡、`…` 行菜单 rename/fork/archive、点行打开、拖拽、相对时间）全部是核心 React 组件原生行为，插件**零复制**。折叠 = 对桶内行设 inline display:none（React 不管理这些行的 style，故不被清掉）。

v1（cf8a5ad）独立入口+整节接管 → v2（4a89eed 起）跟随视图+自绘列表 → v3（本版）就地增强。v2 遗留的 `relativeLabel`/`deriveBuckets` 纯函数保留（harness 固定，渲染器已不用）。

## 可复用结论

1. **核心 ui-workspace 的“分组方式”菜单（ViewOptionsMenu）在真实运行时无法安全注入**：它是 portal + 两阶段定位渲染的 React 菜单；向其中插入/追加行会导致“菜单空/一闪即没”（本仓库多轮实测：jsdom 静态复现正常、真机必现，无 console 报错）。结论：**不要对该菜单做任何 DOM 注入**。
2. **核心视图状态可外部读取，且可靠**：`createWorkspaceViewStore()`（ui-workspace/src/client/stores.ts）`persist: 'dsh.workspace.view.v5'`；`packages/client/store/src/index.ts` 的 `attachPersistence` 把**整值 JSON 同步写 localStorage**（key 即 persist 名，每次变更都写回）。外部插件读该 key 即得 groupBy/orderBy，无需 DOM 推断。
3. **React 列表的“注入安全”规律（v3 核心发现，可推广）**：
   - 官方 flat 列表全量渲染（无虚拟化），行 `key=sessionId`；React 调和只看自己的 fiber 记录，**只操作它创建的节点，对插入其间的陌生节点完全透明**——因此在官方行之间插组头、在行内插前缀 span 是安全的；
   - 但 React 重排行时（updated 排序随运行会话持续变化）用 insertBefore 搬自己行，注入节点会留在原地 → 必须用 **MutationObserver（childList+characterData，关闭 attributes 防自触发）** 即时重锚组头；所有写操作先比较后写，保证幂等、不触发观察器死循环；
   - **绝不能搬动官方行本身**（换父级/重排会被 React 按 fiber 拽回）。
4. **行身份匹配（官方 DOM 无 sessionId 可读）**：官方行没有 data-id，但渲染顺序 == recency 顺序（deriveFlat 先 `rows.sort(byRecency)`）；按标题文本逐行与快照匹配（重复标题按序映射，blank 行标题 = 本地化“新会话”），匹配失败的行跳过不注入。anchor 发现：`[class*=flatList][role="tree"]`（兜底：含 `[class*=sessionRow]` 的 tree）；行=`role=treeitem` 且 class 含 `sessionRow`；标题=`[class*=title]`；slot=`[class*=slot]`。
5. 数据通道：`sessions`/`workspaces` 客户端服务可直接 ctx.get/inject；归档是 workspace 快照 `archivedSessionIds`；可见性 = 非 subagent、未归档、blank 仅 current（`sessionVisible`）；打开/重命名/分叉/归档 v3 全走核心行内菜单，插件无需自建（v2 的 `sessions.open/scope/sessionOf` 通道因此删除）。
6. DOM 锚点：核心“视图选项”按钮 aria-label = `视图选项`/`View options`（随 locale）；CSS Modules 子串 class `[class*=headerActions]`/`[class*=sectionHeader]`/`[class*=listArea]`/`[class*=flatList]`/`[class*=searchExpanded]`/`[class*=searchTree]`；无稳定 id/data-*。**真实运行 DOM 的两条实测结论（2026-09-08 无头 Chrome 对 `dsh web` 真机验证）**：① flat 列表 `[class*=flatList][role=tree]` 的直接子节点是 hover-card 锚点 span（`_root_1b2ny_3` 这类纯 hash 类名），`role=treeitem` 的 sessionRow 行在 wrapper 内部——必须用后代查询 `tree.querySelectorAll('[role=treeitem]')` 找行，且组头/折叠锚定到 `row.parentElement`（wrapper），否则 `tree.insertBefore` 会因 anchor 非直接子节点抛错、注入静默失败；② CSSOM 给 style 赋数值会静默丢失（`node.style.fontSize = 12` 无单位被丢弃），内联样式一律写带单位字符串（`'12px'`）。
7. **真实 GUI 诊断工作流（可复用）**：`dsh web` 打印的 URL 带一次性 token；用 curl 带 `-c/-b` cookie jar 即可拿 index.html（含 boot manifest 与各插件 bundle URL `/plugins/??<id>/client.js&rev=...`，改文件后 rev 内容即时更新、无需重启）；装 `puppeteer-core` + 系统 Chrome headless 加载 token URL，等 ~15s 后即可 evaluate 读真实 DOM/localStorage（视图状态 key `dsh.workspace.view.v5` 可先写入再 reload 强制进入 flat+updated）。注意 headless 每次 launch 默认全新临时 profile：折叠态等 localStorage 持久化测试要在同一 browser 实例内 reload 验证。
7. 外部插件 `src/client.js` 是纯 JS 被原样伺服：改后**刷新页面**即可；`pnpm run dev:web` 的 HMR 不管本仓库。
8. 测试形态：`window.__DSH_TEST__` 暴露纯函数（分桶/投影/前缀/行匹配/桶区间规划/相对时间/字典/视图跟随判定），`test/bundle.test.mjs` 用 `new Function` 物化 bundle 断言逻辑，localStorage 用 stub（bundle 内取 localStorage 需经 `getStorage()` 兼容 Node）；DOM 交互留 ACCEPTANCE 手工清单。
