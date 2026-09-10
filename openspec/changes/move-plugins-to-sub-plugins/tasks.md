## 1. 核心路径重构（host-core）

- [x] 1.1 新增 `PLUGINS_DIRNAME='sub-plugins'`、`pluginRootsOf(repoRoot)`、`pluginAbsDirOf(repoRoot, dir)`；验证：host-core 测试覆盖「仅有嵌套」「仅有扁平」「两处同名」三种仓库形态
- [x] 1.2 `listRepoPluginDirs` 改为双根并集（按名去重、嵌套优先、仍排除管理器自身）；验证：并集/去重/排序断言
- [x] 1.3 `readPluginMeta` 经 `pluginAbsDirOf` 取 `dirPath`；验证：嵌套布局下 `dirPath` 指向 `sub-plugins/`
- [x] 1.4 `planMigration` 的 `link:` 一律用 `p.dirPath`（回退 `path.join(repoRoot, dir)`）；验证：嵌套仓库迁移后 devDep 指向 `sub-plugins/`
- [x] 1.5 新增纯函数 `staleLinkSpec(manifest, meta)`；验证：正确/陈旧/非本包三种返回

## 2. 宿主接线与面板

- [x] 2.1 `index.js`：`PLUGINS_ROOT`、`HOST_DIAG.pluginsRoot`、`resolveContext.pluginsRoot`、`listPayload.pluginsRoot`、`/status.pluginsRoot`
- [x] 2.2 `ensureDevDep` 自愈陈旧链接（复用既有备份+pnpm+回滚）；验证：代码路径审查 + 纯逻辑用例
- [x] 2.3 `client.js`：文案与头部显示「子插件目录」；验证：bundle.test 渲染断言

## 3. 迁移执行（需批准）

- [x] 3.1 `git mv` 6 个子插件目录到 `sub-plugins/`（管理器自身不移动）——git 识别为 43 个 rename，历史保留
- [x] 3.2 备份 profile `package.json`/`cordis.patch.yml`（`*.bak-20260910-115100`），改写 6 条 devDependencies `link:` 指向 `sub-plugins/`，`pnpm install` 完成（15s）
- [x] 3.3 验证：7 个包（含管理器）`await import()` 全部 OK；软链真实路径指向 `sub-plugins/`；`dsh --dump-config --profile web` 6 行 id 不变；profile `cordis.patch.yml` 与备份逐字节一致
- [x] 3.4 重启 `dsh web` 后验证：面板列出 6 个子插件且全部「已激活」，头部显示仓库目录 + 子插件目录；`/status` 与 `/list` 返回 200 且含 `pluginsRoot`；`legacyDetected=false`

## 4. 回归与文档

- [x] 4.1 7 个子包全部测试文件通过（无回归）
- [x] 4.2 `openspec validate move-plugins-to-sub-plugins` 通过
- [x] 4.3 同步 `dsh-plugin-manager/README.md`（目录布局节）、`ACCEPTANCE.md`（A1/A3/A7）、根 `README.md`、`AGENTS.md`（旧伞包描述已纠正）
- [x] 4.4 新增 `docs/knowledge/2026-09-10-sub-plugins-layout.md` 并登记索引
- [ ] 4.5 归档本变更到 `openspec/changes/archive/` 并同步 `openspec/specs/plugin-manager/spec.md`