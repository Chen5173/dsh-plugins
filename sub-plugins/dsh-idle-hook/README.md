# dsh-idle-hook

模型不在运行的时候，按你配置的规则跑一个本机脚本——把「DSH 停下来了」推到你真正会看到的地方。

- **一轮结束**（跑完 / 报错 / 超过 token 上限 / 被拦截）→ 通知我
- **工具调用在等我批准** → 通知我
- **模型提问在等我回答** → 通知我

脚本是一个**通用执行器**：`python` / `bat` / `ps1` / `sh` / 任意可执行文件都行，怎么通知由你决定（系统提示音、手机推送、办公 IM）。宿主半在 DSH 进程里监听，**浏览器页面关掉也照常触发**。

> 和已装的 `dsh-notification` 的分工见下文「与 dsh-notification 的关系」——两者可以并存而不重复打扰。

## 安装

推荐的方式（同仓库其它插件）：用 `dsh-plugin-manager` 在 **设置 → 本地插件** 里启用 `dsh-idle-hook`。

本插件是 `sub-plugins/` 下的子插件：**不声明 `dsh.bundle`、不带自己的 `cordis.patch.yml`**，激活行完全由管理器维护——因此不要用 `dsh plugin add <子插件目录>` 装卸它（见仓库根 README 的「⚠️ 子插件不要用 `dsh plugin` 装卸」）。

- 宿主半（监听 + 执行）随 profile patch 热重载**立即生效**；
- 设置页入口「空闲通知」需要**刷新一次页面**才会出现（客户端界面只在页面加载时进出 `__DSH_BOOT__`）。

启用后打开 **设置 → 空闲通知**：首次会预置一条**处于禁用状态**的示例规则（macOS 提示音 / Windows 通知），改好字段再启用。在你自己启用任何规则之前，插件不会执行任何东西。

## 触发语义

| 触发 | 什么时候 | 不触发 |
|---|---|---|
| 一轮结束 | `completed`（正常跑完）、`error`（报错）、`max-tokens`（超限）、`blocked`（被拦截） | **你自己按的停止**（`aborted:user`）、会话被销毁（`aborted:disposed`）、`interrupted`（修复标记，运行期不产生） |
| 等待批准 | 工具调用真的被交给人类批准时 | 由既有策略自动放行、从未询问人类的批准 |
| 等待回答 | 模型提问等待人类回答时 | — |

补充语义：

- **边沿触发**：每次「进入」该状态触发一次，停留在状态里不会周期性重复。
- **去抖**：同一规则 + 同一会话的两次触发之间至少间隔 `去抖秒数`（默认 3 秒，可配）。
- **多会话独立**：N 个会话同时停下来就触发 N 次，每次带自己的会话上下文。
- **子代理静默**：子代理（subagent）会话不触发——它的父回合还在跑，那不代表 DSH 停下来了。
- **确认真的停了**：一轮结束后会确认该智能体确实空闲且没有排队输入；如果 driver 紧接着又开了下一轮，就不通知。

## 脚本契约

### 怎么被调用

| 扩展名 | 用什么跑 |
|---|---|
| `.py` | `python3`（Windows 上是 `python`），带 `-u` |
| `.bat` / `.cmd` | `cmd /c` |
| `.ps1` | `powershell -NoProfile -ExecutionPolicy Bypass -File` |
| `.sh` / `.bash` | `bash` |
| `.js` / `.mjs` | 当前 DSH 进程用的那个 node |
| 其它（含 `.exe`、无扩展名可执行文件） | 直接运行 |

规则里的**「解释器」字段留空即可自动判断**；填了就覆盖上表。

- **参数按数组直传**，默认**不经过 shell**：路径里有空格、参数里有引号都会原样送达，也没有注入面。
- 参数与命令里可用占位符：`{sessionId}` `{cwd}` `{title}` `{reason}` `{detail}` `{rule}`；`~` 会展开成主目录。
- **工作目录**：规则填了用它；留空用触发它的会话的工作目录。
- 需要「一行命令」时，打开规则里的 **用 shell 执行整条命令**（应急开关，默认关）。

### 脚本拿到什么

**标准输入**：一份 UTF-8 JSON，写完即关闭。

```json
{
  "sessionId": "session-…",
  "sessionTitle": "修复登录跳转",
  "cwd": "/Users/you/project",
  "reason": "turn-end",
  "reasonDetail": "completed",
  "triggeredAt": "2026-09-20T12:34:56.789Z",
  "ruleId": "rule-…",
  "ruleName": "空闲提醒"
}
```

- `reason` ∈ `turn-end` | `approval` | `question`
- `reasonDetail` 只有 `turn-end` 有意义：`completed` / `error` / `max-tokens` / `blocked` / `aborted:<原因>`；批准与提问时为 `null`。

**环境变量**（给 bat / 一行命令这类不方便解析 JSON 的场景）：

