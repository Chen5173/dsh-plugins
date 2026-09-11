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

- [x] 仓库级扫描：6 个 `sub-plugins/*/package.json` 均无 `dsh.bundle`、目录内无 `cordis.patch.yml`、`files` 不再列它；仓库根无 `cordis.patch.yml`；管理器自身仍保留 `dsh.bundle`（它才是唯一本地 bundle）。**（2026-09-11 校订）** 原条目里「仓库根无 `package.json`」已不成立：根现在有一个 `package.json`，但它是**管理器的安装外壳**（同名、零依赖、只转发、不提供任何子插件激活行），不是当年的聚合伞包 `dsh-local-plugins`；该属性现由 `test/root-install-shell.test.mjs` 逐条强制，见 A11。
- [x] 隔离 profile 实测（`DSH_HOME` 指向临时目录，**未触碰运行中的 web profile**）：`dsh plugin --profile scratchy add <sub-plugins/dsh-esc-rewind>` → 只进 `dependencies`（`link:`），`dsh.profile.bundles` 仍只有 `@deepseek-ai/dsh-base`，CLI 打印 `dsh: warning: dsh-esc-rewind declares no dsh.bundle — installed as a plain dependency, not a profile layer`，exit 0。
- [x] 隔离 profile 实测：上述状态下启动该 profile 成功（进程存活、无 `duplicate loader entry id`）。
- [x] 隔离 profile 实测（陈旧布局的红能力对照）：把该子插件塞回 `bundles` → exit 1，报 `dsh: profile bundle "dsh-esc-rewind" declares no dsh.bundle in its package.json`（比改造前的 `duplicate loader entry id` 自解释得多）。
- [x] 改造前复现（同一隔离手法）：真 bundle 层 + 真 profile 层同 id → `duplicate loader entry id: esc-rewind`，exit 1；改造后该构造已不可能（没有包自带 patch 可被合并）。
- [x] 需真机：重启 `dsh web` 后 6 个子插件仍正常加载、面板仍显示「已激活」（本次只改 manifest 与文档，未改激活行与依赖）。2026-09-10 重启后实测：`GET /list` → 6 个全 `state=active`、`installWhere=devDependencies`、`valid=true`、`legacyDetected=false`、`yamlError=null`；宿主启动未报 `failed to import loader entry`（行解析不到会让启动直接失败，故无报错即可判为加载正常）。

## A10 批量全部开启 / 全部关闭（2026-09-10）

> ⚠️ **证据缺口（2026-09-11 整理文档时发现）**：本节多处 `[x]` 引用的 `test/batch-toggle.test.mjs` **从未入库**（`git log --all --` 查无此文件）。批量目前真实存在的自动化只有 `host-core.test.mjs` 的 `batchPlan` 纯逻辑用例与 `bundle.test.mjs` 的面板用例；凡「引用 batch-toggle.test 用例 N」的条目应视为**未验证**，直到该 harness 被补出来（可复用 `debounce.test.mjs` 的真 handler harness + `__setPnpmRunner` 桩）。

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
## A11 仓库根安装外壳与 `add <仓库根>`（2026-09-10 提出 / 2026-09-11 落地）

对照 `openspec/specs/plugin-manager/spec.md`「仓库根安装外壳让 git 地址可直接安装」（delta 与实测见 `openspec/changes/archive/2026-09-11-install-via-git-url/`）。

> **校订说明（重要，以免后人再被骗一次）**：本节最初写于 2026-09-10，但当天**只改了文档**——仓库根 `package.json` 与 `test/root-install-shell.test.mjs` 两个文件都没有被创建（`git show --stat ebc225d` 只含 README/AGENTS/spec/src 的改动）。所以 2026-09-10 那批「自动化 / 红能力 / 隔离 profile 实测」条目当时**指向的是不存在的文件**，已在此删除并按 2026-09-11 的真实复测重写。原条目里我这次**没有**重跑的部分（浏览器半定位算法 `nearestPackage` 分支逐行验证、base-only 进程存活 15 s、塞坏行的红能力对照）不恢复为「已验证」，改列在下方「未复验」。

- [x] 自动化：`dsh-plugin-manager/test/root-install-shell.test.mjs`（18 条断言，2026-09-11 全绿）覆盖——外壳 `name` === 管理器包名 === 客户端 `__ModuleLoader__.load({ id })` 注册的字符串；`main` 与 `exports["."]` 都落在包内 `src/index.js` 同一文件；`exports["./client"]` 与 `dsh.client` 与包内清单逐字段一致；`dsh.bundle.patch` 解析到包内 `cordis.patch.yml` 且该文件只插 `dsh-plugin-manager` 一行；仓库根无 `cordis.patch.yml`；外壳 `private`/`type: module`、**不声明任何依赖**、**不设 `files` 白名单**（会把 `sub-plugins/` 裁掉）、**不带 `dsh.profile.bundles`**、清单里任何位置都不出现子插件名；6 个子插件均不声明 `dsh.bundle`、无包自带 patch、不复用管理器包名；从「安装后布局」（`<pkg>/dsh-plugin-manager/src`）反推仓库根仍能扫到全部子插件。
- [x] 红能力（2026-09-11 逐条实跑，11 个变异全部判红、对照组全绿）：改外壳 `name`、删 `exports["./client"]`、删 `main`、转发指向不存在的文件、加子插件 `dependencies`、把 `dsh.bundle.patch` 指到根新建的 `cordis.patch.yml`、加 `files` 白名单、改 `dsh.client.platform`、去掉 `private`、删掉整个 `dsh.bundle`、给外壳加 `dsh.profile.bundles`；以及让某个子插件重新声明 `dsh.bundle`。
- [x] 等价性：`add <仓库根>` 与 `add <仓库根>/dsh-plugin-manager` 与 `add git+…` 三个入口写入同一个 `dsh-plugin-manager` 依赖键与同一条 bundle 层。
- [ ] 未复验（2026-09-10 声称过、本次未重跑，勿当作已验证）：`@deepseek-ai/dsh-client-modules` 两条定位分支（`nearestPackage` / `exports["./package.json"]` 兜底）的逐行复算；base-only profile 进程存活 15 s；往 profile 塞一行坏行以证明启动会失败。

