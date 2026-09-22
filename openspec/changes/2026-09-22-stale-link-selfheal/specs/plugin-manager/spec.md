## MODIFIED Requirements

### Requirement: 启用缺失依赖的子插件时自动安装

系统 SHALL 在用户启用一个子插件时（单行「开启」与批量「全部开启」使用同一实现），先确保该包已可解析：需要时在目标 profile 目录写入 devDependency `link:<子插件实际所在绝对目录>`（仅加 devDependency，不加进 `dsh.profile.bundles`），并在需要时执行 `pnpm install`，安装成功后再写入激活行。**判定必须区分"键在不在"与"指向对不对"**：当 devDependency 已存在但 `link:` 指向的不是该子插件当前所在目录（目录已被移动、换机器/换 profile、安装入口变更等）时，系统 SHALL 把它视为需要修复并改写为当前目录，MUST NOT 因为"键已存在"而跳过修复、MUST NOT 直接信任旧路径。只有"键存在且指向当前实际目录"时才可以不写文件、不跑安装。安装或写行失败时，MUST NOT 出现“看似已启用”的半状态：面板给出可理解的错误并可重试，子插件保持原状态，profile `package.json` 由备份回滚。

#### Scenario: 启用未安装子插件自动装依赖

- **WHEN** 子插件根有一个从未安装的子插件，用户点击启用
- **THEN** 管理器自动将其加入 profile devDependencies 并安装，随后写入激活行，插件变为「已激活」

#### Scenario: 陈旧链接在启用时被修复

- **WHEN** profile devDependencies 中该子插件的 `link:` 指向旧目录（如移动前的仓库根路径），用户点击启用
- **THEN** 管理器把该 `link:` 改写为子插件当前所在目录并执行安装，随后写入激活行，插件变为「已激活」

#### Scenario: 陈旧链接在「全部开启」时也被修复

- **WHEN** 多个子插件的 `link:` 都已陈旧，用户点击「全部开启」
- **THEN** 管理器把它们的 `link:` 一次性全部改写为各自当前目录，只执行**一次** `pnpm install`，随后写入激活行

#### Scenario: 链接已正确时不写文件不安装

- **WHEN** devDependency 已存在且 `link:` 正指向该子插件当前所在目录，用户点击启用
- **THEN** 管理器不写 `package.json`、不跑 `pnpm install`，只写激活行

#### Scenario: 安装失败不产生半状态

- **WHEN** 对未安装子插件执行启用，但安装失败（如网络/磁盘/路径错误）
- **THEN** 面板显示失败错误卡片，子插件状态不变（仍可重试或取消），激活清单不被写入，profile `package.json` 回到改动前

#### Scenario: 安装不改变 bundles 列表

- **WHEN** 管理器为某子插件执行自动安装后运行 `dsh plugin --profile web install`（或其它 reconcile 触发）
- **THEN** `dsh.profile.bundles` 中本地插件仍只有管理器一个条目，子插件不会被重新塞进 bundles

## ADDED Requirements

### Requirement: 陈旧链接的自动检测是只读的

系统 SHALL 为每个受管子插件判定其 profile 依赖态之一：`absent`（无依赖键）、`fresh`（键存在且 `link:` 指向该子插件当前实际目录）、`stale-mismatch`（键存在、目标目录存在但不是当前实际目录）、`stale-target-missing`（键存在但目标目录不存在）。判定 SHALL 使用解析后的真实路径比较，并在大小写不敏感的文件系统（Windows/macOS 默认）上把仅大小写/分隔符差异视为 `fresh`。检测 SHALL 在宿主半加载时与面板每次拉取数据时各执行一次，MUST 是只读的：MUST NOT 因检测写 profile 文件、MUST NOT 因检测执行安装。判定结果 SHALL 随面板数据面暴露（每个插件带 `linkState`）。

#### Scenario: 检测出目标不存在的陈旧链接

- **WHEN** 某子插件的 `link:` 指向一个已不存在的目录
- **THEN** 该插件在面板数据里是 `linkState: 'stale-target-missing'`，且此过程没有写任何文件、没有执行安装

#### Scenario: 检测出指向别处的陈旧链接

