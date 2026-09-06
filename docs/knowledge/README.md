# docs/knowledge — 开发知识库

本目录沉淀 **dsh-plugins 开发中可复用的结论**（决策、接口、踩坑、验证方法），供跨会话检索。每完成一段开发就新增一篇 `YYYY-MM-DD-<功能slug>.md`，**并在下方表格追加一行**，避免文档成为孤岛。

写作纪律：宁短勿长、只写可复用结论、不复制大段代码、已有 README/ACCEPTANCE 覆盖的内容引用路径即可。

## 索引

| 日期 | 主题 | 文件 | 一句话要点 |
|---|---|---|---|
| 2026-09-06 | DSH 插件：会话「重新生成标题」 | [2026-09-06-dsh-session-title-regenerate.md](2026-09-06-dsh-session-title-regenerate.md) | 外部插件用 commands.execute 触发 host 逻辑 + viewport 内 DOM 注入菜单项；最低推理=off+session-title；remote.commands 必须注入读；session.events 跨版本兼容 |
