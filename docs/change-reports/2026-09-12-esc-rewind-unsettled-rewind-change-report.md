# esc-rewind 快捷键回退放宽 修改报告

## 1. 需求与成功标准
- **需求**：只要对话这一轮「不是正常结束（settled）」，就允许用 Esc 快捷键回退，不再要求尾部必须是 `interrupted`。
- **成功标准**：
  - 非运行态下，尾部非 settled（含 running 之外的 interrupted / 未知状态 assistant / 刚发出的 user 提问）且草稿为空时，Esc 触发 rewind；
  - 正常运行结束（settled 尾）永不 rewind；
  - 草稿非空仍 disarm；
  - 运行态两次 Esc 语义不变（stop → rewind）。

## 2. 修改摘要
- 新增 `tailUnsettled(list)` 判定「尾部非 settled」；
- `decideEsc` 非运行分支与 `EscBridge` 的 post-stop hint 改用同一判定，保证提示与实际 armed 一致；
- 运行态分支、草稿条件、回退点选取（`qualifyExchange`）均未改。

## 3. 修改文件和符号
| 文件 | 函数 | 修改内容 |
|---|---|---|
| `sub-plugins/dsh-esc-rewind/src/client.js` | `tailUnsettled`（新增） | 判定尾部非自然结束 |
| 同文件 | `decideEsc`（409 行 → 417 行） | `tailInterrupted(list)` → `tailUnsettled(list)` |
| 同文件 | `EscBridge`（hint effect + 监听） | `interrupted` → `unsettled`，提示同步新语义 |
| 同文件 | internals 导出 | 追加 `tailUnsettled` |
| `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | —— | 新增 2 条纯逻辑用例（user 尾、未知状态 assistant 尾回退） |
| `docs/knowledge/2026-09-08-dsh-esc-rewind.md` | —— | 追加 v6 小节 |
| `docs/knowledge/README.md` | —— | 索引登记一行 |

## 4. 影响面复查
### Codemap
- 依赖方：`src/client.js` 无外部文件 import（插件入口，自带独立 bundle）——**complete**。
- 被依赖方：无其他插件引用它。
- 其他入口：`decideEsc` 仅由 document capture 监听调用；hin生效逻辑用同一 `unsettled`。

### Serena
- 符号引用：`tailUnsettled` 新增，被 `decideEsc`、`EscBridge`、internals 导出引用，均已更新。
- `tailInterrupted` 保留未删（仍导出），不再用于 armed 判定。
- 未确认关系：无（纯客户端插件，无跨语言/API 边界）。

## 5. 测试结果
| 命令 | 结果 | 备注 |
|---|---|---|
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | 37/37 PASS | 新增 2 条 + 既有 35 条全绿 |
| 全仓库子插件套件（7 个 `bundle.test.mjs`） | 全部 PASS | 无回归 |
| `node --check` 两个改动文件 | OK | 语法正常 |

## 6. 架构/模块图变更
- 无（未新增图资产；纯逻辑放宽，未改结构）。

## 7. 记忆与 Handoff 更新
- 更新的项目记忆：`docs/knowledge/2026-09-08-dsh-esc-rewind.md`（v6）+ `docs/knowledge/README.md` 索引。
- 保存的 Handoff：Codemap 工作目录指向 deepseek-harness，非本仓库，未保存本项目 handoff（记录原因）。
- 标记为待验证：无。

## 8. 未解决问题和剩余风险
- 语义边界已与用户确认：尾部为「刚发出的 user 提问」也会可回退，re重放到该提问本身。
- hint 文案仍只区分 delete 开/关两档，未新增「未回复提问」专属文案（如需可后续加）。

## 9. Git 状态
- 是否提交：**未提交**（未收到 commit 指令，不执行 commit / push）。
