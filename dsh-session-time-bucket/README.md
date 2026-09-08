# dsh-session-time-bucket

给 DSH Web GUI **侧栏会话列表**的“单列表 + 最近更新”视图加时间桶分组：今天 / 昨天 / 前7天 / 前30天 / 更早（按会话**最近更新时间**、本地自然日分桶），行标题恒带所属工作区前缀。

采用**跟随核心视图 + 就地增强**的架构：插件读取核心持久化的视图状态（localStorage `dsh.workspace.view.v5`），当核心处于 **单列表(flat) + 最近更新(updated)** 时，在核心自己渲染的列表上**增量注入**两组节点——时间桶组头 + 行内工作区前缀——**不重绘、不替换任何官方元素**：

- 会话行保持核心原生渲染：状态点（进行中蓝色追逐/已完成绿点）、悬停提示卡、行尾 `…` 操作菜单（重命名/分叉/归档）、点行打开、拖拽排序——全部是核心自己的 React 组件与 CSS，插件完全不复制。
- 只在两处做注入：① 每桶首行上方插一个组头（官方项目行同款 34px/三角 slot/gap 6）；② 每行官方标题 span 前插一个 `[工作区]` 前缀 span。
- React 安全性：核心按 fiber 记录调和子节点，只操作它自己创建的节点；注入节点对 React 透明，行顺序变化时插件用 MutationObserver 即时重锚组头。

纯客户端插件。不注册宿主端点、不新增模型工具；数据来自核心 `sessions` / `workspaces` 两个客户端服务（仅用于分桶、工作区名与行身份匹配——不做任何渲染）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 核心处于 单列表+最近更新 | 自动激活：核心列表**保持原样渲染**，仅在其行间/行内注入组头与工作区前缀 |
| 时间桶组头 | 出现在每桶首行上方：今天/昨天/前7天/前30天/更早（**空桶不出现**）；chevron（▾/▸）+ 数量；点击折叠（隐藏该桶全部行）/展开，折叠态持久化 |
| 会话行 | 核心原生行：状态点、悬停提示卡、`…` 菜单、拖拽、打开全部为核心行为；插件只加 `[工作区名]`/`[未分组]` 前缀（12px tertiary，贴标题前） |
| 行身份匹配 | 渲染顺序 == 核心 recency 顺序，按标题文本逐行匹配（重复标题按序映射）；匹配失败的行不注入、保持原样 |
| 点某一行 | 核心原生 `onOpen`（插件不接管） |
| 切回 按工作区 / 手动排序 | 自动退出：移除全部注入节点，核心列表原样保留 |
| 进入搜索 | 自动退出（搜索树接管列表区域），退出搜索后若仍在 单列表+最近更新 则自动恢复 |
| 窄栏（rail） | 不激活 |
| 刷新 | 折叠态记住；核心视图状态由核心自己持久化，恢复后自动跟随 |

## 设计约束与取舍

- **不重绘、不复制官方行**：行的一切交互与样式（状态点、hover 卡、行菜单、拖拽）由核心 React 组件原生提供；插件注入的只有组头与 4px 宽的文本前缀，官方视觉格式天然一致，无“适配漂移”。
- **React 调和安全性**：React 用 key 调和 `list` 子节点、只读写它自己 fiber 里记录的节点；插入其间的组头对 diff 不可见。核心按更新顺序重排行时，MutationObserver（childList/characterData，关闭 attributes 防自触发）即时重锚组头；所有写操作先比较后写，保证幂等不死循环。
- **行顺序不重排**：核心 recency 顺序天然产生单调的桶区间（今天在前…更早在后），插件只在桶边界插组头，绝不搬动官方行（手动拖乱后组头按实际顺序成段出现，每段独立折叠）。
- **视图状态读取不靠 DOM**：核心把 `{groupBy, orderBy, …}` 整值 JSON 同步持久化到 `dsh.workspace.view.v5`，插件 1s 观察器读它判定激活；搜索态/rail 由 DOM 特征判断。
- **退出零残留**：exit 时删除组头、删除前缀 span、还原标题 margin、展开全部折叠行；React 列表不受影响。
- 列表数据不爬 DOM：会话元数据由 sessions/workspaces 服务快照推导；任何异常 try/catch 兜底。
- 无 React：纯 DOM + `--dsw-*` 令牌；文案跟随 locale（zh/en）。

## 安装

```bash
dsh plugin --profile web add dsh-session-time-bucket   # 或 add ./dsh-session-time-bucket（本地活链接）
```

仓库统一安装模型（聚合伞包）见根 `README.md`：根 `package.json.dependencies` + 根 `cordis.patch.yml` 各一行，profile `devDependencies` `link:` 后 `dsh plugin --profile web install`。外部 client bundle 原样伺服：改 `src/client.js` 后**刷新页面**即可（`pnpm run dev:web` 时走 HMR）。

## 开发 / 验证

```bash
node dsh-session-time-bucket/test/bundle.test.mjs   # 逻辑 harness（14 条）
node --check dsh-session-time-bucket/src/client.js
```

浏览器手测见 `ACCEPTANCE.md`。
