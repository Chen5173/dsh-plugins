## Why

子插件包与仓库级文件（`docs/`、`openspec/`、`.agents/`、根 README/AGENTS）平铺在同一层，根目录已有 7 个 `dsh-*` 目录，每加一个插件就继续挤占根目录。管理器的扫描与链接路径又把「仓库根」当成「插件根」硬编码：`listRepoPluginDirs` 只做单层 `readdirSync(repoRoot)`，`readPluginMeta`/`planMigration` 用 `path.join(repoRoot, dir)` 拼 `link:` —— 所以「插件放哪一层」目前不可选择。

DSH 的解析链路本身与层级无关：Loader 行只认**包名**，profile 用 `devDependencies` 的 `link:` 绝对路径解析到包目录，浏览器半经 `exports["./client"]` + `dsh.client` 投递。因此「子插件放哪一层」纯粹是本仓库的自选布局，改它不需要动核心。

## What Changes

- 子插件源码收拢到仓库根的 `sub-plugins/`；`dsh-plugin-manager` **自身留在仓库根**（它仍是唯一本地 bundle）。
- 把「仓库根」与「子插件根」拆成两个概念：新增 `PLUGINS_DIRNAME='sub-plugins'`、`pluginRootsOf(repoRoot)`（优先 `sub-plugins/`，回退仓库根，仅当嵌套目录存在时返回两根）、`pluginAbsDirOf(repoRoot, dir)`；扫描改为**双根并集**（按目录名去重、嵌套优先），`link:` 一律指向插件**实际所在**目录。
- 双根并集让迁移可按任意顺序完成、半迁移状态可用，且目录移动可回滚（把目录移回即可）。
- 启用路径自愈陈旧链接：新增 `staleLinkSpec(manifest, meta)` 检测 devDependency 的 `link:` 是否仍指向当前目录；`ensureDevDep` 在启用时顺带修复，而不是信任旧路径。
- 面板文案与头部显示改为「子插件目录（sub-plugins/）」（新增 `pluginsRoot` 字段；与仓库根不同时才显示）。
- 激活行 id 保持稳定（= 目录名去 `dsh-` 前缀，与层级无关），因此本变更**不改变任何既有激活状态**，profile 的既有覆盖/停用继续有效。

## Capabilities

### Modified Capabilities

- `plugin-manager`：扫描根从「仓库根」泛化为「子插件根（`sub-plugins/`）+ 旧扁平根」的并集；启用时修复陈旧 `link:`。

## Non-goals

- 不让根伞包 `dsh-local-plugins` 复活（它仍为 DEPRECATED，根 `cordis.patch.yml` 的 5 行旧 id 与本模型的行 id 冲突，启用即 `duplicate loader entry id`）。
- 不移动 `dsh-plugin-manager` 自身、不改它的 bundle 身份与行 id。
- 不改 DSH 核心、不新增运行时依赖、不改任何子插件的业务逻辑。

## Success Criteria

- `node dsh-plugin-manager/test/host-core.test.mjs` 与 `bundle.test.mjs` 全绿（含新增的嵌套布局/双根/链接修复用例）。
- 7 个子包原有测试全绿（无回归）。
- 迁移后 6 个子插件的行 id 与激活集合不变；`cd ~/.dsh/profiles/web && node --input-type=module -e "await import('dsh-<pkg>')"` 全部成功。