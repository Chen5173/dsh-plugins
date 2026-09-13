# 宿主版本适配审计：0.1.2-rc.1 → 0.1.5-rc.2

> 一次性结论，供**下一次** DSH 升级照抄流程。审计对象是「本仓库插件用到的宿主/客户端契约」，
> 不是整棵 harness；结论带证据路径与 tag，可直接复跑。

## 1. 为什么要写这篇

DSH 从 `0.1.2-rc.1` 升到 `0.1.5-rc.2`（源码检出 `D:\ChenSirDocument\GitHub-Projects\deepseek-harness`，
`git describe` = `dsh-v0.1.5-rc.2-2-g30841f98c8`；本机 profile 当时仍跑 `0.1.2-rc.1`）时，
本仓库 7 个插件没有任何自动化的「宿主契约」门禁，**只有人工审计**能回答「升级会不会坏」。

本篇记录一套**可复跑的机械审计流程**，以及本次的完整结论——下一次升级不必再从零想。

## 2. 审计流程（5 步，全部只读）

> ⚠️ **本流程的 2b 步是 2026-09-12 晚补上的**：第一轮只做到第 2 步，漏掉了 `CommandContribution.description`
> 这种「成员名没变、**类型签名变了**」的契约变更，结果真机上 `/rewind` 直接消失（详见
> `2026-09-08-dsh-esc-rewind.md` v7.4）。只对撞名字是不够的。

前提：harness 仓库里同时存在新旧两个 tag（`git tag --list 'dsh-v0.1.*'`）。

1. **圈定变更面**：`git diff --name-only dsh-v0.1.2-rc.1..dsh-v0.1.5-rc.2 -- packages/client packages/api packages/core/session`
   （本次 252 个源文件，去掉 `tests/`），只看**插件真正用到的包**。
2. **对撞公开成员名**：对每个变更文件抽成员名——
   `grep -oE '^\s+(readonly )?[a-zA-Z][A-Za-z0-9]*[(:]' | sed -E 's/^[[:space:]]+(readonly )?//; s/[(:]$//'`
   ——对两个 tag 各求一次、`diff` 出**只有删除**（`<`）的文件。加/改通常是兼容的，**删除才是失配候选**。
   > 为什么可行：本项目插件**不 import 宿主内部包**（见 `2026-09-09-plugin-host-half-no-core-import.md`），
   > 所以契约就是「服务名 + 成员名 + 槽位名 + DOM/存储键」这些**字符串与标识符**，正好是机械可比的东西。
   >
   > ⚠️ 但**这类对撞抓不到类型变更**（成员名没变就不会进差集）。
2b. **对撞类型签名**：对「插件用到的每个类型/接口」按名字抽取整段声明、两 tag 各一份、逐行 diff。
   名字没变但签名变了就是这里露出来（本次：`readonly description: string` → `readonly description: () => string`；
   顺带查出 `InputState.imageIds` → `attachmentIds`、`claim.images` → `claim.attachments` 等）。
   抽取脚本要点：用 `^export (?:interface|type) <Name>(?![A-Za-z0-9_])` 定位，
   `interface` 走花括号配平、`type` 走到空行，比较前先去掉注释行与缩进。
   **必须覆盖的类型**：插件注册/回传的对象（如 `CommandContribution`、`SelectOption`）、
   插件读取的快照（`SessionSnapshot`、`ChatSnapshot`、`InputState`）、插件调用的入参（`QueueAction`、`SessionForkRequest`）。
3. **二道核对用生成物**：harness 自带两份生成目录——
   - `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`：每个槽位的 `kind`/`scope`/`ownerProps`/`standardProps`/占用者；用同样的「按 key 抽条目再 diff」办法比对，能查出**槽位契约**变化（本次：只新增 `useResource`/`usePanelInfo`）。
   - `packages/extensions/cordis-client-runner/src/client/api-catalog.ts` 与 `packages/extensions/tool-cordis/src/api-catalog.ts`：客户端/宿主 API 类型目录（本次：客户端只增 9 个类型、删 3 个本仓库未用的类型）。
4. **人读剩余信号**：DOM/CSS 类名、testid、`localStorage` 键、profile 与 CLI 行为不在这两份目录里，
   用 `grep` 直接在新 tag 上验存在性（本次：`sessionRow`/`searchTree`/`searchExpanded`/`listArea`/`flatList`/`sectionHeader`/`headerActions`、
   `[data-composer-input]`、`dsh.workspace.view.v5`、`cordis.patch.yml` 的 `insert`/`disabled`/`id` 键、`dsh plugin` CLI 均在）。
5. **行为语义另算**：类型/名字全对也可能坏在**语义**上——本次真机的第二个缺陷（fork 种子把父会话未落定的排队输入复制进子分支）
   就属于这一类，只能靠**真机日志**（`~/.dsh/sessions/**/session.v3.jsonl.zstd`，
   多帧 zstd 须 `read_across_frames=True`）或复现取证，见 v7.4。

