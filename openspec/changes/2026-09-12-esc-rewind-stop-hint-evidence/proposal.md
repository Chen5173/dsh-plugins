## Why

用户报告：**正常的输出结束后仍会弹出「已停止 · 再按 Esc 回退本轮」提示**。

根因（已用 harness 只读探针复现 + 源码核对）：

- v7.1 把「用户主动停止」近似成「本会话内 `running` 出现 true→false 下降沿」。但**自然结束也有同一条下降沿**（`agent/status` 的 running 覆盖整轮，正常收尾后同样置 false）。
- 唯一能区分二者的判据是「尾部是否为被中断的回复」，而它读的是**另一个 store 的同一帧快照**：`unsettled = tailUnsettled(list)` 来自 `useConversation` 的 chat 投影，`running` 来自 `useSession` 的会话 store，两者的到达/发布顺序不保证。
- 更关键：插件读的是 `chat.legacy.nodes`，而核心的 legacy 投影里**`status === 'running'` 的 assistant 行不产出任何节点**（内容只在 `partial` 里）。因此在「running 已变 false、最后一条 assistant 还没落定」的那一帧，尾巴是**这一轮刚发出的 user 提问**——非 assistant 尾 → `tailUnsettled()` 为真 → 条件齐了，照弹。

即：这个提示的判据（瞬态投影 + 下降沿）与「是否被主动停止」在数据上并不等价，属于**判据错误**，不是时序微调能解决的。

## What Changes

- 提示判据改为**宿主写入的耐久停止证据**，不再读瞬态投影：
  - 停止证据：尾部 assistant 行带 `interrupted` 标记；或该轮 `turn/end` 原因 `kind === 'aborted'` 且 cause `{kind:'user'}`（覆盖「尚无内容即被停」的回合，`commands.ts` 的 Stop/Esc 取消固定用 `{kind:'user'}`）。
  - 自然结束证据：尾部 assistant 行为 `settled`，或该轮 `turn/end` 是其它终态（`completed`/`error`/`max-tokens`/`blocked`）。
- 下降沿只用来**记录候选**（证明本会话刚结束了一轮），候选在该轮定型（尾部成为 assistant 行，或该轮 `turn/end` 落定）后才结算：停止证据 → 提示一次；自然结束证据 → 静默丢弃。这样 `running` 位与对话投影谁先到都不会误弹，也不会漏弹。
- 候选按「最后一轮用户提问的 seq」绑定，发新消息 / 切会话即失效；提示每回合至多一次，草稿非空不提示（保持既有防误触）。
- 诊断补 `__diag.hintToasts` / `__diag.lastHint`（本次缺陷此前无法自证：hint effect 不写任何诊断字段）。
- 清掉 `decideEsc` 的死参数 `unsettled`（函数内部本就用 `list` 重算 `tailUnsettled`），避免两处判据继续漂移。

## Capabilities

### New Capabilities

（无新增能力）

### Modified Capabilities

- `esc-rewind`: 修改「「再按 Esc 回退」提示只在用户主动停止后出现」——把判据从「running 下降沿 + 尾部非 settled」改为「running 下降沿 + 该轮耐久停止证据」，并明确「自然结束（含投影尚未落定的中间帧）MUST NOT 提示」「无内容即被停的回合 SHOULD 提示」。

## Impact

- `sub-plugins/dsh-esc-rewind/src/client.js`：新增 `tailStatus()` / `lastTurnEndEvidence()` 两个纯读函数；`EscBridge` 新增 `stopCandidateRef` 并把 hint effect 改为「候选 + 耐久证据结算」；`__diag` 增两个字段；`decideEsc` 调用点去掉死参数。
- `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`：新增真机形态（`chat.legacy.nodes`）与「投影落后」时序的用例；既有 toolbar-Stop 用例保持有效。
- `openspec/specs/esc-rewind/spec.md`：归档时并入本 delta（本次不归档）。
- 宿主半 `src/index.js`：无改动（纯客户端判据修正，无端点/设置变更）。
- 兼容性：键盘语义、回退引擎、删除模式全不变；只收窄提示的出现条件。纯客户端改动，刷新页面生效。
