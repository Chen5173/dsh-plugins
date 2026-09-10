# dsh-plugin-manager — ACCEPTANCE

对照 `openspec/specs/plugin-manager/spec.md` 的每条 Requirement（原 delta 已归档于 `openspec/changes/archive/2026-09-09-add-plugin-manager/`）。标注「需真机」的项需在真实 DSH web profile + 浏览器里验证（本仓库自动化只覆盖纯逻辑/客户端注册层）。

## A1 面板列出仓库子插件并推导状态

- [x] 自动化：`deriveStates` 覆盖 已激活/已停用/旧布局/未激活/非插件目录 五态；面板按状态渲染徽标与控件（bundle.test「renders plugin rows…」）。
- [x] 自动化：非插件 `dsh-*` 目录被标 invalid，不提供激活（host-core scan 用例）。
- [x] 自动化：管理器自身不列入管理集（`listRepoPluginDirs` 排除 `dsh-plugin-manager`）。
- [x] 自动化：双根并集扫描与嵌套优先（host-core「sub-plugins/ nested layout」用例：仅有嵌套 / 半迁移并集 / 同名目录去重）。
- [x] 自动化：头部显示子插件目录（bundle.test「header shows the repo root and the scanned plugins root」）。
- [x] 需真机：设置页左侧出现「本地插件」，列出的状态与 profile 实际一致；顶部显示仓库路径与子插件目录（2026-09-10 实测：面板截图 + `GET /list` → 200，6 个子插件全「已激活」，头部两行路径正确）。

## A2 主开关激活/停用并持久化

- [x] 自动化：`upsertManaged` 停用=写 disabled、启用=移除 disabled、稳定 id、不动其它行（host-core transform 用例）。
- [x] 自动化：面板开关 POST `set-enabled`（bundle.test「toggling…」）。
- [ ] 需真机：停用一个带界面的插件（如 dsh-session-time-bucket）→ 宿主行为实时停止 + 面板提示刷新；刷新后其 UI 消失；重启 DSH 后状态保持。再启用 → 实时恢复 + 刷新后 UI 出现。
- [ ] 需真机：`dsh --profile web --dump-config` 中该子插件行 `disabled: true/false` 正确。

## A3 启用缺失依赖的子插件时自动安装

- [x] 自动化：index.js 的 `ensureDevDep` 逻辑（manifest 改写 + `pnpm install` + 失败回滚）经代码路径审查；devDeps 不进入 bundles 由 `planMigration` 用例断言（bundles 只剩 manager）。
- [x] 自动化：`staleLinkSpec` 报告陈旧 `link:`（正确 spec / 陈旧 spec / 非本包 三种返回）；`ensureDevDep` 修复时复用「备份 → 改写 devDependencies → `pnpm install` → 失败回滚」。
- [ ] 需真机：把一个从未安装的仓库子插件点启用 → 自动加入 devDependencies + 激活；安装失败（如路径错）出现错误卡片且状态不变、可重试。
- [ ] 需真机：让某子插件的 devDependency `link:` 指向旧路径（如目录移动后未重链），点启用 → 路径被改写为当前目录并安装成功、插件激活。

## A4 移除子插件

- [x] 自动化：`removeManaged` 删行/摘依赖、`dropDevDep` 路径审查；面板移除按钮仅对 active/disabled/inactive 显示。
- [ ] 需真机：移除后插件不再加载、devDependencies 摘除、重新启用可复装。

## A5 一键迁移旧布局

- [x] 自动化：`planMigration` 用例——旧 `dependencies`+bundles 布局迁移后：子插件进 devDependencies、bundles 只剩 `dsh-plugin-manager`、激活集合不变（停用的仍停用）、伞包条目被移除、已迁移 profile 为 no-op。
- [x] 需真机：一键迁移（2026-09-09 在 web profile 上执行）→ 激活集合不变、profile 内留下 `*.bak-<ts>` 备份。当前已是迁移后状态：`/list` `legacyDetected=false`，面板不再出现迁移横幅。

