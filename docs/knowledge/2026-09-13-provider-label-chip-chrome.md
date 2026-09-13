# provider 标签改成胶囊 chip：先搞清「这个框是谁画的」

面向用户的诉求：composer 里的 provider 标签希望有一枚**深色框**，形状与旁边的模型 chip 一致，四角圆润、边界（内边距）略宽一点。真正的坑不在改样式，而在**先确认那枚方框来自谁**——它既不是插件的，也不是核心的。

## 结论（可复用）

1. **composer 里按钮的底色可能来自皮肤，不是插件**。ice-princess 的 `~/.dsh/skins/ice-princess/patches.css` 有一条：

   ```css
   [data-composer-card] button:not([role='menuitem']):not([role='option']) {
     background-color: #17264ae6 !important;
   }
   ```

   它把输入卡内**所有非菜单按钮**刷成同一底色——本插件的 provider 标签按钮和核心的模型 chip 都被它刷到，所以两者底色本来就相同；方角是因为这条规则只设 `background-color`，不设 `border-radius` / `padding`。插件当时的 `labelStyle` 写的是 `background: transparent; padding: 0`，**根本没有任何 chip 装饰**。

2. **判据 + 定位手法（不开 DevTools 也能定位）**：
   - 插件用的是**内联样式**，内联压得住普通样式表规则 ⇒ 屏幕上还看得见底色，就说明存在 `!important` 规则（或另一个元素在画）。这条判据可以先用来自证「不是我的代码画的」。
   - 截图取像素：框底色 `rgb(22,37,72)` ≈ `#17264a` × 0.9 alpha 叠在页面底色 `#0f1a33` 上；
   - 在主题 token 里找 `#17264a`：皮肤 `skin.css` 的 `--dsw-alias-interactive-bg-hover-solid: #17264a` 命中；
   - `grep -n "!important" ~/.dsh/skins/<name>/*.css` → 命中上面那条，落定。

3. **核心模型座位的几何**（要跟它对齐就抄这几个数）：`packages/client/ui-model-selection/src/client/ModelSelect.module.css` 的 `.trigger` = `height: 28px`、`padding: 0 4px 0 8px`、`border-radius: 24px`、`font 13/20/500`、`color --dsw-alias-label-secondary`；静止态 `background: transparent`，hover `--dsw-alias-interactive-bg-hover`。

4. **皮肤 `!important` 与插件自绘的取舍：几何归插件、颜色归主题/皮肤**。插件自己写 `--dsw-alias-interactive-bg-hover-solid` 作兜底底色（没皮肤时也是深色 chip），皮肤在时皮肤赢——于是两枚 chip 自动同色，插件不必（也不该）写死皮肤色值、不必与其争优先级。形状（28px 高 / 24px 圆角 / 左右各 10px 内边距，比模型座位宽 2px）由插件负责，皮肤那条规则动不到。

5. **`max-width: 11em` 与内边距**：改成 `box-sizing: border-box` 后，省略号上限**含**内边距 ⇒ 窗口压窄时不会比以前多占宽度，README 里「不挤模型名与上下文用量」的承诺不变。

6. **验证手法**：新增 2 条 harness 断言直接读 `buttonOf(tree).props.style`；再把 HEAD 版 `client.js` 临时写回跑一遍，确认**新用例全红**、老用例不红，然后恢复（`cp` 到 `tmp/` → `git show HEAD:<path> > <path>` → 跑 → `cp` 回来 → `diff -q` 确认字节一致）。改的是客户端半 ⇒ **刷新页面**即可生效，不用重启宿主。

## 影响面

- `sub-plugins/dsh-composer-provider-label/src/client.js`：只动 `labelStyle` 常量（`readOnlyStyle` 与错误态 `!` 按钮由它派生，一并变化）。
- `sub-plugins/dsh-composer-provider-label/README.md`：「标签在哪」补 chip 描述与皮肤优先级，「设计约束」加一条几何对齐。
- `sub-plugins/dsh-composer-provider-label/ACCEPTANCE.md`：2.1 的验收口径由「无边框无背景、像模型名的前置缀」改为「与模型座位同几何的胶囊 chip」；原 2.5 拆成 2.5（有皮肤时与模型 chip 同色 → 已由用户确认）与 2.6（默认主题下的兜底底色 → 待抽查）。

## 证据

- 改动前：`node sub-plugins/dsh-composer-provider-label/test/bundle.test.mjs` 55/55（两条新用例在 HEAD 版 `client.js` 上为 FAIL）。
- 改动后：同文件 **55/55 通过**；全仓库 `sub-plugins/*/test/*.test.mjs` 与 `dsh-plugin-manager/test/*.test.mjs` 无新增失败（`dsh-open-session-workdir/test/interception.test.mjs` 的 `function isFolderRevealPath not found in client-registry.js` 是既存失败，与本次改动无关）。
- 浏览器侧：**2026-09-13 用户确认**「形状与皮肤下的同色效果都没问题」⇒ ACCEPTANCE 2.1、2.5 已勾；默认主题下的兜底底色（2.6，`--dsw-alias-interactive-bg-hover-solid` 而不是透明）未在无皮肤环境走过，仍留空。
