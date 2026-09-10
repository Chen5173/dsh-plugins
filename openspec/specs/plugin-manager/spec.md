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

系统 SHALL 为每个可管理子插件提供主开关：停用 = 在其激活行上写 `disabled`（保留行与现场，可再启用）；启用 = 移除 `disabled` 并确保行存在。激活状态 MUST 持久化为 profile `cordis.patch.yml` 中由管理器维护的行（稳定 id、`name`=子插件包名），DSH 对 profile patch 的实时热重载 MUST 让宿主侧即时启停；对带浏览器客户端 UI 的子插件，界面侧 MUST 经一次页面刷新进入/离开引导图。管理器 MUST 不触碰 `dsh-mcp-manager` 等其它插件的行。对主开关请求的持久化 SHALL 在短窗口内合并（见「开关写入合并与重应用可见性」）：面板 MUST 在用户点击后立即按目标状态呈现该行，而行的落盘可以在合并窗口后完成。

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

#### Scenario: 开关目标状态立即呈现

- **WHEN** 用户点击某子插件的主开关
- **THEN** 该行在他看到响应时已经处于目标状态（面板不显示中间态等待落盘），行的落盘可在其后完成

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

### Requirement: 开关写入合并与重应用可见性

系统 SHALL 把短时间内的多次主开关请求合并为一次 profile `cordis.patch.yml` 写入（默认 400 ms 合并窗口），使 N 次点击最多只触发一次 DSH 核心的配置重应用；窗口内对同一行的再次请求 SHALL 覆盖该行的待写意图，MUST NOT 产生多次写入。合并后的落盘 SHALL 以磁盘当前内容为基础再套用待写意图，MUST NOT 用陈旧副本覆盖其它写入者的改动。`/__dsh-plugin-manager/status` SHALL 暴露未落盘的待写数量，面板 SHALL 在「仍有未落盘变更」或「宿主未恢复响应」期间显示「正在应用」提示，并在两者都消解后自动撤下，MUST NOT 要求用户手动刷新。合并落盘失败时系统 MUST 让失败可见（面板提示与诊断字段），并使后续列表以磁盘真实状态为准，MUST NOT 静默丢弃意图。宿主进程正常退出时，仍待写的意图 SHALL 被尽力落盘。

#### Scenario: 连点多个开关只写一次文件

- **WHEN** 用户在合并窗口内对两个不同子插件各发出一次开关请求
- **THEN** profile `cordis.patch.yml` 只被写入一次，DSH 核心只发生一次配置重应用，两行最终都等于用户的目标状态

#### Scenario: 同一行重复点击合并为一次写入

- **WHEN** 用户在合并窗口内对同一子插件连续切换两次（例如关再开）
- **THEN** 只有最后一次的目标状态被写入，文件不出现该行的中间状态

#### Scenario: 面板显示正在应用并在宿主恢复后自动消失

- **WHEN** 用户点击开关，落盘与随后的核心配置重应用开始
- **THEN** 面板显示「正在应用」提示；当待写数量归零且宿主恢复响应后，提示自动撤下，无需用户操作

#### Scenario: 合并窗口内仍可继续操作

- **WHEN** 面板正在显示「正在应用」，用户去点另一个子插件的开关
- **THEN** 该操作被接受并并入同一次待写意图（不因提示而被拒绝），且不额外增加一次核心配置重应用

#### Scenario: 落盘失败不静默

- **WHEN** 合并后的写入失败（例如 patch 文件不可写）
- **THEN** 面板显示错误，诊断字段记录失败原因，后续列表返回磁盘上的真实状态（不呈现「看似已生效」的假状态）

#### Scenario: 退出时尽力落盘

- **WHEN** 宿主进程在合并窗口尚未结束时正常退出
- **THEN** 尚未落盘的意图被尽力写入 patch 文件；无法写入时保留磁盘原状，不产生半个文件或损坏的 YAML

### Requirement: 本地插件不提供 bundle 安装路径

