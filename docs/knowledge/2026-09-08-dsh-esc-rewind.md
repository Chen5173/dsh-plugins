# DSH 插件：Esc 停止 + Esc Esc /rewind 回退重来

日期：2026-09-08 · 插件 `dsh-esc-rewind`（client-only）

## 结论（可复用）

- **DSH 会话日志 append-only，插件无法原地删消息**。核心 `ConversationContextOriginKind 'rewind'/'rewrite'`（`packages/client/ui-chat/src/client/model/conversation-context.ts`）是全仓死代码（无生产者/消费者）；surface-replace（`core/session/src/surface.ts`）只能「一段→一条新节点」且仅供 `/compact` 宿主内部，客户端无任何 delete/truncate/rewind verb。想表达 Codex/Claude 式 rewind → 用官方非破坏组合：`sessions.fork({sessionId, atSeq, increaseTitle:false})`（fork 边界 = `atSeq` 之后第一个 turn/end）+ `workspaces.archiveSession(oldId)` + `sessions.open(childId)` + `inputActions.setDraft(text)`。fork 语义见 `api/session-controller/.../contract/sessions.ts` 的 fork 注释：只切「完整回合前缀」。
- **客户端可触达的服务**（plugin client apply(ctx) 用 `ctx.inject([name], cb)` 懒取即可，勿写死 inject 数组以免旧版本阻塞加载）：`sessions`（ISessions：binding/fork/open/create/search；list 快照 `{ids, byId: {title, displayTitle, origin:'subagent'}}`）、`workspaces`（IWorkspaces：`archiveSession`/`list.getSnapshot().items[{workspaceId, sessionIds}]`）、`conversation`（ConversationController：scope-addressed cancel/send/updateQueue + 无 scope 的 `createDraftImages(File[])→ComposerAttachment[]`、`releaseDraftImage`，Service 名 `'conversation'`，root 单例）、`uiConversation`（root Service：`binding(sessionId).snapshot.get().views.get('chat')` 可命令式读会话节点）、`commandUi`（`register(CommandContribution)`：纯客户端 `/`-菜单条目，`ui.kind:'popupSelect'` 的 options/onSelect 全在 client，是「斜杠命令+自绘交互」的正规扩展缝；贡献名与宿主命令冲突会 fail loud）。
- **取消**：`sessions.binding(id).session.cancel()`（SessionFace，含 updateQueue/readAttachment/rename/loadOlder；getSnapshot().running/queue）。`inputActions`（slot kit 提供的公共面）**没有** cancel/stop——只有 setDraft/addImages/removeImage/pruneImages/submit。排队清除：对 `snapshot.queue[]` 每个 `item.id` 调 `session.updateQueue(item.id, {kind:'remove'})`。
- **会话节点读数**：`chat` 视图快照（`views.get('chat')`）历史字段 `legacy.nodes` 已在新版消失；可靠路径 = `{order, nodes.get(key)}` 的 view node：`node.kind`、`node.anchorSeq`(seq)、`node.data.content`（user/steering，ContentBlock[]，image 块为 `{type:'image', attachment: ImageAttachmentRef{attachmentId, mediaType, name}}`）、assistant 状态在 `node.data.status`（'running'|'settled'|'interrupted'）。跨版本读法写容错 + `window.__dsew` 诊断。
- **Esc 捕获**：核心所有 Esc 关闭逻辑都是 bubble 阶段（Menu/Modal/ContextMeter/TurnUsagePanel/Lightbox/MessageFeedback）；composer 内 Lexical keymap 在 CRITICAL 优先级处理 ESC 弹层（`KEY_ESCAPE_COMMAND`）。插件用 document **capture** keydown（同 composer-history-recall），必须先过门控：无弹层（role dialog/menu/listbox/aria-modal）+ 无外来文本框 + **composer 无 `/@` trigger token 在光标前**（trigger 弹层是 portal，composedPath 看不见）。
- **armed（可回退）用派生状态而非记忆**：running 可停；或尾部 assistant `status==='interrupted'`（即曾被 Stop/ESC 打断，自然 settled 永不 armed）且草稿为空（改草稿即解除）；新发送/切会话天然失效。ESC-stop 与工具栏 Stop 都能进入同态。
- 附件尽力还原：`binding.session.readAttachment(attachmentId)` → `{attachment, data(Uint8Array)}` → `new File([data], name, {type})` → `conversation.createDraftImages([file]).map(a=>a.id)` → 分支挂载后 `inputActions.addImages(ids)`。跨会话 setDraft 用「module 级 pending（keyed by child sessionId），桥在目标会话挂载时消费」解决（open 后 inputActions 身份变化，不能当场调）。

