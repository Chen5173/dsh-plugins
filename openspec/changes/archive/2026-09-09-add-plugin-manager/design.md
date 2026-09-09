## Context

现状（见 proposal.md – Why）：仓库根伞包 `dsh-local-plugins` 未被 web profile 使用；profile 里 5 个本地插件以「`dependencies` `link:` + 各自在 `dsh.profile.bundles`」的旧布局存在。已核实的 DSH 机制约束：

- profile `cordis.patch.yml`（用户层）被 `patchReload:'live'` 的 HMR 文件监听器实时重读并 `entry.update` 重放（`packages/boot/app-boot` `watchUserPatches`）；因此**新写/改写该文件的行会实时生效**。
- bundle 自带 `cordis.patch.yml` 只在启动时读一次、不被监听——不能作为“随时可增删”的真相源。
- `dsh plugin` 只是 pnpm 转发器：`add <pkg>` 后 `reconcilePlugins` 会把「声明了 `dsh.bundle.patch` 的 dependencies」追加进 `dsh.profile.bundles`；**devDependencies 不会被 reconcile 扫描**（本仓库 README 已实测验证）。
- `dsh-mcp-manager` 用 js-yaml（`JSON_SCHEMA` 扩展 `!!js` 自定义 type，`{__jsExpr}`）对同一个 profile patch 文件做整文件 parse→transform→dump——是可复制的先例。
- 客户端插件以 `window.__ModuleLoader__.load({id, factory})` 提供；内置设置节用 `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))` 注册一级入口（`ui-settings-general` 左栏是 slot ledger 的实时投影）。
- 客户端插件的进/出 `__DSH_BOOT__` 引导图发生在页面加载时；宿主侧行可实时启停，客户端 UI 变化需要一次页面刷新。

## Goals / Non-Goals

**Goals:**
- 把「哪个本地插件在 web profile 激活」收敛为**一份**管理器维护的清单（profile `cordis.patch.yml` 中一组带标记的行），面板只读写这一份 + profile 依赖。
- 用户只安装 `dsh-plugin-manager` 一个 bundle；新增/移除子插件不再手工改 profile。
- 复用 DSH 既有持久化与热重载：不发明新的“运行时启停 API”（DSH 没有内置 toggle RPC）。
- 与既有生态共存：不破坏 `dsh-mcp-manager` 行、不吞掉用户手写 disabled 行。
- 可测试：核心逻辑（扫描/状态推导/patch 变换/迁移规划）抽成可单元测试的纯函数（如 esc-rewind 的宿主半那样带 `test/bundle.test.mjs`）。

**Non-Goals:**
- 不做远程/市场插件管理（内置「设置→插件」的只读清单仍在）。
- 不做“从零新建插件脚手架”。
- 不做自动刷新页面（Q9 已定：手动刷新提示）。
- 不管理 `dsh`/`tui` 等其他 profile（默认 web；不把迁移范围扩大）。
- 不改 DSH 核心、不提交补丁到 deepseek-harness。

## Decisions

### D1 真相源 = profile `cordis.patch.yml` 中一组由管理器维护的行

每个子插件以稳定行 id 存在（沿用其历史上独立 bundle 用的 id，如 `session-time-bucket`、`esc-rewind`；也即根伞包 cordis.patch.yml 曾用的 id，使既有 profile disabled 覆盖继续有效）。行形式：

```yaml
# --- dsh-plugin-manager: managed local plugins (do not hand-edit) ---
- insert:
    - id: session-time-bucket
      name: 'dsh-session-time-bucket'
    - id: esc-rewind
      name: 'dsh-esc-rewind'
    - id: composer-history-recall
      disabled: true
      name: 'dsh-composer-history-recall'
```

- 已激活 = 行存在且未 disabled；停用 = `disabled: true`（保留现场）；移除 = 行整个删除 + devDependencies 摘除。
- 选择 profile patch 而非仓库内清单的理由：激活集合本质是**机器/profile 本地**状态（仓库可克隆到别处）；且该文件被 HMR 监听 → 天然“写文件即实时生效”，无需 loader API。
- 备选（否决）：(a) 仓库根文件作真相源 + `ctx.loader.create` 动态建行——客户端 `__DSH_BOOT__` 在页面加载时固定、bundle patch 只启动读一次，动态行持久化/重启一致性要自管，且 loader 动态建行的模块解析语义不如 patch 行成熟；(b) 复用根伞包静态 cordis.patch.yml——它只启动读一次，无法表达“运行时新增子插件”。

### D2 子插件放 devDependencies，bundles 只留管理器

迁移后：`dsh.profile.bundles` 本地条目 = `dsh-plugin-manager`；全部本地子插件以 `link:<repo>/dsh-xxx` 放 `devDependencies`。pnpm 会把 devDependencies 装进 profile `node_modules`（可解析），`reconcilePlugins` 只扫 dependencies → 不会把它们塞回 bundles。这是本仓库 README 已实测过的形态（伞包实验即用 devDependencies），唯一变化是「插入行」的位置从伞包 bundle patch 移到 profile patch。

### D3 宿主半提供 HTTP `/__dsh-plugin-manager/*`，客户端 fetch

