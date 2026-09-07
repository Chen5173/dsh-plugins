## 1. 包骨架与可安装性

- [x] 1.1 建 `dsh-composer-provider-label/package.json`：`keywords:["dsh-plugin"]`、`type:"module"`、`main:"src/index.js"`、`exports{".","./client","./package.json"}`、`files:["src/","cordis.patch.yml","README.md","ACCEPTANCE.md"]`、`dsh.bundle.patch:"./cordis.patch.yml"`、`dsh.client:{inject:["@deepseek-ai/dsh-client-runtime"],platform:"web"}`、peer 下限 `@deepseek-ai/dsh-api-session-controller` 与 `@deepseek-ai/dsh-client-runtime` 均 `^0.1.2-rc.1`；验证：`node -e "JSON.parse(require('fs').readFileSync('dsh-composer-provider-label/package.json'))"` 无错，`openspec` 不涉此步骤
- [x] 1.2 写**包自带** `cordis.patch.yml`：`- insert:` 单行 `{id: composer-provider-label, name: 'dsh-composer-provider-label'}`（行 id 稳定，重复 add 不产生第二条）；验证：文件仅两行结构，与仓库三个先例一致
- [x] 1.3 `src/index.js`（node 半）：导出 `{name:'composer-provider-label', inject:['settingsCtx'], apply(ctx, config)}`，apply 里调用 `settingsCtx.settings.installSection(ctx, 'dsh-composer-provider-label', ConfigSchema, mergedConfig)`——schema 只含可选 `providerAliases: Record<string,string>`，默认值内置 `{providerAliases:{'deepseek-official':'office'}}`；不注册命令、不建端点；验证：`node --check src/index.js` 通过，且代码中没有任何除 installSection 外的宿主副作用
- [x] 1.4 `npm pack --dry-run` 在包目录内验证产物只含 `src/`、`cordis.patch.yml`、README/ACCEPTANCE（无 `openspec`/`test` 之外的泄漏）；验证：命令输出无 `node_modules` 项

## 2. 客户端注册与数据解析

- [x] 2.1 `src/client.js` 建立 bundle 协议：`window.__ModuleLoader__.load({id:'dsh-composer-provider-label', factory})`，classic script、无 JSX、`React.createElement`；factory 返回 `{name, inject:['slots'], apply(ctx, config)}`（config 预期为 undefined，见 design D4，不依赖它）；验证：`test/bundle.test.mjs` 用 `new Function('window','navigator','document', source)` 加载真实产物，断言 `__ModuleLoader__.load` 的 id/factory 形状与 `exports.inject === ['slots']`
- [x] 2.2 注册 `conversation.input.right` list 项（`id:'composer-provider-label'`、`order:10`、`locale:'dsh-composer-provider-label'`），组件签名取标准 props `{sessionId, useProjection, t}`；验证：bundle 测试断言注册调用参数（name/id/order/locale 精确匹配），并在无 sessionId 时不渲染（spec「没有会话时不显示」）
- [x] 2.3 生效路由解析器：`resolveRoute(projection, catalog) = projection.next ?? catalog.default`（两者都缺 → null）；`useProjection('modelSelection')` 订阅 + `remote.session.modelCatalog()` 结果合并；验证：bundle 测试用假投影/假 catalog 分别断言「有 next 用 next」「无 next 用 default」「都缺 → 不渲染」（spec「会话已选定模型时出现」「会话未显式选模型时显示解析后的默认提供方」）
- [x] 2.4 provider 短名解析器 `shortProviderName(providerId, catalog, aliases)`：优先级 ①`aliases[id]` ②内置表（仅 `deepseek-official→office`）③`catalog.groups.find(g=>g.id===id)?.name` 剪尾部括号 ④退回 `id`；裁剪规则去掉末尾 `(…)`（半角/全角均可）及相邻空白，空结果保留原名；验证：bundle 测试逐条覆盖优先级、`ARK (Coding Plan)→ARK`、`office` 命中、未收录 provider → id（spec「提供方名称的取值与改写规则」五场景）
- [x] 2.5 目录缓存与刷新：模块级 `{generation,value}`；首次需要时经 `remote.session.modelCatalog()` 拉取；监听 `llm/adapters-updated`、`settings/document-updated` 触发重取，`connection/reset` 丢弃缓存；目录在途时用旧缓存或只靠投影（可降级为 id）；验证：bundle 测试断言三事件分别触发重取/丢缓存、在途时不阻塞渲染（spec「宿主连接重建」「目录拉取失败但路由已知」）

## 3. 标签渲染、tooltip 与文案

