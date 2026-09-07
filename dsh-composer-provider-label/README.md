# dsh-composer-provider-label

在 DSH Web GUI 的 composer（输入框）里，模型选择器左边加一枚**只读 provider 标签**：把「下一次请求实际会打到哪个提供方」直接说清楚，让同一模型名下的多条路由可以区分。

例如同一台机器上 `deepseek-v4-flash` 同时挂在 ark、codemaker、bai、openroputer 四家时，输入区原本只显示 `DeepSeek-V4-Flash · high`，装了这个插件后读作：

```
office · DeepSeek-V4-Flash · high
```

纯客户端插件 + 一个可选的宿主设置段。不遮蔽核心的模型选择器、不做 DOM 注入、不注册模型工具、不新增宿主端点（node 半唯一的动作是声明一个 settings 段，且失败时静默跳过）。

## 为什么需要它

核心的模型选择器只显示**模型名**（`ModelSelect` 触发器文案是 `model.name · 推理档`；只有模型不在目录里才退回 `provider/model`）。而同一模型名可以同时来自多个提供方——它们各自的计费、限流、上下文窗口与可用性都不同，只显示模型名根本看不出打的是哪条线。核心其实早就具备全部所需数据（会话的 `modelSelection` 投影 + 宿主的 `session/modelCatalog`），缺的只是一个把 provider 说出来的触点。

## 安装

```bash
dsh plugin --profile web add ./dsh-composer-provider-label
# 或发布后：
dsh plugin --profile web add dsh-composer-provider-label
```

然后重启 `dsh web`。安装会写入 profile `package.json` 的 `dsh.profile.bundles`，并应用插件自带的 `cordis.patch.yml`（一行 `insert`，行 id `composer-provider-label` 稳定，重复 add 不会产生第二条）。

**版本要求**：需要核心 **≥ 0.1.2-rc.1**。`session/modelCatalog` 与 `modelSelection` 投影都自 `0.1.2-alpha.1` 起才有（槽位 `conversation.input.right` 本身 0.1.0-rc.7 就有）。版本不够时标签**自动不出现**，不报错。

## 标签在哪

composer 工具行右侧组、**模型选择器左边一格**：`[…] [provider] [DeepSeek-V4-Flash · high] [上下文] [发送]`。

## 名字从哪来（优先级）

1. **settings 里的别名**：`dsh-composer-provider-label.providerAliases` 中用户写的短名；
2. **内置表**：只预置 `deepseek-official → office`（官方 provider 的注册显示名硬编码为 `DeepSeek`，太泛，所以内置一个覆盖）；
3. **注册显示名**（目录里 `group.name`，即 settings 里该 provider 的 `displayName`），**剪掉尾部括号段**——`ARK (Coding Plan)` 显示为 `ARK`，完整名留在 tooltip；
4. 都拿不到 → 显示 provider **id**（如 `codemaker` 没配 displayName 时就是 `codemaker`）。

想给某个 provider 起短名，在 `settings.yaml`（或设置页）里写：

```yaml
dsh-composer-provider-label:
  providerAliases:
    codemaker: cm        # 自定义
    deepseek-official: DeepSeek  # 改掉内置的 office
```

> 注：`providerAliases` 与内置表按**键级合并**——内置的 `office` 仍然存在，你写的条目覆盖同名项；想整体换风格就把 `deepseek-official` 映射成别的词即可。没有 displayName 的 provider（如 `codemaker`）也可以直接在它自己的 settings 段补 `displayName`，插件会自动用上（那时第 3 条生效）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 会话已显式选模型 | 标签显示该路由的 provider，tooltip 标注「本会话显式选择」 |
| 切换模型到另一 provider | 不刷新页面即时跟随（订阅 `modelSelection` 投影） |
| 会话从未选过模型 | 显示解析后的 **profile 默认**路由的 provider，tooltip 标注「跟随 profile 默认」 |
| 切换会话 / 子代理会话 | 跟随当前会话，无需刷新 |
| 改了某 provider 的 displayName 或别名 | 不刷新页面即变（监听 `settings/document-updated`） |
| provider 不在目录里 / 目录还没拉到 | 显示 provider id（降级，不消失） |
| 宿主重连 | 丢弃旧目录缓存按新一代重解析 |
| 无会话（欢迎态） | 槽位本就不渲染 |
| 悬停/聚焦标签 | tooltip：provider 完整名 · 模型 id · 路由来源 |
| 点击标签 | 无任何副作用（只读） |

