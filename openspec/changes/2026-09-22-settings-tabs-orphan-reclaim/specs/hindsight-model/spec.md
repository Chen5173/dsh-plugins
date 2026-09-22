## MODIFIED Requirements

### Requirement: 设置页提供 Hindsight 模型面板

系统 SHALL 在设置页的**「插件」页**里以 tab 形式提供「Hindsight 模型」面板（贡献到核心 `ui-settings-plugins` 声明的 `settings.plugins.tab` 列表槽：id `hindsight-model`，order 30；MUST NOT 再注册独立的一级 `settings.section` 导航行），展示四层事实：① 权威配置文件（profile `.env`）的落盘值；② 运行中守护进程实际生效的值；③ 会覆盖权威文件的外层冲突源；④ 「是否已生效」的判据。当面板所依赖的宿主端点不可达时，面板 SHALL 渲染明确的不可用说明，MUST NOT 呈现空白面板、静默失败或未捕获的报错。当运行的核心没有声明 `settings.plugins.tab` 槽时，注册 MUST 被跳过且 MUST NOT 抛出未捕获错误。

#### Scenario: 打开设置页看到面板

- **WHEN** 用户打开设置页并进入「插件」，选中「Hindsight 模型」tab
- **THEN** 出现「Hindsight 模型」面板，且四层事实各自可见（不可得的那一层标为未知，见后续需求）

#### Scenario: 宿主端点不可达

- **WHEN** 面板加载时宿主端点不可达或返回错误
- **THEN** 面板显示明确的不可用说明（含失败原因），同时不抛出未捕获异常、不显示成“四层皆空”的假状态

#### Scenario: 核心没有插件页 tab 槽时降级

- **WHEN** 运行的核心未声明 `settings.plugins.tab`（旧核心）
- **THEN** 注册被跳过、不产生未捕获错误，插件的宿主侧端点与守护进程能力不受影响
