## 1. 前置核对与插件骨架

- [x] 1.1 核对宿主半注册 HTTP 端点的真实惯用法：读 `sub-plugins/dsh-esc-rewind/src/index.js` 与 DSH `packages/host/webserver/src/index.ts`，确认服务名、`register` 签名、`kind: 'exact'` 用法与 `ctx.effect` 包裹方式；若与 `design.md` D7 的注记不一致，就地更正 design。验证：在 design.md D7 留下「已核对，结论为 X（源码：文件:行号）」。
- [x] 1.2 建骨架 `sub-plugins/dsh-hindsight-model/`：`package.json`（`name`/`main`/`exports["./client"]`/`dsh.client`）、`README.md`、`ACCEPTANCE.md`、`src/index.js`、`src/client.js`、`test/bundle.test.mjs`。验证：`node --check` 两个源文件通过；`grep -c '"bundle"' package.json` 为 0；目录内不存在 `cordis.patch.yml`。
- [x] 1.3 确认插件能被管理器扫描到（不依赖仓库根清单）。验证：按 `docs/knowledge/2026-09-09-dsh-plugin-manager.md` 的双根扫描规则核对目录位置与命名，命中 `sub-plugins/dsh-*`。

## 2. 纯函数层（先写测试）

- [x] 2.1 实现 `.env` 行级 merge：解析 `KEY=VALUE`、只替换命中键所在行、缺失键追加到文件尾。验证：harness 用例覆盖「仅命中行变化」「新增键追加」「注释与顺序逐字节不变」「CRLF 输入输出保真」「值中含 `=`」「空值与引号」「`null` 表示删除键」。
- [x] 2.2 实现启动日志解析：取**最后一组**启动块，抽出 `provider` / `model` / `base_url` 与连通性结论。验证：harness 覆盖「日志含多组时取最后一组」「无日志文件」「有启动块但缺配置读取行」三种输入。
- [x] 2.3 实现冲突源计算：输入 profile 管理的键集 + 用户级环境映射 + 宿主进程环境映射，输出两组冲突键。验证：harness 覆盖「两组分开」「同键不同值」「外层有键但值相同不算冲突」。
- [x] 2.4 实现生效判据：主判据为「①落盘三件套 vs ②进程实际读到的三件套是否一致」（不一致时逐个列出字段），仅当取不到 ② 时回退到时序判据 `StartTime > mtime`（秒级同值按未生效）。验证：harness 覆盖「一致即已生效（即使文件比进程新）」「不一致时列出字段」「进程未报的字段不算不一致」「无启动块时回退到时序判据」。
- [x] 2.5 实现净化重启命令生成：入参 `{daemonProfile, embedPackagePath, conflictKeys}`，产出 PowerShell 片段。验证：harness 断言 profile 名与目录取自入参（不硬编码）、命令在启停前列出全部冲突键的 `Remove-Item Env:`。

## 3. 宿主半：读取四层

- [x] 3.1 定位本机 Hindsight 配置：读 `~/.hindsight/coding-agent.json` 的 `daemonProfile` / `apiPort` / `embedPackagePath`；缺失或不可解析时返回 unknown 而非抛错。验证：单测用临时目录夹具（含文件缺失、JSON 损坏两种），并真机读一次对照当前值。
- [x] 3.2 读取①落盘层：profile `.env` → 有序键值表，**保真未知键**。验证：单测夹具 + 真机对照 `profiles/coding-agent.env` 的 6 个活动键。
- [x] 3.3 读取②生效层：解析 `profiles/<profile>.log` 的最后一组启动块。验证：单测夹具 + 真机对照当前 daemon 启动输出。
- [x] 3.4 读取③冲突源：`reg query HKCU\Environment`（经注入的命令执行器，便于测试）+ 宿主 `process.env`。验证：单测用假执行器；真机对照 HKCU 现有 2 条与进程 env 的 1 条。
- [x] 3.5 读取④判据所需的时序证据：`Get-NetTCPConnection -LocalPort <apiPort> -State Listen` → PID → `Get-Process StartTime`，与 `.env` mtime 比较；daemon 未运行一律 unknown（此时 ②④ 两层都标未知，历史日志不算现状）。验证：单测用假执行器覆盖「在跑」「没跑」；**真机已对照** PID 16280 StartTime=18:55:46 vs .env mtime=18:56:29，并据此发现原时序判据会误报（见 design D4）。

## 4. 宿主半：写入与备份

- [x] 4.1 实现备份 + 原子写 + 失败回滚：写前生成 `*.bak-<ts>`，经 tmp 文件 rename 落盘；任一步失败则从备份还原并回报原因。验证：单测模拟 rename/写入失败，断言文件内容与备份一致且无半写状态。
- [x] 4.2 实现保存聚合：校验键名白名单（只接受 `proposal.md` 列出的键）、`null` 语义为删除该键、未知键拒绝。验证：单测断言未知键返回 400、合法键落盘、删除键后该行消失。

