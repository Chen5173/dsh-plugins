# dsh-hindsight-model

DSH 设置页里的一块「Hindsight 模型」面板：**看穿四层取值**、**改得动权威文件**、**答得出「到底生效了没有」**。

Hindsight（Vectorize 的长期记忆层）虽然以 DSH 插件形式装入，后端却是**独立 Python 守护进程**——进程、凭据、模型语义三样都和 DSH 隔离，所以它必须单独配模型。更麻烦的是它的配置链路有三个反直觉之处，本插件就是围绕它们做的。

## 它解决的三个问题

| 问题 | 事实（已读上游源码确认） |
|---|---|
| 改完不知道生效没 | 没有热加载（`HindsightConfig._config_cache` 只在进程内，不存在 reload 端点）⇒ 必须重启；而面板能直接回答「现在跑的是哪套值」 |
| 改了被静默改回去 | 守护进程**启动路径会回写权威文件**：`cli.py` 载入 profile 到 `os.environ` 时**不覆盖已存在的键**、`daemon_embed_manager.py` 用 `{**profile, **config}` 合并、`_register_profile()` 再经 `create_profile()` **整体重写** `.env`。所以外层同名环境变量会赢，并覆盖你刚存的值 |
| 不知道「哪一层说了算」 | 权威落点是 `~/.hindsight/profiles/<profile>.env`，但外层还有**用户级环境变量**与**宿主进程环境变量**两层，且两者处置方式不同 |

## 面板里的四层

| 层 | 含义 |
|---|---|
| ① 权威落盘 | `~/.hindsight/profiles/<profile>.env` 的内容（密钥只显示长度） |
| ② 运行中实际生效 | 守护进程启动日志里它**真正读到**的 provider / model / endpoint + 连通性结论 |
| ③ 冲突源 | 会覆盖 ① 的外层值，**分两组**：用户级环境变量（本插件可清理）、宿主进程环境变量（本插件清不掉，只提示） |
| ④ 生效判据 | **主判据**：① 与 ② 的三件套是否一致；**回退判据**（取不到 ② 时）：进程启动时间 vs 文件修改时间 |

> 为什么主判据不是时间：上游启动路径自己会回写该文件，实测本机 `.env` mtime（18:56:29）就晚于进程启动（18:55:46），而两者取值完全一致。只按时间判定会对完全健康的配置长期误报「尚未生效」。

## 用法

设置页 →「Hindsight 模型」。四个操作：

- **从 DSH 读取**：把 DSH 的默认模型（provider / model）与该路由的 `baseURL` 预填进表单（**只填表单，不写盘**）。DSH 的密钥**不会**以明文进入浏览器：面板只显示「有值 / 长度 / 来源」，勾选「保存时使用 DSH 的密钥」后由宿主半在保存时解析并使用。
- **保存**：把改动写进权威文件。写入是**行级增改**——只改命中键所在行，其余行（含模板注释、未知键、顺序、行尾风格）逐字节不变；先写 `*.bak-<时间戳>` 备份，经临时文件 rename 原子落盘，失败即回滚。字段留空表示**删除该键**（回落到内置默认）。
- **验证**：回答「生效了没有、生效的是哪套值」，不一致时逐个列出字段及两侧取值。
- **清理用户级冲突键**：先把这些键（含值）导出到 `~/.hindsight/backups/hkcuenv-<时间戳>.json`，导出成功后才执行删除；二次确认，取消则不动任何键。

### 重启：插件不代劳，但给你一条正确的命令

本插件**绝不**启动/停止守护进程。面板给出一条可直接复制的命令，形如：

```powershell
Remove-Item Env:HINDSIGHT_API_LLM_MODEL, Env:HINDSIGHT_API_LLM_API_KEY -ErrorAction SilentlyContinue
uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> stop
uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> start
```

其中 profile 名与 `embedPackagePath` 都取自本机 `~/.hindsight/coding-agent.json`，不硬编码。**开头那行是关键**：它清除会覆盖 profile 的外层变量，使权威文件成为唯一真源。若不清，你在带这些变量的会话里重启，刚落盘的值会被外层值写回覆盖。

## 已知行为与能力边界

- **上游会整体重写 `.env`**：任何经过官方启动路径的动作都会 `write_text(render_config(...))` 重建该文件。本插件的行级写入依赖「启动路径会把既有非小写键带过去」这一点存活；**外层存在同名键时，你的写入仍会被覆盖**——这正是面板要把 ③ 列出来的原因。别把它当插件 bug。
- **宿主进程环境变量清不掉**：它来自启动 `dsh web` 的上层环境，插件只能如实显示并保证自己给出的重启命令做了净化。要彻底清掉，得在你启动 DSH 的地方去掉那个变量。
- **密钥只写不读回**：`api_key` 字段是单向的；诊断与日志只记键名与长度，不含取值。备份文件（profile 的 `*.bak-*` 与 HKCU 导出）本身含明文，请注意。
- **只跟随一个 profile**：`coding-agent.json` 里的 `daemonProfile`，不做多 profile 切换。
- **Windows 限定**：依赖 `reg query` 与 PowerShell；非 Windows 下相关层降级为「未知」，其余照常。

## 宿主端点

客户端面板通过同源 `fetch` 调这几个端点（`kind: 'exact'`，前缀 `/__hindsight-model`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/__hindsight-model/state` | 四层 + 字段三态 + 冲突源 + 重启命令 + 备份列表（密钥只回元信息） |
| `POST` | `/__hindsight-model/save` | `{changes: {KEY: value\|null}, useDshKey?}` → 备份 + 行级改写 |
| `GET` | `/__hindsight-model/dsh-model` | 预填数据（含密钥元信息，不含明文） |
| `POST` | `/__hindsight-model/verify` | 生效判定 + 启动日志三件套 + 最近的 LLM 调用 |
| `POST` | `/__hindsight-model/clean-env` | 导出 HKCU 备份 + 删除冲突键（需 `confirm: true`） |

方法不符回 `405`，未管理的键回 `400`，内部异常回 `500`（均为 JSON）。

## 安装 / 启停

由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：子插件自带 `dsh.bundle` 会被塞进 profile bundles，与管理器写的激活行同 id → `dsh web` 启动直接失败（`duplicate loader entry id`）。踩坑记录见 `docs/knowledge/2026-09-10-retire-bundle-install.md`。

本插件**不声明** `dsh.bundle`、目录内**不放** `cordis.patch.yml`。

## 开发 / 验证

```bash
node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs   # 逻辑 harness（60 条：纯函数 / 四层读取 / 写入回滚 / 端点契约 / 面板渲染）
node --check sub-plugins/dsh-hindsight-model/src/index.js
node --check sub-plugins/dsh-hindsight-model/src/client.js
node --check sub-plugins/dsh-hindsight-model/src/host-core.js
```

- 宿主半（`src/index.js` + `src/host-core.js`）改动 → **重启 GUI host** 才生效。
- 客户端半（`src/client.js`）改动 → **刷新页面**即可。
- 浏览器手测见 `ACCEPTANCE.md`；设计取舍与取证见 `openspec/changes/2026-09-13-add-hindsight-model-panel/design.md`。
