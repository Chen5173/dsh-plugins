## Why

DSH Web GUI 的 composer 模型选择器只显示**模型名**：`ModelSelect` 的触发器文案是 `model.name`（外加 ` · 推理档`），只有当模型不在目录里时才退回 `provider/model`（`packages/client/ui-model-selection/src/client/ModelSelect.tsx:197-200`）。而本机 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers` 下，**同一个 `deepseek-v4-flash` 同时挂在 ark、codemaker、bai、openroputer 四家**，各自还给了不同的显示名。结果是：界面上写着「DeepSeek-V4-Flash」，实际打的是火山方舟、本地代理还是 OpenRouter，完全看不出来——计费、限流、上下文窗口和能不能用都不一样，猜错的成本很高。

核心具备全部所需数据（`session/modelCatalog` 返回按 provider 分组的目录，`modelSelection` 投影返回该会话生效路由），缺的**只是一个把 provider 说出来的触点**。

## What Changes

- 新增一个 DSH 插件包 `dsh-composer-provider-label`：在 composer 工具行的 **`conversation.input.right`** 这个 list 槽位（`replaceRisk: none`，当前无占用者，位置就在模型选择器左边一格）注册一枚**只读** provider 标签。
- 标签**只显示 provider，不重复模型名**（模型名由核心选择器负责），整行读作 `office · DeepSeek-V4-Flash · high`。
- provider 名取目录里的 `group.name`（即 settings 的 `displayName`），**剪掉尾部括号后缀**（`ARK (Coding Plan)` → `ARK`），完整名进 tooltip。
- 内置一张极小别名覆盖表，只预置 `deepseek-official → office`（该 provider 的 displayName 在 `packages/llm/llm-deepseek/src/index.ts:472` 硬编码为 `DeepSeek`）；其余 provider 一律不预置，没有 displayName 的（如 `codemaker`）就显示 provider id。
- 别名表可由用户覆盖：node 半用 `settings.installSection` 注册命名空间 `dsh-composer-provider-label`（字段 `providerAliases`），client 半经 `remote.settings.describe()` 读自己那一段；**读不到或报错就静默回退内置表**。
- 生效路由按 `projection.next ?? catalog.default` 解析——与核心 `ModelDirectory.current` 同一条规则，两边永不打架；无 sessionId、投影未就绪时**整枚标签不渲染**。
- 刷新：订阅 `modelSelection` 投影（切会话/切模型即时生效）；监听 `llm/adapters-updated` 与 `settings/document-updated` 重取目录；`connection/reset` 时丢弃目录缓存。
- 文案跟随客户端 locale（zh/en），只用 `--dsw-*` 主题 token，不加「本标签来自插件」的来源标识。
- **不做**：不改 DSH 核心、不遮蔽 `conversation.input.model` 这个 single 槽位、不做 DOM 注入、不做 provider/model 切换交互（v1 只读，交互留给后续变更）、不显示 baseURL / 推理档 / 不可路由告警（交给核心已有的 block 文案）。

## Capabilities

### New Capabilities

- `composer-provider-label`: 在会话 composer 的工具行上，把该会话**下一次请求实际会用的 provider** 以可读、可跟随路由变化、可被用户改名的方式显示出来——包括标签何时出现、显示什么名字、名字从哪来、如何随路由与配置刷新、以及它不得改变任何会话状态。

### Modified Capabilities

- 无。既有能力 `composer-history-recall`（`openspec/specs/composer-history-recall/spec.md`）与本变更共用 composer，但用的是不同槽位（`conversation.input.overlay` vs `conversation.input.right`），其需求不变；共存只作为验收项，不构成需求修改。

## Impact

- **新增**：插件包目录 `dsh-composer-provider-label/`（`package.json` + `cordis.patch.yml` + `src/index.js` + `src/client.js` + `test/bundle.test.mjs` + `README.md` + `ACCEPTANCE.md`），带 `dsh-plugin` keyword。
- **安装面**：profile `package.json` 的 `dsh.profile.bundles` 追加一项；Loader 行由包自带 `cordis.patch.yml` 的 `- insert:` 落地（与仓库三个先例同构）。
- **新增配置面**：settings 命名空间 `dsh-composer-provider-label`（字段 `providerAliases`），由本插件 node 半注册，因此会出现在设置页与 `settings/describe()` 结果里。卸载插件后该段若被用户手写过，残留在 `settings.yaml` 中无害（README 说明）。
- **运行时依赖（全部是核心已有、已在 web profile 内的公开契约）**：
  - 槽位：`conversation.input.right`（list / session，`packages/client/ui-conversation/src/client/contract/slots.ts:135`）
  - 投影：`useProjection('modelSelection')` → `{lastUsed, next}`，每项 `{provider, model, reasoningEffort?}`（`packages/api/session-controller/src/model-selection-projection.ts:62`）
  - Remote：`remote.session.modelCatalog()` → `{default, routableProviders, groups[{id,name,models[]}], failures[]}`（`packages/api/session-controller/src/index.ts:253`）；`remote.settings.describe()`
  - 事件：`llm/adapters-updated`、`settings/document-updated`、`connection/reset`
  - 服务：`slots`、`locale`；UI 件 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`
- **版本下限**：`@deepseek-ai/dsh-api-session-controller` / 核心 **≥ 0.1.2-rc.1**。`session/modelCatalog` 与 `modelSelection` 投影都自 `dsh-v0.1.2-alpha.1` 起存在（`git tag --contains` 查得）；槽位本身 `dsh-v0.1.0-rc.7` 就有。版本不够时标签**自动不出现**，不报错。
- **不受影响**：会话日志与投影缓存（纯读）、workspace 记账、模型工具集、核心 `ModelSelect` 的两级菜单与推理档选择、其它 profile（无 web 表面时槽位不存在，插件自然不渲染）。
- **已知边界**：`modelCatalog()` 是**按 host 代际**的目录，不是按会话；本插件与核心一样缓存一份。远程 Web UI 场景下 provider 名反映的是宿主侧配置，与浏览器所在机器无关。
