# dsh-open-session-workdir

> ## ⛔ 已退役（2026-09-18）——不要再启用
>
> **核心里已经有这个功能了。** `@deepseek-ai/dsh-client-ui-open-in-app`（`dsh-web-app` bundle 自带的行 `ui-open-in-app`）会在会话头部 `conversation.session.header.utilities` 放一枚「Open In…」**分体按钮**：主按钮用**上次选过的应用**打开当前会话的 `cwd`，右侧箭头列出宿主探测到的**全部已装应用**（Windows 上通常是 Explorer + Git Bash + 编辑器），选择持久化在 `dsh.open-in-app.choice`。也就是说「下拉选择 + 图标随上次选择切换」这套交互核心已经实现，本插件成了重复品。
>
> 因此：
> - **管理器面板不再列出它** —— `dsh-plugin-manager/src/host-core.js` 的 `RETIRED_PLUGIN_DIRS` 里登记了 `dsh-open-session-workdir`，扫描直接跳过（`dsh-plugin-manager/test/root-install-shell.test.mjs` 有一条断言钉住「源码在、面板不列」）。
> - **源码、本文档、`ACCEPTANCE.md` 与两个测试全部保留**，作为「外部插件如何绕开被劫持的 opener」「能力门控 + 失败卡片」的参考实现。
> - **不要**把它从 `RETIRED_PLUGIN_DIRS` 里删掉再启用：它做的事核心已经在做，两枚按钮会并排出现。
> - 退役的完整原因、调查过程与实测证据：[`docs/knowledge/2026-09-18-retire-open-session-workdir.md`](../../docs/knowledge/2026-09-18-retire-open-session-workdir.md)。
>
> 下面保留的是退役前的原始说明，**只作历史参考**（其中的安装/启停步骤已不再适用）。

在 DSH Web GUI 的会话头部动作条上加一枚按钮：**打开当前会话的工作目录**（Windows 上即资源管理器打开到该目录内部）。

纯客户端插件。它**不含任何宿主端点、不注册模型工具、不新增攻击面**——把路径交给 DSH 核心已有的原生打开链路：`connection.api.host.openPath({path}, signal)` → 宿主 `openNativePath`（次选 `workspaces.openPath`，若某版本让它容器可见）。

## 为什么需要它

每个会话都绑定一个工作目录，但界面上没有任何入口能跳过去：想看会话产出的文件、复制路径、或在里面手动开个终端，只能凭 slug 编码去磁盘上猜（`~/.dsh/sessions/--D-ChenSirDocument-Dsh-Projects-dsh-plugins--/…`）。

核心其实早就具备打开原生路径的能力，缺的只是触点。本插件补的就是这个触点，因此核心将来换 opener、加平台，插件零跟随成本。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: open-session-workdir, name: 'dsh-open-session-workdir' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

**版本要求**：需要 `@deepseek-ai/dsh-api-session-controller` ≥ `0.1.1-rc.2`（能力门控用的 `session.canOpenWorkspacePath` 从该版本起存在）。核心版本不够时按钮**自动不出现**，不会报错。

打开动作按可达性依次试三条通道：`workspaces.openPath` → `connection.api.host.openPath` → `remote.session.openWorkspacePath`。**当前环境实际命中第三条**：这个 profile 混装了 `dsh-client-runtime@0.1.1-rc.2`（全局 npm）与 `dsh-client-connection@0.1.2-alpha.2`（开发检出），而 0.1.2-alpha.2 删掉了前两条通道。三条都不可达时按钮**仍然出现**，点击后给出写明**三个服务名**的失败卡片（见 D9：做成不可见会让故障无法被发现）。

## 按钮在哪

会话头部那一行（显示会话标题/面包屑的那条）**右侧的图标排**。本插件的行是 `order: 25`，核心自带的动作在它两侧：日程(10) → 任务列表(20) → **打开的文件夹(25，本插件)** → … → 删除会话(30)。只有图标没有文字，悬停显示「打开工作目录」。

> 那个 `…` 不是排版省略：同一个槽位里**还有别的插件行**——`dsh-session-title-regenerate` 的重新生成标题是 **27**、`dsh-esc-rewind` 的归档/删除处置开关是 **28**。两个都启用时，本按钮**右边**会再挤两枚图标，实际顺序不是上面那四个。全部插件的真实 order 见 [`docs/plugins.md`](../../docs/plugins.md)。

