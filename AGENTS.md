# dsh-plugins — Agent 指引

DSH 插件开发/收集仓库（本地 git monorepo；每个插件是独立子目录，各自带 `README.md` 与 `ACCEPTANCE.md`，先例：`dsh-open-session-workdir`、`dsh-composer-history-recall`）。

## 开始前先读
- **项目知识库索引：`docs/knowledge/README.md`** — 接手新任务或提问前先看索引，再按需点开具体篇目；每完成一段开发在此新增一篇并登记一行。
- 开发规则：本仓库无项目级规则索引，按 `developer-principles` 采用用户级 `~/.agents/rules/index.md`。

## 插件统一安装（先读 README）
仓库根是聚合伞包 `dsh-local-plugins`（`cordis.patch.yml` = 唯一激活清单）。涉及「安装/卸载/新增插件、profile 结构、bundles」时先读根 `README.md` 的「统一安装模型」，不要直接逐个 `dsh plugin add` 本地插件。
