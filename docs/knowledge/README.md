# docs/knowledge — 开发知识库

本目录沉淀 **dsh-plugins 开发中可复用的结论**（决策、接口、踩坑、验证方法），供跨会话检索。每完成一段开发就新增一篇 `YYYY-MM-DD-<功能slug>.md`，**并在下方表格追加一行**，避免文档成为孤岛。

写作纪律：宁短勿长、只写可复用结论、不复制大段代码、已有 README/ACCEPTANCE 覆盖的内容引用路径即可。

## 索引

| 日期 | 主题 | 文件 | 一句话要点 |
|---|---|---|---|
| 2026-09-06 | DSH 插件：会话「重新生成标题」 | [2026-09-06-dsh-session-title-regenerate.md](2026-09-06-dsh-session-title-regenerate.md) | 外部插件用 commands.execute 触发 host 逻辑 + viewport 内 DOM 注入菜单项；最低推理=off+session-title；remote.commands 必须注入读；session.events 跨版本兼容 |
| 2026-09-06 | DSH 插件：侧栏「按时间桶」分组 | [2026-09-06-dsh-session-time-bucket.md](2026-09-06-dsh-session-time-bucket.md) | v3 跟随核心视图 + 就地增强：读核心持久化视图状态 localStorage `dsh.workspace.view.v5`（groupBy/orderBy 整值 JSON 每次变更同步写回），单列表+最近更新时**不重绘官方列表**，只在行间注入时间桶组头、行内注入 `[工作区]` 前缀，官方行（状态点/hover卡/行菜单/拖拽）全保留；React 按 fiber 调和只动自己节点，注入节点安全，行重排时用 MutationObserver 即时重锚组头；不注入核心分组菜单（portal 两阶段渲染不可安全扩展） |
| 2026-09-08 | DSH 插件：Esc 停止 / Esc Esc·/rewind 回退重来 | [2026-09-08-dsh-esc-rewind.md](2026-09-08-dsh-esc-rewind.md) | append-only 无法原地删消息：回退 = `sessions.fork(atSeq)`+`workspaces.archiveSession`+open+setDraft；纯客户端可注入 sessions/workspaces/conversation/uiConversation/commandUi(popupSelect 贡献=斜杠命令交互缝)；`inputActions` 无 cancel 用 `binding().session.cancel()`；armed=派生态（running 或尾部 interrupted 且草稿空）；document capture Esc 须让位弹层/trigger token；**v5 删除模式**：客户端无真删 verb，宿主半自建（`fs.rmSync` 日志目录+`storageDomain` 清投影/记账），settings 段 `esc-rewind.deleteOldOnRewind` 全局开关（describe 失败回退 false），会话头图标两态（档案柜⇄红叉垃圾桶），安全时序=新分支可用后才删、失败降级归档 |
| 2026-09-09 | DSH 插件：host 半禁止 import 宿主内部包（去核心化） | [2026-09-09-plugin-host-half-no-core-import.md](2026-09-09-plugin-host-half-no-core-import.md) | `link:` 插件真实路径在仓外 → Node 裸包解析从仓库向上找不到宿主内部包（默认解引用 symlink，`--preserve-symlinks` 才走 profile）→ 启动 `ERR_MODULE_NOT_FOUND`；host 半只用注入服务、宿主工具就地实现；曾靠不入库本地桩顶着的 title-regenerate 已去核心化 |
| 2026-09-09 | DSH 插件：composer 提供方标签升级为两级选择器 | [2026-09-09-dsh-composer-provider-label-picker.md](2026-09-09-dsh-composer-provider-label-picker.md) | 写路径只有 `session.selectModel` 且 provider+model 必须成对（宿主顺带写 profile 默认）；`Menu` 的 submenu 不可控/无勾选/关滚动上限 → 自管 pane + 原地 `side=top`；single 槽对动态插件是负优先级=遮蔽核心；link: 下 schemastery 解析失败 → settings 段是死的，偏好存 localStorage；目录失败只在 idle 隐式重试，其余走显式重试入口 |
| 2026-09-09 | DSH 插件：本地插件管理器（dsh-plugin-manager） | [2026-09-09-dsh-plugin-manager.md](2026-09-09-dsh-plugin-manager.md) | 只装一个 bundle（子插件放 devDependencies + profile `cordis.patch.yml` 管理器维护行，live HMR 实时生效）；宿主从 `ctx.baseUrl` 定位 profile、js-yaml 走 profile 顶层 node_modules、行 id 全局唯一、整文件重写先例=mcp-manager；客户端 `settings.section` order16 + `__ModuleLoader__.load` factory（require('react')，无 JSX）；客户端 UI 变化需一次页面刷新；legacy 布局需先一键迁移；根伞包 `dsh-local-plugins` 退役 |
| 2026-09-10 | DSH 插件：子插件收拢到 sub-plugins/（布局重构） | [2026-09-10-sub-plugins-layout.md](2026-09-10-sub-plugins-layout.md) | 拆「仓库根 / 子插件根」两概念（`pluginRootsOf` 双根并集 + `pluginAbsDirOf` 嵌套优先）；行 id 只由目录名决定 ⇒ 布局迁移零激活变更；`link:` 陈旧由 `staleLinkSpec`+`ensureDevDep` 自愈；宿主半改动需重启 `dsh web` 才生效；伞包/根目录替换方案未采用的理由已记录 |