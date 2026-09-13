## Context

动机见 `proposal.md`。本节只记塑造方案的约束。

### 为什么「净化环境」必须是插件自己的责任

权威文件会被启动路径回写，链路已读源码确认：`cli.py` 把 profile 载入 `os.environ` 时**不覆盖已存在的键** → `daemon_embed_manager` 用 `{**profile_config, **config}` 合并 → `_register_profile()` 把 `HINDSIGHT_API_*` 写回 → `profile_manager.create_profile()` 整体重写 `.env`。

上一版把这条责任交给了**用户手敲的命令文本**（`Remove-Item Env:…`）。一旦启停由插件执行，净化就必须在插件里完成——否则「点按钮启动」会比「手敲命令」更糟：它会用外层值覆盖刚保存的配置。

### 本机现状（实测）

- `~/.hindsight/coding-agent.json`：`daemonProfile=coding-agent`、`apiPort=9077`、`embedPackagePath=C:\Users\chensir5173\.hindsight\embed-project`
- 宿主进程 env 里有 `HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash`，profile 里是 `deepseek-flash` ⇒ **一条真实的待净化项**
- 当前 daemon 未运行（`GET :9077/health` 无响应）

### CLI 面（已核实源码）

`hindsight-embed daemon` 的子命令只有 `start`（可选 `--ui`）/ `stop` / `status` / `logs`，**没有 `restart`**；`--profile` 是全局参数。交接稿 §5.8 实测过 `uv run --directory <embed-project> hindsight-embed daemon --profile coding-agent start` 可用。

## Goals / Non-Goals

**Goals**

- 面板内完成启停，且**启停不会破坏刚保存的配置**（净化由插件保证，不再依赖用户记性）。
- 状态如实：运行中/已停止、PID、端口、启动时间、健康结果；未知就是未知。
- 停止/重启这类会中断记忆操作的动作，必须经过确认才执行。

**Non-Goals**

- 不做「保存并生效」一键链路（用户明确保留手动节奏）。
- 不做健康轮询/就绪等待（启动后由「刷新」或动作回执反映状态）。
- 不做开机自启、崩溃重启、守护监护。
- 不启动 `--ui` 控制平面、不包装官方 `control`。
- 不改 DSH 侧 `hindsight` 行的 `disabled`。

## Decisions

### D1. 由插件 spawn，而不是继续给命令文本

用户要求面板能启停；且净化责任移入插件后，spawn 是唯一能保证净化生效的位置。命令文本**保留展示**（复制、审计、故障时手动重放），但不再是唯一路径。

### D2. 净化名单 = profile 管理的键

spawn 子进程时，从 `process.env` 派生一份副本并删除 `MANAGED_KEYS`（即面板托管的那 13 个键，含 `HINDSIGHT_API_LLM_*`、`HINDSIGHT_API_PORT`、`HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT`、`HF_ENDPOINT`）。

**为什么是这 13 个**：它们正是 profile 拥有的键集。净化后 `cli.py` 的「不覆盖已存在键」判据落空，profile 成为唯一真源。

**为什么不顺手把 HKCU 也清掉**：那是独立的、需要用户决策的系统级写入，已由既有需求（「清理用户级冲突键需先导出备份并二次确认」）单独管辖；启停动作 MUST NOT 顺带改系统环境。

### D3. restart = stop → 等端口释放 → start

CLI 无 `restart` 子命令。实现为两次 spawn，中间按端口轮询等待释放（有上限），避免 start 撞上尚未退出的旧进程。等待上限与轮询间隔写进纯函数以便测试。

### D4. 停止是幂等的

daemon 本就没跑时停止必须成功返回并如实说明，而不是报错——否则「先停再起」在任何时候都可用，而「停一个已经停的东西」不该被当成失败。

### D5. 停止/重启要求服务端确认标志

端点对 `stop` / `restart` 要求 body 带 `confirm: true`；缺省回 400。前端的内联二次确认负责产生该标志。这与既有 `cleanEnv` 的做法一致：**不可逆/有副作用的动作，光靠前端确认不够**。

### D6. 单飞与超时

同一时刻只允许一个启停动作在跑（宿主侧串行化，前端按钮互斥）。`stop` 的超时明显长于 `start`——`uv` 冷启动 + 进程退出都可能慢。超时即失败，不重试（重试会让「到底停了没」更难判断）。

### D7. 动作回执直接带上新状态

`POST /daemon` 的响应里带上重新采集的四层快照，前端不必再打一次 `/state`；同时返回退出码与 stdout/stderr 的**尾部**（截断 + 脱敏：任何值形如密钥的一律不落）。这样「点完按钮发生了什么」在一屏内可见。

## Risks / Trade-offs

- **停止会中断进行中的记忆操作** → 二次确认 + 按钮旁常驻提示；不做 `pending_operations` 检查（用户先前已明确否掉）。
- **`uv` 冷启动慢** → 超时放宽；失败时回显 stderr 尾部，让用户能看到真实原因（例如没装 uv、embed-project 被移动）。
- **spawn 失败不回滚** → 因为没有什么可回滚的：启停不改任何文件。失败只报告，不重试。
- **净化名单随上游增长而滞后** → 名单由本仓库 `MANAGED_KEYS` 单一来源派生；上游新增**未被我们托管**的键不会被净化，但也不会被我们写坏（我们只写托管键）。
- **面板能停掉自己的记忆层** → 这是用户要的能力；风险通过确认门与状态可见性控制，而不是通过禁止。停止后 ②④ 两层会如实显示「守护进程未在运行」（既有需求已覆盖）。
- **`--ui` / `control` 未纳入** → 明确出界；若日后要做，属于新增 capability 行为，需另开变更。

## Migration Plan

1. 无数据迁移、无 schema 变更、无配置格式变更。
2. 部署：管理器面板停用/启用该插件即可（客户端半改动刷新页面；宿主半改动需重启 `dsh web`）。
3. 回滚：停用插件。插件对系统的写入面未变（仍只写 profile `.env` 与备份/导出文件）；**启停动作不写任何文件**，因此回滚不涉及遗留状态。
4. 已归档变更里的「重启命令」区块继续存在，用户原有工作方式不受影响。

## Open Questions

- 是否要在启动后**自动轮询健康直至就绪**（而不是让用户点「刷新」）。当前不做；若要，属于行为增强，需另开变更。
- 是否要把 `--ui`（控制平面）与 `control` 一并做成可启动项。当前明确不做。
