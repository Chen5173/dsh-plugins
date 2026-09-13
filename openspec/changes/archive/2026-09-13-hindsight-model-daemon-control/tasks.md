## 1. 纯函数层（先写测试）

- [x] 1.1 实现 `sanitizedEnv(env, keys)`：从 `process.env` 派生副本并删除 profile 管理的键。验证：harness 断言被删键消失、无关键（如 `PATH`）保留、原对象未被改动。
- [x] 1.2 实现 `daemonArgs({embedPackagePath, daemonProfile, action})`：产出 `uv run --directory <dir> hindsight-embed daemon --profile <profile> start|stop` 的参数数组；入参缺失时返回 null。验证：harness 断言 profile 名与目录来自入参（不硬编码）、`restart` 不被透传成 CLI 参数（CLI 无此子命令）、缺参返回 null。
- [x] 1.3 实现停止的幂等判定与重启的等待参数（端口释放轮询上限/间隔，作为常量导出）。验证：harness 覆盖「本就没跑 ⇒ 视为成功且带说明」「跑着 ⇒ 正常执行」「等待超限 ⇒ 失败并说明」。
- [x] 1.4 实现输出截断与脱敏 `tailForDisplay(text)`：只留尾部若干行，且不落任何形似密钥的值。验证：harness 断言超长输出被截断、含密钥字样的行被替换。

## 2. 宿主半：启停执行

- [x] 2.1 实现 `daemonAction(action, {confirm})`：串行化（单飞）、spawn、超时、回执。`stop`/`restart` 缺 `confirm` 时拒绝。验证：单测（注入假执行器）断言「缺 confirm ⇒ 拒绝且不 spawn」「单飞：并发第二次调用被拒」「超时 ⇒ 失败且不重试」。
- [x] 2.2 接上真实的 spawn：子进程用**净化后的 env**，`shell` 仅按平台需要开启（Windows 下 `uv` 是 `uv.exe`，直接 execFile 即可）。验证：单测断言传给 spawn 的 env 里不含托管键；真机跑一次 `start`。
- [x] 2.3 `restart` = stop → 等端口释放（有上限）→ start。验证：单测断言调用顺序与等待发生在两者之间；真机跑一次 `restart` 并确认 PID 变化。

## 3. 宿主半：端点

- [x] 3.1 注册 `POST /__hindsight-model/daemon`，body `{action, confirm?}`；非法 action 回 400、缺 confirm 的 stop/restart 回 400、`start` 不需要 confirm。验证：harness 逐分支断言状态码与 JSON。
- [x] 3.2 回执携带重新采集的四层快照 + 退出码 + 截断后的输出。验证：harness 断言响应含 `state.layers.applied` 与 `result.exitCode`，且不含密钥明文。

## 4. 客户端半：区块与动作

- [x] 4.1 「守护进程」区块：状态行（运行中/已停止 · PID · 端口 · 启动时间 · 健康）+ 四个按钮 `启动`/`停止`/`重启`/`刷新`；动作进行中互斥禁用。验证：harness 渲染断言四个按钮存在、状态文案随 `/state` 变化、进行中全部禁用。
- [x] 4.2 停止/重启的内联二次确认（点击后按钮变「确认停止」/「确认重启」，并带 `confirm: true` 发请求）；取消不发请求。验证：harness 断言确认前无请求、确认后请求体含 `confirm: true`。
- [x] 4.3 常驻提示「停止/重启会中断进行中的记忆操作」，且该提示在按钮旁可见。验证：harness 渲染断言文案存在。
- [x] 4.4 展示将执行的命令文本（沿用既有区块），并说明插件已代为净化环境。验证：harness 断言命令文本与净化说明同时出现。
- [x] 4.5 降级：本机配置不可读或生成不出命令时整块禁用并写明缺口，其余功能照常。验证：harness 注入缺失场景断言禁用态与文案。

## 5. 文档同步与回归

- [x] 5.1 更新插件 `README.md`：新增「启停」用法、净化由插件负责的说明、把原先「插件不启停」的表述改掉。验证：README 里每条命令与端点从源码逐条核对。
- [x] 5.2 更新 `ACCEPTANCE.md`：新增启停相关的 `[B]` 项（启动/停止/重启/确认门/幂等/净化生效），并修掉与新行为矛盾的旧条目。验证：逐条对照本次 delta 的 7 个 Scenario 都能找到对应验收项。
- [x] 5.3 跑全仓库测试确认无新增回归。验证：命令输出；已知的第三方 `dsh-open-session-workdir/test/interception.test.mjs` 红不作为本次回归。
- [ ] 5.4 `[B]` 真机走通：面板「启动」把 daemon 拉起 → 四层 ②④ 从「未知」变为实际值 → 「停止」后回到未知 → 「重启」后 PID 变化；且**启动后 profile 的取值未被外层变量改写**（对照 `.env` 内容与 ③ 层）。验证：用户手测；未通过则本变更不算完成。
