# dsh-plugins — Agent 指引

DSH 插件开发/收集仓库（本地 git monorepo；每个插件是独立子目录，各自带 `README.md` 与 `ACCEPTANCE.md`，先例：`dsh-open-session-workdir`、`dsh-composer-history-recall`）。

## 开始前先读
- **项目知识库索引：`docs/knowledge/README.md`** — 接手新任务或提问前先看索引，再按需点开具体篇目；每完成一段开发在此新增一篇并登记一行。
- 开发规则：本仓库无项目级规则索引，按 `developer-principles` 采用用户级 `~/.agents/rules/index.md`。

## 插件统一安装（先读 README）
只装 `dsh-plugin-manager` 一个本地 bundle；子插件源码在 `sub-plugins/`（管理器自身仍在仓库根），子插件根与仓库根都会被扫描。激活清单（真相源）是 profile `cordis.patch.yml` 中由管理器维护的稳定 id 行。涉及「安装/卸载/新增插件、profile 结构、bundles」时先读根 `README.md` 的「统一安装模型」，不要直接逐个 `dsh plugin add` 本地插件。

### 本地插件包一律不声明 `dsh.bundle`（2026-09-10 起）
- `sub-plugins/dsh-*/package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 有包自带 `cordis.patch.yml`；仓库根 MUST NOT 再提供聚合伞包 `dsh-local-plugins`（聚合 `cordis.patch.yml` 已删除，根不再有任何列出子插件激活行的清单）。
- **唯一例外：管理器的安装外壳**（2026-09-10 起）—— 根 `package.json` 可以声明 `dsh.bundle`，但 MUST 满足：`name` = `dsh-plugin-manager`（包名即插件身份：bundle 层名 / 激活行 id / 浏览器模块表 id）、`private: true`、`main`/`exports["."]` 转发到 `dsh-plugin-manager/src/index.js`、`exports["./client"]` 与 `dsh.client` 与包内一致、`dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`、**不声明任何依赖**。目的是让 `dsh plugin --profile web add <仓库根>` 等价于 `add <仓库根>/dsh-plugin-manager`。这些约束由 `dsh-plugin-manager/test/root-install-shell.test.mjs` 强制（改名/漏转发/加子插件依赖都会判红）。
- 原因：子插件的激活行由管理器写在 profile `cordis.patch.yml`。若包同时声明 `dsh.bundle`，一次 `dsh plugin --profile web add <子插件目录>` 就会把它塞进 `dsh.profile.bundles`，包自带 patch 与管理器行**同 id 各插一次** → `dsh web` 启动失败 `duplicate loader entry id: <rowId>`（已实测复现）。
- 卸载/停用只能走管理器面板：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、不删管理器写的激活行，会留下悬空行使下次启动报 `failed to import loader entry …: Cannot find package …`（同样已实测）。
- 变更记录与实测证据：`openspec/changes/archive/2026-09-10-retire-local-plugin-bundle-install/`。
