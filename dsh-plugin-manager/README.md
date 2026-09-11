# dsh-plugin-manager

**本地插件管理器**：只安装这一个 bundle，就能在 DSH Web 设置页的「本地插件」面板里，管理本仓库（`dsh-plugins` monorepo）内的**全部 `dsh-*` 子插件**（`sub-plugins/` 与仓库根两个扫描根的并集）——查看激活状态、逐个或**一键批量**开关（激活/停用）、移除、以及把旧的「逐个 `dsh plugin add` + dependencies/bundles」布局**一键迁移**到管理器模型。

它取代了仓库根的聚合伞包 `dsh-local-plugins`（**2026-09-10 已物理删除**，含旧的根清单与聚合 `cordis.patch.yml`）与「每加一个插件就手工 `dsh plugin add`、改两处清单」的流程；仓库根现在只有**本管理器的安装外壳**（同名转发，见「安装」）。子插件包自同日起也**不再声明 `dsh.bundle`**、不再带包自带 `cordis.patch.yml` —— 安装路径只有「管理器面板」一条（原因见下）。

## 安装（一次）

仓库本身就是 git 仓库，根 `package.json` 是本管理器的「安装外壳」，因此可以直接用 git 地址装：

```bash
# 从 git 装（对方不必先 clone）：装完插件名就是 dsh-plugin-manager
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
# 等价简写 / 锁版本：github:Chen5173/dsh-plugins 、 …dsh-plugins.git#<tag|commit|branch>

# 本机开发（改代码即时生效）：装仓库根或本包目录
dsh plugin --profile web add D:/ChenSirDocument/Dsh-Projects/dsh-plugins
dsh plugin --profile web add ./dsh-plugin-manager
```

以上写法**完全等价**：都让 `dsh-plugin-manager` 进入 profile `dependencies` 与 `dsh.profile.bundles`，激活行 id 相同，从一个换成另一个只改写同一个依赖键，不产生第二个 bundle 层或第二行（隔离 profile + 本地 git remote 实测）。

> **git 入口靠的就是那个外壳**：`dsh plugin` 把 `pnpm add <git 地址>` 转发一遍，pnpm 会 clone 整个仓库并把**根目录当作包**，所以包名取自根清单的 `name`。实测删掉根 `package.json` 后，装出来的依赖键退化成仓库目录名（`dsh-plugins.git`），且因没有 `dsh.bundle` 被 reconcile 判成普通依赖，打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 并且永不激活。外壳因此 MUST 同名、MUST 转发 `dsh.bundle.patch`，且 MUST NOT 加 `files` 白名单（会把 `sub-plugins/` 裁掉）。约束由 `test/root-install-shell.test.mjs` 强制。

> **git 装来的是快照**：profile 内是 clone 副本，改仓库源码不即时生效，升级走 `dsh plugin --profile web update`。管理器会把这个 clone 当作它的仓库根，照常扫到 `sub-plugins/` 里的全部子插件；在面板启用某个子插件时，写入的 `link:` 指向 clone 内的 `node_modules/dsh-plugin-manager/sub-plugins/<pkg>`（实测可被 profile 解析、`dsh web` 正常启动）。要热改子插件源码，就改用本地路径入口安装。

> 为什么根清单要与本包**同名**：包名就是插件身份 —— profile `dependencies` 键、bundle 层名、激活行 id、浏览器模块表 id 都是它。客户端产物里 `window.__ModuleLoader__.load({ id: 'dsh-plugin-manager' })` 是写死的，而 DSH 的客户端模块系统按「离行入口文件最近的、名字等于该行 specifier 的 manifest」定位包，所以外壳必须同名、且同时转发 `main`/`exports["./client"]`/`dsh.bundle.patch` 到本包。源码、测试、patch、README/ACCEPTANCE 都在 `dsh-plugin-manager/`，外壳不含被复制的代码。

然后**重启 `dsh web`**（新 bundle 层在启动时装载），打开设置页 → 左侧出现「本地插件」入口。

> 安装后首次使用：如果面板顶部提示「仍以旧布局安装」，点 **一键接管/迁移** —— 它会备份 profile 的 `package.json` 与 `cordis.patch.yml`，把本地子插件从 `dependencies`/`dsh.profile.bundles` 收敛为 `devDependencies` + 管理器维护的激活行，迁移前后你的插件激活集合不变。

## 管理模型（为什么“只装一个”就够）

