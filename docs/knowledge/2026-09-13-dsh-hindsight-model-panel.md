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

## 相关文件

- 插件：`sub-plugins/dsh-hindsight-model/{src/host-core.js, src/index.js, src/client.js, test/bundle.test.mjs, README.md, ACCEPTANCE.md}`
- 变更：`openspec/changes/2026-09-13-add-hindsight-model-panel/`（proposal / design / specs/hindsight-model / tasks）
- 报告：`docs/change-reports/2026-09-13-hindsight-model-panel-change-report.md`
- 上游事实源：`~/.hindsight/embed-project/.venv/Lib/site-packages/hindsight_embed/{cli.py, profile_manager.py, daemon_embed_manager.py}`、`.../hindsight_api/config.py`
