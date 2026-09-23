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

## v7.5（2026-09-13）：v7.4 只修了一半——fork 种子**必然**带出被回退那条消息，还原时序又输给 React 提交

用户报「0.1.5-rc.2 上：① 回退后信息没回到对话框；② 回退后再发消息，新消息排队、之前的信息继续被执行」。逐条复看会话日志 + 宿主源码后，v7.4 的结论要**修正**：

- **② 的主因不是「父会话此刻还 pending」，而是 fork 切点本身**。宿主 `commands.fork`（`packages/api/session-controller/src/commands.ts:202-275`）：
  `boundary = 第一个 seq ≥ atSeq 的 turn/end`，然后 `cut = boundary.seq+1`，并 `while (cut < len && events[cut].type !== 'turn/start') cut++`。被回退那条消息的 `agent/inbox/spliced`(insert) 恰好排在**它自己的 turn/start 之前**，而 claim (`removedCount:1`) 排在 turn/start **之后** ⇒ 种子 = `[0, cut)` 里只有 insert、没有 claim ⇒ 子会话的 `inbox` 投影（`core/agent-loop/src/inbox.ts` 是事件 fold，**耐久**且随页面 baseline 下发）里就有一条继承来的 pending 旧消息。用户重发时 agent 先 claim 它（`start=0`）并执行，新消息排队 —— 真机三例完全对上：`8c693ecf`（23:19:52 fork，子会话 23:20:16 执行继承的 `e35e7ff4`）、`1aacc7bb`（10:46:53 fork，10:52:58 执行继承的 `858a838b`，用户 10:48/10:52 发的两条在等）、`716995b9`（三次「继续」，先执行继承的 `e947d3bb`）。**结论：这不是竞态，是结构性泄漏，父会话清队列永远清不到它。**
- **v7.4 的守卫看不到它**：`settlePendingInputs` 只读客户端 queue 镜像 `snapshot.queue`；宿主 queue 帧只在「有活跃 agent 且 session 匹配」时广播（`control.ts:29-40`），而同一次变化的 `projection` 帧（key `inbox`）是无条件广播的；刚按下回车的输入还可能只存在于本地回声 `pendingSubmissions`（`QueueDock` 就是拿它显示「等待中」）。日志里 fork 前**没有任何 removal 事件**，与「守卫看到空队列」自洽。
- **① 是还原时机**：`doRewind` 原本 `open(child) → await settlePendingInputs(child,600) → armPendingRestore(...)`；中间的 await 会 sleep（正是②的子会话有 pending 的场景），React 先提交子会话挂载，还原 effect 第一跑读到 `__pending === null` 直接 return，而它只按 `[sessionId, draft, inputActions]` 重跑 ⇒ 那次还原永久丢失；用户一打字（draft 变化）还会把它清掉。harness 旧用例是在 `doRewind` 全部结束**之后**才挂载子会话，正好绕开了真实顺序。
- **改法（客户端，两处一起修）**：
  1. `pendingInputsOf(sessionId)` 三来源合一：宿主 `inbox` 投影（`session.projections.faceOf('inbox')`，随页面 baseline 到达）∪ queue 镜像 ∪ 未对账的 `pendingSubmissions`（queued/steering 且其 rpcId 未出现在任何宿主行）。`settlePendingInputs` 用它做「删 + 等确认」，`clearQueue` 也复用同一判定。
  2. **fork 前**清父会话（清不掉仍 `code:'pending-input'` 放弃回退）；**open 分支后**再清一次子会话（继承项只在这里可见），预算 900ms、`budgetMs` 内用 `requireProjectionMs` 宽限等投影到场——只有本页见过 `inbox` 投影（`__dsew.inboxProjectionSeen`）才等，旧核心不多等一分。
  3. `armPendingRestore` 提到 `sessions.open(childId)` **之前**（`__pending` 按 childId 键控，父会话的桥不会消费）；补模块级武装通知（同 `__toastListeners`）让「武装晚于挂载」也能补跑；「一次回退只回填一次」改为「已回填的会话 id」而非一次性布尔 ref（旧写法同页第二次回退永不回填）。
- **诊断**：`__dsew.pendingSource / childPendingSource`（`inbox-projection` `queue-mirror` `echo`）、`pendingConfirmMs / childPendingConfirmMs`、`pendingStaged / pendingApplied / pendingLateArm / pendingDropped`、`inboxProjectionSeen`。
- **测试**：套件 **67/67**（新增 7 条：投影通道清父会话、未对账回声拦住回退、子会话继承项被清、子会话先挂载仍还原、同页二次回退仍还原、晚武装补跑、无投影时降级走 queue 镜像）。**红绿验证**：7 条新用例跑在 v7.4 的 `client.js` 上 **60/67**（7 条全红，报错点分别是「投影项没被删」「回声时仍 fork」「子会话继承项没被删」「晚武装没回填」「第二次没回填」），当前实现 **67/67**。
- **顺带**：`dsh-open-session-workdir/test/interception.test.mjs` 失败（`isFolderRevealPath not found in client-registry.js — their bundle changed shape`）与本插件无关，是既有的宿主 bundle 形状漂移，未修。（2026-09-22 复跑已绿：该漂移被上游修掉。）

