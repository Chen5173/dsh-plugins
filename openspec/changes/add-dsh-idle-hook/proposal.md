# Proposal

## Why

DSH 常常无人值守地跑很久：一轮可能几分钟到几十分钟。人离开屏幕后就无法知道它现在是「跑完等你输入」「卡在等你批准」，还是「报错停下了」。

已经装在 profile 里的 `dsh-notification` 只解决了一半：它是**客户端半**的浏览器原生通知，页面一关就彻底静默，且只在一轮结束（running→idle 边沿）时响，完全覆盖不到「等待批准 / 等待回答」这两种最需要人介入的状态；它也不能把通知送到手机或办公 IM（例如网易 POPO）。此外它的偏好存在 localStorage，与 DSH 的配置体系无关。

缺的是一条**由人自己配置、在 DSH 进程内（不依赖浏览器页面）按智能体状态自动执行任意本地脚本**的通路：脚本可以是 python / bat / ps1 / sh / 可执行文件，怎么通知（系统提示音、手机推送、办公 IM webhook）由人自己决定。

## What Changes

- 新增子插件 `sub-plugins/dsh-idle-hook`（宿主半 + 客户端半 + README + ACCEPTANCE + 测试 + examples）；按 2026-09-10 起的仓库规则**不声明 `dsh.bundle`、不带自带 `cordis.patch.yml`**，激活行由管理器维护。
- 新增设置页一级入口**「空闲通知」**（`settings.section`，order 19）：全局总开关、规则列表（增/删/改/启用）、每条规则的「试跑」按钮、上次运行时间/耗时/退出码、失败标红、可展开的最近 200 条执行历史。
- 新增触发（宿主半，页面关着也生效，边沿触发）：
  - **一轮结束**：`turn/end` 的 `completed` / `blocked` / `error` / `max-tokens` 触发；`aborted` 除 `reason.kind ∈ {user, disposed}` 外触发（自己按的 Stop 不响）。
  - **等待人类批准**：监听 `approval/request` 瀑布，**只观察不改行为**。
  - **等待人类回答提问**：监听 `user-questions/request` 瀑布，同样只观察。
- 新增规则执行语义：同规则去抖（默认 3 秒）、同规则并发时跳过、超时（默认 30 秒）杀进程、连续失败 3 次自动停用并标红。
- 新增脚本调用契约：按扩展名自动选择解释器（`.py`/`.bat`/`.cmd`/`.ps1`/`.sh`/可执行文件）、参数数组直传（默认不经 shell，另有逃生开关）、`~` 展开、占位符 `{sessionId}` `{cwd}` `{title}` `{reason}`、stdin JSON + 环境变量传递上下文（**不含对话正文**）。
- 新增**两层环境变量**配置：全局（所有规则共用）与规则级（可覆盖全局）；执行时按「进程环境 → 全局 → 规则 → `IDLE_HOOK_*` 契约」合并，契约键不可覆盖（仅提示）；值支持占位符，历史只记录键名。
- 新增配置持久化：规则存 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook:` 命名空间；执行历史（滚动 200 条）存 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`。
- 新增页面在场判定：客户端半心跳上报可见性/聚焦；每条规则的「触发前提」三档（任意 / 仅页面关着 / 仅页面不可见或失焦），据此与 `dsh-notification` **分工互斥、不重复通知**。
- 新增 `examples/` 通知脚本示例：macOS（osascript/afplay）、Windows（PowerShell）、手机推送（Bark/ntfy）、Webhook（飞书/企业微信/钉钉/Telegram/Slack）、**网易 POPO**（notify 接口，Python 3）。
- 明确不做：面向模型的工具（模型不能改规则、不能自己触发脚本）、把对话正文交给脚本、浏览器原生通知（继续归 `dsh-notification`）。

## Capabilities

### New Capabilities

- `idle-hook`: DSH 处于「模型不在运行」（一轮结束 / 等待批准 / 等待回答）时，按用户配置的规则执行本地脚本并记录执行结果——涵盖触发矩阵与边沿语义、脚本调用契约与生命周期、失败处理、设置页配置与执行历史、页面在场判定、「试跑」语义。

### Modified Capabilities

（无：本变更不改动 `plugin-manager` / `esc-rewind` / `composer-history-recall` / `composer-provider-label` 的任何既有需求。）

## Impact

- **新增代码**：子插件 `sub-plugins/dsh-idle-hook/`（`package.json`（无 `dsh.bundle`）、`src/index.js` 宿主半、`src/client.js` 客户端半、`src/host-core.js`、`README.md`、`ACCEPTANCE.md`、`test/`、`examples/`）。
- **安装方式**：由 dsh-plugin-manager 的「本地插件」面板扫描 `sub-plugins/` 后启用（管理器写入 profile 的激活行），**不改** 仓库根 `package.json`（它是管理器的安装外壳）、**不改** 任何既有激活行。
- **运行时副作用（宿主半，需在 README 显著位置声明）**：执行用户配置的本地进程；写 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook` 命名空间与 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`；注册 `/__idle-hook/*` HTTP 前缀路由。
- **接缝风险**：新增两个瀑布监听（`approval/request`、`user-questions/request`）必须 `{ prepend: true }` 且立即 `return next()`，否则会截断批准/提问链路（需用测试守住）。
- **依赖**：仅 Node 内建模块；宿主半**零** `@deepseek-ai/*` import（仓库既有硬规则）。
- **不影响**：`dsh-notification` 的行为与其配置。
