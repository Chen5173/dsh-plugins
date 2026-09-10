## Context

动机见 `proposal.md - Why`；行为契约见 `specs/plugin-manager/spec.md`。这里只记录塑造方案的事实与决策。

**现状证据（本变更全部基于实测/读码）**

| 事实 | 位置 |
| --- | --- |
| 扫描是单层扁平：`fs.readdirSync(repoRoot)` 取直接子目录中的 `dsh-*`，排除 `MANAGER_DIR` | `src/host-core.js` `listRepoPluginDirs` |
| 插件绝对目录 = `path.join(repoRoot, dir)`，`link:` 由它拼出 | `readPluginMeta` / `planMigration` |
| `REPO_ROOT = path.resolve(<pkg>/src, '..', '..')` | `src/index.js` |
| 行 id = 目录名去 `dsh-` 前缀，**与目录层级无关** | `rowIdOfDir` |
| Loader 行只认包名；profile 以 `devDependencies` 的 `link:` 绝对路径解析包；浏览器半经 `exports["./client"]` + `dsh.client` 投递 | profile 实况 + 既有结论 |
| 行 id 全局唯一：重复 → `duplicate loader entry id` 拒绝整次刷新 | 既有结论（docs/knowledge） |
| 根伞包 `cordis.patch.yml` 的 5 个旧 id 与 profile 中管理器维护的 5 行同 id | 根 `cordis.patch.yml` vs profile `cordis.patch.yml` |

## Decisions

**D1 双根并集，而不是「只扫 sub-plugins/」**：`pluginRootsOf` 在 `sub-plugins/` 存在时返回 `[<repo>/sub-plugins, <repo>]`，扫描取并集并按目录名去重。理由：迁移期「部分已移动」是常态，双根让代码先落地、目录后移动（或反之）都安全，且回滚只需把目录移回。代价：仓库根若残留同名 `dsh-*` 目录，以嵌套副本为准（D2），面板不会出现重复行。

**D2 嵌套优先**：`pluginAbsDirOf` 按 `pluginRootsOf` 顺序取第一个存在的目录 → `link:` 与 `dirPath` 一律指向嵌套副本，避免把根目录残留当成活插件。

**D3 行 id 不随层级变化 → 迁移零激活变更**：`rowIdOfDir` 只看目录名。这是本变更可以「只换层级、不动 profile 行」的关键依据，也是选择该方案而不是改名的原因。

**D4 链接修复放在启用路径，不新增 UI/端点**：`staleLinkSpec` 是纯函数；`ensureDevDep` 在 devDep 已存在但 `link:` 指向旧目录时走既有的「备份 → 改写 devDependencies → `pnpm install` → 失败回滚」路径。用户无需新按钮：开关一次即自愈（这也是把「计划中的 /relink 端点 + 面板按钮」缩减掉的原因，见 R3）。

**D5 不移动管理器自身**：管理器留在仓库根，`REPO_ROOT` 推导不变；`sub-plugins/` 只是它的扫描对象。把管理器移到仓库根（安装路径变成仓库根）是另一个变更，本变更不做。

## Risks / Trade-offs

- **R1 `pnpm install` 失败**：迁移必须重新链接 6 个 devDependency，失败会让这些包在 profile 中解析不到。缓解：迁移前备份 profile `package.json`（`*.bak-<ts>`），失败回滚备份；双根扫描保证目录层面可回滚。
- **R2 重启窗口**：宿主半代码改动只在 `dsh web` 重启后生效；在「目录已移动 + 未重启」的窗口内，旧代码扫不到子插件，面板会显示为空（插件本身仍正常加载）。缓解：迁移后提示重启。
- **R3 计划缩减**：proposal 最初计划新增 `POST /relink` 端点与面板「修复链接」按钮；实现时改为「启用即自愈」，因为后者复用既有 UI 与既有回滚路径，且不需要用户理解新概念。端点/按钮留待确有批量修复需求时再加。
- **R4 其它工具假设扁平布局**：若有第三方工具硬编码 `<repo>/dsh-*`，会失效。缓解：迁移后抽查 profile `node_modules` 内是否出现该路径假设。