## v7.6（2026-09-22）：删除模式加子代理守卫——「会话还挂着子代理就不真删」

- **触发**：用户报「主 agent 跑着子代理、主 agent 停下等它的完成通知时 rewind 回退（删除模式）」→ 主会话被真删，**子代理不见了、也没挂到新会话上**。
- **真机取证**（`D:\dsh\.dsh_home`；settings 里 `esc-rewind.deleteOldOnRewind: true`）：被删父会话 `session-e71582a6` 的子代理 `6455048f`（`subagent/descriptor{mode:'continuable'}`，label「Mac 侧重建与回归流水线」）**在父会话被删后 8 分钟仍在写日志**（turn 2 从 14:09 起未结束）⇒ 完成通知永远送不出去；同期 `session-cbec2279` 被删后留下 **24 个** 子代理孤儿（全库扫描：98 个会话里 27 个「父不在磁盘上」的孤儿子代理）。
- **根因（宿主才是真源，四条都核对过）**：① 子代理**只能靠自己的 header** 被枚举（`subagent/src/list-children.ts:90` 过滤 `header.parentSession === parentId && origin === 'subagent'`）⇒ 父日志一删就永久失去入口；② 完成通知投给**父会话 agent**（`subagent/src/continuation-activation.ts:823` `notifySettlement` → `ctx.agents.get(parentSession)`，父缺席**静默 return**）；③ 侧栏根本不列子代理行（`client/ui-workspace/src/client/tree.ts:146` `origin !== 'subagent'`），入口只有父会话的子代理目录；④ 投递授权按 header 的 `parentSession` 校验（`api/session-controller/src/history.ts:346`、`src/agent.ts:85-91`）⇒ **新分支接管不了旧子代理**，宿主也**没有** reparent/adopt verb（全仓 grep 无生产者）。
- **修法（方案 A，用户选定）**：宿主半新增 `subagentGuardOf(ctx, sessionId)`，`deleteSessionCore` 在**任何破坏性动作之前**用官方服务 `ctx.subagents.listChildren(sessionId)` 探一次：有子代理（running 或 inactive）→ 抛 `409 + {reason:'subagents', children, running}`；listing 抛错 → `409 + subagents-unknown`（fail-safe）；`subagents` 服务缺席 → 放行（无运行时尚无法拥有子代理）。客户端解析结构化 `reason` 后走既有降级路径**归档** + 专用 toast（含 N/M 计数），`deleted:false`。
- **可复用要点**：① 宿主拒绝要表达成**结构化 reason** 而不是文案，客户端才能给准确提示；② 「读不到就拒删」与仓库既有的「describe 失败一律回退归档」是同一条安全侧原则；③ `ctx.subagents.listChildren` 是插件**不必 import 核心包**就能用的官方缝（返回 `activity: running|inactive`）；④ **「子代理改挂到新会话」在现有核心不可能**——header 是日志首事件、不可变，别在这条路上设计功能。
- **测试**：套件 **74/74**（新增 6 条：客户端「宿主拒绝 → 归档 + 专用提示」「未知态 fail-safe」；宿主「有子代理即拒绝且磁盘/存储零改动」「未知态拒绝」「空列表或缺服务照常删」；端点「409 透传且守卫先于任何磁盘动作」；另 capability audit 增 4 条两侧字面量一致性断言）。**红绿验证**：新用例跑在 HEAD 版源码上 **66/74**（8 条全红）。全仓库 sweep（管理器 4 支 + 子插件全部）无回归。

## v7.7（2026-09-22）：设置入口收拢为「本地插件」一级入口 tab + 孤儿子代理回收

