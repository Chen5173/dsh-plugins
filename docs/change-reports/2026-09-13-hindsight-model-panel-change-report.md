# dsh-hindsight-model 插件（Hindsight 模型面板）修改报告

## 1. 需求与成功标准

- **需求**：做一个能管理 Hindsight 推理模型的 DSH 插件——一方面可自定义（provider / model / base_url / api_key 等），另一方面**能读取 DSH 的模型并设置到 Hindsight**。
- **用户确认的范围**（逐项问过，非默认）：
  - 交互面**只有设置页面板**（不做斜杠命令、不做模型工具、不做会话头控件）；
  - 表单覆盖**全配置面**：推理三件套 + key、retain/reflect 分操作覆盖、embedding/reranker 显式固定、端口/idle 超时/HF 镜像源；
  - **重启由用户自己做**，插件不 spawn 任何进程，改为给一条**已净化环境**的可复制命令并保留「验证」按钮；
  - 「从 DSH 读取」**全部预填到表单、等确认再保存**；但 api_key **不以明文回传**，改用勾选框由宿主半在保存时使用；
  - 面板**允许清理** HKCU 里会覆盖 profile 的键（先导出备份）；
  - 15721 那个端点**只如实展示、不预设推荐**（真机核实后它就是用户自己配的 DSH 路由端点）。

## 2. 修改摘要

新增插件 `sub-plugins/dsh-hindsight-model/`（两半 + 核心 + harness + README/ACCEPTANCE）：

| 文件 | 内容 |
|---|---|
| `src/host-core.js` | 纯逻辑 + 可注入 IO：`.env` 行级 merge、启动日志解析、冲突源计算、生效判据、命令生成、备份/原子写/回滚、HKCU 导出后删除；`createCore(deps)` |
| `src/index.js` | cordis 接线：真依赖（fs / execFile / fetch）、DSH 侧读取、5 个 HTTP 端点、`registerRoutes`（`ctx.effect` 包裹、惰性） |
| `src/client.js` | `settings.section`（order 17）面板：四层对照、分组表单与三态字段、按钮与降级渲染 |
| `test/bundle.test.mjs` | 离线 harness **60 条**（纯函数 / 四层读取 / 写入回滚 / 端点契约 / 面板渲染） |
| `README.md` / `ACCEPTANCE.md` | 用法、已知行为、能力边界；人工验收项（标 `[B]`） |

配置写入**绝不调用** `profile create`（它会整体重写 `.env`）；改为按 `KEY=VALUE` 行级 read-modify-write，只改命中行、缺失键追加，先备份 `*.bak-<ts>`、经临时文件 rename 原子落盘、失败回滚。

## 3. 关键决策与取舍

1. **profile 唯一真源 + 净化 spawn**（方案 A，否决了「全部委托官方 CLI」与「包装官方 control 中心」）：官方 `profile set-env` 每改一键一次 `uv` 冷启动，且**不解决**外层变量覆盖问题；控制中心是另一个 Web UI 且大概率同样不处理这两点。
2. **不 spawn 进程**（用户要求）：改为给命令，但命令**自带环境净化**——因为 `cli.py` 载入 profile 时不覆盖已存在的键，不清外层变量的话落盘值会被写回覆盖。
3. **api_key 明文不出宿主进程**：`/state` 与 `/dsh-model` 只回 `{hasValue, length, source}`；`useDshKey` 路径由宿主半 `credentials.resolve()` 后直接写入。
4. **⚠️ 生效判据在实现后被真机推翻并修订**：规格初稿写的是「`StartTime > mtime` 才算已生效」。用真依赖实测本机发现——`.env` mtime `18:56:29` **晚于**进程启动 `18:55:46`，而两者取值完全一致（都是 `deepseek / deepseek-flash / …15721/v1`）。原因是**上游启动路径自己会回写该文件**（`_register_profile()` → `create_profile()`）。该判据会对健康配置长期误报「尚未生效」。经用户确认后改为：**主判据 = 文件三件套 vs 进程实际读到的三件套是否一致**（不一致时逐个列出字段），仅当取不到进程取值时回退到时序判据；时序关系保留为佐证 `rewrittenAfterStart`。spec / design / tasks 已同步。
5. **面板 order 17**（夹在 `local-plugins` 16 与 `mcp` 18 之间），沿用仓库既有约定。