## 3. 本次结论：只有草稿附件一族改名

| 0.1.2-rc.1 | 0.1.5-rc.2 | 影响插件 |
| --- | --- | --- |
| `conversation.createDraftImages(files)` | `conversation.createDrafts(sessionId, files)` | esc-rewind（图片还原） |
| `conversation.releaseDraftImage(id)` | `conversation.releaseDraftAttachment(id)` | esc-rewind（释放草稿） |
| `conversation.draftImages(ids)` | `conversation.resolveDraftAttachments(ids)` | 未使用 |
| `inputActions.addImages(ids)` | `inputActions.addAttachments(ids)` | esc-rewind（草稿回填） |
| `inputActions.removeImage/pruneImages` | `removeAttachment/pruneAttachments` | 未使用 |
| `InputState.imageIds` | `attachments` / `attachmentIds` | 未使用 |
| `ComposerAttachmentsOwnerProps.onAddImages/onRemoveImage` | `onAddFiles/onRemoveAttachment` | 未使用（无插件注册 `conversation.input.attachments`） |
| `ComposerBarInjected.addImages/removeImage/draftImages/resolveSubmitMode` | `addFiles/removeAttachment/resolveDraftAttachments/retryFileUpload` + `hooks.busyEnter` | 未使用 |

**核对为「未变」的清单（下次升级可直接回归这几条）**：

- 槽位：`conversation.input.overlay`、`conversation.input.right`、`conversation.session.header.actions`、`shell.overlay`、`settings.section`
  —— 名与 `kind`/`scope` 全在；**新增**标准 props `useResource`、`usePanelInfo`（加法，不破坏）。
- 客户端服务名：`slots`、`locale`、`sessions`、`workspaces`、`connection`、`commandUi`、`remote`、`remote.session`、`remote.commands`、`remote.settings`、`settings`（宿主侧同名能力亦在）。
- 数据形状：`chat.legacy.nodes`（`LegacyConversationSlice` 仅注释改动）、`timeline.turnOrder` + `turns: Map` + `TurnLocation.end`、
  `ConversationNode` 判别联合（`records.ts` 仅注释改动）。
- 耐久证据链：`turn/end` 的 `{kind:'aborted', reason}` + `AgentCancelCause` 仍含 `{kind:'user'}`、`{kind:'parent'}`、`{kind:'hook'}`、`{kind:'disposed'}`；
  `assistant/message{interrupted:true}` 仍只在 `signal.aborted` 且有内容时写（`core/agent-loop/src/agent.ts`）。
- 客户端会话面：`session.{sessionId,cancel,rename,readAttachment,updateQueue,loadThrough,loadOlder,command}`、`sessions.{binding,byId,list,open,create,fork,subagentAddress,scope,scopeOf}`、`workspaces.{list,archiveSession,openPath}`、`commandUi.register`、`remote.session.{modelCatalog,selectModel}`、`connection.api.host.openPath`。
- 宿主面：`sessions.{get,flush,store,detachEntered}`（`detachEntered` 两版都是 TS `private`，运行时可用）、`agents.{get,cancel,whenIdle}`、`storageDomain.get/table/global`、`workspaces` 表结构。
- 插件清单/安装面：`dsh.client.{platform,inject,immediately,external}` 语义未变、`window.__ModuleLoader__.load({id,factory})` 未变、`@deepseek-ai/dsh-client-ui-primitives` 仍在 `PLATFORM_MODULES` 基座里（新增 `dsh-client-ui-dockkit`）、profile `dsh.profile.bundles`/`patchReload`/`cordis.patch.yml` 与 `dsh plugin` 子命令未变、bundle patch 的 `insert`/`disabled`/`id` 语义未变。

**顺带发现（与本仓库插件无关，但升级时会遇到）**：harness 根 `engines` 变为 `^22.19.0 || >=24.0.0`（本机 Node v24.14.1 满足）；
`apps/cli` 新增 `--from-default-profile` 与代理安装，均加法。

## 4. 结果与后续

- 唯一需要改代码的是 `dsh-esc-rewind` 的草稿附件桥；改法是**能力探测两代兼容**（详见 `2026-09-08-dsh-esc-rewind.md` v7.3），
  不是读宿主版本号——这与仓库既有约定一致（「探测—降级—可见」）。
- **仍未覆盖**：本仓库没有自动化的宿主契约门禁，本篇的 4 步只能人工跑；若以后要固化，最小可用形态是
  「把第 3 步的核对清单写成一个读取 profile `node_modules` 的只读探针」，但那会依赖已安装的核心包版本，
  与「不上服务器、不碰运行中 profile」的测试纪律冲突，**暂不做**。
