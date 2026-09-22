# dsh-esc-rewind 修改报告：删除模式的「子代理守卫」（宿主半拒绝真删）

日期：2026-09-22 · 范围：`sub-plugins/dsh-esc-rewind`（客户端半 + 宿主半 + harness + 文档）

## 1. 问题与成功标准

- **现象（用户报告）**：主 agent 跑着一个子代理、主 agent 停下等它的完成通知时用 rewind 回退；删除模式把主会话**真删**了 ⇒ **子代理不见了，也没能挂到新会话上**。
- **成功标准（方案 A，用户确认）**：
  1. 会话**仍有子代理**（运行中或已结束）时**不真删**：宿主半拒绝，客户端按既有降级路径**归档**，并给**专用提示**（含子代理数量与运行中数量）；
  2. **读不到子代理状态**时同样**不真删**（fail-safe），提示带原因；
  3. 没有子代理的会话**照旧真删**（不引入退化）；
  4. 回退本身永不受影响（最坏情况 = 归档旧会话）。

## 2. 根因（真机取证 + 宿主源码核对）

- **真机现场**（`D:\dsh\.dsh_home`，`settings.yaml` 里 `esc-rewind.deleteOldOnRewind: true`）：
  - 父会话 `session-e71582a6` 已被真删（全库 98 个会话查无此目录），其 rewind 分支 `session-55d37c5f`（`isSeeded:true`、`parentSession=session-e71582a6`）仍在跑；
  - 它的子代理 `6455048f`（`subagent/descriptor{mode:'continuable'}`，label「Mac 侧重建与回归流水线」）`parentSession=session-e71582a6`，turn 2 从 14:09 起未结束，**父会话被删后 8 分钟（16:02）仍在写日志** ⇒ 完成通知永远送不出去；
  - 同期被删的 `session-cbec2279` 留下 **24 个** 子代理孤儿（全库扫描：27 个子代理的父不在磁盘上）。
- **机制（宿主为真源，四条均核对源码）**：
  1. 子代理**只能靠自己的 header** 被枚举：`packages/subagent/subagent/src/list-children.ts:90` 过滤 `record.header.parentSession === parentSessionId && origin === 'subagent'` ⇒ 父日志一删就永久失去入口；
  2. 完成通知按父会话投递：`packages/subagent/subagent/src/continuation-activation.ts:823` `notifySettlement` → `ctx.agents.get(activation.parentSession)`，父缺席**静默 return**；
  3. 侧栏不列子代理行：`packages/client/ui-workspace/src/client/tree.ts:146`（`origin !== 'subagent'`）⇒ 入口只剩父会话的子代理目录；
  4. 投递/授权按 header 校验：`packages/api/session-controller/src/history.ts:346`、`src/agent.ts:85-91` ⇒ 新分支无法接管旧子代理；宿主**没有** reparent/adopt verb（全仓 grep 无生产者）。
- **插件侧缺陷**：`src/index.js` 的 `deleteSessionCore` 只处理目标会话本身（cancel/flush/detach/删目录/清记账），从不查看子代理；客户端 `doRewind` 同理。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `src/index.js` | 新增 `subagentGuardOf(ctx, sessionId)`（官方服务 `ctx.get('subagents').listChildren(sessionId)`）；`deleteSessionCore` 在**任何破坏性动作之前**过守卫，命中即 `DeleteError(409, {reason, children, running})`；`DeleteError` 增加 `details`；删除端点把 details 透传给客户端；新增 `BLOCK_REASON_CHILDREN/UNKNOWN` 常量；`HOST_DIAG.lastGuard` + `GET /__esc-rewind/status` 暴露守卫结论 |
| `src/client.js` | `deleteOldSession` 解析结构化拒绝原因（`REASON_SUBAGENTS/REASON_SUBAGENTS_UNKNOWN`）、`__diag.lastDelete` 留存 reason/children/running、按原因给专用 toast（`rewind.subagents` / `rewind.subagents.unknown`，中英双语）、返回值加 `blocked` |
| `test/bundle.test.mjs` | +6 条用例 + capability audit 4 条断言（见 §5） |
| `README.md` / `ACCEPTANCE.md` | 删除模式段落补「子代理守卫」；人工验收项 5.13–5.15；harness 计数 67 → 74 |
| `docs/knowledge/2026-09-08-dsh-esc-rewind.md` + 索引 | v7.6 一节 + 索引一行 |