本仓库 MUST NOT 为本地子插件提供 bundle 层：`sub-plugins/` 下每个子插件的 `package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 存在包自带的 `cordis.patch.yml`。仓库根 MUST NOT 再提供聚合伞包清单（无根 `package.json`、无根 `cordis.patch.yml`）。据此，`dsh plugin --profile <name> add <子插件目录>` 这一路径 MUST NOT 让子插件进入 `dsh.profile.bundles`、MUST NOT 产生与管理器激活行重复的 loader entry id（否则 `dsh web` 启动会因 `duplicate loader entry id` 直接失败）；该路径的可见后果 SHALL 限于"装成普通 profile 依赖 + 打印 `declares no dsh.bundle` 警告 + 不激活"，且 MUST 不影响已有激活行，管理器 SHALL 仍能在启用时接管该包（把同名依赖改写为 `devDependencies` 的 `link:`）。卸载子插件的唯一受支持路径 SHALL 是管理器面板的「移除」；文档 MUST 明确警示 `dsh plugin --profile <name> remove <子插件包名>` 只摘依赖而不删管理器写的激活行，会留下指向不存在包的悬空行并使下次启动失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。

#### Scenario: 子插件包不自带 bundle 层

- **WHEN** 检查 `sub-plugins/` 下每个子插件的 manifest 与目录内容
- **THEN** 没有任何 manifest 声明 `dsh.bundle`，目录内也不存在包自带的 `cordis.patch.yml`

#### Scenario: 仓库根不再提供聚合伞包

- **WHEN** 检查仓库根是否存在可安装的伞包清单
- **THEN** 根 `package.json` 与根 `cordis.patch.yml` 都不存在，`dsh-local-plugins` 不再是一个可被 `dsh plugin add` 装进 profile 的包

#### Scenario: CLI 误装只装成普通依赖且不激活

- **WHEN** 在某个 profile 上执行 `dsh plugin --profile <name> add <某子插件目录>`
- **THEN** 该包进入 profile `dependencies` 而**不进入** `dsh.profile.bundles`，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告，管理器维护的激活行数量与内容不变，且该 profile 仍能正常启动（不出现 `duplicate loader entry id`）

#### Scenario: 卸载路径唯一且在文档中被明确警示

- **WHEN** 用户想卸载某个子插件
- **THEN** 文档指示的唯一路径是管理器面板「移除」（删激活行 + 摘依赖，仓库源码目录保留）；同时明确写出用 `dsh plugin --profile <name> remove <子插件包名>` 的后果是留下悬空激活行、导致下次启动报 `failed to import loader entry …: Cannot find package …`

### Requirement: 批量全部开启 / 全部关闭的作用范围与计数口径

面板 SHALL 提供两个批量动作「全部开启」与「全部关闭」，每个按钮 SHALL 显示本步可作用数量 N（例如「全部关闭 (6)」），N 为 **0** 时该按钮 MUST 置灰不可点。批量的作用域 MUST 限于面板列出的受管仓库子插件（管理器自身除外），MUST NOT 改动 profile 激活清单中其它插件的行（如 `mcp-*`、其它非本仓库插件）。

批量目标按子插件状态收敛：

- **全部开启** SHALL 作用于 `已停用`（去掉行内 `disabled`）与 `未安装`（补 `link:` devDependency、装依赖、写激活行）；MUST 跳过 `已激活`、`未激活(仅依赖)`、`旧布局`、`非插件目录`。
- **全部关闭** SHALL 作用于 `已激活`（写 `disabled: true`，保留行与依赖）；MUST 跳过 `已停用`、`未激活(仅依赖)`、`未安装`、`旧布局`、`非插件目录`——系统 MUST NOT 为从未启用过的子插件新增激活行。

N SHALL 等于上述「真能改动」的项数：`全部开启` 的 N = 已停用 + 未安装；`全部关闭` 的 N = 已激活。被跳过的项（`未激活(仅依赖)`、`旧布局`、`非插件目录`）MUST NOT 计入 N，且当存在 `旧布局` 项时面板 MUST 提示用户先执行「一键接管/迁移」。

#### Scenario: 全部关闭停用所有已激活子插件

- **WHEN** 面板列出 6 个全部 `已激活` 的子插件，用户点「全部关闭」并确认
- **THEN** 6 个子插件的激活行都被写入 `disabled: true`（行与 devDependency 保留），宿主行为全部停止，面板显示全部「已停用」

#### Scenario: 全部开启补齐已停用与未安装

- **WHEN** 面板现状为 3 个已停用、1 个从未安装、2 个已激活，用户点「全部开启」并确认
- **THEN** 3 个已停用的行去掉 `disabled`、1 个未安装的补上 devDependency 与激活行、2 个已激活的不变，最终全部为「已激活」

#### Scenario: 未激活(仅依赖)在批量中被跳过

- **WHEN** 某子插件已装为 profile `devDependencies` 但没有激活行（面板显示「未激活(仅依赖)」），用户执行「全部开启」或「全部关闭」
- **THEN** 该子插件状态不变（不新增行、不写 `disabled`），也不计入按钮的可作用数量 N

#### Scenario: 非插件目录不计入数量

- **WHEN** 受管目录中存在缺少有效插件 `package.json` 的 `dsh-*` 目录
- **THEN** 它不计入两个批量按钮的 N，批量执行不影响它，也不报错中断整批

#### Scenario: 不触碰其它插件的行

- **WHEN** profile 激活清单中另有 `mcp-*`、其它非本仓库插件等行，用户执行任意批量动作
- **THEN** 这些行的内容与顺序原样保留，仅受管子插件的行被改写，且 `dsh.profile.bundles` 不被改动

### Requirement: 批量执行一次落盘、一次安装

一次批量动作 SHALL 至多产生一次 profile `cordis.patch.yml` 写入（因而至多一次 DSH 核心配置重应用），MUST NOT 按项各写一次；当批量需要为多个 `未安装` 子插件补依赖时 SHALL 先把全部缺失的 `link:` devDependency 写齐，再执行**一次** `pnpm install`，MUST NOT 逐项安装。批量开始前系统 SHALL 接管仍在合并窗口中的单行开关意图，把它们与批量目标合并进**同一次** `cordis.patch.yml` 写入（既不静默丢弃先前的点击，也不额外产生第二次写入），并基于「这些意图已生效」的状态计算批量目标。

#### Scenario: N 项批量只写一次文件

- **WHEN** 用户点击「全部关闭」，受影响子插件为 N 个
- **THEN** profile `cordis.patch.yml` 只被写入一次，所有 N 行在同一次写入中落盘，DSH 核心只发生一次配置重应用

#### Scenario: 多个未安装项一次安装

- **WHEN** 「全部开启」遇到 3 个未安装的子插件
- **THEN** 管理器一次写齐 3 个 `link:` devDependency 后执行一次 `pnpm install`，成功则 3 个都被激活；MUST NOT 执行 3 次安装

#### Scenario: 排队中的单行意图先被兑现

- **WHEN** 用户刚点了某行开关（意图仍在 400 ms 合并窗口中），随即点击「全部关闭」
- **THEN** 该排队意图与批量目标落在同一次文件写入里（不额外多写一次），批量按「该意图已生效」的状态计算，最终状态等于「批量关闭」的语义，不出现被吞掉的中间态

### Requirement: 批量失败逐项回报且不产生半状态

批量执行 SHALL 采用尽力而为语义：能改动的项照常落盘，失败项 MUST 保持原状态（不出现「看似已启用/已停用」的假状态），并在响应中逐项给出结果与原因，面板 MUST 把这些失败项逐条呈现给用户以便重试。批量中的依赖安装失败 MUST NOT 阻止已安装项的开关落盘。

#### Scenario: 安装失败时已安装项仍照批

- **WHEN** 「全部开启」中部分子插件需要安装依赖而 `pnpm install` 失败
- **THEN** 这些未安装项被逐条报告为失败（原因可见、状态不变、可重试），而其余已安装子插件仍被正常开启

#### Scenario: 失败项在面板上逐条可见

- **WHEN** 批量结束后有 k 项失败
- **THEN** 面板提示条逐条列出失败子插件与失败原因，而不是只给一个失败总数

#### Scenario: 全批失败时状态与磁盘一致

- **WHEN** 批量过程中 patch 文件写入失败
- **THEN** 面板与诊断报出错误原因，后续列表返回磁盘上的真实状态，子插件保持操作前的状态

### Requirement: 批量操作的面板交互与生效提示

两个批量按钮 SHALL 在执行前请求用户确认，确认文案 MUST 包含将影响的数量，并在存在被跳过项（旧布局）时说明。批量执行期间面板 SHALL 锁住每行的开关/移除与「一键接管/迁移」并显示进行中提示，批量结束（含落盘与应用窗口消解）后 MUST 解锁。批量若改动了任何带浏览器界面的子插件，MUST 沿用既有约定提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。

#### Scenario: 确认文案带数量

- **WHEN** 用户点击「全部关闭 (6)」
- **THEN** 弹出确认框，文案包含数量 6（以及「跳过 N 个旧布局插件，请先迁移」之类的说明，若适用）；取消则不改动任何状态

#### Scenario: 批量执行期间锁定面板

- **WHEN** 批量正在执行（可能正在跑 `pnpm install`）
- **THEN** 每行的开关/移除与「一键接管/迁移」不可点，面板显示进行中提示；批量结束后恢复可点

#### Scenario: 批量完成后提示刷新界面

- **WHEN** 批量改动中包含带客户端 UI 的子插件
- **THEN** 面板提示需要刷新页面使这些子插件的界面生效，并提供刷新按钮；页面不会被自动刷新
