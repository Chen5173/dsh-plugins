## Why

Hindsight（Vectorize 的长期记忆层）以 DSH 插件形式嵌入，但后端是**独立 Python 守护进程**，与 DSH 硬隔离：进程分离、凭据分离（DSH 的 `~/.dsh/.credentials.yaml` 它不认）、语义上只认 `base_url + api_key + model` 三件套。所以它必须**单独配模型**，而目前这件事只能手改文件 + 手动重启，且改完无法确知是否生效。

交接稿已把三个痛点钉到源码级：

1. **没有热加载**：`HindsightConfig._config_cache` 只在进程内缓存，不存在任何 reload 端点 ⇒ 改配置必须重启进程。
2. **官方插件的自动拉起在 Windows 上是坏的**：`daemon-start.js:711` 的 `onPath()` 用 Unix `which`，本机 `which.exe` 不在 Windows PATH 上 ⇒ `detectLlm()` 三个入口全落空 ⇒ `preflightDaemon()` 拒绝启动 daemon（`daemon_no_llm`，`plugin.log` 里 11 次）。
3. **「改了没生效」无法自证**：profile `.env` 是权威落点，但它会被**启动路径自己重写**。链路已读源码确认：
   - `cli.py:115` 把 profile 载入 `os.environ` 时**不覆盖已存在的键** ⇒ 外层环境变量赢；
   - `daemon_embed_manager.py:718` `merged_config = {**profile_config, **config}` ⇒ 显式传入的 config 覆盖 profile；
   - `_register_profile()`（`daemon_embed_manager.py:941-957`）把这份 config 的 `HINDSIGHT_API_*` 写回；且 `ensure_running()` 在 daemon **已运行时也会调它**；
   - `profile_manager.py:421` 用 `write_text(render_config(...))` **整体重写** `.env`。

实测当前就处于这种状态：HKCU 用户级是 `deepseek-flash`，**DSH 进程 env 里是 `deepseek-v4-flash`**，profile 里是 `deepseek-flash` —— 三个值不一致，而面板要回答的正是「现在到底哪套在跑」。

同时，DSH 侧的模型信息**读得到但没地方用**：`ctx.agentDefaultModel.currentSelection()` 给出默认 `{provider, model}`，路由的 `baseURL` 可从 `listConfigurableProviders()` + settings 下钻拿到，`ctx.credentials.resolve(ref)` 能在宿主半解出明文 key —— 但没有任何界面把它们送进 Hindsight，用户只能手抄。

现在动手的时机：事实链已经被交接稿钉死；且用户当前 DSH 默认路由（`codemaker`）与 Hindsight 恰好指向**同一个端点** `http://127.0.0.1:15721/v1`、同一个模型名 `deepseek-flash`，值却来自不同来源 —— 这正是最容易产生「改了没生效」的状态，也是把四层关系可视化的最佳样本。

## What Changes

新增插件 `dsh-hindsight-model`（`sub-plugins/`，由仓库的管理器面板统一安装），提供一块**设置页「Hindsight 模型」面板**：