- **需求**（用户拍板）：① 设置里只留**一个入口**，本仓各插件的内容以 **tab** 切；② 回收历史孤儿——只做「停止运行中的孤儿」与「找回成普通会话」，**不做删除**，且**全手动**。
- **核心已有这套机制（本轮只读核对）**：`ui-settings-plugins` **独占唯一的「插件」导航行并渲染 tab chrome**（源码注释：*owns the one Plugins navigation entry and the tab chrome; feature plugins contribute pages without competing for Settings nav rows*），它在运行期声明列表槽 `settings.localPlugins.tab`（`kind: 'list', scope: 'root'`，owner props 为空），tab 首次选中才挂载、之后保持挂载。**贡献范式**（范本 `packages/client/ui-settings-plugin-inventory/src/client/index.ts`）：`ctx.slots.inject('settings.localPlugins.tab', () => ctx.slots.register({ name, id, order, label, locale? }, Component))`。⚠️ **插件不能凭空造设置导航行**：slot registry 只允许注册到**父项已声明**的子槽，未声明槽 `register` 直接抛 `slot "<name>" is not declared`。
- **迁移映射**（只改注册行、组件零改动——三处组件都不吃 `settings.section` 的 owner props）：`dsh-plugin-manager` `local-plugins` 16 → tab **20**；`dsh-hindsight-model` 17 → tab **30**；`dsh-idle-hook` 19 → tab **40**；esc-rewind 新增 tab `subagents` **50**（核心自带 `configurable` 0 / `all` 10 在前）。
- **孤儿 = 可达性（传递）**：`origin === 'subagent'` 且其 `parentSession` 缺失、或父自身也不可达。依据：侧栏不渲染子代理行（`client/ui-workspace/src/client/tree.ts:146`），子代理只能从**父会话的子代理目录**进入（`subagent/src/list-children.ts:90` 按子会话自身 header 的 `parentSession` 列举）⇒ 父一删，整棵子树彻底没有入口。
- **找回 = fork 成普通会话**：宿主半只读扫描给出行（含 `atSeq` = 最后一个 `turn/end`、`canRescue`），客户端用官方 `sessions.fork({sessionId, atSeq})` + `rename(label)` + `open(childId)`；`commands.fork` 的语义（新会话 `origin` 空、`isSeeded`、沿用源 workspace）使新会话**侧栏可见且可继续**——这是现有核心下让孤儿「重新可用」的**唯一**路子；原孤儿不删；运行中的孤儿**先停再 fork**（未落盘内容进不了种子）。
- **宿主半只读扫描的两个细节**：语料用 `sessionQuery.listSessions()`（一次拿全量 header 判可达性）；逐项 label/`atSeq` 用 `sessionQuery.observeSession(id, { projectionMode: 'none' })` —— 观察对象是 **`Disposable`**，用完必须 `observation[Symbol.dispose]()` 释放租约（不释放会 pin 住冷读缓存），并发上限 4、单条失败只降级该行。
- **停止的诚实语义**：`agents.get(id)` 不存在 → `not-running`（幂等 no-op）；存在 → `cancel({kind:'user'})` + 有上限地等 `whenIdle()`；等到 → `confirmed:true`，超时/信号失败 → `confirmed:false` + reason，**绝不谎报成功**。
- **可复用要点**：① 想给设置页添东西，先找**核心已经声明好的槽**（`settings.localPlugins.tab` / `settings.plugin.item` / `settings.general.item`），别自建导航行；② 「不可达/孤儿」这类判定要按**用户实际能进哪条路**（可达性）定义，而不是只看一条字段是否存在；③ 插件改不了别人的会话 header，所以「让孤儿复活」只能靠**复制出普通会话**，不能靠改挂。
- **测试**：esc-rewind 套件 **89/89**（v7.7 时新增 12 条；2026-09-22 追加「删除孤儿」再 +3 条：宿主「orphanSetOf 四态」「只读扫描（label/canRescue/running/释放租约）」「单条失败降级 + 缺服务」「stopOrphanRun 三态」「孤儿端点 4 组」；客户端「tab 注册 + 旧核心降级」「打开只读 + 渲染」「空/失败态」「停止 POST + 未确认静默」「找回链路（先停→fork(atSeq)→沿用标签→open）」「无回合禁用 + 批量勾选」「全手动不变量」），其余三插件注册断言同步更新；**红绿**：新用例跑在 `HEAD` 源码上 esc-rewind **17 红**、manager **1 红**、hindsight **1 红**、idle-hook **1 红**，实现后全绿；管理器 4 支 + 子插件全量 sweep 无回归。

### v7.7 修正（2026-09-22，用户反馈）：设置页要「自建一级入口 + 内部 tab」，不是塞进核心「插件」页

- 用户否决了"把本仓各插件的设置页贡献到核心 `settings.plugins.tab`"：核心「插件」页会与其它内容混杂。要的是**设置左侧新增一个自有的一级入口「本地插件」**，各插件面板作为它内部的 tab。
- 先前结论有误：`settings.section` 本身就是核心声明的 list 槽，**任何插件都能注册自己的一个一级入口**，并在该注册里用 `children` 声明自有子槽、自己渲染 tab chrome（核心 `ui-settings-plugins` 用的正是这套）。
- 落地形态：`dsh-plugin-manager` 注册 `settings.section`（id `local-plugins`，order 16，label「本地插件」）+ `children: { "settings.localPlugins.tab": { kind: "list", scope: "root" } }`；自己的管理面板是第一个 tab（id `plugins`，order 0）；三个子插件注册到 `settings.localPlugins.tab`（esc-rewind `subagents` 50 / hindsight 30 / idle-hook 40）。
- 自建 tab chrome 的两个关键点：① tab 台账用 `ctx.slots.entries(slot)` + `ctx.slots.subscribe(slot, …)` 自己订阅；② 当前 tab 用 `props.renderSlot(slot, {}, { only: id })` 挂载，并"首挂载后保持挂载"（切回来不丢草稿）。
- 副作用：入口归管理器所有 ⇒ **管理器被停用时这些 tab 一并消失**（"一个入口"的代价，与用户预期一致）。
- 同批反馈的 UI 打磨：孤儿面板按钮改成与核心卡片同几何（`.5px var(--dsw-alias-border-l3)` / radius 6 / height 26 / padding `0 10px`），破坏性动作（停止）用 `--dsw-alias-state-error-primary` 描边；每行操作**右对齐**（`marginLeft: auto`），行内元信息收进左侧两行。
