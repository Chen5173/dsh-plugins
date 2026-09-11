## Why

本仓库是一个 git 仓库（remote `https://github.com/Chen5173/dsh-plugins.git`），但**没法用 git 地址安装**。2026-09-10 的 `ebc225d`「将manager作为根目录下的安装bundle」只写了文档：README / AGENTS 都声称根 `package.json` 是「管理器的安装外壳」、并声称约束由 `dsh-plugin-manager/test/root-install-shell.test.mjs` 强制 —— 但**这两个文件都没有被创建**。后果是按文档操作的人会在真仓库上撞墙：

实测（`DSH_HOME` 指向临时目录 + 本地 bare remote + `git+file://`，未触碰运行中的 web profile）：

| 仓库根状态 | `dsh plugin --profile web add git+…` 的实际结果 |
|---|---|
| 无 `package.json`（= 2026-09-10 的真实状态） | pnpm 用**仓库目录名**当包名（装出来叫 `pre.git`），依赖键 `pre.git`，`dsh.profile.bundles` **不变**，CLI 打 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**永不激活** |
| 有同名外壳 `package.json`（本变更） | 依赖键 `dsh-plugin-manager`，`bundles` 恰好多一条 `dsh-plugin-manager`，`--dump-default-config` 组合出 `- id: dsh-plugin-manager`，管理器在 clone 里扫到全部 6 个子插件 |

根因在 `apps/cli/src/plugin.ts`：`dsh plugin add <spec>` 只是把 `pnpm add <spec>` 转发到 profile 目录，再按「装出来的真实包名」查 `dsh.bundle?.patch` 做 reconcile。pnpm 安装 git 依赖时**把 clone 的根目录当作那个包**，所以**根清单决定包名与是否为 bundle**——这是 git 入口的唯一硬条件，`add <仓库根>` 路径入口同样依赖它。

## What Changes

- **新增仓库根 `package.json`：管理器的安装外壳**（此前只存在于文档里）。同名（`dsh-plugin-manager`）、`private: true`、`type: module`、`main`/`exports["."]`/`exports["./client"]`/`dsh.client`/`dsh.bundle.patch` 全部转发到 `dsh-plugin-manager/` 内既有文件；**不声明任何依赖**、**不带 `dsh.profile.bundles`**、**不设 `files` 白名单**、根仍不放 `cordis.patch.yml`。零新增源码、零复制。
- **新增 `dsh-plugin-manager/test/root-install-shell.test.mjs`**（18 条断言）：把上面每一条 MUST 都变成判红条件，并断言「从安装后布局反推仓库根仍能扫到子插件」。
- **文档同步 git 入口**：根 `README.md`「安装」段改为以 `git+https://`/`github:` 领头并解释外壳为何是硬条件；`dsh-plugin-manager/README.md` 同步；`AGENTS.md` 补「为什么外壳才能吃 git 地址」与「git 装的是快照」。
- **spec 校订**：`plugin-manager` 的「本地插件不提供 bundle 安装路径」原文写着「无根 `package.json`」，与外壳直接冲突 → 改为「根唯一允许的清单是安装外壳」，并 ADDED 新 Requirement「仓库根安装外壳让 git 地址可直接安装」。
- **ACCEPTANCE 校订**：A11 删掉 2026-09-10 那批指向不存在文件的「已验证」条目、留校订说明、未复验项明标；新增 A12 记录本次 git 实测。

## Capabilities

### Added Capabilities

（无新 capability。）

### Modified Capabilities

- `plugin-manager`：ADDED「仓库根安装外壳让 git 地址可直接安装」（4 场景）；MODIFIED「本地插件不提供 bundle 安装路径」（把「根不得有 package.json」收窄为「根唯一允许的清单是零内容的外壳」）。

## Non-goals

- **不改管理器逻辑**：`repoRootOfPluginSrc` / `pluginRootsOf` 现有实现天然适配「clone 根即仓库根」（实测），不加来源检测、不加代码。
- **不改 DSH 核心**：不在 `dsh plugin` 里为 git spec 加特殊处理或护栏。
- **不做发布到 npm registry**：外壳保持 `private: true`；本变更只服务 git / 路径两种入口。
- **不补 `test/batch-toggle.test.mjs`**：同类「文档引用不存在的测试」事故，但属于批量功能，另案处理（已记入知识库「未了结」）。
- **不动本机 web profile**：它现在仍以 `link:` 指向仓内子目录；是否换成 git 地址由用户决定（实测两种入口可互相收敛为同一条 bundle 层）。

## 成功判据

1. `dsh plugin --profile <name> add git+https://…/dsh-plugins.git` 之后：`dependencies` 只多出 `dsh-plugin-manager` 一个键、`dsh.profile.bundles` 只多出 `dsh-plugin-manager` 一层、启动组合出 `- id: dsh-plugin-manager`、无 `duplicate loader entry id`。
2. 从该 clone 里 `repoRootOfPluginSrc(<pkg>/dsh-plugin-manager/src)` === `<pkg>`，扫到 6 个子插件且 `readPluginMeta` 全 `valid`；面板启用某子插件后 `link:` 指向 clone 内子目录并可被 profile 解析，`deriveStates` 报 `active`。
3. `node dsh-plugin-manager/test/root-install-shell.test.mjs` 全绿，且改名/漏转发/加依赖/加 `files`/加根 patch/子插件复活 `dsh.bundle` 六类变异全部判红。
4. 仓库内不再有任何文档声称「根没有 package.json」或引用不存在的 `root-install-shell.test.mjs`。