## 复用点
- 伞包登记：根 `cordis.patch.yml` 一行 + 根 `package.json.dependencies` 一行（web profile 实际是 per-plugin 直连：`dependencies link:` + `dsh.profile.bundles` 行 + `dsh plugin --profile web add <dir>`；README 的 umbrella 模型当前未启用）。
- 浏览器端 bundle 无构建：改 `src/client.js` 刷新即可；新插件行需 GUI host 重启后生效。

## 补：长历史 /rewind 分页（同文更新 2026-09-08）

- `commandUi` popupSelect **打开时只加载一次 options、不做动态追加/增量渲染**（`ui-commands/src/client/popup.ts`：options once, filter locally）。需要“未加载历史也能选 + 每屏 5 条 + ↓ 分页”时，popupSelect 只能当**启动器**（单行 → `openPicker`），真正列表要**自绘**：复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（body portal、headless、Esc/遮罩 onClose）。
- 会话客户端只持有“已加载事件窗口”的节点（`chat` 视图）；更早内容要靠 `sessions.binding(id).session.loadOlder()` 逐页向后拉，然后**轮询 conversation 快照**直到节点数增长或 `hasMore` 翻 false（assembler 异步 flush）。
- `/rewind` 可用性要与已加载内容**解耦**：非 subagent、非 blank（`SessionSummary.blank`）即可选；面板空列表时自动 loadOlder，底部到 `hasMore=false` 为止。
- 自绘面板键盘：document capture 处理 ↑/↓/Enter 并 stopPropagation（避免命中 composer/Lexical）；Esc 交给 Modal 关闭。EscBridge 在 `__pickerSession===sessionId` 时必须**让行**（不停止底层回合）。面板归属用 module 级 `__pickerSession` + pub/sub，桥卸载/切会话要清理，防止旧会话重挂载时“复活”面板。

## v3 定稿（2026-09-08 二次迭代后，取代上文“自绘面板”方案）

- 实测教训：自绘 Modal 面板 + “按 ↓ 触发 `loadOlder()` 逐页 + 轮询节点数增长”在真实 GUI 不稳定（停在“加载中”不出新行，节点数不涨）。且用户要的是**一次性全量预读** + 沿用原生命令选择器，不是逐页动态追加。
- **正确做法**：打开 `/rewind` 时在 popupSelect 的 `options()` 里先 `session.loadThrough(0)`（SessionFace 自带“跳到最早”的翻页加载器，ChatView 跳转旧回合同款，内部自动翻完全部页）一次把整个历史读进客户端；随后 `waitForSettled`（轮询组装节点数稳定 2 次采样且 `hasMore=false`）再一次性返回全部选项。shell 在 options pending 期间原生显示“加载中”，读完后支持本地搜索/↑↓/滚动 → 列表可覆盖任意早的回合，无动态追加问题。
- 兼容：宿主无 `loadThrough` 时回退到 `loadOlder()` 循环（上限 400 页）。
- UI：不要自绘面板——复用原生 popupSelect（原生外观、自带 loading/空态/搜索/定位），插件只负责把 options 喂全。
- 可选：`options()` 开始时 publishToast 一条“正在读取全部历史…”给用户进度感（toast 走 composer 区域，不是面板）。

## v4：load-once + 缓存水位（2026-09-08）

