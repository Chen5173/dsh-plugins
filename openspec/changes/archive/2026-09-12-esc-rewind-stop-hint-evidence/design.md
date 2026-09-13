## 背景与证据

### 现象

自然结束的回合结束后，界面仍自动弹出「已停止 · 再按 Esc 回退本轮」（`esc.hint`）——用户没有按过 Esc，也没有点过 Stop。

### 证据链

1. **提示的唯一自动路径**是 `src/client.js` 的 post-stop hint effect（v7.1 引入），条件 = `wasRunning === true`（running 下降沿）+ `!unsettled` + `!running` + 草稿空。
2. **下降沿不唯一**：`agent/status` 的 `running` 覆盖整轮（`packages/core/agent/src/runtime-types.ts` 注释：「running 从唤醒输入开始，持续到 driver drain/close/checkpoint」），正常收尾同样产生 true→false。
3. **两个输入来自不同 store / 不同发布时机**：
   - `running`：宿主 `agent/status` → `api-session/status` 广播（`packages/api/session-controller/src/index.ts:143`）→ 客户端 `client/index.ts:94` → `Session.handleRunning()` → notifier 微任务（`sessions/session.ts:498`）。
   - `unsettled` ← `chat.legacy.nodes`：每会话事件 journal → `appendLive` → `BoundConversation.accept` → assembler → `publish()`；高频流式行按 3 个动画帧延迟发布（`ui-conversation/src/client/conversation/assembly.ts:121-137`）。
4. **运行中的 assistant 在插件读的那份列表里根本不存在**：`ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts` 的 `legacyContribution` 对 `assistant-step` 且 `status === 'running'` 返回 `nodes: EMPTY_LIST`（内容只进 `partial`）。所以下降沿那一帧的尾巴是**本轮刚发出的 user 提问** → `tailUnsettled()` = true。
5. **harness 只读探针复现**（不改文件，用 `test/bundle.test.mjs` 的前半段 + 追加用例）：
   - 只下 running 下降沿、chat 列表不变 → `toasts = ["esc.hint"]`（复现现象）
   - running 与 settled 尾巴同一次提交落地 → `toasts = []`（既有 39 条测试覆盖的正是这种，故永远测不到真机那一帧）
   - 另：harness 的 `chatOf()` 返回 `legacy: null`，走的是 view-node 分支，与真机的 `chat.legacy.nodes` 分支不是同一条路。

## 决策

### D1 判据换成宿主耐久证据，而不是继续微调时序

「是否被主动停止」在客户端唯一可靠的耐久证据有两处，均由宿主写入、且**只有取消才会产生**：

- `assistant/message { interrupted: true }`：`core/agent-loop/src/agent.ts:374-383`（仅在 `signal.aborted` 且有内容时写）；
- `turn/end { reason: { kind: 'aborted', reason: { kind: 'user' } } }`：`agent-loop/src/agent.ts:313/328` + `api/session-controller/src/commands.ts:446`（工具栏 Stop 与本插件的 `session.cancel()` 都走这条，cause 固定 `user`）。

**不采用**：`turn/end.reason.kind === 'interrupted'`——那是持久化层崩溃修复的标记（`core/session/src/types.ts` 注释：「The loop never emits this marker」），非用户停止。

自然结束的对照证据：尾部 assistant 行为 `settled`，或该轮 `turn/end` 为 `completed`/`error`/`max-tokens`/`blocked`。

### D2 用「候选 + 延迟结算」替代「同一帧 AND」

若要求「下降沿与 interrupted 尾巴在同一次提交里同时出现」，则真机上停止的提示会**大概率漏掉**（interrupted 行通常比 running 位晚到）。因此：

- 下降沿只负责**记候选**（= 本会话刚结束了一轮，记目标回合的 user seq）；
- 候选在该轮**定型**时结算：`tailStatus(list)` 给出 `settled`/`interrupted`，或该轮 `turn/end` 落定给出终态；
- 未定型（尾部仍是 user 行、或 assistant 行仍在 `running`）→ 保持候选等待，不提示也不误判。

这使判据对两个 store 的到达顺序**双向免疫**：证据先到 → 下降沿那一帧即结算；证据后到 → 后续帧结算。候选按目标回合 seq 绑定，发新消息 / 切会话即失效，避免把旧轮证据套到新一轮上。

### D3 覆盖「尚无内容即被停」的回合

取消发生在第一个 token 之前时宿主不写 interrupted assistant 行（`content.length === 0` 直接跳过），尾巴会永远停在 user 行。此时用该轮 `turn/end` 的 `aborted/user` 作为停止证据，保证工具栏 Stop 仍然给出提示；只有 cause 为 `user` 才算（hook/parent/disposed 的 abort 不算用户停止）。

### D4 顺带修掉两处诊断/死参数问题

- hint effect 此前不写任何诊断字段，导致本次缺陷无法自证：新增 `__diag.hintToasts`（计数）与 `__diag.lastHint`（最后一次提示的依据：`tail-interrupted` / `turn-aborted`）。
- `decideEsc({ …, unsettled })` 是死参数（函数内部用 `list` 重算 `tailUnsettled`）：调用点与组件内该变量一并去掉，避免「提示判据」和「armed 判据」继续漂移。

### D5 不改的东西

- `tailUnsettled()` 继续作为 **Esc armed 判定**（Esc 处理器每次按键都用实时 list 重算，不存在本缺陷的「中间帧」问题）。
- 回退引擎（fork/归档/删除/open/setDraft）、`/rewind`、删除模式开关、会话头图标：一律不动。
- 提示文案不新增（沿用 `esc.hint` / `esc.hint.delete` 两档）。

## 风险与边界

- **工具栏 Stop 的提示会晚一两帧**（等该轮定型）；Esc 停止仍由 `onKey` 立即提示，不受影响。
- 若客户端事件窗口里既没有 interrupted assistant 行、也没有该轮 `turn/end`（例如历史被分页截断），候选会一直留到「发新消息 / 切会话」为止：不提示（宁缺勿错），Esc armed 行为不受影响。
- harness 仍是逻辑级（无真机渲染/时序）；新增用例按真机形态（`legacy.nodes`、运行中 assistant 无节点、投影落后一帧）建模，真机验收项写入 `ACCEPTANCE.md`。

## 备选方案（未采用）

| 方案 | 不采用原因 |
|---|---|
| 只要求「同一次提交里同时满足下降沿 + interrupted」 | 真机停止时大概率漏提示（见 D2） |
| 用 `unsettled` 的上升沿/下降沿做判据 | `tailUnsettled` 对 running 尾也为真，运行中已恒为 true，没有可用边沿 |
| 只改 `tailUnsettled` 让 user 尾不算 unsettled | 会同时砍掉 v6 明确要的「撤销刚发出的提问」能力 |
| 把「最后一次由本插件发出停止」记在 module 状态里 | 覆盖不到工具栏 Stop（插件没有该按钮的插槽/seam），漏提示面更大 |
