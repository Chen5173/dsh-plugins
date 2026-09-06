# 验收清单 — dsh-open-session-workdir

代码侧的 17 条逻辑断言已由 `test/bundle.test.mjs` 自动覆盖并通过。本清单覆盖**只有装起来在浏览器里才能确认**的部分：真实安装、视觉布局、宿主原生打开、语言切换、以及「不改变会话状态」的回归。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
# 核心版本必须 >= 0.1.1-rc.2（能力门控用的 session.canOpenWorkspacePath 从该版本起存在）
# 且 dsh-client-runtime 需暴露 workspaces.openPath
dsh --version
```

版本不够时**预期表现是按钮不出现**，不是报错——这是设计行为（能力探测关闭门控）。

## 1. 安装与加载

```bash
cd <本仓库>
dsh plugin --profile web add ./dsh-open-session-workdir
dsh --dump-config --profile web | grep -n open-session-workdir   # 应看到一行
```

- [ ] 1.1 `[B]` 重启 `dsh web` 无报错、无插件加载失败提示
- [ ] 1.2 `[B]` DevTools → Network 过滤 `/plugins/`，能看到本插件 bundle 返回 **200**
- [ ] 1.3 `[B]` Console 无 `slot "conversation.session.header.actions" is not declared`、无 `list slot ... already has an entry with id`
- [ ] 1.4 重复执行 `dsh plugin --profile web add ./dsh-open-session-workdir`：`package.json` 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 各**只有一行**，不产生第二条 `open-session-workdir`

## 2. 入口可见性（spec：会话视图提供打开工作目录的入口）

- [ ] 2.1 `[B]` 选中一个有工作目录的会话 → 头部动作条出现文件夹图标按钮，tooltip 为「打开工作目录」
- [ ] 2.2 `[H]` 按钮与既有按钮同排不重叠：`schedule-catalog`(order 10) → `job-list`(20) → **本按钮(25)** → `session-delete`(30)
- [ ] 2.3 `[B]` 无桌面宿主（WSL 里 `unset DISPLAY WAYLAND_DISPLAY` 后启动，或 headless 容器）→ 按钮**不出现**
- [ ] 2.4 `[H]` 切到 `_no-cwd` 归档下的会话 → 按钮消失；切回有 cwd 的会话 → 按钮回来，**全程不刷新页面**

## 3. 打开行为（spec：触发入口打开该会话的工作目录）

- [ ] 3.1 `[B]` Windows 上点击 → 资源管理器打开到该目录**内部**并显示文件（不是父目录高亮该目录）
- [ ] 3.2 `[H]` 对含空格、中文、反斜杠的 cwd（如 `D:\My Project\中文 dir`）点击 → 打开的仍是该目录本身
- [ ] 3.3 `[H]` 连续点击 3 次 → 每次都独立发起，按钮不永久禁用、不报错
- [ ] 3.4 `[B]` macOS / 带桌面的 Linux 宿主 → 由系统默认文件管理器打开到目录内部

## 4. 反馈（spec：打开结果必须给出可观察反馈）

- [ ] 4.1 `[H]` 成功 → 顶部轻量 Toast「已交给系统打开」，约 4s 自动消失，**无 Modal**
- [ ] 4.2 `[B]` 把某会话的 cwd 目录临时改名后点击 → 锚定卡片显示「该目录当前无法访问（可能已被删除或移动）」+ 完整路径 + 复制按钮
- [ ] 4.3 `[H]` 目录仍在但宿主打开失败（DevTools 里把 `connection.api.host.openPath` 打桩成 `() => Promise.resolve({result:{ok:false,error:{message:'opener refused'}}})`）→ 卡片透出宿主原文；`path open failed: ` 前缀若出现会被剥掉
- [ ] 4.4 `[B]` 超时：DevTools 里把网络节流到 Slow 3G 或直接 kill 宿主 powershell 进程 → 卡片提示「打开请求超时」，按钮恢复可点，**不永久停在 spinner**

## 5. 路径可获取（spec：失败时目录路径仍可获取）

- [ ] 5.1 `[H]` 失败卡片点「复制路径」→ 粘贴得到完整绝对路径
- [ ] 5.2 `[B]` **远程 Web UI**（浏览器与宿主不同机）：点击后资源管理器开在**宿主**上；卡片常驻一句「目录是在宿主机器上打开的，不是浏览器所在机器」

## 6. 语言（spec：入口文案跟随客户端语言）

- [ ] 6.1 `[B]` 中文客户端 → 按钮 title 与所有提示为中文
- [ ] 6.2 `[B]` 切英文后**不刷新**再看 → 按钮 title 与提示变英文（`locale/change` 生效）

## 7. 主题（spec 无要求，design D4 约束）

- [ ] 7.1 `[B]` 深色 / 浅色主题各看一次按钮与失败卡片 → 无硬编码色、无对比度失效

## 8. 只读回归（spec：触发入口不改变会话状态）

```bash
S=~/.dsh/sessions/<slug>/<session-id>/session.jsonl.zstd
stat -c '%y %s' "$S"      # 记下 mtime 与大小
```

- [ ] 8.1 点击按钮并成功打开目录
- [ ] 8.2 `[B]` 当前会话 id 未变、对话内容未变、滚动位置未变
- [ ] 8.3 再次 `stat -c '%y %s' "$S"` → **mtime 与大小均无变化**
- [ ] 8.4 会话运行状态未变（运行中的会话不会被打断）

## 9. 共存（**本次回归的重点**）

- [ ] 9.1 `[B]` 与 `@huanlin/dsh-plugin-session-delete` 同时启用 → 两枚按钮同排、各自可用、互不遮挡
- [ ] 9.2 `[B]` **启用 `dsh-better-sidebar` 且其 `interceptOpenPath` 开着**，点击本按钮 → Windows 资源管理器真的打开该目录，**不出现** `"<path>" is a directory`（这是已修复的 bug，必须复验）
- [ ] 9.3 `[B]` 同一配置下，点击聊天正文里的文件链接 → 仍然开在 better-sidebar 的编辑器里（本插件不得反向破坏它）
- [ ] 9.4 `[B]` 同一配置下，点击侧边栏文件树里的目录 → 行为与装本插件前一致
- [ ] 9.5 关掉 `dsh-better-sidebar`（`disabled: true`）后重复 9.2 → 仍然正常（不依赖对方缺席）

自动化侧已有一条挂载对方真实代码的探针：

```bash
node dsh-open-session-workdir/test/interception.test.mjs
```

## 10. 回滚

```bash
# 方式 A：禁用
#   编辑 ~/.dsh/profiles/web/cordis.patch.yml：
#     - id: open-session-workdir
#       disabled: true
# 方式 B：卸载
dsh plugin --profile web remove dsh-open-session-workdir
```

- [ ] 10.1 `[B]` 重启后按钮消失，无残留报错
- [ ] 10.2 插件不写任何持久数据 → 卸载后 `~/.dsh/` 下无本插件目录

---

## 全量场景对照

`openspec/changes/add-open-session-workdir/specs/session-workdir-open/spec.md` 共 6 条 Requirement / 17 个场景。逐条走查完成后：

```bash
openspec validate add-open-session-workdir --strict
```
