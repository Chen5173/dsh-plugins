## ADDED Requirements

### Requirement: 仓库根安装外壳让 git 地址可直接安装

仓库 MUST 能被 `dsh plugin --profile <name> add <git 地址>`（`git+https://`、`github:` 简写、`git+ssh://`）与 `add <仓库根路径>` 两种入口安装，且安装后的插件身份 MUST 是 `dsh-plugin-manager`。为此仓库根 MUST 提供一个**安装外壳** `package.json`，且 MUST 满足：`name` = `dsh-plugin-manager`（pnpm 安装 git 依赖时把 clone 的**根目录当作包**，包名即 profile `dependencies` 键、bundle 层名、激活行 id 与浏览器模块表 id）；`private: true`；`type: module`；`main` 与 `exports["."]` 指向 `dsh-plugin-manager/src/index.js`；`exports["./client"]` 指向 `dsh-plugin-manager/src/client.js`；`dsh.client` 与包内清单逐字段一致；`dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`。外壳 MUST NOT 声明任何 `dependencies`/`devDependencies`/`optionalDependencies`，MUST NOT 设 `files` 白名单（那会把 `sub-plugins/` 从安装内容里裁掉），MUST NOT 自带激活行。这些约束 MUST 由 `dsh-plugin-manager/test/root-install-shell.test.mjs` 强制。

安装后的 clone MUST 保持管理器现有的仓库定位方式可用：宿主半从 `<安装目录>/dsh-plugin-manager/src` 反推出的仓库根即该安装目录，扫描到的子插件集合与直接在仓库里跑时一致；用户在面板启用某个子插件时，管理器写入的 `link:` 指向 clone 内的子插件目录且 MUST 能被 profile 解析。

文档 MUST 写明 git 安装得到的是**快照而非活链接**（改仓库源码不即时生效，升级走 `dsh plugin --profile <name> update`），以及缺少该外壳时的真实后果（包名退化为仓库目录名、被判成普通依赖、永不激活）。

#### Scenario: 用 git 地址安装后插件名是 dsh-plugin-manager

- **WHEN** 在一个干净 profile 上执行 `dsh plugin --profile <name> add git+https://…/dsh-plugins.git`
- **THEN** profile `dependencies` 只多出 `dsh-plugin-manager` 一个键（值是该 git 地址），`dsh.profile.bundles` 只多出 `dsh-plugin-manager` 一层，启动组合出 `- id: dsh-plugin-manager`，且不出现 `duplicate loader entry id`

#### Scenario: 换安装入口不产生第二个 bundle 层

- **WHEN** profile 已用 `link:`（或仓库根路径）装了管理器，用户改用 git 地址再 `add` 一次
- **THEN** 同一个 `dsh-plugin-manager` 依赖键被改写为新地址，`dsh.profile.bundles` 仍只有一个 `dsh-plugin-manager` 条目，激活行数量不变

#### Scenario: 从 git 装的 clone 仍能管理其子插件

- **WHEN** 通过 git 地址装好管理器后，用户在面板启用某个子插件
- **THEN** 管理器把指向 clone 内 `sub-plugins/<pkg>` 的 `link:` 写进 profile `devDependencies` 并完成安装，该子插件变为「已激活」，profile 能解析到它的入口

#### Scenario: 外壳被改动时测试判红

- **WHEN** 有人改掉外壳的 `name`、删掉某个转发（`main`/`exports`/`dsh.client`/`dsh.bundle.patch`）、给它加依赖、加 `files` 白名单，或在仓库根新增 `cordis.patch.yml`
- **THEN** `dsh-plugin-manager/test/root-install-shell.test.mjs` 失败

## MODIFIED Requirements

### Requirement: 本地插件不提供 bundle 安装路径

本仓库 MUST NOT 为本地子插件提供 bundle 层：`sub-plugins/` 下每个子插件的 `package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 存在包自带的 `cordis.patch.yml`。仓库根 MUST NOT 提供聚合伞包清单，也 MUST NOT 存在根 `cordis.patch.yml`；仓库根**唯一允许**的清单是管理器的**安装外壳**（见「仓库根安装外壳让 git 地址可直接安装」），该外壳 MUST NOT 列出任何子插件依赖或子插件激活行。据此，`dsh plugin --profile <name> add <子插件目录>` 这一路径 MUST NOT 让子插件进入 `dsh.profile.bundles`、MUST NOT 产生与管理器激活行重复的 loader entry id（否则 `dsh web` 启动会因 `duplicate loader entry id` 直接失败）；该路径的可见后果 SHALL 限于"装成普通 profile 依赖 + 打印 `declares no dsh.bundle` 警告 + 不激活"，且 MUST 不影响已有激活行，管理器 SHALL 仍能在启用时接管该包（把同名依赖改写为 `devDependencies` 的 `link:`）。卸载子插件的唯一受支持路径 SHALL 是管理器面板的「移除」；文档 MUST 明确警示 `dsh plugin --profile <name> remove <子插件包名>` 只摘依赖而不删管理器写的激活行，会留下指向不存在包的悬空行并使下次启动失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。

#### Scenario: 子插件包不自带 bundle 层

- **WHEN** 检查 `sub-plugins/` 下每个子插件的 manifest 与目录内容
- **THEN** 没有任何 manifest 声明 `dsh.bundle`，目录内也不存在包自带的 `cordis.patch.yml`

#### Scenario: 仓库根不再提供聚合伞包

- **WHEN** 检查仓库根的清单内容
- **THEN** 根 `cordis.patch.yml` 不存在，根 `package.json`（若有）只是管理器安装外壳：不列子插件依赖、不列子插件激活行、`dsh.profile.bundles` 不由它提供，`dsh-local-plugins` 不再是一个可被 `dsh plugin add` 装进 profile 的包

#### Scenario: CLI 误装只装成普通依赖且不激活

- **WHEN** 在某个 profile 上执行 `dsh plugin --profile <name> add <某子插件目录>`
- **THEN** 该包进入 profile `dependencies` 而**不进入** `dsh.profile.bundles`，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告，管理器维护的激活行数量与内容不变，且该 profile 仍能正常启动（不出现 `duplicate loader entry id`）

#### Scenario: 卸载路径唯一且在文档中被明确警示

- **WHEN** 用户想卸载某个子插件
- **THEN** 文档指示的唯一路径是管理器面板「移除」（删激活行 + 摘依赖，仓库源码目录保留）；同时明确写出用 `dsh plugin --profile <name> remove <子插件包名>` 的后果是留下悬空激活行、导致下次启动报 `failed to import loader entry …: Cannot find package …`
