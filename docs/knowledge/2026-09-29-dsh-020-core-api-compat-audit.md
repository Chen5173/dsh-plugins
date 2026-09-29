# 宿主版本适配审计：0.1.5-rc.2 → 0.2.0-rc.1（0.2.0 线）

> 一次性结论，照抄于 `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md` 的流程。
> 审计对象是「本仓库插件用到的宿主/客户端契约」，不是整棵 harness。证据路径带 tag，可直接复跑。

## 1. 触发

用户要求把本仓库插件升级到 **dsh 0.2.0-rc2**。核对了官方 npm / npmmirror / unpkg /
deepseek-harness 上游 tag 与分支（`git ls-remote`）、本机 `D:\dsh` 检出（`git describe` =
`dsh-v0.2.0-rc.1`，工作树含未提交的 sidebar-terminal 改动）后确认：**0.2.0-rc2 尚未发布，
0.2.0 线当前就是 0.2.0-rc.1**。因此把目标定为「0.2.0 线」：`^0.2.0-rc.1` 的 peer 范围在
0.2.0-rc.2 发布后自动兼容。

## 2. 0.2.0 线的三个实锤破坏

对撞 tag `dsh-v0.1.5-rc.2`（fb2c4b9e6）与 `dsh-v0.2.0-rc.1`（4878cdab）后，本仓库
插件触点共有三处失配：

### 2.1 @deepseek-ai/dsh-client-runtime 被移除

- 0.2.0 refactor（`be531688f3 refactor(client): migrate consumers and remove Runtime` 等）
  把「客户端运行时」拆进 `dsh-client-modules`（浏览器加载内核）、`dsh-client-connection`、
  `dsh-api-remotes` 等，**`dsh-client-runtime` 包从 0.2.0 全家桶里消失**（已核对
  `.dsh_home/profiles/node_modules/@deepseek-ai` 有 240 个包、无 runtime；`git ls-tree`
  0.2.0-rc.1 的 `packages/client` 也无 runtime 目录）。
