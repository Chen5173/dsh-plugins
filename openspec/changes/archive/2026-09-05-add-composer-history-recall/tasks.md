## 1. 包骨架与可安装性

- [x] 1.1 建 `dsh-composer-history-recall/package.json`：`keywords:["dsh-plugin"]`、`type:"module"`、`main:"src/index.js"`、`exports{".","./client","./package.json"}`、`files:["src/","cordis.patch.yml","README.md","ACCEPTANCE.md"]`、`dsh.bundle.patch:"./cordis.patch.yml"`、`dsh.client:{inject:["@deepseek-ai/dsh-client-runtime"],platform:"web"}`、peer 下限 `@deepseek-ai/dsh-client-ui-primitives`；验证：`node -e "require('./dsh-composer-history-recall/package.json')"` 无错（已执行），`npm pack --dry-run` 产物只含 6 个声明文件、无 `node_modules`/`openspec` 泄漏（已执行）
- [x] 1.2 写 `src/index.js`：只导出空 `apply()` + `inject:[]` + `name`，注释说明「空 node 半让包成为 Loader 条目，真实逻辑走 `exports["./client"]` + `dsh.client`」（照 `dsh-open-session-workdir` 形态）；验证：`node --check src/index.js` 通过（已执行）；`dsh web` 启动加载与 `dump-config` 可见属宿主冒烟，记于 ACCEPTANCE 1.1
- [x] 1.3 写 `cordis.patch.yml` 的 `- insert:` 单行（`id: composer-history-recall`、`name: 'dsh-composer-history-recall'`）；验证：结构与已验证的同构插件逐字节同形（已核对）；安装幂等（重复 `add` 不产生第二行）属宿主冒烟，记于 ACCEPTANCE 1.4

## 2. 客户端注册与惰性门控

- [x] 2.1 `src/client.js` 建立 bundle 协议：`window.__ModuleLoader__.load({ id:'<pkg>', factory })`，classic script、无 JSX、`React.createElement`，factory 返回 `{ apply, inject:['slots'] }`；在 `conversation.input.overlay` 注册一个默认渲染 `null` 的桥接组件（design D1）；验证：harness 断言注册槽位/id/order 与 capture 阶段挂载（已执行）；DevTools Network 200 属浏览器冒烟，记于 ACCEPTANCE 1.2
- [x] 2.2 能力缺席惰性（design D7）：`inputActions` 或 `useConversation` 缺失（无会话 / 非 web 表面）时组件返回 `null` 且不挂任何监听；验证：harness「unfocused composer ignores the arrow keys」断言无 setDraft、无 consume（已执行）；overlay 为 session-scope，无会话即不挂载
- [x] 2.3 历史派生（design D3）：从 `useConversation` 时间线过滤 `kind==='user'` 节点、拼接其 `text` 块为一条、丢弃空串，得到「最新在前」的 `history`，用 `useMemo` 绑定会话/时间线版本；验证：harness「history is newest-first, user-only, blanks dropped」（已执行）

## 3. 方向键门控与召回

- [x] 3.1 在 composer 的 contenteditable 根挂 **capture 阶段** `keydown` 监听，处理 `ArrowUp`/`ArrowDown`（design D1）；验证：harness「ArrowUp on an empty focused composer recalls the newest sent message」——填入最近一条、会话无新增（已执行）
- [x] 3.2 首/末行判定（design D2）：由 DOM Selection 折叠光标算所在块索引，`↑` 需 `line===0`；不满足直接 `return` 放行给编辑器；验证：harness「multi-line draft with caret on a middle line does not hijack ArrowUp」与「caret on the first block ... enters browse」（已执行）
- [x] 3.3 含引用 chip 时不接管（design D2）：`useInput().occurrences.length > 0` 时放行方向键；验证：harness「reference chips in the draft suppress recall」（已执行）
- [x] 3.4 与触发菜单互斥（design D5）：命中门控但光标前文本处于 `/` 或 `@` token 时放行；验证：harness「an active slash/mention token suppresses recall」（已执行）
- [x] 3.5 游标推进与边界（design D4/D6）：首次 `↑` 快照 `savedDraft` 并 `index=0`；连续 `↑` 逐条更早、越界停在最早并 `Toast`「已到最早」；连续 `↓` 逐条更新、`index` 减到 `-1` 退出浏览并 `setDraft(savedDraft)`；验证：harness「consecutive ArrowUp walks older; boundary stays and toasts」「ArrowDown past newest exits browse and restores the saved draft」「entry from a non-empty first-line draft preserves it as savedDraft」（已执行）
- [x] 3.6 接管时 `preventDefault()`+`stopPropagation()`、未接管时不干预；验证：harness 各 `press` 断言 `prevented` 真/假与 `drafts` 是否变化（已执行）

