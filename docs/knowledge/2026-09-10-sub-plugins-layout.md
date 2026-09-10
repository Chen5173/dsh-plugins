# DSH 插件：子插件收拢到 sub-plugins/（布局与双根扫描）

日期：2026-09-10 · 涉及：`dsh-plugin-manager/{src/host-core.js, src/index.js, src/client.js, test/*}`、profile web 的 6 条 devDependencies `link:`、OpenSpec change `move-plugins-to-sub-plugins`（2026-09-10 已归档）。

## 一句话

把「仓库根」与「子插件根」拆成两个概念（`pluginRootsOf` 双根并集 + `pluginAbsDirOf` 嵌套优先），子插件源码收拢进 `sub-plugins/`；行 id 只由目录名决定，因此布局迁移**不改变任何激活状态**。

## 可复用结论

- **DSH 的解析链路与目录层级无关**：Loader 行只认**包名**，profile 用 `devDependencies` 的 `link:` 绝对路径解析到包目录，浏览器半经 `exports["./client"]` + `dsh.client` 投递。所以「插件放哪一层」纯粹是仓库布局选择，不需要动核心。
- **迁移安全设计 = 双根并集 + 嵌套优先**：`pluginRootsOf(repoRoot)` 在 `sub-plugins/` 存在时返回 `[<repo>/sub-plugins, <repo>]`；扫描取并集、按目录名去重、嵌套副本优先。因此「先改代码再移动目录」或反之都安全，半迁移状态可用，回滚 = 把目录移回。
- **行 id 与层级解耦是「零激活变更」的依据**：`rowIdOfDir` 只看目录名（去 `dsh-` 前缀），迁移无需新增/改名任何 profile 行，既有 `disabled` 与用户覆盖继续有效。
- **`link:` 陈旧必须修、不能信任**：目录移走后 profile 的 `link:` 仍指向旧绝对路径 → 包解析不到。新增纯函数 `staleLinkSpec(manifest, meta)` 比较现有 spec 与「当前目录应有的 spec」，`ensureDevDep` 把它当作需要修复的情形，复用既有「备份 → 改写 devDependencies → `pnpm install` → 失败回滚」。
- **宿主半代码改动只在 `dsh web` 重启后生效**：目录已移动 + 未重启的窗口里，旧代码只扫扁平根 → 面板短暂为空（插件本身仍正常加载）。迁移后必须提示重启。
- 面板新增 `pluginsRoot` 字段（与 `repoRoot` 不同时才显示一行），文案由「仓库根」改为「子插件目录（sub-plugins/）」。

## 验证命令

```bash
node dsh-plugin-manager/test/host-core.test.mjs   # 嵌套/双根/同名去重/staleLinkSpec 用例
node dsh-plugin-manager/test/bundle.test.mjs      # 头部 pluginsRoot 渲染断言
openspec validate --specs                          # plugin-manager 主 spec（change 已归档）
# 迁移后逐包验证解析 + 行不变：
cd ~/.dsh/profiles/web && node --input-type=module -e "await import('dsh-session-time-bucket')"
dsh --dump-config --profile web | grep -A1 'session-time-bucket'
```

## 真机验证（2026-09-10）

- 面板：设置 →「本地插件」列出 `sub-plugins/` 下 6 个子插件，全部「已激活」，头部显示仓库目录 + 子插件目录，无 legacy 横幅。
- 端点：`GET /__dsh-plugin-manager/status` 与 `/list` 均 200 且含 `pluginsRoot`；`legacyDetected=false`、`yamlError=null`；6 条记录均为 `state=active`、`installWhere=devDependencies`、`hasClient=true`。
- 解析：7 个包（含管理器）在 profile 内 `await import()` 全部 OK；软链真实路径指向 `sub-plugins/`。
- 状态不变：profile `cordis.patch.yml` 与迁移前备份逐字节一致；`dsh --dump-config --profile web` 的 6 行 id 原样。
- 宿主半代码改动必须重启 `dsh web` 才生效：本次即「移动目录 → 重链 → 重启」流程，重启前面板为空是预期现象。

## 未采用方案（记录理由，避免重复讨论）

- **伞包复活当安装点**（根 `dsh-local-plugins` 插 manager 行）：根 `cordis.patch.yml` 的 5 个旧 id 与 profile 中管理器维护的 5 行**同 id** → 启用即 `duplicate loader entry id`；且 bundle 层只在启动读一次，收益仅「安装路径改名」。**2026-09-10 后续：伞包已连同 6 个子插件的 `dsh.bundle` 声明一起删除（见 [2026-09-10-retire-bundle-install.md](2026-09-10-retire-bundle-install.md)），这条路径从此不可能再出现。**
- **把管理器移到仓库根**：`REPO_ROOT = path.resolve(src, '..', '..')` 等路径推导与全部文档路径都要重写，收益仅是安装点更短，是三个方案里改动面最大的。
- **`POST /relink` 端点 + 面板按钮**：改为「启用即自愈」，复用既有 UI 与回滚路径（理由见 change 的 `design.md` R3）。

## 相关文件

- 变更：`openspec/changes/archive/2026-09-10-move-plugins-to-sub-plugins/`（proposal / design / tasks / spec delta，已归档）；行为契约已并入 `openspec/specs/plugin-manager/spec.md`
- 代码：`dsh-plugin-manager/src/{host-core.js,index.js,client.js}`、`test/{host-core,bundle}.test.mjs`
- 文档：`dsh-plugin-manager/README.md`（目录布局节）、`dsh-plugin-manager/ACCEPTANCE.md`（A7）
