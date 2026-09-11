# dsh-plugin-manager

**本地插件管理器**：装上这一个插件，就能在 DSH Web 设置页的「本地插件」面板里管理本仓库全部 `dsh-*` 子插件 —— 查看状态、逐个或批量开关（激活 / 停用）、移除、把旧布局一键迁移到管理器模型。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
# 本机开发：dsh plugin --profile web add <仓库根>
```

**重启 `dsh web`** → 设置 → 左侧「本地插件」。各入口写法与限制见根 [`README.md`](../README.md)。

首次进入若面板顶部提示「仍以旧布局安装」，点 **一键接管/迁移** —— 它会先备份 profile 的 `package.json` 与 `cordis.patch.yml`（`*.bak-<时间戳>`），迁移前后你的插件激活集合不变。

## 面板怎么用

每行 = 状态标签 + 包名/目录 + 描述 + 主开关 + 移除；顶部 = 仓库路径 / 子插件目录 / 目标 profile / **全部开启·全部关闭** / 刷新 / 一键迁移。

- **启用**：自动补依赖并写入激活行，宿主侧即时生效。
- **停用**：保留激活行与依赖，只是关掉，随时可再开。
- **移除**：删激活行 + 摘依赖；仓库里的源码目录保留，之后可再启用。
- **带界面的子插件**其客户端 UI 只在**一次页面刷新**后进/出。面板开关后会提示并给出刷新按钮，**不会自动刷新**。
- **批量按钮**上的数字 = 这一步真能改动的插件数（为 0 时置灰）。「全部开启」处理 `已停用` 与 `未激活`；「全部关闭」处理 `已激活`；`未激活(仅依赖)`、`旧布局`、`非插件目录` 一律跳过（旧布局请先迁移，确认框与结果里会点明跳过了几个）。批量只作用于面板列出的受管子插件，profile 里其它插件的行（`mcp-*`、`dsh-liquid-glass` …）一行都不碰。
- **失败逐项回报**：批量中某项失败只影响该项（原因可见、状态不变、可重试），其余照常生效，提示条逐条列出。
- **执行期锁定**：批量进行中（可能正在装依赖）所有开关、移除与「一键迁移」都禁用并显示「处理中…」。
- **连点会合并**：短时间内多次开关只落盘一次。落盘会让核心重应用整棵配置树，界面可能短暂无响应。
- **没有**撤销按钮、「全部移除」，也不会自动迁移旧布局。

## 它会改动你机器上的什么

- 读写目标 profile 的 `package.json`（`devDependencies`）与 `cordis.patch.yml`（激活行）；每次改动前生成 `*.bak-<时间戳>` 备份，失败自动回滚。
- 需要装依赖时在 profile 目录执行 `pnpm install`。
- YAML 处理用 profile 自带的 `js-yaml`；缺失时自动 `pnpm add -D js-yaml` 一次。
- 默认管理**当前正在运行的那个 profile**。没有 Web 界面可探测时（例如 headless 宿主）回退到 `$DSH_HOME/profiles/<config.profile || 'web'>` —— 要改这个回退目标，在 `dsh.profile.bundles` 里本插件行加 `config: { profile: '名字' }`。
- 除以上之外不写任何持久数据。

## 卸载 / 回滚

```bash
dsh plugin --profile web remove dsh-plugin-manager
```

卸载管理器后，已迁移的子插件按现状（`devDependencies` + 激活行）继续工作。要回到迁移前的样子，先还原面板报出的 `*.bak-*` 备份文件，再重装。

> ⚠️ **卸载子插件不要用 CLI**：`remove <子插件包名>` 只摘依赖、不会删管理器写的激活行，下次 `dsh web` 启动会失败。请用面板的「移除」。

## 版本要求

- Node ≥ 20（`package.json` 的 `engines`）。
- 宿主：profile 顶层能解析 `js-yaml`（web profile 已具备）。
- 浏览器：需要核心提供 `react` 模块字与 `settings.section` 槽；面板注入 `@deepseek-ai/dsh-client-runtime@^0.1.2-rc.1`。

---

每个子插件的作用与触发位置见 [`docs/plugins.md`](../docs/plugins.md)。本包的机制说明、约束与实测证据在仓库根 `AGENTS.md`、`docs/knowledge/`、`openspec/`；逐条验收项见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。
