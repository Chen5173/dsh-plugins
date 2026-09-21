# Tasks

## 1. 脚手架与清单

- [x] 1.1 建 `sub-plugins/dsh-idle-hook/` 子插件与 `package.json`（`type: module`、`main/exports`（含 `./client`）、**不声明 `dsh.bundle`**、`dsh.client`（platform web）、`files`、`peerDependencies`、**空 dependencies**）；用 `node -e "JSON.parse(require('node:fs').readFileSync('dsh-idle-hook/package.json','utf8'))"` 校验可解析
- [x] 1.2 确认 **不**产生 `sub-plugins/dsh-idle-hook/cordis.patch.yml`（2026-09-10 起的规则：子插件不自带 patch、不声明 `dsh.bundle`）；`ls sub-plugins/dsh-idle-hook` 中无该文件
- [x] 1.3 建 `README.md` 与 `ACCEPTANCE.md` 骨架（标题 + 章节名先占位）；`ls sub-plugins/dsh-idle-hook/` 能看到 4 个文件
- [x] 1.4 迁移到新布局：`dsh-idle-hook/` → `sub-plugins/dsh-idle-hook/`、删自带 `cordis.patch.yml`、`package.json` 去 `dsh.bundle`、客户端 `settings.section` order 17→19（避开 `dsh-hindsight-model` 的 17）；验证：`node dsh-plugin-manager/test/root-install-shell.test.mjs` 通过 + 管理器扫到该插件（`valid: true, hasClient: true`）

## 2. 宿主半纯逻辑（`src/host-core.js`，零 `@deepseek-ai/*` import）

- [x] 2.1 实现解释器映射与命令拼装：`.py`→python、`.bat`/`.cmd`→cmd /c、`.ps1`→powershell -File、`.sh`→bash、其它直接执行；显式解释器覆盖优先；shell 模式下拼成单条字符串
- [x] 2.2 实现参数处理：数组直传、`~` 展开、`{sessionId}`/`{cwd}`/`{title}`/`{reason}` 占位符替换
- [x] 2.3 实现触发上下文构造：stdin JSON（sessionId/sessionTitle/cwd/reason/reasonDetail/triggeredAt/ruleId/ruleName，**不含对话正文**）+ ASCII 安全环境变量（`IDLE_HOOK_SESSION_ID`/`_CWD`/`_REASON`/`_TIME`）
- [x] 2.4 实现触发矩阵判定 `shouldFireOnTurnEnd(reason)`：completed/blocked/error/max-tokens → true；aborted 且 reason.kind ∈ {user, disposed} → false，除此之外的 aborted → true
- [x] 2.5 实现规则校验（字段类型/范围、命令存在性与可执行性、去抖与超时默认值）与失败计数逻辑（连续失败 3 次 → 自动停用；重新启用清零）
- [x] 2.6 写 `test/host-core.test.mjs` 覆盖 2.1–2.5（含带空格路径、中文标题只进 stdin、各平台扩展名、aborted 矩阵边界）；`node sub-plugins/dsh-idle-hook/test/host-core.test.mjs` 全绿

## 3. 宿主半执行器与状态

- [x] 3.1 用 `node:child_process.spawn` 执行脚本（`cwd`/`env`/`windowsHide`、stdin 写 JSON 后关闭、stdout+stderr 尾部截断、超时 `kill` 并记为超时失败）
- [x] 3.2 实现同规则并发跳过（上一实例仍在跑 → 记录「已跳过」）与同规则去抖（默认 3s，可配）
- [x] 3.3 实现执行历史（内存 + 落盘 `~/.dsh/idle-hook-history.json`，滚动 200 条，含时间/规则/结果/耗时/输出尾部）
- [x] 3.4 实现设置命名空间读写（动态 `import('@deepseek-ai/schemastery')` 包 try/catch + 零依赖 fallback schema，注册 `idle-hook` 段；数组为整体替换语义）
- [x] 3.5 验证：在 `test/` 里用临时目录 + 一个写文件的脚本跑通创建→执行→历史落盘→滚动；`node --check sub-plugins/dsh-idle-hook/src/index.js` 通过

