# 2026-09-18 退役 `dsh-open-session-workdir`：机制 + 「官方打开」探测不到 Windows Terminal / PowerShell / cmd 的根因

## 一、退役怎么做（本篇的可复用结论）

需求是「插件过时了，从管理器面板消失，但仓库源码保留」。管理器**没有插件清单**——`dsh-plugin-manager/src/host-core.js` 的 `listRepoPluginDirs()` 直接扫 `sub-plugins/` + 仓库根取 `dsh-*` 目录，所以「不再显示」没有一行现成的注册代码可注释，改的是**扫描**：

- 新增 `RETIRED_PLUGIN_DIRS`（含 `dsh-open-session-workdir`，带日期与理由的注释），`listRepoPluginDirs()` 里 `if (RETIRED_PLUGIN_DIRS.includes(e.name)) continue`。
- 效果：面板不列、`/list` 与三个批量按钮的计数不含它、管理器再也激活不了它；而目录、README、ACCEPTANCE、两个测试**原样保留**（`readPluginMeta` 仍能读到，`valid: true`）。
- 复用的取舍理由：**删目录**会丢参考实现且历史不可 grep；**改目录名**（去掉 `dsh-` 前缀）会让根 README / `docs/plugins.md` / 多个 ACCEPTANCE 里的路径变死链；**只在插件里注释掉 `slots.register`** 则面板仍会列出它。要重新启用 → 把名字从数组里删掉即可。
- 测试钉子（两处，都做过变异验证——把 `includes(...)` 改成 `false` 后两支各自判红，报的是断言信息而非语法错误）：
  - `test/host-core.test.mjs`：合成仓库（两个 root 各放一份退役目录）→ `listRepoPluginDirs` 只返回非退役项。
  - `test/root-install-shell.test.mjs`：真实仓库上断言「退役目录**在磁盘上**（源码保留）+ **不在** `listRepoPluginDirs` 里 + manifest 仍可读」。
- **退役不会自动卸载已激活的实例**：profile `cordis.patch.yml` 的激活行与 `devDependencies` 里的 `link:` 仍在，按钮继续跑；要真移除，用面板「移除」（此时面板还列着它）或手工删行 + 删依赖键 + `pnpm install`。

## 二、为什么退役：核心已经自带同一个功能

- `@deepseek-ai/dsh-client-ui-open-in-app`（`dsh-web-app` bundle 里的 `ui-open-in-app` 行）在 **`conversation.session.header.utilities`**（不是 `actions`）注册一枚「Open In…」**分体按钮**：主按钮 = 上次选过的应用图标，箭头 = 宿主探测到的全部已装应用，点击用该应用打开会话 `cwd`，选择持久化在 `localStorage: dsh.open-in-app.choice`。
- 宿主半 `@deepseek-ai/dsh-host-open-in-app` 只暴露 **HTTP 路由**（不是 remote）：`GET /open-in-app/apps`、`GET /open-in-app/icon/<id>`、`POST /open-in-app/open`（body `{app, path}`，path 必须是绝对且存在的目录），全部先过 `connection.requestRejection` 的信任栅栏。路由常量在 `@deepseek-ai/dsh-host-open-in-app/shared`。
- 本插件原来是纯客户端、零宿主端点，靠 `connection.api.host.openPath` 直连核心原生打开链路；核心这条路线出现后它成了重复品。

## 三、⚠️ 本次调查的核心价值：菜单里只有 Git Bash 的两个独立原因

用户现场只看到 Git Bash。实测（本机 Windows）两个原因**彼此独立**：

### 原因 A：`cmd` / `powershell` / `pwsh` 从来不在候选里

`packages/host/open-in-app/src/catalog.ts` 的终端项只有：macOS `terminal`（`open -a Terminal`）、win32 `windowsterminal`（`wt -d {path}`）、win32 `gitbash`（`git-bash.exe --cd={path}`）、Linux `ghostty`/`kitty`/`gnometerminal`/`konsole`。**没有** `powershell`/`cmd` 条目——`powershell.exe` 在该包里只出现在图标提取与测试注释里。所以它们永远不可能出现在菜单里。

### 原因 B：`wt` 在表里，但被 `stat()` 判成「没装」

