## Why

面板已经能把 Hindsight 的模型配置看清楚、改正确，却**动不了那个进程**：守护进程既无热加载（改配置必须重启），官方插件的自动拉起在 Windows 上又是坏的（`onPath()` 用 Unix `which` ⇒ `detectLlm()` 落空 ⇒ `preflightDaemon()` 拒绝启动）。于是「改完要生效」这一步只能靠用户自己开终端敲命令，而**敲的时候还得记着先清冲突环境变量**——不然外层值会在启动时经 `_register_profile()` 把刚保存的 profile 覆盖回去。

用户实测后要求补上这个能力：**面板要支持启动 / 停止 Hindsight 守护进程**。这同时意味着修订上一个变更里的一条硬约束（当时按用户选择写成「插件 MUST NOT 自行启动、停止或重启守护进程」）。

顺带一个现场证据：本机 daemon 目前就是停着的（`GET http://127.0.0.1:9077/health` 无响应），而面板四层里的 ②④ 两层在此时只能显示「未知」——面板能读不能动，缺的正是这块。

## What Changes

在既有 `dsh-hindsight-model` 插件上新增**守护进程启停**能力，其余（四层对照、行级写入、从 DSH 读取、清理冲突键）一概不动：

- 面板新增「守护进程」区块：状态行（运行中/已停止 · PID · 端口 · 进程启动时间 · `/health` 结果）+ 四个动作 `启动` / `停止` / `重启` / `刷新`（动作进行中互斥）。
- 新增宿主端点 `POST /__hindsight-model/daemon`，body `{action: 'start'|'stop'|'restart'}`。
- 命令由本机 `~/.hindsight/coding-agent.json` 生成，不硬编码：
  `uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> start|stop`。
  **CLI 没有 `restart` 子命令**（已核实只有 `start`/`stop`/`status`/`logs`），故重启 = `stop` → 等端口释放 → `start`。
- **spawn 时净化子进程环境**：剥掉全部 profile 管理的键。这是让「保存」真正生效的关键一步，等效于原先要求用户手敲的 `Remove-Item Env:`，现在由插件保证。
- 安全门：`停止`/`重启` 内联二次确认；daemon 本就没跑时 `停止` 视为幂等成功但如实说明。
- 失败降级：读不到本机配置或生成不出命令时，该区块整体禁用并写明缺什么，其余功能照常。
- 动作回显：退出码 + stdout/stderr 尾部（截断、脱敏），不回滚、不重试。

**明确不做**：一键「保存并生效」链路（用户选择保留手动节奏）· DSH 侧 `hindsight` 行的 `disabled` 开关 · 开机自启 / 守护监护 · `pending_operations` 插队检查（用户先前已否）· 不做 `--ui` / `control` 的启动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `hindsight-model`: 原需求「插件不启停守护进程，只提供已净化环境的重启命令」整条改写为「面板可启停守护进程，且启停必须净化子进程环境」——不再是「给一条命令让用户自己敲」，而是面板直接执行，并把原先由用户命令字符串承担的**环境净化**责任移进插件自身。其余 12 条需求不变。

## Impact

**新增代码**
- `sub-plugins/dsh-hindsight-model/src/host-core.js`：启停纯逻辑（净化环境构造、命令参数生成、幂等判定、输出截断）
- `sub-plugins/dsh-hindsight-model/src/index.js`：`POST /__hindsight-model/daemon` 端点 + 带净化 env 的 spawn
- `sub-plugins/dsh-hindsight-model/src/client.js`：「守护进程」区块与四个动作 + 二次确认
- `sub-plugins/dsh-hindsight-model/test/bundle.test.mjs`：对应用例

**外部交互面（新增写入/进程动作）**
- 读取：`~/.hindsight/coding-agent.json`（`daemonProfile` / `apiPort` / `embedPackagePath`，均已读）、`GET http://127.0.0.1:<apiPort>/health`
- 进程：spawn `uv run --directory <embedPackagePath> hindsight-embed daemon --profile <daemonProfile> start|stop`（这是本插件**第一次**产生进程副作用）
- 不再需要用户手动执行重启命令（原「重启命令」区块改为仍保留命令文本，供复制/审计，但不再把它当作唯一路径）

**不受影响**
- 四层读取、行级写入与备份、从 DSH 读取、HKCU 清理的既有行为与规格
- 文件写入面不变（仍只写 profile `.env` 与备份/导出文件；不写 profile `cordis.patch.yml`）
- 不改 DSH 核心、不改上游 Hindsight 包、不新增依赖
