# 验收清单 — dsh-hindsight-model

逻辑层（`.env` 行级 merge、启动日志取最后一组、冲突源计算、生效判据、净化命令生成、四层读取、备份/原子写/回滚、保存校验、DSH 侧读取与凭据不回传、HKCU 导出后删除、5 个端点的契约与脱敏、面板四层渲染与三态字段、面板降级渲染）由 `test/bundle.test.mjs`（**60 条**）自动覆盖。标 `[B]` 的必须在真实 GUI 人眼/手测。

架构重点：**插件不启停守护进程**（只给一条净化过环境的可复制重启命令 + 验证按钮）；**写入是行级 read-modify-write**（绝不调 `profile create`，它会整体重写）；**生效判据是「文件三件套 vs 进程实际读到的三件套」**，时序关系只作佐证。

前置：本插件由管理器面板安装（`dsh-plugin-manager` →「本地插件」里启用 `hindsight-model`）。宿主半改动需重启 `dsh web`；客户端半改动刷新页面即可。

## 0. 面板出现与安装

- [ ] 0.0 `[B]` 管理器面板启用后：profile 的 `devDependencies` 出现本插件的 `link:`、`dsh.profile.bundles` 里本地条目**仍只有** `dsh-plugin-manager`、`cordis.patch.yml` 里 `hindsight-model` 行**只有一行**
- [ ] 0.1 `[B]` 重启 `dsh web` → 设置页出现「Hindsight 模型」节，位置在「本地插件」与「MCP」之间；Console 无报错
- [ ] 0.2 `[B]` 宿主半被停用（管理器里关掉）后刷新页面 → 该节消失，且**不出现空白面板**、无未捕获异常

## 1. 四层呈现

- [ ] 1.1 `[B]` ① 层显示 `~/.hindsight/profiles/coding-agent.env` 的路径、mtime 与全部活动键；`HINDSIGHT_API_LLM_API_KEY` 只显示 `••••••(长度)`，**页面上看不到明文**
- [ ] 1.2 `[B]` ② 层显示守护进程启动日志里读到的 `provider / model / base_url`，与 `profiles/coding-agent.log` 里最后一组启动块一致；连通性显示「已验证连接」
- [ ] 1.3 `[B]` ③ 层分两组：用户级环境变量 与 宿主进程环境变量。本机预期：用户级**无冲突**（HKCU 两条与文件同值），宿主进程 env 里 `HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash` **与文件不同** → 出现在进程组并被标为冲突
- [ ] 1.4 `[B]` ③ 层明确写出「宿主进程环境变量本插件清不掉」这句边界说明，并给出自行处理的指引
- [ ] 1.5 `[B]` ④ 层给出结论 + **依据**：本机预期 `已生效 / consistent / 依据：三件套一致`，并附「文件在进程启动后被重写过」的说明
- [ ] 1.6 `[B]` **未知即未知**：停掉守护进程（`hindsight-embed daemon --profile coding-agent stop`）后点「重新读取」→ ②④ 两层都显示「未知：守护进程未在运行」，**不显示**上次的旧值当现状

## 2. 字段三态

- [ ] 2.1 `[B]` 已设置的键显示其落盘值；未设置的键显示「未设 → 回落默认：X」（如 `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` → `BAAI/bge-small-en-v1.5`）
- [ ] 2.2 `[B]` 被外层覆盖的键（本机 `HINDSIGHT_API_LLM_MODEL`）用**独立标记**呈现，与「未设置」明显不同，并同时能看到生效值

## 3. 写入与回滚

- [ ] 3.1 `[B]` 改一个已存在的键并保存 → 提示里出现备份路径；`profiles/` 下出现 `coding-agent.env.bak-<时间戳>`，其内容等于改动前的完整文件
- [ ] 3.2 `[B]` 用编辑器对照改动后的 `.env`：**只有那一行变了**，模板注释、顺序、未知键（如 `HINDSIGHT_API_SOME_FUTURE_KEY`）逐字节不变
- [ ] 3.3 `[B]` 给一个未设置的键赋值并保存 → 该键以 `KEY=VALUE` 追加到文件末尾，既有内容不变
- [ ] 3.4 `[B]` 把某个键的值**清空**再保存 → 该键所在行**消失**（回落默认），而不是写成 `KEY=`
- [ ] 3.5 `[B]` 「保存」按钮在没有任何改动时是禁用的；改一处后才可点

