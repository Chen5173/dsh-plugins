# 验收清单 — dsh-composer-history-recall

代码侧的 20 条逻辑断言已由 `test/bundle.test.mjs` 自动覆盖并通过。本清单覆盖**只有装起来在浏览器里才能确认**的部分：真实 Lexical 选区下的首/末行手感、软换行取舍、与斜杠/提及菜单共存、真实安装、视觉 Toast、语言切换、以及「不改变会话状态」的回归。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
dsh --version   # web profile 需含 conversation.input.overlay 槽与 composer 的 data-composer-input
```

能力缺席时**预期表现是插件惰性不生效**（`↑`/`↓` 与未安装一致），不是报错。

## 1. 安装与加载

安装一律走管理器面板（先装 `dsh-plugin-manager` 一次 → 重启 `dsh web` → 设置 →「本地插件」→ 打开本插件主开关）。**不要**用 `dsh plugin --profile web add` 装本子插件（不会激活，见 README 警示）。

```bash
dsh --dump-config --profile web | grep -n composer-history-recall   # 应看到一行
```

- [ ] 1.1 `[B]` 装好管理器、重启后 `dsh web` 无报错、无插件加载失败提示，面板里本插件显示为「已启用」
- [ ] 1.2 `[B]` 面板启用后：profile `devDependencies` 出现本插件的 `link:`、`dsh.profile.bundles` 里本地条目仍**只有 `dsh-plugin-manager`**
- [ ] 1.3 `[B]` DevTools → Network 过滤 `/plugins/`，刷新页面后能看到本插件 bundle 返回 **200**
- [ ] 1.4 `[B]` Console 无 `slot "conversation.input.overlay" is not declared`、无 list 项 id 冲突
- [ ] 1.5 在面板里把主开关**关→开**一次：profile `cordis.patch.yml` 里 `composer-history-recall` 行**始终只有一行**（不产生第二条），且开回后功能恢复

## 2. 进入召回（spec：输入框提供方向键历史召回）

- [ ] 2.1 `[H]` 选中一个你已发过多条消息的会话 → 点进输入框、清空 → 按 `↑` → 草稿填入**最近一条**你发过的消息，会话无新增
- [ ] 2.2 `[B]` 真实手感：填入后光标在文本末尾、可直接编辑
- [ ] 2.3 `[H]` 历史只含你自己发的消息：往上翻不会翻出助手回复

## 3. 首/末行门控（spec：首行/末行门控避免抢占光标移动）

- [ ] 3.1 `[B]` 输入多行草稿（Shift+Enter 换行），光标停在**中间行**按 `↑`/`↓` → 光标正常上下移动，**不召回**
- [ ] 3.2 `[H]` 光标移到**首行**按 `↑` → 进入召回
- [ ] 3.3 `[B]` **软换行取舍**：一段长文本自动折行成多个视觉行、但只有一个逻辑块时，`↑` 会当作首行进入召回——这是逻辑行语义的预期，非 bug

## 4. 与菜单 / chip 共存（design D2/D5）

- [ ] 4.1 `[B]` 输入 `/` 打开命令菜单 → `↑`/`↓` 在菜单里选候选，**不触发历史召回**
- [ ] 4.2 `[B]` 输入 `@文件` 打开提及菜单 → 同上
- [ ] 4.3 `[B]` 草稿里已插入一个引用 chip（如 `@某文件`）→ 按 `↑` 不召回、光标正常移动
- [ ] 4.4 `[B]` **中文 IME**：输入法候选框打开时按 `↑`/`↓` 选词，不被插件抢走

## 5. 游标推进与边界（spec：浏览游标逐条推进并处理边界）

- [ ] 5.1 `[H]` 连续 `↑` 逐条更早；到最早再 `↑` → 停留 + 顶部 Toast「已是最早一条历史」，不报错
- [ ] 5.2 `[H]` 连续 `↓` 回到最新后再 `↓` → 退出浏览、恢复进入前草稿（空则清空）
- [ ] 5.3 `[B]` 从非空草稿进入（光标首行 `↑`）→ `↓` 越过最新能恢复你原来那段草稿

## 6. 重置（spec：编辑或切换会话后重置浏览游标）

- [ ] 6.1 `[H]` 召回一条后手动编辑，再把光标置首行按 `↑` → 从最近一条重新开始
- [ ] 6.2 `[B]` 召回→编辑→回车发送→再 `↑` → 从最近一条（即刚发的那条）开始
- [ ] 6.3 `[H]` 切到另一会话按 `↑` → 召回的是新会话的历史，与旧会话无关，全程不刷新

## 7. 语言与主题（spec：提示文案跟随客户端语言）

- [ ] 7.1 `[B]` 中文客户端 → 边界 Toast 为中文
- [ ] 7.2 `[B]` 切英文后**不刷新**再触发 → Toast 变英文（`locale/change` 生效）
- [ ] 7.3 `[B]` 深色 / 浅色主题各触发一次 Toast → 无硬编码色、对比度正常

## 8. 只读回归（spec：召回只填回草稿不自动发送）

```bash
S=~/.dsh/sessions/<slug>/<session-id>/session.jsonl.zstd
stat -c '%y %s' "$S"      # 记下 mtime 与大小
```

- [ ] 8.1 反复用 `↑`/`↓` 召回多条历史
- [ ] 8.2 `[B]` 当前会话 id 未变、对话内容未变、滚动位置未变、无消息被自动发出
- [ ] 8.3 再次 `stat -c '%y %s' "$S"` → **mtime 与大小均无变化**

## 9. 共存

- [ ] 9.1 `[B]` 与 `dsh-open-session-workdir`、`@huanlin/dsh-plugin-session-delete` 同时启用 → 头部按钮与本插件互不影响、无 slot id 冲突

## 10. 回滚

```bash
# 在管理器面板里操作，不要用 dsh plugin remove（会留下悬空激活行）
# 方式 A：停用 —— 关掉本插件主开关（profile 行写 disabled: true，行保留）
# 方式 B：卸载 —— 点本插件行上的「移除」（删激活行 + 摘 devDependency；源码目录保留）
```

- [ ] 10.1 `[B]` 停用后（宿主侧即时生效，刷新页面）`↑`/`↓` 恢复编辑器原生行为，无残留报错；再开回主开关功能恢复
- [ ] 10.2 插件不写任何持久数据 → 卸载后 `~/.dsh/` 下无本插件目录，且 profile 里无指向本包的悬空行

---

## 全量场景对照

`openspec/changes/add-composer-history-recall/specs/composer-history-recall/spec.md` 共 7 条 Requirement / 15 个场景。逐条走查完成后：

```bash
openspec validate add-composer-history-recall --strict
```
