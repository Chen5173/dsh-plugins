## Why

「删掉管理器」目前**没有干净路径**，而且按本机实际装法后果更糟：

- 核心 `dsh plugin --profile web remove dsh-plugin-manager` 是一只 **pnpm 薄转发 + 只对账 `dsh.profile.bundles`**（`apps/cli/src/plugin.ts`：`pnpm remove` → `reconcilePlugins`）。它**不认识** `cordis.patch.yml` 里由管理器写下的子插件激活行，也**不会**碰子插件的 `link:` 依赖键——那是另外一批依赖。核心也**没有任何卸载钩子**（全仓 grep 无 `uninstall`/`preRemove`/`postRemove` 约定），所以"跑官方 remove 时让管理器自己清理"在现有核心下没有插入点。
- 结果是**悬空行 + 死链**：下次 `dsh web` 启动报 `failed to import loader entry <id> …: Cannot find package …`（本仓已实测记录在案）；`link:` 目标消失后下一次 `pnpm install` 也可能直接失败。
- 本机（2026-09-22 核对）是 **git 快照装法**：`dsh-plugin-manager: github:Chen5173/dsh-plugins`，7 个子插件的 `link:` 全部指向 `node_modules/dsh-plugin-manager/sub-plugins/<name>` ⇒ 删管理器会把这 7 个子插件的**代码一起带走**（它们在快照里），却把行与键留在 profile 里。
- `dsh-plugin-manager/README.md` 的「卸载 / 回滚」写着"卸载管理器后，已迁移的子插件按现状继续工作"——这句话**只对另一种装法成立**（子插件 `link:` 指向独立的开发 checkout）。git 快照装法下不成立，文档需要修正。

于是需要一条**自包含的一键卸载**：不依赖 DSH 宿主、不依赖 `dsh` CLI，把子插件痕迹与管理器自身一起清掉。

## What Changes

- **新增自包含卸载脚本** `dsh-plugin-manager/tools/uninstall-manager.mjs`（随包分发，git 装法下随快照到位）：解析 profile → 算出将删除的内容（受管子插件的激活行 + 指向本仓库 `sub-plugins/` 的 `link:` 键 + 管理器自身依赖键 + `dsh.profile.bundles` 里的管理器条目）→ **各留一份 `*.bak-<ts>` 备份** → **各写一次**文件 → 跑**一次** `pnpm install`。全程**不删任何源码目录**；支持 `--dry-run`（只打印将删除什么）与逐项结果输出；无可删项时 `noop`（幂等）。
- **新增面板「复制卸载命令」**：管理器面板给出按当前 profile 拼好的那条命令（git 装法的路径是 `node_modules/dsh-plugin-manager/dsh-plugin-manager/tools/…` 双层，手打易错），并在复制前展示**将删除什么**（行数、依赖键数、是否会跑安装）；只复制、**不自动执行**（卸载是破坏性动作，必须由用户在终端亲自跑）。
- **降级**：Windows 上 pnpm 删「脚本自己所在目录」可能 EBUSY/EPERM ⇒ 脚本捕获后打印"重跑一次 `pnpm install`"的收尾命令（此时行与键已清干净，**不留半态**）。
- **文档修正**：README「卸载 / 回滚」区分两种装法（git 快照 vs 开发 checkout），并指向这条一键命令；ACCEPTANCE 新增人工项（真机跑一次卸载 → 启动无 `Cannot find package`）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `plugin-manager`：新增「自包含的一键卸载命令」「面板提供复制卸载命令且不自动执行」「卸载后 profile 可自证干净」三条要求。

## Impact

- 代码：新增 `dsh-plugin-manager/tools/uninstall-manager.mjs`（复用 `src/host-core.js` 的纯逻辑与 `makeYamlEngine`；profile 的 js-yaml 经 `createRequire(profile/package.json)` 解析，与宿主半同一约定）；`src/client.js` 面板新增复制按钮 + 将删清单；`src/index.js` 只读暴露"将删除什么"（复用现有 `/list` 数据面即可，必要时加一个只读端点）。
- 测试：新增 `dsh-plugin-manager/test/uninstall.test.mjs`（临时 `DSH_HOME` + pnpm 桩 + 真 profile 夹具）锁住不变量：**恰好一次** patch 写 + **恰好一次** manifest 写 + **恰好一次** install；`*.bak-<ts>` 存在；受管行与链接清空；管理器依赖键与 bundles 条目消失；**其它插件的行/键逐字节不变**；源码目录仍在；重复跑是 `noop`；pnpm 失败时双回滚。`bundle.test.mjs` 覆盖复制按钮。
- 风险：脚本自持"摘 `dsh-plugin-manager` 依赖键 + 移除其在 `dsh.profile.bundles` 的条目"这一小块核心 reconcile 语义（核心若换载体，脚本要跟进；届时表现为启动报管理器包找不到，**可见可修**）；删自身所在目录的平台差异（已设计降级）。
- 非目标：不做 `--via-cli`（调用官方 remove 收尾）开关；不在此变更里提交上游卸载钩子建议（用户未选）；不删任何源码目录。