不在左侧会话列表的行上，也不在右侧文件面板里。

## 与 dsh-better-sidebar 共存

两者都想用 `remote.session.openWorkspacePath`，但意图相反：better-sidebar 把它**影子化**，好让聊天里的文件链接开在它自己的侧边栏编辑器；而本插件要的恰恰是**别开在 GUI 里、去开系统文件管理器**。被影子化后目录会被当成文件读，GUI 报：

```
"D:\...\dsh-plugins" is a directory
```

本插件因此不走那条漏斗，改走 `workspaces.openPath`（同一个宿主 `openNativePath`，只是没人劫持）。**两个插件可同时启用，互不影响**：聊天文件链接仍然进侧边栏，本按钮仍然开资源管理器。`test/interception.test.mjs` 会把 better-sidebar 真实产物里的 `wrapOpenWorkspacePath` 挂上来复现这件事；它没装时该测试自动 SKIP。

## 停用 / 卸载 / 回滚

在管理器面板里关掉主开关即停用（profile 里该行写 `disabled: true`），点「移除」即卸载（删激活行 + 摘 devDependency）。两者都被 DSH 实时热重载，宿主侧立即生效；**刷新页面**后按钮消失。插件不写任何持久数据，回滚无残留。

```yaml
# 面板停用后 profile cordis.patch.yml 中的形态（行保留，可随时再开）
- insert:
    - id: open-session-workdir
      name: 'dsh-open-session-workdir'
      disabled: true
```

> 不要用 `dsh plugin --profile web remove dsh-open-session-workdir` 卸载：它只摘依赖、留下悬空激活行，下次 `dsh web` 启动会失败。见上方警示。

## 行为

| 情况 | 表现 |
| --- | --- |
| 会话有 `cwd` 且宿主有桌面 | 头部出现文件夹图标按钮 |
| 宿主无桌面（headless Linux、非 WSL） | 按钮**不出现**（问核心，不猜平台） |
| 会话无 `cwd`（`_no-cwd` 归档下） | 按钮不出现 |
| 切换会话 | 按钮指向的目录随之改变，无需刷新 |
| 打开成功 | 顶部轻量 Toast「已交给系统打开」，4s 自动消失 |
| 对**同一目录**再点一次 | Toast 改为「该目录已在文件管理器中打开」：Windows 资源管理器会**复用**该目录已有的窗口（且后台进程把它提到前台可能被系统抑制），所以此时**不会有新窗口**出现。实测对照：对未打开的目录执行宿主同一条命令 → 窗口数 5→6；对已打开的目录 → 5→5 |
| 目录已被删除/移动 | 锚定卡片说明「该目录当前无法访问」+ 完整路径 + 复制按钮 |
| 宿主打开命令报错 | 卡片透出宿主返回的原因文本 + 完整路径 + 复制按钮 |
| 8s 无响应 | 卡片提示超时，按钮恢复可点 |

失败卡片常驻一句提示：**目录是在宿主机器上打开的，不是浏览器所在机器**。远程 Web UI 场景下这是最容易踩的坑，所以复制路径入口始终就在手边。

## 设计约束

