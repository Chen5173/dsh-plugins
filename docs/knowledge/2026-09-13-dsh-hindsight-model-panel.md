# DSH 插件：Hindsight 模型面板（dsh-hindsight-model）

日期：2026-09-13 · 涉及 `sub-plugins/dsh-hindsight-model/`、`openspec/changes/2026-09-13-add-hindsight-model-panel/`。

## 一句话

Hindsight 是**独立 Python 守护进程**（与 DSH 硬隔离：进程/凭据/模型语义全不通），它必须单独配模型，而它的权威配置文件 `.env` 会被**启动路径自己回写**。本插件在设置页把它摊成四层（落盘值 / 进程实际生效值 / 外层冲突源 / 生效判据），写入改用行级 read-modify-write；**不启停进程**，只给一条净化过环境的可复制重启命令 + 验证按钮。

## 可复用结论（本轮实测/读源码得出）

### Hindsight 配置链路（决定一切的三条）

- **改配置必须重启**：`HindsightConfig._config_cache` 只在进程内，不存在任何 reload 端点。
- **启动路径会整体重写权威文件** —— 四步链路（源码已核）：`cli.py` 把 profile 载入 `os.environ` 时 **`if key not in os.environ` 不覆盖已存在键** → `daemon_embed_manager` 用 `{**profile_config, **config}` 合并（显式 config 赢）→ `_register_profile()` 把 `HINDSIGHT_API_*` 写回，且 `ensure_running()` 在 daemon **已运行时也会调它** → `profile_manager.create_profile()` 最终 `write_text(render_config(config))`。**推论：外层同名环境变量会赢，并在每次启动时被写回覆盖你刚存的值。**
- **所以写入绝不能用 `profile create`**；用按 `KEY=VALUE` 的行级 read-modify-write（只改命中行、缺失键追加），并靠启动路径「把既有非小写键带过去」存活。

### ⚠️ 生效判据：时序判据会误报（本轮被真机推翻）

- 「`进程 StartTime > .env mtime` 才算已生效」**不成立**：上游启动路径自己会回写该文件，mtime 常常落在启动**之后**。实测本机 `.env` `18:56:29` vs 进程 `18:55:46`，而两者取值**完全一致**。只按时间判会对健康配置长期误报「尚未生效」。
- **正确判据**：主判据 = 「文件里的 provider/model/baseUrl 三件套」与「启动日志里进程实际读到的三件套」是否一致（不一致时逐个列出字段）；时序关系只作**佐证**，仅在取不到进程取值（无启动块 / 进程未运行）时回退为判据。

### 真机探针写法（可复用）

别只看文档——**直接用真依赖跑一遍只读核心**最有说服力：`createCore({...真 fs/execFile, writeText: () => { throw ... }})` 然后 `collectState()`。把 `writeText` 换成抛错即可保证探针绝不写盘。本轮的判据缺陷就是这样发现的。

### 键名坑（交接稿写错、真源码为准）

- **不存在** `HINDSIGHT_API_EMBEDDINGS_MODEL` / `..._RERANKER_MODEL`。真名是按 provider 分名的：`HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL`（默认 `BAAI/bge-small-en-v1.5`）、`HINDSIGHT_API_RERANKER_LOCAL_MODEL`（默认 `cross-encoder/ms-marco-MiniLM-L-6-v2`）。
- `HINDSIGHT_API_LLM_BASE_URL` **不在模板里**，是 `render_config()` 追加到文件尾的 ⇒ 解析必须按 `KEY=VALUE`，**不能按行号**。
- 同类：`PROVIDER_DEFAULT_MODELS`（provider → 默认模型）可用于「未设 → 回落默认」提示；`HINDSIGHT_API_PORT` 的权威在 `.env` 而不是 metadata。

### DSH 侧读「我自己的模型」的确切 API

- 默认模型是**服务**，读法为**同步方法**：`ctx.get('agentDefaultModel').currentSelection()` → `{provider, model, reasoningEffort?}`。
- **`baseURL` 不在任何枚举 API 里**（`LlmProviderInfo` 只有 `{id, name}`）：必须 `ctx.get('llm').listConfigurableProviders()` 找到条目，再 `ctx.get('settings').get(entry.settingsNs)` 按 `entry.settingsPath` **下钻**取 `baseURL` / `apiKeyEnv`。
- **明文密钥只能在宿主半取**：`ctx.get('credentials').resolve(ref)` → `{value, source}`；客户端半**没有** credentials 的 remote 面。想「用 DSH 的 key 但明文不出宿主进程」，就传一个布尔标志让宿主半在保存时解析。
- ⚠️ 不要假设「settings 里没有密钥」——本机 `settings.yaml` 的 `describe-image:` 段就有明文 `apiKey`。按 `settingsPath` 只取需要的字段。

