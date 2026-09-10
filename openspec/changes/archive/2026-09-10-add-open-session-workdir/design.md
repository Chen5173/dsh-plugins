## Context

动机见 `proposal.md - Why`；行为契约见 `specs/session-workdir-open/spec.md`。这里只记录塑造方案的核心现状与约束。

**核心已经具备的能力（本变更全部复用，不新增 Host 代码）**

| 能力 | 位置 | 事实 |
| --- | --- | --- |
| `session.canOpenWorkspacePath(): boolean` | `@deepseek-ai/dsh-api-session-controller`，`@Remote` | 直接返回 `canOpenPath()`；默认实现 `canOpenNativePath()`：darwin/win32 恒真，linux 看 WSL 或 `DISPLAY`/`WAYLAND_DISPLAY` |
| `session.openWorkspacePath({path}, signal)` | 同上，`@Remote('openWorkspacePath')` | 走 `openNativePath`；win32 执行 `powershell.exe -NoProfile -Command Invoke-Item -LiteralPath '<path>'`（PowerShell 单引号字面量转义），darwin `open`，WSL 先 `wslpath -w`，linux `xdg-open`。**但它是聊天侧共用的漏斗，会被 dsh-better-sidebar 影子化**（见 D1 的修正） |
| `workspaces.openPath(path)` | `@deepseek-ai/dsh-client-runtime` 的 `WorkspaceRuntime` | 内部 `api.host.openPath({path})` → **同一个** `openNativePath`。失败**抛异常**（`path open failed: <宿主原因>`），无 signal。**但它 `ctx.reflect.provide` 在 WorkspaceRuntime 自己的子作用域里，外部插件看不见**（对比 `sessions` 是 `rootCtx.reflect.provide`）→ 只能作为次选通道 |
| `connection.api.host.openPath({path}, signal)` | `dsh-client-connection` 用**普通** `ctx.provide("connection", handle)` 提供，容器可见 | apiproxy 客户端层，核心自己就是这么调的。返回 `{result:{ok,value/error}}` 信封；**接受 AbortSignal**。→ **本插件实际使用的主通道** |
| 结果形态 | `typert.remote-client.js` / `dsh-client-runtime` | typert Remote：`result.mode:'strict'`，成功 `{opened:true}`，代理包成 `{ok:true,value}` / `{ok:false,error:{message}}`，`cancellation:{parameter:'signal'}`；`workspaces.openPath`：无返回值，失败抛 `Error`（前缀 `path open failed: ` 需剥掉再展示） |
| 目录可达性探测 | `workspace-controller` 的 `directoryPicker.list(path, signal)` | 宿主用 `node:fs/promises` 的 `opendir`/`stat` 真实读目录，同样返回 `{ok,error}` |

**客户端拿得到 cwd**：会话摘要带 `cwd`（投影缓存里 `record.identity.cwd`，形如 `D:\ChenSirDocument\...`，绝对路径），`ctx.sessions.list.getSnapshot().byId[id].cwd` 可读，`useSessions((s) => s.byId[sessionId]?.cwd)` 可订阅。

**头部动作条的契约**：`conversation.session.header.actions` 是 `conversation.session.header` 声明的 `kind: "list", scope: "session"` 子槽；注册项组件收到 `{ sessionId, useSessions, t }`（`dsh-client-ui-jobs` 的 `JobListAction` 已验证）。

**纯 UI 插件的落地形态（官方先例）**：`@deepseek-ai/dsh-client-ui-directory-picker-browse` 的 node 半只有一个空 `apply()`，注释写明「the empty apply exists so the plugin appears in the host cordis.yml / Loader; the browser half ships via `exports["./client"]`, discovered through the package.json `dsh.client` declaration」。`dsh-client-modules` 的 node 半**只扫描已启用的 Loader 条目**去发现 `dsh.client` 包——所以哪怕插件没有任何宿主行为，也必须有一条 patch 行让它成为 Loader 条目。

## Goals / Non-Goals

**Goals:**

- 一枚按钮 + 一次 Remote 调用，把「打开当前会话工作目录」变成一等公民操作。
- 在核心能力升级（换 opener、加平台）时**零跟随成本**：插件不复制任何平台判断逻辑。
- 失败路径可诊断：永远能看到目标路径，永远能一键复制。
- 装/卸都只动 profile 的一行 patch。

**Non-Goals:**

