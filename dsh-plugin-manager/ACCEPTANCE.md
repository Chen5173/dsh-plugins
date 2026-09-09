# dsh-plugin-manager — ACCEPTANCE

对照 `openspec/changes/add-plugin-manager/specs/plugin-manager/spec.md` 的每条 Requirement。标注「需真机」的项需在真实 DSH web profile + 浏览器里验证（本仓库自动化只覆盖纯逻辑/客户端注册层）。

## A1 面板列出仓库子插件并推导状态

- [x] 自动化：`deriveStates` 覆盖 已激活/已停用/旧布局/未激活/非插件目录 五态；面板按状态渲染徽标与控件（bundle.test「renders plugin rows…」）。
- [x] 自动化：非插件 `dsh-*` 目录被标 invalid，不提供激活（host-core scan 用例）。
- [x] 自动化：管理器自身不列入管理集（`listRepoPluginDirs` 排除 `dsh-plugin-manager`）。
- [ ] 需真机：设置页左侧出现「本地插件」，列出的状态与 profile 实际一致；顶部显示仓库路径与 profile 名。

## A2 主开关激活/停用并持久化

- [x] 自动化：`upsertManaged` 停用=写 disabled、启用=移除 disabled、稳定 id、不动其它行（host-core transform 用例）。
- [x] 自动化：面板开关 POST `set-enabled`（bundle.test「toggling…」）。
- [ ] 需真机：停用一个带界面的插件（如 dsh-session-time-bucket）→ 宿主行为实时停止 + 面板提示刷新；刷新后其 UI 消失；重启 DSH 后状态保持。再启用 → 实时恢复 + 刷新后 UI 出现。
- [ ] 需真机：`dsh --profile web --dump-config` 中该子插件行 `disabled: true/false` 正确。

## A3 启用缺失依赖的子插件时自动安装

- [x] 自动化：index.js 的 `ensureDevDep` 逻辑（manifest 改写 + `pnpm install` + 失败回滚）经代码路径审查；devDeps 不进入 bundles 由 `planMigration` 用例断言（bundles 只剩 manager）。
- [ ] 需真机：把一个从未安装的仓库子插件点启用 → 自动加入 devDependencies + 激活；安装失败（如路径错）出现错误卡片且状态不变、可重试。

## A4 移除子插件

- [x] 自动化：`removeManaged` 删行/摘依赖、`dropDevDep` 路径审查；面板移除按钮仅对 active/disabled/inactive 显示。
- [ ] 需真机：移除后插件不再加载、devDependencies 摘除、重新启用可复装。

## A5 一键迁移旧布局

- [x] 自动化：`planMigration` 用例——旧 `dependencies`+bundles 布局迁移后：子插件进 devDependencies、bundles 只剩 `dsh-plugin-manager`、激活集合不变（停用的仍停用）、伞包条目被移除、已迁移 profile 为 no-op。
- [ ] 需真机：装好管理器后对当前 web profile（5 个本地插件）执行一键迁移 → 迁移前后可见激活集合不变；`package.json`/`cordis.patch.yml` 出现 `*.bak-<ts>` 备份；失败可回滚。

## A6 设置入口与生效模型

- [x] 自动化：注册 `settings.section` id `local-plugins`、order 16、标签「本地插件」；动作成功且目标带 client → 显示刷新提示且**不自动刷新**（bundle.test 两处断言）。
- [ ] 需真机：左侧导航出现在「插件」之后；legacy 检测横幅出现；仓库目录不可达时显示可读错误。

## 其它真机检查

- [ ] 需真机：与 `dsh-mcp-manager` 共存——面板做几次开关/移除后，MCP 行仍在、MCP 面板仍正常。
- [ ] 需真机：`/__dsh-plugin-manager/status` 与 `/list` 返回 200 且字段完整。