- **四层对照（只读）**：① profile `.env` 落盘值 ② 运行中进程实际生效值（启动日志）③ 冲突源（HKCU 用户级 + DSH 进程 env，分开列）④ 生效判据（daemon `StartTime` vs `.env` mtime）。每层标出与相邻层的差异。
- **分组表单（可编辑）**：推理模型（`HINDSIGHT_API_LLM_PROVIDER|MODEL|BASE_URL|API_KEY`）· 分操作覆盖（`HINDSIGHT_API_RETAIN_LLM_MODEL` / `HINDSIGHT_API_REFLECT_LLM_MODEL`）· 向量与重排（`HINDSIGHT_API_EMBEDDINGS_PROVIDER` + `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` / `HINDSIGHT_API_RERANKER_PROVIDER` + `HINDSIGHT_API_RERANKER_LOCAL_MODEL` —— 注意**不存在** `..._EMBEDDINGS_MODEL`／`..._RERANKER_MODEL`，模型键是**按 provider 分名**的，本插件只暴露当前在用的 `local` 那一支）· 杂项（`HINDSIGHT_API_PORT` / `HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT` / `HF_ENDPOINT`）。字段三态：有值 / 未设（提示落哪个默认值）/ 被冲突源覆盖。
- **写入用行级 read-modify-write**：按 `KEY=VALUE` 解析 `profiles/<profile>.env`，只改命中键的行、缺失键追加到文件尾，先备份 `*.bak-<ts>`，再 tmp+rename 原子写。**绝不调用 `profile create`**（它会整体重写）。
- **冲突源处置**：一键清理 HKCU 里会覆盖 profile 的键（先导出备份到 `~/.hindsight/backups/`，二次确认）。**DSH 进程 env 只如实提示、不尝试修改**，并明确告知这是本插件的能力边界。
- **「从 DSH 读取」**：把 `agentDefaultModel` 的 provider/model、路由 `baseURL` 预填进表单（**不写盘**）。api key **不回传明文**：表单只显示「DSH 有一把（来源 `apiKeyEnv`，长度 N）」，勾选「保存时使用 DSH 的这把 key」后由宿主半在保存时解析并使用。
- **不 spawn 任何进程**：面板给出**可直接复制的、已净化环境的重启命令**（profile 名与 embed-project 路径从 `~/.hindsight/coding-agent.json` 生成，并在命令里先清掉冲突键，保证 profile 是唯一真源）；另给「验证」按钮，重启后回答「生效了没有、生效的是哪套值」。
- 宿主半新增只读/写端点 `/__hindsight-model/*`（`kind: 'exact'`），惰性注册（`webServer` 只在 web profile 存在）。

**不做**（明确出界，YAGNI）：多 profile 切换（只跟随 `coding-agent.json` 的 `daemonProfile`）、模型 failover、embedding 模型下载、包装官方 `control` 控制中心、插件侧进程启停。

## Capabilities

### New Capabilities

- `hindsight-model`: 在设置页内查看并修改 Hindsight 守护进程的模型配置，且能对「配置是否真的生效」给出可断言的结论。覆盖：四层取值与差异、分组表单的读写语义、冲突源的检测与处置、从 DSH 读取模型（含密钥不出宿主进程）、重启命令的生成与生效验证、失败降级与密钥脱敏。

### Modified Capabilities

（无。本次不改动任何既有 capability 的规格行为。）

## Impact

**新增代码**
- `sub-plugins/dsh-hindsight-model/package.json`（不声明 `dsh.bundle`）、`src/index.js`（宿主半）、`src/client.js`（客户端半）、`test/bundle.test.mjs`、`README.md`、`ACCEPTANCE.md`

**外部读取面**
- `~/.hindsight/coding-agent.json`（`daemonProfile` / `apiPort` / `embedPackagePath`）
- `~/.hindsight/profiles/<profile>.env`（按 `KEY=VALUE` 解析，不按行号）
- `~/.hindsight/profiles/<profile>.log`（启动日志三行）
- `HKCU\Environment`（`reg query`）、DSH 宿进程序程 `process.env`
- daemon 进程 `StartTime`（`Get-NetTCPConnection -LocalPort <apiPort> -State Listen` → PID → `StartTime`）
- daemon HTTP：`/health`、`/v1/default/banks`、`/v1/default/banks/{bank}/llm-requests`

**外部写入面**
- `~/.hindsight/profiles/<profile>.env`（行级 RMW + `*.bak-<ts>` 备份 + 原子写）
- `~/.hindsight/backups/hkcuenv-<ts>.json`（HKCU 导出备份）
- `HKCU\Environment`（按用户操作删除冲突键）

**DSH 内部依赖（仅注入服务，MUST NOT import `@deepseek-ai/*`）**
- `ctx.webServer.register`、`ctx.agentDefaultModel.currentSelection`、`ctx.llm.listProviders`/`listConfigurableProviders`、`ctx.settings.get`、`ctx.credentials.resolve`、客户端 `settings.section` + `window.__ModuleLoader__`

**不受影响**
- 不改 DSH 核心、不改 Hindsight 上游包（`@vectorize-io/hindsight-coding-agents` / `hindsight-api-slim` / `hindsight-embed`）、不新增任何依赖、不改任何既有插件的规格行为