- 每次开 `/rewind` 都 `loadThrough(0)` 属多余。策略：`refreshHistory()` 四级短路——
  1) 本页 `__fullLoaded` 且 `hasMore=false` → 直接读**活的会话快照**（窗口已锚定开头、新消息实时长尾，天然不丢最新）；2) `hasMore=false` 且能看到首个回合（`isFirst`）→ 认为已全覆盖；3) 有**内存/localStorage 记录**且 `watermarkSeq(≥)` 当前最新回合 → 直接出缓存，不发请求；4) 否则才全量 `loadThrough(0)` 并写缓存。
- 缓存条目 = 该会话全部用户回合（seq/anchorSeq/isFirst/time/全文本/imageRefs）+ watermarkSeq（最新用户回合 seq），localStorage 键 `dsh-esc-rewind.history.<sessionId>`，超 2.5MB 跳过持久化只留内存。
- **新鲜度**：缓存不直接信任——每次用「当前活窗口最新用户回合 seq」与 watermark 比较；有新内容就合并重载一次并刷新水位，因此“读缓存不会漏最新”。同页内新消息由活窗口直接覆盖（机制 1），无需触发重载。
- 选型执行：`onSelect` 从 `knownExchangesOf()`（缓存优先）按 seq 找回合，避免只读当前窗口而找不到旧回合；图片回退仍走 durable `attachmentId` 的 `readAttachment`。

## v5：删除模式（2026-09-08，grill 确认后新增）

