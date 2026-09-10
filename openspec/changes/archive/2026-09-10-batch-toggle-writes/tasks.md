## 1. 定位（已完成）

- [x] 1.1 量宿主成本：`snapshot` 3.1 ms ×3，实机 `/list` 4–22 ms，`POST /set-enabled` 往返 19–30 ms —— 排除管理器自身逻辑
- [x] 1.2 量写入代价：真实开关后宿主阻塞 681 / 797 / 1021 / 1184 ms（4 次采样）
- [x] 1.3 排除监听/解析路径：写入完全相同字节 → max 71 ms、零阻塞（核心对未变配置短路）
- [x] 1.4 排除整树重挂载：`/plugins/events` SSE 在两次开关期间未断
- [x] 1.5 确认核心路径：`vendor/hmr` chokidar → `watchUserPatches` → `vendor/include` `applyEntryPatches` + `root.update`

## 2. 提案与设计（已完成）

- [x] 2.1 `proposal.md`（Why / What Changes / 非目标 / 成功判据）
- [x] 2.2 `design.md`（R1–R7 决策、风险与回滚、已否决方案）
- [x] 2.3 本变更的 spec delta（1 条 MODIFIED + 1 条 ADDED），`openspec validate --strict` 通过

## 3. 主机半：意图合并

- [x] 3.1 `host-core.js`：`INTENT_DEBOUNCE_MS`、`mergeIntent(intents, {id,name,enabled})`、`applyIntents(rows, intents)`
- [x] 3.2 `host-core.test.mjs`：同行覆盖、异行并存、空意图为恒等、未知 id 新增行、不改输入
- [x] 3.3 `index.js`：待写意图 + 去抖定时器 + `flushPending()`（重读磁盘行 → 套用意图 → 写一次）
- [x] 3.4 `snapshot()` 叠加意图；`/status` 增 `pendingWrites` 与 `lastFlushError`
- [x] 3.5 `/remove`、`/migrate` 动作前先 `flushPending()`；`ctx.effect` 清理时同步尽力落盘

## 4. 客户端：正在应用

- [x] 4.1 `settle()`：按 `pendingWrites` + 宿主往返判定，两者都消解才撤下提示
- [x] 4.2 文案 zh/en（`applying`）与提示渲染；bundle 测试断言
- [x] 4.3 `applying` 期间不禁用其它开关（连点交给主机合并），仅显示提示

## 5. 验证与文档

- [x] 5.1 全部测试文件通过（10 个：manager 3 + 子插件 7）
- [x] 5.1b 新增 handler 级 harness `test/debounce.test.mjs`，并验证其**红能力**（换回立即写入即失败在写入次数）
- [x] 5.2 实测连点：400 ms 内翻转 2 个不同子插件 → **1 次写入 + 1 次重应用**（对照改前 2 次）——2026-09-10 实机实测（`probe-burst2.mjs`：并发探测宿主 + 15 ms 粒度监听 patch 文件 mtime）：两轮 burst 各 **1 次写入**、各 **1 次宿主阻塞**（1080 ms / 1341 ms）；4 次开关共落盘 **2 次**（改前为 4 次）
- [x] 5.3 实测单次开关：往返 < 100 ms、「正在应用」出现并在宿主恢复后自动消失、最终状态与磁盘一致——实测 POST 往返 **52–68 ms** 且响应即带目标状态；紧接着 `/status` 报 `pendingWrites=2`（证明尚未落盘）；提示条的显示/撤下由 `bundle.test.mjs` 断言（`pendingWrites>0` 出现、归零后自动撤下、不锁其它行）；结束时状态回到 `active` 且 patch 文件 md5 `d7ae99…` 与初始逐字节一致
- [x] 5.4 `dsh-plugin-manager/README.md`、`ACCEPTANCE.md`（A8）增补；新增 `docs/knowledge/2026-09-10-toggle-write-batching.md` 并登记索引
- [x] 5.5 `openspec validate batch-toggle-writes --strict` 通过（归档留待你验收后）