- **路径原样透传**：`cwd` 已是宿主绝对路径，插件不做 `resolve`/`normalize`/分隔符转换。空格、中文、UNC、反斜杠都按原样交给核心。
- **失败分类是事后的**：只有打开失败时才调 `directoryPicker.list(cwd)` 判断目录是否还在。事前探测会在成功路径上白付一次网关往返，而且在没装目录浏览服务的 profile 上会**误判**成「目录不可访问」从而彻底堵死打开。
- **反馈分两处**：核心的 `Toast` 是顶部居中的**纯字符串**横幅（没有 children 座位，装不下按钮），所以成功用它、失败用自绘的锚定卡片。
- **绕开被劫持的漏斗**：见上一节。检查 `session.openWorkspacePath` 是否存在毫无意义——它存在也可能已被别的插件换掉。
- **apply 期的 ctx 上 `ctx.get()` 解析不到任何后挂载的服务**（属性通道同样为空）。必须在 `ctx.inject(names, sub => sub.get(name))` 的回调里取，并把该作用域存下来复用。这是 `remote.session`、`workspaces`、`connection` 连续三次「服务明明存在却拿不到」的共同根因。
- **劫持用形状判别，不用名单**：核心把 remote 方法装成 `configurable:true` 的 **getter**；谁把它换成 value 属性就是劫持。此时走 `methods` 注册表里那份原始 `direct`（劫持者替换的只是实例描述符，动不到注册表）。注册表拿不到就退回公开入口——被劫持好过打不开。见 D10。
- **外部插件只能看见容器级 `provide` 的服务**：`sessions`（`rootCtx.reflect.provide`）和 `connection`（普通 `ctx.provide`）可见；`workspaces` 是 `WorkspaceRuntime` 在**自己子作用域**里 `ctx.reflect.provide` 的，兄弟插件拿不到。所以打开动作走 `connection.api.host.openPath`，而不是照抄核心插件里的 `ctx.workspaces.openPath`。
- **外部插件取 remote 控制器必须用点路径名**：`ctx.get('remote.session')` / `ctx.inject(['remote.session'], f => f.get('remote.session'))`。**不能**照抄核心插件里的 `ctx.remote.session.xxx`——那是同容器同作用域才成立的写法，外部 bundle 照抄会静默拿到没挂控制器的空根对象，门控永远关着、按钮永远不出现（现场踩过，见 design D9）。
- **服务读取用 `ctx.get(name)` + 属性双通道，且每个服务单独 `ctx.inject`**：合并成一个 `ctx.inject(['remote','workspaces'])` 会等**全部**就绪，任一名字解析不了回调就永不触发，同样导致按钮静默消失。
- **超时是客户端计时**：`openPath` 没有 signal 参数（服务端自己起 AbortController），所以 8s 超时只能 `Promise.race`。代价是取消保真度：超时后宿主仍可能晚一点真的打开资源管理器。晚到的 rejection 被显式吞掉。
- **「已打开」是客户端按路径记的**：宿主 `openPath` 只返回 void，"窗口是被复用还是新建"没有回传通道，所以插件只能记住「本页面内这个路径此前打开成功过」来切换文案（随页面加载重置）。若那个窗口在此期间被你手动关掉，再点会真的新开窗口、而文案仍说"已打开"——偏保守，但不会再被误读成"按钮坏了"。要消除这点偏差需要宿主回传窗口状态，本插件不为此引入宿主端点（见「不含任何宿主端点」）。
- **只读**：不切换会话、不重载页面、不向会话日志写任何事件。

## 开发

```bash
node sub-plugins/dsh-open-session-workdir/test/bundle.test.mjs        # 30 条逻辑断言
node sub-plugins/dsh-open-session-workdir/test/interception.test.mjs  # 挂载 better-sidebar 真实代码的探针
```

30 条逻辑断言覆盖（含一条**能力审计**：从已安装的 typert 元数据取出 session remote 全部改状态方法，断言 bundle 一个都不调）：bundle 注册协议、服务声明、槽位 id/order/locale、能力门控关闭路径、**服务晚于 apply 挂载时仍能出按钮**、`cwd` 门控与会话切换、路径原样透传、连续点击、成功 Toast、四种失败分类（含 opener 缺失）、超时、复制写入剪贴板、locale 字典注册。

`interception.test.mjs` 用**现场真实形状**的 ctx（apply 期 ctx 全盲、`workspaces` 在但没有 `openPath`、`connection` 在但没有 `api`、`remote.session` 是带 accessor + `methods` 注册表的命名空间），按大括号配对从已安装的 better-sidebar 产物里抽出**真实**的 `wrapOpenWorkspacePath` / `isFolderRevealPath` 挂到假 `remote.session` 上，断言「目录必须到达原生 opener、且绝不进侧边栏编辑器」——对方没装时自动 SKIP，抽取失败会报错而不是静默通过。

两者都是**逻辑**harness（自带 hook shim，profile 里没有 jsdom），不覆盖视觉布局与 portal 定位——那部分见 [ACCEPTANCE.md](./ACCEPTANCE.md)：一份可勾选的装后验收清单，覆盖 17 个 spec 场景里必须人眼确认的部分。

## License

MIT
