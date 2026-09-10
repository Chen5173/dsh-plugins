## Why

面板上点一次开关会「卡住约 1 秒才翻过去」，并且整页同时卡一下。实测定位（本机 web profile，2026-09-10）：

- `POST /__dsh-plugin-manager/set-enabled` 的**往返只要 19–30 ms**，宿主一半的成本（3 次 snapshot）合计约 10 ms —— 慢的不是管理器。
- 每次写入 profile `cordis.patch.yml` 后，宿主事件循环被独占 **681 / 797 / 1021 / 1184 ms**（4 次采样）；期间所有 GUI 请求排队，表现为「整页卡一下」。
- 把**完全相同字节**写回 patch 文件：`max=71 ms`、零阻塞 → 代价不在文件监听/解析，而在「配置真的变了」时 DSH 核心对**整棵配置树**的事务性重应用（`vendor/hmr` chokidar → `apps/cli/src/profile-boot.ts` 的 `watchUserPatches` → `vendor/include` 的 `applyEntryPatches` + `root.update`）。
- 同时订阅 `/plugins/events`：两次开关期间 SSE 未断 → 不是整树重挂载，而是增量重应用。

结论：单次开关的 1 秒不可避免（核心行为，插件侧无法绕过），但**次数可以减少**，且**卡顿可以变成可读状态**。当前实现是「一次点击 = 一次写入 = 一次重应用」，用户连续点 N 个开关就要付 N 秒；面板在等待期间只有开关变灰，没有任何「正在应用」的说明。

## What Changes

- **主机半合并写入（去抖 + 意图叠加）**：`/set-enabled` 不再立即写文件，而是把「行 id → 目标状态」记入内存待写意图并重置一个去抖定时器（默认 400 ms）；窗口结束只写一次 `cordis.patch.yml`，因此 N 次连点最多只触发一次核心重应用。窗口内对同一行的再次点击覆盖同一意图。
- **响应与列表即时反映目标状态**：`snapshot()` 在派生状态前把待写意图叠加到磁盘行上，所以点击后立刻返回的就是用户目标状态（面板开关立即到目标位置，不必等落盘）。
- **待写数量可见**：`/status` 新增 `pendingWrites`，客户端据此判断「是否还有未落盘的变更」。
- **面板显示「正在应用」**：客户端在请求被接受后进入 `applying`，直到「`pendingWrites == 0` 且宿主一次探测往返恢复正常」，才把提示撤下；期间**不锁死面板**（允许继续点，由主机合并），并把合并窗口内不产生任何写入。
- **落盘失败不静默**：合并后的写入失败记录到 `HOST_DIAG.lastFlushError`，面板显示错误，下一次列表刷新以磁盘真实状态为准；进程退出时（`ctx.effect` 清理）尽力把待写意图落盘。
- 移除/迁移动作前先落盘待写意图，避免「先移除、再被一个更早的意图写回」。

## Capabilities

### Modified Capabilities

- `plugin-manager`：主开关的持久化从「每次点击立即写」改为「去抖合并后写」，并在面板上暴露「正在应用」状态。

## Non-goals

- 不改 DSH 核心、不试图消除核心那次整树重应用的 1 秒（只降低触发次数）。
- 不改 `cordis.patch.yml` 的格式、行 id 规则、激活模型（devDependencies + 管理器维护行）。
- 不做「状态未变则不写」的幂等保护：实测 DSH 对未变化的配置已自行短路（相同字节写入零阻塞），该保护无收益。
- 不引入客户端本地乐观状态：服务端意图叠加已让响应在 ~30 ms 内反映目标状态。
- 不新增运行时依赖、不改任何子插件。

## Success Criteria

- 单测全绿：`node dsh-plugin-manager/test/host-core.test.mjs`、`node dsh-plugin-manager/test/bundle.test.mjs`（含新增的意图合并/叠加用例与文案断言）。
- 实测连点：400 ms 窗口内翻转 2 个不同子插件，`cordis.patch.yml` **只被写入一次**、宿主只发生一次重应用（对照改前：2 次写入 + 2 次各约 1 秒的阻塞）。
- 实测单次开关：`POST` 往返 < 100 ms；面板出现「正在应用」提示，并在宿主恢复响应后自动消失；开关位置与最终磁盘状态一致。
- 验收后 `openspec validate batch-toggle-writes` 通过。