- [x] 3.1 渲染一枚只读弱色纯文本标签（只用 `--dsw-*` token，无硬编码色、无边框无背景），文本为 `shortProviderName(...)` 结果；路由/别名变化时经投影订阅与事件缓存自然重渲染，不刷新页面；验证：bundle 测试断言渲染文本、主题变量使用（无 `#hex`/`rgb(` 字样）与路由切换后文本变化（spec「会话内切换模型到另一提供方」「切换会话」「深色与浅色主题」）
- [x] 3.2 tooltip：hover 与键盘聚焦均经 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip` 展示——provider 完整登记名（未裁剪版本）、当前模型 id、路由来源（`会话显式选择`/`沿用上一条请求`/`profile 默认`，由 next vs default 命中分支推导）；验证：bundle 测试断言 tooltip 内容三字段与来源文案分支（spec「悬停查看完整信息」「名字被截断时仍能看到全名」）
- [x] 3.3 无障碍与窄空间：元素带 `aria-label`（如「模型提供方：office」）；CSS 允许文本省略号截断 provider、不挤压同排其它控件；验证：bundle 测试断言 aria-label 存在；视觉省略由 ACCEPTANCE 人工确认（spec「键盘用户可获取同样信息」「输入区空间不足」）
- [x] 3.4 locale：注册 NS `dsh-composer-provider-label` 的 zh/en 字典（tooltip 字段名、aria 前缀、路由来源三种文案），随 `locale` 服务切换即时生效，缺席时回退 `navigator.languages` 嗅探；验证：bundle 测试断言字典注册、`__t` 命中/回退（spec「中文与英文客户端」）

## 4. 配置段与热更新

- [x] 4.1 client 侧配置读取：apply 期注入 `remote.settings`，启动调一次 `describe()`，从 `namespaces` 取本插件 ns 的 `providerAliases` 并缓存为别名覆盖表；`describe()` 抛错 / 无本 ns / 值为空 → 静默回退内置表，不报错不提示；验证：bundle 测试分别注入成功/失败/缺失三种 describe 结果断言别名表与回退（spec「用户配置的别名覆盖内置与登记名」「读取用户配置失败」）
- [x] 4.2 别名配置热生效：`settings/document-updated` 后重取 describe() 并重渲染（与 2.5 的目录重取解耦，单独覆盖"改了别名"这条路径）；验证：bundle 测试模拟一次 document-updated → 别名表刷新 → 渲染文本变化（spec「修改提供方显示名或别名」）
- [x] 4.3 node 半 schema 与默认值一致性：`src/index.js` 里 `ConfigSchema` 与 `src/client.js` 内置表都声明 `deepseek-official→office`，两处常量同一来源（如各自硬编码但在测试中断言相等）；验证：bundle 测试断言两端预置值一致，防止未来漂移

## 5. 逻辑测试与能力审计

- [x] 5.1 按仓库先例写 `test/bundle.test.mjs`（自研 runner，非 node:test）：用假 React/ctx/slots/locale/Tooltip/remote 的 hook shim 加载真实 `client.js`，覆盖 2.1–4.2 全部断言；验证：`node dsh-composer-provider-label/test/bundle.test.mjs` 全绿、退出码 0
- [x] 5.2 能力审计：从已安装核心产物（typert 元数据或 fixture）取出 session remote 会改状态的成员（`selectModel`/`prompt`/`rename`/`fork`/`create`/`updateQueue`/`cancel`/`control` 等），断言 bundle 源码一个都不引用；它调用的 session 方法只允许 `modelCatalog`；验证：审计断言通过（spec「显示是只读的且不改变会话状态」的等价自动化证明）
- [x] 5.3 `node --check` 全绿：`src/index.js`、`src/client.js` 语法通过；验证：两条命令退出码 0

## 6. 集成验收与交付

- [ ] 6.1 逐条走查 `specs/composer-provider-label/spec.md` 的 7 条 Requirement 全部场景并记录结果；验证：`openspec validate add-composer-provider-label --strict` 无 error
- [x] 6.2 写 `README.md`：安装/卸载（含 `disabled:true` 回滚）、版本下限 ≥0.1.2-rc.1、别名配置（settings 段 + 官方预置 office + codemaker 等无 displayName 的显示为 id 及补 displayName 的办法）、卸载后 settings 残留段的清理步骤、与既有三插件共存说明、不含宿主端点（仅一个 settings section）；验证：照 README 在干净 profile 从零装一遍成功，再按回滚步骤卸载
- [x] 6.3 写 `ACCEPTANCE.md`：覆盖 GUI 侧人工项——真实安装加载无报错、标签出现位置与顺序（模型名左侧、order 10）、`office` 与 `ARK` 显示、切会话/切模型/子代理会话三条路径即时更新、settings 改 displayName/别名后不刷新热更新、深浅主题、窄窗口省略、zh/en 切换、与 `dsh-composer-history-recall`（↑ 召回）/ `dsh-open-session-workdir` / `dsh-session-title-regenerate` 共存、点击标签零副作用、会话日志 mtime/size 不变；验证：文档列出可勾选项，条目与 spec 场景一一对应
---

**进度注记（apply 完成时）**：1.1–5.3 与 6.2/6.3 已实现并通过验证；6.1（逐条走查 spec 场景）与 6.2 的"干净 profile 实装回环"依赖真实安装，按约定未实装，已转交给 ACCEPTANCE.md 的 §1（安装与加载）与 §9（回滚）人工项，未勾选不代表缺失。
