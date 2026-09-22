# 2026-09-11 · DSH 插件：用 git 地址安装整个 monorepo（根安装外壳落地）

> **补记（2026-09-22）：删管理器为什么必须用自带脚本**
> 1) 核心 `dsh plugin --profile web remove dsh-plugin-manager` 是 **pnpm 薄转发 + 只对账 `dsh.profile.bundles`**（`apps/cli/src/plugin.ts`）——它**不认识** profile `cordis.patch.yml` 里由管理器写下的子插件激活行，也**不动**子插件的 `link:` 键，核心**没有任何卸载钩子**；只删管理器会留下悬空行 + 死链，下次启动 `failed to import loader entry …: Cannot find package …`。
> 2) git 快照装法下更糟：子插件代码就在管理器克隆里（`node_modules/dsh-plugin-manager/sub-plugins/<name>`）⇒ 删管理器等于把它们一起带走，但行与键还在。
> 3) 因此本仓自带 `dsh-plugin-manager/tools/uninstall-manager.mjs`（**不依赖 DSH 宿主与 dsh CLI**，只用 node + pnpm + profile 的 js-yaml）：清受管行 + 指向本仓库的 `link:` 键 + 管理器依赖键 + bundles 条目 → 一次 `pnpm install`；写前两份 `*.bak-<ts>`、**不删任何源码目录**、默认干跑（`--yes` 才执行）、重复跑 noop。面板只提供「复制卸载命令」（含 `--profile <name> --yes`），**不提供点一下就执行**。
> 4) 测试不变量（`test/uninstall.test.mjs`）：恰好一次 patch 写 / 一次 manifest 写 / 一次 install、其它插件的行键逐字节不变、源码目录仍在、安装失败时给 `pnpm install --dir` 收尾命令（此时行键已清，不留半态）。

日期：2026-09-11 · 涉及：仓库根 `package.json`（新增）、`dsh-plugin-manager/test/root-install-shell.test.mjs`（新增）、根 `README.md`、`dsh-plugin-manager/{README,ACCEPTANCE}.md`、OpenSpec `plugin-manager` spec。

## 一句话

`dsh plugin --profile web add git+https://…/dsh-plugins.git` 能装成功的前提，是**仓库根有一个与管理器同名的 `package.json`**：pnpm 安装 git 依赖时把 clone 的根目录当作包，所以**根清单的 `name` 就是插件身份**；本机 web profile 里 `dsh-plugin-manager` 这个包名、bundle 层名、激活行 id 全都来自它。

## 可复用结论

1. **`dsh plugin` 是 pnpm 转发器 + reconcile**（`apps/cli/src/plugin.ts`）：`add <spec>` → 在 profile 目录跑 `pnpm add <spec>` → 用「装出来的真实包名」查 `dsh.bundle?.patch`，有则进 `dsh.profile.bundles`，无则打 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告。因此 **git 地址装不装得上，完全取决于 clone 根目录那份 manifest**：没有根 `package.json` 时 pnpm 退化用**仓库目录名**当包名（实测装出来叫 `pre.git`），既没有 `dsh.bundle` 也永不激活。
2. **外壳（forwarder）模式，不是伞包（aggregator）模式**：根清单只做三件事——同名、转发（`main`/`exports["."]`/`exports["./client"]`/`dsh.client`/`dsh.bundle.patch` 全部指向 `dsh-plugin-manager/` 内的既有文件）、零内容（不声明依赖、不带 `dsh.profile.bundles`、根不放 `cordis.patch.yml`）。激活行仍然只由管理器写进 **profile** 的 `cordis.patch.yml`，所以「装根」与「装包目录」是同一个 id，不会 `duplicate loader entry id`。
3. **git 依赖会带上整棵工作树**（实测：clone 后有 `sub-plugins/`、`docs/`、`openspec/`，无 `.git`、无 `node_modules`）。推论：**根清单 MUST NOT 设 `files` 白名单**——那等于把要管理的子插件裁掉，管理器会在自己的安装目录里扫到空集合。管理器现有的 `repoRootOfPluginSrc(<pkg>/dsh-plugin-manager/src) === <pkg>` 因此**天然适配** git 安装，不需要任何路径逻辑改动。
4. **从 clone 里启用子插件也是通的**：管理器写的 `link:<pkg>/sub-plugins/<x>` 指向 profile 自己的 `node_modules` 内部，pnpm（hoisted linker）接受并把子包 hoist 成一条链接，`createRequire(profile/package.json).resolve('<x>')` 能解析到 `src/index.js`，`--dump-config` 能组合出该激活行。也就是说 `git+https` 装来的是**自包含的一份仓库**，不需要用户再 clone。
5. **git 装来的是快照不是活链接**（与 `link:` 相对）：改源码不即时生效，升级走 `dsh plugin --profile web update`。开发期要热改仍用 `add <仓库根>`；两种入口可互相替换、**收敛为同一条 bundle 层**（实测把已有的 `link:` 换成 git 地址：依赖键不变、bundles 仍一条、`- id: dsh-plugin-manager` 出现次数 = 1）。
6. **无 `prepare` 脚本 ⇒ 不需要 pnpm 10 的 `allowBuilds` 白名单**（`dsh plugin` 失败时会提示该白名单，容易误以为要配）。本仓库根清单刻意不加任何构建脚本，所以 git 安装是一条命令就完的事。
7. **验证手法（不碰运行中的 profile）**：`DSH_HOME=<临时目录>` + `git clone --bare` 出一个本地 remote + `git+file://`（与 `git+https://`/`github:` 走 pnpm 同一条 clone→根即包 的路径，只差传输与鉴权）；启动类断言用 `dsh --profile X --dump-default-config`（bundle 层）/ `--dump-config`（含 profile 用户层）——只组合配置树、**不占端口、不起服务**，因此可以在正在跑 GUI 的机器上安全验证。