- 不做「在父目录中选中该目录」（`explorer /select`）——那要求绕开核心自己 spawn 进程，与本次选定的路线冲突。
- 不做侧边栏会话行菜单、工作区行菜单、命令面板入口（会话行菜单无官方槽位，DOM 注入是独立的风险预算，另立变更）。
- 不做把目录内容列进 Web GUI 的浏览器（`directoryPicker` 已有自己的插件负责）。
- 不做远程 Host 场景下的路径转发或跨机映射。
- 不注册任何模型工具：这是纯人类手势。

## Decisions

### D1：复用核心的原生打开链路，不自建 Host 端点

**选择**：插件只有 UI，路径交给核心客户端服务 `ctx.workspaces.openPath(cwd)`。

**修正（实现后，由现场日志驱动，共两轮）**：原计划走 `ctx.remote.session.openWorkspacePath`。装到真实 profile 后发现 `dsh-better-sidebar` 会**影子化**该方法——它用 `ctx.inject(['remote.session'])` 把 `openWorkspacePath` 换成自己的 `wrapped`，好让聊天里的文件链接开在它自己的侧边栏编辑器里。它的目录分支 `isFolderRevealPath()` 只认 `'.'` / `'\.'` 这类后缀，绝对目录路径不被识别，于是目录被当文件读，GUI 报 `"<path>" is a directory`。两条路最终都落到同一个宿主 `openNativePath`，差别只是**有没有被劫持**。**最终修正（第三轮，查到环境层根因）**：这个 profile 的核心包是**混装**的——`dsh-client-runtime@0.1.1-rc.2` 来自全局 npm，而 `dsh-client-connection@0.1.2-alpha.2`、`dsh-api-session-controller@0.1.2-alpha.2` 符号链接到开发检出。在 **0.1.2-alpha.2 里 `WorkspaceRuntime.openPath` 和 `connection.api` 都被删了**（实测 handle 只剩 `isLoopback/generation/state/reconnect/registerGenerationSource/start`），检出自家的 `packages/client/ui-chat/src/client/apply.ts:122` 用的就是 `ctx.remote.session.openWorkspacePath`。所以**没有第二条路可绕**，只能正面处理劫持（见 D10）。

opener 仍按可达性依次尝试**三条**通道（① `workspaces.openPath` ② `connection.api.host.openPath` ③ `remote.session.openWorkspacePath`），前两条是为版本漂移留的兼容位；当前实际命中的是第三条。三条都拿不到才报错，且文案写明**三个名字**。`test/interception.test.mjs` 把对方**真实**的 `wrapOpenWorkspacePath` / `isFolderRevealPath` 从已安装产物里按大括号配对抽出来挂载复现，先红后绿。

**为什么**：核心那条链路已经是 shell-free 的 `runNativeCommand` + PowerShell 字面量转义，并且自带平台分派（含 WSL）。自建端点要重新解决三件核心已经解决的事——任意路径执行的攻击面（必须自己做「只允许已知会话 cwd」的白名单）、`explorer.exe` 恒返回退出码 1 的坑、以及跨平台分派。省下的代码量与长期维护面完全不对等。

**放弃的替代方案**：`/__plugin/...` HTTP 端点 + `spawn('explorer.exe', ['/select', path])`。唯一净收益是 `/select` 语义，代价是新增宿主攻击面。用户已确认「直接打开该目录」，故不取。

**已知后果**：Windows 上 `Invoke-Item` 对目录 = 资源管理器打开到目录内部，正好是选定的行为；但无法区分「目录不存在」与其它 PowerShell 层失败（见 D5）。

### D2：可见性门控 = `canOpenWorkspacePath()` && `cwd` 非空，二者缺一不渲染

**选择**：不猜平台，问核心。启动时探测一次 `canOpenWorkspacePath()`，结果缓存在模块级；`cwd` 用 `useSessions` 订阅，随会话切换自动重算。

**为什么**：`canOpenNativePath()` 里那段 darwin/win32/WSL/`DISPLAY` 判断是核心的知识，插件自己写 `navigator.platform` 嗅探一定会漂移，而且浏览器平台 ≠ 宿主平台（远程 Web UI 时必然错）。

**探测时机**：Remote 是异步的，首帧无法判定 → 按钮**默认不渲染**，探测返回 true 后才出现。探测本身抛错按 false 处理：宁可少一枚按钮，不给一枚点了没反应的死按钮（对应 spec「宿主没有桌面时隐藏入口」）。

**放弃的替代方案**：始终渲染、失败再提示——在无桌面的 headless 宿主上会稳定制造噪音。

### D3：`cwd` 原样透传，不做任何路径加工

**选择**：`workspaces.openPath(cwd)`，不 `resolve`、不 `normalize`、不转分隔符。

