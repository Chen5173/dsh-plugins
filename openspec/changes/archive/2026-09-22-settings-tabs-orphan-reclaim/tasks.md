## 1. 宿主半：孤儿扫描（只读）

- [x] 1.1 新增纯函数 `orphanSetOf(corpus)`：输入会话 header 语料（`id`/`parentSession`/`origin`），输出**不可达子代理**集合（传递判定：父缺失，或父自身不可达）与每个孤儿的父 id。验证：harness 新增用例覆盖「父缺失」「父在→不算」「父本身是孤儿→子也算」「无孤儿→空集」四态，且函数不修改入参。
- [x] 1.2 新增 `scanOrphans(ctx, { signal })`：用 `ctx.get('sessionQuery').listSessions()` 取语料 → `orphanSetOf` 判定 → 逐项补 `running`（`agents.get(id)`）、`label` 与 `atSeq`（`observeSession(id)`：`subagent/descriptor` 的 label、最后一个 `turn/end` 的 seq）、`lastActivity`；冷读并发上限 4，单条失败只降级该行为 `label=id`、`canRescue=false`。验证：fake ctx 用例覆盖「descriptor 缺失回退 id」「observe 抛错不炸整次扫描」「无 turn/end ⇒ canRescue=false」「无 subagents/sessionQuery 服务时返回空并记诊断」。
- [x] 1.3 新增只读端点 `GET /__esc-rewind/orphans`（非 GET → 405）：返回 `{ok, count, orphans:[{id, label, parentId, running, canRescue, atSeq, lastActivity}]}`，并把最近一次扫描结论写入 `HOST_DIAG.lastOrphanScan`、在 `GET /__esc-rewind/status` 里带出孤儿计数。验证：端点用例（正常/方法不对）+ 断言与 1.1 纯函数在同一现场下的结果一致。
- [x] 1.4 新增端点 `POST /__esc-rewind/orphans/stop`（body `{ids: string[]}`）：逐 id 复用 `stopAgentIfRunning`，返回逐项 `{id, stopped, confirmed, reason?}`；未在跑 → `{stopped:false, reason:'not-running'}`；非法 id → 400，空数组 → 400。验证：用例覆盖「在跑→stopped/confirmed」「未在跑→not-running」「等待上限内未静默→confirmed:false 且不谎报成功」。
- [x] 1.5 新增模型工具 `esc_rewind_orphans`（best-effort，动态 import `@deepseek-ai/dsh-tools`，与既有 `esc_rewind_session_delete` 同形态）：`action: 'list' | 'stop'`。验证：源码断言（工具名/参数/延迟注册），tools 缺席时静默降级。

## 2. 客户端：入口 tab + 回收面板

- [x] 2.1 注册 tab：`ctx.slots.inject('settings.localPlugins.tab', () => ctx.slots.register({ name:'settings.localPlugins.tab', id:'subagents', order:50, label: () => t('子代理'/'Subagents'), locale: NS }, OrphansTab))`；槽缺失或注册抛错时静默降级并写 `__dsew.orphanTabRegistered`。验证：harness 断言槽名/id/order/标签双语，且「无该槽」现场不抛未捕获错误。
- [x] 2.2 面板读路径：打开即 `GET /__esc-rewind/orphans`，渲染计数 + 列表（label、父 id、在跑、可否找回、最后活动时间）+ 空态/加载态/失败态（失败带原因）+ 「刷新统计」按钮。验证：fetch stub 用例覆盖正常/空/HTTP 失败/JSON 坏四态。
- [x] 2.3 停止动作：逐项按钮 + 勾选批量，`POST /__esc-rewind/orphans/stop`，逐项渲染结果（已停止 / 未在跑 / 未确认静默），失败不掩盖成功项。验证：用例断言请求体与三种结果渲染。
- [x] 2.4 找回动作：`canRescue:true` 才可点；running 时先走停止再继续；成功路径 = `sessions.fork({sessionId, atSeq})` → `rename(label)` → `sessions.open(childId)`；`canRescue:false` 显示原因且按钮禁用；失败可见且不产生半成品。验证：用例覆盖「正常找回」「无边界拒绝」「运行中先停后 fork」，并断言**未调用任何删除路径**、原孤儿 id 不在 opened/archived 之外被动过。
- [x] 2.5 全手动不变量：源码断言面板无 `setInterval`/启动钩子；用例断言「打开面板/点刷新统计」只发生 GET（无 cancel、无 fork）。

