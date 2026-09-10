## 1. 提案与设计

- [x] 1.1 `proposal.md`（Why 含三份实测证据 / What Changes / Non-goals / 成功判据）
- [x] 1.2 `design.md`（D1–D5 决策、风险与回滚、已知限制；含 6 变体实测表）
- [x] 1.3 本变更的 spec delta（1 条 ADDED Requirement，4 个场景），`openspec validate retire-local-plugin-bundle-install --strict` → `Change 'retire-local-plugin-bundle-install' is valid`

## 2. 删除退役伞包

- [x] 2.1 删除仓库根 `package.json` 与根 `cordis.patch.yml`（`dsh-local-plugins` 退场）
- [x] 2.2 复核删除安全性：`grep -rl dsh-local-plugins ~/.dsh/profiles/*/package.json ~/.dsh/profiles/web/*.bak-*` → 无命中（4 个 profile + 7 个备份全清白）；仓库根无 `node_modules`；`openspec` 是全局命令（`/c/nvm4w/nodejs/openspec`），不依赖根 package.json
- [x] 2.3 复核仓库内引用面：剩余命中全部是「历史说明 / 规则文案 / 新增变更文档」，加上 `dsh-plugin-manager/src/host-core.js` 的伞包退场分支（保留，对仍把伞包留在依赖清单的 profile 有效）与其测试夹具

## 3. 子插件去 bundle 化

- [x] 3.1 6 个 `sub-plugins/*/package.json`：删除 `dsh.bundle` 字段、`files` 去掉 `cordis.patch.yml`（diff 全部为 4 行删除/包，行尾保持 CRLF）
- [x] 3.2 删除 6 个 `sub-plugins/*/cordis.patch.yml`（包自带 bundle 层）
- [x] 3.3 仓库级断言脚本通过：6 个 manifest `dsh.bundle=false`、目录内无 `cordis.patch.yml`、`files` 不再提及；根 `package.json`/`cordis.patch.yml` 均不存在；管理器自身仍保留 `dsh.bundle=true`（它才是唯一本地 bundle）
- [x] 3.4 `npm pack --dry-run --json` 复核：6 个子插件产物各 5 个文件（`src/client.js`、`src/index.js`、`package.json`、`README.md`、`ACCEPTANCE.md`），无 `cordis.patch.yml`、无 node_modules/openspec 泄漏；管理器的产物**仍含** `cordis.patch.yml`（正确）

## 4. 文档同步

- [x] 4.1 根 `README.md`：安装模型表述改为「不声明 `dsh.bundle`」、新增「⚠️ 这两条 `dsh plugin` 命令不要用」表、「新增一个插件」步骤改成不要声明 `dsh.bundle`、「已退役：聚合伞包」改为「已删除」并给出陈旧 profile 的修法
- [x] 4.2 6 个子插件的 `README.md`：安装/启停/卸载改为管理器面板路径 + 两条 CLI 警示（12/12 文件完成；我逐文件复扫 CLI/伞包/`dsh.bundle` 提及，仅剩警示内的否定句与"装管理器"这一条正确用法）
- [x] 4.3 6 个子插件的 `ACCEPTANCE.md`：作废的 CLI 安装类验收项改为管理器模型验收（含 `bundles` 仍只有管理器的口径、面板关→开后仅一行；`[x]` 历史勾选态与 `[H]`/`[B]` 标记保留）
- [x] 4.4 `dsh-plugin-manager/README.md`（伞包措辞、CLI 陷阱小节、行 id 说明、不需要 `dsh.bundle` 的目录布局条目）与 `ACCEPTANCE.md`（新增 A9 六条）
- [x] 4.5 `docs/knowledge/`：更新 `2026-09-09-dsh-plugin-manager.md`（3 处）与 `2026-09-10-sub-plugins-layout.md`（伞包条目）；新增 `2026-09-10-retire-bundle-install.md`；索引表追加一行
- [x] 4.6 `AGENTS.md` 新增「本地插件包一律不声明 `dsh.bundle`」硬规则 + `.serena/memories/core.md` 同步（gitignored，供后续会话）

## 5. 验证

- [x] 5.1 全量测试通过：10/10（管理器 `bundle`/`debounce`/`host-core` + 6 个子插件 7 个文件），失败数 0
- [x] 5.2 `openspec validate retire-local-plugin-bundle-install --strict` 通过；`openspec validate --all` → **7 passed, 0 failed**（含新 change，无新增失败）
- [x] 5.3 残留引用扫描：`dsh-local-plugins` 命中均为有意保留（历史/规则/变更文档 + 管理器退场分支与夹具）；6 个子插件的源码与 manifest 已无 `dsh.bundle`；12 个子插件文档已无「推荐 CLI 安装/卸载」表述（仅剩警示内否定句与"装管理器"这一条正确用法）
- [x] 5.4 隔离 profile 复现验证（`DSH_HOME` → 临时目录，**未触碰运行中的 web profile**）：
  - `dsh plugin --profile scratchy add <sub-plugins/dsh-esc-rewind>` → 只进 `dependencies`（`link:`），`dsh.profile.bundles` 仍只有 `@deepseek-ai/dsh-base`，打印 `dsh: warning: dsh-esc-rewind declares no dsh.bundle — installed as a plain dependency, not a profile layer`，exit 0
  - 该 scratch profile 启动成功（进程存活，无 `duplicate loader entry id`）
  - 陈旧布局红能力对照：把该包塞回 `bundles` → exit 1，`dsh: profile bundle "dsh-esc-rewind" declares no dsh.bundle in its package.json`（改造前同一构造报 `duplicate loader entry id: esc-rewind`）
  - 管理器接管能力未受影响：`readPluginMeta` 不读 `dsh.bundle`，`ensureDevDep` 会把误装出的 `dependencies` 条目改写为 `devDependencies` 的 `link:`

- [x] 5.5 实机验收（2026-09-10 用户重启 `dsh web` 后）：`GET /list` → 6 个子插件全 `state=active`、`installWhere=devDependencies`、`valid=true`；`legacyDetected=false`、`yamlError=null`、`pendingWrites=0`、`lastFlushError=null`；宿主启动无 `failed to import loader entry`（该错误会让启动直接失败，故无报错即可判为加载正常）

## 6. 归档与提交（待用户验收）

- [x] 6.1 用户验收后 `openspec archive retire-local-plugin-bundle-install`（2026-09-10 重启验收通过后归档）
- [x] 6.2 提交（代码与文档同一 commit；本项目未接入版本管理体系，body 末尾注明跳过版本号/changelog）
- [x] 6.3 提交粒度：经用户决定，本变更与尚未提交的 `batch-toggle-writes` **合并为一次提交**（两个 OpenSpec change 目录仍各自独立，归档时分别处理）
