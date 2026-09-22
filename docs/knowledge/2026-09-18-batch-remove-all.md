# DSH 插件：「全部移除」批量清空（迁移后重新定位）

对应变更：`openspec/changes/2026-09-18-add-remove-all/`（proposal / design / specs delta / tasks 全在），
验收：`dsh-plugin-manager/ACCEPTANCE.md` A13。代码：`dsh-plugin-manager/src/host-core.js`(`removePlan`/`REMOVE_REASONS`)、
`src/index.js`(`dropDevDeps` + `POST /remove-all` + `batchCounts.remove`)、`src/client.js`(第三个批量按钮)、
`test/batch-remove-all.test.mjs`。

## 为什么需要它（可复用的根因结论）

- `linkSpecOf()` 写出的依赖一律是**绝对路径** `link:<abs dir>`（`~\`/`\${DSH_HOME}` 都不成立：pnpm 不展开环境变量）。
  profile 被复制/迁移（换机器、换 `DSH_HOME`）后这些路径指向不存在的位置。
- `deriveStates` 只看**键在不在**，不看指向是否有效 ⇒ 陈旧 `link:` 仍被算作「已安装」，
  面板显示「未激活(仅依赖)」，`staleLinkSpec` 的自愈分支**在这条路径上是死代码**（`ensureDevDep` 前的
  `present` 守卫会直接跳过）⇒ 单行开关**永远不会**把它修好。
  > ⚠️ **2026-09-22 修正**：这不是"未定义行为"。`openspec/specs/plugin-manager/spec.md` 的「启用缺失依赖的子插件时自动安装」
  > **本来就要求**"devDependency 已存在但 `link:` 指向的不是当前目录时，视为需要修复并改写为当前目录"，还配了场景
  > 「陈旧链接在启用时被修复」；实现里那个 `present` 守卫让规格要求落空 = **实现漏做**。已由
  > `openspec/changes/2026-09-22-stale-link-selfheal` 修掉：单行与批量启用改为 `present && !stale` 才跳过，
  > 并新增自动检测（只读）/ 能确定就自动修（每次宿主启动最多一次）/ 不确定只提示 + 面板横幅与「重定位」按钮。
- 所以「修好它」的可用手段是**先清掉痕迹再重新启用**：键不存在时走的是完整的
  `ensureDevDep`（按子插件**当前实际目录**重写 `link:`）+ `pnpm install` 路径。
  这就是「全部移除」这个功能的唯一目的，它不是「批量关闭」的替代品。

## 语义与顺序（与批量开关**刻意相反**的一处）

| | 批量开关 | 全部移除 |
|---|---|---|
| 合并窗口里排队的单行意图 | **接管**（并入同一次写入） | **丢弃**（目标行本来就要删；先落盘只会白付一次核心配置重应用），条数以 `discardedIntents` 回报 |
| 写入次数 | 1 次 patch | 1 次 patch + 1 次 manifest |
| 安装次数 | 至多 1 次 | 至多 1 次 |
| 失败处理 | 尽力而为、逐项回报 | **双回滚**（patch 原文 + manifest 备份一起还原，杜绝「行没了依赖还在」） |

顺序：丢弃意图 → `await flushChain`（保证删除是最后写盘的那次）→ 一次 `removeManaged` 写 patch →
一次 `dropDevDeps`（内含一次 `pnpm install`）→ 任一失败则 patch 与 manifest 一起回滚。
`removePlan` 与 `batchPlan` **并列而非合并**（第三个方向塞进 `batchPlan` 会让两套词表/口径纠缠）。

计数口径：目标 = 在 profile 里**有痕迹**（有激活行 **或** 有依赖键）的 `valid && !legacyBundle` 项 ⇒
`active` + `disabled` + `inactive(仅依赖)`；`uninstalled`/`legacy`/`invalid` 跳过且不计入 N。
`inactive` 必须计入——它正是迁移后陈旧 `link:` 的状态。

## 测试手法（比 mtime 采样更硬）

- **精确计写入次数**：在测试里替换共享的 `node:fs` 对象的 `fs.writeFileSync`，按绝对路径分支计数
  （`writeCounts.patch` / `writeCounts.manifest`）。handler 用的是同一个 `fs` 对象，所以这是**真计数**，
  不受「同秒内多次写」或 mtime 粒度影响（`debounce.test.mjs` 的 mtime 采样做不到这点）。
- **不真跑 pnpm**：`__setPnpmRunner` 桩记录 `(dir, args)`；需要失败路径时让桩返回 `{ok:false}`。
- **不碰运行中的 web profile**：临时 `$DSH_HOME` + 从真实 profile **junction** 一个 `js-yaml` 进来
  （`fs.symlinkSync(realYaml, tmp/profile/node_modules/js-yaml, 'junction')`），既拿到真 YAML 引擎又零网络零安装。
- **红能力**：两次变异都实跑过——① 端点改成逐项 `dropDevDep` → 判红在「恰好 1 次 manifest 写入」(actual 2)；
  ② `dropDevDeps` 里连跑两次 install → 判红在「恰好 1 次 pnpm install」(actual 2)。写完断言一定要变异一次，
  否则「恰好一次」这类断言很可能只是没被触发。

## 踩坑

- 结果数组里除了受管项还有**仓库扫描出的全部子插件**（无痕迹项逐条 `skipped`）——
  断言「失败项」时不能写 `results.every(outcome === 'failed')`，要按名字筛出目标项。
- `pnpmRunner` 收到的 `dir` 带尾部分隔符，比较路径要用 `path.resolve` 两边归一。

## 顺手发现的既有失败（与本次改动无关）

`sub-plugins/dsh-open-session-workdir/test/interception.test.mjs` 失败：它按函数名从**本机已装的第三方**
`dsh-better-sidebar` bundle 里抽 `isFolderRevealPath` 并做 brace matching，而 0.19.0 的
`lib/client-registry.js` 里该名字出现 **0 次** ⇒ 断言「their bundle changed shape」。
本仓库 `sub-plugins/` 未被本次改动触碰（`git diff --stat HEAD -- sub-plugins/` 为空），属外部依赖形状变化，
需要时再单独修（例如改探针的定位方式，或按版本跳过）。
