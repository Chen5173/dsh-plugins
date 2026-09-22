## MODIFIED Requirements

### Requirement: 设置入口与生效模型

系统 SHALL 在设置页的**「插件」页**里以 tab 形式呈现「本地插件」面板（贡献到核心 `ui-settings-plugins` 声明的 `settings.plugins.tab` 列表槽：id `local-plugins`，order 20），MUST NOT 再注册独立的一级 `settings.section` 导航行——设置左侧导航 MUST 只保留核心的「插件」一行，本面板与其它功能插件贡献的页面都作为该行内部的 tab。面板 SHALL 展示目标 profile 名与仓库路径。开关/移除/迁移后：宿主侧行为经 profile patch 热重载实时生效；对带浏览器客户端 UI 的子插件，MUST 提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。目标 profile 默认取当前 GUI 运行的 web profile，且 SHOULD 允许通过设置覆盖；目录定位优先用管理器自身所在目录的上一级，找不到时 MUST 给出可读错误而非静默空列表。当运行的核心没有声明 `settings.plugins.tab` 槽时，注册 MUST 被跳过且 MUST NOT 抛出未捕获错误。

#### Scenario: 入口出现在设置左侧导航

- **WHEN** 用户打开设置页
- **THEN** 左侧导航出现的是核心唯一的「插件」入口（不再有独立的「本地插件」导航行）；进入「插件」后 tab 列表里出现「本地插件」，点开即渲染面板

#### Scenario: 客户端插件开关后提示手动刷新

- **WHEN** 用户启用或停用某个带客户端 UI 的子插件
- **THEN** 宿主行为即时变化，同时面板提示需要刷新页面使该插件的界面生效，并提供刷新按钮；页面不会被自动刷新

#### Scenario: 仓库目录不可达时给出错误

- **WHEN** 管理器无法定位/读取其所在仓库根（目录被移动或权限不足）
- **THEN** 面板显示可读错误与目标路径，而不是空白列表或崩溃

#### Scenario: 核心没有插件页 tab 槽时降级

- **WHEN** 运行的核心未声明 `settings.plugins.tab`（旧核心）
- **THEN** 注册被跳过、不产生未捕获错误，管理器的宿主侧能力与其它插件不受影响
