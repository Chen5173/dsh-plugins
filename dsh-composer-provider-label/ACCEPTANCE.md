# 验收清单 — dsh-composer-provider-label

代码侧的 26 条逻辑断言已由 `test/bundle.test.mjs` 自动覆盖并通过。本清单覆盖**只有装起来在浏览器里才能确认**的部分：真实安装、composer 布局、tooltip 观感、语言切换、三路即时更新、以及「不改变会话状态」的回归。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
# 核心版本必须 >= 0.1.2-rc.1（session/modelCatalog 与 modelSelection 投影从该版本起存在）
dsh --version
```

版本不够时**预期表现是标签不出现**，不是报错——这是设计行为。

## 1. 安装与加载

```bash
cd <本仓库>
dsh plugin --profile web add ./dsh-composer-provider-label
dsh --dump-config --profile web | grep -n composer-provider-label   # 应看到一行
```

- [x] 1.1 `[B]` 重启 `dsh web` 无报错、无插件加载失败提示（**重点**：确认 host 半对 `@deepseek-ai/schemastery` 的动态 import 失败时不会让整行加载失败——应只见标签、settings 段缺省）
- [x] 1.2 `[B]` DevTools → Network 过滤 `/plugins/`，能看到本插件 bundle 返回 **200**
- [x] 1.3 `[B]` Console 无 `slot "conversation.input.right" is not declared`、无 `list slot ... already has an entry with id`
- [x] 1.4 重复执行 add：`dsh.profile.bundles` 与 `cordis.patch.yml` 各**只有一行** `composer-provider-label`

## 2. 入口可见性（spec：输入区显示当前生效路由的提供方）

- [x] 2.1 `[B]` 打开一个有会话的聊天 → composer 工具行出现 provider 标签，位置在**模型选择器左边一格**（`[+][模式]  …  [provider][DeepSeek-V4-Flash · high][上下文][发送]`），无边框无背景、弱色、像模型名的前置缀
- [x] 2.2 `[B]` 同一模型名挂在多家（ark/codemaker/…）时，分别选到不同 provider → 标签文字不同（`ARK` / `codemaker` / …）
- [x] 2.3 `[B]` 从没选过模型的新会话 → 标签显示 profile 默认路由的 provider
- [x] 2.4 `[B]` 空白/无会话欢迎态 → 无标签

## 3. 名字与别名（spec：提供方名称的取值与改写规则）

- [x] 3.1 `[B]` 切到 `ark` 且其 displayName 为 `ARK (Coding Plan)` → 标签显示 `ARK`（括号已剪），悬停 tooltip 里能看到完整 `ARK (Coding Plan)`
- [x] 3.2 `[H]` 官方 `deepseek-official` → 标签 `office`（内置表）
- [x] 3.3 `[B]` 在 `settings.yaml` 或设置页给 `dsh-composer-provider-label.providerAliases` 写 `codemaker: cm` → 重启后切到 codemaker 显示 `cm`
- [x] 3.4 `[B]` 把 `providerAliases` 里 `deepseek-official` 改成 `DeepSeek` → 官方标签变为 `DeepSeek`
- [x] 3.5 `[B]` 没有 displayName 也没有别名的 provider（如 codemaker 未配置时）→ 显示其 id
- [x] 3.6 `[B]` 设置页别名配置写坏（非字符串值）→ 标签仍显示，无报错（schema 拒绝，别名回退内置）

## 4. 即时更新（spec：标签随路由与配置即时更新）

- [x] 4.1 `[B]` 用核心模型选择器把当前会话从 ark 切到 codemaker → 标签**不刷新页面**即变
- [x] 4.2 `[B]` 从会话 A 切到路由不同的会话 B → 标签指向 B
- [x] 4.3 `[B]` 打开一个子代理会话 → 标签跟随其模型路由
- [x] 4.4 `[B]` 在设置页把 `ark` 的 displayName 从 `ARK (Coding Plan)` 改成 `火山方舟` → 不刷新页面，标签变 `火山方舟`（`settings/document-updated` 生效）
- [x] 4.5 `[B]` DevTools 触发宿主重连（`connection/reset`）→ 标签按新代际目录重解析，无旧名残留

## 5. tooltip 与无障碍（spec：悬停可核对完整路由信息）

- [x] 5.1 `[B]` 悬停标签 → tooltip 含：provider 完整名（未裁剪）、模型 id、路由来源
- [x] 5.2 `[B]` 来源文案三分支都对：刚切过模型=「本会话显式选择」；从没切过但发过消息=「沿用上一条请求」；新会话=「跟随 profile 默认」
- [x] 5.3 `[B]` 窗口压窄到标签出现省略号 → tooltip 仍是完整名
- [x] 5.4 `[B]` Tab 聚焦标签 → 读出 aria-label（如「模型提供方: office」）；tooltip 同样可读

## 6. 只读回归（spec：显示是只读的且不改变会话状态）

```bash
S=~/.dsh/sessions/<slug>/<session-id>/session.jsonl.zstd
stat -c '%y %s' "$S"      # 记下 mtime 与大小
```

- [x] 6.1 `[B]` 点击标签、切模型、切会话各若干次
- [x] 6.2 `[H]` 能力审计已自动覆盖：bundle 源码不引用 `selectModel`/`prompt`/`rename`/`fork` 等任何改状态的 session Remote，也不写 settings（只 `describe()` 读）
- [x] 6.3 `[B]` 再次 `stat -c '%y %s' "$S"` → mtime 与大小不变
- [x] 6.4 `[B]` 核心模型选择器的两级菜单、推理档切换、发送按钮均与未装本插件时一致；标签不遮挡它们

## 7. 语言与主题（spec：文案与外观跟随客户端设置）

- [x] 7.1 `[B]` 中文客户端 → aria 与 tooltip 字段为中文；英文客户端 → 对应英文（provider 名本身不翻译）
- [x] 7.2 `[B]` 切语言后**不刷新**再看 → 文案已变（locale/change 生效）
- [x] 7.3 `[B]` 深色 / 浅色主题各看一次标签与 tooltip → 无硬编码色、无对比度失效
- [x] 7.4 `[B]` 窄窗口 → provider 省略号截断，模型名与上下文表不被挤掉

## 8. 共存

- [x] 8.1 `[B]` 与 `dsh-composer-history-recall` 同开：输入框里 ↑ 召回历史照常工作，provider 标签照常显示，互不影响
- [x] 8.2 `[B]` 与 `dsh-open-session-workdir`、`dsh-session-title-regenerate` 同开：头部按钮/菜单项正常，composer 行无重叠
- [x] 8.3 `[B]` 若以后别的插件也注册 `conversation.input.right` → 按 order 排列不冲突（本插件 order 10）

## 9. 回滚

```bash
# 方式 A：禁用（编辑 ~/.dsh/profiles/web/cordis.patch.yml）
#   - id: composer-provider-label
#     disabled: true
# 方式 B：卸载
dsh plugin --profile web remove dsh-composer-provider-label
```

- [ ] 9.1 `[B]` 重启后标签消失，无残留报错
- [ ] 9.2 插件不写会话数据 → 卸载后 `~/.dsh/sessions/` 下无本插件痕迹；`settings.yaml` 里手写的 `dsh-composer-provider-label:` 段若存在则无害残留，可手动删除

---

## 全量场景对照

`openspec/changes/add-composer-provider-label/specs/composer-provider-label/spec.md` 共 7 条 Requirement / 23 个场景。逐条走查完成后：

```bash
openspec validate add-composer-provider-label --strict
```
