## Context

见 proposal.md - Why。`sub-plugins/dsh-esc-rewind/src/client.js` 的 `decideEsc()` 目前只有 `none`/`stop`/`rewind` 三种动作：

- 运行态：第一次 `Esc` → `stop`（并设 `stopMarkRef`），第二次 `Esc`（`stopMarkRef === target.seq` → `stopIssued=true`）→ `rewind`，已有两步防误触。
- 非运行态（尾部非 settled 且草稿空）：一次 `Esc` 直接 `rewind`，无第二步确认。

`stopMarkRef` 记录了「对当前 target 回合已按过一次 Esc」，并在 session 切换时重置；document capture 入口在 `onKey`，动作由 `decideEsc` 返回后分发。测试通过 `internals().decideEsc(...)` 直接驱动纯判定。

## Goals / Non-Goals

**Goals:**
- 非运行态回退也走两步：第一次 `Esc` 只武装（提示），第二次 `Esc` 才 `rewind`。
- 复用现有 `stopMarkRef`/`stopIssued` 机制，不新增全局状态。
- 保持运行态行为不变；草稿非空仍 disarm。

**Non-Goals:**
- 不改宿主半 `src/index.js`、不回退点选取（`qualifyExchange`）、不改删除模式。
- 不新增「已武装」专用视觉/独立文案（复用现有 `esc.hint`/`esc.hint.delete` 两档提示）。

## Decisions

1. **新增 `action:'arm'` 而非复用 `'stop'`**
   - 理由：`stop` 的 consumer（onKey）会调 `issueStop` 并设 `stopMark`，语义是“取消运行中的回合”；非运行态没有回合在跑，复用它会让 listener 误以为要 stop，行为混淆。新增 `arm` 使 `onKey` 分支语义清晰（consume + 设 `stopMarkRef` + 提示，不调 `issueStop`）。
   - 备选：复用 `stop`——被否，语义不匹配、易误触发 `issueStop`。

2. **首次 Esc 记录 `stopMarkRef.current = target.seq`，二次依赖既有 `stopIssued`**
   - 理由：`onKey` 已经在每次按下时计算 `stopIssued = stopMarkRef.current === target.seq`；非运行态第一次按下把 `stopMarkRef` 置为 target.seq，天然让下一次按下拿到 `stopIssued=true`，复用现有机制零新增状态。
   - 备选：引入独立“armed” ref——被否，重复 `stopMarkRef` 的功能且要处理与运行态同 ref 的串扰。

3. **非运行态 `arm` 与运行态共用同一 `stopMarkRef` 域**
   - 理由：`stopMarkRef` 本身即“对当前 target 已按过一次”的语义，两种路径天然互斥于同一会话（运行态用 stop 后转到非运行态即可 rewind；非运行态 arm 后不会与运行态 conflict，因为 running 在同一刻不会同时成立）。
   - 备选：分开两个 ref——被否，需额外跨态清理，收益极低。session 切换时既有 `useEffect([sessionId])` 重置 `stopMarkRef` 已覆盖跨会话串扰。

4. **spec 同步范围**
   - 将「可回退状态是派生判定且防误触」的可回退条件由“尾部 `interrupted`”改为“尾部非 `settled`”，并新增“非运行态第一次 Esc 仅武装”场景，使 spec 反映真实行为（含上一轮已放宽的 `tailUnsettled`）。

## Risks / Trade-offs

- [第一次 Esc 只武装，用户可能以为没反应] → 复用既有的“再按一次 Esc 回退本轮”提示（`esc.hint`/`esc.hint.delete`），首次按下即反馈，避免无感。
- [与运行态共用 `stopMarkRef` 可能串态] → 运行态与非运行态在同一会话同一时刻互斥（running 布尔决定走哪支）；session 切换已有重置。测试覆盖跨态序列。
- [非运行态一次 Esc 不再回退，改变现有用户习惯] → 这是本变更的目标（防误触）；spec/文档/提示同步说明“再按一次”才回退。

## Migration Plan

- 纯客户端改版，无数据迁移。
- 部署：改 `src/client.js` + 测试 → 刷新 web 页面即生效（宿主半未改，无需重启 host）。
- 回滚：还原 `decideEsc` 与 `onKey` 的 `arm` 分支即可，无 schema/配置变更。

## Open Questions

无（范围与行为已在 proposal 与用户确认内定；无影响 spec/方案/任务拆分的未决项）。
