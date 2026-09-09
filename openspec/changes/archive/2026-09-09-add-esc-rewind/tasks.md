# Tasks — add-esc-rewind

> 注：本变更 = **事后补记的既有实现**（组 1–6，`dsh-esc-rewind/` 已落地、18 条 harness 断言全绿，逐条标记 `[x]` 附当时验证）**+ 新增删除模式**（组 7，规划已确认、尚未实现，标记 `[ ]`，待 apply 阶段执行）。

## 1. 包骨架与仓库登记

- [x] 1.1 建 `dsh-esc-rewind/package.json`：`keywords:["dsh-plugin"]`、`type:"module"`、`main:"src/index.js"`、`exports{".","./client","./package.json"}`、`files:["src/","cordis.patch.yml","README.md","ACCEPTANCE.md"]`、`dsh.bundle.patch:"./cordis.patch.yml"`、`dsh.client:{inject:["@deepseek-ai/dsh-client-runtime"],platform:"web"}`、peer 下限（session/workspace-controller/client-runtime/ui-commands/ui-conversation `^0.1.2-rc.1`，ui-primitives `^0.1.1-rc.2`）；验证：`node -e "JSON.parse(require('fs').readFileSync('dsh-esc-rewind/package.json'))"` 无错
- [x] 1.2 写 `src/index.js`（空 host：`export { apply, inject: [], name }`，name `esc-rewind`，使插件成为 Loader 入口）与 `cordis.patch.yml`（Loader 行 + `conversation.input.overlay` insert 行）；验证：`node --check src/index.js` 通过、patch YAML 可解析
- [x] 1.3 仓库登记：根 `package.json.dependencies` += `"dsh-esc-rewind":"link:./dsh-esc-rewind"`，根 `cordis.patch.yml` append 一行；web profile per-plugin 直连（`dependencies` `link:` + `dsh.profile.bundles` 行 + `dsh plugin --profile web add D:/.../dsh-esc-rewind`）；验证：`dsh plugin --profile web list` 出现 `esc-rewind`、重启 GUI 后 `window.__dsew.applied===true`（ACCEPTANCE 0.1）

## 2. 服务接线与诊断面

- [x] 2.1 `src/client.js` apply(ctx)：gate `inject:['slots']`，`bindService` 懒取 `sessions/workspaces/conversation/uiConversation/commandUi` 存入 `__svc`；注册 `registerRewindContribution` 与 `conversation.input.overlay` 槽位（ROW_ID `esc-rewind`、order 60、`locale` 声明）；验证：bundle 测试注入假 ctx/slots/services 后 apply 不抛错、贡献/槽位注册回调被调用
- [x] 2.2 诊断面：`window.__dsew`（applied 标志、escStops/escRewinds/historyLoads 计数、lastGate、resetHistoryCache 等）+ `window.__dsewInternals._module`（供 harness 直取模块）；验证：测试断言计数随动作递增、lastGate 可解释"为什么没接管"，且不含消息内容
- [x] 2.3 locale：`ctx.locale.register(NS,{zh,en})`（`esc.rewind.stop`、`esc.rewind.rewound`、`rewind.command.*`、`rewind.picker.loading` 等文案），locale 服务缺席回退 `navigator.languages`；验证：测试断言 zh/en 两字典存在、`__t` 按当前 locale 取词

## 3. 会话读数、交换点推导与决策矩阵

- [x] 3.1 纯函数读数：`nodeKind/nodeSeq/nodeTime/contentOf/assistantStatusOf/nodeText/nodeImageRefs/chatNodeList`（走 `{order,nodes.get}` view node 读法 + 跨版本字段容错）；验证：bundle 测试用假 chat 快照断言 user/assistant/image 各类节点解析正确
- [x] 3.2 `buildExchanges` 从节点列表推导"用户回合交换点"（每轮含用户问题 seq/时间/文本/imageRefs + 之后到下一用户回合前的完整边界），`lastExchange/qualifyExchange` 判定最近一轮是否可回退；验证：测试覆盖单轮/多轮/首轮/纯图片/尾随 assistant 各形态，锚点 seq 正确
- [x] 3.3 `decideEsc` 决策矩阵：running→stop；尾部 `interrupted` 且草稿空→rewind；settled 尾部/草稿非空/无会话→放行；验证：测试逐格断言（spec「生成中按一次 Esc」「自然正常结束不可回退」「编辑草稿后解除」等场景）
- [x] 3.4 可用性 `sessionFacts/summaryOf/workspaceOf/isSubagentSession`：非 blank、非 subagent 判定；验证：测试断言空白/子代理会话不可回退（spec「子代理会话不提供回退」）

