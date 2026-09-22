## 1. 纯逻辑（host-core.js + test/host-core.test.mjs）

- [x] 1.1 新增 `linkStateOf(manifest, meta, io)`：返回 `absent / fresh / stale-mismatch / stale-target-missing / unknown`，比较用注入的 `io.realpath/exists`，大小写（win32/darwin）与分隔符差异算 `fresh`。验证：矩阵用例覆盖「无键」「正确键」「指向存在但不同目录」「目标不存在」「仅大小写差异」「仅分隔符差异」「相对 link:」「io 抛错 → unknown」。
- [x] 1.2 新增 `relinkPlan(derived)`：把陈旧项分成 `auto`（可唯一确定实际目录）与 `manual`（目标缺失/多候选），并给出计数。验证：用例覆盖混合现场、全可修、全不可修、无陈旧（count 0、不修改入参）。

## 2. 宿主半（index.js）

- [x] 2.1 收紧单行与批量启用路径的守卫：`present && !stale` 才跳过 `ensureDevDep`（补规格缺口），批量「全部开启」同源复用。验证：真 profile 夹具 + `__setPnpmRunner` 桩——陈旧时恰好一次 manifest 写 + 一次 install 且 `link:` 被改写；`fresh` 时零写零安装。
- [x] 2.2 `/list` 每个插件加 `linkState`/`expectedDir`；顶层加 `autoRelink` 结果；新增 `POST /__dsh-plugin-manager/relink`（一次写 + 一次 install + 备份 + 失败回滚）。验证：endpoint 级用例（可修项=2 时恰好一次 install、失败回滚、`dirs` 过滤、无陈旧时 noop）。
- [x] 2.3 宿主半加载时自动检测 + 一次性自愈：默认开、进程内存闩锁（每次宿主启动最多一次）、失败消耗额度、日志与诊断留痕。验证：用例断言「可修时自动改写 + 恰好一次 install」「同一进程第二次拉取不再动作」「不可确定项被跳过并列入 skipped」「开关关闭时不写」。
- [x] 2.4 设置开关（管理器 settings 段新增布尔字段，默认 `true`）。验证：describe/update 往返 + 关闭后自动路径不写文件。

## 3. 客户端（client.js）

- [x] 3.1 面板横幅：存在陈旧项时显示总数与分区（可自动修复 / 需人工处理），逐条给出插件名、`linkState`、"声明指向 vs 当前实际目录"；无陈旧项时不渲染。验证：bundle harness 渲染断言（有/无陈旧两种现场）。
- [x] 3.2 「重定位」按钮 + 开关入口：调用 `/relink`，执行中禁用、执行后呈现处理条目与安装是否发生、失败原因可见；开关切换写 settings 并即时反映。验证：harness 断言请求体、按钮禁用态与结果文案。

## 4. 测试与红绿

- [x] 4.1 新增/更新的用例全绿（`node dsh-plugin-manager/test/host-core.test.mjs` + `bundle.test.mjs`，必要时新增 `test/relink.test.mjs`）。
- [x] 4.2 红绿验证：新用例先跑在改动前源码上必须红（记录红条数与失败点），实现后全绿。
- [x] 4.3 全仓 sweep（管理器 4 支 + 子插件全部 + `node --check`）。

## 5. 文档

- [x] 5.1 `dsh-plugin-manager/README.md`：安装/升级段补"链接会随当前目录自动重定位（默认开、每次启动最多一次、可关）+ 面板横幅与一键重定位"。
- [x] 5.2 `dsh-plugin-manager/ACCEPTANCE.md`：新增人工项（自动重定位留痕、关开关只提示、`fresh` 时零写入）。
- [x] 5.3 `docs/knowledge/2026-09-18-batch-remove-all.md` 修正表述：不是"未定义行为"，而是 **规格（plugin-manager spec 场景「陈旧链接在启用时被修复」）已有要求、实现漏做**；并在 `docs/knowledge/README.md` 追加索引行。
- [x] 5.4 新增 `docs/change-reports/2026-09-22-stale-link-selfheal-change-report.md`。
- [ ] 5.5 主 spec 同步（归档时执行，归档由用户触发）。

## 6. 真机验收（用户侧）

- [ ] 6.1 把某个子插件的 `link:` 手工改成不存在的路径 → 重启 `dsh web` → 启动日志与面板显示"已自动重定位 1 条"，`link:` 被改回当前目录，安装恰好一次。
- [ ] 6.2 把某个子插件目录临时改名（使目标缺失且无法确定）→ 只出现横幅"需人工处理"，**不写文件、不安装**。
- [ ] 6.3 关闭开关后再制造陈旧 → 只检测与提示；重新打开并重启 → 自动修一次。