## 3. 设置入口收拢（三个既有插件）

- [x] 3.1 `dsh-plugin-manager/src/client.js`：注册行改为 `settings.localPlugins.tab`（id `local-plugins`，order 20），组件与服务注入不变。验证：`node dsh-plugin-manager/test/bundle.test.mjs` 断言槽名/id/order，且**不再**注册 `settings.section`。
- [x] 3.2 `sub-plugins/dsh-hindsight-model/src/client.js`：同（id `hindsight-model`，order 30）。验证：其 harness 注册断言更新并全绿。
- [x] 3.3 `sub-plugins/dsh-idle-hook/src/client.js`：同（id `idle-hook`，order 40）。验证：其 harness 注册断言更新并全绿。
- [x] 3.4 props 依赖核对：三个面板若依赖 `settings.section` 的 owner props（如 `t`），改用注册项 `locale: NS` 的 `props.t` 或 `ctx.locale.bind(NS)`。验证：harness 以 tab 槽的 props 形状渲染不报错、文案随语言切换。

## 4. 测试与红绿

- [x] 4.1 跑 `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`：新增用例全绿，计数写入 ACCEPTANCE。
- [x] 4.2 红绿验证：把新增用例跑在实施前的源码上，必须按预期红（记录红条数与失败点），再在实施后全绿。
- [x] 4.3 全仓 sweep：管理器 4 支（host-core/bundle/debounce/root-install-shell）+ 全部子插件 harness + `node --check` 两半，全绿（逐条贴命令与结果）。

## 5. 文档

- [x] 5.1 `sub-plugins/dsh-esc-rewind/README.md` 增「子代理回收」段（入口 = 设置 → 本地插件 → 子代理；停止/找回语义与边界；全手动）；`ACCEPTANCE.md` 增人工项 6.x（tab 出现、统计与探针一致、停止在跑孤儿、找回有完整回合的孤儿、空态、全手动无副作用）。
- [x] 5.2 三个插件 README/ACCEPTANCE 记账「设置入口已移到 设置 → 本地插件 → <tab>」。
- [x] 5.3 `docs/knowledge/2026-09-08-dsh-esc-rewind.md` 新增 v7.7 小节（可复用结论：`settings.localPlugins.tab` 是核心声明的列表槽、tab 懒挂载、注册范式与 `settings.section` 的取舍；孤儿定义=可达性；找回=fork 成普通会话），并在 `docs/knowledge/README.md` 追加索引行。
- [x] 5.4 新增 `docs/change-reports/2026-09-22-settings-tabs-orphan-reclaim-change-report.md`（问题、根因、方案、验证证据、边界与遗留）。
- [ ] 5.5 主 spec 同步：归档时把三个 delta 合入 `openspec/specs/{esc-rewind,plugin-manager,hindsight-model}/spec.md`（归档动作由用户触发，不自动执行）。

## 6. 真机验证（用户侧）

- [ ] 6.1 重启 `dsh web` + 刷新页面：设置 → 本地插件 出现「子代理」tab，统计与本机现场（27 个孤儿，含 `6455048f`）一致；`GET /__esc-rewind/orphans` 探针结论一致。
- [ ] 6.2 对仍在跑的孤儿执行「停止」（确认静默），对 1 个有完整回合的孤儿执行「找回」（确认新会话出现在侧栏、内容可继续、原孤儿仍在）。
- [ ] 6.3 设置左侧导航出现**「本地插件」一级入口**（核心「插件」行不受影响）；进入后 tab 列表出现「插件」「Hindsight 模型」「空闲通知」「子代理」四个 tab，切换功能正常、切换后不丢已填内容。

