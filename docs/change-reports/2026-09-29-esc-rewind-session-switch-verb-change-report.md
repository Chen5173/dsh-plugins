# dsh-esc-rewind 变更报告：0.2.0 的会话切换动词迁移（`sessions.open` → `uiWorkspace.openSession`）

日期：2026-09-29 · 相关：`docs/knowledge/2026-09-29-dsh-020-core-api-compat-audit.md` §9 · 交付物：客户端插件 + harness 夹具 + 文档

## 1. 触发（用户报障）

`/rewind` 打开的原生命令选择器（popupSelect）里红字 **`sessions.open is not a function`**，下面才是会话行；回退的后半段全部没发生（分支不打开、问题文本不回填、诊断无线索）。0.2.0 线适配（2026-09-29 审计）之后**仍然**报这个错。

## 2. 根因

- 0.2.0 客户端 `sessions` 面（`packages/extensions/cordis-client-runner/src/client/api-catalog.ts:181-229`）只有 `retain / using / retainInfo / refreshProjections / search / fork / scope / binding`，**没有 `open`**；切换会话的动词在另一个服务 `uiWorkspace.openSession(target)`（同文件 :334-341；类型面 `packages/client/ui-workspace/src/client/navigation.ts:29-34`；实现 :200-202 `replaceMain(target, signal, 'reveal')`；`SessionTarget = SessionId | SubagentAddress`，传子会话 id 字符串即可）。
- 插件两处调用点：`doRewind`（旧 `src/client.js:1359` **裸调用** ⇒ TypeError 冒到选择器）与 `rescueOrphan`（旧 :2270 `typeof sessions.open === 'function'` 守卫把失败**吞掉** ⇒ 孤儿「找回」静默不切分支）。
- **为什么 0.2.0 审计放过了它**：审计 §8.2 按**名字**对表，把 `sessions.open` 一并列进「存在且形状未变」，没有回答「0.2.0 里谁负责切换会话」；同时测试夹具的假 `sessions` **自带 `open`**，比真机多一个动词 ⇒ 红绿失真。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `sub-plugins/dsh-esc-rewind/src/client.js` | 新增 `openSessionInUi(childId)`：能力探测优先 `__svc.uiWorkspace.openSession`、回退旧核心 `__svc.sessions.open`，都缺/都抛写 `__diag.openFail` 并 return false（不读版本号）；`doRewind` 切换失败 ⇒ 撤掉已武装的还原 + 释放已建图片草稿 + **原会话不归档不删除** + `{ok:false, code:'open-unavailable'}` + toast；`rescueOrphan` 改用同一 helper；`apply()` 注入名单加 `uiWorkspace`；i18n 新增 `rewind.open.fail`（中/英） |
| `sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | 夹具删掉假的 `sessions.open`、改 `uiWorkspace.openSession`（`overrides.noUiWorkspace` 可模拟「宿主没有该服务」），`state` 带上 `uiWorkspace`；新增 3 条用例（夹具同形 / 经 uiWorkspace 切换且照常归档 / 无通道 ⇒ 放弃且不动原会话） |
| `sub-plugins/dsh-esc-rewind/README.md` | 服务面、切换步骤、还原时机 3 处措辞 + 新增一条 0.2.0 bullet（红字根因、能力探测、`rewind.open.fail`、`__dsew.openFail`） |
| `sub-plugins/dsh-esc-rewind/package.json` | description 更正为 sessions (fork/create/binding) + uiWorkspace (openSession)；version 0.1.2 → 0.1.3 |
| `package.json` / `dsh-plugin-manager/package.json` | 版本同步 patch+1：0.3.0 → 0.3.1（「有改动必须 bump」硬规则） |
| 文档 | 审计篇 §8.2 更正 + §9 全节；`docs/knowledge/2026-09-08-dsh-esc-rewind.md` 服务清单更正 + v7.8 小节；知识库索引一行 |

## 4. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` | **96/96 通过**（改前 93 条；新增 3 条全绿） |
| 红绿：`git checkout -- sub-plugins/dsh-esc-rewind/src/client.js` 后跑同一套件 | **进程以 `TypeError: sessions.open is not a function` 直接崩**（与真机红字一致）；恢复实现后 96/96 |
| 全仓 sweep（7 个管理器套件 + 9 个子插件套件） | **全部 PASS**：batch-remove-all / bundle / debounce / entry-config(5 checks) / host-core / root-install-shell（含「根外壳与管理器版本一致」护栏）/ uninstall；composer-history-recall 24/24、composer-provider-label 55/55、esc-rewind **96/96**、hindsight-model 115/115、idle-hook 22 + 51、open-session-workdir 31/31、session-time-bucket 16/16、session-title-regenerate 25/25 |
| 唯一一处红：`dsh-open-session-workdir/test/interception.test.mjs` | **与本变更无关的环境性失败，已定位**：该用例从 `C:\Users\chensir5173\.dsh\profiles\web\node_modules\dsh-better-sidebar\lib\client-registry.js`（872776 字节，2026-09-13 20:03）按名字抽取 `isFolderRevealPath` / `wrapOpenWorkspacePath`，而这份**已安装的第三方 sidebar 构建里两个函数都不存在**（上游改名/改构造）⇒ `AssertionError: function isFolderRevealPath not found in client-registry.js — their bundle changed shape`。该插件自身的单元套件仍 31/31 绿。**未修改**：属第三方 bundle 漂移，超出本插件范围 |

## 5. 边界与遗留

- **切换失败时的取舍**：宁可不回退，也不留「fork 出来但没人打开、原会话还被归档/删除」的半成品 ⇒ 明确返回 `open-unavailable` 并 toast。原有 pending-input 守卫（`code:'pending-input'`）语义不变。
- **运行中 GUI**：profile `web` 装的是 git 快照（`github:Chen5173/dsh-plugins#174a17e…`），本次为让用户当场复测，手工把修好的 `src/client.js` 覆盖到 `…/profiles/web/node_modules/dsh-plugin-manager/sub-plugins/dsh-esc-rewind/src/client.js`（备份 `client.js.bak-0.1.2-snapshot`）。**非安装动作**：`dsh plugin --profile web update` 会覆盖回 git 内容；长期热改请按根 README 换本地路径入口（`dsh plugin --profile web add D:/ChenSirDocument/Dsh-Projects/dsh-plugins`，需重启 `dsh web`）。
- **未做**：把「切换会话动词」写进跨版本契约清单做自动体检（本轮靠人）。若后续再遇同类迁移，优先按**动作**对表。
