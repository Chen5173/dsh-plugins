# plugin-manager Specification

## Purpose
在 DSH Web 设置页提供一个「本地插件」面板，让用户只安装 `dsh-plugin-manager` 一个插件即可管理本仓库（monorepo）内全部 `dsh-*` 子插件在 web profile 中的激活状态：列出子包与各自状态、一键激活/停用/移除、缺失依赖时自动安装、以及把旧的「逐个 dependencies+bundles」布局一键迁移为新模型。

## Requirements

### Requirement: 面板列出仓库子插件并推导状态

系统 SHALL 在设置页新增一级入口「本地插件」，列出管理器所在仓库的**子插件根**下的每一个 `dsh-*` 子包（排除管理器自身），并为每个子包显示：包名、目录名、`package.json` 描述，以及推导出的状态之一——`已激活`（profile 激活清单中存在且未 disabled，且包已在 profile 中可解析）、`已停用`（清单中存在但 disabled）、`未安装`（包未在 profile 依赖中，无法解析）、`非插件目录`（缺少有效插件 `package.json`）。扫描到的新子包（从未激活过）MUST 以「未安装/未激活」状态出现并可被用户激活。

子插件根 SHALL 依次取「仓库根下的 `sub-plugins/`（存在时）」与「仓库根自身（旧扁平布局）」两处，扫描结果 MUST NOT 因同名目录出现两行；同名时以 `sub-plugins/` 下的副本为准。面板头部 SHALL 显示仓库路径，并在子插件目录与仓库路径不同时同时显示子插件目录。

#### Scenario: 打开设置「本地插件」看到全部子包

- **WHEN** 用户安装管理器后打开设置页的「本地插件」入口，子插件根存在多个 `dsh-*` 子包
- **THEN** 面板列出全部子包（不含管理器自身），每个显示包名、目录名、描述与当前状态，状态与 profile 实际激活情况一致

#### Scenario: 子包位于 sub-plugins 子目录

- **WHEN** 子包位于 `<仓库>/sub-plugins/dsh-xxx`，仓库根没有同名的 `dsh-xxx`
- **THEN** 面板列出该子包，其目录信息指向 `sub-plugins/dsh-xxx`，状态推导与它位于仓库根时一致

#### Scenario: 半迁移仓库（部分子包仍在仓库根）

- **WHEN** 仓库中一部分子包已移动到 `sub-plugins/`，另一部分仍在仓库根
- **THEN** 面板同时列出两处的子包且状态正确，不因布局混合而漏项或报错

#### Scenario: 同名目录两处都存在

- **WHEN** `<仓库>/dsh-xxx` 与 `<仓库>/sub-plugins/dsh-xxx` 同时存在
- **THEN** 面板只列出一行，且该行指向 `sub-plugins/dsh-xxx`（嵌套副本优先）

#### Scenario: 从未安装过的子包显示为未激活

- **WHEN** 子插件根存在一个尚未被激活的 `dsh-*` 子包（不在 profile 依赖、激活清单无其行）
- **THEN** 面板将其显示为「未激活/未安装」并提供可用的「启用」操作

#### Scenario: 非插件目录被识别

- **WHEN** 子插件根存在名为 `dsh-*` 但缺少有效插件 `package.json` 的目录
- **THEN** 面板将其显示为「非插件目录」，不提供激活操作且不报错中断

#### Scenario: 管理器自身不列入

- **WHEN** 面板扫描子插件根
- **THEN** 管理器自己的目录 `dsh-plugin-manager` 不作为一个可管理的子插件出现

### Requirement: 主开关激活/停用子插件并持久化

系统 SHALL 为每个可管理子插件提供主开关：停用 = 在其激活行上写 `disabled`（保留行与现场，可再启用）；启用 = 移除 `disabled` 并确保行存在。激活状态 MUST 持久化为 profile `cordis.patch.yml` 中由管理器维护的行（稳定 id、`name`=子插件包名），DSH 对 profile patch 的实时热重载 MUST 让宿主侧即时启停；对带浏览器客户端 UI 的子插件，界面侧 MUST 经一次页面刷新进入/离开引导图。管理器 MUST 不触碰 `dsh-mcp-manager` 等其它插件的行。

