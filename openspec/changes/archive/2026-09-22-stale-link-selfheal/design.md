## Context

- **现成件**：`host-core.js` 已有 `staleLinkSpec(manifest, meta)`（判定 `link:` 是否与当前目录不符）与 `linkSpecOf`；`index.js` 的 `ensureDevDep` / `ensureDevDeps` 已会写 `link:` + 跑一次 `pnpm install` + 备份。
- **缺口（规格已有、实现漏做）**：`index.js` 单行 `set-enabled` 路径的守卫只判断"键在不在"（`present`），键在就跳过 `ensureDevDep` ⇒ `staleLinkSpec` 永不触发；`deriveStates` 同样只看键在不在，于是面板把陈旧链接显示成「未激活(仅依赖)」，用户无法区分"没装"与"指错"。
- **数据面与代价**：`GET /list` 返回 `plugins: s.derived`（每项含 `dir/dirPath/name/hasClient/state`）与 `batchCounts`；写 profile 的一次配置变更会触发核心整树重应用 **0.7–1.2 s**（知识库 2026-09-10），所以任何动作都要"一次写 + 一次 install"。批量动作已有 `*.bak-<ts>` 备份与回滚，且有 `__setPnpmRunner` 注入点供测试。

## Goals / Non-Goals

**Goals:** 自动检测（只读）→ 能确定就自动修（默认开、每次宿主启动最多一次）→ 不确定只提示；面板横幅 + 一键重定位；补上"键在但陈旧也要改写"的规格缺口（单行/批量/自动三条路径共用同一实现）。

**Non-Goals:** 不猜路径；不碰非受管键/行与 `dsh.profile.bundles`；不删任何源码目录；不做定时轮询（只在宿主加载与面板拉取时检测）；不做管理器的自卸载（另议）。

## Decisions

**D1 判定与实现**：新增 `linkStateOf(manifest, meta, io)` 纯函数（`io = { exists, realpath, platform }` 注入，便于跨平台单测），四态 `absent / fresh / stale-mismatch / stale-target-missing`；比较用 realpath，大小写不敏感平台（win32/darwin）与分隔符差异一律算 `fresh`；`io` 抛错或无法解析一律降级为"不可确定"（只提示，不修）。
**D2 三条路径共用一套自愈**：单行「开启」、批量「全部开启」、自动重定位都调用既有 `ensureDevDep(s)`；差别只在触发者。守卫收紧为 `present && !stale` 才跳过——这正是规格本来就要求的行为。
**D3 自动触发与额度**：宿主半加载后执行一次"检测 → 可确定项一次性重定位"，**每次宿主启动最多一次**（额度是进程内存闩锁，不落盘；失败同样消耗额度，避免坏环境反复写）。
**D4 开关**：复用管理器已有的 settings 命名空间加一个布尔字段（默认 `true`）；关闭 = 只检测 + 提示（横幅与一键按钮仍在）。
**D5 数据面**：`/list` 的每个插件加 `linkState` 与 `expectedDir`；顶层加 `autoRelink: { at, items, ok, error, skipped }`；新增 `POST /__dsh-plugin-manager/relink`（body 可带 `dirs`，缺省处理全部可确定项）。
**D6 一次动作一次 install**：可修项在一次 manifest 写里批量改写，随后只跑一次 `pnpm install`；`fresh` 项零写入。
**D7 备份与回滚**：沿用现有备份（`*.bak-<ts>`）与原子写；manifest/patch 任一失败即回滚到动作前内容，不留半状态。
**D8 客户端**：面板加载即用 `/list` 的 `linkState` 渲染横幅（总数 + 可自动修复区 + 需人工处理区 + 逐条"声明指向 vs 当前实际目录"）+「重定位」按钮 + 开关入口；无陈旧项时横幅不渲染、零写入。

## Risks / Trade-offs

- [误判：junction / 8.3 短路径 / 网络盘] → realpath 解析失败即降级为"不可确定"；误判最坏结果是"多写一次同样的值"（幂等，且有备份）。
- [自动改用户环境] → 只在能唯一确定时写；默认开但有开关；每次启动一次；结果在面板与诊断可见。
- [启动时多一次 install] → 仅在真的陈旧时发生；正常情况下零写入（用写入计数断言守住）。
- [与用户手改 profile 打架] → 备份 + 回滚；开关可关。
- [并发] → 复用现有面板串行/busy 语义，自动动作与手动动作共享同一把"一次性额度"。

## Migration Plan

纯增量：老 profile 行为不变；首次加载若检测到可修项才写一次（并留备份）。回滚 = 关掉开关，或恢复 `*.bak-<ts>`。

## Open Questions

- 开关的 UI 落点（设置页管理器段 vs 面板头部）按实现时就近选择，不影响规格与任务边界。