| 变量 | 值 |
|---|---|
| `IDLE_HOOK_SESSION_ID` | 会话 id |
| `IDLE_HOOK_RULE_ID` | 规则 id |
| `IDLE_HOOK_CWD` | 工作目录 |
| `IDLE_HOOK_REASON` | `turn-end` / `approval` / `question` |
| `IDLE_HOOK_DETAIL` | 结束原因细节 |
| `IDLE_HOOK_TIME` | 触发时刻（ISO 8601） |

**隐私边界**：脚本**拿不到对话正文**（用户消息或模型回复的内容）。人类可读的会话标题只走标准输入；环境变量里的 id / 原因 / 时间戳保证是 ASCII，避免 Windows 代码页把变量弄乱（标题若含中文请从 stdin 读）。

### 生命周期

- **超时**：默认 30 秒（可配），到时**杀掉进程**并记为超时失败。
- **并发**：同一规则上一次执行还没结束又来触发 → **本次跳过**并记录「已跳过」（不会堆积进程）。
- **失败**：记录每次的退出码、耗时与输出尾部；**连续失败 3 次自动停用该规则**并在设置页标红，修好后点「重新启用并清零」。

脚本执行**永远不会阻塞 DSH**：不等待、不参与、不影响对话 / 批准 / 回答链路。

## 设置页：空闲通知

| 控件 | 说明 |
|---|---|
| 总开关 | 关掉 = 所有规则都不执行（规则与历史保留） |
| 规则列表 | 每条可 启用/停用、试跑、编辑、删除；显示上次运行时间·结果·退出码·耗时 |
| 触发条件 | 一轮结束 / 等待批准 / 等待回答（三个独立勾选） |
| 触发前提 | 任意 / 仅页面关着 / 仅页面不可见或失焦（见下节） |
| 去抖 / 超时 | 秒；默认 3 / 30 |
| 试跑 | 用**你当前打开的会话**的上下文跑一次；没有会话时用内置示例上下文。试跑计入历史，但**不计入**自动停用的失败计数 |
| 执行历史 | 最近 200 条滚动，落盘 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`（含 stderr/stdout 尾部），重启后仍在 |

规则配置存在 DSH 的设置文件 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook:` 命名空间里，可以直接手改（改完刷新页面即可看到）。

## 环境变量（两层）

设置页顶部有一张**全局环境变量**表，每条规则的表单里也有同样一张——**变量名 / 值两列，每行可删、底部「+ 添加一行」**：

- **全局**：所有规则共用，适合放 `NOTIFY_ACCESS_KEY`、`POPO_RECEIVER`、`MAIL_RECEIVER` 这类变量，配一次就够了。
- **规则级**：只对该规则生效，**同名时覆盖全局**（例如 A 规则发 POPO、B 规则只发邮件）。
- **合并顺序**：DSH 进程环境 → 全局 → 该规则 → 插件注入的 `IDLE_HOOK_*`。
- **`IDLE_HOOK_*` 不可覆盖**：插件注入的触发上下文永远优先——你配了同名键会被忽略，界面只提示不报错，脚本拿到的仍是真实值。
- **占位符**：值里可用 `{sessionId}` `{cwd}` `{title}` `{reason}` `{detail}` `{rule}`，例如 `PROJECT_DIR={cwd}`。
- **格式**：键名限 `[A-Za-z_][A-Za-z0-9_]*`，空行与 `#` 开头的行忽略；缺等号或键名非法的行**会阻止保存**并说明原因。
- **明文提醒**：变量值会明文写进 `<DSH_HOME 或 ~/.dsh>/settings.yaml`（和规则参数一样）。不愿落盘就把密钥留在启动 DSH 前的 `export` 里。
- **文件路径**：设置文件在 `$DSH_HOME/settings.yaml`（`DSH_HOME` 未设置时才是 `~/.dsh/settings.yaml`）。用本仓库的 `dsh-start.sh` 启动时它把 `DSH_HOME` 指向仓库内的 `.dsh_home`，所以实际路径是 `<仓库>/.dsh_home/settings.yaml`；执行历史同理落在 `$DSH_HOME/idle-hook-history.json`。
- 执行历史里只记录**变量名**（方便排查「脚本为什么没拿到变量」），**不记录变量值**。
- **清空即删除**：把框里内容删光再保存 = 真的删掉这些变量（保存走的是设置服务的「整段替换」语义；如果只做合并，空框是删不掉任何键的 —— 这个坑踩过一次）。规则里的环境变量同理，改空的规则会随整条规则一起写回。

## 与 dsh-notification 的关系

`dsh-notification` 是**浏览器原生通知**：只在页面开着时响，只覆盖「一轮结束」，偏好存在浏览器里。本插件补上它做不到的三件事：**页面关着也能通知**、**等待批准 / 等待回答**、**任意通道（含手机与办公 IM）**。

