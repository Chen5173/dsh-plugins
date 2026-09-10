# dsh-plugin-manager — ACCEPTANCE

对照 `openspec/changes/add-plugin-manager/specs/plugin-manager/spec.md` 的每条 Requirement。标注「需真机」的项需在真实 DSH web profile + 浏览器里验证（本仓库自动化只覆盖纯逻辑/客户端注册层）。

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

对照 `openspec/specs/plugin-manager/spec.md`「开关写入合并与重应用可见性」（delta 见 `openspec/changes/batch-toggle-writes/`）。

- [x] 自动化：handler 级 harness（`test/debounce.test.mjs`：真 `registerHttp` + 假 web 服务器 + 临时 `$DSH_HOME`）——400 ms 窗口内对两个不同子插件各发一次开关，patch 文件**只被写入一次**，两行都落在同一次写入里；同一行关→开也只写一次并只保留最后一次目标状态。
- [x] 自动化：窗口内响应已带目标状态（面板不必等落盘）；`/status` 在窗口内报告 `pendingWrites ≥ 1`，落盘后归零。
- [x] 自动化：`mergeIntent` 覆盖语义与 `applyIntents` 恒等/新增行/不修改输入（`host-core.test.mjs`）；`pendingWrites > 0` 期间面板显示「正在应用」、不锁其它行、归零后自行撤下（`bundle.test.mjs`）。
- [x] 自动化：退出路径尽力落盘——排队后立即 dispose，意图仍写入 patch 文件。
- [x] 红能力：把 handler 临时换回「收到请求立即写」后，`debounce.test.mjs` 精确失败在 `two quick switches produced exactly ONE patch-file write`（2026-09-10 验证后还原）。
- [ ] 需真机：连点手感——400 ms 内翻转两个子插件只出现**一次**界面卡顿（对照改前：每次点击各约 1 秒）；「正在应用」提示出现并在宿主恢复后自动消失。

## 其它真机检查

- [ ] 需真机：与 `dsh-mcp-manager` 共存——面板做几次开关/移除后，MCP 行仍在、MCP 面板仍正常。
- [x] 需真机：`/__dsh-plugin-manager/status` 与 `/list` 均返回 200 且字段完整（`repoRoot`/`pluginsRoot`/`profileName`/`yamlResolved`/`legacyDetected`/`yamlError` 全在；2026-09-10 实测）。

## A9 本地插件不提供 bundle 安装路径（2026-09-10）

对照 `openspec/specs/plugin-manager/spec.md`「本地插件不提供 bundle 安装路径」（delta 见 `openspec/changes/retire-local-plugin-bundle-install/`）。

- [x] 仓库级扫描：6 个 `sub-plugins/*/package.json` 均无 `dsh.bundle`、目录内无 `cordis.patch.yml`、`files` 不再列它；仓库根无 `package.json` / `cordis.patch.yml`；管理器自身仍保留 `dsh.bundle`（它才是唯一本地 bundle）。
- [x] 隔离 profile 实测（`DSH_HOME` 指向临时目录，**未触碰运行中的 web profile**）：`dsh plugin --profile scratchy add <sub-plugins/dsh-esc-rewind>` → 只进 `dependencies`（`link:`），`dsh.profile.bundles` 仍只有 `@deepseek-ai/dsh-base`，CLI 打印 `dsh: warning: dsh-esc-rewind declares no dsh.bundle — installed as a plain dependency, not a profile layer`，exit 0。
- [x] 隔离 profile 实测：上述状态下启动该 profile 成功（进程存活、无 `duplicate loader entry id`）。
- [x] 隔离 profile 实测（陈旧布局的红能力对照）：把该子插件塞回 `bundles` → exit 1，报 `dsh: profile bundle "dsh-esc-rewind" declares no dsh.bundle in its package.json`（比改造前的 `duplicate loader entry id` 自解释得多）。
- [x] 改造前复现（同一隔离手法）：真 bundle 层 + 真 profile 层同 id → `duplicate loader entry id: esc-rewind`，exit 1；改造后该构造已不可能（没有包自带 patch 可被合并）。
- [ ] 需真机：重启 `dsh web` 后 6 个子插件仍正常加载、面板仍显示「已激活」（本次只改 manifest 与文档，未改激活行与依赖）。