## 8. 孤儿删除（2026-09-22，用户追加需求）

用户要求「子代理」面板增加**删除**；选定语义：**受守卫拒绝、不级联**，另有**批量删除 + 全选/取消全选**。

- [x] 8.1 宿主半：`ORPHANS_DELETE_PATH = '/__esc-rewind/orphans/delete'` + `deleteOrphanRun(ctx, id)`（复用 `deleteSessionCore`：先 cancel+静默，再删日志/投影缓存/工作区记账；守卫拒绝翻成 `{deleted:false, reason:'subagents', children}`）；端点校验 405/400/非法 id，逐项结果 + `deleted`/`blocked` 计数。验证：`bundle.test` 新增端点用例（空 ids/非法 id → 400；守卫拒绝 → 0 磁盘动作；未受守卫的真实删除，临时 `DSH_HOME`）。
- [x] 8.2 客户端：逐行「删除」（危险色）+ 批量「删除选中 (N)」+ 「全选 / 取消全选」；删除前 `window.confirm`（文案含数量与不可恢复）；逐项结果文案区分 已删除 / 守卫拒绝（含子级数）/ 不存在 / 失败；删除成功后从勾选集合移除。验证：`bundle.test` 新增 2 条（全选→批量→结果文案；取消确认不发请求）。
- [x] 8.3 规格：新增「删除不可达孤儿（真删，受守卫且不级联）」要求 + 4 个场景；原「本轮 MUST NOT 提供删除孤儿」条款改写为「显式触发 + 删除必须先确认」。
- [x] 8.4 文档：esc-rewind README「子代理回收」补删除与全选；ACCEPTANCE 增自动化与真机项；变更报告补记；版本 0.2.1 → 0.2.2（按 AGENTS.md 版本规则）。

## 7. 入口形态修正（2026-09-22，用户反馈）

用户明确：**不要塞进核心「插件」页**（会与其它内容混杂），而是**在设置左侧导航新增「本地插件」一级入口**，各本地插件面板作为该入口内的 tab。据此改实现与规格：

- [x] 7.1 `dsh-plugin-manager/src/client.js` 改为**自建一级入口**：注册 `settings.section`（id `local-plugins`，order 16，label「本地插件」）并声明子槽 `settings.localPlugins.tab`（`kind: 'list'`），同时渲染 tab chrome（tab 栏几何/交互抄核心 `ui-settings-plugins`：`border-bottom .5px var(--dsw-alias-border-l2)`、active 下划线条、首挂载后保持挂载）。
- [x] 7.2 管理器自己的面板成为该入口的第一个 tab（id `plugins`，order 0）；`settings.section` 的注入改为收集式（harness 支持多个 inject）。验证：`bundle.test` 断言两个注册 + `children['settings.localPlugins.tab'].kind === 'list'` + chrome 用 `renderSlot(..., { only: 'plugins' })` 挂载当前 tab。
- [x] 7.3 三个子插件改注册到 `settings.localPlugins.tab`（esc-rewind `subagents` 50 / hindsight `hindsight-model` 30 / idle-hook `idle-hook` 40）；各自 harness 与 capability audit 同步。
- [x] 7.4 面板打磨（同批反馈）：孤儿面板按钮改为与核心卡片同几何（`.5px var(--dsw-alias-border-l3)`、radius 6、height 26、padding 0 10px），「停止」用危险色（`--dsw-alias-state-error-primary`）；每行的「停止/找回」右对齐（`marginLeft: auto`），行内元信息（label + 运行中/父会话）收进左侧两行。
- [x] 7.5 规格与文档改写：把先前写成"核心「插件」页 tab"的措辞统一改为「本地插件」一级入口（`settings.localPlugins.tab`），覆盖三个 spec delta、proposal/design、README/ACCEPTANCE、知识库与变更报告。