要避免同一件事响两次，用**「触发前提」三档**分工：

| 场景 | 建议 |
|---|---|
| 想让它俩互补（推荐） | 本插件的规则设成 **仅页面关着**：页面开着时 dsh-notification 负责，页面关着时本插件负责 |
| 只想用本插件 | 规则设成 **任意**，并在设置 → 本地插件 里停用 `dsh-notification` |
| 只想在用别的窗口时收到 | 规则设成 **仅页面不可见或失焦** |

「页面关着」= 客户端心跳停了超过 30 秒（页面每 5 秒上报一次可见性/聚焦状态）；从未打开过页面（例如终端 profile）同样按「页面关着」处理。

## 通知脚本示例

`examples/` 里是可以直接用的脚本，把路径填进规则的「命令」即可（解释器留空自动判断）：

| 文件 | 用途 | 需要的环境变量 |
|---|---|---|
| `notify-macos.sh` | macOS 系统通知 + 提示音 | — |
| `notify-windows.ps1` | Windows 原生 toast | — |
| `notify-bark.py` | Bark 手机推送（Python 3） | `BARK_KEY`（`BARK_BASE` 可选） |
| `notify-ntfy.sh` | ntfy 推送 | `NTFY_TOPIC`（`NTFY_BASE` 可选） |
| `notify-webhook.sh` | 飞书 / 企业微信 / 钉钉 / Telegram / Slack | `WEBHOOK_KIND` + 对应 URL/token |
| `private/notify-popo.py` | **网易 POPO**（notify 接口，Python 3） | `POPO_ACCESS_KEY`、`POPO_RECEIVER` |
| `private/notify-mail.py` | **只发邮件**（同一接口；支持抄送/密送、HTML 正文、附件） | `NOTIFY_ACCESS_KEY`、`MAIL_RECEIVER` |
| `private/notify-popo-mail.py` | **网易 POPO + 邮件** 二合一 —— ⚠️ **默认两个渠道都发**，只发一个要在参数里加 `--only mail` / `--only popo`（可 `--batch` 一条请求发两条；支持群里 @、附件） | `NOTIFY_ACCESS_KEY` + `POPO_RECEIVER` / `MAIL_RECEIVER` |
| `notify-router.py` | 按 `reason` 分流到不同通道/文案 | 见文件头注释 |
>
> 带 `private/` 前缀的三个（POPO / 邮件 / 二合一）放在 `examples/private/` —— 该目录被 `.gitignore` 忽略（`**/examples/private/`），**不入库**，新克隆的仓库里没有它们。你自己那份不想提交的脚本（内网接口、个人配置）也放这儿；`examples/README.md` 保留了它们的接口说明。

密钥怎么给（按省事程度自上而下）：① **写进上面的环境变量框**（全局配一次、规则可覆盖；明文落在 `settings.yaml`）；② 启动 DSH 前 `export` → 脚本自动继承（不落盘）；③ 直接写在规则的「参数」里（如 `--token=xxx`，同样明文落盘）；④ 直接写进脚本（本地脚本，风险自负）。用法与坑见 `examples/README.md`。

## 宿主半的副作用（读前知悉）

- 以 **DSH 进程的身份**执行你配置的本地进程（不经过 DSH 的 sandbox 策略）。
- 写 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`（执行历史 + 每规则的失败计数/自动停用状态）。
- 通过客户端写 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook:` 段。
- 注册 `/__idle-hook/*` HTTP 路由，供设置页读取状态、上报页面在场、试跑与查历史。
- 只**观察**批准与提问链路（`prepend` 后原样 `return next()`），绝不改变结果或延迟。

## 已知限制

- 页面关着时看不到设置页（触发照常，宿主半在工作）。
- Windows 侧我只能在 macOS 上验证代码路径（解释器选择/参数拼装/失败处理有单测覆盖），**真机通知未验证**——见 `ACCEPTANCE.md` 的 Windows 条目。
- 规则是**整份数组替换**：同一时刻建议只在一个页面编辑，两个页面同时改会互相覆盖。
- 自动停用后必须手动「重新启用」；插件不会自己复活一条一直失败的规则。
- 规则不做排序/依赖编排，多条规则各自独立执行。

## 开发 / 测试

```sh
node sub-plugins/dsh-idle-hook/test/host-core.test.mjs   # 触发矩阵、解释器选择、上下文、presence、失败计数 + 真进程执行
node sub-plugins/dsh-idle-hook/test/bundle.test.mjs      # 客户端 harness：注册、渲染、写入、试跑、心跳、宿主半安全护栏
```

改 `src/client.js` → **刷新页面**即可（`pnpm run dev:web` 时走 HMR）；改 `src/index.js`（宿主半）→ 需**重启 GUI host**。设计依据见 `openspec/changes/add-dsh-idle-hook/`。
