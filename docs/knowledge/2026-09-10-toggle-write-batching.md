# DSH 插件：一次开关 = 一次核心配置重应用（写入合并）

日期：2026-09-10 · 涉及：`dsh-plugin-manager/{src/host-core.js, src/index.js, src/client.js, test/debounce.test.mjs}`、profile `cordis.patch.yml`、OpenSpec change `batch-toggle-writes`。

## 一句话

面板开关「卡约 1 秒才翻」的元凶不是管理器（响应 19–30 ms），而是**写 `cordis.patch.yml` 会让 DSH 核心重应用整棵配置树并独占宿主事件循环 0.7–1.2 秒**；管理器能做的是**把 N 次点击合并成 1 次写入**，并把这段时间显示成「正在应用」。

## 实测数据（本机 web profile）

| 场景 | 宿主事件循环最大阻塞 | 说明 |
|---|---|---|
| 单次开关（关） | **1184 ms** | `POST /set-enabled` 往返仅 30 ms |
| 单次开关（开） | **797 ms** | 往返 19 ms |
| 再一轮开关 ×2 | **681 ms / 1021 ms** | 期间 `/plugins/events` SSE 未断 |
| 写入**完全相同字节** | **0（max 71 ms）** | 配置未变 → 核心自行短路 |
| 无任何操作的 180 秒 | 1459 ms（1 次） | 同类阻塞也会自发出现 |

测量方法：5 ms 间隔打 `GET /__dsh-plugin-manager/status`，记录相邻两次探测起点的最大间隔（= 宿主事件循环被占住的时间），同时在 20 ms 粒度上观察 patch 文件 mtime 变化与 `/list` 里的状态翻转。

## 可复用结论

- **代价在「配置变更」本身，不在文件 IO/解析**：相同字节写入零阻塞 → 监听、读取、解析、`entry.update` 的 no-op 路径全都很快；真正的成本是 `root.update(data)` 对整棵树的事务性重应用。
- **不是整树重挂载**：开关期间 `/plugins/events` SSE 保持连接 → web/HMR 插件没有被重新挂载，是增量重应用。
- **核心链路**：`vendor/hmr` 的 chokidar `registerConfig` → `refreshConfig()`（**无内容比对**，只要 `change` 事件就 refresh）→ `apps/cli/src/profile-boot.ts` 的 `watchUserPatches` 回调（`composeLive()` 用 `structuredClone` 拼全部补丁层）→ `vendor/include` 的 `internal/update` 处理器（`applyEntryPatches(this.data, config.patches)` + `root.update(data)`）。
- **任何 patch 层写入者都吃这份成本**（不只本插件）：手工编辑 profile patch、其它写入补丁的工具都一样。
- **插件侧能改的只有两点**：写入的**次数**（合并）和这段时间的**可感知性**（提示 + 不锁死面板）。想让 1 秒本身消失需要改核心（增量应用/分片/只重挂改动项），属上游范围。

## 采用的方案（change `batch-toggle-writes`）

- 主机半：`/set-enabled` 不再立即写文件，而是 `mergeIntent()` 记「行 id → 目标状态」并重置 `INTENT_DEBOUNCE_MS = 400` 的去抖定时器；到点 `flushPending()` **重新读盘**再逐个 `upsertManaged`，只写一次（避免覆盖窗口内别人的改动）。
- 响应与 `/list` 用 `applyIntents(rows, pendingIntents)` 叠加意图 → 面板在 30 ms 内就到目标状态，不必等落盘。
- `/status` 暴露 `pendingWrites` 与 `lastFlushError`；客户端 `settle()` 在「`pendingWrites > 0` 或探测往返 > 250 ms」期间显示「正在应用」，两者都消解后自动撤下（**只提示、不锁开关**，否则连改 3 个插件要串行等 3 秒）。
- `/remove`、`/migrate` 动作前先落盘；`ctx.effect` 清理时同步尽力落盘（强杀进程仍可能丢那次意图，已写进 README）。

## 验证命令

```bash
node dsh-plugin-manager/test/host-core.test.mjs   # mergeIntent / applyIntents 纯逻辑
node dsh-plugin-manager/test/debounce.test.mjs    # 真 handler + 临时 $DSH_HOME：连点只写一次
node dsh-plugin-manager/test/bundle.test.mjs      # 「正在应用」渲染与不锁行
openspec validate batch-toggle-writes --strict
```

红能力验证：临时把 handler 换回「收到请求立即写」，`debounce.test.mjs` 会精确失败在 `two quick switches produced exactly ONE patch-file write`。

## 相关文件

- 变更：`openspec/changes/batch-toggle-writes/`（proposal / design / tasks / spec delta）
- 代码：`dsh-plugin-manager/src/{host-core.js,index.js,client.js}`、`test/debounce.test.mjs`
- 文档：`dsh-plugin-manager/README.md`（宿主半副作用节）、`dsh-plugin-manager/ACCEPTANCE.md`（A8）
