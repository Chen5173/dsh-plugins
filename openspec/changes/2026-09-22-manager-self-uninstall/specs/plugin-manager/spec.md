## ADDED Requirements

### Requirement: 自包含的一键卸载命令

系统 SHALL 提供一个**不依赖 DSH 宿主与 `dsh` CLI** 的卸载命令（随 `dsh-plugin-manager` 包分发的 Node 脚本），一次调用完成：解析目标 profile → 删除该 profile 中**全部受管子插件的激活行**（`cordis.patch.yml`）与**指向本仓库 `sub-plugins/` 的 `link:` 依赖键**（`package.json`）→ 删除 `dsh-plugin-manager` 自身的依赖键与其在 `dsh.profile.bundles` 中的条目 → 在 profile 目录执行**恰好一次** `pnpm install`。命令 MUST 在写文件前为两份文件各留一份带时间戳的备份（`*.bak-<ts>`），MUST NOT 删除任何源码目录，MUST NOT 触碰其它插件的激活行、依赖键或 bundles 条目。

命令 SHALL 支持**干跑**（只打印将删除的内容，不写文件、不安装）与**逐项结果输出**（删了哪些行/键、是否执行了安装、备份路径）。当没有可删除项时，命令 SHALL 是幂等 `noop`（不写文件、不安装、不报错）。

#### Scenario: 一条命令清空子插件并移除管理器

- **WHEN** 在一个装有管理器的 profile 上运行该卸载命令
- **THEN** 受管子插件的激活行与 `link:` 依赖键、管理器自身的依赖键、`dsh.profile.bundles` 中的管理器条目全部消失；`cordis.patch.yml` 与 `package.json` 各被写入一次、各留一份 `*.bak-<ts>`；`pnpm install` 恰好执行一次

#### Scenario: 干跑不动任何文件

- **WHEN** 用户带干跑参数运行该命令
- **THEN** 输出列出将删除的行、依赖键与是否会执行安装；两份文件逐字节不变、没有执行安装

#### Scenario: 其它插件与源码目录不受影响

- **WHEN** profile 中同时存在非本仓库插件的行（如 `mcp-*`、第三方插件）与其依赖键
- **THEN** 它们逐字节不变；本仓库各子插件的源码目录、以及被 `link:` 指向的任何开发 checkout 目录都仍然存在

#### Scenario: 重复执行是幂等 noop

- **WHEN** 对已经卸载过的 profile 再次运行该命令
- **THEN** 命令报告无可删除项，不写文件、不执行安装，退出码为成功

#### Scenario: 安装阶段失败时给出可收尾的降级路径

- **WHEN** 最后的 `pnpm install` 失败（例如 Windows 上删除脚本自身所在目录遇到 EBUSY/EPERM）
- **THEN** 命令如实报告失败原因，并打印"重跑一次 `pnpm install`"的收尾命令；此前的删除结果保持可用（用户重跑即可收尾），且不谎报成功

### Requirement: 面板提供复制卸载命令且不自动执行

管理器的设置面板 SHALL 提供一个「复制卸载命令」入口：按**当前 profile** 拼出可直接粘贴执行的那条命令（兼容两种装法：git 快照下脚本路径在 `node_modules/dsh-plugin-manager/dsh-plugin-manager/tools/` 下，本地 `link:` 装法下在仓库目录里），并在复制前展示**将删除什么**（受管子插件行数、依赖键数、是否会执行一次安装、以及"源码目录不会被删除"的说明）。该入口 MUST 只复制命令、MUST NOT 自动执行卸载，MUST 在剪贴板不可用时给出可手动复制的文本。

#### Scenario: 复制到的命令与将删除内容一致

- **WHEN** 用户点击「复制卸载命令」
- **THEN** 剪贴板得到一条指向当前 profile 的卸载命令，且面板同时显示"将删除 N 条激活行 / M 个依赖键 + 管理器自身，源码目录保留"

#### Scenario: 只复制不执行

- **WHEN** 用户点击该入口
- **THEN** 不写任何文件、不执行安装、不改变任何插件状态；卸载仍必须由用户在终端亲自运行那条命令

### Requirement: 卸载后 profile 状态可自证干净

卸载命令执行成功后，profile SHALL 处于"启动不需要任何本仓库子插件"的状态：不存在受管子插件的激活行、不存在指向本仓库 `sub-plugins/` 的 `link:` 依赖键、`dsh.profile.bundles` 中不含 `dsh-plugin-manager`。系统 SHALL 让这一点可核对（命令逐项列出清掉了什么，或在结束时输出可直接比对的文件路径与条目数）。

#### Scenario: 卸载后按文件自证

- **WHEN** 卸载命令成功结束
- **THEN** 输出或后续核对显示：`cordis.patch.yml` 中受管子插件行数为 0、`package.json` 中指向本仓库 `sub-plugins/` 的键数为 0、`dsh.profile.bundles` 不含管理器；随后启动 GUI host 不再出现 `failed to import loader entry` / `Cannot find package`
