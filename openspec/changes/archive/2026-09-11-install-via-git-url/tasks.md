## 1. 提案与设计

- [x] 1.1 `proposal.md`（Why 含「无根清单 → 包名退化成 `pre.git` 且不激活」的实测对照表 / What Changes / Non-goals / 成功判据）
- [x] 1.2 `design.md`（D1–D5 决策、机制源码依据、10 行实测表、已知限制、回滚）
- [x] 1.3 本变更的 spec delta（1 条 ADDED + 1 条 MODIFIED Requirement）

## 2. 落地安装外壳

- [x] 2.1 新增仓库根 `package.json`：`name` = `dsh-plugin-manager`、`private: true`、`type: module`、`main`/`exports["."]` → `dsh-plugin-manager/src/index.js`、`exports["./client"]` → `dsh-plugin-manager/src/client.js`、`dsh.client` 与包内一致、`dsh.bundle.patch` → `dsh-plugin-manager/cordis.patch.yml`
- [x] 2.2 确认外壳**零内容**：不声明 `dependencies`/`devDependencies`/`optionalDependencies`、不带 `dsh.profile`、不设 `files`、根不放 `cordis.patch.yml`
- [x] 2.3 确认管理器代码无需改动（`repoRootOfPluginSrc` 从 `<pkg>/dsh-plugin-manager/src` 反推出的仓库根即 clone 根；实测 6/6 子插件 `valid`）

## 3. 强制测试

- [x] 3.1 新增 `dsh-plugin-manager/test/root-install-shell.test.mjs`（18 条断言，全绿）：身份（name === 包内 name === 客户端注册 id）、ESM/private、零依赖、清单任何位置不出现子插件名、`main`+`exports["."]`+`exports["./client"]`+`dsh.client`+`dsh.bundle.patch` 逐条转发到位且目标文件存在、包内 patch 只插一行、根无 patch、无 `dsh.profile`、无 `files` 白名单、6 个子插件均不声明 `dsh.bundle`/无包自带 patch/不复用管理器包名、安装后布局仍可扫描
- [x] 3.2 红能力验证：11 个外壳变异 + 1 个子插件变异全部判红，对照组全绿（逐条结果见 design.md 表 #10）
- [x] 3.3 在**安装出来的 clone** 内直接跑该测试 → PASS（外壳随仓库分发且自洽）

## 4. git 入口实测（隔离 DSH_HOME + 本地 bare remote + git+file://）

- [x] 4.1 正向：`add git+…` → 依赖键 `dsh-plugin-manager`、`bundles` 恰多加一条、无 `declares no dsh.bundle` 警告
- [x] 4.2 启动组合：`--dump-default-config` 出现 `- id: dsh-plugin-manager / name: dsh-plugin-manager`，exit 0，无 `duplicate loader entry id`
- [x] 4.3 安装内容：`node_modules/dsh-plugin-manager/` 为整棵工作树（含 `sub-plugins/`，无 `.git`/`node_modules`）
- [x] 4.4 运行时定位与子插件启用：`link:` 指向 clone 内 `sub-plugins/dsh-esc-rewind` → `pnpm install` exit 0 → 可 `resolve()`、`deriveStates` = `active`、`--dump-config` 含 `esc-rewind` 行
- [x] 4.5 反向对照（红能力）：remote 退回无根清单的提交 → 依赖键变成仓库目录名 `pre.git`、`bundles` 不变、打印 `declares no dsh.bundle …`
- [x] 4.6 入口收敛：profile 先以 `link:` 装管理器（= 本机 web profile 现状）再 `add git+…` → 同一依赖键被改写、`bundles` 仍一条、`- id: dsh-plugin-manager` 出现次数 = 1、exit 0
- [x] 4.7 全程未触碰运行中的 web profile（仅**只读**查看其现状以确认迁移场景）

## 5. 文档与 spec 同步

- [x] 5.1 根 `README.md`「安装」：以 `git+https://…`/`github:` 领头，补「为什么非要有这个外壳」「git 装的是快照」「子插件跟着一起进来（禁 `files`）」三段实测说明；修掉指向不存在文件的 `add-repo-root-install-entry` 引用
- [x] 5.2 `dsh-plugin-manager/README.md`「安装」同步 + 测试清单加入 `root-install-shell.test.mjs`
- [x] 5.3 `AGENTS.md`：外壳约束补 `type: module`/无 `dsh.profile`/无 `files`，并写明三种入口等价与「包名取自根清单」的机制
- [x] 5.4 `openspec/specs/plugin-manager/spec.md`：MODIFIED「本地插件不提供 bundle 安装路径」（「无根 package.json」→「根唯一允许的清单是零内容外壳」，消除与 AGENTS/README 的直接冲突）；ADDED「仓库根安装外壳让 git 地址可直接安装」（4 场景）
- [x] 5.5 `dsh-plugin-manager/ACCEPTANCE.md`：A9 校订「仓库根无 package.json」已不成立；A11 重写（删除指向不存在文件的证据条目、留校订说明、未复验项明标）；新增 A12 记录 git 实测
- [x] 5.6 `docs/knowledge/2026-09-11-install-via-git-url.md` 新增 + 索引登记；顺手把索引里指向不存在的 `2026-09-10-repo-root-install-entry.md` 的行改接本篇，并对 `2026-09-10-batch-toggle-all.md` 缺失行加 ⚠️ 说明

## 6. 验收

- [x] 6.1 `node dsh-plugin-manager/test/*.mjs` 四支全绿
- [x] 6.2 成功判据 1–4 逐条达成（判据 4：仓库内不再有「根没有 package.json」的声称，`grep` 复核）
- [x] 6.3 真实 `git+https://` 复验（推到 `135ce6b` + tag `v0.1.0` 之后，隔离 `DSH_HOME`）：`add git+https://github.com/Chen5173/dsh-plugins.git` → exit 0、依赖键 `dsh-plugin-manager`（pnpm 归一化显示为 `github:Chen5173/dsh-plugins`）、`bundles` 恰一条、无警告；`#v0.1.0` 锁版本同样正常；装出来的 `node_modules/dsh-plugin-manager/` 是整棵工作树（6 个子包），在其内部跑外壳测试 PASS
- [ ] 6.4 需真机（浏览器侧）：重启 `dsh web` → 设置页出现「本地插件」、`GET /list` 列出 6 个子插件、界面功能正常
- [ ] 6.5 未覆盖：私有仓库的 git 凭据面（本仓库 public，pnpm 直接调用系统 git）
- [ ] 6.6 另案：补 `test/batch-toggle.test.mjs`（同类「文档引用不存在的测试」事故，批量功能的 handler 级自动化仍缺）