- 影响：8 个插件包的 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` 与
  `peerDependencies` 都引用它。
- 0.2.0 装载器对 `inject` 的处理：它只是浏览器侧「包行先到」的排序提示（
  `WebBootEntry.inject`），主机扫描不校验、未知名字不崩溃（同 profile 里
  `dsh-openspec` 也还残留这个 inject 名，可正常运行）。但引用一个已删除的包名是错的，
  必须清掉。

### 2.2 客户端禁止 require 宿主 UI 包

- 0.2.0 官方的 `cordis-plugin-development/practices.md` 明令：
  **「Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness
  Client package as a module… Write your own controls」**。
- 0.2.0 模块表 `ClientModuleSystem.import()` 对「非 seed / 非 materialized / 非 boot 图行」
  的 require **直接抛错**（"runtime mirror of the bundle purity gate"）⇒ 5 个插件
  （composer-history-recall / composer-provider-label / esc-rewind / open-session-workdir /
  session-title-regenerate）在 0.2.0 profile 上 require primitives 会**整行白屏**，除非
  primitives 恰好作为包行存在。本机 profile 未装 primitives（未在共享 node_modules 中），
  0.2.0-rc.1 的 primitives 源包虽存在且已发布，但官方已把「自己画控件」定为唯一正道。
- 影响：上述 5 个插件（Toast / Tooltip / Menu / 图标）。

### 2.3 peer 地板过时

- 全部 peer 都钉在 0.1.x 线；0.2.0 线上 `@deepseek-ai/dsh-client-runtime` 不存在，
  `@deepseek-ai/dsh-api-*`、`dsh-client-ui-commands`、`dsh-tools` 等在 0.2.0-rc.1
  均存在且版本为 `0.2.0-rc.1`。

## 3. 修改摘要（全仓库 8 插件 + 管理器）

| 插件 | 修改 |
| --- | --- |
| 全部 9 包 | `dsh.client.inject` 删除（不再声明已删的 `dsh-client-runtime`）；peerDependencies 只保留 0.2.0 线仍存在的包并抬到 `^0.2.0-rc.1`，其余删除 |
| dsh-composer-history-recall | primitives Toast → 自建控件（保留 try/catch 探测旧行） |
| dsh-composer-provider-label | primitives Tooltip/Menu/图标 → 自建（Menu 缺失时按既有逻辑降级为只读标签） |
| dsh-esc-rewind | primitives Toast → 自建控件 |
| dsh-open-session-workdir | primitives 6 图标 + Toast + Tooltip + writeClipboard → 自建 |
| dsh-session-title-regenerate | primitives 4 图标 + Toast → 自建 |
| dsh-plugin-manager + 根外壳 | inject/peer 清理；版本 0.2.2 → 0.3.0（两处同步） |

自建控件（`_uc_*` 前缀）为纯 token 版 Toast/Tooltip/图标，抄自 0.2.0 `ui-primitives` 的
最小实现，样式只用 `--dsw-*` 主题 token；**每处都保留 `try { require('@deepseek-ai/dsh-client-ui-primitives') }`
探测**——旧核心（0.1.x，包在）用原包，0.2.0（包不在 boot 图）落到自建实现。「探测—降级—可见」
正是本仓库既有的跨世代约定。

## 4. 验证

- 全仓库 16 支测试套件全绿（管理器 6 支 + 子插件 10 支，含 esc-rewind 90/90、
  provider-label 55/55、history-recall 24/24、open-workdir 31/31、title-regen 25/25）。
- 浏览器侧真实构图需在 0.2.0 profile 上刷新页面人工验收（ACCEPTANCE 项）。

## 5. 版本

- 根外壳 + 管理器同步 0.2.2 → 0.3.0（「有改动必须 bump」硬规则，受
  root-install-shell.test.mjs 版本一致性护栏约束）。
- 改动过的 5 个子插件各自 patch+1：history-recall 0.1.1、provider-label 0.1.1、
  esc-rewind 0.1.2、open-session-workdir 0.1.1、title-regenerate 0.1.2。

## 6. 追加（同日）：0.2.0 换了设置模型 —— `installSection` 退役

用户在 0.2.0-rc.1 上打开「本地插件 → 空闲通知」时报红
`No configurable plugin entry "idle-hook"`，上方还有「设置服务不可用：规则无法读取，插件保持静默」。

**根因**（证据：`packages/settings/settings/src/index.ts`）：

- 0.2.0 把设置从「插件自报命名空间」改成 **profile 条目配置**：`SettingsForms.describe()` 只列出
  `entry.fiber.runtime.Config` 存在且 `volatileForm(schema)` 非空的条目，`ns` = **条目 id**；
  `write()` 对任何不是可配置条目的 ns 直接抛 `No configurable plugin entry "<ns>"`（第 504 行）。
- `settings.installSection` 在 0.2.0 **已不存在**（全仓 0 引用）——所以 idle-hook / esc-rewind 的宿主半
  落到降级分支（那句「设置服务不可用」），客户端一写配置就被核心拒绝（红框）。
- `link:` 宿主半**无法** `import('@deepseek-ai/schemastery')`（实测 `ERR_MODULE_NOT_FOUND`：
  解析沿真实路径走到 `E:\…\dsh-plugins`，那里没有 node_modules），所以 Config 只能手写。
- 另：loader 的 `equalExceptVolatile` 只对 `~standard.vendor === 'schemastery'` 的 schema 走
  「volatile 原地提交」；我们的普通值没有 Volatile 引用，若认领 vendor，写入会被判定为
  volatile-only 而不重启条目 ⇒ 宿主半永远读不到新值。

**修法（能力探测，两代共存）**：

| 插件 | 宿主半 | 客户端 |
| --- | --- | --- |
| dsh-idle-hook | 导出 `Config`（手写 schema）；读配置优先 `installSection` 的 source（0.1.x），否则读 apply 时拿到的条目 Config（0.2.0）；`status.settings.source` 明示来源 | 不变（`remote.settings.describe/update`，ns = 条目 id `idle-hook`） |
| dsh-esc-rewind | 导出 `Config`；0.2.0 下用条目 Config 填 `HOST_DIAG.settingsValue` | 不变（ns = `esc-rewind`） |
| dsh-composer-provider-label | 导出 `Config`（`providerAliases`），保留旧 `installSection` 路径 | 别名查找同时认 `composer-provider-label`（0.2.0 条目 id）与 `dsh-composer-provider-label`（0.1.x 段 ns） |

手写 schema 的三个成员，正好对应三个消费者：`~standard.validate`（cordis `resolveConfig`）、
`meta.volatile` + `toJSON()`（设置服务的 `volatileForm`/`plainSchema`；`toJSON` 返回真实
schemastery 的 refs 表，用同版本 schemastery 现场捕获）、`~standard.vendor`（**故意不是**
`schemastery`，让写配置走普通路径 → 条目重启 → `apply(ctx, config)` 拿到新值）。

**验证**：三份真实 `Config` 过完整管线 —— `'toJSON' in schema` ✔、`~standard.validate` ✔、
`volatileForm` 列出全部字段 ✔、`isVolatilePath` 全路径可写 ✔、表单校验真实值 ✔。

## 7. 追加（同日）：0.2.0 归档契约变了 —— Result 化 + 「停止并归档」

真机症状：**回退后原会话没有被归档**；打开删除模式后也**没有删除**（原会话都留在列表里）。

**根因**（证据：`dsh-api-workspace-controller` 的 `lib/client.js` / `lib/index.js`）：

1. **`workspaces.archiveSession(id, options?)` 现在返回 RemoteResult**（`{ok:true,value}` /
   `{ok:false,error}`），**被拒绝时不抛异常**。插件原先只 `try { await … } catch`、不查返回值 ——
   归档没发生却当成功，诊断里连错都没有（静默失败）。
2. **仍有运行中工作的会话默认被拒绝**：宿主把 `WorkspaceActiveSessionError` 翻成
   `workspace/session-active`，要 `{ stopActivity: true }` 才「停止并归档」——正是核心
   「归档会话」确认框里 `stopAndArchiveSession` 走的那条路。
3. 删除模式当时根本没接上：它由设置命名空间 `esc-rewind.deleteOldOnRewind` 驱动，而该命名空间
   在 0.2.0 上读不到（见 §6）⇒ `deleteModeOn()` 恒 false，回退永远走归档分支，而归档又静默失败 ——
   一个根因同时解释了两个症状。

**修法**（`sub-plugins/dsh-esc-rewind/src/client.js` 的 `archiveOldSession` 桥接）：

- 先按原样调一次；返回 `{ok:false}` 就把它翻成异常交给同一段处理（0.1.x 的旧实现直接抛，语义一致）。
- 只有 `workspace/session-active`（含消息里出现 "session-active"/"running work" 的兜底）才**补一次
  `{ stopActivity: true }` 重试**；其余拒绝如实记录，不重试。
- 诊断新增 `__dsew.archiveFail`（原因）/ `__dsew.archiveStopActivity`（是否走了重试）；
  最终失败会 toast「旧会话归档失败：…（它仍留在列表里）」，**绝不静默**。
- 删除模式的降级路径（真删失败 → 归档）复用同一桥接，因此也拿到了 Result 语义。

**顺带核对为未变**（删除路径的宿主依赖）：`subagents.listChildren(parentId)`（0.2.0 仍是 2 参、
返回 catalog 数组）、`sessions.get/flush`、`sessions.store`/`detachEntered`（运行时属性，
类型面仍是私有）、`storageDomain` 的单元名 `session_projcache` 与 `workspace`（表 `workspaces`）。
唯一消失的是 `agent.whenIdle()`（0.2.0 已无）——插件的调用点本来就有 `typeof === 'function'` 守卫，
降级为「取消后直接继续删」。

**验证**：esc-rewind 套件 90 → **93/93**（新增 3 条：仍活跃被拒 → stopActivity 重试成功；
其它拒绝如实记录并提示；0.1.x 抛异常路径仍被记录）。provider-label 55/55、title-regenerate 25/25
在行尾归一化后复跑仍全绿。

## 8. 全仓同类问题排查（用户要求「还有别的插件有类似的问题吗」）

方法：把 9 个包（管理器 + 8 子插件）的宿主/客户端半里所有 `service.method(` 调用抽成清单，
逐类对撞 0.2.0 的安装包（存在性 / 返回值语义 / 改名）。

**结论：只有 2 处同类问题（均已修），其余全部核对为安全。**

### 8.1 修掉的两处

| 插件 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| dsh-plugin-manager | 0.2.0 上「自动重定位」开关在设置页根本不出现，值永远停在默认（on） | 宿主半只经 `settings.installSection` 注册命名空间（0.2.0 已退役） | 导出 `Config`（宽松校验，保留 repoRoot 等安装参数）+ `apply(ctx, config)` 读 `autoRelink`；0.1.x 仍走 installSection（`setSource` 覆盖）。新增 `test/entry-config.test.mjs`（5 条） |
| dsh-hindsight-model | 0.2.0 上面板「自动启动」开关禁用（提示设置不可写）；`useDshKey` 永远 available:false | 宿主半走 `settings.register`/`installSection`（都退役了）；读 DSH key 用 `settings.get(ns)`（0.2.0 无此方法） | 导出 `Config` + `apply(ctx, config)`；新增 0.2.0 分支 `wireEntryConfig`：读 = apply 时的条目配置，写 = `settings.update(条目 id, patch)`；DSH key 改经 `describe()` 按 ns 取 `value` 再沿 `settingsPath` 下钻（`llm.listConfigurableProviders()` 仍在）。bundle 套件 114 → 115 |

### 8.2 核对为安全（下次升级可直接回归这几条）

- **客户端 Remote 的返回值语义**：`sessions.fork/create`（**抛** `SessionForkError`/`SessionCreateError`）、
  `conversation.cancel/updateQueue`（**抛**）、`workspaces.openPath`/`remote.session.openWorkspacePath`
  （插件已用 `__unwrapOpen` 双形状解包）、`remote.commands.execute`、`remote.session.modelCatalog/selectModel`
  （插件已查 `ok`）—— 即：Result 化只发生在 `workspaces.archiveSession`（§7 已修），其余仍是抛异常或普通值。
- **槽位与服务名**：`slots.entries(key)`/`slots.subscribe(key, fn)`（在 `dsh-client-ui-renderer`）、
  `ctx.slots.register/inject/renderSlot`、`commandUi.register`、`sessions.binding|open|scope|scopeOf|list.getSnapshot`
  （快照仍有 `byId`）、`workspaces.list.getSnapshot`（`items/pinnedSessionIds/archivedSessionIds`）、
  `uiConversation.binding`（`snapshot.getSnapshot().views.get('chat')`）、`locale.register/translate/subscribe`
  —— 全部存在且形状未变。
- **宿主服务**：`agents.get/list/roots/cancel`、`subagents.listChildren(parentId)`、`tools.register`+`defineTool`、
  `webServer.register({kind})`、`storageDomain` 的单元/表名（`session_projcache`、`workspace`/`workspaces`）、
  存储表的 `get/put/delete/entries` —— 全部健在。唯一消失的是 `agent.whenIdle()`（运行时已无实现，
  类型文件里还留着），调用点本来就有 `typeof === 'function'` 守卫。
- **插件清单面**：`dsh.client.inject`（0.2.0 只当排序提示，未知名字不致命，但已按 §2.1 清掉）、
  `dsh.bundle.patch`、`exports["./client"]`、`window.__ModuleLoader__.load({id, factory})` 协议 —— 未变。
