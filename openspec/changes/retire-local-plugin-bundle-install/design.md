## Context

本变更只动**仓库里的包清单与文档**，不动管理器代码、不动 DSH 核心。决策依据来自 2026-09-10 的隔离 profile 实测（`DSH_HOME` 指向临时目录，`bundles` 只含 `@deepseek-ai/dsh-base`，不起服务器）：

| 变体 | 构造 | 结果 |
|---|---|---|
| 基线 | 空 patch | 启动成功（进程存活） |
| 单行、包不存在 | `insert: [{id: probe-a, name: '@deepseek-ai/nonexistent-probe-xyz'}]` | exit 1：`failed to import loader entry probe-a (…): Cannot find package …` |
| 两行、**id 不同**、包不存在 | 同上 ×2 | exit 1：`loader entries failed to apply AggregateError`（**不是** duplicate） |
| 两行、**id 相同**、包不存在 | 同上但同 id | exit 1：`duplicate loader entry id: probe-dup` |
| 真 bundle 层 + 真 profile 层、同 id | 手工造一个声明 `dsh.bundle` 的包放进 `bundles`，profile patch 再插同 id | exit 1：`duplicate loader entry id: esc-rewind` |

关键判据：**duplicate 闸门先于包解析**（id 相同的两行即便指向不存在的包也照样报 duplicate），所以"子插件包自带 bundle 层 + 管理器激活行"一旦同时生效就是无条件崩溃。

## Decisions

### D1：直接删除伞包，而不是继续保留 DEPRECATED 或清空其 patch

- 保留（现状）：它仍是一个**可被 `dsh plugin add` 装成 bundle 的包**，5 个 row id 与管理器行完全相同 → 任何一次误装 = 启动崩溃。真正的成本不是"历史冗余"，而是"活的崩溃源"。
- 清空其 `cordis.patch.yml`（改成 `[]`）：能消除 id 冲突，但拆掉了它"聚合装全部"的唯一语义，留下的只是一个装不出东西的空壳包 —— 语义比删除更混乱，且仍会被 reconcile 塞进 `bundles`。
- **决定**：删除根 `package.json` 与根 `cordis.patch.yml`。删除前已核对引用面：4 个 profile 与 7 个 `package.json.bak-*` 均无引用，仓库根无 `node_modules`，`openspec` 是全局命令（不依赖根 package.json）。回滚 = `git checkout` 取回两个文件。

### D2：连 6 个子插件的 `dsh.bundle` 声明一起摘掉，而不只是删伞包

- 伞包只是**一个**触发点；另一条路径（`dsh plugin add ./sub-plugins/<pkg>`）由子插件自己的声明触发，删伞包挡不住它。
- 该声明在**当前模型下已是惰性**：子插件不在 `dsh.profile.bundles` 里，包自带 patch 从不被合并；留着的唯一作用是"把 CLI 误装变成崩溃"。
- 摘掉后误装路径**降级而非失效**：`dsh plugin add` 把包装进 `dependencies`、打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`、不进 bundles、不激活；管理器仍能扫到它并在启用时把 `link:` 改写进 `devDependencies`（`ensureDevDep` 本来就会把 `dependencies` 里的同名条目删掉再写 devDep）。风险面已被用户确认为**零**（插件只有作者自己在用，无外部使用者、无内部 registry 消费方）。
- 连带删除各自的包自带 `cordis.patch.yml`（去掉 `files` 里的同名条目）：声明没了它就永远不会被加载，留着只会继续误导（其注释还写着 `Loaded via dsh plugin --profile <name> add`）。

### D3：不动 `dsh plugin` 的 reconcile，也不加运行时护栏

`reconcilePlugins` 的规则是"依赖里声明了 `dsh.bundle` 就进 bundles"——这是核心的合理设计（`dsh plugin add` 的主要用途就是把 bundle 层装进 profile）。真正错的是**本仓库同时提供两种互斥的安装模型**。消除触发条件属于本仓库的责任，改核心属于越界。

同理，CLI `remove` 造成的悬空行**无法**由管理器救回：那条行让下一次启动就 fail，管理器根本没机会运行。唯一可行的防线是文档警示（见 D5 与 spec delta 的最后一个场景）。

### D4：验收靠"仓库级断言 + 隔离 profile 复现"，不靠真机点面板

- 仓库级：断言 6 个 manifest 无 `dsh.bundle`、目录内无 `cordis.patch.yml`、仓库根无 `package.json`/`cordis.patch.yml`（一条 grep/node 检查即可，写进 tasks）。
- 隔离 profile：把某子插件目录 `dsh plugin --profile <scratch> add`，断言 `dsh.profile.bundles` 不含它、警告已打印、激活行数不变、`dsh web` 仍能启动（本变更 D2 的核心收益）。
- 绝不在用户正在运行的 web profile 上做验证（会改它的 `package.json`）。

### D5：已知限制（文档化，不修）

`dsh plugin --profile web remove <子插件包名>` 只摘依赖、不删管理器写的激活行 → 悬空行 → 下次启动 `failed to import loader entry <id> (<name>): Cannot find package …`。修法只能是手工删行或把包装回来。因此文档 MUST 把卸载路径收敛到面板「移除」，并把这条 CLI 路径标注为危险。这属于"用户绕过管理器直接操作 profile"的固有代价，与"只有 CLI 才有能力改 profile 依赖"这一事实共存。

## Risks and rollback

| 风险 | 评估 | 处置 |
|---|---|---|
| 删除伞包导致某个 profile 起不来 | **几乎为零**：已核对 4 个 profile + 7 个备份均无引用；且引用它才会触发 `cannot resolve profile bundle` | 若真发生：`git checkout` 取回根 `package.json`/`cordis.patch.yml`，或手工从该 profile 的 `dsh.profile.bundles` 摘掉 `dsh-local-plugins` |
| 摘声明后有人仍想把某子插件当独立 bundle 安装 | 该模型与本仓库的管理器模型**互斥**（同时存在即 duplicate id） | 文档写清互斥性；将来若真要发布某子插件为独立包，需在**另一个仓库/另一个包**里做，不要在本仓库复活 bundle 层 |
| `files` 里删掉条目影响打包 | 本仓库无发布流水线；`npm pack` 只是本地检查 | 顺带用 `npm pack --dry-run` 复核一次产物 |
| 文档漏改导致新老模型并存 | 中：6 个包的 README/ACCEPTANCE 都写过 `dsh plugin add` 安装 | 完成后对全仓库 grep `dsh-local-plugins`、`dsh.bundle`、`dsh plugin --profile web add ./` 逐条核对 |
