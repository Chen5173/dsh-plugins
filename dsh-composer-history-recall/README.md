# dsh-composer-history-recall

在 DSH Web GUI 的**输入框**里，用 `↑` / `↓` 方向键逐条召回**当前会话中你自己发过的消息**，填回草稿供编辑后重发——像终端的命令历史。

纯客户端插件。它**不含任何宿主端点、不注册模型工具、不新增攻击面**：历史从核心已装配好的会话视图读取，写回草稿走核心公开的 `inputActions.setDraft`。

## 为什么需要它

想重复或微调刚发过的一条消息时，只能手动往上翻、复制、粘贴。核心已有一个相邻手势——双击 `Escape` 触发 `rewind`——但它一次只能取回**最近一条**、且会顺带回退会话。本插件补的是「逐条、只读、不回退、不发送」的历史召回。

## 安装

```bash
dsh plugin --profile web add dsh-composer-history-recall
# 本地开发：
dsh plugin --profile web add ./dsh-composer-history-recall
```

然后重启 `dsh web`。安装会写入 profile `package.json` 的 `dsh.profile.bundles`，并应用插件自带的 `cordis.patch.yml`（一行 `insert`）。

**版本要求**：需要 web profile 提供 `conversation.input.overlay` 槽、会话标准 props（`useConversation` / `useInput` / `inputActions`），以及 composer 根上的 `data-composer-input` 属性。任一缺席时插件**惰性不生效**（不挂监听、不报错），与未安装等价。

## 卸载 / 回滚

把 profile `cordis.patch.yml` 里那一行置为禁用，或直接 `dsh plugin --profile web remove dsh-composer-history-recall`，然后重启。插件不写任何持久数据，回滚无残留。

```yaml
- id: composer-history-recall
  disabled: true
```

## 行为

| 情况 | 表现 |
| --- | --- |
| 输入框为空、聚焦、有历史，按 `↑` | 召回**最近一条**你发过的消息填入草稿（不发送） |
| 浏览中连续 `↑` | 逐条向更早推进 |
| 浏览中连续 `↓` | 逐条向更新推进；越过最新一条 → 退出浏览、恢复进入前的草稿（空则清空） |
| 到最早一条后再 `↑` | 停在最早一条，顶部轻量 Toast「已是最早一条历史」 |
| 多行草稿、光标在**中间行**按 `↑`/`↓` | 交还编辑器，正常上下移动光标，**不召回** |
| 光标在**首行**按 `↑` | 进入浏览、召回最近一条 |
| 草稿含引用 chip（`@文件` 等） | 方向键交还编辑器，不召回（避免坐标错位） |
| 正在输入 `/命令` 或 `@提及`（菜单打开） | 方向键交还触发菜单，不召回 |
| 手动编辑召回回来的草稿 | 退出浏览；下次 `↑` 从最近一条重新开始 |
| 发送一条消息后 | 退出浏览；`history` 纳入刚发送的消息 |
| 切换会话 | 游标重置，按新会话的历史召回 |
| 当前会话没有任何你发过的消息 | `↑`/`↓` 保持编辑器原生行为，不报错 |

## 设计约束

- **只读、不发送**：召回只写草稿，绝不自动提交，绝不改变会话消息或运行状态。
- **首/末行门控（逻辑行）**：composer 是 Lexical，段落以块级子元素呈现；插件用「光标所在块是否为编辑器的首/末个块」判定，与终端的逻辑行语义一致。软换行（同一块内视觉换行）算一行——这是已知取舍。
- **进入浏览后放宽门控**：`setDraft` 会把光标落到草稿末尾，若继续要求首行则多行历史条目无法连续 `↑`；故首/末行门控只用于**进入**，进入后自由上下。
- **不抢编辑器/菜单原生键**：监听挂在 document **capture 阶段**（先于 Lexical），只在全部安全条件满足时 `preventDefault`+`stopPropagation`，否则原样放行。
- **外部编辑判定**：记录本插件最后写入的草稿串；草稿落到与之不符的值即判为用户改动，重置游标。用提交后的 draft 值判定，规避 `setDraft` 的异步滞后竞态。
- **文案跟随 locale**：注册 `composer-history-recall` 命名空间（zh/en），`locale/change` 后无需刷新即生效。

## 开发

```bash
node dsh-composer-history-recall/test/bundle.test.mjs
```

24 条行为断言覆盖：bundle 注册协议、服务声明、overlay 槽位 id/order、capture 阶段挂载、locale 字典注册、历史派生（最新在前 / 仅 user / 丢弃空）、进入召回、逐条推进与边界、退出恢复 savedDraft、首/末行门控、chip 抑制、触发 token 抑制、无历史惰性、未聚焦忽略、修饰键 / IME 放行、编辑重置、切换会话重置、绝不 submit。

该测试是**逻辑** harness（自带 hook shim 与假 composer DOM，profile 里没有 jsdom），不覆盖真实 Lexical 选区几何、软换行手感、视觉 Toast 与语言切换——那部分见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## License

MIT
