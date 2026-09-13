## Context

动机与痛点见 `proposal.md`。本节只记**塑造方案**的现状与约束。

### 外部系统：Hindsight 的配置链路（已读源码确认）

权威落点是 `~/.hindsight/profiles/<profile>.env`，但**启动路径会重写它**：

| 环节 | 事实 | 证据 |
|---|---|---|
| profile 载入 env 不覆盖已存在键 | 外层环境变量赢 | `cli.py:115`（`if key not in os.environ`） |
| 显式 config 覆盖 profile | `merged_config = {**profile_config, **config}` | `daemon_embed_manager.py:718` |
| 启动时把 config 写回 profile | `_register_profile()` 的 `create_profile(profile, port, merged)` | `daemon_embed_manager.py:941-957` |
| 且 daemon 已运行时也会写回 | `ensure_running()` 里 `is_running` 分支同样调 `_register_profile` | `daemon_embed_manager.py:1217` |
| `create_profile` 整体重写文件 | `config_path.write_text(render_config(config))` | `profile_manager.py:421` |

推论：**只有「外层没有同名键」时，profile 的写入才可能存活**。实测当前三层取值不一致：
- `HKCU\Environment`：`HINDSIGHT_API_LLM_MODEL=deepseek-flash`、`HINDSIGHT_API_LLM_API_KEY=<17 chars>`（`PROVIDER` 未设）
- DSH 宿进程序程 `process.env`：`HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash`（**与 HKCU 不同值**，且已确认不是官方插件所写——`daemon-start.js:693/723` 只读入参）
- profile `.env`：`HINDSIGHT_API_LLM_MODEL=deepseek-flash`、`..._PROVIDER=deepseek`、`..._BASE_URL=http://127.0.0.1:15721/v1`、`..._API_KEY=codemaker-managed`、`HINDSIGHT_API_PORT=9077`、`HF_ENDPOINT=https://hf-mirror.com`

### 外部系统：官方 CLI 与守护进程

- 命令面：`hindsight-embed profile set-env`（read-then-merge）。任何调用都要 `uv run --directory <embed-project>`（本机 `C:\Users\chensir5173\.hindsight\embed-project`）。
- 官方插件 SDK 的自动拉起在 Windows 上坏的：`daemon-start.js:711` 的 `onPath()` 用 Unix `which` ⇒ `detectLlm()` 落空 ⇒ `preflightDaemon()` 拒绝启动（`daemon_no_llm`）。**不要**通过把 Git 的 `usr/bin` 加进 PATH 去"修"它——那会让 `detectLlm()` 返回 `claude-code` 并写进 profile，破坏用户配置。
- 无热加载：`_config_cache` 只在进程内；不存在 reload 端点。

### DSH 侧可读能力（子代理源码调研结论）

| 能力 | 宿主半读法 | 备注 |
|---|---|---|
| 默认模型选择 | `ctx.get('agentDefaultModel').currentSelection()` | **是同步方法，不是属性**；返回 detached `{provider, model, reasoningEffort?}` |
| 提供方列表 | `ctx.get('llm').listProviders()` | `LlmProviderInfo` 只有 `{id, name}` |
| 路由的端点 | `ctx.get('llm').listConfigurableProviders()` → `ctx.get('settings').get(entry.settingsNs)` 按 `entry.settingsPath` 下钻 → `node.baseURL` / `node.apiKeyEnv` | **baseUrl 不在任何枚举 API 里**，只能这样读 |
| 解析后的明文密钥 | `ctx.get('credentials').resolve(ref)` → `{value, source}` | 客户端半**无** credentials remote 面 |
| 注册 HTTP | `ctx.webServer.register({kind, path, handler})` | 只在 web 形态存在；handler 自持 `ServerResponse` |

当前本机值：DSH 默认 `provider: codemaker` / `model: deepseek-flash`（`~/.dsh/settings.yaml:3-5`），`codemaker` 路由 `baseURL: http://127.0.0.1:15721/v1`、`apiKeyEnv: CODEMAKER_API_KEY`（`settings.yaml:79-82`）。

### 仓库约束

