# dsh-session-time-bucket

给 DSH Web GUI **侧栏会话列表**的“单列表 + 最近更新”视图加时间桶分组：今天 / 昨天 / 前7天 / 前30天 / 更早（按会话**最近更新时间**、本地自然日分桶），行标题恒带所属工作区前缀。

采用**跟随核心视图**的架构（不改核心、**不注入核心的“分组方式”菜单**——该菜单在真实运行时无法安全扩展，见知识库篇目）：插件读取核心持久化的视图状态（localStorage `dsh.workspace.view.v5`），当核心处于 **单列表(flat) + 最近更新(updated)** 时，自动把列表区域替换为时间桶分组；切回“按工作区”/“手动排序”或进入搜索，自动还原核心列表。核心头部（分组方式/排序方式菜单、搜索、＋新建）始终保留、可随时操作。

纯客户端插件。不注册宿主端点、不新增模型工具；数据来自核心 `sessions` / `workspaces` 两个客户端服务，点开会话走 `sessions.open(id)`。

## 行为

| 情况 | 表现 |
| --- | --- |
| 核心处于 单列表+最近更新 | 自动激活：仅隐藏核心列表区域，替换为时间桶列表（核心头部保留） |
| 时间桶列表 | 全部工作区 + 未分组会话混合，按 `updatedAt` 落桶；桶内最新在前；**空桶隐藏**；组标题带 chevron（▾/▸）+ 数量、可折叠并记住折叠态 |
| 会话行 | **恒**显示工作区前缀：`[工作区名] 标题`、无工作区 `[未分组]`；行尾相对时间（如 “5天前”） |
| 状态点 | 运行中（running）行最左有蓝色追逐动画点；已完成（completed）行最左有绿色圆点；空闲无点（与核心一致） |
| 悬停行 | ~0.5s 后行右侧弹出提示卡片：完整标题（不截断）+ 相对时间 + 状态；卡片可停留，滚动跟随 |
| 可见性 | 与核心一致：排除子代理起源与已归档；当前空白“新会话”显示在它自己的桶 |
| 点某一行 | `sessions.open(id)` 打开该会话 |
| 切回 按工作区 / 手动排序 | 自动退出，核心列表原样恢复 |
| 进入搜索 | 自动退出（搜索树接管列表区域），退出搜索后若仍在 单列表+最近更新 则自动恢复 |
| 窄栏（rail） | 不激活 |
| 刷新 | 折叠态记住；核心视图状态由核心自己持久化，恢复后自动跟随 |

## 设计约束与取舍

- **不注入核心菜单**：实测核心“视图选项”菜单（portal + 两阶段渲染）无法安全扩展——注入会导致菜单空/闪没；改为跟随核心既有视图状态，体验上比独立入口更原生。
- 视图状态读取不靠 DOM：核心把 `{groupBy, orderBy, …}` 整值 JSON 同步持久化到 `dsh.workspace.view.v5`，插件 1s 观察器直接读它判定激活；无需任何 DOM 推断。
- 接管只涉及核心 `listArea` 的隐藏/恢复（纯 inline display 开关），不碰核心状态；`header` 不动。
- 列表数据不爬 DOM：全部由 sessions/workspaces 服务快照推导；任何异常 try/catch 兜底。
- 无 React：纯 DOM + `--dsw-*` 令牌；文案跟随 locale（zh/en）。

## 安装

```bash
dsh plugin --profile web add dsh-session-time-bucket   # 或 add ./dsh-session-time-bucket（本地活链接）
```

仓库统一安装模型（聚合伞包）见根 `README.md`：根 `package.json.dependencies` + 根 `cordis.patch.yml` 各一行，profile `devDependencies` `link:` 后 `dsh plugin --profile web install`。外部 client bundle 原样伺服：改 `src/client.js` 后**刷新页面**即可（`pnpm run dev:web` 时走 HMR）。

## 开发 / 验证

```bash
node dsh-session-time-bucket/test/bundle.test.mjs   # 逻辑 harness（10 条）
node --check dsh-session-time-bucket/src/client.js
```

浏览器手测见 `ACCEPTANCE.md`。
