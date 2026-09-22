# dsh-plugin-manager 变更报告：陈旧链接的自动检测与自愈

日期：2026-09-22 · OpenSpec 变更：`openspec/changes/2026-09-22-stale-link-selfheal` · 交付物：宿主半 + 客户端面板 + harness

## 1. 需求（用户确认）

- 只做**旧链接自愈**（管理器的自卸载脚本/命令另议）。
- 检测要**自动**；检测到后：**能确定就自动修，不确定只提示**。
- 自动修复默认**开**，且**每次宿主启动最多一次**。

## 2. 根因（规格已有要求、实现漏做）

- `openspec/specs/plugin-manager/spec.md` 的「启用缺失依赖的子插件时自动安装」原文要求：*"devDependency 已存在但 `link:` 指向的不是该子插件当前所在目录时，系统 SHALL 把它视为需要修复并改写为当前目录，而不是直接信任旧路径"*，并配有场景「陈旧链接在启用时被修复」。
- 实现里 `src/index.js` 的单行 `set-enabled` 守卫只判断"键在不在"（`present`）⇒ `host-core.js` 现成的 `staleLinkSpec` 永不触发；`deriveStates` 同样只看键在不在 ⇒ 面板把陈旧链接显示成「未激活(仅依赖)」，用户无法区分"没装"与"指错"。
- 触发场景：换机器 / 换 `DSH_HOME` / 改安装入口（git 快照 ⇄ 本地路径）/ 目录改名或迁移（`link:` 是**绝对路径**）。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `src/host-core.js` | 新增 `LINK_STATES`（`absent/fresh/stale-mismatch/stale-target-missing/stale-unresolved/unknown`）、`sameLinkTarget`（realpath 比较，win32/darwin 大小写不敏感 + 分隔符归一）、`linkStateOf`（只读判定）、`RELINK_REASONS`、`relinkPlan`（auto/manual 两桶）；`deriveStates` 带上 `linkState`/`linkDeclared`/`linkExpected`（可注入 `io` 便于测试）；`batchPlan` 开启方向把「有行且链接陈旧」纳入目标并把 `needsInstall` 置真 |
| `src/index.js` | 单行启用守卫收紧为 `!inDeps && (无 devDep 键 || spec 陈旧)`；`/list` 增 `linkPlan` + `autoRelink` + `autoRelinkEnabled`；`/status` 增开关与最近结果；新增 `POST /__dsh-plugin-manager/relink`（一次写 + 一次 install + 备份 + 失败回滚，可带 `dirs` 过滤，无陈旧时 `noop`）；加载时 `autoRelinkOnce`（一次性闩锁、失败也消耗额度、开关关闭只记 `skipped`）；设置段 `dsh-plugin-manager.autoRelink`（默认开，含零依赖 fallback schema，link: 安装下 schemastery 解析不到也能注册） |
| `src/client.js` | 面板横幅（计数 + 「声明指向 → 当前实际目录」 + 需人工处理区 + 开关关闭提示）、行内「链接陈旧」徽标、「重定位」按钮（只在有可修项时出现）与结果提示 |
| 测试 | `host-core.test.mjs` 判定矩阵与规划用例；`debounce.test.mjs` handler 级「恰好一次 install」用例（单行修复 / 正确即零写 / `/relink` / 自动一次 + 闩锁 / 关开关）；`bundle.test.mjs` 横幅与按钮；新增测试钩子 `__setAutoRelink`/`__resetAutoRelinkLatch`/`__autoRelinkOnce`；修 harness `textOf` 对嵌套 children 数组的遍历 |
| 文档 | README 面板段、ACCEPTANCE A14、知识库修正 + 索引 |

## 4. 验证证据

| 项 | 结果 |
|---|---|
| `node dsh-plugin-manager/test/{host-core,debounce,bundle,root-install-shell}.test.mjs` | 全部 PASS |
| 红绿：三个源文件还原到 `HEAD` 后跑同一批用例 | `host-core.test.mjs` 因缺少新导出直接崩、`debounce.test.mjs` 1 处 `TypeError`、`bundle.test.mjs` 2 条红（本次横幅用例 + 另一在飞变更的设置入口用例）；恢复实现后全绿 |
| 全仓 sweep（管理器 4 支 + 子插件全部）+ `node --check` | 全绿 |
| `openspec validate 2026-09-22-stale-link-selfheal` | valid（4/4 artifacts） |

## 5. 边界与遗留

- **安全侧**：只在"能唯一确定实际目录"时才自动写；目标缺失且本仓库里找不到该插件 → 只提示；写前留 `*.bak-<ts>`，失败回滚；每次宿主启动最多一次。
- **未做**：管理器的自卸载（删除管理器时连带清子插件）——用户已把顺序定为"先做自愈"，该议题待后续（脚本 / 面板命令 / 上游卸载钩子三条路已调研）。
- **真机验收待用户执行**：ACCEPTANCE A14 的四条 `[B]`（自动修留痕、不可确定只提示、关开关只提示、`fresh` 时零写入）。
- **归档未执行**：主 spec 合并在归档时进行，归档须用户指令。
