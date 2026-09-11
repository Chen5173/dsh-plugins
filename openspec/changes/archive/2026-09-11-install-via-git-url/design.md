# Design — 仓库根安装外壳与 git 地址入口

## 背景机制（读源码确认，非推测）

`dsh plugin --profile <name> <args…>`（`apps/cli/src/plugin.ts`）做三件事：

1. profile 目录不存在则 `initProfile()`（只写 `package.json`/`cordis.patch.yml`/`pnpm-workspace.yaml`，不安装）。
2. `spawnSync('pnpm', args)`，cwd = profile 目录；参数过一遍 `anchorPathSpec()` —— 它**只**重写 `.`/`..` 开头的相对路径（含 `file:`/`link:` 前缀形式），`git+https://…`、`github:user/repo`、绝对路径**原样透传**。
3. pnpm 成功则 `reconcilePlugins()`：遍历 profile `dependencies` 的**真实包名**，对每个调 `exportsPatch()` → `resolveBundleDir()` → 读该包 manifest 的 `dsh.bundle?.patch`；有则把包名追加进 `dsh.profile.bundles`，没有则（新依赖）打警告 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`。

启动侧 `loadProfile()`（`packages/boot/app-boot/src/profile.ts`）按 `dsh.profile.bundles` 顺序解析每层包目录，读 `dsh.bundle.patch`（**相对该包根**）合成 patch 层；声明了 bundle 层却没有 `dsh.bundle` 会直接抛 `profile bundle "X" declares no dsh.bundle in its package.json`。

**关键推论**：git 依赖由 pnpm clone 整个仓库、并把 **checkout 根目录当作那个包**。于是「装这个仓库」这件事的包名、是否为 bundle、入口文件、patch 路径**全部由根 `package.json` 决定**，管理器内部那份 `dsh-plugin-manager/package.json` 在 git 安装路径上根本不被读取（它只是被 clone 进来的一个普通子目录）。

## 决策

### D1 外壳 = 同名转发器，而不是伞包（aggregator）

根清单与包内清单**同名** `dsh-plugin-manager`，且只转发、不产出任何新内容：

| 字段 | 值 | 为什么 |
|---|---|---|
| `name` | `dsh-plugin-manager` | 包名 = profile `dependencies` 键 = bundle 层名 = 激活行 id = 浏览器模块表 id（客户端产物里 `__ModuleLoader__.load({ id: 'dsh-plugin-manager' })` 是写死的） |
| `private` | `true` | 外壳只服务「装这个仓库」，不该被发布 |
| `type` | `module` | cordis bundle body 需要 ESM 命名导出 |
| `main` / `exports["."]` | `dsh-plugin-manager/src/index.js` | 与包内清单同一文件 ⇒ `add <根>` 与 `add <根>/dsh-plugin-manager` 加载同一份宿主半 |
| `exports["./client"]` | `dsh-plugin-manager/src/client.js` | `client-modules` 对声明了 `dsh.client` 却没有 `./client` 的包会直接抛 `declares dsh.client but exports no "./client" bundle` |
| `dsh.client` | 与包内逐字段相同 | 安装后被读取的是**根**清单 |
| `dsh.bundle.patch` | `dsh-plugin-manager/cordis.patch.yml` | 相对包根解析，正好落到包内那份（只插管理器自己一行） |
| 依赖 | 一个都不声明 | 见 D2 |
| `files` | 不写 | 见 D3 |
| `dsh.profile` | 不写 | 见 D4 |

同名 ⇒ 两个入口写入同一个依赖键与同一条 bundle 层；`patch` 指向同一个文件 ⇒ 激活行 id 相同 ⇒ 不可能 `duplicate loader entry id`。

### D2 外壳 MUST NOT 声明子插件依赖

这正是 2026-09-10 删掉的伞包 `dsh-local-plugins` 的事故机制：伞包那 5 行与管理器维护的行 id **完全相同**，谁再装一次就多插一行同 id → 启动崩溃。子插件的激活行**只由管理器写进 profile 的** `cordis.patch.yml`。另外 pnpm 也不会安装「仓外 link 包」声明的嵌套依赖，靠外壳 dependencies 传递安装子插件本来就不成立。

### D3 外壳 MUST NOT 设 `files` 白名单

实测 git 安装会带上整棵工作树（`sub-plugins/`、`docs/`、`openspec/`…，无 `.git`、无 `node_modules`）。`files` 是 pack 白名单，一旦加上（例如只列 `dsh-plugin-manager/`）就会把 `sub-plugins/` 裁掉 —— 而管理器恰恰靠 `<仓库根>/sub-plugins/` 扫子插件，届时面板会在自己的安装目录里扫到**空集合**。

### D4 根仍然不放 `cordis.patch.yml`

外壳提供 bundle 层 ≠ 根提供聚合清单。根一旦有 patch，就会与管理器写的行撞 id。故 `dsh.bundle.patch` 指向的是**包内**那份，根目录保持无 patch。

### D5 不改管理器代码

`repoRootOfPluginSrc(<安装目录>/dsh-plugin-manager/src)` = `<安装目录>`，`pluginRootsOf` 首根 = `<安装目录>/sub-plugins` —— 与仓库内布局同构，所以 git 安装天然可用（实测 6/6 `valid`、行 id 与仓库内一致）。启用子插件时写的 `link:` 会指向 profile 自己 `node_modules` 内部，pnpm（hoisted linker）接受并 hoist 成一条链接，`createRequire(profile/package.json).resolve()` 可解析。

## 实测（2026-09-11）

手法：`DSH_HOME` 指向临时目录、`git clone --bare` 出本地 remote、`git+file://`（与 `git+https://`/`github:` 走 pnpm 完全相同的 clone→根即包 路径，只差传输与鉴权）。启动类断言一律用 `--dump-default-config` / `--dump-config`（只组合配置树，不占端口、不起服务，故可在正在跑 GUI 的机器上安全执行）。**全程未触碰运行中的 web profile。**