- **需求**：回退后旧会话怎么处理可切换——默认归档，开关打开=真删。开关放**会话头右侧 actions 排**（图标档案柜⇄红色带叉垃圾桶，order 28，避开 schedule 10/job-list 20/open-workdir 25/chameleon 30），全局偏好、settings 持久化，无二次确认（用户已接受误触即永久丢失），但分层 toast 警示。
- **真删无官方客户端 verb**：`ISessions` 只有 create/open/archive 相关/clear/refresh/search；`workspaces.delete` 是删 **workspace 注册**（`api/workspace-controller/src/index.ts` 注释明言 *"while retaining files and Sessions"*）；核心 `session/disposed` 只是广播。真删必须**宿主半自建**（本机 `@huanlin/dsh-plugin-session-delete` 是范本：`fs.rmSync` 删 `~/.dsh/sessions/<slug>/<id>/` 两拼写 + `storageDomain` 清 `session_projcache`/`workspace` + `agents` 拒删运行中 + `sessions.store/detachEntered`）。esc-rewind 自建同款（`src/index.js`）但不依赖第三方。
- **node 半注册三件套**（全部懒/可选，`inject:[]` 不阻塞加载）：① settings 段 `esc-rewind.deleteOldOnRewind`（动态 import schemastery，同 provider-label 的坑：外部 link 插件静态 import 不保证解析）；② `webServer.register` `POST /__esc-rewind/session/delete`；③ 模型工具 `esc_rewind_session_delete`（动态 import `@deepseek-ai/dsh-tools`）。webServer/tools/schemastery 缺席都静默降级。
- **client 半读/写开关**：`remote.settings.describe()`（懒 `ctx.inject(['remote.settings'])`，shape 兼容 `scope.settings`/`scope['remote.settings']`/`scope.get('settings')`）读 `deleteOldOnRewind`；切换 `settings.update(ns, patch, undefined)` 无条件写；**describe 失败/缺字段一律回退 false**（绝不因读不到配置而误开删除）；`settings/document-updated`（ns===自己的）时重新加载。
- **安全时序**（D7）：删除永远在 **fork+open 新分支确认可用之后**；删除失败 → 降级 `workspaces.archiveSession` + toast「删除失败，已改为归档」，回退本身不失败。首轮降级（create 新空会话）同样按开关处置旧会话。
- **分层反馈**（D8）：切删除态 toast「已开启：回退将删除旧会话（不可恢复）」；删除态下首次 Esc 停止 toast 用 `esc.hint.delete`（警示文案）；执行后 toast「旧会话已删除」。module 级 `__t` 返回**翻译文本**（zh/en），seat `t` 返回 key——测试断言要区分（教训）。
- **测试坑**（harness）：`publishToast` 走 `__toastListeners`，纯逻辑调用（不经 React）不渲染 Toast → 测试需先 `mount()` 一个组件注册 listener 再 `rerender()`；`materialize` 需递归遍历 Fragment children（DisposeToggle 返回 Fragment[button, toast]）；`withFetch` 必须 `await fn()` 否则 finally 提前恢复 fetch；`mountHeader` 用 `freshInstance` 会丢 state → 用 `rerender`（beginRender）保留 slots。
- **真机 bug：client 绑定 `remote.settings` 时，全部探测放同一 try 会因 guard ctx 抛错短路**。真实 cordis client ctx 上**未注入名字的裸属性读取会 throw**（`cannot get property "settings" without inject`，provider-label 注释原话）；若 `bindSettings` 第一步 `scope.settings` 抛错且与后续探测共享一个 try，后面 `scope.remote.settings`/`get('remote.settings')` 全被跳过 → `__settings` 恒 null → 点击开关报「切换失败：settings-unavailable」。修复 = `readRemoteSettings(scope)` **每个候选独立 try**，顺序：`get('remote.settings')` → `scope['remote.settings']`（dotted 字面键）→ `get('remote')?.settings` → `scope.remote?.settings` → `get('settings')`（带 describe 形状校验）→ `scope.settings`；注入面：`ctx.inject(['remote.settings'])` 与 `ctx.inject(['remote'])` 双通道。
- **真机解析真相（我最初判断错误）**：从插件源码目录裸 `node` 探测 `import('@deepseek-ai/schemastery')` 会 FAIL（源码目录无 node_modules），**但宿主进程里 app-boot 重写了裸 specifier 的 `import()`**（`packages/boot/app-boot/src/index.ts` override import → `internal.import(specifier, bareModuleBaseUrl)`），路由到**安装 closure** `~/.dsh/profiles/node_modules/@deepseek-ai/`（含 schemastery/dsh-tools/dsh-settings，共 233 包）解析成功。所以宿主半的动态 import 在真机**可用**；用裸 node 探测是错误场景。验证宿主半已加载：`POST /__esc-rewind/session/delete` 带无效 id 应回 `{"error":"invalid session id: ..."}` 400。
- **RemoteResult envelope**：`remote.settings.describe()/update()` 返回 typert envelope `{ok:true,value}|{ok:false,error}`——解包必须 `unwrapResult`：`ok:false` 抛错（带 error.message/code），`ok:true` 取 `.value`；非 envelope 直接透传。
- **第二真机 bug：settings 段未注册（“namespace is not registered”）**。绑定修好后 update 仍被宿主拒绝，因为宿主半 `installSettingsSection` 依赖 `import('@deepseek-ai/schemastery')`，而**宿主解析 bundle 的裸 specifier 走插件源码目录**（title-regenerate 能静态 import `@deepseek-ai/dsh-llm` 只因为它源码目录自带本地 stub）——外部 link 插件目录无 schemastery → import 失败 → 段从未注册。修复 = **零依赖 fallback schema**：`SettingsProvider` 只用 `schema(value)`（resolve 校验/默认值）与 `schema.toJSON()`（describe 序列化），`redactSecrets(schema,…)` 对函数型 schema 走 default 分支原样放行（无 secret 声明即安全）。`fallbackSectionSchema(field, fallback)` 返回可调用函数 + toJSON，语义等同 `z.object({field: z.boolean().default(false)})`。installSettingsSection 现在：schemastery 可用用真 schema，解析失败/不兼容 → catch → 仍用 fallback 注册，`HOST_DIAG` 记录结果。
- **宿主半改动必须重启 GUI host**（client 半刷新页面即可）：`src/index.js` 新增只读 `GET /__esc-rewind/status`（返回 `settingsSectionRegistered`/`settingsSectionError`/`deleteOldOnRewind`，对应 ACCEPTANCE 5.10 探针）。
- 现有 **35 条 harness 全绿**（18 既有 + 10 删除模式 + 4 宿主半 + 3 settings-reader 回归）。

## v6（2026-09-12）：快捷键回退放宽到「尾部非 settled」