## 4. 宿主半接缝（只观察，绝不阻断）

- [x] 4.1 订阅 `ctx.on('session/event', ...)` 取 `turn/end`，套 2.4 矩阵，触发前确认 `agent.status === 'idle'` 且 `inbox.nextTurn`/`nextStep` 为空
- [x] 4.2 注册 `ctx.on('approval/request', (req, next) => { void fire(); return next() }, { prepend: true })`——**不 await** 脚本、原样返回 `next()` 结果
- [x] 4.3 注册 `ctx.on('user-questions/request', ...)` 同上
- [x] 4.4 注册 HTTP 前缀路由 `/__idle-hook/*`（`status`/`rules`/`presence`/`history`/`test-run`），经 `ctx.get('webServer')` 或 `ctx.inject(['webServer'], ...)` 惰性绑定；无 webServer（终端 profile）时静默降级
- [x] 4.5 验证：`test/bundle.test.mjs` 断言宿主半源码**不含** `@deepseek-ai/` import、且两个瀑布监听器的注册参数含 `prepend` + `return next()`；真机上批准一次工具调用，确认脚本被触发且批准结果不受影响

## 5. 客户端半（设置页 + 心跳）

- [x] 5.1 `window.__ModuleLoader__.load` + `settings.section` 注册（id `idle-hook`、`order: 19`、标签「空闲通知」/英文「Idle Notifications」），无 JSX
- [x] 5.2 渲染全局总开关 + 规则列表 + 规则表单（名称/启用/命令/参数/解释器覆盖/工作目录/三个触发条件勾选/触发前提三档/去抖/超时/shell 开关）
- [x] 5.3 每条规则显示上次运行时间·耗时·退出码、失败标红与原因、「试跑」按钮（有会话用真实上下文，无会话用示例上下文）
- [x] 5.4 可展开的执行历史列表（最近 200 条，含输出尾部）
- [x] 5.5 心跳：可见性/聚焦变化与每 5s 定时 POST `/__idle-hook/presence`
- [x] 5.6 首次打开预置一条禁用的 macOS 示例规则；界面变更给出「刷新页面生效」提示且**不自动刷新**
- [x] 5.7 验证：`node sub-plugins/dsh-idle-hook/test/bundle.test.mjs` 用仓库既有 harness 断言注册参数、默认值与「不自动刷新」；真机刷新页面后看到「空闲通知」入口

## 6. 示例脚本（`examples/`）

- [x] 6.1 `notify-macos.sh`（osascript 通知 + afplay 提示音）
- [x] 6.2 `notify-windows.ps1`（PowerShell 原生通知）
- [x] 6.3 `notify-bark.py` / `notify-ntfy.sh`（手机推送，服务端地址与密钥走环境变量）
- [x] 6.4 `notify-webhook.sh`（飞书/企业微信/钉钉/Telegram/Slack 的 webhook 形态）
- [x] 6.5 `private/notify-popo.py`（网易 POPO：`notify.nie.netease.com` 与 `int.notify.nie.netease.com`，`X-Notify-AccessKey` 与收件人走环境变量，Python 3）
- [x] 6.6 `notify-router.py`（按 `reason` 分流到不同通道）+ `examples/README.md`（每条示例怎么填进规则表单）
- [x] 6.7 验证：在本机用 6.1 的配置点「试跑」，观察系统提示音与通知出现；`python3 examples/private/notify-popo.py --dry-run` 能打印将要发送的 payload（不真的发）

## 7. 文档

