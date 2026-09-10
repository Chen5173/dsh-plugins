## Why

管理器模型（子插件只作为 profile `devDependencies` 的 `link:` 被解析、激活行由管理器写在 profile `cordis.patch.yml`）落地后，仓库里仍留着两条**会把 `dsh web` 变成起不来**的路径，且都是实测复现过的：

- **子插件包自带的 bundle 层仍在**。6 个子插件的 `package.json` 都还声明着 `dsh.bundle.patch`、各自还带着 `cordis.patch.yml`。在**当前**模型下这份声明已经是**惰性**的（子插件不在 `dsh.profile.bundles` 里，所以包自带 patch 从不被合并），它唯一还在起的作用是：一旦有人按老文档执行 `dsh plugin --profile web add <子插件目录>`，`dsh plugin` 的 reconcile 会因为这个声明把包塞进 `dsh.profile.bundles`，于是包自带 patch 与管理器已写的激活行**同 id 各插一次**。
  实测（隔离 profile，真 bundle 层 + 真 profile 层，同 id `esc-rewind`）：
  `Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: esc-rewind` → **exit 1，启动失败**。
  `vendor/loader` 的 `EntryGroup.update` 在 `Promise.allSettled` 之前就扫重复 id 并抛错（`vendor/loader/src/config/group.ts:62-66`），而 `applyEntryPatches` 的 `data.push(...insert)` 不去重（`vendor/include/src/index.ts:94`）。
- **仓库根的退役伞包仍是可安装包**。`dsh-local-plugins`（根 `package.json` + 根 `cordis.patch.yml`）此前只是"标记 DEPRECATED"，而它的 5 个 row id 与管理器维护的行 id **完全相同**——谁再装一次，重现上面同一个崩溃。

此外第三条危险路径虽然不能靠本变更消除，但必须写进文档：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、**不会删管理器写的激活行**，于是留下指向不存在包的悬空行，下次启动报 `failed to import loader entry <id> (<name>): Cannot find package …`（同样实测 exit 1）。

## What Changes

- **删除退役伞包**：删掉仓库根 `package.json` 与根 `cordis.patch.yml`（`dsh-local-plugins` 彻底退场）。已核对：本机 4 个 profile（web/add/tui/dsh-tui）与 7 个 `package.json.bak-*` 备份**都没有**引用它，仓库根也没有 `node_modules`，所以删除不会让任何现有 profile 起不来。
- **子插件去 bundle 化**：6 个子插件 `package.json` 去掉 `dsh.bundle`、`files` 去掉 `cordis.patch.yml`，并删掉各自的包自带 `cordis.patch.yml`。这样 CLI 误装路径从「**崩溃**」降级为「装成普通依赖 + 打印 `declares no dsh.bundle …` 警告 + 不激活（管理器可随后接管）」。
- **文档全面同步**：根 `README.md`（安装模型、新增插件步骤、"已退役"→"已删除"）、6 个子插件的 `README.md`/`ACCEPTANCE.md`（安装/启停/卸载一律改为管理器面板路径，并写入两条 CLI 警示）、`dsh-plugin-manager/README.md` 与 `ACCEPTANCE.md`、`docs/knowledge/`（更新 2 篇旧结论 + 新增本篇变更记录）。

## Capabilities

### Added Capabilities

- `plugin-manager`：新增 Requirement「本地插件不提供 bundle 安装路径」——仓库 MUST NOT 再为本地子插件提供 bundle 层与聚合伞包，CLI 误装 MUST NOT 产生重复 loader entry id，卸载路径 MUST 唯一（面板「移除」）。

### Modified Capabilities

（无。现有 `plugin-manager` 的 requirements 都建立在"管理器的激活行是唯一真相源"上，与新模型一致；本变更是把仓库里残留的旧安装路径删干净，不改管理器行为。）

## Non-goals

- **不改管理器逻辑**：`planMigration` 里"profile 若仍带 `dsh-local-plugins` 条目则一并移除"的分支保留（对仍把伞包留在依赖清单里的 profile 仍是有效清理），不加新代码。
- **不改 DSH 核心**：不在 `dsh plugin` 的 reconcile 里加护栏（那属于核心行为，且"声明驱动 reconcile"本身是合理设计）。本变更只在插件仓库侧消除触发条件。
- **不改激活模型**：仍是「profile devDependencies `link:` + 管理器维护的 profile `cordis.patch.yml` 激活行」，行 id 规则不变。
- **不新增 GUI 功能**：CLI 误用 `remove` 造成的悬空行只能手工修（管理器无从介入——启动已经失败），本变更只用文档警示，不加运行时护栏。

## 成功判据

1. 仓库根不再存在可安装的伞包清单；`grep -rn dsh-local-plugins` 只命中历史文档与"为什么不能再引入"的说明。
2. 6 个子插件的 manifest 均不含 `dsh.bundle`，目录内不再有包自带 `cordis.patch.yml`。
3. 在隔离 profile 上把某个子插件目录 `dsh plugin --profile web add` 之后：`dsh.profile.bundles` 里**没有**该子插件、CLI 打印 `declares no dsh.bundle` 警告、激活行数量不变、`dsh web` 仍能正常启动。
4. 1–3 全部有命令输出为证；`openspec validate retire-local-plugin-bundle-install --strict` 通过；既有全部测试（管理器 3 + 子插件 7）仍通过。