| 概念 | 位置 | 说明 |
|---|---|---|
| 唯一本地 bundle | profile `dsh.profile.bundles` | 只保留 `dsh-plugin-manager` 一个本地条目 |
| 子插件可解析 | profile `devDependencies`（`link:` 到 `sub-plugins/<子包>` 的绝对路径） | pnpm 安装后从 profile `node_modules` 解析；子插件包**不声明 `dsh.bundle`**（2026-09-10 起），所以 `dsh plugin` 的 reconcile 在任何路径下都**不会**把它们塞进 bundles |
| 激活清单（真相源） | profile `cordis.patch.yml` 中由管理器维护的稳定 id 行 | `- insert: [{ id: <rowId>, name: '<pkg>' }]`，停用=行内 `disabled: true`；该文件被 DSH 的 patch HMR **实时热重载**，宿主行为即时启停 |
| 面板 | 设置页一级入口「本地插件」（`settings.section`，order 16） | 行 = 状态点 + 包名/目录 + 描述 + 主开关 + 移除；顶部 = 仓库路径 / 子插件目录 / 目标 profile / **全部开启·全部关闭** / 刷新 / 一键迁移 |

- **启用**：自动补 `devDependencies` 的 `link:`（必要时跑 `pnpm install`）→ 写激活行 → 实时生效。
- **停用**：行保留、写 `disabled: true` → 实时停止宿主行为。
- **移除**：删激活行 + 从 `devDependencies` 摘除该 `link:`（仓库里的源码目录**保留**，随时可再启用）。
- **生效提示**：带浏览器界面的子插件，其客户端 UI 只在**页面刷新**后进/出 `__DSH_BOOT__` 引导图——开关后宿主侧即时变化，面板会提示「刷新页面使界面生效」并提供刷新按钮，**不会自动刷新**。
- **批量开关**：顶部「全部开启 (N)」/「全部关闭 (N)」，N = 这一步真能改动的子插件数（N=0 时置灰）。

## 批量开关（全部开启 / 全部关闭）

- **作用范围**：只作用于面板列出的受管仓库子插件，**排除管理器自身**；profile 激活清单里其它插件的行（`mcp-*`、`dsh-liquid-glass` …）一行都不碰。
- **谁能被批量动**：
  - 全部开启 = `已停用`（去掉行内 `disabled`）+ `未安装`（补 `link:` devDependency、装依赖、写激活行）；
  - 全部关闭 = `已激活`（写 `disabled: true`，**保留行与依赖**，随时可再开）；
  - `未激活(仅依赖)`、`旧布局`、`非插件目录` 一律**跳过**（前两类不凭空写行；旧布局请先「一键接管/迁移」，面板会在确认框与结果里点明跳过了几个）。
- **一次点击 = 一次落盘 + 一次安装**：批量把所有目标（以及仍在 400 ms 合并窗口里的单行点击意图）合并成**一次** `cordis.patch.yml` 写入——即一次核心配置重应用，而不是 N 次；需要为多个未安装子插件补依赖时，先一次写齐全部 `link:` 再跑**一次** `pnpm install`。
- **失败逐项回报**：尽力而为——安装失败只让「未安装」那部分失败（原因可见、状态不变、可重试），已安装项的开关照常生效；失败项在面板提示条里逐条列出。
- **执行期锁定**：批量进行中（可能正在装依赖）每行的开关/移除与「一键接管/迁移」都禁用并显示「处理中…」，完成后解锁并提示是否要刷新页面。
- **不做**：没有撤销按钮（再点另一个按钮即可恢复，但「4 开 2 停」这类混合状态不会被精确还原）、没有「全部移除」、不做旧布局的自动迁移。

## 目录布局（\`sub-plugins/\`）