## 4. EscBridge：键盘捕获、门控与停止/回退执行

- [x] 4.1 `EscBridge` 组件挂 `conversation.input.overlay`：document **capture** keydown；门控读活动元素/`composedPath()`（弹层 role dialog/menu/listbox/aria-modal）、外来文本框、IME composing、composer `/@` trigger token、`__pickerSession` 让位；任一不确定放行；验证：测试以假事件对象逐项断言门控（spec「弹层打开时 Esc 先关弹层」「IME 组合或外部文本框焦点不触发」）
- [x] 4.2 `issueStop`（running 时 `binding().session.cancel()` + toast「已停止 · 再按 Esc 回退本轮」）与二次击「停止+回退」同态（快速连按不等停稳）；验证：测试断言 stop 路径调 cancel 恰一次、toast 文案、快速连按终态一致（spec「快速连按两次 Esc」）
- [x] 4.3 `doRewind(sessionId, exchange)` 串行引擎：`ensureIdle`（running 先 cancel 限时等停）→ `clearQueue`（updateQueue remove 逐项）→ 图片准备（readAttachment→File→createDraftImages，单项失败降级）→ `fork({atSeq:anchorSeq, increaseTitle:false})` → 归档原会话 → `open(childId)` → pending 还原（module 级 keyed by childId + TTL 30s，挂载且草稿空时消费）；验证：bundle 测试以记录 mock 断言调用序列、标题保留、首轮降级走 `create` 新空会话（spec「Esc 二次回退」「首轮回退降级」「带图片尽力还原」「原会话可恢复」）

## 5. /rewind 命令：原生选择器 + 全量预读 + load-once 缓存

- [x] 5.1 `registerRewindContribution`：贡献 `rewind`（popupSelect）；options 内可用性判定 → `refreshHistory`；onSelect 从 `knownExchangesOf`（缓存优先）按 seq 找回 exchange → `doRewind`；验证：测试断言贡献注册、options 首次触发全量加载、onSelect 走 doRewind（spec「/rewind 命令列出全部历史用户回合」「选中回合即从该轮之前重开」）
- [x] 5.2 全量预读：`loadThrough(0)`（宿主缺失回退 `loadOlder()` 循环，上限 400 页）+ `waitForSettled`（节点数稳定 2 次采样且 `hasMore=false`）；验证：测试断言调用 loadThrough 恰一次、settled 后才出选项（spec「从未渲染过的很早回合也可选」）
- [x] 5.3 load-once + 缓存水位：`refreshHistory` 四级短路（活窗口全覆盖 / `hasMore=false` 且见首轮 / 记录新鲜 / 才 loadThrough）；`rememberExchanges/localCacheSet/localCacheGet`（键 `dsh-esc-rewind.history.<sessionId>`，超 2.5MB 只留内存）、`maxExchangeSeq/watermarkSeq` 水位比较，有新内容合并重载一次；验证：新增 2 条测试——同页二次 open 不重复 loadThrough（`historyLoads` 不增）、刷新后无新内容走缓存/有新消息触发一次合并重载且最新在顶（spec「同一页面二次打开不重复加载」「刷新页面后无新内容走缓存」「刷新后已有新消息则合并重载」「缓存过大自动降级」）
- [x] 5.4 `node --check src/client.js` 语法通过；验证：命令退出码 0

## 6. 测试与文档

- [x] 6.1 按仓库先例写 `test/bundle.test.mjs`（自研 runner，非 node:test）：假 React/ctx/slots/services/uiConversation/commandUi 的 hook shim 加载真实 `client.js`，覆盖 2.1–5.3 全部断言（现 18 条）；验证：`node dsh-esc-rewind/test/bundle.test.mjs` 全绿、退出码 0
- [x] 6.2 能力审计：从已安装核心产物取出 session/workspace remote 会改状态的成员（delete/truncate/rewind 之类），断言 bundle 源码**一个都不引用**——回退只经 `fork/archiveSession/open` 等官方非破坏面；验证：审计断言通过（等价证明"append-only、不删日志"）
- [x] 6.3 写 `README.md`（行为表、为什么 fork+归档、键盘捕获与防误触、安装/卸载、开发验证命令）与 `ACCEPTANCE.md`（§0–4 人工项，含 3.10–3.12 load-once/缓存项）；验证：文档与 spec 场景一一对应、可勾选
- [x] 6.4 知识库沉淀：`docs/knowledge/2026-09-08-dsh-esc-rewind.md`（append-only/服务清单/取消路径/节点读数/Esc 捕获/armed 派生/附件还原 + v3 全量预读定稿 + v4 load-once 缓存水位）并在 `docs/knowledge/README.md` 登记一行；验证：知识库索引可检索
- [x]  逐条走查 `specs/esc-rewind/spec.md` 的 10 条 Requirement（含组 7 新增的 3 条）全部场景并记录结果；验证：`openspec validate add-esc-rewind --strict` 无 error

