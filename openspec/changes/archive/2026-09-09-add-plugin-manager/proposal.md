## Why

本地插件的激活集目前靠三份互不相同的清单手维护：仓库根伞包 `dsh-local-plugins` 的 `cordis.patch.yml`（只列 5 个、已漏 `dsh-composer-provider-label`）、web profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies`（5 个但与伞包不同、且漏 `dsh-open-session-workdir`）、以及 profile `cordis.patch.yml` 里可能的手写 `disabled` 行。每加一个新插件都要手工 `dsh plugin --profile web add`、改两处清单，装多了自然漂移。需要一个「只装一次、之后全部在设置页里可视化管理」的统一入口。

## What Changes

新增 DSH 插件包 `dsh-plugin-manager`（宿主半 + 浏览器客户端半）：

- **唯一本地入口**：web profile 里本地插件只保留 `dsh-plugin-manager` 一个 bundle；仓库内全部 `dsh-*` 子插件（含未来新增）移入 profile `devDependencies`，保持可解析但不会被 `dsh plugin` 的 reconcile 重新塞进 `dsh.profile.bundles`。
- **激活清单 = profile `cordis.patch.yml` 中由本管理器管理的行**（稳定 id、`name`=子插件包名、可 `disabled`），复用 DSH 对 profile patch 的**实时热重载**：宿主行即时启停；客户端 UI 变更经一次页面刷新进/出引导图。
- **设置页一级入口「本地插件」**（settings.section，排在「插件」节之后）：列出仓库根全部 `dsh-*` 子包（排除管理器自身），每行显示状态（已激活/已停用/未安装/非插件目录）+ 描述，提供**主开关**（停用=保留 disabled 行；启用=必要时自动 `pnpm add -D link:` 安装后写激活行）与次操作**「移除」**（删行 + 从 devDependencies 摘除）。
- **一键「接管/迁移」**：检测到子插件仍以旧布局（`dependencies` + 各自在 `dsh.profile.bundles`）存在时，面板提供迁移按钮——移 devDependencies、bundles 只留管理器、按当前激活状态补齐 patch 行。
- **生效提示**：开关后宿主行即时生效；对带客户端 UI 的插件提示「刷新页面使界面生效」，提供刷新按钮，不自动刷新。
- **退役伞包**：仓库根 `dsh-local-plugins` 与其 `cordis.patch.yml` 标记 deprecated 并停止使用（profile 未引用则不动）；根 README 与开发知识库同步更新。

**不做**：不管理远程/市场插件（内置「设置→插件」仍是全量只读清单）；不提供“从零新建插件脚手架”；不改 DSH 核心；不做自动刷新页面。

## Capabilities

### New Capabilities

- `plugin-manager`: 在 DSH Web 设置页提供「本地插件」面板，管理本仓库（monorepo）内全部 `dsh-*` 子插件在 web profile 中的激活状态——包括仓库子包扫描与状态推导、以稳定 id 行读写 profile `cordis.patch.yml` 实现激活/停用/移除、缺失依赖时自动 `pnpm add -D link:` 安装、旧「dependencies+bundles」布局的一键迁移、以及“宿主实时生效 + 客户端界面需刷新”的生效模型。

### Modified Capabilities

- 无。既有能力（`esc-rewind`、`composer-history-recall`、`composer-provider-label`）需求不变；本变更只是把它们作为“被管理的子插件”纳入同一激活模型，作为验收场景。

## Impact

- **新增**：插件包目录 `dsh-plugin-manager/`（`package.json` + `cordis.patch.yml` + `src/index.js` + `src/client.js` + `test/bundle.test.mjs` + `README.md` + `ACCEPTANCE.md`），带 `dsh-plugin` keyword。
- **新增加载/配置面**：
  - profile `cordis.patch.yml` 将新增一组由管理器维护的行（注释标明 `managed by dsh-plugin-manager`，请勿手改）；现有 `dsh-mcp-manager` 等其它行原样保留。
  - web profile `package.json`：`dsh.profile.bundles` 的本地插件条目收敛为仅 `dsh-plugin-manager`；本地子插件在 `devDependencies` 以 `link:<repo>/dsh-xxx` 声明。
- **宿主半（Node，dsh web 进程内，非沙箱）**：扫描 `path.resolve(__dirname,'..')`（仓库根）的 `dsh-*` 子包；读写 `$DSH_HOME/profiles/web/cordis.patch.yml`（js-yaml + `!!js` schema，复用 `dsh-mcp-manager` 已验证的整体 parse→transform→dump 模式）；需要时在 profile 目录 `spawn pnpm add -D link:…`；注册 HTTP 端点 `/__dsh-plugin-manager/*`（list/enable/disable/remove/migrate/status）。
- **客户端半（浏览器）**：`window.__ModuleLoader__.load` factory 内 `require` react / `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-runtime`；`ctx.slots.inject('settings.section', …)` 注册 `id:'local-plugins'`、order 16、标签「本地插件」；面板经 `fetch('/__dsh-plugin-manager/…')` 与宿主通信。
- **依赖下限（peerDependencies）**：`@deepseek-ai/dsh-client-runtime` ≥ `0.1.1-rc.2`、`@deepseek-ai/dsh-client-ui-primitives` ≥ `0.1.1-rc.2`、`@deepseek-ai/schemastery`（可选，设置段注册用）。版本/槽位缺失时设置入口不出现，静默退化。
- **文档面**：仓库根 `README.md` 的「统一安装模型/新增插件流程」改写为管理器模型并注明伞包已退役；`docs/knowledge/` 新增一篇。
- **已知边界**：管理器只作用于配置的目标 profile（默认 `web`，可配置覆盖）；重写 patch 文件与 `dsh-mcp-manager` 同为整文件重写，两者并发写存在最后写入者胜（罕见，均可从文件本身恢复）；移除「未安装」插件不需要卸载其它机器状态。