## A6 设置入口与生效模型

- [x] 自动化：注册 `settings.section` id `local-plugins`、order 16、标签「本地插件」；动作成功且目标带 client → 显示刷新提示且**不自动刷新**（bundle.test 两处断言）。
- [x] 需真机：左侧出现「本地插件」一级入口（面板实测打开）；非 legacy 布局下不出现迁移横幅（`legacyDetected=false`）。
- [ ] 未验证：仓库目录不可达时给出可读错误而非静默空列表。

## A7 子插件目录布局（sub-plugins/）

对照 `openspec/specs/plugin-manager/spec.md`「子插件目录布局与行 id 稳定性」（delta 已归档于 `openspec/changes/archive/2026-09-10-move-plugins-to-sub-plugins/`）。

- [x] 自动化：`pluginRootsOf` 在 `sub-plugins/` 存在时返回「嵌套根 + 仓库根」，不存在时只返回仓库根；`pluginAbsDirOf` 嵌套优先、未知目录回退扁平路径。
- [x] 自动化：`planMigration` 在嵌套仓库下写出的 devDep `link:` 指向 `sub-plugins/<子包>`（而非仓库根）。
- [x] 自动化：行 id 与层级无关（`rowIdOfDir` 既有用例；迁移不改行 id 由 `upsertManaged` 断言覆盖）。
- [x] 需真机：移动后 profile 中 `link:` 指向 `sub-plugins/<子包>`（`realpathSync` 实测），且 `dsh --dump-config --profile web` 的行 id 与 `disabled` 状态不变（profile `cordis.patch.yml` 与迁移前备份逐字节一致）。
- [x] 需真机：重启 `dsh web` 后面板列出全部 6 个子插件且状态正确（截图 + `GET /list` → 全 `active`、`installWhere=devDependencies`、`hasClient=true`）。
- [ ] 未验证：子插件自身界面功能不变（时间桶分组 / Esc 回退 / provider 两级选择器 / 历史召回 / 标题重生成 / 打开工作目录）——需人工点一遍。

## A8 开关写入合并与「正在应用」

对照 `openspec/specs/plugin-manager/spec.md`「开关写入合并与重应用可见性」（delta 见 `openspec/changes/archive/2026-09-10-batch-toggle-writes/`）。

- [x] 自动化：handler 级 harness（`test/debounce.test.mjs`：真 `registerHttp` + 假 web 服务器 + 临时 `$DSH_HOME`）——400 ms 窗口内对两个不同子插件各发一次开关，patch 文件**只被写入一次**，两行都落在同一次写入里；同一行关→开也只写一次并只保留最后一次目标状态。
- [x] 自动化：窗口内响应已带目标状态（面板不必等落盘）；`/status` 在窗口内报告 `pendingWrites ≥ 1`，落盘后归零。
- [x] 自动化：`mergeIntent` 覆盖语义与 `applyIntents` 恒等/新增行/不修改输入（`host-core.test.mjs`）；`pendingWrites > 0` 期间面板显示「正在应用」、不锁其它行、归零后自行撤下（`bundle.test.mjs`）。
- [x] 自动化：退出路径尽力落盘——排队后立即 dispose，意图仍写入 patch 文件。
- [x] 红能力：把 handler 临时换回「收到请求立即写」后，`debounce.test.mjs` 精确失败在 `two quick switches produced exactly ONE patch-file write`（2026-09-10 验证后还原）。
- [x] 需真机：连点手感——400 ms 内翻转两个子插件只出现**一次**界面卡顿（对照改前：每次点击各约 1 秒）；「正在应用」提示出现并在宿主恢复后自动消失。2026-09-10 实机实测（`probe-burst2.mjs`，两轮 burst）：各 1 次写入 + 各 1 次宿主阻塞（1080 / 1341 ms），POST 往返 52–68 ms，结束状态与 patch 文件 md5 均还原；提示条的显示与自动撤下由 `bundle.test.mjs` 断言（浏览器里仍可一眼复核）。

