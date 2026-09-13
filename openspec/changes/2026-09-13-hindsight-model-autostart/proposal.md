## Why

Hindsight 的记忆要在「下一次请求」里真正起作用，守护进程就必须在跑；但本机**没有任何东西会自动把它拉起来**：

- 官方 `hindsight` 行确实带着自动拉起（宿主半订阅 `agent/session-start` 与 `agent/pre-step` → `ensureDaemon()` → `/health` 通就采纳、否则后台 detach 拉起），但它的 `preflightDaemon()` 里 `detectLlm()` 只认**宿主进程 env** 的 `HINDSIGHT_API_LLM_PROVIDER` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY`，或 `which claude`（Windows 上 `which` 不存在）。本机的 provider 写在 **profile `.env`** 里，宿主 env 没有 ⇒ 每次只记一条 `daemon_no_llm` 就返回。2026-09-13 的实验复现了这一点。
- 就算把那份 env 补给它，也有两笔代价（同一实验的实证）：① 它的启动器会**闪一个控制台窗口**——`startDaemonDetached()` 把 node 起成 `detached: true`（`DETACHED_PROCESS`，无控制台；此时同传的 `windowsHide` 不起作用），内层 `spawn('uv', …, { stdio: 'pipe' })` 没带 `windowsHide`，于是控制台子系统的 `uv.exe` 新建一个可见 `conhost`（实验里那个 conhost 的父进程就是 `uv.exe`；面板那条因为 `windowsHide: true`，一个窗口都不闪）；② 它每次启动都把宿主 env 里所有 `HINDSIGHT_API_*` 交给 `profile create --merge` 写回 profile（`daemonEnv()`），也就是**承认「外层 env 会赢」**，与「profile 是唯一真源」的设计直接冲突——三件套同值时那次 profile 逐字节未变，但一旦用户在面板改了值就会被 env 覆盖回去。

结果：**只有用户记得在面板点「启动」才有记忆**。这正是本变更要补的一块。

## What Changes

在既有 `dsh-hindsight-model` 插件上新增**按需惰性自动启动**，并复用已经落地的启停链路（不新增任何启动方式）：

- **触发**：会话开始 / 首次需要记忆时检查一次。宿主半订阅会话生命周期事件；事件服务缺失时**能力探测降级**为「仅面板手动」，不报错。
- **前置探测**：`GET /health` 通 ⇒ **采纳**（不重启、不写任何文件）；不通 ⇒ **后台惰性冷启动**（不阻塞会话）。失败**退避**、不逐回合重复尝试。
- **可见性**：面板「守护进程」状态行显示「正在后台冷启动（约 44–73s）」「上次自动启动的结果」。
- **开关**：settings 新增 `autoStart`，关掉即退回今天的手动语义。
- **启动前 launcher 自愈**：启动前读 `.venv\Scripts\pythonw.exe` 的 PE 子系统；若为控制台程序(3) ⇒ 用同一份 uv 基础里的 GUI 版覆盖（**先备份原件**）后再启动，并在状态行与动作回执里如实写明「本次换回了 GUI launcher」。
- **启动来源可见**：状态行标注本次是 **本插件自动 / 面板手动 / 外部** 拉起；外部拉起的若监听进程镜像为控制台 `python.exe`，标注「有控制台窗口风险」。
- **净化路径不变**：启动仍走 `uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> start`，子进程 env 仍**净化**，且**绝不调用 `profile create`**。

**明确不做**：改 `~/.hindsight/coding-agent.json`（`serverMode` / `embedPackagePath` / …）· 动官方 `hindsight` 行（含写 `disabled`）· 给第三方包打补丁 · 开机自启（Windows 服务 / 任务计划）· 多 profile · 复刻上游 `detectLlm()` 那类前置判定。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `hindsight-model`: 在既有需求「面板可启停守护进程，且启停必须净化子进程环境」之上**新增三条需求**：① 守护进程**按需自动启动**（健康则采纳、不健康则后台冷启动、失败退避、可开关）；② 启动前 **launcher 自愈**（子系统为控制台时换回 GUI 版并如实报告）；③ 启动**来源可见**（本插件自动 / 面板手动 / 外部；外部为控制台镜像时标注窗口风险）。其余需求（四层呈现、行级写入、冲突源边界、密钥不出宿主进程、生效断言、手动启停四动作等）**不变**。

## Impact

**新增代码**

- `sub-plugins/dsh-hindsight-model/src/host-core.js`：健康探测编排、退避策略、启动来源判定、PE 子系统读取与自愈的纯函数
- `sub-plugins/dsh-hindsight-model/src/index.js`：会话生命周期订阅（能力探测）+ 现有 `/__hindsight-model/daemon` 与 `/state` 的扩展
- `sub-plugins/dsh-hindsight-model/src/client.js`：`autoStart` 开关、状态行新增文案（冷启动中 / 上次结果 / 来源 / 窗口风险）
- `sub-plugins/dsh-hindsight-model/test/bundle.test.mjs`、`README.md`、`ACCEPTANCE.md`

**外部交互面**

- 读：`~/.hindsight/coding-agent.json`（已在读）、`GET http://127.0.0.1:<apiPort>/health`（已在用）、`.venv\Scripts\pythonw.exe` 的 PE 头（**新增只读**）
- 写：settings 命名空间新增一个布尔键（`dsh-hindsight-model.autoStart`）；自愈时**新增一处文件写入**——备份并覆盖 `.venv\Scripts\pythonw.exe`（仅在子系统为控制台时发生）
- 进程：**自动启动会在后台产生进程副作用**，命令与今天面板按钮完全相同

**前置依赖（必须先满足）**

- 本变更的 ADDED 需求与主 spec 里现行那条「插件 MUST NOT 自行启动、停止或重启守护进程」**直接冲突**；该条已由**尚未归档**的 `2026-09-13-hindsight-model-daemon-control` 变更 `REMOVED`。因此本变更的**实现与归档必须排在那个变更归档之后**（顺序反过来会让主 spec 自相矛盾）。
- 与官方 `hindsight` 行**并存且不冲突**：它的自动拉起若能生效，`/health` 探测会让本插件直接采纳、不重启。

**不受影响**

- 四层对照、行级写入与备份、从 DSH 读取、HKCU 清理、面板四个手动动作的既有行为
- 不改 DSH 核心、不改上游 Hindsight 包、不新增依赖、不写 profile `cordis.patch.yml`