- **需求**：只要这一轮**不是正常结束**，就允许用 Esc 快捷键回退（之前只认尾部 `interrupted` + 空草稿）。
- **改动**：新增 `tailUnsettled(list)`（尾部非助手节点、或助手状态非 `settled` 即真；空/正常结束为假），`decideEsc` 非运行分支与 `EscBridge` 的 post-stop hint 改用同一判定；`tailInterrupted` 保留未删（仍导出，仅不再用于 armed）。运行态两次 Esc 语义不变（stop→rewind），草稿非空仍 disarm。
- **语义边界**：尾部是**刚发出的 user 提问（助手尚未回复）**也会进入可回退态，re重放到该提问本身——这是用户确认要的「撤销刚发出问题」。hid提示只识别 `interrupted` vs 其余非 settled，文案仍按 delete 开/关分两档。
- 细跑：`sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` 37/37 全绿（新增 2 条纯逻辑：user 尾回退、未知状态 assistant 尾回退）。

## v7（2026-09-12）：非运行态也两次 Esc（防误触）

- **需求**：v6 放宽后，非运行态一次 Esc 就直接回退，误触风险高。改为**非运行态也要两步**：第一次 Esc 只武装（记住 target + 提示「再按一次 Esc 回退本轮」），第二次 Esc（`stopIssued=true`）才真正 `doRewind`。
- **改动**：`decideEsc` 非运行态分支返回 `action:'arm'`（非 `stopIssued`）或 `action:'rewind'`（`stopIssued`）；document capture 的 `onKey` 新增 `arm` 分支——`consume()` + 设 `stopMarkRef.current = target.seq` + toast（`esc.hint`/`esc.hint.delete` 两档），**不调 `issueStop`**（没在运行）。复用既有 `stopMarkRef`/`stopIssued`，不新增状态；与运行态共用同一 ref（session 切换已重置）。
- **为什么新增 `arm` 而非复用 `stop`**：`stop` 分支会调 `issueStop`，语义是「取消运行中的回合」；非运行态复用会误触发停止逻辑。`arm` 分支语义清晰、零 `issueStop`。
- **建议勿改文档/文案膨胀**：首次按下沿用既有「再按一次 Esc 回退本轮」提示，不新增「已武装」独立文案（如要可后续扩展）。
- 细跑：esc-rewind 套件 37/37 全绿（3 条非运行态测试改写为「第一次=arm、第二次=rewind」），全仓库子插件 + manager 套件无回归。

## v7.1（2026-09-12）：post-stop hint 只在主动停止后弹（切进失败会话不提示）

- **缺陷**：post-stop hint effect（给工具栏 Stop 补「再按 Esc 回退」提示）的触发只看「尾部非 settled + 草稿空」，不检查是否本会话内主动停止过 → **切换进一个本就非正常结束的会话（如 429 失败轮、被打断历史轮）时也会自动弹提示**，时机错误。
- **根因**：`hintedRef` 是 per-`target.seq` 守卫、切会话不重置；effect 触发条件无「是否刚停止」判定。
- **修复**：新增 `prevRunningRef`（session 切换时重置为 null），hint effect 改为**仅当 `running` 在本会话内发生 true→false 下降沿**（即用户主动 Stop / Esc 停止）且尾部非 settled、草稿空时才提示。切进失败会话 running 全程 false、无下降沿 → 不弹。
- **为什么不用 `unsettled` 上升沿**：`tailUnsettled` 对 running 尾也返回 true，运行中 unsettled 已为 true；工具栏 Stop 前后 unsettled 恒 true，无上升沿可用。真正区分「主动停止」的是 running 下降沿。
- **测试**：新增 2 条（切进 unsettled 会话不提示、工具栏 Stop 提示一次），套件 39/39 全绿；全仓库无回归。

## v7.2（2026-09-12）：提示时机改为「宿主耐久停止证据」（修「自然结束仍弹提示」）