## 4. 冲突源处置

- [ ] 4.1 `[B]` 点「清理用户级冲突键」→ 先出现内联二次确认；点「取消」后**不删任何键、也不生成备份**
- [ ] 4.2 `[B]` 确认清理后：`~/.hindsight/backups/hkcuenv-<时间戳>.json` 出现且含被删键的**值**；`reg query HKCU\Environment` 里该键消失；与该配置无关的键（如 `Path`）**原封不动**
- [ ] 4.3 `[B]` 清理后重启守护进程（用 6.1 的命令）→ 之前被覆盖的键**不再被覆盖**，面板 ③ 层用户级冲突为空

## 5. 从 DSH 读取与密钥

- [ ] 5.1 `[B]` 点「从 DSH 读取」→ provider / model / base_url 被预填为 DSH 的默认模型（本机预期 `codemaker` / `deepseek-flash` / `http://127.0.0.1:15721/v1`）
- [ ] 5.2 `[B]` 预填之后 **profile 文件的 mtime 与内容都不变**（读取不写盘）
- [ ] 5.3 `[B]` 密钥行**不出现明文**：只显示来源（如 `CODEMAKER_API_KEY`）与长度；浏览器 DevTools 的 Network 里 `/dsh-model` 与 `/state` 的响应体**都不含**密钥明文
- [ ] 5.4 `[B]` 勾选「保存时使用 DSH 的密钥」并保存 → `.env` 里的 `HINDSIGHT_API_LLM_API_KEY` 变为 DSH 那把 key，而**页面上全程没显示过它**

## 6. 重启命令与验证

- [ ] 6.1 `[B]` 面板给出可复制的重启命令，其中的 profile 名与 `embed-project` 路径和 `~/.hindsight/coding-agent.json` 一致；第一行是清冲突键的 `Remove-Item Env:`
- [ ] 6.2 `[B]` 执行该命令 → 守护进程重启成功（`daemon status` 正常、`GET http://127.0.0.1:9077/health` 返回 200）
- [ ] 6.3 `[B]` 重启后点「验证」→ 结论为**已生效**，并报出正确的 provider / model / endpoint 三件套与最近的 LLM 调用记录
- [ ] 6.4 `[B]` **反例**：改一个键**保存但不重启** → 点「验证」应报「未生效：文件与进程取值不一致」并**逐个列出**不一致字段及「文件值 vs 进程值」（不是笼统一句"没生效"）
- [ ] 6.5 `[B]` 面板操作期间守护进程的 PID 不变（插件从不自己启停进程）

## 7. 脱敏与诊断

- [ ] 7.1 `[B]` 面板任何位置、任何响应里都不出现 `HINDSIGHT_API_LLM_API_KEY` 的明文（可用 DevTools 全量搜索字符串验证）
- [ ] 7.2 `[B]` 备份区只显示备份**路径**列表，不显示备份文件内容

## 8. 降级

- [ ] 8.1 `[B]` 临时把 `~/.hindsight/coding-agent.json` 改名 → 面板仍打开，只重启命令区显示「读不到本机 Hindsight 配置，命令不可用」，其余照常；恢复文件名后点「重新读取」恢复正常
- [ ] 8.2 `[B]` 缺少 DSH 侧能力时（如某次核心变更后 `credentials` 服务不存在）→「从 DSH 读取」被禁用，并**写明缺哪一项**

## 9. 回归

- [ ] 9.1 `[B]` 核心行为不受影响：设置页其他节正常、会话正常、Hindsight 记忆检索/写入正常（`GET /v1/default/banks` 三个 bank 的 `pending_operations`/`failed_operations` 为 0）
- [ ] 9.2 `[B]` 全仓库测试无新增回归（管理器 4 支 + 子插件各支；`dsh-open-session-workdir/test/interception.test.mjs` 的已知第三方红不算）

## 10. 主链路（必须走通，否则本变更不算完成）

- [ ] 10.1 `[B]` 管理器面板安装 → 打开设置页看到四层 → 对照当前实际值 → 保存一个键 → 用面板给的重启命令重启 → 点「验证」看到「已生效」与正确的三件套
- [ ] 10.2 `[B]` 冲突源处置闭环：清理 HKCU 冲突键前、后各存一次同一个键并重启，确认清理后落盘值不再被覆盖（对照面板 ③ 层与 `.env` 实际内容）
