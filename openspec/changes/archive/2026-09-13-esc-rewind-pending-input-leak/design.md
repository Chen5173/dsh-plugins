## 背景与证据

### 现象

0.1.5-rc.2 上：① 回退后被撤销的提问没有回到输入框；② 回退后再发消息，新消息一直在等待队列里，而「之前的信息」继续被执行（一条在执行、一条在等待、内容相同）。

### 证据链

1. **fork 切点决定种子**：`packages/api/session-controller/src/commands.ts` 的 `fork` —— `boundary = source.events.find(e => e.type === 'turn/end' && e.seq >= atSeq)`；`let cut = boundary.seq + 1`；`while (cut < len && events[cut].type !== 'turn/start') cut++`；`agents.create({ seed: source.events.slice(0, cut), inheritedEventCount: cut })`。
2. **insert 在 turn/start 之前、claim 在之后**（真机日志事件序）：`agent/inbox/spliced{target:'next-turn', start:0, inserted:[A]}` → `turn/start` → `agent/inbox/spliced{start:0, removedCount:1, inserted:[]}` → `user/message(A)`。回退目标那一轮的 `turn/start` 就是 `cut`，所以种子**只有 insert、没有 claim**。
3. **收件箱是耐久投影**：`packages/core/agent-loop/src/inbox.ts` 的 `inboxProjectionDefinition` 从 `agent/inbox/spliced` 事件 fold 出 `{'next-turn','next-step'}`；子会话带着种子创建 ⇒ 它的收件箱里就有一条继承来的 pending 旧消息。子会话被用户的新消息唤醒时，agent 按收件箱顺序 claim（`start=0`）并执行旧的那条。
4. **真机日志三例**（`~/.dsh/sessions/**/session*.jsonl*`，多帧 zstd 必须 `read_across_frames=True`）：
   - `session-8c693ecf`：种子末事件 = 插入 `e35e7ff4`（23:19:50），fork 23:19:52；子会话 23:20:16 的 `user/message` id 就是 `e35e7ff4`。
   - `session-1aacc7bb`：fork 10:46:53，种子末事件 = 插入 `858a838b`；用户 10:48/10:52 又发两条，10:52:58 执行的是继承的 `858a838b`。
   - `session-716995b9`：23:31–23:33 连发三次「继续」，子会话先执行继承的 `e947d3bb`，用户自己那条排到后面。
5. **守卫看不到**：`control.ts` 的 `sessionProjections.onChanged` 对每个 key 无条件广播 `projection` 帧，但 `queue` 帧前有 `if (agent?.session !== session) return`；且刚提交的输入可能只存在于 `snapshot.pendingSubmissions`（`QueueDock` 用它渲染「等待中」）。三例在 fork 前都没有 removal 事件，与「守卫看到空队列」自洽。
6. **还原时序**：`doRewind` 旧顺序 `open → await settle(child) → arm`；`settle` 在子会话有 pending 时至少 `sleep(60ms)`，React 在此期间提交子会话挂载，`EscBridge` 的还原 effect 首跑 `__pending === null` 直接 return，且依赖只有 `[sessionId, draft, inputActions]` ⇒ 不再重跑。harness 旧用例（`pending restore applies the prompt on the branch mount`）是在 `doRewind` 结束后才 `mount` 子会话，掩盖了这一点。

## 决策

### D1 主修放在「分支打开后清自己的收件箱」，而不是继续在父会话上想办法

种子里那条 insert 由宿主切点语义决定，客户端无法通过「清父会话队列」消掉（那条消息在父会话里早已被 claim，不在任何队列里）。因此：fork 前清父会话（覆盖「此刻真的 pending」的情形）+ **open 分支后清分支收件箱**（覆盖结构性继承），两者缺一不可。

### D2 判定三来源合一，而不是只读 queue 镜像

`pendingInputsOf()`：① 宿主 `inbox` 投影（随页面 baseline 与 `projection` 帧到达，且是 fork 种子的第一现场）；② queue 镜像（旧核心唯一来源，兜底）；③ 未对账的本地回声（`placement` 为 `queued`/`steering` 且 `rpcId` 未被任何宿主行承认）——它没有宿主 id，只能等它落定（`updateQueue` 需要 inbox 里的 message id）。清不掉仍放弃回退（保持既有语义）。

### D3 投影宽限只在「这一代核心确实有投影」时生效

子会话的继承项只在 `inbox` 投影里可见，但投影是随页面 baseline 异步到达的。若核心没有该能力（0.1.2 及更早），不该凭空多等：用 `__inboxProjectionSeen`（本页见过投影值即置位，属能力探测、不读版本号）决定子会话清理是否等 300ms 宽限；等不到就退回 queue 镜像判定（等价旧行为，不更差）。

### D4 还原登记在 open 之前，且「一次回填」按会话记

`armPendingRestore` 提到 `sessions.open(childId)` 之前（键控 childId，父会话的桥不会消费）；再补模块级武装通知，覆盖「武装晚于挂载」的任意顺序。「只回填一次」用「已回填的会话 id」表达：下一次回退会 open 出新的 childId，天然可再回填；桥卸载后（`restoreAliveRef`）残留定时器不得再写旧会话草稿。草稿非空的处理保持既有原则（不覆盖用户输入，记 `pendingDropped='draft'`）。

### D5 诊断优先

本次两个缺陷此前都无法自证（一个看不到继承项、一个看不到还原是否发生过）。新增的 9 个 `__dsew` 字段是验收的一部分：`pendingSource` / `childPendingSource` / `pendingConfirmMs` / `childPendingConfirmMs` / `pendingStaged` / `pendingApplied` / `pendingLateArm` / `pendingDropped` / `inboxProjectionSeen`。

## 验证

- `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` → **68/68**（新增 8 条）。
- 红绿：把 `src/client.js` 临时回到 v7.4 → **60/68**（8 条新用例全红，失败点分别为「投影项没被删」「回声时仍 fork」「子会话继承项没被删」「子会话先挂载时没回填」「第二次回退没回填」「晚武装没补跑」「无投影时无诊断」「合体场景两处都红」），恢复实现 → 68/68。
- 全仓库子插件套件 + manager 4 支套件无回归；`node --check` 两个源文件通过。
- 已知既有失败（与本变更无关）：`dsh-open-session-workdir/test/interception.test.mjs` 抓第三方 `dsh-better-sidebar` bundle 形状，报 `isFolderRevealPath not found`。
