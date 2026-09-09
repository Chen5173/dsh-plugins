# dsh-session-title-regenerate

给 DSH（DeepSeek Harness）会话加一个「重新生成标题」动作：用**当前模型、最低推理模式**总结该会话**全部用户提问**，生成一个 60 字以内的单行标题并直接覆盖旧标题。

两个入口，共用同一套逻辑：

- **会话头部操作区按钮**（`conversation.session.header.actions` 槽位）
- **侧边栏会话行 `⋯` 菜单项**「重新生成标题」——核心 `ui-workspace` 把该菜单（重命名/分叉/归档）写死、没有插件扩展点，因此本项与 `@huanlin/dsh-plugin-session-delete` 同款，采用 **DOM 注入**（MutationObserver 监听 `[role=menu]`）。核心把原生项渲染在 `[role=menu] > role=presentation(viewport)` 内容区里，而 session-delete 等插件项是直接挂到 `[role=menu]` 上的兄弟节点；所以本插件把菜单项**追加进内容区 viewport**，使它紧跟在官方"重命名/分叉/归档"之下、位于所有插件注入项之上，且不带自己的分隔线——读起来像官方操作而非插件附加项。

宿主注册 `/regenerate-title` 命令；客户端通过核心 Remote `remote.commands.execute(sessionId, '/regenerate-title', [])` 触发——该 Remote 的 `agent` 查找会**自动恢复未打开的会话**，所以菜单项对任意历史会话都有效，且**不会切换当前对话**。

## 工作原理

1. **收集输入**：读会话日志里所有 `user/message`（`source.kind === 'user'`）的文本块，按序拼接、按 UTF-8 字节预算（默认 12 KB）截断。
2. **最低推理模式**：`ctx.llm.stream` 带 `reasoningEffort: 'off'` + `purpose: 'session-title'`（DeepSeek 适配器对 `session-title` 还会强制 `thinking: disabled`）+ `maxTokens: 100` + 极短提示词。若提供方不支持 `off`（返回 `UNSUPPORTED_REASONING_EFFORT`），自动去掉该字段重试一次。
3. **提示词**：只输出一行纯文本标题、无引号/无 Markdown/无解释、**跟随消息语言**、约 60 个 CJK 字符 / 40 个词。
4. **写入**：`ctx.sessionTitle.rename(session, title)` ——与核心 `remote.session.rename` 同一公共 API：新标题进入日志、固定标题（来源记为 `user`）、客户端列表经标题投影即时刷新。
5. **反馈**：成功 Toast「标题已更新：<新标题>」，失败 Toast 透出原因。

## 安装

```bash
# 在本仓库内（dsh-plugins）
dsh plugin --profile web add ./dsh-session-title-regenerate
```

或手动接入（**当前仓库统一由 `dsh-plugin-manager` 管理本地子插件**：装好管理器后在设置页「本地插件」里启用本插件即可；下面这段是已退役的旧布局写法，仅作参考）：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": [ /* ... */, "dsh-session-title-regenerate" ] } },
  "dependencies": {
    "dsh-session-title-regenerate": "link:D:/ChenSirDocument/Dsh-Projects/dsh-plugins/dsh-session-title-regenerate"
  }
}
```

新管理器布局下：子插件放 profile `devDependencies`（`link:` 到本仓库子目录），激活行由管理器写进 `cordis.patch.yml`（live 热重载）；`dsh.profile.bundles` 只留 `dsh-plugin-manager`。插件自身的 `cordis.patch.yml` 提供稳定行 `session-title-regenerate`，重复 add 不产生重复行。

## 配置

`/regenerate-title` 命令的默认策略见 `src/index.js` 的 `DEFAULTS`，可在 profile 的 cordis patch 行上用 `config:` 覆盖（示例）：

```yaml
- insert:
    - id: session-title-regenerate
      name: 'dsh-session-title-regenerate'
      config:
        provider: deepseek      # 可选：覆盖会话路由（默认跟随会话当前模型）
        model: deepseek-chat    # 可选：必须与 provider 成对出现
        targetWords: 40         # 非 CJK 语言目标词数
        targetCjkCharacters: 60 # CJK 目标字数
        maxInputBytes: 12288    # 输入字节预算
        maxOutputTokens: 100    # 输出 token 上限
        timeoutMs: 30000        # 单次生成超时
```

## 测试

```bash
node dsh-session-title-regenerate/test/bundle.test.mjs
```

纯 Node 逻辑 harness（无浏览器）：宿主命令 handler（消息收集、最低推理参数、标题规范化、错误/重试/截断/取消路径）+ 客户端（槽位注册、命令触发、标题→id 解析、菜单注入与点击流）。宿主半**不 import 任何宿主包**——消息构造与流装配是 `src/index.js` 内的本地实现——因此测试与运行都不需要 `node_modules`，`link:` 安装也能直接加载。

## 兼容性与风险

- 目标核心版本 `>= 0.1.1-rc.2`（`remote.commands.execute`、`ctx.sessionTitle`、`purpose:'session-title'` 均自该版本存在）。
- **宿主半零宿主包依赖**：只用注入服务 `commands` / `llm` / `sessionTitle`，消息构造与流装配为文件内本地实现 → 以 `link:` 形态装在 profile 之外也能加载。若在 `src/index.js` 里 import `@deepseek-ai/*`，Node 会按仓库真实路径解析（symlink 被解引用），仓库祖先链上没有 `node_modules` → 启动即 `ERR_MODULE_NOT_FOUND`。
- 菜单项依赖核心 `ui-workspace` 的会话行 DOM（`[class*=sessionRow]` + `menuOpen`、`[role=menu]`、`[class*=title]`）。`session-delete` 插件在本 profile 已在用同款手法；若上游为会话菜单新增插件槽位，本插件的注入项可平滑换成槽位实现。
- 会话行 DOM 不携带 id，菜单项按**标题**反查会话（客户端列表 store：精确 → 去 fork 后缀 → 互相包含）。同名标题极端情况下可能解析偏差；头部按钮按 id 触发，不受影响。
- 标题以 `user` 来源固定：此后新消息不会自动更新该标题，需再次「重新生成」（这是第 1 轮已确认的「始终覆盖」语义）。
- 触发会经过 `commands.execute`，会话流里会出现一对 `command/run`/`command/done` 节点（`recordInput:false`，不记录参数）；命令也会出现在 composer 的 `/` 命令菜单（可手动输入 `/regenerate-title`）。
- 宿主错误文案为简体中文（客户端自有文案 zh/en 双语）。

## 许可

MIT