- 子插件一律**不声明** `dsh.bundle`、目录内**不放** `cordis.patch.yml`（AGENTS.md；违反会让 `dsh web` 启动时 `duplicate loader entry id` 崩溃）。
- 宿主半**不得 import `@deepseek-ai/*`**：`link:` 插件的真实路径在仓外，Node 从仓库向上找不到宿主内部包 ⇒ 启动即 `ERR_MODULE_NOT_FOUND`。只用注入服务。
- 客户端半无 JSX，走 `window.__ModuleLoader__.load({id, factory})` + `require('react')`；客户端界面变化需一次页面刷新。
- 安全事实：该部署 `settings.yaml:2591-2593`（`describe-image:` 段）存在明文 `apiKey` ⇒ **不能假设「settings 里没有密钥」**；`.credentials.yaml` 的 `refs:` 下每个 value 都是明文密钥；`profiles/<p>.env` 里还留有历史明文 `sk-f6b7…` 残留。

## Goals / Non-Goals

**Goals**

- 把「Hindsight 现在到底哪套模型在跑」变成一张能自证的四层对照表。
- 让面板里的「保存」**真的会持久**：写入路径与启动路径的环境冲突被显式处理，而不是假装不存在。
- 让「从 DSH 读取」可用，且**密钥明文不出宿主进程**。
- 所有外部交互失败时降级并说明缺口，不静默、不猜测。

**Non-Goals**（设计层面的边界，范围边界见 `proposal.md`）

- 不替换或"修好"官方插件；不碰 `@vectorize-io/hindsight-coding-agents`。
- 不做 profile 的创建/删除/切换（只操作 `coding-agent.json` 指认的那一个）。
- 不做跨平台抽象：本设计依赖 `reg query` / PowerShell / `uv`，非 Windows 上按降级路径处理。
- 不实现 daemon 生命周期管理（明确出界，见 Decisions）。
- 不包装官方 `control` 控制中心（:7878）。

## Decisions

### D1. 插件身份与两半划分

`sub-plugins/dsh-hindsight-model/`，激活行 id = `hindsight-model`（沿用「目录名去 `dsh-`」惯例）。宿主半持有全部文件/进程/DSH 读取能力；客户端半只渲染与发起同源 `fetch`。

**为什么两半**：面板需要读 `~/.hindsight/*` 与 `process.env`（客户端做不到），而 DSH 的 `credentials` 没有 remote 面（子代理核实），密钥解析只能在宿主半。备选「纯宿主半」被否——那要求用户会用斜杠命令或工具语义，与用户选定的设置页面板形态不符。

### D2. 写入采用「行级 read-modify-write」，不调官方 CLI

对 `profiles/<profile>.env` 做：按行解析 `KEY=VALUE` → 只替换命中键所在行 → 缺失键追加到文件尾 → `*.bak-<ts>` 备份 → tmp+rename 原子写。

**备选与否决理由**
- *官方 `profile set-env`（每键一次 `uv run`）*：语义最安全，但**不解决核心问题**——CLI 照样把外层 env 值写回 profile，用户看到的仍是「改了没生效」；且每改一键一次 `uv` 冷启动，改 6 个键就是 10–20s 的保存等待。
- *裸调 `profile create --merge`*：明确禁止（`profile_manager.py:421` 整体重写，注释与未知键会丢）。
- *包装官方 `control` 控制中心*：另一个 Web UI，与设置页面板割裂；且大概率同样不做冲突源处理与生效断言，两个真痛点仍留给我们。

**已知代价**：我们自己的 merge 语义要写测试覆盖（见 `tasks.md` 的纯函数用例）。

### D3. 不 spawn 守护进程：改为给出「已净化环境」的可复制命令

用户明确「重启我自己重启」。因此插件**不**调用 `daemon stop/start`，而是生成一条命令，形态为：

```powershell
# profile 名与 embed-project 路径取自 ~/.hindsight/coding-agent.json，不硬编码
Remove-Item Env:HINDSIGHT_API_LLM_MODEL, Env:HINDSIGHT_API_LLM_API_KEY, Env:HINDSIGHT_API_LLM_PROVIDER, Env:HINDSIGHT_API_LLM_BASE_URL -ErrorAction SilentlyContinue
uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> stop
uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> start
```