#### Scenario: 停用已激活子插件

- **WHEN** 用户关闭某已激活子插件的主开关
- **THEN** 其激活行被写入 `disabled`，宿主行为实时停止；再次打开面板时状态为「已停用」，行与包依赖保留

#### Scenario: 重新启用已停用子插件

- **WHEN** 用户重新打开某已停用子插件的主开关
- **THEN** 其行的 `disabled` 被移除，宿主行为恢复；无需重装依赖

#### Scenario: 状态在重启后保持

- **WHEN** 用户停用某子插件后重启 DSH
- **THEN** 该子插件仍处于停用状态（面板与行为一致）

#### Scenario: 不动其它插件的行

- **WHEN** profile `cordis.patch.yml` 中已有 `dsh-mcp-manager` 等其它插件维护的行，用户对某个本地子插件执行开关
- **THEN** 其它行原样保留、内容不被破坏或改写

### Requirement: 启用缺失依赖的子插件时自动安装

系统 SHALL 在用户启用一个「未安装/未激活」的子插件时，先确保该包已可解析：需要时在目标 profile 目录写入 devDependency `link:<子插件实际所在绝对目录>`（仅加 devDependency，不加进 `dsh.profile.bundles`），并在需要时执行 `pnpm install`，安装成功后再写入激活行。当 devDependency 已存在但 `link:` 指向的不是该子插件当前所在目录（例如目录已被移动到 `sub-plugins/`）时，系统 SHALL 把它视为需要修复并改写为当前目录，而不是直接信任旧路径。安装或写行失败时，MUST NOT 出现“看似已启用”的半状态：面板给出可理解的错误并可重试，子插件保持原状态，profile `package.json` 由备份回滚。

#### Scenario: 启用未安装子插件自动装依赖

- **WHEN** 子插件根有一个从未安装的子插件，用户点击启用
- **THEN** 管理器自动将其加入 profile devDependencies 并安装，随后写入激活行，插件变为「已激活」

#### Scenario: 陈旧链接在启用时被修复

- **WHEN** profile devDependencies 中该子插件的 `link:` 指向旧目录（如移动前的仓库根路径），用户点击启用
- **THEN** 管理器把该 `link:` 改写为子插件当前所在目录并执行安装，随后写入激活行，插件变为「已激活」

#### Scenario: 安装失败不产生半状态

- **WHEN** 对未安装子插件执行启用，但安装失败（如网络/磁盘/路径错误）
- **THEN** 面板显示失败错误卡片，子插件状态不变（仍可重试或取消），激活清单不被写入，profile `package.json` 回到改动前

#### Scenario: 安装不改变 bundles 列表

- **WHEN** 管理器为某子插件执行自动安装后运行 `dsh plugin --profile web install`（或其它 reconcile 触发）
- **THEN** `dsh.profile.bundles` 中本地插件仍只有管理器一个条目，子插件不会被重新塞进 bundles

### Requirement: 移除子插件

系统 SHALL 为已管理的子插件提供次操作「移除」：删除其激活行并从 profile devDependencies 摘除该 `link:` 依赖（需要时执行移除安装）；移除后子插件回到「未激活/未安装」状态，后续可重新启用。

#### Scenario: 移除已激活子插件

- **WHEN** 用户对某已激活子插件执行移除
- **THEN** 其激活行被删除、devDependencies 中对应 `link:` 被摘除，插件不再加载；面板显示为未激活

#### Scenario: 移除后重新启用

- **WHEN** 某子插件被移除后，用户在面板再次启用它
- **THEN** 管理器重新安装依赖并写入激活行，行为与首次启用一致

### Requirement: 一键迁移旧布局

