# esc-rewind 提示时机（宿主耐久停止证据）修改报告

## 1. 需求与成功标准

- **需求**：修掉「正常的输出结束后仍自动弹出『已停止 · 再按 Esc 回退本轮』」——提示只能在**用户真的停过某一轮**之后出现。
- **成功标准**：
  - 自然结束的回合（含「running 位已掉、对话投影尚未落定」的中间帧）**全程不弹提示**；
  - 工具栏 Stop（有内容 / 尚无内容）**必定弹一次**、每回合至多一次；
  - 切进历史上被中断或失败的会话（本会话内无 running 下降沿）**不弹**；
  - 草稿非空不弹；Esc 的 armed/停止/回退语义、回退引擎、删除模式**全部不变**。

## 2. 修改摘要

- 提示判据从「running 下降沿 + 尾部非 settled（瞬态投影）」改为「**下降沿记候选 + 该轮定型后按宿主耐久证据结算**」。
- 停止证据 = 尾部 assistant 带 `interrupted`，或该轮 `turn/end` 为 `aborted`/`user`；自然结束证据 = 尾部 `settled` 或该轮 `turn/end` 为其它终态。
- 新增两个纯读函数 `tailStatus()` / `lastTurnEndEvidence()`；`tailInterrupted()` 改为复用 `tailStatus()`。
- `decideEsc` 调用点的死参数 `unsettled` 删除；`__diag` 新增 `hintToasts` / `lastHint`。

## 3. 修改文件和符号

| 文件 | 函数/位置 | 修改内容 |
|---|---|---|
| `sub-plugins/dsh-esc-rewind/src/client.js` | `tailStatus`（新增） | 尾部 assistant 行状态或 `null` |
| 同文件 | `lastTurnEndEvidence`（新增） | 读 `chat.timeline` 最后一轮 `turn/end` 终态 |
| 同文件 | `tailInterrupted` | 改为 `tailStatus(list) === 'interrupted'` |
| 同文件 | `__diag` | 新增 `hintToasts` / `lastHint` |
| 同文件 | `EscBridge` | 新增 `stopCandidateRef`（session 切换重置）；hint effect 重写；删除 `unsettled` 变量与 `decideEsc` 死参数 |
| 同文件 | `exposeInternals` | 导出 `tailStatus` / `lastTurnEndEvidence` |
| `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | 新增构造器 + 10 条用例 | `legacyUser/legacyAssistant/timelineOf/legacyChatOf`（真机 `chat.legacy.nodes` + `timeline` 形态）；提示证据相关 8 条（含回归）+ 删除模式文案 + 纯函数契约 |
| `sub-plugins/dsh-esc-rewind/README.md` | 行为表 / 键盘捕获章节 / 测试条数 | 提示时机行改为耐久证据口径；补充诊断字段说明；49 条 |
| `sub-plugins/dsh-esc-rewind/ACCEPTANCE.md` | 1.5–1.9、4.4 | 新增人工验收项（自然结束不弹、Stop 迟一两帧弹一次、无内容停止弹一次、草稿不弹、切进历史会话不弹、诊断自证） |
| `openspec/changes/2026-09-12-esc-rewind-stop-hint-evidence/` | proposal/design/tasks/spec delta | 本次变更方案与 spec delta（**未归档**） |
| `docs/knowledge/2026-09-08-dsh-esc-rewind.md` + `README.md` | v7.2 小节 + 索引行 | 根因、新判据、红绿证据 |
| 宿主半 `src/index.js` | —— | 无改动 |

## 4. 影响面复查

### Codemap

- `src/client.js`：**无 import、无 importer**（外部 client bundle 叶子文件）——改动不外溢到其他文件。
- 仓库 hub 文件：无（`No hub files found`）。
- 其他入口：`decideEsc` 仅由 document capture 监听调用；hint effect 仅由 `EscBridge` 使用；新函数经 `window.__dsewInternals` 暴露给 harness。

### 行为边界

- `tailUnsettled()` 语义与调用点未变（仍只服务 Esc armed 判定，按键时用实时 list 重算）。
- 新增 `chat.timeline` 只读访问：形状不符/缺失一律返回 `null`（走「未定型」分支，不提示），不影响回退与删除通道。
- 未改任何宿主端点、settings 字段、profile 写入 —— 不需要重启 GUI host，刷新页面即生效。

## 5. 测试结果

| 命令 | 结果 | 备注 |
|---|---|---|
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **49/49 PASS** | 既有 39 条 + 新增 10 条（8 条提示证据 + 删除模式文案 + 纯函数契约） |
| 同套件跑在 `HEAD` 版 `src/client.js` 上 | **41/49** | 8 条新用例全红（含 `api.tailStatus is not a function`），证明是真实回归覆盖（红→绿） |
| `node --check src/client.js` / `src/index.js` | OK | 语法通过 |
| 全仓库子插件套件（7 个文件） | 6/7 PASS | 24/53/49/31/16/24 全绿；`sub-plugins/dsh-open-session-workdir/test/interception.test.mjs` **报错退出**：它从**第三方** `dsh-better-sidebar` 提取 `isFolderRevealPath`，而该插件于 2026-09-12 17:34 更新到 `0.19.0-alpha.1`、函数形状变化（现为 `revealInExplorer`/`revealPaths`），探针按设计「形状变了就报警」。**与本改动无关**（未触及该插件；同一探针在本次会话早期仍是 PASS），需按新 bundle 重新提取后单独修复 |
| 管理器套件（4 个） | 全部 PASS | bundle / debounce / host-core / root-install-shell |
| `openspec validate --changes esc-rewind-stop-hint-evidence` | ✓ 1 passed | MODIFIED 需求保留既有 scenario 名 |

## 6. 架构/模块图变更

- 无（未新增图资产；纯客户端判据修正，未改结构）。

## 7. 记忆与 Handoff 更新

- 更新的项目记忆：`docs/knowledge/2026-09-08-dsh-esc-rewind.md`（v7.2）+ `docs/knowledge/README.md` 索引。
- 未保存 Codemap handoff（本仓库非 harness 工作目录）。

## 8. 未解决问题和剩余风险

- **提示晚一两帧**：工具栏 Stop 的提示要等该轮定型（尾部出现 `interrupted` 行 / `turn/end` 落定）。Esc 停止仍由按键路径立即提示，不受影响。
- **窗口截断**：若客户端事件窗口里既没有 `interrupted` 行、也没有该轮 `turn/end`（历史被分页截断等），候选会留到「发新消息 / 切会话」为止 → 不提示（宁缺勿错）；Esc armed 行为不变。
- **真机需人工验收**：`ACCEPTANCE.md` 1.5–1.9、4.4 为 `[B]` 项（需在真实 GUI 刷新页面后手测）。
- **OpenSpec 变更未归档**：按 `openspec-archive.md` 规则，等用户验收后再归档（归档时把 delta 并入主 spec）。

## 9. Git 状态

- 是否提交：**未提交**（未收到 commit 指令，不执行 commit / push）。
