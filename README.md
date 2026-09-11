# dsh-plugins

本地 DSH 插件 monorepo（git 仓库）。每个插件是独立子包（子插件在 `sub-plugins/`，管理器自身在仓库根），各自带 `README.md` 与 `ACCEPTANCE.md`。**推荐安装方式：只装 `dsh-plugin-manager` 一个插件**，然后在其设置页「本地插件」面板里管理其它全部子插件（扫描、激活/停用、移除、一键迁移）。

## 统一安装模型（2026-09-09 起：管理器模型）

| 概念 | 位置 | 说明 |
|---|---|---|
| 唯一本地 bundle | web profile `dsh.profile.bundles` | 只保留 `dsh-plugin-manager` 一个本地条目 |
| 子插件（活链接） | profile `devDependencies`（`link:` 到仓库子目录） | 可解析、**不声明 `dsh.bundle`**（2026-09-10 起）所以 reconcile 任何路径都不会把它塞进 bundles、改代码即时生效 |
| 激活清单（真相源） | profile `cordis.patch.yml` 中由管理器维护的稳定 id 行 | `- insert: [{ id: <rowId>, name: '<pkg>' }]`；被 DSH patch HMR **实时热重载** |
| 管理 UI | 设置页一级入口「本地插件」（`settings.section`，order 16） | 每子插件：开关/移除；顶部：一键接管/迁移 |

### 安装

本仓库**本身就是一个 git 仓库**，根 `package.json` 是「管理器的安装外壳」，所以可以直接用 git 地址装（对方不需要先 clone）：

```bash
# 从 git 安装：装完插件名就是 dsh-plugin-manager
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
# 等价的 github 简写：dsh plugin --profile web add github:Chen5173/dsh-plugins
# 锁版本：地址后面加 #<tag|commit|branch>（该 ref 必须已推到远端，否则 pnpm 报 Could not resolve … 并整体失败）

# 本机开发（改代码即时生效）：装自己这份 checkout
dsh plugin --profile web add D:/ChenSirDocument/Dsh-Projects/dsh-plugins
# 等价写法（直接装包目录）：add <仓库根>/dsh-plugin-manager

# 重启 dsh web → 设置 → 本地插件 → 若提示旧布局，先点「一键接管/迁移」
```

> 这些写法**完全等价**（隔离 profile 实测）：都让 `dsh-plugin-manager` 进入 profile `dependencies` 与 `dsh.profile.bundles`，激活行 id 相同；从一个换成另一个只会**改写同一个依赖键**，不产生第二个 bundle 层或第二行（实测把已有的 `link:` 直接换成 git 地址即收敛）。根清单的 `name` **必须**等于 `dsh-plugin-manager` —— 包名就是插件身份（profile `dependencies` 键 / bundle 层名 / 激活行 id / 浏览器模块表 id）；它只是**转发外壳**（`main` → `dsh-plugin-manager/src/index.js`，`dsh.bundle.patch` → `dsh-plugin-manager/cordis.patch.yml`），源码、测试、README/ACCEPTANCE 都仍在 `dsh-plugin-manager/`。

> **为什么非要有这个外壳**：`dsh plugin add <git 地址>` 只是把 `pnpm add <git 地址>` 转发一遍，而 pnpm 会 clone **整个仓库**并把**根目录当作那个包** —— 于是根清单决定包名。实测（隔离 `DSH_HOME` + 本地 git remote）：有外壳 → 依赖键与 bundle 层都是 `dsh-plugin-manager`，`dsh --dump-default-config` 组合出 `- id: dsh-plugin-manager`；删掉外壳 → pnpm 退化用仓库目录名当包名（装出来叫 `dsh-plugins.git`），并且因为没有 `dsh.bundle` 被 reconcile 判成普通依赖，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**永不激活**。

> **git 装来的是快照，不是活链接**：profile 里放的是 clone 出来的副本，改仓库源码不会即时生效；升级用 `dsh plugin --profile web update`（或再 `add` 一次该地址）。要热改就用上面的本地路径写法。

> **子插件跟着一起进来**：pnpm 安装 git 依赖会带上整棵工作树（所以根清单**不能**加 `files` 白名单，那会把 `sub-plugins/` 裁掉），从 git 装的管理器照样扫到全部子插件；启用时它把 `link:` 指向 clone 内的 `node_modules/dsh-plugin-manager/sub-plugins/<pkg>`（实测能被 profile 解析、`dsh web` 正常启动）。

> 旧布局 = 子插件仍逐个挂在 `dependencies` + `dsh.profile.bundles`（每个子插件自己的 bundle 层在启动时读一次）。迁移会备份 profile 的 `package.json`/`cordis.patch.yml`，收敛为 devDependencies + 管理器维护行，**迁移前后激活集合不变**。

### 为什么子插件放 devDependencies 而不是 dependencies

`dsh plugin` 的 reconcile 只处理**声明了 `dsh.bundle` 的 `dependencies`**。子插件包自 2026-09-10 起**不再声明 `dsh.bundle`**、也不再有包自带 `cordis.patch.yml`，所以任何路径都不会把它们拉进 `dsh.profile.bundles`；`devDependencies` 随之成为一个**约定**：语义上「本地开发活链接」不是运行时依赖，并让 `dsh.profile.bundles` 只列真正提供 profile 层的包（管理器自己）。子插件只是**被解析的包**，激活行由管理器统一维护，同时保留 `link:` 活链接。

> 历史原因（保留以免误改回去）：2026-09-10 之前子插件包各自声明 `dsh.bundle`，于是 `dsh plugin --profile web add <子插件目录>` 会把它们塞进 `bundles`，包自带 patch 与管理器行**同 id 各插一次** → `dsh web` 启动失败 `duplicate loader entry id`。摘掉声明后这条崩溃路径被结构性消除。

