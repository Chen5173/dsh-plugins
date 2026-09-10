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

对照 `openspec/changes/move-plugins-to-sub-plugins/specs/plugin-manager/spec.md`（布局与行 id 稳定性）。

- [x] 自动化：`pluginRootsOf` 在 `sub-plugins/` 存在时返回「嵌套根 + 仓库根」，不存在时只返回仓库根；`pluginAbsDirOf` 嵌套优先、未知目录回退扁平路径。
- [x] 自动化：`planMigration` 在嵌套仓库下写出的 devDep `link:` 指向 `sub-plugins/<子包>`（而非仓库根）。
- [x] 自动化：行 id 与层级无关（`rowIdOfDir` 既有用例；迁移不改行 id 由 `upsertManaged` 断言覆盖）。
- [x] 需真机：移动后 profile 中 `link:` 指向 `sub-plugins/<子包>`（`realpathSync` 实测），且 `dsh --dump-config --profile web` 的行 id 与 `disabled` 状态不变（profile `cordis.patch.yml` 与迁移前备份逐字节一致）。
- [x] 需真机：重启 `dsh web` 后面板列出全部 6 个子插件且状态正确（截图 + `GET /list` → 全 `active`、`installWhere=devDependencies`、`hasClient=true`）。
- [ ] 未验证：子插件自身界面功能不变（时间桶分组 / Esc 回退 / provider 两级选择器 / 历史召回 / 标题重生成 / 打开工作目录）——需人工点一遍。

## 其它真机检查

- [ ] 需真机：与 `dsh-mcp-manager` 共存——面板做几次开关/移除后，MCP 行仍在、MCP 面板仍正常。
- [x] 需真机：`/__dsh-plugin-manager/status` 与 `/list` 均返回 200 且字段完整（`repoRoot`/`pluginsRoot`/`profileName`/`yamlResolved`/`legacyDetected`/`yamlError` 全在；2026-09-10 实测）。
