## 1. 包骨架与可安装性

- [x] 1.1 建 `dsh-open-session-workdir/package.json`：`keywords:["dsh-plugin"]`、`type:"module"`、`main:"src/index.js"`、`exports{".","./client","./package.json"}`、`files:["src/","cordis.patch.yml"]`、`dsh.bundle.patch:"./cordis.patch.yml"`、`dsh.client:{inject:["@deepseek-ai/dsh-client-runtime"],platform:"web"}`、peer 下限 `@deepseek-ai/dsh-client-ui-primitives:^0.1.1-rc.2`；验证：`node -e "require('./dsh-open-session-workdir/package.json')"` 无错，且 `dsh plugin --profile web add ./dsh-open-session-workdir` 解析成功
- [x] 1.2 写 `src/index.js`：只导出空 `apply()`，注释说明「空 node 半是为了让插件成为 Loader 条目，浏览器半经 `exports["./client"]` + `dsh.client` 投递」（照 `dsh-client-ui-directory-picker-browse` 的形态）。验证（实测）：`dsh --dump-config --profile web` 输出含 `# == dsh-open-session-workdir` / `- id: open-session-workdir` / `name: dsh-open-session-workdir`，退出码 0、无报错。"启动无报错"这一条未直接读到运行中 `dsh web` 的启动输出，但 bundle 确实在浏览器里加载并渲染（更强的证据）
- [x] 1.3 写**包自带** `cordis.patch.yml` 的 `- insert:` 单行（`id: open-session-workdir`）。验证（实测）：`dsh.profile.bundles` 里恰好 1 次；bundle 确实被 combo 加载（按钮已渲染）。**注意 profile 的 `cordis.patch.yml` 里 0 行是正确的**——那一版任务描述把「包自带 patch」误写成「profile patch」，`dsh plugin add` 只登记包，行由包自己贡献
- [x] 1.4 `npm pack --dry-run` 检查产物只含 `src/` 与 `cordis.patch.yml`；验证：命令输出无 `node_modules`/`openspec` 泄漏

## 2. 客户端注册与可见性门控

- [x] 2.1 `src/client.js` 建立 bundle 协议：`window.__ModuleLoader__.load({ id:'<pkg>', factory })`，classic script、无 JSX、`React.createElement`，factory 返回 `{ apply, inject:['slots'] }`。验证（等价自动化形式）：`test/bundle.test.mjs` 用 `new Function('window','navigator','document', source)` 加载**真实产物**，断言 `__ModuleLoader__.load` 的 id/factory 形状与 `exports.inject === ['slots']`；现场侧由「按钮已渲染」证明——槽位未声明时 `ctx.slots.register` 会抛，而控制台没有任何 `slot "..." is not declared`
- [x] 2.2 模块级能力探测：控制器用**点路径名**取（`ctx.get('remote.session')` / `ctx.inject(['remote.session'], f => f.get('remote.session'))`，**不可**照抄核心的 `ctx.remote.session`），再异步调 `canOpenWorkspacePath()` 并缓存（探测抛错按 false）；**不**检查 `session.openWorkspacePath`（它存在也可能已被别的插件影子化），也**不**把 `workspaces.openPath` 存在与否作为可见性条件（见 D9：那个等待一旦不触发，按钮会静默消失）；结果未就绪或为 false 时整枚按钮不渲染；验证：在 headless Linux 宿主（无 `DISPLAY`、非 WSL）上按钮不出现，Windows 宿主上出现
- [x] 2.3 在 `conversation.session.header.actions` 注册 list 项（`id:"open-workdir"`、`order:25`、`locale:NS`），组件签名 `{ sessionId, useSessions, t }`，图标 `IconFolderOpenOutline16` + `Tooltip`；验证：头部动作条出现一枚文件夹按钮，与既有 job/schedule 按钮同排不重叠
- [x] 2.4 `cwd` 用 `useSessions((s) => s.byId[sessionId]?.cwd)` 订阅，空串/undefined 时返回 null；验证：切到 `_no-cwd` 归档下的会话按钮消失，切回有 cwd 的会话按钮回来，全程无需刷新页面（对应 spec「入口跟随当前会话切换」）

## 3. 打开链路与结果反馈