**为什么**：`identity.cwd` 已是宿主绝对路径；核心的 `resolveWorkspacePath` 是为「聊天里的相对文件提及」设计的（`dsh-client-ui-chat` 的 `openFile` 才需要它）。多走一步归一化反而会给 UNC 路径、尾部分隔符制造差异。spec 的「路径原样传递」场景直接对应这条。

### D4：成功用 `Toast`，失败用自绘的锚定卡片

**选择**：成功走 `Toast({ text, icon, anchor, onDone })`；失败走插件自己的锚定卡片（`createPortal` 到 body，从按钮矩形定位），卡片里放原因、完整路径（`<code>` 可选中）、宿主/浏览器说明，以及真正的「复制路径」按钮（`writeClipboard`）。

**为什么**：实现时核实了 `Toast` 的真实契约——它是**顶部居中横幅**，`text` 是一段字符串文案（内部 `createElement('span', null, text)`），**没有 children 座位**，4s 后回调 `onDone`。原设计「失败一句带路径的提示，内部附复制路径」把它当成了可容纳按钮的容器，这是错的：spec 要求的是一个可点击的复制入口（「WHEN 用户在失败提示中选择复制路径」），塞进 Toast 只能靠把 React 元素当字符串传进去，属于未文档化用法。`require('react-dom')` 在 client bundle 里可用（`dsh-client-ui-message-feedback` 已验证），所以自绘卡片不需要新增 external。

**放弃的替代方案**：(a) 把元素当 `text` 传给 Toast——依赖未声明的行为，核心一改就碎；(b) 失败弹 `Modal`——为一个 200ms 手势打断用户；(c) 只在 Toast 文案里放路径、让用户自己选中复制——不满足 spec 的显式 affordance 场景。

### D5：失败分类走「事后探测」，不做事前拦截

**选择**：点击 → 直接 `workspaces.openPath(cwd)` → 抛错时才调 `directoryPicker.list(cwd)` 富化文案：探测也失败 ⇒ 说「目录当前无法访问（可能已被删除或移动）」；探测成功 ⇒ 展示异常消息（剥掉 `path open failed: ` 前缀后的宿主原因）。

**为什么**：事前探测会在 99% 的成功路径上白付一次网关往返 + 目录 IO，而且当某个 profile 没装 `dsh-host-directory-picker-browse` 时，事前探测会**误判**成「目录不可访问」从而彻底堵死打开。事后探测只在已经失败时运行，最坏情况只是文案退化为核心原始错误串——不会误伤。

**放弃的替代方案**：事前探测（把可用性检查前置）。理由如上：代价更高、且在缺服务时是错的。

### D6：超时 = 真 AbortSignal + 客户端 `Promise.race` 双保险

**选择**：`withDeadline(opener.open(cwd, makeDeadline(8000)), 8000)`。

**为什么两个都要**：主通道 `connection.api.host.openPath({path}, signal)` **接受 signal**，abort 会传到 apiproxy 层，取消是真的；但次选通道 `workspaces.openPath(path)` 签名里没有 signal，所以仍需要一层 `Promise.race` 兜底，否则那条通道卡死时按钮永久停在加载态。分类上 `__Deadline` 与 `AbortError` 都算超时。

**残留**：宿主侧 `case "host.openPath"` 自己 `new AbortController()`，所以**服务端**不会因为客户端 abort 而终止已启动的 PowerShell——晚到的窗口仍可能出现。这比 D1 修正前设想的好一层（传输层确实取消了）。8s 无响应本身已是宿主侧异常；晚到的窗口是无害的（用户只是多开一个文件夹），而"骗过 UI"在这里恰好是我们想要的——按钮必须恢复可点。晚到的 rejection 在 `withDeadline` 里被显式吞掉，不会变成 unhandled rejection。8s 的余量是给 Windows 上 PowerShell 冷启动（实测 2–3s 量级）留的。

### D7：包形态 = 空 node 半 + 单文件 client 半

**选择**：

```
dsh-open-session-workdir/
├── package.json          # keywords:["dsh-plugin"], dsh.bundle.patch, dsh.client{inject,platform:"web"}
├── cordis.patch.yml      # - insert: [{ id: open-session-workdir, name: '<pkg>' }]
└── src/
    ├── index.js          # export function apply() {} —— 见 Context，为了让插件成为 Loader 条目
    └── client.js         # window.__ModuleLoader__.load({ id, factory })
```

`client.js` 走 bundle 协议：classic script、无 JSX、`React.createElement`、只用 `--dsw-*` 主题 token；`factory` 里 `require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')` 属于隐式 baseline，只有 `@deepseek-ai/dsh-client-runtime` 需要写进 `dsh.client.inject`（与 `@huanlin/dsh-plugin-session-delete` 一致）。

