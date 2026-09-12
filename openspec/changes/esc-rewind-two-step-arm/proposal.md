## Why

当前 `decideEsc` 在**非运行态**（尾部非 settled 且草稿为空）下按一次 `Esc` 就直接回退整轮，缺少运行态已有的「第二次 Esc 确认」防误触层级——用户只按一下就可能误触发回退。同时，上一轮把可回退判定从「尾部 `interrupted`」放宽到「尾部非 settled」（含刚发出的 user 提问），但 spec 尚未同步，需要一并校正以满足“spec 反映真实行为”。

## What Changes

- 非运行态下的回退也改为「两步确认」：第一次 `Esc` 只进入武装态并给出“再按一次 Esc 回退”提示，**第二次** `Esc` 才真正执行 `doRewind`。
- 越权于共享同 `stopMarkRef`/`stopIssued` 机制：运行态第一次=stop、第二次=rewind；非运行态第一次=arm、第二次=rewind——两种路径统一，且互相不串状态（session 切换即重置）。
- 同步 / 校正 spec：将「可回退状态是派生判定且防误触」的可回退条件由“尾部 `interrupted`”修正为“尾部非 `settled`（含被打断、未知状态、以及刚发出的 user 提问）”，并补充非运行态两次 `Esc` 的场景。
- 新增/调整 hint 文案：非运行态第一次 `Esc` 的提示仍是「再按一次 Esc 回退本轮」（沿用现有 `esc.hint`/`esc.hint.delete` 两档），不新增文案。**（如用户希望区分“已武装”与“未武装”，可后续再扩展，本次默认复用现有提示避免文案膨胀。）**

## Capabilities

### New Capabilities

（无新增能力）

### Modified Capabilities

- `esc-rewind`: 修改「可回退状态是派生判定且防误触」与「Esc 二次回退撤销整轮并重开分支会话」两个需求——可回退条件放宽为尾部非 `settled`，且非运行态也要求两次 `Esc`（第一次武装、第二次回退）。

## Impact

- `sub-plugins/dsh-esc-rewind/src/client.js`：`decideEsc` 返回 `action:'arm'` 分支、document capture 监听新增 `arm` 处理（consume + 记 `stopMarkRef` + 提示）。
- `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs`：调整非运行态一次回退的断言为“第一次=arm、第二次（stopIssued=true）=rewind”，并新增对应用例。
- `openspec/specs/esc-rewind/spec.md`：同步上述两需求的 delta。
- 宿主半 `src/index.js`：无改动。
- 兼容性：键盘行为改动，无 API/数据格式破坏；需刷新页面生效（纯客户端半）。