## 其它真机检查

- [x] 需真机：与 `dsh-mcp-manager` 共存——面板做几次开关/移除后，MCP 行仍在、MCP 面板仍正常。（2026-09-10 实测 + 用户真机确认：多轮开关后 patch 文件 md5 与操作前**逐字节一致**，据此 3 条 MCP 行 [CodeMap / Serena / gcp] 原样保留；MCP 面板由用户确认正常）
- [x] 需真机：`/__dsh-plugin-manager/status` 与 `/list` 均返回 200 且字段完整（`repoRoot`/`pluginsRoot`/`profileName`/`yamlResolved`/`legacyDetected`/`yamlError` 全在；2026-09-10 实测）。

## A9 本地插件不提供 bundle 安装路径（2026-09-10）

对照 `openspec/specs/plugin-manager/spec.md`「本地插件不提供 bundle 安装路径」（delta 见 `openspec/changes/archive/2026-09-10-retire-local-plugin-bundle-install/`）。

- [x] 仓库级扫描：6 个 `sub-plugins/*/package.json` 均无 `dsh.bundle`、目录内无 `cordis.patch.yml`、`files` 不再列它；仓库根无 `package.json` / `cordis.patch.yml`；管理器自身仍保留 `dsh.bundle`（它才是唯一本地 bundle）。
- [x] 隔离 profile 实测（`DSH_HOME` 指向临时目录，**未触碰运行中的 web profile**）：`dsh plugin --profile scratchy add <sub-plugins/dsh-esc-rewind>` → 只进 `dependencies`（`link:`），`dsh.profile.bundles` 仍只有 `@deepseek-ai/dsh-base`，CLI 打印 `dsh: warning: dsh-esc-rewind declares no dsh.bundle — installed as a plain dependency, not a profile layer`，exit 0。
- [x] 隔离 profile 实测：上述状态下启动该 profile 成功（进程存活、无 `duplicate loader entry id`）。
- [x] 隔离 profile 实测（陈旧布局的红能力对照）：把该子插件塞回 `bundles` → exit 1，报 `dsh: profile bundle "dsh-esc-rewind" declares no dsh.bundle in its package.json`（比改造前的 `duplicate loader entry id` 自解释得多）。
- [x] 改造前复现（同一隔离手法）：真 bundle 层 + 真 profile 层同 id → `duplicate loader entry id: esc-rewind`，exit 1；改造后该构造已不可能（没有包自带 patch 可被合并）。
- [x] 需真机：重启 `dsh web` 后 6 个子插件仍正常加载、面板仍显示「已激活」（本次只改 manifest 与文档，未改激活行与依赖）。2026-09-10 重启后实测：`GET /list` → 6 个全 `state=active`、`installWhere=devDependencies`、`valid=true`、`legacyDetected=false`、`yamlError=null`；宿主启动未报 `failed to import loader entry`（行解析不到会让启动直接失败，故无报错即可判为加载正常）。

## A10 批量全部开启 / 全部关闭（2026-09-10）

对照 `openspec/specs/plugin-manager/spec.md`「批量全部开启 / 全部关闭」相关 Requirement（delta 原稿见 `openspec/changes/archive/2026-09-10-add-batch-toggle-all/`）。

### 作用范围与计数口径

- [x] 自动化：`batchPlan` 六态全覆盖——开启方向 = `disabled` + `uninstalled`（后者带 `needsInstall`），关闭方向 = 仅 `active`；`inactive`/`legacy`/`invalid` 一律跳过并带机器可读 reason（host-core.test「batch switch planning」用例，含未知状态的兜底 reason）。
- [x] 自动化：`N` 口径——全激活时 关闭 N=全部、开启 N=0；混合现场 开启 N=2、关闭 N=1（同上用例）。
- [x] 自动化：非插件目录不计入 N、也不会成为目标（host-core 用例 + harness 里 `batchCounts.*.skippedInvalid` 断言）。
- [x] 自动化：不触碰其它插件的行——批量关闭后 `mcp-CodeMap`（insert 行的 config）、`cmhub-mcp-gcp`、`dsh-liquid-glass`（普通覆盖行 `disabled: false`）逐项结构性比对不变，且 profile `package.json` 与操作前逐字节一致（batch-toggle.test 用例 2）。
- [ ] 需真机：面板上两个按钮显示的数量与真实可作用项一致（重启 `dsh web` 后打开设置 → 本地插件，对照行状态数一遍）。

