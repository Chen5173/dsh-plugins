## Why

子插件的解析依赖 profile 里的一条 `link:<绝对目录>`。这条链接会**静默失效**：换机器、换 profile、换安装入口（git 快照 ⇄ 本地路径）、目录改名或迁移之后，键还在但指向的目录已经不对了。面板目前把这种状态显示成「未激活(仅依赖)」，用户看不出是"没装"还是"指错了地方"，也就是**没有任何自动检测**；想修只能手动「全部移除 → 全部开启」。

更关键的是：这条自愈**本来就写在规格里**——`openspec/specs/plugin-manager/spec.md` 的「启用缺失依赖的子插件时自动安装」明确要求"devDependency 已存在但 `link:` 指向的不是当前目录时，视为需要修复并改写为当前目录，而不是直接信任旧路径"，还配了场景「陈旧链接在启用时被修复」。但实现里 `src/index.js` 的守卫只判断"键在不在"（`present`），键在就跳过 `ensureDevDep` ⇒ `host-core` 里现成的 `staleLinkSpec` 永远不被触发。**这是实现漏做了规格要求，不是未定义行为。**

本次变更补上这个缺口，并把"检测"从"用户点开关才发现"升级为**自动检测**：宿主半加载时与面板刷新时各查一次（只读）；**能确定目标就自动修**（默认开、每次宿主启动最多一次、带备份），**确定不了就只提示**（绝不猜路径）。

## What Changes

- **自动检测（只读）**：新增逐插件的链接态判定 `fresh / stale-target-missing / stale-mismatch / absent`（比较用 realpath、Windows 下大小写不敏感），结果经 `GET /__dsh-plugin-manager/list` 暴露为每个插件的 `linkState`；检测本身不写文件、不跑 pnpm。
- **自动自愈（默认开，每次宿主启动最多一次）**：宿主半加载时若发现可确定的陈旧项（目标目录存在且唯一对应本仓库里的那个子插件）→ 重写 `link:` + **一次** `pnpm install` + `*.bak-<ts>` 备份；失败回滚、不留半状态；结果（时间/条目/成败）在面板与诊断中可见。开关关闭后只检测与提示。
- **确定不了只提示**：`link:` 目标不存在、或无法唯一确定实际目录时，MUST NOT 猜路径——面板显示横幅与"需人工处理"分区。
- **面板自检横幅 + 一键「重定位」**：检测到陈旧项时显示数量与逐条明细（插件 → 目标的实际/声明差异），按钮执行与自动修相同的动作（可一次处理全部可确定项）；无陈旧时零显示、零写入。
- **补上规格缺口**：单行「开启」与「全部开启」在"键存在但 spec 陈旧"时也走 `ensureDevDep` 重写（守卫收紧为 `present && !stale` 才跳过），与自动检测共用同一判定。
- 文档：README 的安装/升级段说明"链接会自动重定位（含开关）"；ACCEPTANCE 新增人工项；知识库修正 2026-09-18 那篇的表述（不是"未定义"，而是**规格已有要求、实现漏做**）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `plugin-manager`：修改「启用缺失依赖的子插件时自动安装」（把陈旧链接的修复变成**所有启用路径**都必须遵守、并明确"键在但陈旧也要改写"）；新增「陈旧链接的自动检测（只读）」「能确定就自动修、不确定只提示」「面板自检横幅与一键重定位」三条要求。

## Impact

- 代码：`dsh-plugin-manager/src/host-core.js`（`linkStateOf` / `relinkPlan` 纯逻辑）、`src/index.js`（加载时一次性自检+自愈、`present && !stale` 守卫、`/list` 增 `linkState`、新增 `POST /__dsh-plugin-manager/relink`、设置开关）、`src/client.js`（横幅 + 重定位按钮 + 开关）。
- 测试：`test/host-core.test.mjs`（判定矩阵，含 Windows 大小写/分隔符/相对路径/junction）、`test/bundle.test.mjs`（面板横幅与按钮、守卫收紧后的单行自愈）、必要时新增 `test/relink.test.mjs`（真 profile 夹具 + `__setPnpmRunner` 桩，断言"恰好一次 install"）。
- 运行期代价：**正常情况下零写入**；只有真的检测到可修项时才发生"一次 patch/manifest 写 + 一次 install"（写 profile 会触发核心整树重应用 0.7–1.2 s，所以必须一次动作一次 install、每次启动最多一次）。
- 边界：只动受管子插件自己的键，MUST NOT 触碰管理器自身依赖、其它插件行/键、`dsh.profile.bundles`；MUST NOT 删除任何源码目录。
- 非目标（本变更不做）：管理器的自卸载脚本/命令（另一件事，等这轮之后再谈）。
