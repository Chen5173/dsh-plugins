# esc-rewind 宿主 0.1.5-rc.2 版本适配修改报告

## 1. 需求与成功标准

- **需求**：DSH 已升级到 `0.1.5-rc.2`，把本仓库插件适配到新宿主，保证升级后行为不退化。
- **成功标准**：
  - 全仓库 7 个插件对「宿主/客户端契约」的用法在 `0.1.5-rc.2` 上**逐项核对**，列出失配清单；
  - 同一份代码在 **0.1.2-rc.1 与 0.1.5-rc.2 两代核心**上都能工作（用户当前仍跑前者）；
  - 缺能力时**降级而不是报错**，且降级态**可见**（可诊断）；
  - 既有行为（回退引擎、删除模式、提示时机、Esc 语义）**不变**；全仓库测试无新增回归。

## 2. 修改摘要

- 审计结论：插件触点里**只有草稿附件一族改名**（0.1.5-rc.2 把「图片草稿」泛化为「附件草稿」），其余槽位/服务/DOM/存储/证据链/profile 格式全部未变。
- `dsh-esc-rewind/src/client.js` 新增三个**能力探测桥接**纯函数，把三处失配调用点收进统一入口：
  | 桥接函数 | 先探（新） | 回退（旧） |
  | --- | --- | --- |
  | `createDraftAttachments(conversation, sessionId, files)` | `createDrafts(sessionId, files)` | `createDraftImages(files)` |
  | `releaseDraftAttachment(conversation, id)` | `releaseDraftAttachment(id)` | `releaseDraftImage(id)` |
  | `restoreDraftAttachments(actions, ids)` | `addAttachments(ids)` | `addImages(ids)` |
- `__diag` 新增 `draftCreateApi` / `draftRestoreApi`（`'createDrafts'` / `'createDraftImages'` / `null`）；三个函数加入 `_module` 导出供 harness 断言。
- 其余 6 个插件（含管理器）**无代码改动**——审计证明其触点未变。

## 3. 修改文件和符号