- **WHEN** 某子插件的 `link:` 指向的目录存在，但不是它当前所在的目录
- **THEN** 该插件为 `linkState: 'stale-mismatch'`，并在数据里带上"声明指向 vs 当前实际目录"

#### Scenario: 仅大小写或分隔符差异不算陈旧

- **WHEN** `link:` 的写法与该子插件当前实际目录只在大小写或路径分隔符上不同（如 `D:/Repo/x` vs `D:\\Repo\\X`）
- **THEN** 判定为 `fresh`，不触发任何修复

#### Scenario: 检测不改环境

- **WHEN** 系统完成一次检测（无论结果如何）
- **THEN** profile 的 `package.json` 与 `cordis.patch.yml` 逐字节不变

### Requirement: 能确定就自动修，不确定只提示

系统 SHALL 在检测到陈旧项后自动修复**可确定**的那些：仅当该子插件在当前仓库中能唯一定位到实际目录、且自动重定位开关开启时，才改写其 `link:` 为当前目录，并在一次动作内为全部可修项只执行**一次** `pnpm install`，写文件前留下带时间戳的备份；任何失败 MUST 回滚到动作前状态且 MUST NOT 留半状态。**每次宿主启动最多自动执行一次**重定位动作。对 `stale-target-missing` 且当前仓库里找不到该插件实际目录、或存在多个候选的项，系统 MUST NOT 猜路径，MUST 只提示（不写文件、不安装）。自动重定位的结果（时间、处理了哪些条目、成功或失败原因）SHALL 在面板与诊断数据中可见。

#### Scenario: 可确定时自动重写并只安装一次

- **WHEN** 宿主半加载时检测到 2 个子插件的 `link:` 陈旧，且它们在当前仓库中都能唯一定位
- **THEN** 管理器改写这 2 条 `link:`、恰好执行一次 `pnpm install`、留下 `*.bak-<ts>` 备份，并在面板/诊断中记录本次自动重定位的条目与结果

#### Scenario: 确定不了的一律不猜

- **WHEN** 检测到某子插件的 `link:` 目标目录不存在，且当前仓库里没有它的实际目录
- **THEN** 不写任何文件、不执行安装，只在面板横幅中把它列入"需人工处理"，并说明原因

#### Scenario: 一次启动最多修一次

- **WHEN** 同一次宿主运行期间，面板被反复刷新并多次拉取数据
- **THEN** 自动重定位动作最多再次发生 0 次（该启动的额度已用尽），后续检测只读

#### Scenario: 开关关闭时只检测

- **WHEN** 用户在设置里关闭自动重定位开关，随后宿主重启并检测到可修项
- **THEN** 不写文件、不安装，只在面板显示横幅与可修项清单

#### Scenario: 自动修失败时回滚且不留半状态

- **WHEN** 自动重定位过程中写文件或安装失败
- **THEN** profile `package.json` 回滚到动作前内容，插件状态保持原样，面板与诊断给出失败原因，且该启动不再重试

### Requirement: 面板自检横幅与一键重定位

面板 SHALL 在存在陈旧链接时显示横幅：包含总数、逐条明细（插件名、`linkState`、声明指向与当前实际目录）以及"可自动修复"与"需人工处理"的分区；并提供「重定位」按钮，对全部可确定项执行与自动修复相同的动作（一次安装、写前备份、失败回滚）。不存在陈旧项时 MUST NOT 显示横幅、MUST NOT 写任何文件。按钮执行中与执行后 SHALL 明确呈现结果（处理条目、安装是否发生、失败原因）。

#### Scenario: 横幅列出可修与不可修

- **WHEN** 面板检测到 3 条陈旧项，其中 2 条可确定、1 条目标缺失
- **THEN** 横幅显示总数 3，可自动修复区列出 2 条并可直接点「重定位」，需人工处理区列出剩余 1 条及其原因

#### Scenario: 一键重定位只安装一次

- **WHEN** 用户点击「重定位」处理 2 条可修项
- **THEN** 两条 `link:` 被一次改写、`pnpm install` 恰好执行一次，成功后横幅消失

#### Scenario: 无陈旧项时零副作用

- **WHEN** 所有子插件的链接都正确，用户打开面板
- **THEN** 不显示横幅，且 profile 两份文件逐字节不变、没有执行任何安装
