## 1. 纯判定：decideEsc 非运行态两步

- [x] 1.1 在 `sub-plugins/dsh-esc-rewind/src/client.js` 的 `decideEsc` 非运行态分支：`qualified && draft === '' && tailUnsettled(list)` 时，`opts.stopIssued === true` 返回 `{action:'rewind', exchange}`，否则返回 `{action:'arm', exchange}`；使运行态分支不变。验证：`node --check sub-plugins/dsh-esc-rewind/src/client.js` 通过，且 `internals().decideEsc({running:false,draft:'',list,stopIssued:false})` 返回 `arm`、`{stopIssued:true}` 返回 `rewind`。

## 2. 事件分发：onKey 处理 arm

- [x] 2.1 在 document capture 的 `onKey` 分发处新增 `action === 'arm'` 分支：`consume()`、设 `stopMarkRef.current = target.seq`、`__diag.lastAction='arm'`、`publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))`，**不调用 `issueStop`**。验证：`node --check ...client.js` 通过，逻辑 harness 能观察到 arm 分支路径。

## 3. internals 导出

- [x] 3.1 确认 `decideEsc`/`tailUnsettled` 已在 `window.__dsewInternals` 导出（`arm` 复用 `decideEsc`，无需新增导出）。验证：测试内 `internals().decideEsc(...)` 可调用。

## 4. 测试更新与新增

- [x] 4.1 更新 `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`：原「armed interrupted tail rewinds on ESC」改为「第一次=arm」；新增断言「同一 list、`stopIssued:true`」=rewind；新增覆盖「非运行态 user 尾第一次=arm、第二次=rewind」与「settled 尾仍 none」。
- [x] 4.2 运行 `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` 全绿（37/37 以上）。
- [x] 4.3 运行全仓库子插件套件 `for f in sub-plugins/*/test/*.test.mjs; do node "$f" || echo FAIL; done` 无回归。

## 5. spec 同步与文档

- [x] 5.1 校验 `openspec validate --changes esc-rewind-two-step-arm` 通过（MODIFIED 需求完整、scenario 使用 4 个 `####`）。
- [x] 5.2 在 `docs/knowledge/2026-09-08-dsh-esc-rewind.md` 追加 v7 小节记录「非运行态两次 Esc」；在 `docs/knowledge/README.md` 索引登记一行。
- [ ] 5.3 依 apply 结果将 delta 归并进 `openspec/specs/esc-rewind/spec.md`（archive 时 — 由 `/openspec-archive-change` 执行，apply 阶段不改主 spec）。

## 6. 提示时机修正（apply 后新增：post-stop hint 只在主动停止后弹）

- [x] 6.1 新增 `prevRunningRef`，在 session 切换 effect 里重置；post-stop hint effect 改为仅当 `running` 从 true→false（下降沿）且尾部非 settled 且草稿空时提示，切进已是 unsettled 的会话（如 429 失败轮）不再误弹。验证：`node --check ...client.js` 通过、39/39 全绿。
- [x] 6.2 在 `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` 新增 2 条：切进 unsettled 会话不提示、工具栏 Stop（下降沿）提示一次。验证：run suite 39/39。
- [x] 6.3 在 spec delta 补一条「提示时机」需求（切进非正常结束会话不提示；主动停止后才提示）。验证：`openspec validate --changes esc-rewind-two-step-arm` 通过。