| 文件 | 函数/位置 | 修改内容 |
| --- | --- | --- |
| `sub-plugins/dsh-esc-rewind/src/client.js` | `createDraftAttachments`（新增） | 能力探测建草稿：新名 `createDrafts(sessionId, files)` → 旧名 `createDraftImages(files)`；两代都缺返回 `null` |
| 同文件 | `releaseDraftAttachment`（新增） | 释放草稿：`releaseDraftAttachment(id)` → `releaseDraftImage(id)` |
| 同文件 | `restoreDraftAttachments`（新增） | 回填草稿 id：`addAttachments(ids)` → `addImages(ids)` |
| 同文件 | `doRewind` 的图片还原段 | 调用点改为 `createDraftAttachments(...)`；能力守卫改为「新名或旧名任一存在」 |
| 同文件 | `doRewind` 的失败回滚段 | 改为 `releaseDraftAttachment(...)`（去掉 `typeof === 'function'` 内联判断） |
| 同文件 | `EscBridge` 的 pending 还原 effect | `inputActions.addImages(...)` → `restoreDraftAttachments(inputActions, ...)` |
| 同文件 | `__diag` | 新增 `draftCreateApi` / `draftRestoreApi` |
| 同文件 | `exposeInternals` | 导出三个桥接函数 |
| 同文件 | 顶部注释 | `createDraftImages` 一处改为「createDrafts，旧核心名按能力探测」 |
| `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | 夹具 + 5 条用例 | `makeServices` 支持 `draftApi: 'next'\|'legacy'\|'none'`、`readAttachment` 覆写、`failFork`；`mount` 支持 `inputsApi`；新增 5 条（新世代、旧世代、两代各一条释放、两代都缺降级） |
| `sub-plugins/dsh-esc-rewind/README.md` | 顶部段落 / 「为什么默认是 fork+归档」/ 开发-验证 / 新增「版本要求」节 | 写清两代名字、探测结果诊断字段、未变清单 |
| `sub-plugins/dsh-esc-rewind/ACCEPTANCE.md` | 引言 + 2.10 / 2.11 / 4.5 | 测试 49→54 条；新增 `[B]` 人工项（新核心走新名、旧核心走旧名、诊断自证） |
| `sub-plugins/dsh-esc-rewind/package.json` | `version` | 0.1.0 → **0.1.1**（影响用户的适配，按仓库先例手工抬 manifest） |
| `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md` | 新增 | 可复跑的 4 步审计流程 + 本次完整失配/未变清单 |
| `docs/knowledge/2026-09-08-dsh-esc-rewind.md` | v7.3 小节 | 失配表、双代桥接、红绿证据 |
| `docs/knowledge/README.md` | 索引行 | 登记适配审计篇 |
| 宿主半 `src/index.js` | —— | 无改动（宿主面 API 核对未变） |

## 4. 影响面复查

### Codemap

- `sub-plugins/dsh-esc-rewind/src/client.js` 是叶子文件——Codemap `get_file_context` 实测：`IMPORTS: none (leaf file)`、`IMPORTED BY: none`、`CONNECTED: 0 files`，本改动不出文件边界；仓库无 hub 文件。
- 其余插件零改动，不存在跨文件影响。

### 行为边界

- 图片还原仍是 **best-effort**：`readAttachment` 失败/无字节 → 只还原文本；两代 API 都缺 → 跳过并留 `draftCreateApi: null`，**回退照常成功**。
- 一处**语义升级**（新核心侧）：0.1.5 的 `createDrafts` 按 MIME 分流——图片仍是本地草稿，**非图片**会变成「选中即后台直传宿主」的文件草稿。本插件 `nodeImageRefs()` 只收 `type === 'image'` 的 content block、构造出的 `File.type` 也取自 `mediaType`，实际只走图片分支；万一将来出现非图片附件，行为是「正常上传」而不是旧版的抛错降级。
- 新签名多一个 `sessionId` 参数，桥接函数把它带进去（`createDrafts(sessionId, files)`），不会误把 `files` 传成第一参。
- 释放路径：`doRewind` 在 fork/打开失败时释放已建草稿，两代名字各测一次。
- **未触及**：`decideEsc`、hint 结算、删除模式、宿主半删除端点、管理器任何代码。

## 5. 测试结果

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **54/54 PASS** | 既有 49 + 新增 5（新世代建草稿+回填、旧世代同场景、两代释放各一、两代都缺降级） |
| 同套件跑在 `HEAD` 版 `src/client.js` 上 | **50/54** | 4 条新用例红：新世代两条是能力断言（`0 !== 1`，即旧代码给不出 `createDrafts`/`addAttachments`）；旧世代与降级两条红在新增诊断字段（`undefined !== 'createDraftImages'` / `undefined !== null`）。旧世代**释放**那条在改前改后都绿 = 纯回归守卫 |
| `node --check src/client.js` / `src/index.js` | OK | 语法通过 |
| 全仓库套件（4 管理器 + 7 子插件） | 10/11 PASS | manager 4 支全 PASS；子插件 24/53/**54**/31/16/24 全绿；`sub-plugins/dsh-open-session-workdir/test/interception.test.mjs` **仍报错退出**（见 §8） |
| 契约审计 | 人工 4 步 | 见 `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md` |

**红绿验证命令（可复跑）**：

```bash
cp sub-plugins/dsh-esc-rewind/src/client.js /tmp/client.new.js
git show HEAD:sub-plugins/dsh-esc-rewind/src/client.js > sub-plugins/dsh-esc-rewind/src/client.js
node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs   # 50/54：4 条草稿桥用例红
cp /tmp/client.new.js sub-plugins/dsh-esc-rewind/src/client.js
node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs   # 54/54
```

## 6. 架构/模块图变更

- 无（未新增图资产）。本改动在 esc-rewind 客户端内部新增一层「核心世代适配」薄桥接，结构不变。

## 7. 记忆与 Handoff 更新

- 项目记忆：`docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md`（新增）+ `docs/knowledge/2026-09-08-dsh-esc-rewind.md` v7.3 + `docs/knowledge/README.md` 索引。
- 未保存 Codemap handoff（本仓库非 harness 工作目录）。

## 7.5 真机验收发现的第二批缺陷（同日追加，已修）

本节是**首轮静态审计漏掉的两类**问题，由用户在本机 `0.1.5-rc.2` 上跑出来后才定位并修复。

### 缺陷 A：`/rewind` 在 0.1.5 上从 `/` 菜单消失

- **根因（类型级契约变更）**：`CommandContribution.description` 由 `readonly description: string`（0.1.2-rc.1）改为 `readonly description: () => string`（0.1.5-rc.2），候选装配调用 `contribution.description()`（`ui-commands/src/client/service.ts:217`）。本插件传字符串 ⇒ `TypeError` ⇒ **整个候选装配失败**，命令不出现。
- **首轮为什么没抓到**：§2 的审计只对撞了**成员名**（`description` 两版都在，不进差集），没对撞**类型签名**——方法已补（审计篇步骤 2b），并在审计篇顶部标注了这次失误。
- **为什么不能双形态共存**：旧核心把该值**当 React 子节点**渲染（`MenuView.tsx:157`），函数会抛 `Functions are not valid as a React child`；新核心必须拿到函数。
- **修法**：`description` 写成 **getter**，读取时按能力探测结果返回字符串或函数；探测用两个 0.1.5 才有的能力信号（`main.conversation` 槽位 / 槽位新标准 props `usePanelInfo`·`useResource`），**不读版本号**。诊断：`__dsew.commandDescShape`。

### 缺陷 B：回退后「同一条消息被执行了、又有一条在等待」

- **真机取证**（`~/.dsh/sessions/.../session-8c693ecf-.../session.v3.jsonl.zstd`，多帧 zstd 须 `read_across_frames=True`）：
  `#78 turn/end{aborted,user}`（Esc 停止）→ `#79 agent/inbox/spliced` 插入用户消息 A（刚发出、未落盘）→ `#80 session/end-seed{inherited:true}` ★fork 切点 → `#81` 子会话里又发出 B（回退还原的文本）→ `#85` A 落盘并被执行，B 直到 `#160/#167` 才被消费。