- **缺陷**：用户报告**正常的输出结束后仍自动弹出**「已停止 · 再按 Esc 回退本轮」。v7.1 的守卫（本会话内 running 有过 true→false 下降沿）方向对、判据错。
- **根因（三层，全部代码核对过）**：
  1. **下降沿不唯一**：`agent/status` 的 `running` 覆盖整轮（`core/agent/src/runtime-types.ts`：从唤醒输入起、持续到 driver drain/close/checkpoint），正常收尾同样置 false。
  2. **两个输入两个 store**：`running` 走宿主 `agent/status` → `api-session/status` 广播（`api/session-controller/src/index.ts:143`）→ 客户端 `$on`（`client/index.ts:94`）→ `Session.handleRunning()` → notifier 微任务（`sessions/session.ts:498`）；`unsettled ← chat.legacy.nodes` 走每会话事件 journal → `BoundConversation.accept` → assembler → `publish()`（高频流式行按 3 个动画帧延迟发布，`ui-conversation/.../assembly.ts:121-137`）。同一帧里读两者不成立。
  3. **运行中的 assistant 在插件读的那份列表里不存在**：`LegacySliceBuilder.legacyContribution` 对 `assistant-step` + `status==='running'` 返回 `nodes: EMPTY_LIST`（内容只进 `partial`）⇒ 下降沿那一帧的尾巴是**本轮刚发出的 user 提问** ⇒ `tailUnsettled()` 为真 ⇒ 误弹。
- **harness 为什么没抓到**：既有「工具栏 Stop 提示一次」用例把 running 与 interrupted 尾巴**在同一次 rerender 里**同时赋值，构造不出真机那一帧；且 `chatOf()` 返回 `legacy: null`（view-node 分支），而真机走 `chat.legacy.nodes` 分支。只读探针（复用 harness 前半段 + 追加用例）复现：只下下降沿 → toast 出现；两者同帧 → 不出现。
- **新判据（只用宿主耐久证据）**：
  - 停止证据：尾部 assistant 行带 `interrupted`（`core/agent-loop/src/agent.ts:374-383` 仅在 `signal.aborted` 且有内容时写）；或该轮 `turn/end` 为 `{kind:'aborted', reason:{kind:'user'}}`（`agent.ts:313/328` + `api/session-controller/src/commands.ts:446`，工具栏 Stop 与本插件 `session.cancel()` 同源）——后者覆盖「尚无内容即被停」。
  - 自然结束证据：尾部 assistant 为 `settled`，或该轮 `turn/end` 为 `completed`/`error`/`max-tokens`/`blocked`（`turn/end` 的 `interrupted` kind 是**崩溃修复**标记、loop 不产出，不能当停止证据）。
  - **下降沿只用来记候选回合**（证明本会话刚结束一轮），候选等该轮**定型**后结算 → 对「running 位 / 对话投影谁先到」双向免疫；候选绑定最后一轮 user seq，发新消息/切会话即作废。
- **新增纯函数**：`tailStatus(list)`（尾部 assistant 行状态或 null）、`lastTurnEndEvidence(chat)`（读 `chat.timeline.turnOrder/turns[n].end.data.reason`，返回 `aborted:user` / `completed` / …）。`tailUnsettled()` 继续只服务 **Esc armed 判定**（按键时用实时 list 重算，不受本缺陷影响）。
- **顺带**：`decideEsc` 调用点的 `unsettled` 是**死参数**（函数内用 list 重算）已删除；`__diag` 增 `hintToasts` / `lastHint`（此前 hint effect 不写任何诊断，缺陷无法自证）。
- **测试**：套件 49/49（新增真机形态构造器 `legacyUser/legacyAssistant/legacyChatOf` + 10 条：自然结束不弹（含投影落后）、下降沿只记候选、无内容停止走 `turn/end aborted/user`、非 user 的 abort/失败轮不弹、切进历史中断会话不弹、草稿非空消耗候选不弹、确定停止证据优先于 settled 尾的歧义情形、删除模式文案、纯函数契约与形状容错）。**红绿验证**：把新用例跑在 `HEAD` 版 client.js 上 8 条全红（41/49），跑在当前实现上 49/49。
## v7.3（2026-09-12）：宿主 0.1.5-rc.2 适配——草稿附件一族改名，改走能力探测双代兼容

