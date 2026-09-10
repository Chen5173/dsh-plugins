# dsh-plugin-manager

**本地插件管理器**：只安装这一个 bundle，就能在 DSH Web 设置页的「本地插件」面板里，管理本仓库（`dsh-plugins` monorepo）内的**全部 `dsh-*` 子插件**（`sub-plugins/` 与仓库根两个扫描根的并集）——查看激活状态、开关（激活/停用）、移除、以及把旧的「逐个 `dsh plugin add` + dependencies/bundles」布局**一键迁移**到管理器模型。

它取代了仓库根的聚合伞包 `dsh-local-plugins`（**2026-09-10 已物理删除**，含根 `package.json` 与根 `cordis.patch.yml`）与「每加一个插件就手工 `dsh plugin add`、改两处清单」的流程。子插件包自同日起也**不再声明 `dsh.bundle`**、不再带包自带 `cordis.patch.yml` —— 安装路径只有「管理器面板」一条（原因见下）。

## 安装（一次）

```bash
dsh plugin --profile web add C:/WorkProject/GithubProjects/ChenSir5173/dsh-plugins/dsh-plugin-manager
# 或相对路径：
dsh plugin --profile web add ./dsh-plugin-manager
```

然后**重启 `dsh web`**（新 bundle 层在启动时装载），打开设置页 → 左侧出现「本地插件」入口。

> 安装后首次使用：如果面板顶部提示「仍以旧布局安装」，点 **一键接管/迁移** —— 它会备份 profile 的 `package.json` 与 `cordis.patch.yml`，把本地子插件从 `dependencies`/`dsh.profile.bundles` 收敛为 `devDependencies` + 管理器维护的激活行，迁移前后你的插件激活集合不变。

## 管理模型（为什么“只装一个”就够）

| 概念 | 位置 | 说明 |
|---|---|---|
| 唯一本地 bundle | profile `dsh.profile.bundles` | 只保留 `dsh-plugin-manager` 一个本地条目 |
| 子插件可解析 | profile `devDependencies`（`link:` 到 `sub-plugins/<子包>` 的绝对路径） | pnpm 安装后从 profile `node_modules` 解析；子插件包**不声明 `dsh.bundle`**（2026-09-10 起），所以 `dsh plugin` 的 reconcile 在任何路径下都**不会**把它们塞进 bundles |
| 激活清单（真相源） | profile `cordis.patch.yml` 中由管理器维护的稳定 id 行 | `- insert: [{ id: <rowId>, name: '<pkg>' }]`，停用=行内 `disabled: true`；该文件被 DSH 的 patch HMR **实时热重载**，宿主行为即时启停 |
| 面板 | 设置页一级入口「本地插件」（`settings.section`，order 16） | 行 = 状态点 + 包名/目录 + 描述 + 主开关 + 移除；顶部 = 仓库路径 / 子插件目录 / 目标 profile / 刷新 / 一键迁移 |

- **启用**：自动补 `devDependencies` 的 `link:`（必要时跑 `pnpm install`）→ 写激活行 → 实时生效。
- **停用**：行保留、写 `disabled: true` → 实时停止宿主行为。
- **移除**：删激活行 + 从 `devDependencies` 摘除该 `link:`（仓库里的源码目录**保留**，随时可再启用）。
- **生效提示**：带浏览器界面的子插件，其客户端 UI 只在**页面刷新**后进/出 `__DSH_BOOT__` 引导图——开关后宿主侧即时变化，面板会提示「刷新页面使界面生效」并提供刷新按钮，**不会自动刷新**。

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

`/__dsh-plugin-manager/status`（诊断）、`/list`（列表+状态）、`/set-enabled`、`/remove`、`/migrate`。JSON in/out；错误带 `error` 文案与 4xx/5xx。

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
```

真机验收项（需浏览器与真实 profile）见 `ACCEPTANCE.md`。
