# DSH 插件：本地插件管理器（dsh-plugin-manager）

日期：2026-09-09 · 涉及：`dsh-plugin-manager/`（host-core + index + client）、web profile、根伞包（2026-09-10 已删除）、OpenSpec change `add-plugin-manager`。

## 一句话

只把 `dsh-plugin-manager` 装进 web profile（唯一本地 bundle），设置页「本地插件」面板即可扫描仓库内全部 `dsh-*` 子包（`sub-plugins/` + 仓库根双根并集）并管理激活状态（启用/停用/移除/一键迁移）；子插件放 `devDependencies`（link:），激活清单 = profile `cordis.patch.yml` 里管理器维护的稳定 id 行。

## 可复用结论（本轮实测/研究得出）

- **DSH 没有“运行时启停插件”的内置 API**；但 web profile `patchReload:'live'` 会**实时监听 profile `cordis.patch.yml`**，改/加行即 `entry.update` 重放（`watchUserPatches` → Include `root.update`）。Bundle 自带 `cordis.patch.yml` 只在启动读一次、不被监听。
- **`dsh plugin add` = pnpm 转发 + reconcile**：只有 `dependencies` 里声明了 `dsh.bundle.patch` 的包会被追加进 `dsh.profile.bundles`；放 `devDependencies` 就不会（pnpm hoisted nodeLinker 仍会把 devDeps 装进顶层 node_modules，可正常 import）。→ “只装一个 bundle + 子插件 devDeps” 可行。**推论（2026-09-10 落实）：既然 `dsh.bundle` 声明只会带来冲突，子插件包就一律不声明它** —— 见 [2026-09-10-retire-bundle-install.md](2026-09-10-retire-bundle-install.md)。
- **profile 目录从宿主里拿**：`ctx.baseUrl`（file:URL，指向 profile 目录，name=basename）；无 webServer 时兜底 `$DSH_HOME/profiles/web`。js-yaml 经 `createRequire(<profile>/package.json)('js-yaml')` 拿到（profile 顶层因 mcp-manager 已装）。
- **patch 文件整文件重写**：先例 = `dsh-mcp-manager`（js-yaml `JSON_SCHEMA.extend(!!js→{__jsExpr})`，parse→transform→dump lineWidth 120，整文件写回）。行 id 全局唯一（否则 `duplicate loader entry id` 拒绝整次刷新）；改动只限自己管理的行 id，别碰 mcp 行。
- **行形状**：新增=`- insert:[{id,name,disabled?}]`；停用=该 insert 项 `disabled:true`；旧布局下对 bundle 行用顶层 `- id: X\n disabled:true` 覆盖（但我们要求先迁移，避免 id 冲突）。
- **客户端设置节**：`ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,label}, Comp))`，order 参考：general 0 / models 10 / plugins 15 / **local-plugins 16** / mcp 18 / agent-presets 20。客户端用 `window.__ModuleLoader__.load({id, factory})`，factory 里 `require('react')`（react/react/jsx-runtime/ui-primitives 是模块表词）；无 JSX，直接 `React.createElement`。
- **客户端 UI 只在页面加载时进出 `__DSH_BOOT__`**：宿主行可实时启停，客户端界面变化必须一次页面刷新（自动刷新被否决 → 面板给提示+刷新按钮）。
- **Windows spawn pnpm** 要 `shell: process.platform==='win32'`（pnpm 是 .cmd shim），cwd=profile 目录，`link:` 用绝对路径（anchorPathSpec 原样透传）。
- **现有 5 子插件的稳定行 id** = 目录名去 `dsh-` 前缀（session-time-bucket / composer-history-recall / composer-provider-label / open-session-workdir / esc-rewind / session-title-regenerate）——与它们旧独立 bundle 用的 id 一致（旧伞包已删除），既有覆盖/回滚不失效。

## 踩坑备忘

- 外部 `link:` 插件**不能指望 pnpm 装它自己声明的嵌套依赖**（不遍历 link 目标），所以 js-yaml 从 profile 拿。**host 半不要 import `@deepseek-ai/*` 宿主内部包**：Node 按仓库真实路径解析（`link:` 的 symlink 被解引用），仓库祖先链上无 `node_modules` → 启动即 `ERR_MODULE_NOT_FOUND`。title-regenerate 曾靠仓库内不入库的本地 stub 顶着，2026-09-09 已去核心化（就地实现 createUserMessage / BlockAssembler，见 [2026-09-09-plugin-host-half-no-core-import.md](2026-09-09-plugin-host-half-no-core-import.md)）。
- 迁移前 profile 里子插件在 `dependencies`+各自 `bundles`；迁移=移 devDeps + bundles 收敛只留 manager + 按当前激活补行，**先备份** `package.json`/`cordis.patch.yml`（`*.bak-<ts>`），失败回滚。
- 面板对 `state==='legacy'` 的行**禁用开关与移除**（返回 409），引导先一键迁移——避免与 bundle 层同 id 行冲突。

## 相关文件

- 插件：`dsh-plugin-manager/{src/host-core.js, src/index.js, src/client.js, cordis.patch.yml, README.md, ACCEPTANCE.md, test/*}`
- 变更：`openspec/changes/archive/2026-09-09-add-plugin-manager/`（delta 已并入 `openspec/specs/plugin-manager/`）
- 已删除：仓库根伞包 `dsh-local-plugins`（根 `package.json` / `cordis.patch.yml` 于 2026-09-10 物理删除；此前只标 deprecated）