- [x] 3.1 服务一律在 `ctx.inject` 回调的作用域上取（apply 期 ctx 解析不到），opener 按可达性择一：`workspaces.openPath` → `connection.api.host.openPath` → `remote.session.openWorkspacePath`（当前环境只有第三条存在，前两条为版本漂移留的兼容位），全部落到同一个宿主 `openNativePath`。**不走 `remote.session.openWorkspacePath`**：`dsh-better-sidebar` 影子化该方法把目录当文件读，报 `"<path>" is a directory`。`cwd` 原样透传；opener 在**点击时**惰性解析（`__resolveOpener()` 依次试两条通道，全不可达才弹 `card.noOpener` 并写明**两个**服务名，而不是让按钮消失）（不 resolve、不 normalize、不改分隔符）；验证：Windows 上资源管理器打开到该目录**内部**；对含空格、中文、反斜杠的 cwd 均正确（spec「路径原样传递」）
- [x] 3.2 单次请求在途时按钮进入进行态，请求结束后恢复可点；验证：连续点击 3 次不报错、不永久禁用，每次都独立发起（spec「连续触发各自生效」）
- [x] 3.3 成功 → `Toast` 轻量确认，措辞为「已交给系统打开」不过度承诺，自动消失；验证：成功点击后 Toast 出现并在数秒内消失，无 Modal
- [x] 3.4 失败分类（事后探测，见 design D5）：`workspaces.openPath` 抛异常时再调 `ctx.remote.directoryPicker.list(cwd)`——探测也失败 ⇒ 提示「目录当前无法访问（可能已被删除或移动）」；探测成功 ⇒ 透出异常消息（剥掉 `path open failed: ` 前缀）；两种提示都常驻完整路径；验证：把某会话的 cwd 目录临时改名后点击得到前者，用 mock 让核心返回错误得到后者
- [x] 3.5 超时路径：`openPath` 无 signal 参数，故用客户端 `Promise.race` 计时；8s 无响应按失败处理并提示，入口恢复可再次触发，晚到的 rejection 被吞掉不产生 unhandled rejection；验证：harness 里只把 `OPEN_TIMEOUT_MS` 那一档计时器压到 0ms 跑一次，确认出现超时提示而非永久进行态
- [x] 3.6 提示中提供「复制路径」，用 `writeClipboard` 写入完整绝对路径；验证：远程 Host 场景（浏览器与宿主不同机）下点击复制，粘贴得到宿主绝对路径（spec「失败时目录路径仍可获取」）

## 4. 文案与主题

- [ ] 4.1 `ctx.locale.register(NS,{zh,en})` 注册字典并在注册项上声明 `locale:NS`；`locale` 服务缺席时回退按 `navigator.languages` 选字典，`locale/change` 后刷新；验证：客户端切英文后按钮 title 与所有 Toast 变英文（spec「切换到英文」）
- [ ] 4.2 所有颜色只用 `--dsw-*` token，不硬编码色值；验证：深浅色主题各看一次按钮与 Toast，无对比度失效

## 5. 集成验收与交付

- [ ] 5.1 逐条走查 `specs/session-workdir-open/spec.md` 的 6 条 Requirement 共 17 个场景并记录结果；验证：全部通过，且 `openspec validate add-open-session-workdir --strict` 无 error
- [x] 5.2 回归「不改变会话状态」。**等价自动化证明**：`bundle.test.mjs` 新增能力审计——从已安装的 typert 元数据取出 session remote 全部会改状态的方法（`attachment/cancel/control/create/follow/fork/prompt/refreshTitle/rename/rewind/selectModel/updateQueue`），断言 bundle 源码**一个都不引用**；它调用的 session 方法恰好只有 `canOpenWorkspacePath` 与 `openWorkspacePath`。滚动位置结构性排除（失败卡片是 `position:fixed` 的 portal，按钮 `flex:'none'`，都不参与文档流）。**未做的部分**：`session.jsonl.zstd` 的 mtime/size 比对——会话正在被本次对话持续写入，无法把点击归因出来，留作离线复验
- [x] 5.3 与 `@huanlin/dsh-plugin-session-delete` 共存安装。验证（现场）：两枚按钮同在 `conversation.session.header.actions` 一行（垃圾桶 order 30 / 打开目录 order 25），删除按钮一直可用，本插件按钮现场点击后宿主回 `ok=true` 且资源管理器窗口出现、`order` 不冲突（不抛 `list slot ... already has an entry with id`）
- [ ] 5.4 写 `README.md`：安装/卸载（含 `disabled:true` 回滚）、所需核心版本下限、远程 Web UI 时目录开在宿主上的说明、以及「本插件不含任何宿主端点」；验证：照 README 在干净 profile 上从零装一遍成功，再按回滚步骤卸载后按钮消失
