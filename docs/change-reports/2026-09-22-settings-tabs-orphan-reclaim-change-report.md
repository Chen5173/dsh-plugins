# dsh-plugins 变更报告：设置入口收拢为核心「插件」页 tab + 孤儿子代理回收

日期：2026-09-22 · OpenSpec 变更：`openspec/changes/2026-09-22-settings-tabs-orphan-reclaim` · 涉及插件：`dsh-esc-rewind`、`dsh-plugin-manager`、`dsh-hindsight-model`、`dsh-idle-hook`

## 1. 需求与成功标准（逐项与用户确认过）

- **孤儿回收动作集**：只做「停止运行中的孤儿」+「找回成普通会话」；**不做删除**（用户未选）。
- **入口**：设置里只留**一个入口**，本仓各插件内容以 **tab** 切（用户原话：「能不能在 setting 目录下只有一个入口，进入入口后，再显示其他子插件的内容，类似 tab 进行切换」）。
- **自动化程度**：全手动，只做统计（无启动钩子、无定时器）。

## 2. 现状与根因

- 上一轮修复（`bf48bd1` 子代理守卫）只阻止**新**孤儿；既成孤儿在界面上**完全不可见**（侧栏过滤 `origin !== 'subagent'`，子代理只能从父会话的子代理目录进入）、**完全不可用**（投递授权按子会话自身 header 的 `parentSession` 校验，父 agent 已不在），运行中的还在烧 token 且结果无处投递。本机现场：98 个会话里 **27 个孤儿**（`cbec2279` 名下 24 个 + `e71582a6` 名下 2 个，其中 `6455048f` 父删后 8 分钟仍在写日志）。
- 核心**没有** reparent/adopt verb（全仓 grep 无生产者），子会话 header 是日志首事件不可变 ⇒ 「把子代理挂回某个会话」不可实现；**唯一**可行的是把它复制成普通会话。
- 设置入口方面：本仓已有 3 个插件各占一行 Settings 导航；而核心 `ui-settings-plugins` **早已**独占唯一的「插件」行并渲染 tab chrome，声明了列表槽 `settings.plugins.tab` 供功能插件贡献页面（核心注释原话：*feature plugins contribute pages without competing for Settings nav rows*）。插件侧自建导航行不可行：slot registry 只允许注册到父项已声明的子槽（未声明直接抛错）。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `sub-plugins/dsh-esc-rewind/src/index.js` | 新增 `orphanSetOf(corpus)`（可达性/传递判定，纯函数）、`scanOrphans(ctx)`（`sessionQuery.listSessions` 语料 + 逐项 `observeSession` 取 label/`atSeq`/最后活动，冷读并发 4、单条失败只降级该行、租约必释放）、`stopOrphanRun(ctx, id, {waitMs})`（not-running / confirmed / timeout 三态）；新增只读端点 `GET /__esc-rewind/orphans`、`POST /__esc-rewind/orphans/stop`；`/status` 带出 `orphans`；新增模型工具 `esc_rewind_orphans`（`list` / `stop`） |
| `sub-plugins/dsh-esc-rewind/src/client.js` | 新增「子代理」tab（`settings.plugins.tab`，id `subagents`，order 50；旧核心无该槽时静默降级 + 诊断）与回收面板（计数/列表/空态/失败态/刷新/逐项与批量「停止」「找回」）；新增 `fetchOrphans` / `stopOrphans` / `rescueOrphan`（运行中先停 → `sessions.fork({sessionId, atSeq})` → `rename(label)` → `open`）；诊断 `__dsew.orphans` / `orphanActions` / `orphanTabRegistered` |
| `dsh-plugin-manager/src/client.js` | 注册行 `settings.section`(16) → `settings.plugins.tab`(id `local-plugins`, order 20)；组件零改动 |
| `sub-plugins/dsh-hindsight-model/src/client.js` | 同（17 → tab order 30） |
| `sub-plugins/dsh-idle-hook/src/client.js` | 同（19 → tab order 40） |
| 四个插件的 `test/bundle.test.mjs` | 新增 12 条孤儿/入口用例 + 三个插件注册断言更新 + capability audit 增一条 |
| 四个插件的 `README.md` / `ACCEPTANCE.md` | 入口位置改述（设置 → 插件 → <tab>）；esc-rewind 新增「子代理回收」段与 6.1–6.7 人工项；idle-hook 计数 11→22 修正 |
| `docs/knowledge/2026-09-08-dsh-esc-rewind.md` + 索引 | v7.7 一节 + 索引一行 |

## 4. 关键决策

1. **不自建设置入口**，用核心 `settings.plugins.tab`：证据是核心自身注释与 `ui-settings-plugin-inventory` 的范式；自建不可行（未声明槽直接抛错）。
2. **孤儿按可达性（传递）定义**：父子代理链上任一环节断裂都算孤儿——因为这正是「用户点不进去」的那个条件。
3. **找回 = 复制成普通会话**：宿主只给 `atSeq`/`canRescue`，`fork` 仍走官方客户端服务；不删原孤儿（用户未选删除）。
4. **宿主半只读、零核心 import**：语料与逐项事实全部来自注入的 `sessionQuery`；`observeSession` 的 `Disposable` 租约显式释放（否则 pin 住冷读缓存）。
5. **停止要诚实**：`not-running` / `confirmed` / `timeout` 三态各自如实回报；超时绝不当成功。
6. **全手动**：无钩子、无定时器；打开面板与刷新都只是 GET（源码断言 + 用例断言双保险）。

## 5. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **86/86 passed** |
| `node dsh-plugin-manager/test/bundle.test.mjs` | PASS |
| `node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs` | **114/114 passed** |
| `node sub-plugins/dsh-idle-hook/test/bundle.test.mjs` | **22 checks passed** |
| 红绿验证（新用例跑在 `HEAD` 源码上） | esc-rewind **17 红**、manager **1 红**、hindsight **1 红**（113/114）、idle-hook **1 红**；恢复实现后全绿 |
| 语法 `node --check`（5 个改动源文件） | 全部通过 |
| 全仓 sweep（管理器 4 支 + 10 个子插件套件） | 全绿 |
| `openspec validate 2026-09-22-settings-tabs-orphan-reclaim` | valid（4/4 artifacts） |

## 6. 边界与遗留

- **没有删除动作**：孤儿本体保留（用户本轮未选删除）；`esc_rewind_orphans` 也只提供 `list` / `stop`。
- **真机验证待用户执行**（ACCEPTANCE 6.1–6.7 + 三个插件的 0.x 项）：重启 `dsh web`、刷新页面后，设置 → 插件 里应出现四个 tab；对现场 27 个孤儿做一次统计/停止/找回。
- **历史孤儿仍在**：本变更只提供处置手段，不会自动清（全手动是用户要求）。
- **归档未执行**：按仓库规则主 spec 的合并在归档时进行，且归档须由用户指令触发。