**为什么**：这是仓库里已被验证可安装的两条先例（session-delete 的 client 半 + directory-picker-browse 的空 node 半）的交集，不发明新形态。

### D8：i18n 用 `locale.register(NS, {zh,en})` + 注册项带 `locale: NS`

**选择**：文案集中在两个字典里，注册 slot 时声明 `locale: NS` 让渲染器注入 `t` 座位；`locale` 服务缺席时回退到按浏览器语言选字典。

**为什么**：与 session-delete 同构，且 `locale/change` 后能自动重渲染，满足 spec「切换到英文」场景。

### D9：服务用 `ctx.get()` 读、每个服务单独 `ctx.inject`、opener 点击时惰性解析

**选择**：`apply()` 里 `__readService(ctx, name)` 先 `ctx.get(name)` 再退回属性；`remote` 与 `workspaces` **各起一个** `ctx.inject([name], cb)`；`workspaces.openPath` **不进可见性门控**，改为点击时 `__resolveOpener()` 解析，彻底拿不到就弹一张写明「workspaces.openPath 缺失」的失败卡片。

**为什么**：这是「按钮不见了」的直接教训，而且**真凶是被现场日志抓出来的，不是推理推出来的**。控制台打出 `apply: remote=MISSING` 后紧跟 `gate CLOSED: remote.session.canOpenWorkspacePath is missing`，说明 `ctx.inject(['remote'])` 的回调**确实触发了**，拿到的 `remote` 却是**没挂控制器的根对象**。

外部 bundle 必须用**点路径服务名**取控制器：`ctx.get('remote.session')` / `ctx.inject(['remote.session'], fctx => fctx.get('remote.session'))`——这是 `dsh-better-sidebar` 的实测写法。核心 bundle 里 `ctx.remote.session.openWorkspacePath(...)` 能用（`dsh-client-ui-chat` 就这么写），因为核心与控制器同容器同作用域；**外部插件照抄会静默拿到 undefined**。`@huanlin/dsh-plugin-session-delete` 之所以没事，是因为它用的是 `ctx.get('sessions')` 这种单层名字，从没碰过 `remote.*`。

**第三轮才挖到共同的底层机制**（`workspaces` 和 `connection` 连着两次「明明存在却拿不到」其实是同一个病）：**apply 期的 ctx 上 `get()` 什么都解析不到，属性也一样**；只有 `ctx.inject(names, sub => …)` 回调收到的那个**作用域 ctx** 能解析后挂载的服务。`remote.session` 之所以最后拿到了，纯粹是因为我走了 inject；而 `connection` 我只用了 `ctx.get` → 永远 undefined → 卡片报「两条通道都不可达」。旁证：`dsh-context`（同为外部插件）是在**组件渲染期**调 `ctx.get("connection")`，拿的是渲染时已就绪的 ctx，不是 apply 期的裸 ctx。

因此本插件的规则是：**任何服务都必须在 inject 回调里用 `sub.get(name)` 取，并把该作用域存下来（`__scope`）供后续惰性查找复用**；`__lookup()` 一律先试 `__scope` 再试 apply ctx。这样即使某个名字对我们不可解析、它的 inject 永不触发，别的服务（`remote.session`）捕获到的作用域仍能替我们查到它。

中途我还踩了第二个坑：`ctx.inject(['remote','workspaces'], cb)` 是**合并等待**，任一名字解析不了回调就永不触发；而当时 `workspaces.openPath` 存在与否被写进了可见性门控，于是按钮整枚消失且零报错。所以：每个服务单独 inject、`ctx.get(name)` 与属性两条通道都读、opener 彻底移出可见性门控。

**取舍**：门控退回 spec 的原始两条（`canOpenWorkspacePath()` && `cwd` 非空），"核心太旧没有 opener" 这种罕见情况由静默不渲染改成**明确报错**。可见性稳定优先于把不存在的依赖藏起来——藏起来的代价是没人能发现它没工作。

### D10：劫持无法绕开，就**结构性识别**它，然后走注册表里那份原始实现

**选择**：判别依据是**属性描述符的形状**，不是名字、不是黑名单：

```js
const d = Object.getOwnPropertyDescriptor(session, 'openWorkspacePath')
const intercepted = d !== undefined && typeof d.get !== 'function'
```