## 5. 宿主半：从 DSH 读取

- [x] 5.1 读默认模型选择：`ctx.get('agentDefaultModel')` 懒取 + `currentSelection()`（同步方法）。验证：mock ctx 单测；真机对照 `settings.yaml` 的 `provider: codemaker` / `model: deepseek-flash`。
- [x] 5.2 读路由端点：`ctx.get('llm').listConfigurableProviders()` → `ctx.get('settings').get(settingsNs)` 按 `settingsPath` 下钻取 `baseURL` / `apiKeyEnv`。验证：mock ctx 单测覆盖「命中」「provider 不在可配置目录」「下钻路径不存在」；真机对照 `codemaker` 的 `http://127.0.0.1:15721/v1`。
- [x] 5.3 凭据解析与不回传：`ctx.get('credentials').resolve(ref)` 得到 `{value, source}`；`/dsh-model` 与 `/state` 只回 `{hasValue, length, source}`。验证：单测断言响应序列化结果中**不含**密钥明文；`useDshKey` 路径断言落盘值等于 resolve 结果。

## 6. 宿主半：冲突键清理

- [x] 6.1 实现导出 + 删除：先写 `~/.hindsight/backups/hkcuenv-<ts>.json`（含键与值），成功后才 `reg delete`；导出失败即中止且不删任何键。验证：单测（假执行器）断言「导出失败 ⇒ 无删除调用」；真机可选演练一次并回填。

## 7. 宿主半：HTTP 端点

- [x] 7.1 注册 5 个 `kind: 'exact'` 路由（`/state` `/save` `/dsh-model` `/verify` `/clean-env`），全部包在 `ctx.effect(...)` 内；`webServer` 不存在时惰性跳过且不抛错。验证：harness 用假 webServer 断言注册路径与 `kind`，并在无 webServer 的 ctx 上断言 apply 不抛错。
- [x] 7.2 端点契约：方法不符 405、未知键 400、内部异常 500 且响应为 JSON。验证：harness 逐端点断言状态码与 `content-type`。

## 8. 客户端半：面板

- [x] 8.1 注册 `settings.section`（`order: 17`，`id`/`name` 与插件一致）并渲染四层对照区，标出层间差异与未知态。验证：harness（React shim + fetch stub）断言四层各自渲染、缺数据时显示未知而非 0/空。
- [x] 8.2 渲染分组表单（推理模型 / 分操作覆盖 / 向量与重排 / 杂项）与三态字段（有值 / 未设且提示默认值 / 被覆盖且给出生效值）。验证：harness 断言三种状态的标记互不相同。
- [x] 8.3 实现交互：密钥掩码 + 「修改」开关 + 「保存时使用 DSH 的密钥」勾选框；按钮「从 DSH 读取」「保存」「验证」「清理冲突键」各自的状态与禁用条件。验证：harness 断言勾选框路径下请求体不含明文密钥、禁用条件随缺服务变化。
- [x] 8.4 降级渲染：缺宿主服务或缺本机配置时，禁用对应区域并显示缺哪一项。验证：harness 分别注入缺失场景断言文案与禁用态。

## 9. 文档、验收与变更报告

- [x] 9.1 写 `README.md`（用法、已知行为「上游启动路径会整体重写 `.env`」、能力边界「宿主进程环境变量清不掉」、安装只能走管理器面板）。验证：文档里每条命令与每个端点都从源码逐条核对——本仓库多次出现「文档声称存在、实际文件不存在」的先例。
- [x] 9.2 写 `ACCEPTANCE.md` 人工验收项（标 `[B]`）。验证：逐条 requirement 的 Scenario 都能在清单里找到对应条目。
- [x] 9.3 写变更报告 `docs/change-reports/2026-09-13-hindsight-model-panel-change-report.md`，并在 `docs/knowledge/` 新增一篇 + 在 `docs/knowledge/README.md` 索引追加一行。验证：索引行链接可达、报告含验证证据表。

## 10. 回归与真机验收

- [x] 10.1 跑全仓库测试（管理器 4 支 + 子插件全部 `test/*.test.mjs`）确认无新增回归。验证：命令输出贴进变更报告；已知的第三方 `dsh-open-session-workdir/test/interception.test.mjs` 红不作为本次回归。
- [ ] 10.2 `[B]` 真机走通主链路：管理器面板安装 → 打开设置页看到四层 → 对照当前实际值 → 保存一个键 → 用面板给的重启命令重启 → 点「验证」看到「已生效」与正确的三件套。验证：用户手测；这是整个插件的存在理由，未通过则本变更不算完成。
- [ ] 10.3 `[B]` 真机验证冲突源处置：清理 HKCU 冲突键前后各存一次同一个键并重启，确认清理后落盘值不再被覆盖（对照 `__` 面板显示与 profile 文件内容）。验证：用户手测 + `.env` 内容对照。
