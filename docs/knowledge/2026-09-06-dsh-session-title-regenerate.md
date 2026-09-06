# DSH 插件：会话「重新生成标题」（dsh-session-title-regenerate）— 2026-09-06

## 目标（What & Why）
给 DSH 会话加「重新生成标题」动作：用**当前模型、最低推理档**总结该会话**全部用户提问**，生成 ≤60 字单行标题并覆盖旧标题。入口：会话头部操作按钮 + 侧边栏会话行 `⋯` 菜单项。GUI 无法自动化，交付物 = 插件源码 + 23 条可跑逻辑测试 + README/ACCEPTANCE 验收清单。

## 改动摘要（What changed）
- 新插件目录 `dsh-session-title-regenerate/`：`package.json`（cordis client 声明）、`cordis.patch.yml`、`src/index.js`(host)、`src/client.js`(client)、`test/bundle.test.mjs`、`README.md`、`ACCEPTANCE.md`，以及测试专用本地 `dsh-llm` 桩（`node_modules/@deepseek-ai/dsh-llm`，不发布、运行时不用）。
- host：`ctx.commands.register('regenerate-title')`：收集全部 `user/message` 文本（UTF-8 字节截断）→ `ctx.llm.stream({reasoningEffort:'off', purpose:'session-title', maxTokens:100, …})`（带 30s 超时护栏）→ 清洗成单行并截 60 码点 → `sessionTitle.rename()` 覆盖固定。
- client：头部按钮（`conversation.session.header.actions`，order 27）、会话行 `⋯` 菜单项（DOM 注入进内容区 viewport）、`shell.overlay` 上的共享 Toast；统一经 `remote.commands.execute` 触发。

## 关键设计决策（Decisions）
- **用命令通道而非自定义 Remote**：外部插件无法新增 typert Remote（发布时才生成客户端代理+schema，运行时无 codegen）。`commands.execute` 是核心 Remote，其 `agent` 查找会自动恢复未打开会话 → 冷会话也能生成。
- **"最低推理模式"落地** = `reasoningEffort:'off'` + `purpose:'session-title'`（DeepSeek 适配器对 session-title 强制 `thinking:disabled`）+ `maxTokens:100`；提供方返回 `UNSUPPORTED_REASONING_EFFORT` 时去掉该字段重试一次。
- **写入用 `sessionTitle.rename`**（公共 API，客户端列表经 title 投影即时刷新）；语义=来源 `user`、标题被固定（之后新消息不再自动更新），符合"始终覆盖"。
- **菜单项追加进内容区 viewport**（`[role=menu] > role=presentation`），而非 append 到 `[role=menu]`——这样项紧跟官方三项、位于 session-delete 等插件项之前、且不带自身分隔线。
- 测试桩刻意还原两处真实运行时行为：remote 根控制器是"需注入的抛错访问器"；Menu 原生项在嵌套 viewport 里。

## 接口与用法（Interfaces）
- 命令：`/regenerate-title`（`recordInput:false`；也出现在 composer 的 `/` 命令菜单）。
- 配置（profile 的 `cordis.patch.yml` 行 `config:`）：`provider`/`model`（缺省跟随会话当前模型）、`targetWords`(40)、`targetCjkCharacters`(60)、`maxInputBytes`(12KB)、`maxOutputTokens`(100)、`timeoutMs`(30s)。
- 安装：`dsh plugin --profile web add ./dsh-session-title-regenerate`，或按 web profile 惯例 `link:` 依赖 + `dsh.profile.bundles`。
- 客户端 i18n：NS=`session-title-regenerate`，zh/en 字典 + locale 服务。

## 踩坑与解法（Gotchas）
- **`cannot get property "remote.commands" without inject`**：外部插件拿到的 `remote` 根上，每个控制器是"需先注入才能读"的访问器。解法：`ctx.inject(['remote.commands'])` 或在注入作用域里 `ctx.get('remote.commands')` 取控制器，绝不直接读裸根 `.commands`（open-session-workdir 读 `remote.session` 是同一个坑）。
- **菜单项排在删除会话后面 / 被分隔线隔开**：核心 Menu 真实 DOM 是嵌套的（原生项在 `[role=menu] > role=presentation(viewport)` 里，session-delete 的项是 append 到 `[role=menu]` 的直接子节点）。曾误以为原生项是 `[role=menu]` 直接子节点而排序失败 → 改为注入 viewport。
- **`session.events` vs `snapshotEvents()`**：0.1.1-rc.2 是 `events` getter，0.1.2-rc.1 起是 `snapshotEvents()` 方法；用 `sessionEventsOf()` 兼容。`requestHeader()` 与 `sessionTitle.rename` 两个版本都存在。
- **测试假 DOM 必须贴近真实**：tagName 大写、递归 querySelector、`class*=` 选择器、viewport 嵌套结构，缺一都会让测试失真（曾因假 DOM 过简放过一个真 bug）。

## 未完成 / 后续（Follow-ups）
- 装进 web profile 后按 `ACCEPTANCE.md` 人工逐条验收（GUI 侧无法自动化）。
- 若上游为会话 `⋯` 菜单新增插件槽位，可把 DOM 注入平滑换成槽位实现。
- `commands.execute` 会在会话流留 `command/run`+`command/done` 一对节点（已 `recordInput:false` 不记参数）；若嫌噪可评估自建 HTTP 端点方案（需自行实现冷会话恢复，风险更高，暂不做）。

## 复现 / 验证（Verify）
```bash
node dsh-session-title-regenerate/test/bundle.test.mjs        # 23/23 逻辑测试
node --check dsh-session-title-regenerate/src/index.js
node --check dsh-session-title-regenerate/src/client.js
```
GUI：硬刷新（Ctrl+Shift+R）→ 打开会话行 `⋯` 菜单：应为 `重命名 / 分叉会话 / 归档会话 / 重新生成标题`（无分隔线），`删除会话` 在其下；点击后不切换会话、Toast 显示新标题、列表标题即时更新。
