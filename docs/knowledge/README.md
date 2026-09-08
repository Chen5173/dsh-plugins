# docs/knowledge — 开发知识库

本目录沉淀 **dsh-plugins 开发中可复用的结论**（决策、接口、踩坑、验证方法），供跨会话检索。每完成一段开发就新增一篇 `YYYY-MM-DD-<功能slug>.md`，**并在下方表格追加一行**，避免文档成为孤岛。

写作纪律：宁短勿长、只写可复用结论、不复制大段代码、已有 README/ACCEPTANCE 覆盖的内容引用路径即可。

## 索引

| 日期 | 主题 | 文件 | 一句话要点 |
|---|---|---|---|
| 2026-09-06 | DSH 插件：会话「重新生成标题」 | [2026-09-06-dsh-session-title-regenerate.md](2026-09-06-dsh-session-title-regenerate.md) | 外部插件用 commands.execute 触发 host 逻辑 + viewport 内 DOM 注入菜单项；最低推理=off+session-title；remote.commands 必须注入读；session.events 跨版本兼容 |
| 2026-09-06 | DSH 插件：侧栏「按时间桶」分组 | [2026-09-06-dsh-session-time-bucket.md](2026-09-06-dsh-session-time-bucket.md) | v3 跟随核心视图 + 就地增强：读核心持久化视图状态 localStorage `dsh.workspace.view.v5`（groupBy/orderBy 整值 JSON 每次变更同步写回），单列表+最近更新时**不重绘官方列表**，只在行间注入时间桶组头、行内注入 `[工作区]` 前缀，官方行（状态点/hover卡/行菜单/拖拽）全保留；React 按 fiber 调和只动自己节点，注入节点安全，行重排时用 MutationObserver 即时重锚组头；不注入核心分组菜单（portal 两阶段渲染不可安全扩展） |