### 一次落盘、一次安装

- [x] 自动化：批量关闭 N 项 = 对 `cordis.patch.yml` **恰好 1 次** `writeFileSync`（harness 在共享的 `node:fs` 对象上计数，非采样估计），且 N 行 `disabled: true` 在同一次写入里落盘（batch-toggle.test 用例 2）。
- [x] 自动化：批量开启 N 项同样只写 1 次、且用不着安装时 `ranPnpm=false`（用例 3）。
- [x] 自动化：两个未安装子插件 → `pnpm` **恰好被调用 1 次**（`install`），两个 `link:` 一次写齐（用例 4）。
- [x] 自动化：合并窗口内的单行意图被「接管」——先 `set-enabled`（意图仍在队列）再批量，全程只写 1 次文件，最终状态 = 批量语义，`/status.pendingWrites` 归零（用例 7；同一次写入里既有排队意图也有批量目标）。
- [x] 自动化：无可作用项时不写文件（`noop=true`、写入次数 +0、N 项 `already-active` 逐条回报，用例 6）。
- [x] 红能力：把批量改回「逐项写文件」→ harness 精确失败在 `batch disable = exactly ONE patch-file write`（actual 7 / expected 1）；把安装改回「逐项安装」→ 精确失败在 `two missing plugins cost exactly ONE pnpm install`（actual 2 / expected 1）。两次演示后均还原代码并复跑全绿（2026-09-10）。

### 失败逐项回报

- [x] 自动化：`pnpm` 失败时未安装项报 `outcome=failed / reason=install-failed` 且带原因文案，已安装项照常落盘（`applied = N-1`），profile `package.json` 逐字节回滚（用例 5）。
- [x] 自动化：失败项在面板提示条里逐条呈现（插件名 + 原因），不是只给一个失败总数（bundle.test「batch failures are listed per plugin」）。
- [x] 自动化：写入失败路径走 `write-error` 分支并把 `lastFlushError` 写进诊断（代码路径审查 + `/status` 字段断言）。

### 面板交互与生效提示

- [x] 自动化：两个按钮渲染、N 文案取自 `/list` 的 `batchCounts`、N=0 时两个按钮都 `disabled`（bundle.test「batch toolbar…」）。
- [x] 自动化：确认框文案含数量与「旧布局跳过」提示；取消则**不发任何请求**（bundle.test 两处断言）。
- [x] 自动化：批量进行中（响应被挂起）每行开关 + 「一键接管/迁移」全部 `disabled` 且按钮显示「处理中…」，响应返回后自动解锁（bundle.test「the panel locks rows and migrate…」）。
- [x] 自动化：带 client 的子插件被批量改动后给出「刷新页面使界面生效」提示与刷新按钮，且**不**自动刷新（bundle.test「全部关闭…hints a reload」，`reloaded === false`）。
- [x] 自动化：旧布局插件在批量中被跳过并逐条回报 `legacy-layout`，`batchCounts.disable.count = N-1`、`skippedLegacy = 1`（batch-toggle.test 用例 8）。
- [ ] 需真机：点「全部关闭 (6)」→ 确认框 → 全部变「已停用」且只卡顿一次（对照逐行点 6 次的 6 次卡顿）；点「全部开启 (6)」→ 全部回来；面板顶部刷新提示出现，刷新后 6 个子插件界面全部消失/恢复。
- [ ] 需真机：`dsh --profile web --dump-config` 中 6 行 `disabled: true/false` 与面板一致，且 `mcp-*` 等其它行原样保留。
- [ ] 需真机：拖一个未安装的子插件目录进 `sub-plugins/`，点「全部开启」→ 只跑一次 `pnpm install`（观察耗时明显短于逐个启用），完成后该插件为「已激活」。
## A11 仓库根安装外壳与 `add <仓库根>`（2026-09-10）

