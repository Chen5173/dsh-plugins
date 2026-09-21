# 验收清单 — dsh-session-title-regenerate

代码侧的 25 条逻辑断言已由 `test/bundle.test.mjs` 自动覆盖并通过（宿主 16 条 + 客户端 9 条）。本清单覆盖**只有装起来在浏览器里才能确认**的部分：真实安装、视觉布局、模型调用落地、标题即时刷新、语言切换、以及与其它插件共存。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
# 核心版本必须 >= 0.1.1-rc.2（remote.commands.execute、ctx.sessionTitle、purpose:'session-title' 均需该版本）
dsh --version
```

版本不够时预期表现：头部按钮点击或菜单项点击会 Toast 报「没有可用的命令通道」/ 生成失败，**不会崩溃**。

## 1. 安装与加载

安装一律走管理器面板（先装 `dsh-plugin-manager` 一次 → 重启 `dsh web` → 设置 →「本地插件」→ 打开本插件主开关）。**不要**用 `dsh plugin --profile web add` 装本子插件（不会激活，见 README 警示）。

```bash
dsh --dump-config --profile web | grep -n session-title-regenerate   # 应看到一行
```

- [ ] 1.1 `[B]` 装好管理器、重启后 `dsh web` 无报错、无插件加载失败提示，面板里本插件显示为「已启用」
- [ ] 1.2 `[B]` 面板启用后：profile `devDependencies` 出现本插件的 `link:`、`dsh.profile.bundles` 里本地条目仍**只有 `dsh-plugin-manager`**
- [ ] 1.3 `[B]` Console 无 `slot "conversation.session.header.actions" is not declared`、无 `list slot ... already has an entry with id`
- [ ] 1.4 在面板里把主开关**关→开**一次 → profile `cordis.patch.yml` 里 `session-title-regenerate` 行**始终只有一行**（不产生第二条），且开回后功能恢复
- [ ] 1.5 `[H]` `grep -rnE "from '@deepseek-ai/|require\('@deepseek-ai/" dsh-session-title-regenerate/src/index.js` 无输出（宿主半零宿主包 import；注释里提到包名不算）
- [ ] 1.6 `[B]` link 安装可直接加载（无 `node_modules`、默认解析）：`cd ~/.dsh/profiles/web && node --input-type=module -e "await import('dsh-session-title-regenerate')"` → 打印 `OK`

## 2. 头部按钮入口（spec：会话头部提供重新生成标题入口）

- [ ] 2.1 `[B]` 选中任意有内容的会话 → 头部动作条出现刷新图标按钮，tooltip「重新生成标题」
- [ ] 2.2 `[B]` 与既有按钮同排不重叠（`open-session-workdir` order 25 → 本按钮 order 27 → `session-delete` order 30），确认不遮挡
- [ ] 2.3 `[B]` 点击 → 图标进入 loading，完成后 Toast「标题已更新：<新标题>」，会话列表标题**即时**变化，无需刷新
- [ ] 2.4 `[H]` 无 sessionId 时不渲染（空白会话/无会话态）

## 3. 侧边栏 ⋯ 菜单项（spec：会话列表行的菜单里有重新生成标题）

- [ ] 3.1 `[B]` 任一会话行点 `⋯` → 「重新生成标题」出现在**官方"重命名/分叉/归档"正下方**（无分隔线、刷新图标），其后才是其它插件项（如 session-delete 的"删除会话"）
- [ ] 3.2 `[B]` 点击该项 → **不切换当前对话**、不打开目标会话；Toast 显示新标题；目标会话在列表里的标题即时更新
- [ ] 3.3 `[B]` 对**未打开的历史会话**（冷会话）点该项 → 同样生成并更新标题（host 经 `commands.execute` 自动恢复会话）
- [ ] 3.4 `[B]` 打开菜单 → 收起 → 再打开 → 注入项**不重复**（幂等）
- [ ] 3.5 `[B]` 工作区行的 `⋯` 菜单（不是会话行）→ **不出现**本插件项
- [ ] 3.6 `[B]` 开着 `dsh-flowglass`（抽屉/右侧栏已挂载）时打开会话行 `⋯` 菜单 → `分叉会话 / 归档会话 / 重新生成标题` **各自只出现一次**；flowglass 自己的「加入当前并发分支」（或其禁用语「暂无当前并发」「不在当前工作区」）**只有一行**，不产生整段菜单的副本（修复前：官方三项与注入项成排重复，见 `docs/knowledge/2026-09-06-dsh-session-title-regenerate.md` 末节）

## 4. 生成语义（spec：总结全部用户提问、最低推理、60 字、单行）

- [ ] 4.1 `[B]` 多轮对话会话 → 新标题反映**整体**主题（含后续提问），不只看第一句
- [ ] 4.2 `[B]` 中文对话 → 标题为中文；英文对话 → 标题为英文（跟随消息语言）
- [ ] 4.3 `[B]` 标题单行、无引号、无 Markdown/emoji 前缀；长度 ≤ 60 字
- [ ] 4.4 `[H]` 模型输出首尾引号/换行/控制字符 → 被清洗；超 60 码点被截断
- [ ] 4.5 `[H]` 提供方不支持 `reasoningEffort:'off'` → 自动去掉该字段重试一次并成功
- [ ] 4.6 `[B]` DevTools → Network 观察：本次标题调用**没有思考（reasoning）输出**（DeepSeek `session-title` 强制 `thinking:disabled`），输出 token 极少（≤100）

## 5. 覆盖与固定（spec：始终覆盖、直接应用）

- [ ] 5.1 `[B]` 对已有标题（含自动生成的）点重新生成 → 旧标题被替换
- [ ] 5.2 `[B]` 重新生成后**再发一条新消息** → 标题**不**自动变化（被固定为 user 来源）；再次点重新生成 → 标题按新内容更新

## 6. 反馈与错误

- [ ] 6.1 `[B]` 成功 → 顶部 Toast，约 4s 自动消失，无 Modal
- [ ] 6.2 `[B]` 空会话（没有任何用户提问）→ Toast 报「这个会话还没有可总结的用户提问」
- [ ] 6.3 `[B]` 断网/模型不可用时 → Toast 报错，头部按钮恢复可点，**不永久停在 spinner**
- [ ] 6.4 `[B]` 关闭会话/切走再回来 → 无残留 Toast/状态

## 7. 语言与主题

- [ ] 7.1 `[B]` 中文客户端 → 按钮 title、菜单项、Toast 前缀为中文
- [ ] 7.2 `[B]` 切英文后**不刷新**再看 → 按钮/菜单项/Toast 前缀变英文（`locale/change` 生效）
- [ ] 7.3 `[B]` 深色/浅色主题各看一次 → 无硬编码色、无对比度失效

## 8. 共存

- [ ] 8.1 `[B]` 与 `@huanlin/dsh-plugin-session-delete` 同时启用 → 两插件菜单注入项都出现、都可用、互不重复
- [ ] 8.2 `[B]` 与 `dsh-open-session-workdir`、`dsh-composer-history-recall` 同时启用 → 头部按钮同排不遮挡，composer 行为不受影响
- [ ] 8.3 `[B]` composer 输入 `/regenerate-title` → 命令同样生效（命令注册进 commands 列表）

## 9. 回滚

```bash
# 在管理器面板里操作，不要用 dsh plugin remove（会留下悬空激活行）
# 方式 A：停用 —— 关掉本插件主开关（profile 行写 disabled: true，行保留）
# 方式 B：卸载 —— 点本插件行上的「移除」（删激活行 + 摘 devDependency；源码目录保留）
```

- [ ] 9.1 `[B]` 停用后（宿主侧即时生效，刷新页面）按钮与菜单项消失，无残留报错；再开回主开关恢复
- [ ] 9.2 插件不写任何持久数据（只追加 `session/title` 事件）→ 卸载后 `~/.dsh/` 下无本插件目录，且 profile 里无指向本包的悬空行
