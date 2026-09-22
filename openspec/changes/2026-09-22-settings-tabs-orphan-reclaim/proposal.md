## Why

上一轮修复（`bf48bd1`：删除模式子代理守卫）只阻止了**新**孤儿的产生，既成的孤儿仍在：孤儿子代理是「子代理会话的父会话已不存在」的会话，它们**在侧栏完全不可见**（核心只渲染 `origin !== 'subagent'` 的行，子代理只能从父会话的子代理目录进入），**也完全不可用**（投递授权按子会话自己 header 的 `parentSession` 校验，而父 agent 已不在注册表），运行中的还会继续烧 token 且结果无处投递。真机现场（2026-09-22 全库扫描）：98 个会话里 **27 个孤儿子代理**，其中 24 个来自同一个已删除的父会话 `session-cbec2279`，另一个仍在跑（`6455048f`「Mac 侧重建与回归流水线」，父会话被删后 8 分钟仍在写日志）。

同一轮观察还暴露出设置入口的臃肿：本仓已有 3 个插件各占一行 Settings 导航（`local-plugins` 16 / `hindsight-model` 17 / `idle-hook` 19），孤儿回收再开一行就是第 4 行。而核心**已经**提供了「一个入口 + tab 切换」的机制：`ui-settings-plugins` 独占唯一的「插件」导航行并渲染 tab chrome，它在运行期声明列表槽 `settings.plugins.tab` 供功能插件贡献页面（核心注释原话：*feature plugins contribute pages without competing for Settings nav rows*），`ui-settings-plugin-inventory` 是现成范式。于是本变更一并做两件事：孤儿回收（新能力）与设置入口收拢（本仓各插件的设置页改为「插件」页里的 tab）。

## What Changes

- **新增：孤儿子代理的发现与统计**（宿主半，只读）：扫描会话语料，把「子代理会话的祖先链已断」的那些列为不可达孤儿，并带上 `running`、可否找回（是否有完整回合边界）、最后活动时间、创建标签；零副作用。
- **新增：孤儿「停止」**：对运行中的孤儿取消其 agent 并等待静默（有上限、超时如实回报），用于止损——其结果本来就无处投递。
- **新增：孤儿「找回」**：把孤儿 `fork` 成**普通会话**（`origin` 为空 ⇒ 侧栏可见、可继续追问），保留标题与全部已落盘对话；**不删除**原孤儿；没有完整回合边界时明确失败；对运行中的孤儿先停止再 fork。
- **新增：「插件」设置页里的「子代理」tab**（`settings.plugins.tab`，id `subagents`）：统计 + 列表 + 逐项/批量「停止」「找回」，失败可见，全手动（只统计不自动动作）。
- **迁移：本仓自建设置行 → 「插件」页 tab**：`dsh-plugin-manager`（原 `local-plugins` 16）、`dsh-hindsight-model`（原 17）、`dsh-idle-hook`（原 19）不再注册 `settings.section` 一级导航行，改为贡献 tab（能力与交互不变，仅入口位置变化）。**BREAKING（对用户可见位置）**：Settings 左侧导航里这三行消失，内容移入「插件」页对应 tab。
- 文档：三个受影响插件与 esc-rewind 的 `README.md`/`ACCEPTANCE.md` 同步；主 spec 归档时同步。

## Capabilities

### New Capabilities

（无。孤儿回收归入既有 `esc-rewind`：它与该插件的删除通道、会话处置语义同源，且共享宿主半与诊断面；不新造能力目录。）

### Modified Capabilities

- `esc-rewind`：新增「设置入口是『插件』页的一个 tab」「孤儿按可达性判定且只读呈现」「停止运行中的孤儿」「找回孤儿为普通会话」「全手动不自动动作」五条要求。
- `plugin-manager`：修改「设置入口与生效模型」——面板入口由独立 `settings.section` 一级导航行改为「插件」页 tab（id `local-plugins`）。
- `hindsight-model`：修改「设置页提供 Hindsight 模型面板」——同上，入口改为「插件」页 tab（id `hindsight-model`）。

（`dsh-idle-hook` 目前没有 spec of record（其变更 `add-dsh-idle-hook` 尚未归档），本次按任务迁移其入口、只在 README/ACCEPTANCE 记账，不写 spec delta。）

## Impact

- 代码：`sub-plugins/dsh-esc-rewind/src/index.js`（孤儿扫描/停止端点 + 诊断面）、`sub-plugins/dsh-esc-rewind/src/client.js`（tab 注册 + 回收面板 + 找回动作）、`dsh-plugin-manager/src/client.js`、`sub-plugins/dsh-hindsight-model/src/client.js`、`sub-plugins/dsh-idle-hook/src/client.js`（入口注册迁移）。
- 测试：`sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`（宿主纯逻辑 + 端点 + 面板 + 动作）、`dsh-plugin-manager/test/bundle.test.mjs`、`sub-plugins/dsh-hindsight-model/test/bundle.test.mjs`、`sub-plugins/dsh-idle-hook/test/bundle.test.mjs`（注册断言改槽名/顺序）。
- 宿主 API：只用官方服务——`sessionQuery.listSessions/observeSession`、`sessions`、`agents`（宿主半）与 `sessions.fork/open`、`slots.register`、`locale`、`webServer`（客户端半）；**不 import 核心包**（沿用本插件的去核心化约定）。
- 兼容：`dsh-plugin-manager` 是仓库根安装外壳（`dsh.bundle`），本次只改其**客户端面板的注册槽**，不动包名/`main`/`exports`/`dsh.bundle.patch`/`cordis.patch.yml`，`root-install-shell.test.mjs` 的 18 条断言不受影响。
- 运行期：宿主半改动需重启 `dsh web`；客户端半刷新页面。