沿用 esc-rewind 的纯 HTTP 端点模式（`ctx.webServer.register({kind:'exact', path, handler})`），不引入 Typert Remote：
- `GET /__dsh-plugin-manager/status`：健康/诊断（探测到 profile 路径、settings 段是否注册等）。
- `GET /__dsh-plugin-manager/list`：仓库根扫描 + 每个子插件的 profile 状态（含迁移是否需要）。
- `POST /__dsh-plugin-manager/set-enabled`：`{dir}` 启用/停用（必要时先自动安装）。
- `POST /__dsh-plugin-manager/remove`：`{dir}` 移除（删行 + 摘 devDep）。
- `POST /__dsh-plugin-manager/migrate`：一键迁移旧布局。
- 响应均为 JSON `{ok, error?, data?}`；写文件失败/权限错误 → 4xx/5xx + 可读信息，客户端显示错误卡片。
- 备选（否决）：Typert Remote `@Remote` 服务更“官方”，但 esc-rewind 已在同 profile 验证 fetch 原生端点足够且依赖更少；Remote 需要 gateway/assembly 双侧接线，跨仓库外插件多一层未知。

### D4 patch 文件用 js-yaml 整体 parse→transform→dump（复用 mcp-manager 模式）

- 用 `yaml.JSON_SCHEMA.extend(!!js type)`（`construct → {__jsExpr}`、`represent` 还原），整文件读入数组、只变换「行 id 或 insert 子项 id ∈ 管理器集合」的条目，其余原样，再整文件写回。
- 文件不存在 → 视为 `[]`（建文件）；空数组写 `[]`。
- 与 mcp-manager 并发整写是“最后写者胜”，概率低且均可从文件恢复；行 id 各自命名空间隔离，不会互相“误删”。
- 依赖改写：profile `package.json` 的 devDependencies/bundles 直接小步改写 + `pnpm install`（在 profile 目录 spawn `pnpm`，即 `dsh plugin` 同款）；先备份 `package.json` 与 `cordis.patch.yml` 到 `*.bak-<ts>`。
- 目标 profile 解析：`process.env.DSH_HOME || ~/.dsh` + `profiles/web`，profile 名默认 `web` 并可在插件 `Config`（schemastery，settings 段）覆盖——与 `dsh-mcp-manager` 完全一致；仓库根 = `path.resolve(__dirname, '..')`（管理器装于 `<repo>/dsh-plugin-manager`）。

### D5 客户端：settings.section「本地插件」+ 手写 factory

- `src/client.js` 用 `window.__ModuleLoader__.load({ id: 'dsh-plugin-manager', factory: (require) => {...} })`，内部 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')`、`require('@deepseek-ai/dsh-client-runtime')`，返回 `{ apply, inject: ['slots'] }`——与内置设置节产物的模块格式一致（这些共享模块由引导图预先提供）。
- `apply` 内 `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'local-plugins', order:16, label: () => t('nav'), locale: NS }, LocalPluginsSection))`。文案走插件自带 zh/en 字典（`locale: NS` 需声明小字典）。
- 面板组件用 ui-primitives 的 React 原语与 `--dsw-*` 令牌渲染；数据全从 `/__dsh-plugin-manager/*` fetch，组件内自带刷新/错误/忙碌状态；开关与「移除/迁移」动作带确认与结果 toast。
- 「刷新使界面生效」：动作成功且目标是带 client 的插件时，显示提示条 + `location.reload()` 按钮（不自动调）。
- 无 slot/服务时（旧版本）静默不注册入口，等同未安装。

### D6 迁移边界与伞包退役

- 「一键迁移」只做局部收敛：本地子插件 dependencies→devDependencies、bundles 去掉本地条目（保留 manager）、按当前 bundles 行 disabled 状态补 patch 行；`dsh-local-plugins` 若在 profile 出现则一并移除条目与依赖。
- 仓库根伞包退役 = 文档/元数据层面：根 `package.json` 保留但 `description` 注明 deprecated（不再注册新依赖行）、根 `cordis.patch.yml` 保留为历史参考并加注释、根 README 的「统一安装模型」改写为管理器模型。不删除文件（避免破坏历史/回滚参照），profile 未引用则不动。

## Risks / Trade-offs

- [整文件重写 profile patch 可能与其他写者（dsh-mcp-manager）竞争] → 行 id 命名空间隔离；写前读最新、写后由 HMR 重放校验；备份文件可回滚；把“改动只限于管理器集合内的行”作为不可变约束写进 ACCEPTANCE。
- [客户端 UI 开关需要手动刷新（自动刷新被否决）] → 面板动作后明确提示 + 刷新按钮；对纯宿主行仍即时生效。
- [pnpm 安装/迁移动作慢或失败] → 所有动作带忙碌态与错误卡片、可重试；迁移先备份。
- [`settings.section` 槽或 ui-primitives 版本不足] → 惰性注册，失败静默退化为不可见，README 注明版本下限。
- [模块解析细节（require react/primitives 在浏览器 module-loader 的可用性）偏离预期] → 与内置设置节产物格式逐字对齐；实现后按 ACCEPTANCE 在真机 GUI 验证入口出现。
- [默认写死 profile=web] → 可配置覆盖 + status 端点暴露实际路径便于诊断。

## Migration Plan

1. 代码先行（本仓库内）：新增 `dsh-plugin-manager/`，测试通过；根 README/知识库更新。
2. 用户安装（真机，需用户执行）：`dsh plugin --profile web add <repo>/dsh-plugin-manager`，重启 GUI。
3. 面板「一键接管/迁移」：把现有 5 个子插件收敛到新模型（devDeps + 管理器维护行），迁移前后激活集合不变。
4. 回滚：迁移有备份；插件本体卸载 = `dsh plugin --profile web remove dsh-plugin-manager` + 还原备份（README 说明）。

## Open Questions

无。所有影响 spec/方案/任务拆分的问题已在本轮访谈中由用户定案（安装模型、真相源、开关/移除语义、自动安装授权、手动刷新、迁移按钮、伞包退役、命名与位置）。