`Remove-Item Env:` 只影响当前 PowerShell 会话（及其子进程），正好抵消「外层变量赢过 profile」；对来自 HKCU 的键也有效，因为每个新会话会从 HKCU 再继承。

**为什么保留净化**：不 spawn ≠ 不用管环境。用户若在带 `HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash` 的会话里重启，那条值会经 `cli.py:115` → `_register_profile` 把面板刚存的 `deepseek-flash` 冲掉。给一条自带净化的命令，比让用户自己拼更接近「保存能生效」这个目标。

**代价**：插件无法**保证**用户真的用它给的命令（这是必然的边界，在面板上说明）。

### D4. 四层的定义与读取源

| 层 | 读取源 | 解析规则 |
|---|---|---|
| ① 落盘 | `profiles/<profile>.env` | 按 `KEY=VALUE` 解析；**不按行号**（`HINDSIGHT_API_LLM_BASE_URL` 是 `render_config()` 追加到文件尾的，不在模板里） |
| ② 生效 | `profiles/<profile>.log` | 取**最后一组**启动块：`OpenAI-compatible client initialized: provider=…, model=…, base_url=…` + `Verifying connection:` / `Connection verified:` |
| ③ 冲突源 | `reg query HKCU\Environment` + 宿主 `process.env` | 与「profile 管理的键集」求交集；两组**分开**呈现 |
| ④ 判据 | **主判据**：① 的三件套 vs ② 的三件套；**回退判据**：`Get-NetTCPConnection -LocalPort <apiPort> -State Listen` → PID → `Get-Process StartTime` 对比 `.env` mtime | 取值一致 ⇒ 已生效（只比较进程真正报出来的字段）；不一致 ⇒ 未生效并逐个列出不一致字段；**仅当取不到 ② 时**才回退到 `StartTime > mtime` |

②④ 都依赖「守护进程在跑」；不在跑时一律标未知，**不拿历史值充当现状**。

**为什么最终不是单一时序判据（2026-09-13 真机实测后改，已同步 spec 需求 9）**：上游守护进程的启动路径**自己会回写这个文件**（`_register_profile()` → `create_profile()` 整体重写），所以文件 mtime 经常落在进程启动**之后**。本机实测：文件 `18:56:29`、进程 `18:55:46`，而两者的 provider / model / 端点**完全一致**（`deepseek / deepseek-flash / …15721/v1`）。只按时间判定，面板会对一个完全健康的配置长期误报「尚未生效」；改成「与进程实际读到的值比对」后，同一台机器正确给出 `applied: true, reason: 'consistent'`。时序关系保留为**佐证**（`rewrittenAfterStart`），结论里注明「文件在进程启动后被重写过（可能只是启动路径把同值写回）」。

**实测这一条是被真机推翻的**：规格初稿把时序判据写成 MUST，实现完成后用真依赖跑 `collectState()` 才发现它在健康系统上误报——这正是「先写规格再实现」要抓的那类问题，故按用户确认就地修订规格。

### D5. `profile` 管理的键集是「已知键清单 + 未知键保真」

表单暴露 `proposal.md` 列出的四组键；但**写入时必须保真处理未知键**（既有的、我们不管的 `HINDSIGHT_*` 键一律原样保留）。这样上游新增键时我们不会把它们写丢。

### D6. 密钥处理：明文只在宿主半流转

- 表单对 `HINDSIGHT_API_LLM_API_KEY` 显示掩码 + 长度；`state` 响应只回 `{hasValue, length}`。
- 「从 DSH 读取」**不回传** DSH 侧密钥明文，只回 `{hasValue, length, source: apiKeyEnv}` + 一个勾选项；勾选后由宿主半在 `save` 时 `credentials.resolve()` 并写入。
- 日志/诊断一律只记键名与长度（交接稿 §11.5 要求）。
- 读 DSH `settings` 时**只按 `settingsPath` 下钻取需要的字段**，不整段回传（该部署 settings 里有明文密钥）。

### D7. 宿主端点契约（`kind: 'exact'`，前缀 `/__hindsight-model`）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/state` | 四层 + 字段三态 + 冲突源 + 重启命令 + 备份路径（密钥只回元信息） |
| `POST` | `/save` | `{changes:{KEY: value\|null}, useDshKey?}` → 备份 + 行级 RMW |
| `GET` | `/dsh-model` | 预填数据（含密钥元信息，**不含明文**） |
| `POST` | `/verify` | ④ + ② + `llm-requests` |
| `POST` | `/clean-env` | 导出 HKCU 备份 + 删除冲突键 |

