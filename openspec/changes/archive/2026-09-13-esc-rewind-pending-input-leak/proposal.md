## Why

用户在 0.1.5-rc.2 上报告两个现象：**① 回退后被撤销的提问没有回到输入框；② 回退后再发消息，新消息排队、而「之前的信息」继续被执行**。复查会话日志与宿主源码后确认：v7.4 的结论（「父会话里刚发出、尚未落盘的排队输入被种子复制」）**只覆盖了一半**，而且守卫本身看不到真正的主因。

- **主因是结构性的，不是竞态。** 宿主 `fork`（`packages/api/session-controller/src/commands.ts`）取 `boundary = 第一个 seq ≥ atSeq 的 turn/end` 后，`cut` 会从该 `turn/end` **一路走到下一个 `turn/start`**；被回退那条消息的 `agent/inbox/spliced`(insert) 恰好排在**它自己的 `turn/start` 之前**，而 claim（`removedCount:1`）排在 `turn/start` **之后**。0.1.5 起收件箱是**耐久投影**（`packages/core/agent-loop/src/inbox.ts` 从事件 fold），于是分支的收件箱里必然有一条继承来的 pending 旧消息：用户重发时 agent 先 claim 它并执行（新消息只能排队）。**父会话清队列永远清不到它。**
  - 真机日志三例：`session-8c693ecf`（23:19:52 fork → 23:20:16 执行继承的 `e35e7ff4`）、`session-1aacc7bb`（10:46:53 fork → 10:52:58 执行继承的 `858a838b`，用户 10:48/10:52 发的两条在排队）、`session-716995b9`（三次「继续」，先执行继承的 `e947d3bb`）。三者种子的最后一个事件都是 `agent/inbox/spliced` 的 insert，fork 前**没有任何 removal 事件**。
- **守卫为什么漏**：`settlePendingInputs` 只读客户端 queue 镜像 `snapshot.queue`；而宿主 queue 帧只在「有活跃 agent 且 session 匹配」时广播（`api/session-controller/src/control.ts`），同一次变化的 `projection`(key `inbox`) 帧才无条件广播；刚按下回车的输入还可能只存在于本地回声 `pendingSubmissions`（「等待队列」UI 正是拿它渲染）。
- **「文字没回输入框」是同一场景的另一半**：`doRewind` 原本 `open(child) → await settlePendingInputs(child, 600) → armPendingRestore(...)`。中间的 await 一旦真的 sleep（正是②的场景），React 先提交子会话挂载，还原 effect 第一跑读到 `__pending === null` 直接 return，而它只按 `[sessionId, draft, inputActions]` 重跑 ⇒ 那次还原永久丢失；用户一打字（draft 变化）还会把它清掉。既有 harness 用例是在 `doRewind` 全部结束**之后**才挂载子会话，恰好绕开了真实顺序。

## What Changes

- **未落定输入的判定改为三来源合一**（`pendingInputsOf()`）：宿主 `inbox` 投影（`session.projections.faceOf('inbox')`，随页面 baseline 到达）∪ queue 镜像 ∪ 未对账的本地回声（`pendingSubmissions` 中 `placement` 为 `queued`/`steering` 且其 `rpcId` 未出现在任何宿主行）。`settlePendingInputs` 与 `clearQueue` 共用这一判定。
- **回退前（fork 之前）**：删掉父会话的未落定输入并**等确认空**；清不掉则返回 `code:'pending-input'`、提示「该会话还有没发出的消息在排队…」并**放弃本次回退**（宁可不回退，也不复制一份输入过去）。
- **分支打开之后**：再清一次**分支自己的**收件箱——种子带出来的继承项只在这一刻可见（预算 900ms；只有本页见过 `inbox` 投影时才为它多等 300ms 宽限，旧核心不多等）。
- **还原文本改确定性**：`armPendingRestore` 提到 `sessions.open(childId)` **之前**（`__pending` 按 childId 键控，父会话的桥不会消费它）；补模块级武装通知（同 `__toastListeners` 套路）让「武装晚于挂载」也能补跑；「一次回退只回填一次」改为「已回填的会话 id」而非一次性布尔 ref（旧写法会让同页第二次回退永不回填）；桥卸载后残留定时器不再写旧会话草稿。
- **诊断可自证**：`__dsew` 增 `pendingSource` / `childPendingSource` / `pendingConfirmMs` / `childPendingConfirmMs` / `pendingStaged` / `pendingApplied` / `pendingLateArm` / `pendingDropped` / `inboxProjectionSeen`。

## Capabilities

### New Capabilities

（无新增能力）

### Modified Capabilities

- `esc-rewind`: 修改「Esc 二次回退撤销整轮并重开分支会话」——补两段 MUST（回退前清空并确认未落定输入，清不掉则 MUST NOT 回退；分支打开后 MUST 清掉种子里继承来的 pending，MUST NOT 让分支替用户执行旧输入）与一条还原时机约束（还原 MUST 在打开分支前登记、分支挂载后 MUST 应用，同页多次回退 MUST 都能还原），并新增两个场景。

## Impact

- `sub-plugins/dsh-esc-rewind/src/client.js`：新增 `pendingInputsOf()`、`clearPendingRestore()`；`settlePendingInputs` 改三来源 + 可选投影宽限；`doRewind` 增「open 后清子会话」并调整还原登记时机；`EscBridge` 的还原路径重构为「按会话记一次 + 模块级晚武装通知」；`__diag` 增 9 个字段。
- `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`：harness 夹具补真机形态（`projections.faceOf('inbox')` / `pendingSubmissions` / `open` 回调），新增 8 条用例。
- `docs/knowledge/2026-09-08-dsh-esc-rewind.md`：新增 v7.5 节（修正 v7.4 的结论并记录证据与红绿验证）。
- 宿主半 `src/index.js`：无改动（纯客户端修复，刷新页面生效）。
- 兼容性：核心 < 0.1.5-rc.2（无 `inbox` 投影）时退化为原 queue 镜像行为，不报错、不多等；删除模式、提示时机、键盘语义均不变。
