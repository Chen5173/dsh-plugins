# DSH 插件：删除聚合伞包 + 子插件去 `dsh.bundle`（安装路径唯一化）

日期：2026-09-10 · 涉及：仓库根 `package.json`/`cordis.patch.yml`（已删除）、6 个 `sub-plugins/*/package.json` 与各自的 `cordis.patch.yml`（已删除）、`dsh-plugin-manager` 文档与根 `README.md`、OpenSpec change `retire-local-plugin-bundle-install`。

## 一句话

管理器模型下「子插件包自带 bundle 层」的唯一作用是**制造启动崩溃**：一旦有人用 CLI `dsh plugin add <子插件目录>`，reconcile 会因 `dsh.bundle` 声明把包塞进 `dsh.profile.bundles`，于是包自带 patch 与管理器维护的激活行**同 id 各插一次** → `dsh web` 起不来。因此把仓库根伞包与 6 个子插件的 `dsh.bundle` 声明一并删除，安装路径只剩「管理器面板」一条。

## 可复用结论（全部本机实测）

### 1. 「配置链坏了就起不来」的五种形态与真实报错

统一外层包装：`dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): …`，全部 exit 1。

| 构造 | 报错主体 |
|---|---|
| 行指向的包不存在 | `failed to import loader entry probe-a (@deepseek-ai/nonexistent-probe-xyz): Cannot find package …` |
| 两行、id **不同**、包都不存在 | `loader entries failed to apply`（AggregateError） |
| 两行、id **相同** | `duplicate loader entry id: <id>` |
| `dsh.profile.bundles` 里的包解析不到 | `cannot resolve profile bundle "X" …` |
| `dsh.profile.bundles` 里的包不再声明 `dsh.bundle` | `profile bundle "X" declares no dsh.bundle in its package.json` |

推论：**任何指向不存在包的激活行都会让启动失败**——这也是"卸载子插件只能用面板「移除」"的硬理由。

### 2. duplicate 闸门先于包解析 ⇒ 同 id 是**无条件**崩溃

`vendor/loader/src/config/group.ts:62-66` 在处理条目（真正 import/mount）**之前**先扫 id 去重并 `throw`；`vendor/include/src/index.ts:94` 的 `data.push(...insert)` 不做去重，同一份 flattened patch 列表里两个显式同 id 的 insert 都会进数组。对照实验：id 不同的两行只会报 AggregateError，不会报 duplicate —— 所以 **id 冲突与"包能不能解析"无关**。

### 3. `dsh.bundle` 声明 = 「会不会被 reconcile 塞进 bundles」的总开关

`apps/cli/src/plugin.ts` 的 `reconcilePlugins` 只看 `dependencies` 与 `dsh.profile.bundles`：`devDependencies` 永不扫描；声明了 `dsh.bundle` 的依赖进 bundles，没声明的打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 且只留在 `dependencies`。管理器 `ensureDevDep` 之后会把同名 `dependencies` 条目改写为 `devDependencies` 的 `link:`，所以**CLI 误装是可自愈的**（对比改造前：误装 = 启动崩溃）。

### 4. CLI 的 add / remove 都不能用来管子插件

- `dsh plugin --profile web add <子插件目录>`：装成普通依赖 + 警告，**不激活**。
- `dsh plugin --profile web remove <子插件包名>`：只摘依赖、**不删管理器写的激活行** → 悬空行 → 下次启动 `failed to import loader entry …`。卸载走面板「移除」（删行 + 摘依赖，源码目录保留）。

### 5. 隔离复现环境（推荐套路）

`DSH_HOME=<临时目录>` + 一个只含 `@deepseek-ai/dsh-base` 的 profile（`bundles` 不含 web app ⇒ 不会起服务器），用 `node <dsh>/apps/cli/lib/bin.js --profile <name>` 直接启动。注意：`--dump-config` **不挂载**条目，因此它证不了这类启动失败，必须真启动（成功时进程存活，用 `timeout` 收尾即可）。

### 6. 管理器扫描与 `dsh.bundle` 无关

`readPluginMeta` 只读 `name`/`description`/`main`/`exports`/`dsh.client`，不要求 `dsh.bundle` → 摘掉声明后 6 个子插件在面板里照常可见可管（全部测试通过）。

## 遗留观察

6 个子插件的 manifest 里带着 `publishConfig.access: public`（例如 `dsh-esc-rewind`），说明曾按"可独立发布"的形态准备过。若历史上真的 `npm publish` 过，外部使用者会从"能装能激活"变成"装成普通依赖 + 警告、不激活"。作者已确认这些插件只有自己在用；若日后要收尾，可对已发布版本做 `npm deprecate` 指向管理器模型。

## 相关文件

- 变更：`openspec/changes/retire-local-plugin-bundle-install/`（proposal / design(含全部实测表) / tasks / spec delta）
- 行为契约：`openspec/specs/plugin-manager/spec.md`「本地插件不提供 bundle 安装路径」
- 文档：根 `README.md`（「已删除：聚合伞包」+「⚠️ 这两条 CLI 命令不要用」）、`AGENTS.md`、6 个子插件的 README/ACCEPTANCE、`dsh-plugin-manager/README.md`
