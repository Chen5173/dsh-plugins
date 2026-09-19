## 1. 纯逻辑层（host-core.js）

- [x] 1.1 新增 `REMOVE_REASONS` 与纯函数 `removePlan(derived)`：目标 = `valid && !legacyBundle && (installed || hasRow)`，其余按 `invalid-dir` / `legacy-layout` / `not-installed` 分类跳过，返回 `{targets, skipped, count}`（targets 带 `dir/rowId/name/hasClient/dirPath/state`）。验证：`host-core.test.mjs` 新增用例覆盖六态混合现场（active/disabled/inactive 计入；uninstalled/legacy/invalid 跳过且 reason 正确）、全空现场 count=0、不修改入参。
- [x] 1.2 在 `host-core.test.mjs` 的 batch switch planning 分组旁补 `removePlan` 的 N 口径断言：全未安装时 N=0；混合现场 N = active + disabled + inactive。

## 2. 宿主半（index.js）

- [x] 2.1 新增 `dropDevDeps(c, names)`：一次读 manifest、一次摘掉 `dependencies`/`devDependencies` 中的受管键、一次备份、一次写、一次 `pnpm install`，失败回滚；返回 `{removed, ranPnpm, error, backup}`。验证：由 3.2 的 handler harness 覆盖（一次安装、失败回滚），并核对与 `ensureDevDeps` 形态一致。
- [x] 2.2 新增端点 `POST /__dsh-plugin-manager/remove-all`（按 D2 的顺序：丢弃 `pendingIntents` → 备份两份文件 → 一次 `removeManaged` 写 patch → 一次 `dropDevDeps` → 失败双回滚），响应形状对齐 `/set-all-enabled`（`results`/`counts`/`noop`/`warning`）并附 `discardedIntents`；`count === 0` 时返回 `noop: true` 且不写任何文件。验证：3.1/3.2 的 harness 用例全绿。
- [x] 2.3 `listPayload` 增加 `batchCounts.remove`（复用 `batchCountsOf` 的口径），并把 `remove-all` 加进端点分发白名单。验证：3.1 断言 `/list` 带 `batchCounts.remove.count` 且与 `removePlan` 一致。
- [x] 2.4 端点在 `count===0 && 无排队意图` 时短路（`noop:true`，不备份、不写、不安装）。验证：3.1 断言该路径下 patch 与 manifest 的写入次数为 0、pnpm 未被调用。

## 3. 自动化测试（新增 test/batch-remove-all.test.mjs）

- [x] 3.1 用 `debounce.test.mjs` 的骨架（临时 `$DSH_HOME` + js-yaml junction + 假 web 服务器 + `__setPnpmRunner` 桩）驱动真 `registerHttp`：断言一次「全部移除」对 `cordis.patch.yml` 恰好 1 次 `writeFileSync`、对 `package.json` 恰好 1 次、`pnpm` 恰好被调用 1 次（`install`），且全部受管行与依赖键消失。
- [x] 3.2 断言不变式：`mcp-*` 行、`dsh.profile.bundles`、非受管依赖键逐字节不变；`dsh-plugin-manager` 自身的依赖键不被摘除。
- [x] 3.3 断言排队意图被丢弃：先 `set-enabled`（意图仍在 400 ms 窗口）再 `remove-all`，最终 patch 中该 id 不存在、响应带 `discardedIntents: 1`、且总写入次数仍为 1。
- [x] 3.4 断言失败回滚：让 pnpm 桩返回失败，断言 `package.json` 与 `cordis.patch.yml` 都回到操作前内容（逐字节），响应 `ok:false` 或带失败项，且无半状态。
- [x] 3.5 断言 noop 路径：无痕迹现场下 `remove-all` 返回 `noop:true`，写入次数与安装次数均为 0。
- [x] 3.6 红能力验证：临时把 `dropDevDeps` 改回逐项调用 `dropDevDep`，确认 3.1 精确失败在「恰好 1 次 install」；还原后全绿（把结果记进 ACCEPTANCE）。

## 4. 客户端半（client.js）

- [x] 4.1 工具栏新增第三个批量按钮「全部移除 (N)」（危险色、N 来自 `batchCounts.remove.count`、N=0 置灰、执行中禁用）；`runBatch` 扩展到第三态 `'all:remove'`，`isBusy` 与批量锁定逻辑覆盖它。验证：`bundle.test.mjs` 新增断言（按钮渲染与 N 文案、N=0 时 disabled、点击后发出 `/remove-all`、执行中锁定所有行与三个按钮）。
- [x] 4.2 中英文文案：`removeAll` / `removeAllConfirm`（含数量与删除后果）/ `removeAllHint` / `removeAllDone` / `removeAllDiscarded`；结果提示复用既有的 `batchFailed` 逐项呈现。验证：`bundle.test.mjs` 断言确认框文案含数量与「源码目录保留/可重新启用」语义，取消时不发请求。
- [x] 4.3 移除包含带界面子插件时沿用既有「刷新页面使界面生效」提示且不自动刷新。验证：`bundle.test.mjs` 断言 `reloaded === false` 且提示出现。

## 5. 文档与验收

- [x] 5.1 更新 `dsh-plugin-manager/README.md`：面板三批量动作与 `/remove-all` 端点、以及「迁移后先全部移除再重新开启即可重新定位」的用法说明。
- [x] 5.2 更新 `dsh-plugin-manager/ACCEPTANCE.md`：新增 A13（作用范围与计数、一次落盘一次安装、丢弃排队意图、失败双回滚、红能力），并标注哪些条目为「需真机」。
- [x] 5.3 全量回归：`node dsh-plugin-manager/test/host-core.test.mjs`、`bundle.test.mjs`、`debounce.test.mjs`、`batch-remove-all.test.mjs`、`root-install-shell.test.mjs`，以及仓库根 `for f in sub-plugins/*/test/*.test.mjs` 全绿；`openspec validate 2026-09-18-add-remove-all --strict` 通过。

## 执行记录（2026-09-18）

- 1.1–5.2 全部落地；5.3 回归：管理器 5 支套件全绿（host-core / bundle / debounce / batch-remove-all / root-install-shell），`openspec validate plugin-manager --strict` 与 `openspec validate 2026-09-18-add-remove-all --strict` 均判 valid。
- 3.6 红能力实跑两次变异：① 端点里逐项 `dropDevDep` → 判红在「恰好 1 次 manifest 写入」（actual 2）；② `dropDevDeps` 连跑两次 install → 判红在「恰好 1 次 pnpm install」（actual 2）。两次均已还原源码。
- 遗留（与本次改动无关，未修）：`sub-plugins/dsh-open-session-workdir/test/interception.test.mjs` 失败——它按函数名从**本机已装的第三方** `dsh-better-sidebar@0.19.0` bundle 里抽 `isFolderRevealPath`，该 bundle 已无此函数（该文件在 0.19.0 里出现 0 次）。本仓库 `sub-plugins/` 本次未被改动（`git diff --stat HEAD -- sub-plugins/` 为空），属既有的外部依赖形状变化。
