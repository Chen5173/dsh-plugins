## Context

见 `proposal.md` 的 Why。实现面需要知道的现状约束（2026-09-18 逐条核对过源码）：

- 宿主半 `src/index.js` 已经把「批量」这件事拆成了三段可复用的动作：`batchPlan(derived, enabled)`（纯逻辑选目标）→ `ensureDevDeps(c, entries)`（一次改写 manifest + 一次 `pnpm install`）→ 一次 `upsertManagedMany` + `writePatchRows`。新动作应当复用这套骨架，而不是另写一条路径。
- 现有单行 `/remove` 的顺序是：先 `flushPending`（把排队意图落盘）→ 删行写盘 → `dropDevDep`（备份 manifest、摘键、`pnpm install`、失败回滚）。**批量不能照抄这个顺序**：它会把正要被删掉的行先写一次盘，白付一次 DSH 核心配置重应用（实测每次 681–1184 ms）。
- `mergeIntent` 的键是行 id；`pendingIntents` 是模块级队列，`/set-all-enabled` 会先把它取走再并入同一次写入。批量移除需要的是**相反**的语义：取走并丢弃。
- `removeManaged(rows, id)` 已经能一次删掉一个 id 的全部出现（insert 项与普通覆盖行）；批量只需按顺序对每个目标 id 调一次，得到新数组后一次写盘。
- `deriveStates` 只按「依赖键是否存在」推导 `installed`，所以陈旧 `link:` 与新鲜 `link:` 在面板上无法区分；本变更不修这个语义（见 Non-Goals），但作用域必须覆盖它——`未激活(仅依赖)` 正是迁移后遗留死链的状态。
- 单个 `/remove` 返回的 `listPayload` 只带 `warning`；批量开关的响应形状是 `{ok, data, results, counts, noop, warning}`。面板已有一套渲染 `results`/`counts` 的代码，批量移除复用同一形状即可零成本接入。

## Goals / Non-Goals

**Goals:**

- 一次动作清空全部受管子插件的激活行与依赖键，让 profile 从「换机器后的陈旧绝对 `link:`」状态回到干净起点。
- 保持既有不变式：至多一次 patch 写入、至多一次 manifest 改写、至多一次 `pnpm install`、失败不留半状态。
- 面板交互与既有两个批量按钮一致（数量、确认、锁定、逐项结果、刷新提示）。

**Non-Goals:**

- 不改 `linkSpecOf` 写绝对路径的既有决策，也不改 `deriveStates` 对陈旧链接的判定（那是另一个问题：迁移后残留路径应被识别为异常）。
- 不修「单行开启时陈旧 `link:` 不被自愈」的缺口；本变更只是让用户可以绕开它（全部移除 → 重新开启）。
- 不删除子插件源码目录、不动 `dsh.profile.bundles`、不动管理器自身。
- 不提供按状态筛选的部分批量移除（只提供「全部」）。

## Decisions

### D1 作用域用新纯函数 `removePlan(derived)` 表达，与 `batchPlan` 对称

目标集 = `valid && !legacyBundle && (installed || hasRow)`；跳过原因沿用同一套机器可读词表（`legacy-layout` / `invalid-dir` / `not-installed`）。`inactive`（仅依赖）**计入目标**，因为那正是死链状态。

替代方案：把移除塞进 `batchPlan` 的第三个方向（`batchPlan(derived, 'remove')`）。否决——`batchPlan` 的第二参是布尔语义（开启/关闭），扩展成枚举会改到现有两个按钮的调用面与测试；新函数只增不改，且能独立单测。

### D2 端点 `POST /remove-all`，先丢弃排队意图，再一次删行 + 一次摘依赖

顺序：① 取走 `pendingIntents` 并清空（记录丢弃条数）→ ② 备份 patch 与 manifest → ③ 一次 `removeManaged` 写 patch → ④ 一次摘掉全部目标键写 manifest → ⑤ 一次 `pnpm install` → 失败则 ③④ 一起回滚并报错。

替代方案：复用 `dropDevDep` 逐项调用。否决——N 次 manifest 改写 + N 次 `pnpm install`，与「一次落盘、一次安装」的既有需求直接冲突。

### D3 摘依赖用新函数 `dropDevDeps(c, names)`，与 `ensureDevDeps` 同形

一次读 manifest、一次过滤 `dependencies`/`devDependencies` 中的受管键、一次备份、一次写、一次 `pnpm install`、失败回滚。返回形状对齐 `ensureDevDeps`：`{removed: string[], ranPnpm, error, backup}`。单个 `dropDevDep` 保留不动（单行移除仍在用）。

替代方案：把 `dropDevDep` 改成接受数组。否决——会让单行路径也走批量语义（多余的数组分配与分支），且单行路径的现有测试要跟着改；新增函数更小。

### D4 patch 与 manifest 的失败回滚是「一起回滚」

manifest 回滚由 `dropDevDeps` 自己做（沿用既有形态）；patch 的回滚由端点做（`writePatchRows(engine, patchFile, 备份内容)`）。因为 patch 写入在 manifest 改写之前，若 manifest/安装失败，端点必须把 patch 也恢复——否则会出现「行没了、依赖还在」的半状态（正是 spec 里禁止的那种）。

替代方案：先摘依赖再删行。否决——安装成功而写行失败时同样会半状态，且 patch 写入失败的概率更低（纯本地文件写），把它放前面可以让「安装失败」这条最可能的失败路径只回滚 manifest + 恢复 patch 备份，逻辑更直白。

### D5 丢弃排队意图的语义写进响应

响应加 `discardedIntents: <条数>`；面板在结果文案里说明。理由：静默丢弃用户刚点的开关会让面板显示与磁盘不一致，而这正是既有设计里反复强调不能出现的状态（`落盘失败不静默` 需求）。

### D6 客户端只加一个按钮与一组文案，不改既有布局

工具栏现有 `batchButton(true)` / `batchButton(false)`，新增 `batchButton('remove')`（`runBatch` 相应接受第三态）；`isBusy` 的 `busy.indexOf('all') === 0` 已经能覆盖 `'all:remove'`。破坏性按钮用 `S.buttonDanger` 与既有单行「移除」保持同一视觉语言。

替代方案：把「全部移除」放进行内菜单或单独的危险区。否决——面板没有菜单体系，且用户要的就是一个和「全部开启/关闭」并列的一键动作。

## Risks / Trade-offs

- [误操作：一键删掉全部链接] → 按钮显示数量、确认框写明后果（源码目录保留、可随时重开）、结果逐项回报；且本动作只摘键不删目录，恢复成本 = 重新点一次「全部开启」。
- [批量移除会让正在运行的子插件立刻停止，用户没预期] → 确认文案写明「将停止这些插件」；带界面的子插件被移除后沿用既有「刷新页面使界面生效」提示。
- [丢弃排队意图可能丢掉用户刚点的开关] → 这些行本来就在被删之列，丢弃不改变最终状态；条数在响应里报告，面板文案体现。
- [`pnpm install` 失败导致「依赖还在、行没了」] → D4 的双回滚；测试用例专门覆盖这条路径。
- [profile 中其它插件被误删] → 目标集只来自 `deriveStates` 的受管子插件（管理器自身不在其中），`removeManaged` 只按受管行 id 删；测试断言 `mcp-*` 行与 `dsh.profile.bundles` 逐字节不变。