## 踩坑 / 事故记录

- **文档比代码先跑**：`ebc225d`「将manager作为根目录下的安装bundle」只改了 README/AGENTS/spec/src，**根 `package.json` 与被反复引用的 `test/root-install-shell.test.mjs` 都没建**；AGENTS.md 还写着「这些约束由 root-install-shell.test.mjs 强制」。后果：任何人按文档以为 `add <仓库根>` 可用，而它实际会把仓库装成名为 `dsh-plugins` 的普通依赖。已在 A11 顶部留「校订说明」，把当时未落地的证据条目删掉、未复验的明标为未复验。**规则：写「由 X 测试强制」之前，X 必须已经存在并跑绿。**
- **`git ls-tree`/`git log --stat` 是判据**：怀疑某天的「实测」是否真的落了盘，看那个 commit 到底动了哪些文件即可，不必重跑当时的实验。
- 同一批遗留：`dsh-plugin-manager/test/batch-toggle.test.mjs` 也被 README 与 ACCEPTANCE A10 当作证据引用，但该文件同样**从未入库**（批量目前只有 `batchPlan` 的纯逻辑测试 + 面板测试覆盖，「恰好一次写入 / 恰好一次 pnpm install / 逐项失败回报」这三条**没有** handler 级自动化）。属于同类事故，尚未补，见下。

## 下一步 / 未了结

- 补 `test/batch-toggle.test.mjs`（复用 `debounce.test.mjs` 的真 handler harness + `__setPnpmRunner` 桩），否则 A10 里引用它的 5 条 `[x]` 不成立。
- ~~真机跑一次真实 `git+https://`~~ → **已做**（2026-09-11 推到 `135ce6b` + tag `v0.1.0` 后）：`add git+https://github.com/Chen5173/dsh-plugins.git` 与其 `#v0.1.0` 形式都 exit 0，依赖键 `dsh-plugin-manager`、bundles 恰一条、装出来的是整棵工作树，装完的 clone 里外壳测试仍 PASS。顺带一个值得记的细节：**pnpm 会把 `git+https://github.com/<user>/<repo>.git` 归一化成 `github:<user>/<repo>` 写进 `dependencies`**，两者是同一个东西，别以为被改坏了。
- 仍未覆盖：私有仓库的 git 凭据面（本仓库 public）、以及浏览器里面板与子插件界面的真机复核。
- 若希望面板能区分「管理器来自 git clone」与「管理器来自本地 checkout」并据此提示「这是快照，升级用 update」，需要在 `/list` 里加一个来源字段（现在只有路径）。
