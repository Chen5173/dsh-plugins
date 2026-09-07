# docs/knowledge — 开发知识库

本目录沉淀 **dsh-plugins 开发中可复用的结论**（决策、接口、踩坑、验证方法），供跨会话检索。每完成一段开发就新增一篇 `YYYY-MM-DD-<功能slug>.md`，**并在下方表格追加一行**，避免文档成为孤岛。

写作纪律：宁短勿长、只写可复用结论、不复制大段代码、已有 README/ACCEPTANCE 覆盖的内容引用路径即可。

## 索引

| 日期 | 主题 | 文件 | 一句话要点 |
|---|---|---|---|
| 2026-09-06 | DSH 插件：会话「重新生成标题」 | [2026-09-06-dsh-session-title-regenerate.md](2026-09-06-dsh-session-title-regenerate.md) | 外部插件用 commands.execute 触发 host 逻辑 + viewport 内 DOM 注入菜单项；最低推理=off+session-title；remote.commands 必须注入读；session.events 跨版本兼容 |
| 2026-09-06 | DSH 插件：侧栏「按时间桶」分组 | [2026-09-06-dsh-session-time-bucket.md](2026-09-06-dsh-session-time-bucket.md) | v2 跟随核心视图：读核心持久化视图状态 localStorage `dsh.workspace.view.v5`（groupBy/orderBy 整值 JSON 每次变更同步写回），单列表+最近更新时只隐藏 listArea、保留 header 自绘时间桶列表，切走/搜索/窄栏自动还原；不注入核心分组菜单（portal 两阶段渲染不可安全扩展，会空/闪没） |