## 4. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs` | **60/60 passed** |
| 红绿验证 | 把 `save()` 的「先合并再校验」变异回旧顺序 → **54/55 时期的一条用例转红**；还原后 60/60。另有真机抓到的判据缺陷由新增用例锁定 |
| 真机只读核对（真依赖跑 `createCore(filesystemDeps()).collectState()`，不写盘） | layout 正确（`coding-agent` / 9077 / embed-project）；① 6 个活动键、key 掩码为 `<17>`；② `deepseek / deepseek-flash / http://127.0.0.1:15721/v1` + `connected=true`；③ 用户级**无冲突**、进程级冲突 `HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash vs deepseek-flash`；④ `applied:true / consistent / basis:values / rewrittenAfterStart:true` |
| 全仓库回归 | 管理器 4 支全 PASS；子插件 7 支中 6 支全 PASS（本插件 60/60）。唯一红仍是第三方 `dsh-open-session-workdir/test/interception.test.mjs`（下游包形状变化，与本变更无关） |
| 语法 | `node --check` × 3（index / client / host-core）通过 |
| 骨架约束 | `package.json` 无 `dsh.bundle`；目录内无 `cordis.patch.yml`；管理器扫描实测含 `dsh-hindsight-model`，行 id `hindsight-model` |
| `openspec validate` | 通过（13 需求 / 31 场景；归并判据修订后重跑仍通过） |

**开发期被 harness/真机抓到的真缺陷**（都不是我事后补的说明）：
1. `useDshKey` 单独提交被「空变更」校验拦掉 → `save()` 改为先合并 resolvedKey 再校验；
2. `collectState` 的 ④ 层漏输出 `file`/`runtime`，而客户端展示不一致字段要读它们；
3. **生效判据本身**（见 §3.4）——真机推翻规格；
4. **harness 的 React shim 忽略 `useEffect` 依赖数组**：每次重渲染都重跑 `load()` 并把刚编辑的草稿重置回去。是「编辑字段后应显示原值」这条新用例把它逼出来的；已让 `useEffect`/`useMemo`/`useCallback` 都遵守 deps。

### 4.1 表单布局修订（用户看完真机截图后提出「有点挤」）

真机截图暴露的问题不是「稍微挤」，而是**表格结构在窄设置栏里撑不住**：`状态` 列只有 13% 宽，`被外层覆盖` 5 个中文字在 11px 下约 55px + 内边距即溢出，折成两行并压到「值」列上；而「落盘值」列在未编辑时与输入框内容完全重复，却白占 18% 宽度。

改成**行式列表**（用户确认后实施）：

- 每个字段一个块：`标签 + 状态徽标 + 键名`（徽标 `white-space: nowrap`，永不换行）→ 输入框独占整行（`flex: 1 1 240px; min-width: 0`）→ **按需**的注脚行；
- 删掉「落盘值」列；改为注脚，且**只在能提供输入框之外的额外信息时出现**：`原值 X`（仅当草稿≠落盘）、`未设 → 回落默认：X`、`实为宿主进程：X`（被覆盖时给出**真正生效的值**——这条同时加强了规格需求 3「必须给出实际生效值」）；
- 相应地删掉了设置表单里的 `<table>`/`<th>`。

新增 5 条渲染用例锁定新布局，其中最有牙的一条是结构断言：**任何 `<input>` 都不得位于 `<td>` 之内**（旧布局正是如此）。harness 总数 60 → **65**，全绿。

## 5. 未解决问题和剩余风险

- **真机主链路尚未人工验收**：`ACCEPTANCE.md` 全部 `[B]` 项（尤其 §10.1 主链路与 §10.2 冲突源闭环）需用户手测；未通过则本变更不算完成。
- **清不掉宿主进程环境变量**：本机 `HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash` 来自启动 `dsh web` 的**上层环境**，插件只能显示 + 靠净化命令规避；要彻底解决需用户在自己启动 DSH 的地方去掉该变量。已在面板与 README 明示为能力边界。
- **上游整体重写 `.env`**：行级写入的持久性依赖「启动路径把既有非小写键带过去」，**外层同名键存在时写入仍会被覆盖**。这是上游行为，README 已记为已知行为，避免日后误判为插件 bug。
- **`HINDSIGHT_API_EMBEDDINGS_MODEL` / `..._RERANKER_MODEL` 不存在**：交接稿里的键名有误，真名是 `..._EMBEDDINGS_LOCAL_MODEL` / `..._RERANKER_LOCAL_MODEL`（按 provider 分名）。本插件只暴露在用的 `local` 一支；换 provider 需另开变更。
- **`peerDependencies` 未声明**：宿主半不 import 任何 `@deepseek-ai/*`，客户端只依赖 `dsh.client.inject` 声明的运行时模块，故没有真实 peer 依赖；同时规避了本仓库已知的 peer 范围对 `0.1.5-rc.2` 全部 UNMET 的问题（见 `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md`）。
- **平台限定**：`reg query` / PowerShell / `uv`；非 Windows 下相关层降级为未知。

## 6. Git 状态

- 是否提交：**未提交**（未收到 commit 指令，不执行 commit / push）。
- 涉及文件：新增 `sub-plugins/dsh-hindsight-model/`（7 个文件）、`openspec/changes/2026-09-13-add-hindsight-model-panel/`（4 个产物）、`docs/change-reports/2026-09-13-hindsight-model-panel-change-report.md`、`docs/knowledge/2026-09-13-dsh-hindsight-model-panel.md`、`docs/knowledge/README.md`（索引一行）。