> pnpm 陷阱备忘（已实测验证，勿改回）：
> - pnpm **不会**安装「仓外 link 包」声明的嵌套依赖，所以管理器不能靠自己的 dependencies 传递安装子插件——子插件由管理器把 `link:` 直接写进 profile 的 devDependencies 再 `pnpm install`。
> - `file:` 依赖跨盘（profile 在 C:、仓库在 D:）是**拷贝**不是硬链接，本地热改失效。
> - 因此「唯一 bundle 层 + devDependencies 活链接 + profile patch 激活行」是实测可行形态。

### ⚠️ 这两条 `dsh plugin` 命令不要用（2026-09-10 起）

| 不要做 | 实际发生什么 |
|---|---|
| `dsh plugin --profile web add <子插件目录>` | 子插件包已不声明 `dsh.bundle`，于是只把它装成 profile 的**普通依赖**并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告：**不进 bundles、也不会激活它**。激活请用面板开关（管理器会把它改写成 `devDependencies` 的 `link:` 并写入激活行）。 |
| `dsh plugin --profile web remove <子插件包名>` | 只摘依赖、**不删管理器写的激活行** → 留下指向不存在包的悬空行，下次 `dsh web` 启动失败：`failed to import loader entry <rowId> (<pkg>): Cannot find package …`（实测 exit 1）。卸载请用面板「移除」。 |

> 上表只针对**子插件目录**。`dsh plugin --profile web add <仓库根>` 与 `add git+https://…/dsh-plugins.git` 都是**允许且推荐**的（装的是管理器本身，见「安装」）；`remove dsh-plugin-manager` 也是卸载管理器的正确命令（会一并从 `dsh.profile.bundles` 摘掉该层）。

证据与逐条实测：`openspec/changes/archive/2026-09-10-retire-local-plugin-bundle-install/design.md`；git/路径两种安装入口的实测：`openspec/changes/archive/2026-09-11-install-via-git-url/design.md`。

## 新增一个插件到本仓库

1. 在 `sub-plugins/` 下建 `dsh-xxx/`（`package.json` 含 `dsh.client`、`exports["./client"]`、`main`、README/ACCEPTANCE；**不要**声明 `dsh.bundle`、**不要**放包自带 `cordis.patch.yml` —— 激活行由管理器写）。管理器也接受仓库根的旧扁平位置。
2. 管理器**自动扫描**到它（`sub-plugins/dsh-*` 与仓库根 `dsh-*` 的并集），在设置「本地插件」里点启用即完成安装+激活——**无需**再改 profile 或本 README 的清单。

## 仓库根：管理器的安装外壳（不是聚合伞包）

根 `package.json` 现在是**管理器的安装外壳**：与包内清单同名（`dsh-plugin-manager`）、`private: true`、不声明任何依赖、不列 `dsh.profile.bundles`，只把 `main`/`exports["."]`/`exports["./client"]` 转发到 `dsh-plugin-manager/src/*`，并让 `dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`（激活行的唯一真相源，只插管理器自己那一行）。它的唯一作用：让「装这个仓库」= 「装管理器」。仓库根**仍然没有** `cordis.patch.yml`，子插件的激活行仍然只由管理器写；一旦有人往外壳里加子插件依赖/激活行，`dsh-plugin-manager/test/root-install-shell.test.mjs` 直接判红。

**聚合伞包 `dsh-local-plugins` 仍然已删除**（旧的根 `package.json` + 根 `cordis.patch.yml`：2026-09-09 起只标 DEPRECATED，2026-09-10 物理删除）。删除理由：那个包插入的 5 个 row id 与管理器维护的行**完全相同** → 谁再装一次就 `duplicate loader entry id` 启动失败。旧文档里「伞包只装一次装全部、根 `cordis.patch.yml` 是唯一激活清单」的模型彻底作废；要查历史内容用 git 历史（`git log -- package.json cordis.patch.yml`）。

- 若某个 profile 的 `dsh.profile.bundles` 里仍列着 `dsh-local-plugins`：该条目现在**不可解析**，这个 profile 启动会报 `cannot resolve profile bundle "dsh-local-plugins"`；修法是手工从该 profile 的 `package.json` 摘掉它（管理器救不了——启动已经失败）。
- 历史迁移备份（2026-09-06 伞包实验）：`~/.dsh/profiles/web/package.json.bak-2026-09-06-umbrella`、`pnpm-lock.yaml.bak-2026-09-06-umbrella`（回滚 = 还原备份后 `dsh plugin --profile web install`）。

## 各插件速览

| 插件 | 作用 |
|---|---|
| `dsh-plugin-manager` | **本地插件管理器**（先装它）——设置「本地插件」面板管理仓库内全部 `dsh-*`（逐个开关 + **全部开启/全部关闭**批量 + 一键迁移） |
| `dsh-session-title-regenerate` | 会话标题「重新生成标题」（最低推理档摘要） |
| `dsh-session-time-bucket` | 侧栏会话按时间桶分组（今天/昨天/…） |
| `dsh-composer-history-recall` | 输入框 `↑`/`↓` 召回自己发过的消息 |
| `dsh-composer-provider-label` | composer 显示模型 provider 标签 |
| `dsh-esc-rewind` | Esc 停止 / Esc·Esc 回退重来 / `/rewind`，可选删除模式 |
| `dsh-open-session-workdir` | 会话头「打开工作目录」 |

## 其他

- 开发规则与知识库入口见 `AGENTS.md`；可复用结论沉淀在 `docs/knowledge/`。
- 仓库级忽略规则见 `.gitignore`（`.vscode/`、`.serena/`、`node_modules/` 不入库）。
