# dsh-plugins — Agent 指引

DSH 插件开发/收集仓库（本地 git monorepo；每个插件是独立子目录，各自带 `README.md` 与 `ACCEPTANCE.md`，先例：`dsh-open-session-workdir`、`dsh-composer-history-recall`）。

## 开始前先读
- **项目知识库索引：`docs/knowledge/README.md`** — 接手新任务或提问前先看索引，再按需点开具体篇目；每完成一段开发在此新增一篇并登记一行。
- 开发规则：本仓库无项目级规则索引，按 `developer-principles` 采用用户级 `~/.agents/rules/index.md`。

## 每个插件做什么、怎么用
回答「X 插件干嘛的 / 在哪触发 / 有什么前提」先看 **`docs/plugins.md`**（用法索引，含核对过的槽位与 order 分布）。写/改任何插件文档前注意：本仓库多次出现「文档声称存在、实际文件不存在」，因此**文档里的每条命令与每个 order/端点都要从源码核对**，不要照抄旧 README。

## 插件统一安装（先读 README）
只装 `dsh-plugin-manager` 一个本地 bundle；子插件源码在 `sub-plugins/`（管理器自身仍在仓库根），子插件根与仓库根都会被扫描。激活清单（真相源）是 profile `cordis.patch.yml` 中由管理器维护的稳定 id 行。涉及「安装/卸载/新增插件、profile 结构、bundles」时先读根 `README.md` 的「统一安装模型」，不要直接逐个 `dsh plugin add` 本地插件。

### 本地插件包一律不声明 `dsh.bundle`（2026-09-10 起）
- `sub-plugins/dsh-*/package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 有包自带 `cordis.patch.yml`；仓库根 MUST NOT 再提供聚合伞包 `dsh-local-plugins`（聚合 `cordis.patch.yml` 已删除，根不再有任何列出子插件激活行的清单）。
- **唯一例外：管理器的安装外壳**（2026-09-10 提出，**2026-09-11 才真正落地**）—— 根 `package.json` 可以声明 `dsh.bundle`，但 MUST 满足：`name` = `dsh-plugin-manager`（包名即插件身份：profile `dependencies` 键 / bundle 层名 / 激活行 id / 浏览器模块表 id）、`private: true`、`type: module`、`main`/`exports["."]` 转发到 `dsh-plugin-manager/src/index.js`、`exports["./client"]` 与 `dsh.client` 与包内一致、`dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`、**不声明任何依赖**、**不带 `dsh.profile.bundles`**、**不设 `files` 白名单**。目的是让 `dsh plugin --profile web add <仓库根>`、`add <仓库根>/dsh-plugin-manager` 与 **`add git+https://github.com/Chen5173/dsh-plugins.git`（及 `github:` 简写）三者等价**。这些约束由 `dsh-plugin-manager/test/root-install-shell.test.mjs`（18 条断言）强制：改名 / 漏转发 / 加子插件依赖 / 加 `files` / 加根 patch / 子插件复活 `dsh.bundle` 全部判红（2026-09-11 用 11 个变异验证过确实判红）。
- **为什么要外壳才能吃 git 地址**：`dsh plugin add` 只是把 `pnpm add <spec>` 转发到 profile 目录，pnpm 安装 git 依赖时**把 clone 的根目录当作那个包**，包名取自根 `package.json` 的 `name`。没有根清单时 pnpm 退化用仓库目录名当包名（实测叫 `dsh-plugins`/`pre.git`）、且因没有 `dsh.bundle` 被 reconcile 判成普通依赖并打 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**永不激活**。`files` 白名单会把 `sub-plugins/` 从安装内容里裁掉，而管理器正是靠该目录扫子插件（实测：clone 内含整棵工作树，`repoRootOfPluginSrc` 直接适配，无需改代码）。
- **git 装的是快照，不是活链接**：改仓库源码不即时生效，升级走 `dsh plugin --profile web update`；开发期要热改用本地路径入口。两种入口互换只改写同一个 `dsh-plugin-manager` 依赖键，不产生第二条 bundle 层（实测收敛）。
- 原因：子插件的激活行由管理器写在 profile `cordis.patch.yml`。若包同时声明 `dsh.bundle`，一次 `dsh plugin --profile web add <子插件目录>` 就会把它塞进 `dsh.profile.bundles`，包自带 patch 与管理器行**同 id 各插一次** → `dsh web` 启动失败 `duplicate loader entry id: <rowId>`（已实测复现）。
- 卸载/停用只能走管理器面板：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、不删管理器写的激活行，会留下悬空行使下次启动报 `failed to import loader entry …: Cannot find package …`（同样已实测）。
- 变更记录与实测证据：`openspec/changes/archive/2026-09-10-retire-local-plugin-bundle-install/`。