`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` 是 **app-execution alias：0 字节 reparse point**。Node 逐 API 实测：

```
wt-alias  stat: EACCES        ← 跟随 reparse 被拒
wt-alias  lstat: OK false     ← 只是个 reparse 点，不是文件
wt-alias  realpath: EACCES
wt-alias  access X_OK: OK     ← 执行是允许的
```

而 `packages/subprocess/subprocess-local/src/index.ts` 的 `resolveExecutable()` 判定恰好是 `stat(candidate)` → `!info.isFile() && continue` → `access(X_OK)`：`stat` 抛 `EACCES` 被 catch → 候选全跳过 → 抛 `was not found on PATH` → `open-in-app` 的 `cli` locator 判为不可用。**同一目录下的真文件（如 `C:\Program Files\Git\git-bash.exe`）`stat` 正常**，所以不是权限沙箱问题，是 alias 这种 reparse point 的特性。

- 验证手法（可复用）：不需要起服务，直接 `node --experimental-transform-types <脚本>` 导入核心源码 `packages/host/open-in-app/src/resolver.ts`，用「PATH/PATHEXT 逐个 stat」的 shim 当 `resolveExecutable`，调 `resolveOpenInAppApps(10000, { resolveExecutable })`，打印 `[...map]`。本机结果：

  ```
  resolved apps: explorer, gitbash
   - explorer {"kind":"shell-open"}
   - gitbash {"kind":"argv","command":"C:\\Program Files/Git/git-bash.exe","args":["--cd={path}"]}
  ```

  注意 `gitbash` 的 `command` 是**混合分隔符**（`C:\Program Files/Git/...`）⇒ 命中的是兜底 `file(['${ProgramFiles}/Git/git-bash.exe'])` 模板（真文件）；`explorer` 是 `fixed` + `shell-open`，win32 恒可用。
- 修法落点（**本次未实施，用户选择只报告**）：① `resolveExecutable` 对 `EACCES/EPERM` 回退 `lstat`（存在）+ `access(X_OK)`，即可让 `wt` 重新可用；② 目录表补 `powershell`/`pwsh`/`cmd` 条目，**同时**在 `packages/client/ui-open-in-app/src/client/locales.ts` 补 `app.<id>` 中英文案——菜单按设计不显示字典里没有名字的 id。

## 四、环境坑：本 harness 的 `pwsh` 是 Windows PowerShell 5.1

`Get-Content -Raw` 在 5.1 里对**无 BOM 的 UTF-8** 文件按 ANSI（cp936）解码，中文注释变乱码；再 `Set-Content -Encoding UTF8` 写回就得到一个语法坏掉的源文件（本次真踩到：`node` 报 `Illegal continue statement`，靠字节级备份 `Copy-Item` 还原）。**结论：改仓库文件一律用 `edit`/`write` 工具，别用 PowerShell 的 `Get-Content|Set-Content` 原地改写**；需要变异测试时，改一行也用 `edit` 工具，跑完再 `edit` 改回。

## 五、本次改动的文件

- `dsh-plugin-manager/src/host-core.js`（`RETIRED_PLUGIN_DIRS` + 扫描跳过 + 注释说明）
- `dsh-plugin-manager/test/host-core.test.mjs`、`dsh-plugin-manager/test/root-install-shell.test.mjs`（各加一条钉子；`root-install` 头部「扫到全部 6 个子插件」的旧口径改为「除退役项外的全部受管子插件」）
- `dsh-plugin-manager/README.md`（新增「退役的子插件不会出现在面板里」一节 + 当前退役名单表）
- `README.md`、`docs/plugins.md`（表格与槽位表标注退役，槽位表补记核心「Open In…」在 `utilities` 槽）
- `sub-plugins/dsh-open-session-workdir/README.md`（顶部退役横幅，原文保留作历史参考）

回归：管理器 5 支套件全绿（含新增断言）；子插件套件除既有的 `dsh-open-session-workdir/test/interception.test.mjs` 外全绿——该红是**既存第三方形状漂移**（它按函数名从 `dsh-better-sidebar` 产物里抽 `isFolderRevealPath`，该包 0.19.0 起已无此函数），与本改动无关，且随插件退役不再影响任何人。