### 宿主半惯用法（澄清一处历史记录）

- 知识库旧记的 `registerHttp` **不是宿主 API**，而是 `dsh-esc-rewind` 自己的局部函数名。真实写法是 `ctx.effect(() => host.register({ kind: 'exact', path, handler }))`，`host` 取自 `ctx.get('webServer')`，缺失时用 `ctx.inject(['webServer'], …)` 回退（该服务只在 web 形态存在）。
- 宿主半**不 import `@deepseek-ai/*`** 这条约束下，上面所有能力都靠**注入服务**拿到，因此不需要声明 `peerDependencies`。

## v2（同日）：面板支持启停守护进程，以及由此挖出的两个上游 Windows 缺陷

用户实测后要求面板能启停 daemon，于是新开变更 `2026-09-13-hindsight-model-daemon-control`，用 delta 修订了原「插件 MUST NOT 启停」那条需求（`REMOVED + ADDED`：整条语义反转，不是改名）。实现中被真机逼出下面几条可复用结论。

### ⚠️ 上游 `daemon stop` 在本类机器上不可能工作（两个 bug 互为镜像）

`hindsight-embed daemon stop` 的流程是「`netstat -ano` 找端口 PID → 校验该 PID 确实是自己的进程 → `os.kill(SIGTERM)`」。本机第一步就崩：

```
UnicodeDecodeError: 'utf-8' codec can't decode byte 0xbb in position 2
WARNING  Could not find PID for port 9077 → "Port 9077 is bound but no hindsight daemon could be identified on it"
✗ Failed to stop daemon   exit=1
```

- 根因：`_run_probe` 用 `subprocess.run(..., text=True)` 解码，编码取自 `locale.getpreferredencoding(False)`；而**这个 venv 跑在 UTF-8 模式里**（`sys.flags.utf8_mode == 1`），于是拿 UTF-8 去解 Windows `netstat` 吐出的 **cp936** 字节。异常发生在读取线程（`subprocess.py:1599`），被吞掉后 `_listening_pids` 返回空。
- **设 `PYTHONUTF8=0` 不是解法**：那样 `getpreferredencoding()` 变 `cp936`，netstat 能解了，但 `cli.py:108` 的 `open(config_path)`（**没指定 encoding**）改去读 profile 的 UTF-8 字节，于是 `'gbk' codec can't decode byte 0x94` —— 而 profile 是 `create_profile(..., encoding="utf-8")` 写的。**开也错、关也错，环境变量层面无解。**
- 实测对照表（同一台机器）：

  | `PYTHONUTF8` | 读 profile（UTF-8 文件） | 解码 netstat（cp936 字节） |
  |---|---|---|
  | `1`（继承自 DSH host env） | ✅ | ❌ |
  | `0` / 未设 | ❌ gbk | ✅ |

- 结论：面板**自己做停止**——取监听端口 PID（用已在用的 `Get-NetTCPConnection` 路径），**先校验命令行确实是 hindsight**（实测身份串：`python.exe -m hindsight_api.main --daemon --idle-timeout 0 --port 9077` → 必须含 `hindsight_api.main`、`--daemon`、且 `--port` 与当前端口一致），才 `Stop-Process`。这样保留了上游「不向无法确认的进程发信号」的安全性质（它防的是误杀恰好占用同端口的不相关服务，issue #3520），只绕开它的解码 bug。**实测停止 234ms、exit 0**；启动仍是官方 CLI。

### 同类缺陷家族

`onPath()` 用 Unix `which`、`_run_probe` 用 UTF-8 解 cp936、`open(profile)` 不指定 encoding —— 三个都是「Windows 上想当然」。遇到 Hindsight 在 Windows 上的怪行为，先怀疑这一类。

### 「PROVIDER 启动后消失」的根因是官方插件，不是我们的净化

现象：某次启动后 profile 里 `HINDSIGHT_API_LLM_PROVIDER=deepseek` 消失、进程改用默认 `provider=openai`（因为 `base_url` 显式指向 15721，连接仍然验证通过，所以不易察觉）。

