## Why

v1 的 `dsh-composer-provider-label` 只解决「看清当前路由」：标签是只读文本，切换提供方仍必须回到核心模型座位，而核心座位的模型列表只能全量展示。使用者要求两件事：**提供方也像模型一样可直接点选**，以及**模型列可切换「全部 / 仅当前提供方」**。这两件事都需要写路径（`session/selectModel`），因此插件从只读升级为「只读 + 唯一白名单写入」。

## What Changes

- **标签变成菜单入口**：`conversation.input.right` 里的标签由只读 `span` 改为按钮；hover/聚焦显示 `▾`，点击打开菜单（`@deepseek-ai/dsh-client-ui-primitives` 的 `Menu` 原语，原地渲染 `side=top`）。tooltip 保留并补上当前 effort。
- **两级可选菜单**：根层两行「提供方 / 模型」（各显示当前值 + `›`），每层顶部一行「‹ 返回」；点提供方立即写入并自动进入模型列表；模型选完关闭菜单。
- **提供方写入语义**：同 provider 且当前模型仍在该 provider 广告列表 → 保留当前模型；否则若 profile 默认模型属于该 provider 用默认、否则用该 provider 第一个模型。provider 不独立于 model，永远一起提交。
- **模型列显示范围**：footer 常驻「全部 / 仅当前提供方」两个互斥项（当前项打勾）；偏好存 localStorage `dsh.composer-provider-label.v1`，默认「全部」，不新增 settings 键。
- **列表内容与呈现**：提供方 = catalog `groups` + `failures`（catalog 顺序），失败项置灰并带失败副文本；当前路由的 provider 未广告时顶部合成一行「当前路由」。「全部」模式按 provider 分组（组标题 = 别名 + displayName）；「仅当前提供方」无组标题，空时显示空态 + 一键切回「全部」。行文案：提供方 = 别名 + displayName 副文本，模型 = 短名 + 完整 id 副文本，当前项打勾。
- **effort 继承**：新模型支持当前 effort 就保留，否则省略（落到 provider 默认）。
- **长列表高度**：模型或提供方较多时，菜单内容区限制在约五行高并内部滚动，底部显示范围开关常驻可见，不再把首行顶出屏幕。
- **容错**：catalog 加载中不渲染标签，失败时渲染错误态按钮（点开 = 重试加载）；菜单顶部在失败时加一行「重试加载」；写入中标签半透明 + `aria-busy`，失败时标签内联错误点 + tooltip 原因；子代理会话（`available=false`）菜单项禁用并说明原因；`Menu` 原语不可用时降级为 v1 只读标签。
- **写权限白名单**：能力审计从「零改状态 Remote」改为白名单 `session.selectModel`，其余改状态 API 仍禁止。
- **已知限制入档**：v1 的 `dsh-composer-provider-label.providerAliases` 在 `link:` 安装形态下实测失效（`ERR_MODULE_NOT_FOUND`，宿主内部包不在仓库祖先链上）→ 写入 README/ACCEPTANCE 已知限制，本次不修通道。

## Capabilities

### New Capabilities

- 无（全部行为落在既有 `composer-provider-label` 能力上）。

### Modified Capabilities

- `composer-provider-label`（`openspec/specs/composer-provider-label/spec.md`）：v1 的「只读标签」需求全部保留，新增「标签作为菜单入口」「提供方一级可选并写入」「模型列显示范围开关」「写入失败与不可用态」「写权限白名单」等需求。

## Impact

- **代码**：`dsh-composer-provider-label/src/client.js`（菜单/pane/footer/写入/容错/范围偏好；v1 的解析与别名能力复用）、`src/index.js`（不改，仍只声明 settings 段）。无新依赖（`Menu` 与 `Tooltip` 同包）。
- **测试**：`test/bundle.test.mjs` 扩到 ≥40 用例（写入调用与参数、provider 选模型规则、effort 继承、范围开关与持久化、禁用/失败/降级、审计白名单）。
- **文档**：`README.md`（安装/配置/已知限制/版本地板）、`ACCEPTANCE.md`（菜单与开关手工清单 + v1 遗留 6.1）。
- **运行时约定**：localStorage 新增键 `dsh.composer-provider-label.v1`（`{ scope: 'all' | 'provider' }`）。
- **版本地板**：不变，仍 ≥ `0.1.2-rc.1`（`session/modelCatalog`、`session/selectModel` 同属该版本已发布类型面）。
- **边界**：不动核心座位、不做 DOM 干预、不加搜索/方向键、不写 profile 默认（Host 会连带写，属核心行为）。