- **触发**：DSH 升级到 `0.1.5-rc.2`（源码检出 `D:ChenSirDocumentGitHub-Projectsdeepseek-harness`，`git describe` = `dsh-v0.1.5-rc.2-2-g30841f98c8`）。
- **核对方式（可复用，详见 `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md`）**：`git diff --name-only dsh-v0.1.2-rc.1..dsh-v0.1.5-rc.2 -- packages/client packages/api packages/core/session` 圈出 252 个变更源文件（去测试）→ 每个文件抽「公开成员名」（`^s+(readonly )?name(:|()`）求两 tag 差集 → **只对出现删除的文件**读代码确认；再用生成物 `slot-catalog.ts` / `api-catalog.ts` 做槽位与客户端 API 的二道核对。
- **唯一实锤失配（同一族改名，三处）**：

  | 0.1.2-rc.1 | 0.1.5-rc.2 | 本插件用处 |
  | --- | --- | --- |
  | `conversation.createDraftImages(files)` | `createDrafts(sessionId, files)` | 回退时把耐久图片引用变回浏览器草稿 |
  | `conversation.releaseDraftImage(id)` | `releaseDraftAttachment(id)` | 回退中途失败时释放未采用的草稿 |
  | `inputActions.addImages(ids)` | `addAttachments(ids)` | 分支挂载后把草稿 id 交回编辑器 |

  （同族的 `removeImage`→`removeAttachment`、`pruneImages`→`pruneAttachments`、`InputState.imageIds`→`attachments`、`ComposerAttachmentsOwnerProps.onAddImages`→`onAddFiles` 本插件未使用。）
- **为什么不是「版本号分支」**：仓库既有约定就是**能力探测 + 降级 + 失败可见**（见 `2026-09-09-plugin-host-half-no-core-import.md`、provider-label 的 `readRemoteSettings`）；且用户当前仍跑 0.1.2-rc.1，双代兼容让**同一份代码两边都可用**。
- **改动**：新增三个桥接纯函数——`createDraftAttachments(conversation, sessionId, files)`、`releaseDraftAttachment(conversation, id)`、`restoreDraftAttachments(actions, ids)`；每个内部先探新名、再回退旧名，三个调用点改为统一入口。`__diag` 新增 `draftCreateApi` / `draftRestoreApi`（`'createDrafts'` / `'createDraftImages'` / `null`），把「这一代核心到底给不给草稿能力」变成**可见诊断**；三个函数进 `_module` 导出供 harness 断言。
- **行为不变**：图片还原仍是 best-effort（字节读不到就只还原文本），两代都缺时静默跳过、**回退本身照常成功**；`imageFail` 诊断保留；删除模式、提示时机等一概不动。
- **测试**：套件 **54/54**（原 49 + 新增 5：新世代建草稿且回填、旧世代同场景、两代各一条「建完草稿后中途失败要释放」、两代都缺静默降级）。**红绿验证**：新用例跑在 `HEAD` 版 `client.js` 上 4 条红（新世代两条是能力断言 `0 !== 1`；旧世代与降级两条红在新增诊断字段 `undefined`），跑在当前实现上 54/54。
- **顺带核对为未变**（清单见适配审计篇）：五个槽位名与标准 props（只新增 `useResource`/`usePanelInfo`）、`chat.legacy.nodes`、`timeline.turnOrder`/`turns`/`TurnLocation.end`、`turn/end` 的 `aborted` + `AgentCancelCause{kind:'user'}`、`assistant/message{interrupted:true}`、`sessions.binding|fork|open|create|list`、`workspaces.archiveSession|list|openPath`、`commandUi.register`、`remote.session.modelCatalog|selectModel`、`connection.api.host.openPath`、宿主 `sessions.get|flush|store|detachEntered`、`agents.get|cancel|whenIdle`、`storageDomain`；侧栏 `sessionRow/searchTree/searchExpanded/listArea/flatList/sectionHeader/headerActions` 与 `[data-composer-input]`、`dsh.workspace.view.v5`、profile `cordis.patch.yml` 与 `dsh plugin` CLI 也都未变。
## v7.4（2026-09-12）：真机 0.1.5-rc.2 上的两个缺陷（/rewind 消失、回退后同一条消息被执行又被挂起）

