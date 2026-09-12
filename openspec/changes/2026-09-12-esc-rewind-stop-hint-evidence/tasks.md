## 1. 纯读判定函数

- [x] 1.1 在 `sub-plugins/dsh-esc-rewind/src/client.js` 新增 `tailStatus(list)`：尾部是 assistant 行时返回 `assistantStatusOf()` 的结果（`running`/`settled`/`interrupted`），否则 `null`；`tailInterrupted()` 保持原语义（改为复用它）。
  - 验证：`node --check sub-plugins/dsh-esc-rewind/src/client.js` 通过；harness `internals().tailStatus(list)` 对三种尾返回对应值、对 user 尾返回 `null`。
- [x] 1.2 新增 `lastTurnEndEvidence(chat)`：读 `chat.timeline`（`turnOrder` + `turns.get(n).end.data.reason`），返回 `'aborted:user'` / `'aborted:<cause>'` / `'completed'` / `'error'` / `'max-tokens'` / `'blocked'` / `'interrupted'`，缺失或形状不符返回 `null`。
  - 验证：harness 用真机形态 timeline 覆盖 `aborted:user`、`completed`、缺失三种输入。

## 2. 提示结算逻辑（核心修复）

- [x] 2.1 `EscBridge` 新增 `stopCandidateRef`（在 session 切换 effect 里与 `prevRunningRef` 一同重置），hint effect 改为：下降沿记候选 → 候选与当前 `target.seq` 匹配才结算 → 未定型（`tailStatus` 为 `null`/`'running'` 且无 `turn/end` 终态）保持等待 → 停止证据（`interrupted` 或 `aborted:user`）提示一次 → 自然结束证据（`settled` / 其它 `turn/end` 终态）静默丢弃。
  - 验证：`node --check` 通过；新增/既有 harness 用例全绿。
- [x] 2.2 提示仍遵守：每回合至多一次（`hintedRef`）、草稿非空不提示、`qualifyExchange(target)` 不通过不提示、删除模式用 `esc.hint.delete` 文案。
  - 验证：harness 覆盖「草稿非空不提示」「同回合不重复提示」「删除模式文案」。
- [x] 2.3 `__diag` 新增 `hintToasts`（计数）与 `lastHint`（`tail-interrupted` / `turn-aborted`）；提示路径写入。
  - 验证：harness 断言提示后 `window.__dsew.hintToasts` 递增且 `lastHint` 取值正确。
- [x] 2.4 删掉 `decideEsc` 调用点的死参数 `unsettled` 及组件内不再使用的 `unsettled` 变量（`decideEsc` 内部照旧用 `list` 重算）。
  - 验证：`node --check` 通过；harness 的 `decideEsc` 纯逻辑用例不受影响。

## 3. 测试

- [x] 3.1 新增真机形态用例：`chat.legacy.nodes`（`{kind:'assistant', seq, blocks}` / `+ interrupted:true` / `{kind:'user', seq, content}`），验证停止证据与自然结束证据都被正确读取（不依赖 `status` 字段）。
- [x] 3.2 新增「回归用例（本次缺陷）」：自然结束时**只下 running 下降沿**、chat 列表仍是「尾巴 = 本轮 user 提问」→ 不提示；随后 settled assistant 落定 → 仍不提示。
- [x] 3.3 新增「停止 + 投影落后」用例：停止后只下下降沿 → 暂不提示（不误判）；interrupted assistant 落定 → 提示恰好一次。
- [x] 3.4 新增「无内容即被停」用例：尾部仍是 user 行、但 `turn/end` 为 `aborted:user` → 提示一次。
- [x] 3.5 新增「切进已中断历史会话」用例：无下降沿（`running` 全程 false）→ 不提示；若该轮为 `completed` 亦不提示。
- [x] 3.6 harness 增加 `legacyChatOf()`（真机形态：`legacy.nodes` + `timeline`）帮助函数，并在文件头注释说明与 `chatOf()`（view-node 形态）的区别。
- [x] 3.7 跑 `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` 全绿；跑全仓库子插件套件无回归；`node --check` 两个源文件通过。

- [x] 3.8 红绿验证：把新用例跑在 `HEAD` 版 `src/client.js` 上 → 8 条全红（41/49）；跑在当前实现上 → 49/49。
- [x] 3.9 新增「确定停止证据优先于 settled 尾」用例：多步回合最后一步无内容即被停时，尾部停在上一步 settled 行，仍必须提示（依据该轮 `turn/end` 的 `aborted`/`user`）；该轮未收尾时保持等待，不得提前判为自然结束。

## 4. 文档与规格

- [x] 4.1 `openspec validate --changes esc-rewind-stop-hint-evidence` 通过（MODIFIED 需求完整、scenario 用 `####`）。
- [x] 4.2 `docs/knowledge/2026-09-08-dsh-esc-rewind.md` 追加 v7.2 小节（判据错误的根因 + 新判据 + harness 探针证据）；`docs/knowledge/README.md` 索引登记一行。
- [x] 4.3 `sub-plugins/dsh-esc-rewind/README.md` 行为表补「提示只在耐久停止证据成立时出现」；`ACCEPTANCE.md` 增补 `[B]` 人工验收项（自然结束不弹提示、工具栏 Stop 弹一次、无内容停止弹一次）。
- [x] 4.4 产出 `docs/change-reports/2026-09-12-esc-rewind-stop-hint-evidence-change-report.md`（按既有报告结构）。
- [x] 4.5 不归档：`openspec/changes/2026-09-12-esc-rewind-stop-hint-evidence/` 保持未归档，等用户验收后决定（`openspec-archive.md` 规则 3）。
