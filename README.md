# dsh-plugins

本地 DSH 插件 monorepo（git 仓库）。每个插件是根目录下独立的 `dsh-*/` 子包，各自带 `README.md` 与 `ACCEPTANCE.md`。仓库根本身是一个**聚合伞包**（bundle），提供「只装一个」的统一安装入口。

## 统一安装模型（如何做到「装一次、管一处」）

| 概念 | 位置 | 说明 |
|---|---|---|
| 伞包（唯一 bundle 层） | 根 `package.json` + `cordis.patch.yml` | 名字 `dsh-local-plugins`；patch 里按行 insert 每个插件，**profile 只需在 `dsh.profile.bundles` 里保留这一个本地条目** |
| 插件本体（活链接） | 各 `dsh-*/` 子包 | 仍以 `link:` 形式挂在 profile 的 **`devDependencies`** |
| profile | `~/.dsh/profiles/<name>/package.json` | `dependencies` 里只有 `dsh-local-plugins` 一个本地依赖；三个插件在 `devDependencies` |

### 为什么插件放 devDependencies 而不是 dependencies

DSH 的 `dsh plugin` 会把**所有声明了 `dsh.bundle` 的 dependencies** 自动加进 `dsh.profile.bundles`；若三个插件仍是 dependencies，它们各自的 `cordis.patch.yml` 会和伞包一起重复 insert 相同行 id（启动冲突）。放进 `devDependencies` 后 reconcile 不会扫描它，插件只是**被解析的包**，行统一由伞包 patch 插入，同时保留 `link:` 活链接（改代码即时生效，无需重装）。

> pnpm 陷阱备忘（已实测验证，勿改回）：
> - pnpm **不会**安装「仓外 link 包」声明的嵌套依赖（`link:` 目标包自己的 dependencies 不被遍历），所以不能指望伞包 `dependencies` 传递安装插件；
> - `file:` 依赖跨盘（profile 在 C:、仓库在 D:）是**拷贝**不是硬链接，本地热改失效；
> - 因此唯一同时满足「活链接 + 只激活一个 bundle」的形态就是上面的 devDependencies 方案。

## 新增一个插件（标准流程）

1. 在根目录建 `dsh-xxx/`（含 `package.json` 声明 `dsh.bundle.patch`、`dsh.client`、`exports["./client"]`、README/ACCEPTANCE）。
2. 在根 `cordis.patch.yml` 追加一行 insert（id 稳定、不与其他行冲突）。
3. （可选）在根 `package.json.dependencies` 登记 `"dsh-xxx": "link:./dsh-xxx"`（仅作清单说明，安装不依赖它）。
4. 在目标 profile 的 `package.json.devDependencies` 加 `"dsh-xxx": "link:<本仓库绝对路径>/dsh-xxx"`。
5. 跑 `dsh plugin --profile <name> install`，重启 DSH GUI 生效。

根 `cordis.patch.yml` 是所有本地插件的**唯一激活清单**。

## web profile 当前形态（2026-09 迁移后）

- `dsh.profile.bundles`：本地插件只保留 `dsh-local-plugins` 一个条目（尾部）。
- `dependencies`：`dsh-local-plugins: link:D:/ChenSirDocument/Dsh-Projects/dsh-plugins`。
- `devDependencies`：三个插件各自 `link:` 到本仓库子目录。
- 迁移前备份：`~/.dsh/profiles/web/package.json.bak-2026-09-06-umbrella`、`pnpm-lock.yaml.bak-2026-09-06-umbrella`（回滚 = 还原备份后 `dsh plugin --profile web install`）。
- 验证方式：重启 GUI 后确认会话行 ⋯ 菜单 / 标题区按钮 / `/regenerate-title` 只出现一次、无重复。

## 其他

- 开发规则与知识库入口见 `AGENTS.md`。
- 仓库级忽略规则见 `.gitignore`（`.vscode/`、`.serena/`、`node_modules/` 不入库）。
