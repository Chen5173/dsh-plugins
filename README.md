# dsh-plugins

本地 DSH 插件 monorepo（git 仓库）。每个插件是根目录下独立的 `dsh-*/` 子包，各自带 `README.md` 与 `ACCEPTANCE.md`。**推荐安装方式：只装 `dsh-plugin-manager` 一个插件**，然后在其设置页「本地插件」面板里管理其它全部子插件（扫描、激活/停用、移除、一键迁移）。

## 统一安装模型（2026-09-09 起：管理器模型）

| 概念 | 位置 | 说明 |
|---|---|---|
| 唯一本地 bundle | web profile `dsh.profile.bundles` | 只保留 `dsh-plugin-manager` 一个本地条目 |
| 子插件（活链接） | profile `devDependencies`（`link:` 到仓库子目录） | 可解析、不被 `dsh plugin` reconcile 塞回 bundles、改代码即时生效 |
| 激活清单（真相源） | profile `cordis.patch.yml` 中由管理器维护的稳定 id 行 | `- insert: [{ id: <rowId>, name: '<pkg>' }]`；被 DSH patch HMR **实时热重载** |
| 管理 UI | 设置页一级入口「本地插件」（`settings.section`，order 16） | 每子插件：开关/移除；顶部：一键接管/迁移 |

### 安装

```bash
dsh plugin --profile web add C:/WorkProject/GithubProjects/ChenSir5173/dsh-plugins/dsh-plugin-manager
# 重启 dsh web → 设置 → 本地插件 → 若提示旧布局，先点「一键接管/迁移」
```

> 旧布局 = 子插件仍逐个挂在 `dependencies` + `dsh.profile.bundles`（每个子插件自己的 bundle 层在启动时读一次）。迁移会备份 profile 的 `package.json`/`cordis.patch.yml`，收敛为 devDependencies + 管理器维护行，**迁移前后激活集合不变**。

### 为什么子插件放 devDependencies 而不是 dependencies

`dsh plugin` 会把**所有声明了 `dsh.bundle` 的 dependencies** 自动加进 `dsh.profile.bundles`；若子插件是 dependencies，它们各自的 `cordis.patch.yml` 会在 bundles 里和管理器重复 insert 相同行 id（启动冲突）。放 `devDependencies` 后 reconcile 不扫描它，子插件只是**被解析的包**，激活行由管理器统一维护，同时保留 `link:` 活链接。

> pnpm 陷阱备忘（已实测验证，勿改回）：
> - pnpm **不会**安装「仓外 link 包」声明的嵌套依赖，所以管理器不能靠自己的 dependencies 传递安装子插件——子插件由管理器把 `link:` 直接写进 profile 的 devDependencies 再 `pnpm install`。
> - `file:` 依赖跨盘（profile 在 C:、仓库在 D:）是**拷贝**不是硬链接，本地热改失效。
> - 因此「唯一 bundle 层 + devDependencies 活链接 + profile patch 激活行」是实测可行形态。

## 新增一个插件到本仓库

1. 在 `sub-plugins/` 下建 `dsh-xxx/`（含 `package.json` 声明 `dsh.bundle.patch`、`dsh.client`、`exports["./client"]`、README/ACCEPTANCE）。管理器也接受仓库根的旧扁平位置。
2. 管理器**自动扫描**到它（`sub-plugins/dsh-*` 与仓库根 `dsh-*` 的并集），在设置「本地插件」里点启用即完成安装+激活——**无需**再改 profile 或本 README 的清单。

## 已退役：聚合伞包 `dsh-local-plugins`

2026-09-09 起仓库根不再作为 bundle 使用（根 `package.json` 与 `cordis.patch.yml` 保留并标记 **DEPRECATED**，仅为历史/回滚参照，勿再往里加行）。旧文档里「伞包只装一次装全部、根 `cordis.patch.yml` 是唯一激活清单」的模型已被管理器模型取代。

- 历史伞包快照：根 `package.json` 的 dependencies 仍是旧 5 个子插件 `link:` 名单（纯清单，无安装作用）。
- 历史迁移备份（2026-09-06 伞包实验）：`~/.dsh/profiles/web/package.json.bak-2026-09-06-umbrella`、`pnpm-lock.yaml.bak-2026-09-06-umbrella`（回滚 = 还原备份后 `dsh plugin --profile web install`）。

## 各插件速览

| 插件 | 作用 |
|---|---|
| `dsh-plugin-manager` | **本地插件管理器**（先装它）——设置「本地插件」面板管理仓库内全部 `dsh-*` |
| `dsh-session-title-regenerate` | 会话标题「重新生成标题」（最低推理档摘要） |
| `dsh-session-time-bucket` | 侧栏会话按时间桶分组（今天/昨天/…） |
| `dsh-composer-history-recall` | 输入框 `↑`/`↓` 召回自己发过的消息 |
| `dsh-composer-provider-label` | composer 显示模型 provider 标签 |
| `dsh-esc-rewind` | Esc 停止 / Esc·Esc 回退重来 / `/rewind`，可选删除模式 |
| `dsh-open-session-workdir` | 会话头「打开工作目录」 |

## 其他

- 开发规则与知识库入口见 `AGENTS.md`；可复用结论沉淀在 `docs/knowledge/`。
- 仓库级忽略规则见 `.gitignore`（`.vscode/`、`.serena/`、`node_modules/` 不入库）。