- 子插件源码放在仓库根的 **\`sub-plugins/\`** 下；\`dsh-plugin-manager\` 自身留在仓库根（它仍是唯一本地 bundle）。
- 管理器扫描**两个根**并取并集：\`<仓库>/sub-plugins\`（存在时）与 \`<仓库>\`（旧扁平布局）；同名目录只出一行，以 \`sub-plugins/\` 下的副本为准。因此迁移可以「先改代码再移动目录」或反之，半迁移状态同样可用，把目录移回即可回滚。
- \`link:\` 一律指向子插件**实际所在**目录：启用某子插件时若发现 devDependency 指向旧目录（如移动前的仓库根路径），会改写为当前目录并重新安装（自愈），而不是信任旧路径。
- 子插件包**不声明 `dsh.bundle`**、目录内**没有**包自带 `cordis.patch.yml`（2026-09-10 起）：激活行由管理器写。若包自带 bundle 层，一次 `dsh plugin --profile web add <子插件目录>` 就会把它塞进 `dsh.profile.bundles`，包自带 patch 与管理器行**同 id 各插一次** → `dsh web` 启动失败 `duplicate loader entry id: <rowId>`（已实测）。

## 子插件行 id（稳定）

= 目录名去掉 `dsh-` 前缀（与该子插件曾作为独立 bundle 安装时用的 id 一致），例如 `dsh-session-time-bucket` → `session-time-bucket`。稳定 id 保证既有 profile 覆盖、重装与回滚都能继续定位。

## 宿主半能力与副作用（读前知悉）

- 运行在 `dsh web` 进程内（非沙箱 Node）。会**读写 profile 文件**并**执行 `pnpm`**：每次改动前对 `package.json` / `cordis.patch.yml` 生成时间戳备份 `*.bak-<ts>`，失败自动回滚。
- YAML 用 profile 自带（顶层已装）的 `js-yaml`（含 `!!js` 表达式保留 schema），整文件 parse→transform→dump；只改动「行 id ∈ 被管子插件」的条目，`dsh-mcp-manager` 等其它行原样保留。
- 目标 profile：默认取当前运行 profile（`ctx.baseUrl` 探测）；可用行 config 覆盖（`dsh.profile.bundles` 中该插件行的 `config: { profile: '...' }`）。
- 仓库目录：`path.resolve(本插件目录, '..', '..')`（即 `dsh-plugin-manager` 的上一级仓库根）；子插件目录 = 该根下的 `sub-plugins/`（存在时），否则回退仓库根自身。目录被移动/删除时面板给出可读错误。
- **主开关的落盘是合并的（去抖 400 ms）**：每次写入 `cordis.patch.yml` 都会让 DSH 核心重应用整棵配置树，期间宿主事件循环被独占 **0.7–1.2 秒**（实测，见 `docs/knowledge/2026-09-10-toggle-write-batching.md`）。因此 `/set-enabled` 先记「待写意图」并重置 400 ms 去抖定时器，窗口内的多次点击只落盘一次；响应与 `/list` 会叠加待写意图，所以面板立刻显示目标状态，`/status` 的 `pendingWrites` 表示还有多少意图未落盘。
- 合并窗口内若进程被强杀，该次意图会丢失（正常退出走同步尽力落盘）；同一行的重复点击只保留最后一次目标状态。

## HTTP 端点（浏览器面板使用）

`/__dsh-plugin-manager/status`（诊断）、`/list`（列表 + 状态 + 两个批量按钮的 `batchCounts`）、`/set-enabled`、`/set-all-enabled`、`/remove`、`/migrate`。JSON in/out；错误带 `error` 文案与 4xx/5xx。

`POST /set-all-enabled { enabled: boolean }` → `{ ok, data, results, counts, noop?, warning? }`：`results` 逐项给出 `{dir,rowId,name,hasClient,outcome:'applied'|'skipped'|'failed',reason?,error?}`，`counts` 给出 `{total,applied,skipped,failed,installed,ranPnpm,wrotePatch}`；`/status` 的 `lastBatch` 记录最近一次批量结果。

## 回滚 / 卸载

```bash
# 先还原迁移前备份（见面板返回的 backups，或 profile 目录 *.bak-* 文件），再卸载管理器：
dsh plugin --profile web remove dsh-plugin-manager
```

管理器自身不写其它持久数据；卸载后子插件按迁移后状态（devDependencies + 激活行）继续工作，可用任意一个子插件自己的旧方式再接管，或还原备份回到迁移前。

> ⚠️ **卸载子插件不要用 CLI**：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、**不会删管理器写的激活行** → 留下指向不存在包的悬空行，下次 `dsh web` 启动失败（`failed to import loader entry <rowId> (<pkg>): Cannot find package …`，实测 exit 1）。卸载子插件请用面板「移除」；反之 `dsh plugin --profile web add <子插件目录>` 也不会激活它（只装成普通依赖 + 打印 `declares no dsh.bundle` 警告）。

## 版本下限

- 宿主：需要 profile 顶层 `node_modules` 可解析 `js-yaml`（web profile 因 dsh-mcp-manager 已具备）；缺失时会自动 `pnpm add -D js-yaml` 一次。
- 浏览器：需要核心提供 `settings.section` 槽与 `react` 模块字（web profile ≥ 0.1.2-rc.1 均具备）。版本不足时设置入口不出现，静默退化。

## 开发 / 测试

```bash
node dsh-plugin-manager/test/host-core.test.mjs   # 宿主纯逻辑（扫描/行变换/状态/迁移规划/意图合并）
node dsh-plugin-manager/test/bundle.test.mjs      # 客户端注册与面板逻辑（React shim + fetch stub）
node dsh-plugin-manager/test/debounce.test.mjs    # 真 handler + 临时 DSH_HOME：连点只写一次 patch
node dsh-plugin-manager/test/batch-toggle.test.mjs # 真 handler + 临时 DSH_HOME：批量一次落盘 + 一次安装 + 逐项失败回报
node dsh-plugin-manager/test/root-install-shell.test.mjs # 仓库根安装外壳（同名/转发/无依赖/无根 patch/安装后仍可扫描）
```

真机验收项（需浏览器与真实 profile）见 `ACCEPTANCE.md`。