- **根因**：0.1.5 把 agent 收件箱写进**事件日志**（`agent/inbox/spliced`），而 fork 用事件种子重建子会话 ⇒ 父会话里那条 pending 输入被复制进新分支并被新分支执行。删除也必须作为事件落在**切点之前**才有效，所以「删一次」不够。
- **修法**：新增 `settlePendingInputs(sessionId, {budgetMs})`（删排队项 + **等快照确认**）；`doRewind` 在 fork 前调用，`empty === false` 时返回 `{ok:false, code:'pending-input'}` + toast 并**放弃回退**；`sessions.open(childId)` 后再跑一次 600ms 兜底清理。诊断：`__dsew.pendingCleared` / `pendingBlocked` / `childPendingCleared`。
- **行为变化（需用户知晓）**：以前「有排队消息时回退」会把那条 pending 输入一起带进新分支；现在**先清掉**，清不掉就**拒绝回退**并提示。

### 追加的测试与验证

| 项 | 结果 |
| --- | --- |
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **60/60 PASS**（54 + 6：命令契约 3 条、未落定输入 3 条） |
| 同套件跑在 `HEAD` 版 `client.js` 上 | **50/60**（10 条红 = 4 条草稿桥 + 3 条契约 + 3 条 pending） |
| 全仓库 11 个套件 | 10 PASS（仍是那条第三方 `interception.test.mjs` 红） |

## 8. 未解决问题和剩余风险

- **真机需人工验收**：用户本机已升级到 `0.1.5-rc.2`（profile 的 `dsh-base` = 0.1.5-rc.2，`dsh-plugin-manager` 已 `link:` 到本检出）， поэтому 2.10/2.11/4.5 之外新增的 2.12/2.13/4.6 也需按 `ACCEPTANCE.md` 手测。客户端改动只需**刷新页面**（宿主半 `src/index.js` 本次未改，不必重启 `dsh web`）。
- **`interception.test.mjs` 仍红（与本改动无关）**：`sub-plugins/dsh-open-session-workdir/test/interception.test.mjs` 从**第三方** `dsh-better-sidebar` 提取函数，本次核对发现该包已是 `0.19.0-alpha.1` 且**整包已不再出现 `openWorkspacePath`/`registerOpenPathInterception`**（`grep -rl` 命中 0 个文件）——即该插件当初要规避的「影子拦截」在新版里可能已不存在。探针按设计「形状变了就报警」，需要按新 bundle 重写或退役；**属于另一个插件的独立工作**，本次未动。
- **`engines` 未跟随**：harness 已改为 `^22.19.0 || >=24.0.0`，本仓库各 `package.json` 仍写 `>=20`。因为插件跑在宿主进程里，最低版本由宿主决定，改不改都不影响运行；如要与宿主口径一致可后续统一抬。
- **无自动化宿主契约门禁**：升级适配只能人工跑审计篇的 5 步（含类型签名差分与真机日志核证），见审计篇 §4。
- **OpenSpec 未开变更**：本次按用户确认走「小 bug 修复豁免」（不改规格行为，只补兼容性），未新建 change；`openspec/changes/2026-09-12-esc-rewind-stop-hint-evidence` 仍**未归档**（等用户验收）。

## 9. Git 状态

- 是否提交：**未提交**（未收到 commit 指令，不执行 commit / push）。
- 提交信息建议（由用户决定）：`fix(esc-rewind): 适配 dsh 0.1.5-rc.2（草稿附件改名 / 命令描述契约 / 回退前清未落定输入）`；如要发版，按仓库先例在 `master` 上打 `v0.2.1`。