## 4. 游标重置

- [x] 4.1 外部编辑检测重置（design D4）：记录本组件最后写入的草稿串，提交后的 `draft` 与之不符即判为手动编辑、`index=null`；验证：harness「manual edit while browsing resets the cursor to newest」（已执行）
- [x] 4.2 发送后重置（design D4）：发送后草稿被清空/改写命中同一「draft≠lastWritten」路径、`history` 纳入刚发送消息；验证：harness 编辑重置走同一机制（已执行）；真实回车发送回归记于 ACCEPTANCE 6.2
- [x] 4.3 切换会话重置（design D4）：`sessionId` 变化时在 effect 里 `index=null` 且重算 `history`；验证：harness「switching sessions resets the cursor and uses the new history」（已执行）

## 5. 文案与主题

- [x] 5.1 `ctx.locale.register(NS,{zh,en})` 并在注册项声明 `locale:NS`，`locale/change` 后刷新（design D8）；验证：harness「locale dictionaries are registered under the plugin namespace」+ 边界 Toast 走 `t('toast.oldest')`（已执行）；切英文不刷新的实时生效记于 ACCEPTANCE 7.2
- [x] 5.2 若渲染任何可见反馈（仅 Toast），颜色只用 `--dsw-*` token、不硬编码；验证：深浅色主题各触发一次边界提示，无对比度失效——**需真实浏览器**，见 ACCEPTANCE 7.3（2026-09-10 用户真机确认通过）

## 6. 集成验收与交付

- [x] 6.1 写逻辑 harness `test/bundle.test.mjs`（自带 hook shim 与假 composer DOM，无 jsdom），覆盖 2.3 / 3.1–3.6 / 4.1–4.3 / 5.1 的可断言部分；验证：`node dsh-composer-history-recall/test/bundle.test.mjs` → 20/20 passed（已执行）
- [x] 6.2 逐条走查 `specs/composer-history-recall/spec.md` 的 7 条 Requirement 全部场景并记录；验证：`openspec validate add-composer-history-recall --strict` → valid（已执行）；15 个场景逐一对应 harness 断言（见 README「开发」段映射）
- [x] 6.3 只读回归：召回前后比对当前会话 id、对话内容、滚动位置，以及 `~/.dsh/sessions/<slug>/<id>/session.jsonl.zstd` 的 mtime 与大小；验证：四项均无变化——**需真实宿主会话日志**，见 ACCEPTANCE 8（2026-09-10 用户真机确认通过）
- [x] 6.4 与 `dsh-open-session-workdir`、`@huanlin/dsh-plugin-session-delete` 共存安装；验证：无 slot 项 id 冲突、各自可用、方向键召回与头部按钮互不影响——**需真实安装环境**，见 ACCEPTANCE 9（2026-09-10 用户真机确认通过）
- [x] 6.5 写 `README.md`（安装/卸载含 `disabled:true` 回滚、所需核心版本下限、逻辑行语义与「不抢多行光标/触发菜单」说明、以及「本插件不含任何宿主端点」）与 `ACCEPTANCE.md`（人眼验收清单）；验证：两份文档已交付（`npm pack --dry-run` 已含二者）；照 README 在干净 profile 从零装一遍属宿主冒烟，记于 ACCEPTANCE 1
