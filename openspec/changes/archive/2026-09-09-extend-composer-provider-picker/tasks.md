## 1. 规格与骨架

- [x] 1.1 确认 `openspec validate extend-composer-provider-picker --strict` 通过，且 proposal/specs/design 三件互相一致（需求编号能在 design 决策里找到落点）
- [x] 1.2 复核 `package.json`：peerDeps 仍为 `@deepseek-ai/dsh-api-session-controller ^0.1.2-rc.1` / `dsh-client-runtime ^0.1.2-rc.1` / `dsh-client-ui-primitives ^0.1.1-rc.2`，无新依赖（`npm ls --omit=dev` 或读 package.json 验证）
- [x] 1.3 在 `src/client.js` 顶部补齐本轮的模块注释（菜单两级 + 写入白名单 + 范围偏好），保持 v1 的注释风格

## 2. 菜单结构

- [x] 2.1 标签由只读 `span` 改为按钮：`aria-haspopup="menu"`、`aria-expanded`、hover/聚焦才显示 `▾`，点击只开菜单不改路由；`test/bundle.test.mjs` 断言点击标签后未调用任何写接口
- [x] 2.2 根层两行「提供方 / 模型」各自显示当前值（别名 / 模型短名）并可进入对应 pane；测试断言根层渲染出两行且值正确
- [x] 2.3 每层顶部加「‹ 返回」行，返回根层且不改变已生效选择；测试断言返回后 `pane` 回到 root 且无写入
- [x] 2.4 footer 常驻「全部提供方 / 仅当前提供方」两个互斥项，当前项打勾；测试断言 footer 两项的 selected 状态与 scope 一致
- [x] 2.5 关闭路径交给原语（Esc / 外部点击），确认不引入自定义全局监听；测试断言 Esc 关闭后路由与状态不变

## 3. 数据与写入

- [x] 3.1 提供方列表构建：`catalog.groups`（catalog 顺序）+ `catalog.failures`（置灰 + 失败副文本）；当前路由 provider 未广告时顶部合成「当前路由」行；测试覆盖三种情形
- [x] 3.2 模型列表构建：「全部提供方」按 provider 分组（组标题 = 别名 + displayName），「仅当前提供方」无组标题；行文案 = 短名 + 完整 id；当前项打勾；测试覆盖两种范围
- [x] 3.3 写入封装：调用 `remote.session.selectModel({sessionId, provider, model, reasoningEffort?})`，提交中置 `selecting` 态，失败写错误并保持路由；测试断言调用参数形状与忙碌态
- [x] 3.4 实现 D4 选模型规则（同 provider 保留 / 默认优先 / 第一个 / 当前模型不在列表时改选）并逐条测试
- [x] 3.5 实现 D5 effort 继承（支持则保留，否则省略字段）并测试两种分支

## 4. 容错与降级

- [x] 4.1 目录未就绪不渲染；目录失败渲染错误态入口，点开触发重新加载（可重试）；测试断言两种状态
- [x] 4.2 菜单顶部失败时显示「重试加载」行并触发重载；测试断言该行存在且点击后重载被调用
- [x] 4.3 `Menu` 原语缺失时降级为 v1 只读标签（点击无副作用、tooltip 仍在）；测试用缺失 `Menu` 的 require 桩验证
- [x] 4.4 子代理会话（`available=false`）菜单可开但选择项禁用并说明原因；测试断言禁用与不写入
- [x] 4.5 写入失败时标签内联错误指示 + tooltip 说明，不弹 toast；测试断言错误态与文案来源

## 5. 偏好持久化

- [x] 5.1 实现 `dsh.composer-provider-label.v1` 读写（含 `getStorage()` 降级），默认 `all`；测试覆盖有值/无值/存储不可用
- [x] 5.2 切换范围立即生效并持久化，跨会话与刷新保持；测试模拟两次挂载读取同一存储

## 6. 测试与审计

- [x] 6.1 把能力审计改为白名单：只允许 `session.selectModel`（写）+ `session.modelCatalog` / `settings.describe`（读），其余改状态接口仍禁止；测试断言白名单外调用为零
- [x] 6.2 补齐 v1 既有 26 个用例仍全绿（解析、别名、三类刷新信号、语言、纯函数导出）
- [x] 6.3 测试总数 ≥40 且 `node dsh-composer-provider-label/test/bundle.test.mjs` 全绿

## 7. 文档

- [x] 7.1 `README.md` 更新：菜单用法、范围开关与偏好键、写权限边界、版本地板不变、**已知限制**（`providerAliases` 在 link: 形态下失效）、回滚步骤
- [x] 7.2 `ACCEPTANCE.md` 追加菜单与开关的手工清单（打开/两级钻取/立即写入/范围切换/失败重试/降级），并保留 v1 遗留的 GUI 验收项
- [x] 7.3 追加 `docs/knowledge/YYYY-MM-DD-dsh-composer-provider-label-picker.md` 并更新 `docs/knowledge/README.md` 索引行

## 9. 长列表高度（追加需求）

- [x] 9.1 注入一条作用域样式表（选择器锚定插件自己的菜单 className），把菜单内容区限制在约五行并开启内部滚动；测试断言样式表内容与「只注入一次」
- [x] 9.2 给 `Menu` 传作用域 className，确认规则不会外溢到其它菜单；测试断言该 className 与选择器作用域
- [x] 9.3 复跑全部断言并重新 `openspec validate --strict`（53/53 + valid）

## 8. 验证与交付

- [x] 8.1 `openspec validate extend-composer-provider-picker --strict` 通过（含 specs 与 change 整体）
- [x] 8.2 `npm pack --dry-run` 文件清单仅含 package.json / cordis.patch.yml / README.md / ACCEPTANCE.md / src/** / test/**（无多余文件）
- [x] 8.3 `git status` 仅包含本 change 相关改动（不动 `openspec/changes/add-remote-plugin-sources/` 与其它插件）
- [x] 8.4 在最终回复里报告：测试数量与结果、validate 结果、pack 清单、以及需要用户走的 GUI 验收项（不自动归档 change）