| # | 构造 | 结果 |
|---|---|---|
| 1 | 无根清单的 remote（退回 `ebc225d`）`add git+file://…` | 依赖键 `pre.git`（=仓库目录名），`bundles` 不变，`declares no dsh.bundle …` 警告，exit 0 但**不激活** |
| 2 | 有外壳的 remote `add git+file://…` | 依赖键 `dsh-plugin-manager`，`bundles` = `[dsh-base, dsh-web-app, dsh-plugin-manager]`，无警告 |
| 3 | 同 profile `--dump-default-config` | `# == dsh-plugin-manager` + `- id: dsh-plugin-manager / name: dsh-plugin-manager`，exit 0 |
| 4 | 安装内容 | `node_modules/dsh-plugin-manager/` = 整棵工作树（含 `sub-plugins/` 6 包、`dsh-plugin-manager/`；无 `.git`/`node_modules`） |
| 5 | 从安装目录跑 host-core | `repoRootOfPluginSrc` → 安装根；`pluginRootsOf[0]` → `…/sub-plugins`；`listRepoPluginDirs` → 6 个，`readPluginMeta` 全 `valid` |
| 6 | 按 `ensureDevDep`+`upsertManaged` 启用 `dsh-esc-rewind` 后 `pnpm install` | exit 0；`node_modules/dsh-esc-rewind` → clone 内子目录；`resolve('dsh-esc-rewind')` → `…/src/index.js`；`deriveStates` = `active`（其余 5 个 `uninstalled`） |
| 7 | 同 profile `--dump-config`（含用户层） | 出现 `- id: esc-rewind / name: dsh-esc-rewind`，exit 0 |
| 8 | 在安装出来的 clone 里跑外壳测试 | `root-install-shell tests: PASS` |
| 9 | **收敛**：profile 先 `link:<仓>/dsh-plugin-manager`（本机 web profile 现状）再 `add git+…` | 同一个 `dsh-plugin-manager` 键的 spec 被改写；`bundles` 仍一条；`- id: dsh-plugin-manager` 出现次数 = **1**；exit 0 |
| 10 | 外壳测试的 11 个变异（改名 / 删 `exports["./client"]` / 删 `main` / 转发指向不存在文件 / 加子插件依赖 / patch 指向根新建 patch / 加 `files` / 改 `dsh.client.platform` / 去 `private` / 删整个 `dsh.bundle` / 外壳加 `dsh.profile.bundles`）+ 让子插件重新声明 `dsh.bundle` | 全部**判红**；对照组全绿 |

## 已知限制

- **git 装的是快照**：改仓库源码不即时生效，升级走 `dsh plugin --profile <name> update`。`/list` 目前只回显路径，面板不区分「clone」与「本地 checkout」，也不会提示「该用 update」。
- **私有仓库鉴权不在本仓库掌控内**：pnpm 直接调用系统 git，凭据走 git 侧（SSH key / credential helper）。本次只验到 `git+file://`，真实 `git+https://` 的传输与鉴权面需真机复验（A12 留了未勾选项）。
- **无 `prepare` 脚本 ⇒ 不需要 `allowBuilds`**：`dsh plugin` 失败时会提示 pnpm ≥10 的 `allowBuilds` 白名单，容易被误读为「git 插件都要配」。本仓库根清单刻意不带构建脚本，所以不适用 —— 这一点值得写进 README 以免有人去乱配 workspace 文件。

## 回滚

删掉根 `package.json` 即回到 2026-09-10 状态（git 入口失效、路径入口仍可指 `<仓库根>/dsh-plugin-manager`）；外壳与包内清单之间没有任何复制关系，不存在双份代码需要清理。已按 git 地址装过的 profile 用 `dsh plugin --profile web remove dsh-plugin-manager` 卸载即可。