核心网关给每个 remote 方法装的是 `configurable: true` 的 **accessor**（`packages/api/gateway/src/client/index.ts`：`Object.defineProperty(this, method, { configurable:true, enumerable:true, get(){…} })`）。插件要影子化它，只能换成 **value 属性**——`dsh-better-sidebar` 的 `wrapOpenWorkspacePath` 正是 `Object.defineProperty(target, KEY, { configurable, enumerable, writable, value: wrapped })`。于是「还是不是 getter」就成了一个精确、无需维护名单的判据。

被判定劫持时，走命名空间自己那张 `methods` 注册表：`session.invokeRemote(record.direct, record.scoped, session.ctx, [{path}, signal])`。`methods` / `invokeRemote` 是 TS `private`，**编译成普通运行时属性**，外部可读；而劫持者只替换了实例描述符，**动不到注册表里的原始 `direct`**。两条路最终都落到同一个 `host.openNativePath`，区别只是中间有没有人插一脚。

**降级**：注册表拿不到（内部改名/结构变化）就退回调用公开入口——**被劫持好过打不开**，且这条降级有专门测试断言它仍会如实报错而不是消失。

**为什么不做成「默认让路给 better-sidebar」**：用户点的是我这枚按钮，语义就是「用 Windows 资源管理器打开」；把目录送进编辑器正是他报的 bug。协作式让路在这里等于复现故障。

**代价**：依赖了核心的私有字段。所以判据只用「是不是 accessor」这一条最稳的结构事实，`methods`/`invokeRemote` 缺失时立刻降级，不假设更多内部细节。

## Risks / Trade-offs

- **[核心能力在更旧的 rc 版本里不存在] → 运行时能力探测**：渲染前检查 `typeof ctx.workspaces?.openPath === 'function'`（外加 `session.canOpenWorkspacePath` 探测成功），缺席即不渲染；`package.json` 里把 peer 下限钉到已验证版本（`^0.1.1-rc.2`），并在 README 写明「需要 ≥ 该版本」。
- **[同 profile 里别的插件劫持了打开动作] → 选一条没人劫持的核心路径**：`remote.session.openWorkspacePath` 是聊天侧共用漏斗，已被 `dsh-better-sidebar` 影子化。本插件改走 `workspaces.openPath`。残留风险：若将来有插件连 `host.openPath` 这条也接管，症状会重现——`test/interception.test.mjs` 会在对方代码变化时失败（它按大括号配对抽取真实函数，抽取失败即报错，不会静默通过）。
- **[远程 Web UI：资源管理器开在宿主上，用户以为开在自己机器] → 文案显式承担这个事实**：Toast 里带完整宿主路径；失败提示常驻「复制路径」。spec 已把它写成独立场景，不做转发（Non-Goal）。
- **[`Invoke-Item` 的错误串是 PowerShell 本地化的，可能不可读] → D5 的事后探测**：目录确实没了时给出我们自己的规范中文文案；只有目录可访问却仍失败时才透出宿主原文，此时路径与复制入口都在。
- **[宿主上 explorer 打开成功但窗口在别的虚拟桌面/最小化] → 不试图检测**：核心只保证「opener 接受了路径」，成功 Toast 措辞用「已交给系统打开」而非「已打开」，不过度承诺。
- **[连续点击触发多次 Remote] → 允许，但按钮在单次请求在途时进入进行态**：满足 spec「连续触发各自生效」——不永久禁用，只是同一次点击不重复发。
- **[依赖 `conversation.session.header.actions` 这个非公开稳定的槽位] → 版本钉 + 降级即静默**：槽位缺席时 `slots.inject` 不会渲染，最坏是按钮消失而非白屏；升级核心后需回归这一条（写进 tasks 的验收）。
- **[Trade-off] 拿不到 `/select` 语义**：换来零宿主代码与零新增攻击面，本次认为值得。

## Migration Plan

**部署**

1. `dsh plugin --profile web add <pkg>` —— 自动写 profile `package.json` 的 `dsh.profile.bundles` 并应用插件自带 `cordis.patch.yml`。
2. 重启 `dsh web`；`dsh --dump-config --profile web` 应能看到 `open-session-workdir` 行。

**回滚**：`cordis.patch.yml` 里把该行置 `disabled: true`（或直接 `dsh plugin ... remove`）→ 重启。插件不写任何持久数据，回滚无残留。

## Open Questions

- 成功反馈要不要保留（还是只在失败时说话）？先按「轻量成功 Toast」实现，实际用一周后若显噪，删掉即可——不影响 spec 其它场景，也不改方案结构。
- 无桌面的 Linux/WSL 宿主上是否改为「把路径复制到剪贴板」作为兜底动作？当前只在失败提示里给复制入口；若真实需求出现，是一枚新按钮而非新链路。
