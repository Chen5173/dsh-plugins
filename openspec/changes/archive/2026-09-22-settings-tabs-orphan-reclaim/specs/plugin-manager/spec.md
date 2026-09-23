## MODIFIED Requirements

### Requirement: 设置入口与生效模型

系统 SHALL 在设置页左侧拥有**一个自有的一级入口「本地插件」**（注册 `settings.section`：id `local-plugins`，order 16，label「本地插件」），并由该入口**声明子槽 `settings.localPlugins.tab`（list）与渲染 tab chrome**；管理器自己的管理面板 MUST 是该入口内的一个 tab（id `plugins`，order 0），本仓库其它插件的设置面板 MUST 作为同一入口内的其它 tab 出现——设置左侧导航里本仓插件 MUST NOT 再各占一行，也 MUST NOT 把本仓内容混进核心「插件」页。面板 SHALL 展示目标 profile 名与仓库路径；tab 栏 SHALL 与核心「插件」页同款（当前 tab 有下划线指示，首次选中的 tab 挂载后保持挂载以便切换不丢本地草稿）。开关/移除/迁移后：宿主侧行为经 profile patch 热重载实时生效；对带浏览器客户端 UI 的子插件，MUST 提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。目标 profile 默认取当前 GUI 运行的 web profile，且 SHOULD 允许通过设置覆盖；目录定位优先用管理器自身所在目录的上一级，找不到时 MUST 给出可读错误而非静默空列表。当运行的核心没有声明 `settings.localPlugins.tab` 槽时，注册 MUST 被跳过且 MUST NOT 抛出未捕获错误。

#### Scenario: 入口出现在设置左侧导航

- **WHEN** 用户打开设置页
- **THEN** 左侧导航出现**「本地插件」一级入口**（核心「插件」入口保持原样）；进入后 tab 列表里第一个 tab 就是管理面板，点开即渲染；管理器不再占用其它导航行

#### Scenario: 客户端插件开关后提示手动刷新

- **WHEN** 用户启用或停用某个带客户端 UI 的子插件
- **THEN** 宿主行为即时变化，同时面板提示需要刷新页面使该插件的界面生效，并提供刷新按钮；页面不会被自动刷新

#### Scenario: 仓库目录不可达时给出错误

- **WHEN** 管理器无法定位/读取其所在仓库根（目录被移动或权限不足）
- **THEN** 面板显示可读错误与目标路径，而不是空白列表或崩溃

#### Scenario: 核心没有插件页 tab 槽时降级

- **WHEN** 运行的核心未声明 `settings.localPlugins.tab`（旧核心）
- **THEN** 注册被跳过、不产生未捕获错误，管理器的宿主侧能力与其它插件不受影响