机制链（`env_template.render_config` 是关键）：**它只把「传入字典里有的键」写成活动行，其余模板行一律注释掉**。所以键消失 ⇒ 传给 `create_profile()` 的字典里没有它。而最符合时序的解释是**官方插件**：17:57:50 它记了 `daemon_no_llm`（`detectLlm()` 失效），其 `HindsightServer.start()` 走 `profile create --merge` 用**缺 provider 的 config** 重写了 profile；随后我的启动读到默认 `openai`，`_register_profile` 再把已丢键的集合写回。

**已实测证伪「是我们的净化造成的」**：修好后用真依赖跑「保存 PROVIDER → 停止 → 启动」，`PROVIDER=deepseek` 存活、运行进程读到的也是 `deepseek`、判据 `applied=true / consistent`。所以：净化只影响子进程 env，不会删 profile 的键。

### 生效判据要按「文件是否有该字段」比较

真机暴露过一处逻辑问题：文件里 `PROVIDER` 缺失（= 未设、落默认），进程报 `openai`，于是判据报 `mismatch`。但「文件没写这个键」不等于「文件说它应该是别的值」。正确做法是**只比较文件里确实存在的字段**，缺的字段跳过（进程用什么默认值都是合规的）。

### 真机验证方法（可复用）

沿用前一节的只读探针，把 `spawn` 换成真的 `spawnCommand`、`writeText` 换成抛错，就能**走真实代码路径**跑完整的停止/启动往返，并打印四层与判据：

```
BEFORE running=true pid=9828 health=healthy
stop   ok=true code=stopped exit=0 ms=234
AFTER stop running=false pid=null health=unreachable
start  ok=true code=started ms=46461          ← 冷启动约 46–73s，超时要放宽
AFTER start running=true pid=18496 health=healthy
applied: true consistent values
runtime: deepseek/deepseek-flash @ http://127.0.0.1:15721/v1
```

## v2.1（同日）：启动路径的「控制台窗口」——机制坐实与 1 个文件的修复

v2 那三个缺陷都在**停止**路径，这一支在**启动**路径：每次冷启动守护进程都弹出一个控制台窗口（**关掉它等于杀进程**）。

- **根因（PE 头 + sha256 实测，不是推断）**：本机 embed 的 `.venv\Scripts\pythonw.exe` 与同目录 `python.exe` **字节完全相同**（sha256 `868c5889…`）、PE 子系统 = **CUI(3)**；而 uv 的 venv 模板 `Libenv\scripts
t\pythonw.exe` 与基础目录里的 `pythonw.exe` 都是 **GUI(2)**。uv 0.11.32 建 venv 时给两个名字装的是同一个控制台 launcher。上游 `_windows_gui_interpreter()` 只检查「`Scripts\pythonw.exe` 是否存在」，随后用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 把 daemon 摘出父控制台 ⇒ 一个 CUI 进程在「父进程无控制台」下被创建 ⇒ Windows **新开**一个控制台（实测 `conhost` 的父进程正是 daemon 进程本身）。
- **判据（可复用）**：**PE 子系统 2 = GUI，永不分配控制台；3 = 控制台，会分配**。只读文件头，不猜名字、不看版本号。
- **对照实验（可复用）**：用上游原样那一跳（`creationflags=DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`）启动 `pythonw.exe -c "sleep"`，1.6s 后看有没有**新 conhost**：uv venv 的原件 → 有；换成 GUI 版 → 无。⚠️ **不能直接在 Git Bash 里跑这个对照**：bash 自带控制台，子进程继承它，测不出来。
- **修复**：只换 **1 个文件** —— 把同一份 uv 基础的 GUI 版 `pythonw.exe` 覆盖到 `.venv\Scripts\pythonw.exe`，原件备份到 **`.venv` 之外**（`<embed>\pythonw.exe.uv-orig-<ts>`）。零依赖重装；`uv run` 不会把它改回去（实测跑完仍是 GUI(2)、`pyvenv.cfg` 未被改写）。
- **回滚 / 复发自查**：用备份覆盖回去即可；复发场景 = uv 或 hindsight-embed **重建 venv**，自查就是量一次子系统（2 好 / 3 坏）。
- 现场证据：停/启用的是本仓库探针 `node tmp/hindsight-daemon-probe.mjs {status,stop,start}`（走插件真实代码路径：身份校验 + 环境净化 + 官方 CLI）；修复后 `applied=true / consistent`、**无 conhost**、9077 监听者 = 基础 `pythonw.exe`。

## v3（2026-09-14）：按需自动启动 + 启动器自愈 + 来源可见（`2026-09-13-hindsight-model-autostart`）

