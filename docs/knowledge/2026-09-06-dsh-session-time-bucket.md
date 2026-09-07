# DSH 插件：侧栏「按时间桶」分组（dsh-session-time-bucket）

> 日期：2026-09-06　产物：`dsh-session-time-bucket/`（README/ACCEPTANCE 见该目录）

## 目标与定稿

给 DSH Web 侧栏会话/工作区区加「按时间桶」分组：今天/昨天/前7天/前30天/更早（按 updatedAt、本地自然日），组标题带数量可折叠并记忆、行尾显示相对时间、行标题可切 `[工作区名] 标题`。

**最终架构：独立入口 + 自绘弹层 + 整节接管**（在核心“视图选项”旁加自己的时钟入口；点开自绘弹层：分组方式 → 按时间桶 → 选中后横线 + 显示工作区；激活后接管整节，迷你头部含 入口/按时间桶/显示工作区/＋新建/×退出）。

## 可复用结论

1. **核心 ui-workspace 的“分组方式”菜单（ViewOptionsMenu）在真实运行时无法安全注入**：它是 portal + 两阶段定位渲染的 React 菜单；向其中插入/追加行会导致“菜单空/一闪即没”（本仓库多轮实测：jsdom 静态复现正常、真机必现，无 console 报错）。结论：**不要对该菜单做任何 DOM 注入**。想要原生观感入口时，在核心 `headerActions` 里**尾部 append 自己的入口按钮**（title-regenerate 往行菜单尾部追加是安全先例），入口配**自绘弹层**复刻菜单外观即可。
2. **接管/恢复 = 纯样式开关**：接管 = 隐藏核心 header+listArea（inline display:none）并挂自绘整节；恢复 = 还原 display。核心 React 状态不被改动，因此安全。入口按钮的选中色可表示激活态。
3. 数据通道：`sessions`/`workspaces` 客户端服务可直接 ctx.get/inject（见前篇）；归档是 workspace 快照 `archivedSessionIds` 全集；打开 = `sessions.open(id)`；新建 = `sessions.create`，宿主 cwd 回退 `workspace?.path ?? cwd ?? defaultCwd`（api/session-controller/src/commands.ts:87）。
4. DOM 锚点：核心“视图选项”按钮 aria-label = `视图选项`/`View options`（随 locale）；CSS Modules 子串 class `[class*=headerActions]`/`[class*=sectionHeader]`/`[class*=listArea]`；无稳定 id/data-*。
5. 外部插件 `src/client.js` 是纯 JS 被原样伺服：改后**刷新页面**即可；`pnpm run dev:web` 的 HMR 只管 H 核心 packages（`packages/*/*`），不覆盖本仓库。
6. 测试形态：`window.__DSH_TEST__` 暴露纯函数（分桶/投影/前缀/相对时间/字典），`test/bundle.test.mjs` 用 `new Function` 物化 bundle 断言逻辑；DOM 交互留 ACCEPTANCE 手工清单。