全部包在 `ctx.effect(() => host.register(...))` 内以便随 fiber 释放；方法不符回 405，未知键回 400。

> **已核对（2026-09-13，task 1.1）**：服务方法确实是 `ctx.webServer.register({kind, path, handler})`；知识库里那个 `registerHttp` 是 `dsh-esc-rewind` **自己的局部辅助函数名**，不是宿主 API（`sub-plugins/dsh-esc-rewind/src/index.js:398`，内部 `ctx.effect(() => host.register({ kind: 'exact', path, handler }))`，`host` 取自 `ctx.get('webServer')`；无 webServer 时用 `ctx.inject(['webServer'], …)` 回退，同文件 `:500-507`）。本插件沿用同一写法。

### D8. 面板位置

客户端 `settings.section`，`order: 17`（夹在既有 `local-plugins: 16` 与 `mcp: 18` 之间）。文案沿用本仓库的字段级 i18n dict 惯例（中文为默认）。

### D9. 测试策略

`test/bundle.test.mjs` 离线 harness（沿用既有 7 个插件的做法：mock `ctx` + React shim + fetch stub），**纯函数优先**：`.env` 行级 merge、启动日志取最后一组、冲突源键集、净化命令生成、`StartTime > mtime` 判定；再加端点契约（方法校验、错误码、**密钥不回传**断言）与面板禁用逻辑。真机项标 `[B]` 写进 `ACCEPTANCE.md`。

## Risks / Trade-offs

- **删 HKCU 键不可逆** → 必须先导出 `~/.hindsight/backups/hkcuenv-<ts>.json` 再删，且二次确认；导出失败即中止删除。
- **备份文件本身含明文**（`.env` 里还有历史 `sk-f6b7…` 残留）→ 面板展示备份路径时同时提示其敏感性；备份不自动清理、不自动上传。
- **DSH 进程 env 清不掉** → 明示为能力边界；靠「给净化命令 + 如实显示」缓解，不假装能修。
- **上游 `create_profile` 会整体重写 `.env`** → 我们的行级写**不保证**抗上游重写；但启动路径的 `_register_profile` 会把既有非小写键带过去，因此只要外层不冲突，写入就能存活。这条已知行为要写进 README，避免日后误判为插件 bug。
- **外层变量是"隐藏赢家"** → 若用户不接受清理 HKCU，面板的「保存」在这些键上依旧会被下次启动覆盖；面板必须把这点说清楚，不能只报"保存成功"。
- **平台耦合**（`reg query` / PowerShell / `uv`）→ 非 Windows 走降级：可展示的层照常，命令区与清理项禁用并说明原因。
- **`StartTime` 判据的时区/精度** → 比较前统一到同一时基；`mtime` 与 `StartTime` 秒级同值时按「未生效」处理（宁可误报未生效，也不误报成功）。
- **`webServer` 只存在于 web 形态** → 惰性注册；终端/Electron 下面板整体不出现。

## Migration Plan

1. 实现后由仓库管理器面板安装（**不要**用 `dsh plugin add` 装子插件——会留下悬空激活行导致 `dsh web` 启动失败，见 `docs/knowledge/2026-09-10-retire-bundle-install.md`）。
2. 首次打开面板只读，不改任何文件；用户确认四层读数与现状一致后再试写。
3. 回滚：管理器面板停用/移除该插件即可；插件对系统的全部写入（`.env` 与 HKCU）都有带时间戳的备份可手工还原。无数据库迁移、无 schema 变更。

## Open Questions

- 官方 `control` 控制中心（:7878）实际能力面是否会与面板重叠 —— 交付后再评估要不要把「打开控制中心」作为补充入口，当前不影响任何规格或任务拆分。
- 「从 DSH 读取」是否要支持**会话级**当前模型（宿主半也能通过会话投影读到） —— 面板本身不是会话上下文，当前只做默认模型；若日后要做，属于新增 capability 行为，需另开变更。
