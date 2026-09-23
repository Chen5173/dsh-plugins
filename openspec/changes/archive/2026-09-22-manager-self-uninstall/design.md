## Context

- **核心 remove 的真实语义**（`apps/cli/src/plugin.ts` 已读）：`pnpm <args...>` 在 profile 目录里转发 + `reconcilePlugins` 只对账 `dsh.profile.bundles`（依赖没了 ⇒ 条目去掉）。它不认识 `cordis.patch.yml` 里管理器写的行，也不动子插件的 `link:` 键；核心**没有任何卸载钩子**（全仓 grep 无 `uninstall`/`preRemove`/`postRemove`）。
- **本机装法**：`dsh-plugin-manager` 是 git 快照（`github:Chen5173/dsh-plugins`），7 个子插件的 `link:` 指向 `node_modules/dsh-plugin-manager/sub-plugins/<name>` ⇒ 删管理器连带带走子插件代码，但行/键留在 profile。
- **可复用的现成件**：`src/host-core.js` 的纯逻辑（`listRepoPluginDirs` / `readPluginMeta` / `linkSpecOf` / `readPatchRows` / `removeManaged` / `makeYamlEngine` / `dshHome` / `profileDirOf` …）与宿主半的"profile 的 js-yaml 经 `createRequire(profile/package.json)` 解析"约定；宿主半的备份命名 `*.bak-<ts>` 与"一次写 = 一次核心配置重应用"的代价认知。
- **测试先例**：宿主半用 `__setPnpmRunner` 注入假 runner 来断言"恰好一次 install"；脚本侧应对齐——把逻辑做成可注入 pnpm 的纯函数，CLI 只是薄壳。

## Goals / Non-Goals

**Goals:** 一条**不依赖 DSH / dsh CLI** 的命令，把「子插件痕迹 + 管理器自身」一次清干净（各一次写、一次 install、写前备份、幂等、不删源码）；面板能复制这条命令并预告将删除什么；文档区分两种装法。

**Non-Goals:** 不 spawn 官方 `dsh plugin remove`（用户已否决 `--via-cli`）；不删任何源码目录；不在面板里提供"点一下就执行卸载"的按钮（破坏性动作必须由用户在终端亲自跑）；不提交上游卸载钩子建议。

## Decisions

**D1 脚本位置** `dsh-plugin-manager/tools/uninstall-manager.mjs`：与包同源，可直接 `import '../src/host-core.js'`；git 装法下随快照到位（路径为 `node_modules/dsh-plugin-manager/dsh-plugin-manager/tools/…`，所以面板要帮用户拼这条命令）。
**D2 结构 = 纯逻辑 + 薄 CLI**：`planUninstall({ profileDir, repoRoot })` 返回将删内容（受管行、指向本仓库 `sub-plugins/` 的 `link:` 键、管理器依赖键、`dsh.profile.bundles` 中的管理器条目）与计数；`runUninstall(plan, { pnpm, dryRun })` 执行备份 + 各一次写 + 一次 install + 逐项结果；CLI 只解析 `--profile/--dry-run/--pnpm-cmd/--yes`。测试直接 import 纯逻辑并注入假 pnpm。
**D3 作用域判定（保守，宁可少删）**：只删 ① `cordis.patch.yml` 中 id 命中**本仓库扫描出的受管子插件**的行；② `package.json` 中**值以 `link:` 开头且解析后落在本仓库 `sub-plugins/`（或本管理器所在克隆的 `sub-plugins/`）内**的键；③ `dsh-plugin-manager` 自身键；④ `dsh.profile.bundles` 中的 `dsh-plugin-manager`。其它行/键/条目**逐字节不动**。
**D4 yaml 引擎**：经 `createRequire(profile/package.json)` 解析 profile 的 `js-yaml`（与宿主半一致）；解析不到时**明确报错并退出**（不猜、不外装依赖）。
**D5 顺序与代价**：备份两份 → 各写一次（patch + manifest）→ 一次 `pnpm install`（cwd = profile）。这与宿主半的批量动作同序，保证"一次动作 = 一次配置重应用"。
**D6 自删目录与降级**：`pnpm install` 会删掉脚本自己所在的快照目录；Node 已把脚本读进内存，通常无碍；失败（Windows EBUSY/EPERM）时**如实报错 + 打印"重跑一次 `pnpm install`"的收尾命令**（此时行与键已清，重跑即收尾，不留半态）。
**D7 幂等**：无可删项 = `noop`（零写入、零安装、退出码 0）。
**D8 命令字符串由宿主半给出**：`/list` 增只读字段 `uninstall: { command, willRemove }`（命令按当前 profile 与脚本实际路径拼、按平台加引号；`willRemove` = 行数/键数/是否会安装/源码目录保留说明）。客户端只渲染 + 复制；剪贴板不可用（`navigator.clipboard` 缺失/被拒）时降级为可选中文本。
**D9 不自动执行**：面板不提供执行按钮；命令必须由用户在终端跑（破坏性 + 需要 pnpm），面板只复制与预告。

## Risks / Trade-offs

- [自持一小块核心 reconcile 语义（摘 `dsh-plugin-manager` 键 + 去 bundles 条目）] → 行为等价且被测试锁住（依赖键消失、bundles 条目消失、恰好一次 install）；核心若换载体，表现为启动报管理器包找不到，**可见可修**，不静默错删。
- [Windows 删自身所在目录] → 已设计降级（报错 + 重跑命令），且清行清键在先，不会半态。
- [长路径/空格/中文路径拼命令] → 命令字符串由宿主按平台加引号生成，测试断言含 profile 名与脚本路径。
- [误删开发 checkout] → 只删 profile 里的**键**，从不删目录；`link:` 指向的开发仓库不受影响（测试断言源码目录仍在）。
- [用户在面板看到命令后改了 profile（换 profile/迁移目录）] → 重新打开/刷新面板即重算；命令里带 `--profile` 与绝对路径，跑错 profile 也只会 `noop`。

## Migration Plan

纯增量：不改变任何现有行为；命令只在用户主动执行时动 profile（写前备份）。回滚 = 用 `*.bak-<ts>` 覆盖回去（或按 README 的步骤重装管理器）。

## Open Questions

- 命令是否也要顺手删掉 profile 里指向本仓库的**空目录残留**（例如 `node_modules/<子插件名>` 的 link 残骸）？当前决定：交给 `pnpm install`（它自己会清），脚本不额外动文件系统。