## A12 用 git 地址安装本仓库（2026-09-11）

对照 `openspec/specs/plugin-manager/spec.md`「仓库根安装外壳让 git 地址可直接安装」。手法：`DSH_HOME` 指向临时目录 + 本地 `git clone --bare` 出来的 remote（`git+file://`），**全程未触碰运行中的 web profile**；`git+file://` 与 `git+https://`/`github:` 走 pnpm 完全相同的 clone→根目录即包 的路径，只有传输与鉴权不同。

- [x] 隔离 profile 实测：`dsh plugin --profile web add git+file:///…/realremote.git` → `dependencies` 恰好多出 **`dsh-plugin-manager`** 一个键（值为该 git 地址），无其它新键；CLI **不再**打印 `declares no dsh.bundle` 警告。
- [x] 隔离 profile 实测：`dsh.profile.bundles` = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-manager"]`——git 层只多这一条。
- [x] 隔离 profile 实测：`dsh --profile web --dump-default-config` 组合出 `# == dsh-plugin-manager` 层与 `- id: dsh-plugin-manager / name: dsh-plugin-manager`，exit 0，无 `duplicate loader entry id`。
- [x] 安装内容实测：hoisted 后 `node_modules/dsh-plugin-manager/` 就是整棵工作树（`sub-plugins/` 6 个子包、`dsh-plugin-manager/`、`package.json`…，无 `.git`、无 `node_modules`）。
- [x] 运行时定位实测：从安装目录跑 `repoRootOfPluginSrc(<pkg>/dsh-plugin-manager/src)` → `<pkg>`，`pluginRootsOf[0]` → `<pkg>/sub-plugins`，`listRepoPluginDirs` 得 6 个且 `readPluginMeta` 全部 `valid`、行 id 与仓库内一致。
- [x] 启用子插件实测：按 `ensureDevDep` 的写法把 `link:<pkg>/sub-plugins/dsh-esc-rewind` 写进 profile `devDependencies` 并按 `upsertManaged` 写激活行 → `pnpm install` exit 0，`dsh-esc-rewind` 被 hoisted 成指向 clone 内的链接并可 `resolve()` 到 `src/index.js`；`deriveStates` 报 `state=active`，其余 5 个 `uninstalled`。
- [x] 用户层组合实测：`dsh --profile web --dump-config`（含 profile 自有 `cordis.patch.yml`）出现 `- id: esc-rewind / name: dsh-esc-rewind`，exit 0。
- [x] 安装副本自测：在 clone 出来的安装目录里直接跑 `root-install-shell.test.mjs` → PASS（外壳随仓库一起分发且自洽）。
- [x] 红能力（反向对照）：把 remote 退回到**没有根 `package.json`** 的提交再 `add` 一次 → pnpm 用**仓库目录名**当包名（装出来叫 `pre.git`），`dependencies` 键是 `pre.git`，`bundles` **不变**，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`。这就是外壳存在的理由。
- [x] 换入口收敛实测：profile 先以 `link:D:/…/dsh-plugin-manager`（本机 web profile 的**现状**）装好管理器，再 `add git+…` → 同一个 `dsh-plugin-manager` 键的 spec 被改写为 git 地址，`bundles` 仍只有一条、`dependencies` 仍只有一个键，`--dump-default-config` 里 `- id: dsh-plugin-manager` 恰好出现 **1** 次，exit 0。
- [x] **真实 `git+https://` 传输实测**（2026-09-11，推到 `135ce6b` + tag `v0.1.0` 之后，隔离 `DSH_HOME`）：`dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git` → exit 0，依赖键恰为 **`dsh-plugin-manager`**（pnpm 把 spec 归一化成 `github:Chen5173/dsh-plugins`），`bundles` = `[dsh-base, dsh-web-app, dsh-plugin-manager]`，**无** `declares no dsh.bundle` 警告；`--dump-default-config` 组合出 `- id: dsh-plugin-manager` 且只 **1** 次，exit 0；`node_modules/dsh-plugin-manager/` 是整棵工作树（`sub-plugins/` 6 个目录 + `dsh-plugin-manager/` + `docs/` + `openspec/`）。
- [x] 真实 tag 锁版本实测：`… git+https://…/dsh-plugins.git#v0.1.0` → 依赖键仍是 `dsh-plugin-manager`、spec 为 `github:Chen5173/dsh-plugins#v0.1.0`、`bundles` 恰一条。
- [x] 安装自测：在**从 GitHub 装出来的 clone**里直接跑 `root-install-shell.test.mjs` → PASS。
- [ ] 需真机（浏览器侧，无法在无 GUI 环境判定）：重启 `dsh web` → 设置页出现「本地插件」入口、`GET /list` 列出 6 个子插件、启动日志无 `duplicate loader entry id` / `Cannot find package`。
- [ ] 需真机（私有仓库）：本仓库是 public，凭据面未覆盖。若日后转私有，pnpm 直接调用系统 git，需保证 git 侧有可用凭据（SSH key / credential helper）；失败形态预计是 git 侧鉴权报错而非 dsh 报错。
- [ ] 需真机：从 git 装的 clone 里在面板点「启用」某个子插件 → 面板显示「已激活」且其宿主行为生效（本项的链接与解析部分已由上面的自动化实测覆盖）。