## 7. 删除模式：宿主半真删 + 会话头处置开关（新增，待实现）

> 前置事实（design Context/D6–D8）：客户端无删除 verb，真删必须宿主半动盘（参照 `@huanlin/dsh-plugin-session-delete` 的已证步骤但**自建**）；开关是全局偏好，settings 持久化；安全时序 = 先保证新分支可用再删旧；删除失败降级归档 + toast。

- [x]  `src/index.js` 从空 host 变真实 node apply：`inject:['settings']`（+ 按需 `storageDomain`/`agents`/`webServer`/`tools`），注册 settings 命名空间 `esc-rewind`（字段 `deleteOldOnRewind:boolean default:false`，schema 与默认值在 node 半与 client 半两端一致）；验证：`node --check src/index.js` 通过、bundle/单元测试断言 installSection 被以正确 schema 调用（spec「开关全局生效且持久化」）
- [x]  宿主半删除核心 `deleteSessionCore(ctx, sessionId)`：`ctx.agents.get` 拒绝运行中会话 → 定位并 `fs.rmSync` 磁盘日志目录（`~/.dsh/sessions/*/<id>/` 两拼写）→ 经 `storageDomain` 清 `session_projcache` 与 `workspace` 记账 → 返回逐项结果；验证：测试以临时目录/假 storageDomain 断言删除路径与幂等性（spec「切到删除态后回退真删旧会话」）
- [x]  删除通道：`webServer.register({kind:'exact', path:'/__esc-rewind/session/delete'})`（webServer 可选，出现才注册）+ `tools.register(defineTool)` 双通道，校验 sessionId 格式与 POST 方法；验证：测试断言端点注册/工具注册与参数校验（终端-only profile 也有工具可用）
- [x]  客户端读开关：`remote.settings.describe()` 取 `deleteOldOnRewind` 缓存为 `__deleteMode`（缺省 `false`，describe 失败/缺字段回退默认不误开）；验证：bundle 测试注入成功/失败/缺失三种 describe 结果断言模式位与回退（design「settings 读取失败回退归档」）
- [x]  会话头图标：`conversation.session.header.actions` 注册图标按钮（ROW_ID `esc-rewind-dispose`、order 28，避开 schedule 10/job-list 20/open-workdir 25/chameleon 30），档案柜⇄红色带叉垃圾桶两态随 `__deleteMode` 渲染，单击切换并即时写 settings；普通会话显示、子代理/空白隐藏；验证：bundle 测试以假 header props 断言两态渲染、点击切换、可见性门控（spec「会话头提供旧会话处置开关」「删除态图标与删除当前会话按钮可区分」）
- [x]  `doRewind` 尾段策略化：归档模式走 `workspaces.archiveSession`；删除模式在 fork+open 成功且确认可用后调删除通道，失败降级 `archiveSession` + toast「删除失败，已改为归档」，成功 toast「旧会话已删除」；首轮降级路径同样按策略；验证：bundle 测试断言策略分支、删除调用时序（新分支可用后才删）、失败降级、首轮删除（spec「删除模式的安全时序与失败兜底」「首轮降级同样遵守处置策略」）
- [x]  分层反馈文案：切到删除态 toast「已开启：回退将删除旧会话（不可恢复）」；删除态下首次 Esc 停止 toast 带警示「已停止 · 再按 Esc 将删除本轮并重来（不可恢复）」；执行后 toast「旧会话已删除」——全部入 zh/en 字典；验证：bundle 测试断言三种 toast 文案与模式关联（spec「删除模式无二次确认但有可见反馈」）
- [x]  `node --check src/client.js` + 能力审计更新：确认删除只经自建删除通道与 `archiveSession`，不经任何第三方端点；验证：两条命令退出码 0、审计断言通过
- [x]  bundle 测试扩充（含组 7 场景断言）全绿；验证：`node dsh-esc-rewind/test/bundle.test.mjs` 退出码 0
- [x]  文档同步：README 增「删除模式」段（开关位置/语义/不可恢复/无确认/失败降级、卸载后 settings 残留清理）；ACCEPTANCE 增人工项（图标两态、真实删除后列表/磁盘消失、失败降级、与 chameleon 垃圾桶视觉区分、子代理/空白隐藏）；知识库 `2026-09-08-dsh-esc-rewind.md` 补 v5（宿主半真删 + 开关）并在 README 登记；验证：文档与 spec 一一对应、可勾选