系统 SHALL 检测子插件仍以旧布局存在的情形：本地子插件列在 profile `dependencies` 且各自出现在 `dsh.profile.bundles`。此时面板 MUST 提供「一键接管/迁移」操作：把本地子插件从 `dependencies` 移到 `devDependencies`（保留 `link:` 与安装）、把 `dsh.profile.bundles` 的本地条目收敛为仅管理器、并按迁移前的实际激活状态（各 bundle 行是否 disabled/存在）补齐管理器维护的激活行，使迁移前后用户可见的激活集合不变。迁移须先备份 profile `package.json` 与 `cordis.patch.yml` 以便回滚。

#### Scenario: 检测到旧布局时给出迁移按钮

- **WHEN** profile 中本地子插件仍以 `dependencies` + 各自 `dsh.profile.bundles` 条目存在
- **THEN** 面板出现「一键接管/迁移」提示与按钮；迁移前不擅自改写 profile

#### Scenario: 迁移后激活集合不变

- **WHEN** 用户执行一键迁移，迁移前有 5 个子插件激活、1 个停用
- **THEN** 迁移后 `dsh.profile.bundles` 只剩管理器，5 个仍激活（以管理器维护行存在且未 disabled）、1 个仍停用，devDependencies 含全部本地子插件

#### Scenario: 迁移失败可回滚

- **WHEN** 迁移中途失败（如 pnpm 安装失败）
- **THEN** profile 的 `package.json`/`cordis.patch.yml` 可由管理器留下的备份恢复，迁移不产生半状态，面板给出错误

### Requirement: 设置入口与生效模型

系统 SHALL 在设置页把「本地插件」作为一级入口呈现（位于内置「插件」节之后），并展示目标 profile 名与仓库路径。开关/移除/迁移后：宿主侧行为经 profile patch 热重载实时生效；对带浏览器客户端 UI 的子插件，MUST 提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。目标 profile 默认取当前 GUI 运行的 web profile，且 SHOULD 允许通过设置覆盖；目录定位优先用管理器自身所在目录的上一级，找不到时 MUST 给出可读错误而非静默空列表。

#### Scenario: 入口出现在设置左侧导航

- **WHEN** 用户打开设置页
- **THEN** 左侧导航出现「本地插件」一级入口（在「插件」之后），点开即渲染面板

#### Scenario: 客户端插件开关后提示手动刷新

- **WHEN** 用户启用或停用某个带客户端 UI 的子插件
- **THEN** 宿主行为即时变化，同时面板提示需要刷新页面使该插件的界面生效，并提供刷新按钮；页面不会被自动刷新

#### Scenario: 仓库目录不可达时给出错误

- **WHEN** 管理器无法定位/读取其所在仓库根（目录被移动或权限不足）
- **THEN** 面板显示可读错误与目标路径，而不是空白列表或崩溃

### Requirement: 子插件目录布局与行 id 稳定性

系统 SHALL 支持把子插件包放在仓库根或 `sub-plugins/` 子目录下，且两种布局下同一子插件的**激活行 id 保持不变**（行 id = 目录名去掉 `dsh-` 前缀，与目录所在层级无关）。因此在布局迁移前后，profile `cordis.patch.yml` 中既有的行、`disabled` 状态与用户覆盖 MUST 继续保持有效，无需改写行 id。

#### Scenario: 迁移布局不改变行 id

- **WHEN** 某个子插件从仓库根移动到 `sub-plugins/`（或反向移动）
- **THEN** 它在 profile 激活清单中的行 id、`disabled` 状态与所在条件保持不变，不需要新增/重命名任何行

#### Scenario: 迁移可任意顺序完成

- **WHEN** 先更新管理器代码再移动目录，或先移动目录再更新代码
- **THEN** 两种顺序下管理器都能枚举到同一组子插件（双根并集），不出现“子插件全部消失”的中间态

#### Scenario: 目录移回即可回滚

- **WHEN** 用户把 `sub-plugins/` 下的子包移回仓库根
- **THEN** 管理器仍能枚举它们，行 id 与状态不变，无需改代码或改 profile 行
