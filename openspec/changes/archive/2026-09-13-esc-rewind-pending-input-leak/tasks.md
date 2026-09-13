## 1. 未落定输入判定（三来源合一）

- [x] 1.1 新增 `pendingInputsOf(sessionId)`：读宿主 `inbox` 投影（`session.projections.faceOf('inbox')` 的 `{'next-turn','next-step'}` 条目 id）∪ queue 镜像行 id ∪ 未对账的本地回声计数；返回 `{ ids, sources, echoes }`，`sources` 为 `'inbox-projection'` / `'queue-mirror'` / `'echo'`。
  - 验证：harness 三条来源各自命中（`__dsew.pendingSource` 含对应来源名）。
- [x] 1.2 `settlePendingInputs(sessionId, { budgetMs, requireProjectionMs })` 改用该判定：有 id 就 `updateQueue(id,{kind:'remove'})` 并等确认；返回 `{ cleared, remaining, empty, sources, waitedMs }`。`clearQueue` 复用同一判定（只删不等）。
  - 验证：既有「清空后照常 fork」「清不掉则放弃回退」两条用例继续通过；新增用例断言投影项被删。
- [x] 1.3 未对账回声视为未落定：只要存在 `placement` 为 `queued`/`steering` 且 `rpcId` 未被承认的回声，就继续等待；预算用尽仍不落定则 `empty=false`。
  - 验证：新增用例「回声时不许 fork」→ `result.code === 'pending-input'`、`forks.length === 0`。
- [x] 1.4 能力探测 `__inboxProjectionSeen`：本页见过 inbox 投影值即置位（并写 `__dsew.inboxProjectionSeen`）。
  - 验证：新增「无投影时降级走 queue 镜像」用例断言旧核心路径不被破坏。

## 2. 结构性继承项清理（主修）

- [x] 2.1 `doRewind` 在 `sessions.open(childId)` 之后追加一次 `settlePendingInputs(childId, { budgetMs: 900, requireProjectionMs: __inboxProjectionSeen ? 300 : 0 })`，把分支收件箱里继承来的 pending 清掉并确认。
  - 验证：新增用例「子会话投影里继承来的旧消息被清掉」断言 `queueRemoves` 含继承项 id、`__dsew.childPendingCleared ≥ 1`、`childPendingSource` 含 `inbox-projection`。
- [x] 2.2 诊断：`__diag.childPendingSource` / `childPendingConfirmMs`；fork 前那一步补 `pendingSource` / `pendingConfirmMs`。
  - 验证：harness 断言字段取值。

## 3. 还原时序确定性

- [x] 3.1 `armPendingRestore(childId, text, imageDraftIds)` 调用点移到 `sessions.open(childId)` **之前**；并广播模块级 `__pendingListeners`。
  - 验证：新增用例「子会话先挂载、还原晚武装」→ 分支挂载后仍 `setDraft` 一次、`__dsew.pendingApplied === 1`。
- [x] 3.2 还原路径重构：`applyPendingRestore()`（按「已回填的会话 id」`appliedSessionRef` 记一次、以实时 ref 读草稿与 `inputActions`）+ 挂载/依赖变化 effect + 模块级晚武装通知；卸载置 `restoreAliveRef=false`。
  - 验证：新增用例「同页第二次回退仍回填」（同一桥实例换 sessionId → `setDraft` 计数 2）、「晚武装补跑」（`__dsew.pendingLateArm === 1`）。
- [x] 3.3 草稿非空时不覆盖：放弃并记 `__dsew.pendingDropped === 'draft'`；回退失败时 `clearPendingRestore(childId)` 撤掉已登记的还原。
  - 验证：既有「草稿非空消耗提示/不回填」类用例不回归；新增用例覆盖失败路径不残留。

## 4. 测试与文档

- [x] 4.1 harness 夹具补真机形态：`face.projections.faceOf('inbox')`、`face.live.pendingSubmissions`、`sessions.open` 的 `onOpen` 回调、`seed({ inbox, pendingSubmissions })`、删除请求同时收敛 inbox 投影（便于「等确认」收敛）。
- [x] 4.2 新增 8 条用例：投影通道清父会话 / 未对账回声拦住回退 / 子会话继承项被清 / 子会话先挂载仍还原 / 同页二次回退仍还原 / 晚武装补跑 / 无投影降级走镜像 / 「继承项 + 子会话先挂载」合体场景。
- [x] 4.3 红绿验证：8 条新用例跑在 v7.4 版 `src/client.js` 上全红（60/68），当前实现 68/68。
- [x] 4.4 文档同步：`README.md`（行为表 + 版本要求 + 用例数）、`ACCEPTANCE.md`（新增 2.14–2.16 真机条目）、`docs/knowledge/2026-09-08-dsh-esc-rewind.md`（v7.5 节，含对 v7.4 结论的更正）。
- [x] 4.5 全量回归：6 个子插件套件 + manager 4 支套件通过（`dsh-open-session-workdir/test/interception.test.mjs` 为既有失败，与本变更无关）；`node --check` 两个源文件通过。
