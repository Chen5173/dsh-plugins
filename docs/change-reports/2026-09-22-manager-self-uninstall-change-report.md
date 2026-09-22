# dsh-plugin-manager 变更报告：自包含一键卸载（含全部子插件）

日期：2026-09-22 · OpenSpec 变更：`openspec/changes/2026-09-22-manager-self-uninstall` · 形态：变体 2（脚本自包含）+ 面板「复制卸载命令」

## 1. 需求与约束

- 用户诉求：**在删管理器时把子插件一起清掉**（而不是留一堆悬空行）。
- 已核实的硬约束：核心 `dsh plugin remove` 是 pnpm 薄转发 + 只对账 `dsh.profile.bundles`（`apps/cli/src/plugin.ts`），**不认识** `cordis.patch.yml` 的激活行、**不动**子插件 `link:` 键，且核心**没有卸载钩子** ⇒ 「跑官方命令就自动连带清理」在当前核心下不可能。
- 用户拍板：**变体 2 = 脚本自包含**（自己摘管理器依赖键与 bundles 条目、自己跑一次 pnpm），交付物 A（脚本）+ B（面板复制命令）。

## 2. 修改摘要

| 文件 | 内容 |
|---|---|
| `dsh-plugin-manager/tools/uninstall-manager.mjs`（新增） | `planUninstall()`（只读算出将删内容：受管行 / 指向本仓库的 `link:` 键 / 管理器依赖键 / `dsh.profile.bundles` 条目）+ `runUninstall()`（备份两份 `*.bak-<ts>` → 各写一次 → 一次 `pnpm install`；失败给 `pnpm install --dir` 收尾命令）+ CLI（`--profile/--dry-run/--yes/--pnpm-cmd`，**默认干跑**）+ `insideRoots()`（win32/darwin 大小写不敏感、分隔符归一） |
| `src/index.js` | `/list` 增只读 `uninstall: { command, willRemove }`（命令按当前 profile 与脚本实际路径拼、带显式 `--yes`；预览由快照计算） |
| `src/client.js` | 面板新增「卸载管理器（含全部子插件）」块：将删计数 + 命令文本 + 「复制卸载命令」按钮（剪贴板不可用降级为手动复制），**只复制不执行** |
| `test/uninstall.test.mjs`（新增） | 不变量：恰好一次 patch 写 / 一次 manifest 写 / 一次 install；两份备份存在；受管行与链接清空；管理器键与 bundles 条目消失；**其它插件的行/键/条目逐字节不变**；源码目录仍在；第二次 noop；干跑零写入；安装失败报错 + 收尾命令 |
| `test/debounce.test.mjs` / `test/bundle.test.mjs` | `/list` 字段形状断言；面板块的渲染、复制内容与降级提示断言 |
| `README.md` | 「卸载 / 回滚」重写：两种装法对照表 + 一键命令 + 「核心 CLI 帮不了你」的说明 + 失败降级 |
| `ACCEPTANCE.md` | 新增 A15（自动化证据 + 三条真机项） |
| 知识库 | `2026-09-11-install-via-git-url.md` 补记 + 索引行 |

## 3. 验证证据

| 项 | 结果 |
|---|---|
| 管理器 6 支套件（含新增 `uninstall.test.mjs`） | **全部 PASS** |
| 红绿：脚本移开 + `src/index.js`/`src/client.js` 还原 `HEAD` | `uninstall.test` 报 3 处模块找不到、`debounce.test` `TypeError`、`bundle.test` 3 条红 → 恢复实现后全绿 |
| 全仓 sweep（子插件全部）+ `node --check` | 全绿 |
| `openspec validate 2026-09-22-manager-self-uninstall` | valid（4/4 artifacts） |

## 4. 边界与遗留

- **不自动执行**：面板只复制命令；卸载必须由用户在终端跑（破坏性 + 需要 pnpm）。
- **不删源码目录**：只删 profile 里的键与行；快照目录由 pnpm 自己删。
- **自持一小块核心语义**：摘 `dsh-plugin-manager` 依赖键 + 去其 bundles 条目（与 `reconcilePlugins` 等价）；核心若换载体，表现为启动报管理器包找不到，可见可修。
- **真机验收待用户执行**：ACCEPTANCE A15 的三条 `[B]`。
- **实施中的一次事故（记录在案）**：红绿验证时把 `/tmp` 里的旧快照（上一变更的版本）当作"当前实现"恢复，覆盖掉了本轮的 `index.js`/`client.js` 改动；已按原样重新应用并用 6 支套件复验通过——今后红绿脚本必须先备份"当前"文件再回退。
