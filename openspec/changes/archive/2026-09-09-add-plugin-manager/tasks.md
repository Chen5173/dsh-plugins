## 1. OpenSpec 骨架与清单

- [x] 1.1 创建 `openspec/changes/add-plugin-manager/`（proposal/spec/design/tasks）并跑 `openspec validate --change add-plugin-manager` 通过（proposal 已含新能力 `plugin-manager`）
- [x] 1.2 确认 capability 路径：delta spec 位于 `changes/add-plugin-manager/specs/plugin-manager/spec.md`，归档后落 `openspec/specs/plugin-manager/spec.md`

## 2. 插件骨架与宿主半纯逻辑

- [x] 2.1 新建 `dsh-plugin-manager/`：`package.json`（name=`dsh-plugin-manager`、`main`/`exports["./client"]`、`dsh.bundle.patch`、`dsh.client` platform web + inject client-runtime/client-ui-primitives、peerDependencies）、`cordis.patch.yml`（一行 insert id `dsh-plugin-manager`）、`src/index.js`/`src/client.js` 占位；`node -e` 校验 JSON 与文件齐备
- [x] 2.2 宿主半纯逻辑：仓库根定位（`path.resolve(__dirname,'..')`）、`dsh-*` 子包扫描与元信息读取（name/description/has client）、profile 定位（`DSH_HOME||~/.dsh` + `profiles/<name>`，name 默认 `web` 可覆盖）；用 fixture 目录单测：扫描、排除管理器自身、非插件目录识别
- [x] 2.3 宿主半 profile patch 读写模块（js-yaml + `!!js` schema，整体 parse→transform→dump）：`readPatchRows`/`writePatchRows`、按稳定行 id 增/改/删、只动管理器集合内的行、mcp-manager 风格其它行原样保留；用含 `!!js` 与注释/其它行的 fixture 文件做读写往返单测
- [x] 2.4 状态推导：读 profile `package.json`（dependencies/devDependencies/bundles）与 patch 行 → 每个子插件 `{active, disabled, installed, legacyLayout, needsMigrate}`；单测覆盖 已激活/已停用/未安装/非插件目录/旧布局 五态
- [x] 2.5 迁移规划纯函数：给定当前 manifest（deps/devDeps/bundles）+ 子插件集合 → 输出 {package.json 改写、bundles 收敛为仅 manager、按当前激活补 patch 行、备份文件清单}；单测：5 激活 1 停用迁移后集合不变、bundles 只剩 manager

## 3. 宿主半生效动作与 HTTP

- [x] 3.1 `enable/disable/remove` 动作实现（含必要时 `pnpm add -D link:<abs>` / `pnpm remove`，在 profile 目录 spawn，超时/错误处理）；成功/失败/半状态处理与返回结构；用 dry-run/注入命令执行器单测命令构造与回滚分支
- [x] 3.2 HTTP 端点 `ctx.webServer.register`：`GET /__dsh-plugin-manager/status`、`GET /__dsh-plugin-manager/list`、`POST /__dsh-plugin-manager/set-enabled`、`POST /__dsh-plugin-manager/remove`、`POST /__dsh-plugin-manager/migrate`；JSON 序列化、方法/参数校验、错误码；注入 handler 单测（node:http 直连或直接调 handler）
- [x] 3.3 宿主 `apply(ctx)` 接线：懒取 `webServer`（`ctx.get`/`ctx.inject(['webServer'])`），无 webServer 时静默降级；可选注册 schemastery 设置段 `dsh-plugin-manager`（字段 `profile`，默认 `web`）失败时降级为 fallback schema；导出 `name/inject/apply`；`node --input-type=module` 冒烟加载通过

## 4. 客户端设置面板

- [x] 4.1 `src/client.js`：`window.__ModuleLoader__.load({id:'dsh-plugin-manager', factory:(require)=>{...}})` 格式，`require('react')`/`require('@deepseek-ai/dsh-client-ui-primitives')`/`require('@deepseek-ai/dsh-client-runtime')`，返回 `{apply, inject:['slots']}`；`ctx.slots.inject('settings.section', …)` 注册 `id:'local-plugins'` order 16 label「本地插件」+ zh/en 字典
- [x] 4.2 面板组件：顶部（仓库路径/目标 profile/刷新/一键迁移入口）+ 每子插件行（状态点+包名+目录+描述+主开关+移除）；数据从 `/__dsh-plugin-manager/list` fetch；忙碌/错误/空态齐全
- [x] 4.3 动作接线：开关（set-enabled）、移除（remove，带确认）、迁移（migrate，带确认与备份说明）；动作成功且目标是带 client 的插件 → 显示「刷新页面使界面生效」提示条 + `location.reload()` 按钮（不自动刷新）
- [x] 4.4 浏览器侧测试（jsdom 或轻量 harness）：`test/bundle.test.mjs` 覆盖状态行渲染、fetch 桩交互、提示条出现/不自动刷新；暴露 `window.__dshPluginManagerTest` 诊断钩子
- [x] 4.5 无 slot/旧版本静默退化：不抛错、入口不出现，README 记录版本下限

## 5. 文档、退役伞包与集成收尾

- [x] 5.1 `dsh-plugin-manager/README.md`（安装=`dsh plugin --profile web add`、面板用法、迁移/回滚、权限与副作用说明、版本下限）与 `ACCEPTANCE.md`（对照 spec 每 Requirement 的验收场景）
- [x] 5.2 退役伞包：根 `package.json`/根 `cordis.patch.yml` 注释标 deprecated（不再加新行）；根 `README.md`「统一安装模型/新增插件流程」改写为管理器模型并注明伞包退役；`docs/knowledge/` 新增一篇（含 DSH 机制结论：profile patch live HMR、devDeps 免 reconcile、整文件 js-yaml 重写先例）
- [x] 5.3 全量验证：`node --test`（或现有 test runner）通过；`openspec validate add-plugin-manager` 通过；`git diff --stat` 复查；整理「真机安装与验证」收尾清单（dsh plugin add manager → 重启 → 面板一键迁移 → 开关/新增/移除各验证一次 → 卸载回滚命令）