### 缺陷 1：`/rewind` 在 0.1.5 上从 `/` 菜单消失

- **根因（类型级契约变更——v7.3 审计方法漏掉的那一类）**：`CommandContribution.description` 在 0.1.2-rc.1 是 `readonly description: string`，0.1.5-rc.2 改为 `readonly description: () => string`，候选装配相应改为 `description: contribution.description()`（`packages/client/ui-commands/src/client/service.ts:217`）。本插件传的是**字符串** ⇒ 核心调用它时抛 `TypeError` ⇒ 整个候选装配失败 ⇒ 命令不出现。
- **为什么 v7.3 没抓到**：那轮审计只对撞了**成员名**（`description` 两版都在 ⇒ 不进「只删不加」的差集），没有对撞**类型签名**。已把「类型级差分」补进审计方法（`docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md` 步骤 2b）。
- **为什么不能双形态共存**：旧核心把该值**直接作为 React 子节点**渲染（`MenuView.tsx:157` 的 `<span>{item.description}</span>`），函数会抛 `Functions are not valid as a React child`；新核心则必须拿到可调用的函数。同一个值不可能两边都对，所以只能探测。
- **改法（能力探测，不读版本号）**：`description` 写成 **getter**，读取时按 `__commandDescShape` 决定返回字符串还是函数；世代判定用两个 0.1.5 才有的能力信号——新增的 `main.conversation` 槽位注册成功、或槽位新标准 props（`usePanelInfo`/`useResource`）出现。结果落 `__dsew.commandDescShape`。

### 缺陷 2：回退后「同一条消息被执行了、又有一条在等待」

- **真机取证（会话日志就是耐久真相）**：多帧 zstd 日志要用 `zstandard.stream_reader(..., read_across_frames=True)` 才能整份解出（Node 的 `zstdDecompressSync` 只解第一帧，会误判成「只有 1 行」）。`~/.dsh/sessions/.../session-8c693ecf-.../session.v3.jsonl.zstd` 的事件流：
  - `#78 turn/end {aborted, reason:{kind:'user'}}`（Esc 停止，本插件）
  - `#79 agent/inbox/spliced` 插入用户消息 A —— **刚发出、尚未落盘**
  - `#80 session/end-seed {inherited:true}` ★ fork 切点：种子把 `#0..#79` 整段复制进子会话
  - `#81` 子会话里用户又发出 B（回退还原出来的文本）→ 排在 A 之后
  - `#85` A 落盘并被执行；B 直到 `#160/#167` 才被消费
- **根因**：0.1.5 把 agent 收件箱写进**事件日志**（`agent/inbox/spliced`），而 fork 用事件种子重建子会话 ⇒ 父会话里那条 pending 输入被复制进新分支，并被新分支的 agent 执行；用户看到的就是「一条在执行、一条在等待、内容相同」。
- **为什么「删一次」不够**：删除同样要作为事件落进日志，而且必须落在**切点之前**，子会话重放种子时才看不到这条插入 —— 所以必须「删 + 等快照确认」。
- **改法**：新增 `settlePendingInputs(sessionId, { budgetMs })`——循环「读快照 → 对每条排队项 `updateQueue(id,{kind:'remove'})` → 等 60ms」，直到快照确认没有排队项或用尽预算（默认 1500ms）。`doRewind` 在 fork **前**调用；`empty === false` 时返回 `{ ok:false, code:'pending-input' }` + toast「该会话还有没发出的消息在排队…」并**放弃回退**（宁可不回退，也不复制一份输入过去）。`sessions.open(childId)` 之后再跑一次 600ms 兜底清理，条数记进 `__dsew.childPendingCleared`。
- **测试**：套件 **60/60**（新增 6 条：命令契约三条——旧核心字符串 / 新核心函数 / 第二信号 props；未落定输入三条——清空后照常 fork、清不掉则拒绝回退且不 fork 不归档、子会话继承残留被清掉）。**红绿验证**：新用例跑在 `HEAD` 版 `client.js` 上 **50/60**（10 条红 = 4 条草稿桥 + 3 条契约 + 3 条 pending），当前实现 **60/60**。