- **为什么不让官方那条就行**：官方 `hindsight` 行的 `ensureDaemon()` 确实挂在 `agent/session-start` / `agent/pre-step` 上，但 `preflightDaemon()` 的 `detectLlm()` 只认宿主 env 的 `HINDSIGHT_API_LLM_PROVIDER` / `OPENAI_API_KEY` / … 或 `which claude`（Windows 上没有 `which`），而 provider 写在 **profile** 里 ⇒ 每次只记 `daemon_no_llm` 就返回。**解锁它的代价**：① 它的启动器那一跳 `spawn(uv)` **没做窗口隐藏**（实测：detached 的 node → `uv.exe` 新建一个 conhost）；② `daemonEnv()` 会把宿主 env 里所有 `HINDSIGHT_API_*` 交给 `profile create --merge` 写回 —— 等于承认「外层 env 会赢」。故**自动启动归本插件**（同一条净化命令、不碰 `profile create`）；官方那条**不动**也安全：`/health` 通就采纳。
- **触发只用 `agent/session-start`，不接 `agent/pre-step`**：后者是**每步中介件**（listener 形如 `(payload, next)`），签名接错会拖垮整条链路；规格写的是「会话开始**或**首次需要长期记忆时」，普通事件即满足。
- ⚠️ **宿主 settings 的 API 陷阱（差点让开关永远禁用）**：`settings.installSection(ctx, ns, schema, entry, hooks)` **不返回句柄**（它只把 `scope.get()` 喂给 `hooks.setSource`），能拿到可写句柄的只有 `settings.register(ns, schema, { base })` → `SettingsScope{get, update, replace}`。宿主半要写 settings 就走后者；且 `register` 对**重复命名空间会报错**，所以要用**模块级 scope 缓存**扛住 HMR 重挂。
- **采纳优先 + 后台 + 退避**：探测通过 ⇒ 不重启 / 不写文件 / PID 不变；不通过 ⇒ **后台**启动（`ensureDaemon` 立即返回，真正的启动挂在返回值的 `started` promise 上，绝不 await 进会话路径），失败按 1/5/15/30 分钟退避，且 `advanceAutoAttempt` **只在结果码变化时**给一条 notice（同一失败不重复刷屏）。
- **自愈只在该动盘时动盘，且不允许半换状态**：读 `.venv\Scripts\pythonw.exe` 的 PE 子系统 —— GUI ⇒ 什么都不做；CUI ⇒ 备份到 `.venv` 之外 → 写临时文件 → `rename` **原子替换**；取不到同发行版 GUI 版或替换失败 ⇒ **拒绝启动**并如实说明。
- **来源判定不写标记文件**：只用「监听端口的 PID + 镜像路径（+ 可读时的子系统）」和「本进程这次做过什么」（`startedBy` 只在 pid 匹配时算数），镜像为控制台形态时标「有控制台窗口风险」。
- **真机证据（2026-09-14 00:04–00:06）**：宿主 00:04:12 起 → 00:04:39 会话触发 → **00:04:41 daemon 起** → 00:05:19 冷启动完成；`origin=auto`、`triggers=3`、`failures=0`、`heal=not-needed/already-gui`、`hostEvents=subscription-ok`、**无 conhost**、`applied=consistent`；profile **sha256 与改动前逐字节相同**（`mtime` 被上游整文件回写改了，内容没变）。采纳分支另用探针验证：`ensureDaemon()` → `adopted`、未 spawn。
- **验证方法**：harness 113→114 条；**红绿**用「把两个新行为主体临时置空」的做法（9 条新行为用例全红、老用例一条不红），因为本插件 `src/` 里还混着**并行会话未提交的改动**，`HEAD` 不等于「改动前」。
- **一个只会误导人的现象**（用户当晚实际踩过）：宿主重启后先跑 `netstat -ano` 是**看不到 9077** 的 —— 触发点是**会话开始**（不是宿主启动），且冷启动还要 40 秒左右；面板此时显示「正在后台冷启动」。想要「重启 DSH 就有守护进程」得另加 boot 触发（未做）。

## 相关文件

- 插件：`sub-plugins/dsh-hindsight-model/{src/host-core.js, src/index.js, src/client.js, test/bundle.test.mjs, README.md, ACCEPTANCE.md}`
- 变更：`openspec/changes/2026-09-13-add-hindsight-model-panel/`（proposal / design / specs/hindsight-model / tasks）
- 报告：`docs/change-reports/2026-09-13-hindsight-model-panel-change-report.md`
- 上游事实源：`~/.hindsight/embed-project/.venv/Lib/site-packages/hindsight_embed/{cli.py, profile_manager.py, daemon_embed_manager.py}`、`.../hindsight_api/config.py`