tooltip 文案跟随客户端语言（zh/en）；标签文本是 provider 名字，不翻译。外观只用 `--dsw-*` 主题变量，深色/浅色主题均可读；窗口过窄时 provider 以省略号截断，不挤模型名与上下文用量。

## 设计约束

- **注册在空槽位，不碰核心**：`conversation.input.right`（list / session，`replaceRisk: none`，位置紧邻模型选择器左侧）。`conversation.input.model` 是 single 槽、被核心 `ModelSelect` 占住——遮蔽它等于重写整个两级菜单，不做；DOM 注入改触发器文本没有稳定锚点，也不做。
- **与核心同一条路由规则**：生效路由 = `projection.next ?? catalog.default`（核心 `ModelDirectory.current` 也是这条），标签与模型名**永远不可能对不上**。
- **数据全部公开契约**：`useProjection('modelSelection')`（槽位标准 props）+ `remote.session.modelCatalog()`（按 host 代际缓存，监听 `llm/adapters-updated`、`settings/document-updated`、`connection/reset` 三个信号刷新——与核心目录同款）。
- **只读**：不调用任何会改状态的 Remote（测试里有能力审计：`selectModel`/`prompt`/`rename`/`fork`/… 一个都不许引用），不写 settings（只 `describe()` 读），不写会话日志。
- **宿主依赖可缺失**：node 半经动态 import 加载 `@deepseek-ai/schemastery` 来注册 settings 段；导入失败/无 settings 服务时**静默跳过**，标签仍按内置表工作。别名配置在本地 `link:` 开发形态下可能解析不到该依赖——见下节说明。

## 卸载 / 回滚

```yaml
# 方式 A：禁用（编辑 profile 的 cordis.patch.yml）
- id: composer-provider-label
  disabled: true
# 方式 B：卸载
dsh plugin --profile web remove dsh-composer-provider-label
```

重启后标签消失。插件不写会话数据。若你在 `settings.yaml` 里手写过 `dsh-composer-provider-label:` 段，卸载后它**残留无害**（没有注册方时 `describe()` 不含该 ns），想清理就手动删掉那几行。

## 与既有插件共存

- `dsh-composer-history-recall`：用 `conversation.input.overlay` 槽（键盘 ↑ 召回），与 `input.right` 互不干扰。
- `dsh-open-session-workdir`、`dsh-session-title-regenerate`：作用于会话头部动作条与侧边栏菜单，与 composer 工具行无交集。
- 其余想注册 `conversation.input.right` 的插件按 `order` 排序（本插件 `order: 10`），不冲突。

## 开发

```bash
node dsh-composer-provider-label/test/bundle.test.mjs   # 26 条逻辑断言 + 能力审计
node --check dsh-composer-provider-label/src/index.js
node --check dsh-composer-provider-label/src/client.js
```

26 条断言覆盖：bundle 注册协议、槽位 id/order、locale 字典、四条路由场景（显式 / 沿用 / 默认 / 无路由）、括号剪裁、office 内置别名、settings 别名覆盖与三种失败回退、三个刷新信号、zh/en、纯函数单测、client 与 node 内置表一致性、node 半空安全，以及**能力审计**（断言 bundle 不引用任何改状态的 session Remote、不写 settings）。GUI 侧的视觉/布局/主题/真实安装见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## License

MIT