守卫语义（三条判据，测试逐条覆盖）：

| 情况 | 结果 | 诊断 |
|---|---|---|
| `subagents` 服务缺席 | 放行（无运行时尚无法拥有子代理） | `known:false` |
| `listChildren` 抛错 | **拒绝**（证明不了「没有子代理」就不做不可逆操作） | `reason: subagents-unknown` |
| 有子代理（running 或 inactive） | **拒绝** | `reason: subagents` + `children` / `running` 计数 |

客户端据此走既有降级路径：`workspaces.archiveSession` + 专用 toast；回退（fork/open/还原）不受影响。

## 4. 关键决策与取舍

1. **只做「不删」，不做「改挂」**：子会话的父身份写在**它自己日志的首事件**里（append-only、不可变），列举/投递/授权全读它；宿主无 reparent API ⇒「让子代理挂到新会话」在现有核心不可实现（要做需重写子会话日志头 + 改运行中的 activation，属核心改动）。
2. **拒绝用结构化 reason，不用文案**：宿主回 `409 + {reason, children, running}`，客户端才能给出准确提示（「还有 N 个，运行中 M」）；文案留在客户端 locale 表。
3. **读不到就拒删（fail-safe）**：与仓库既有原则一致（`describe` 失败一律回退归档、pending 清不掉就放弃回退）。代价是 listing 长期坏掉时删除模式退化为归档——但磁盘与记账零改动、提示里带原因，可诊断。
4. **inactive 子代理也拦（保守）**：删父会让**已结束**的子代理同样失去入口（不可见但日志仍在），故一并拦下。若日后要放开，只需把判据从 `children > 0` 收紧为 `running > 0`。
5. **守卫先于一切破坏性动作**：放在 `stopAgentIfRunning` 之前 ⇒ 拒绝时 agent 未停、日志未删、投影/工作区记账未动（用例断言这一点）。

## 5. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **74/74 passed** |
| 红绿验证：新用例跑在 `HEAD` 版 `src/*.js` 上 | **66/74**（8 条全红：客户端 2、宿主 3、端点 1、常量 1、capability audit 1） |
| `node --check src/client.js` / `src/index.js` | 通过 |
| 管理器 4 支（host-core / bundle / debounce / root-install-shell） | 全部 PASS |
| 其余子插件全量 sweep（9 个包 12 个套件） | 全绿（含此前曾红的 `dsh-open-session-workdir/test/interception.test.mjs`，上游已修） |

新增用例清单：

- 客户端：宿主拒绝（有子代理）→ 降级归档 + 专用提示 + `lastDelete` 诊断；宿主拒绝（未知态）→ fail-safe 归档 + 带原因提示；
- 宿主：有子代理 → 409 + 计数且**磁盘/存储零改动**；listing 抛错 → 409 `subagents-unknown` 且不删；空列表 / 缺服务 → 照常真删；
- 端点：409 透传 `reason/children/running`，且守卫先于任何磁盘动作（用一个磁盘上不存在的 id 验证）；
- capability audit：两侧拒绝原因字面量一致（`subagents` / `subagents-unknown`）。

## 6. 遗留与边界

- **「子代理挂到新会话」仍不可实现**（核心无改挂能力）：本方案的效果是「旧会话保留为归档 → 子代理继续挂在它名下、完成通知仍能送达、界面可从旧会话进入」。
- **曾经派过子代理的会话无法再被真删**（按方案 A 的保守取舍）：这是刻意的，避免产生不可见的孤儿；如要放开见 §4.4。
- **历史孤儿未回收**：本次修复前已产生的孤儿（如 `session-cbec2279` 名下 24 个）仍不可见；如需回收（停掉 / 真删 / 归档）另开一轮。
- 本次未新增 OpenSpec 变更：属小 bug 修复（问题定位明确、改动限于删除通道与提示），按 `openspec-development.md` 豁免。