对照 `openspec/specs/plugin-manager/spec.md`「仓库根提供管理器的安装外壳」（delta 原稿见 `openspec/changes/add-repo-root-install-entry/`）。

- [x] 自动化：`dsh-plugin-manager/test/root-install-shell.test.mjs` —— 外壳 `name` === 管理器包名、`main`/`exports["."]` 转发到 `dsh-plugin-manager/src/index.js`（realpath 比较）、`exports["./client"]` + `dsh.client` 与包内一致、客户端产物注册 id === 包名。
- [x] 自动化：外壳 `dsh.bundle.patch` 与包内 `cordis.patch.yml` 是同一文件，且该 patch **只有一行**（`id`/`name` 均为 `dsh-plugin-manager`）——伞包事故（多插一行同 id）的回归锁。
- [x] 自动化：6 个子插件都不声明 `dsh.bundle`、目录内无 `cordis.patch.yml`、不复用管理器包名；仓库根无 `cordis.patch.yml`；外壳不声明任何子插件依赖、无 `dsh.profile.bundles`。
- [x] 红能力：把外壳 `name` 临时改成 `dsh-local-plugins` → 上述测试 2 条精确判红（`shell name === manager name`、`the bundle registers exactly the package name`），改回后复绿（2026-09-10）。
- [x] 隔离 profile 实测（`DSH_HOME` 指向临时目录，**未触碰运行中的 web profile**）：`dsh plugin --profile probe add <仓库根>` → `dependencies` = `{"dsh-plugin-manager":"link:<仓库根>"}`、`dsh.profile.bundles` = `["@deepseek-ai/dsh-base","dsh-plugin-manager"]`、**无** `declares no dsh.bundle` 警告（对照改造前：装成 `dsh-plugins` 普通依赖 + 打警告 + bundles 不变）。
- [x] 隔离 profile 实测：该 profile 启动成功 —— base-only（无 web app、不占端口）进程存活 15 s（`timeout` 124）且零输出，无 `duplicate loader entry id`、无 `Cannot find package`。
- [x] 隔离 profile 实测：`dsh --profile probe --dump-config` 的组合结果含 `- id: dsh-plugin-manager / name: dsh-plugin-manager`，无任何子插件行。
- [x] 红能力对照：同 profile 加一行坏行 `{id: bogus, name: 'dsh-nonexistent-xyz'}` → exit 1，报 `failed to import loader entry bogus (dsh-nonexistent-xyz): Cannot find package … imported from <profile dir>`（证明该构造能暴露坏行，且行名解析锚点就是 profile 目录）。
- [x] 等价性实测：先 `add <仓库根>/dsh-plugin-manager` 再 `add <仓库根>` → 依赖键不变、spec 被改写为仓库根、`dsh.profile.bundles` 仍是同一条（不重复）、启动正常。
- [x] 浏览器半定位实测：按 `@deepseek-ai/dsh-client-modules` 的两条定位分支（`nearestPackage` / `exports["./package.json"]` 兜底）各跑一遍真实算法，10/10 断言通过：定位包名 `dsh-plugin-manager`、产物 `dsh-plugin-manager/src/client.js`、注册 id === 包名。
- [ ] 需真机：在自己的机器上执行 `dsh plugin --profile web add <仓库根>`（例如 `E:\GitHubProjects\ChenSir5173\dsh-plugins`）→ 重启 `dsh web` → 设置页出现「本地插件」面板、`GET /list` 6 个子插件状态正常、启动日志无 `duplicate loader entry id` / `Cannot find package`。

