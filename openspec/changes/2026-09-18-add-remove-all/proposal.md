## Why

现状下每个子插件的「激活」= profile `devDependencies` 里一条 `link:` + profile `cordis.patch.yml` 里一条管理器维护的激活行。管理器写 `link:` 用的是**扫描出来的绝对目录**（`host-core.js` 的 `linkSpecOf`），所以 profile 一旦换机器、换盘符或换 `DSH_HOME`，`devDependencies` 里就留下指向旧绝对路径的死链；而 `deriveStates` 只按**键是否存在**推导状态，面板照旧显示「已激活 / 未激活(仅依赖)」，不给任何提示（2026-09-18 在真实 profile 上核对）。

同一轮核对还发现：单行「开启」只在 devDep 键**不存在**时才写 `link:`（`index.js` 的 `present` 判断直接跳过 `ensureDevDep`），键存在但路径已死时不会重写——`ensureDevDep` 里的 `staleLinkSpec` 因此在单行开关路径上永远不触发。也就是说，用户手上唯一能整体清掉这些陈旧 `link:` 的动作，是逐个点「移除」；子插件一多，既费事又容易漏。

于是需要「全部移除」：一次清空全部受管子插件的激活行与 `link:` 依赖。之后再「开启」走的是「键不存在」那条路径——当前**唯一**能按子插件当前实际目录重写 `link:` 的路径——插件就能在新机器上重新定位。

## What Changes

- 面板工具栏新增第三个批量动作「全部移除 (N)」（破坏性动作，与现有两个批量按钮并列），执行前确认，执行后逐项呈现结果。
- 新增宿主端点 `POST /__dsh-plugin-manager/remove-all`：**一次**删除全部受管激活行 + **一次**改写 profile `package.json` 摘掉这些 `link:` 键 + **一次** `pnpm install`；任一步失败则用操作前备份回滚 `cordis.patch.yml` 与 `package.json`。
- 作用域 = 面板列出的受管子插件中**有痕迹**的那些：已激活、已停用、未激活(仅依赖)。跳过 未激活(未安装)、旧布局、非插件目录；N 只数真正会被改动的项，N = 0 时按钮置灰。
- 与批量开关**语义不同**：仍排在 400 ms 合并窗口里的单行开关意图会被丢弃（这些行本来就要删，先落盘只会白付一次 DSH 核心配置重应用），丢弃条数在响应里如实报告。
- 边界：只摘受管子插件自己的键与行，MUST NOT 触碰 `dsh-plugin-manager` 自身、`dsh.profile.bundles`、以及 `mcp-*` 等其它插件的行。
- 文档：`README.md` 与 `ACCEPTANCE.md`（新增 A13）同步；主 spec 在归档时同步。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `plugin-manager`: 新增一条「批量全部移除」需求（作用范围与计数口径、一次落盘 + 一次安装、丢弃排队意图、失败回滚、以及「移除后重新开启即按当前实际目录重新定位」），并修改既有的「批量操作的面板交互与生效提示」需求，使其从两个批量按钮扩展到三个（确认文案含数量与删除后果、执行期间锁定面板、带界面的子插件被改动后提示刷新）。

## Impact

**改动代码**

- `dsh-plugin-manager/src/host-core.js`：新增纯函数 `removePlan(derived)` 与 `REMOVE_REASONS`
- `dsh-plugin-manager/src/index.js`：新增 `/remove-all` 端点、批量摘依赖的 `dropDevDeps`、批量动作共用的一次性 manifest 改写与回滚
- `dsh-plugin-manager/src/client.js`：第三个批量按钮 + 中英文文案
- `dsh-plugin-manager/test/host-core.test.mjs`、新增 `test/batch-remove-all.test.mjs`（真 handler harness）、`test/bundle.test.mjs`
- `dsh-plugin-manager/README.md`、`dsh-plugin-manager/ACCEPTANCE.md`

**外部交互面（都是既有写入面，不新增文件）**

- 写 profile `package.json`（摘 `dependencies`/`devDependencies` 中的受管键，操作前备份）
- 写 profile `cordis.patch.yml`（删受管行，操作前备份）
- 在 profile 目录执行一次 `pnpm install`

**风险**

- 破坏性动作：批量移除会让正在运行的子插件立刻停止、并删掉它们的 `link:`；靠确认框（含数量与后果文案）+ N 计数 + 逐项结果降低误操作面
- 只摘键不删目录：子插件源码与目录一律保留，可随时重新开启

**不受影响**

- 管理器自身（不在受管集内，不会被移除）、`dsh.profile.bundles`、其它插件（`mcp-*` 等）的行与顺序
- 一键迁移、单个开关/移除、批量开启/关闭的既有行为
- 不新增运行时依赖、不改 DSH 核心
