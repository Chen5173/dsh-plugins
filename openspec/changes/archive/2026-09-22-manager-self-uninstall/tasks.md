## 1. 卸载脚本（dsh-plugin-manager/tools/uninstall-manager.mjs）

- [x] 1.1 纯逻辑 `planUninstall({ profileDir, repoRoot })`：算出将删内容（受管行 / 指向本仓库 `sub-plugins/` 的 `link:` 键 / 管理器依赖键 / `dsh.profile.bundles` 中的管理器条目）与计数；只读、不写文件。验证：`test/uninstall.test.mjs` 覆盖混合现场（含非本仓库的行与键）与"无可删项"两态。
- [x] 1.2 `runUninstall(plan, { pnpm, dryRun })`：备份两份 `*.bak-<ts>` → 各一次写 → 一次 `pnpm install` → 逐项结果；`dryRun` 零写入零安装；pnpm 失败时如实报错 + 打印重跑命令（降级），且已完成的清行结果保留。验证：注入假 pnpm 计数（恰好一次）、备份文件存在、失败路径输出降级命令。
- [x] 1.3 CLI 薄壳：`--profile <name>`（默认 web）/`--dry-run`/`--pnpm-cmd <cmd>`/`--yes`；解析 profile 的 js-yaml 失败时明确报错非零退出。验证：harness 直接 import 纯逻辑；CLI 参数以最小集成用例覆盖（`--dry-run` 无副作用）。
- [x] 1.4 幂等：重复执行 → `noop`（零写入、零安装、退出码 0）。验证：用例连跑两次，第二次断言写入/安装计数为 0。

## 2. 宿主半（index.js，只读数据面）

- [x] 2.1 `/list` 增 `uninstall: { command, willRemove: { rows, deps, installs, keepsSource } }`：命令按当前 profile 与脚本实际路径拼（按平台引号），`willRemove` 来自 `planUninstall` 的只读计数。验证：debounce harness 断言字段存在、命令含 profile 名与脚本路径、计数与夹具一致。
- [x] 2.2 不引入任何自动动作：`/list` 之外不新增端点、不执行卸载、不写文件。验证：计数断言（`/list` 调用后两份文件 mtime 不变）。

## 3. 客户端面板

- [x] 3.1 「复制卸载命令」按钮 + `将删清单`（N 条激活行 / M 个依赖键 + 管理器自身 / 会执行一次安装 / 源码目录保留）：点击复制 `uninstall.command`；剪贴板不可用（无 `navigator.clipboard` 或拒绝）时降级为显示可选中文本。验证：bundle.test 断言按钮文案、复制的字符串等于 payload 里的命令、降级路径不抛错。
- [x] 3.2 面板文案明确"**不会自动执行**、请到终端运行"；卸载后（命令跑完）再打开面板应是空列表 + 无横幅（与新面板行为一致）。验证：文案断言 + 现场恢复用例。

## 4. 测试与红绿

- [x] 4.1 新增 `test/uninstall.test.mjs`：不变量 = 恰好一次 patch 写 / 恰好一次 manifest 写 / 恰好一次 install / 两份备份存在 / 受管行与链接清空 / 管理器键与 bundles 条目消失 / **其它插件的行与键逐字节不变** / 源码目录仍在 / 第二次运行 noop / pnpm 失败路径输出降级命令且已清部分保留。
- [x] 4.2 红绿验证：新用例先跑在改动前源码上必须红（记录条数与失败点），实现后全绿。
- [x] 4.3 全仓 sweep（管理器全部套件 + 子插件全部 + `node --check`）。

## 5. 文档

- [x] 5.1 `dsh-plugin-manager/README.md` 的「卸载 / 回滚」重写：区分 **git 快照**与**本地 `link:` 开发 checkout** 两种装法，给出这条一键命令，并说明"官方 `dsh plugin remove` 只摘依赖、不管子插件行与链接"。
- [x] 5.2 `dsh-plugin-manager/ACCEPTANCE.md` 新增人工项：真机跑一次一键卸载 → 重启 `dsh web` 无 `failed to import loader entry` / `Cannot find package`；再跑一次是 noop；源码目录仍在。
- [x] 5.3 知识库：把"核心 remove 无钩子 + 悬空行的后果 + 自包含脚本的作用域"写成一条可复用结论（新篇或并入 `2026-09-11-install-via-git-url.md`），并在 `docs/knowledge/README.md` 追加索引行。
- [x] 5.4 新增 `docs/change-reports/2026-09-22-manager-self-uninstall-change-report.md`。
- [x] 5.5 主 spec 同步（归档时执行，归档由用户触发）。

## 6. 真机验收（用户侧）

- [ ] 6.1 面板点「复制卸载命令」→ 在终端粘贴执行（先 `--dry-run` 看清单）→ 正式跑一次 → 重启 `dsh web`：设置 → 插件 里不再有「本地插件」tab，启动日志无 `Cannot find package`。
- [ ] 6.2 再次运行同一条命令 → 报 `noop`（不写文件、不安装）。
- [ ] 6.3 仓库源码目录（`E:\GitHubProjects\ChenSir5173\dsh-plugins`）与各子插件目录仍在；需要时按 README 重新安装管理器即可恢复。