- [x] 7.1 `README.md` 定稿：安装、触发矩阵表、脚本契约与上下文字段、规则字段表、与 `dsh-notification` 的分工、「触发前提」三档怎么选、已知限制（Windows 真机未验、页面关闭时配置界面不可用）
- [x] 7.2 `ACCEPTANCE.md` 定稿：自动化项（两条 node 命令）+ 需真机项（含标注「需在 Windows 上验」的条目）
- [x] 7.3 `docs/knowledge/` 新增一篇 `2026-09-20-dsh-idle-hook.md`（沉淀：turn/end 优于 agent/status、两个瀑布的 prepend+return next 铁律、宿主半零 core import 下的 schemastery fallback、心跳判在场）+ 在 `docs/knowledge/README.md` 索引表追加一行
- [x] 7.4 根 `README.md` 的「各插件速览」表追加一行、`docs/plugins.md` 补条目（一览表 / 小节 / 槽位表 / 端点表）；确认根 `package.json`（管理器安装外壳）未被改动
- [x] 7.5 验证：`git status --short` 只显示预期文件；`grep -rn "@deepseek-ai/" sub-plugins/dsh-idle-hook/src/index.js` 无输出

## 9. 环境变量设置（2026-09-20 追加）

- [x] 9.1 宿主纯逻辑：`normalizeEnv`（对象 / `KEY=VALUE` 行列两种输入、丢弃非法键与缺等号的行）、`parseEnvText`/`formatEnvText` 往返、`validateEnv`（缺等号与非法键=错误；`IDLE_HOOK_*`、重复键=警告）、`applyEnvPlaceholders`、`mergeEnv` 优先级——由 `test/host-core.test.mjs` 覆盖
- [x] 9.2 配置层：`normalizeRule`/`normalizeConfig`/`defaultConfig` 携带 `env`；schemastery schema 用 `z.dict(z.string())`、零依赖 fallback schema 同步带上 `env`（否则经 fallback 写入会丢字段）
- [x] 9.3 执行层：`runRule` 用 `mergeEnv(process.env, 全局, 规则(占位符已替换), IDLE_HOOK_*)` 构造子进程环境；历史条目记录 `envKeys`（**只记键名，不记值**）
- [x] 9.4 界面：顶部「全局环境变量（所有规则共用）」框 + 保存按钮；规则表单新增「环境变量」框（可覆盖全局）；非法行阻止保存并显示原因；`IDLE_HOOK_*` 只提示不阻止；规则行显示变量个数
- [x] 9.5 「试跑」把**当前未保存的**全局变量与规则变量一起发给宿主，保证试跑与真实触发一致
- [x] 9.6 验证：`node sub-plugins/dsh-idle-hook/test/bundle.test.mjs` 全绿（新增 4 项：全局保存写入 `{env}`、规则 env 写入 rules 数组、非法行阻止保存 + 契约键只警告、试跑同时带上两层 env）
- [x] 9.7 文档：README 的「密钥怎么给」补上环境变量这一层并新增「环境变量（两层）」小节；`examples/README.md` 的「变量怎么给」从三种变四种（推荐改在插件界面里配）

## 8. 端到端验收与收尾

> 8.1–8.5 是**真机验收项，留给用户**：在「设置 → 本地插件」里启用本插件并刷新页面后按 ACCEPTANCE.md 第 1–7 节逐条验（我未擅自改写 profile 的激活行）。

- [ ] 8.1 真机：一轮正常结束 → 脚本触发一次；间隔之内停留不动 → 不重复触发
- [ ] 8.2 真机：关掉浏览器页面后一轮结束 → 仍触发（「仅页面关着」规则）；打开页面并聚焦 → 该规则不触发
- [ ] 8.3 真机：等待批准与等待回答各触发一次，且批准/回答链路行为与未安装时一致
- [ ] 8.4 真机：连续失败 3 次自动停用并标红；修正后重新启用，计数清零
- [ ] 8.5 真机：重启 DSH 后规则与执行历史仍在
- [x] 8.6 跑 `openspec validate add-dsh-idle-hook --strict` 通过，更新 `tasks.md` 勾选状态，**停下**等待用户确认归档
