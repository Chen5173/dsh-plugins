# DSH 插件：host 半禁止 import 宿主内部包（dsh-session-title-regenerate 去核心化）

日期：2026-09-09 · 涉及：`dsh-session-title-regenerate/{src/index.js, package.json, test/bundle.test.mjs}`、web profile 残留。

## 一句话

本地子插件以 `link:` 形态装在 profile 之外时，host 半**只能通过注入服务**（`ctx.commands` / `ctx.llm` / `ctx.sessionTitle` 等）访问宿主能力；一旦 `import '@deepseek-ai/dsh-llm'` 这类宿主内部包，插件树加载即 `ERR_MODULE_NOT_FOUND`。

## 根因（实测）

- Node 裸包解析从**导入文件的真实路径**向上找 `node_modules`；`link:` 的 symlink 默认被解引用，插件真实路径在 git 仓库里。
- 仓库从插件目录到 `/` **没有任何 `node_modules`**；宿主内部包只存在于 `~/.dsh/profiles/node_modules/@deepseek-ai/...`，不在该祖先链上。
- 实证：`cd ~/.dsh/profiles/web && node --input-type=module -e "await import('dsh-session-title-regenerate')"`
  - 默认 → `ERR_MODULE_NOT_FOUND`（报错路径 = 仓库）；
  - 加 `--preserve-symlinks` → `OK`（解析基准变回 profile）。
- `peerDependencies` 声明不产生安装，pnpm 也不为仓外 `link:` 包装依赖 → 这个 import 唯一"可行"的满足方式是仓库里放同名桩。title-regenerate 早期正是如此（`node_modules/@deepseek-ai/dsh-llm` 本地桩，`.gitignore` 忽略、不入库）；换机器/重新克隆后桩消失，报错复现。

## 规则

1. host 半（`src/index.js`）**零 `@deepseek-ai/*` import**，宿主能力只走 `inject` + `ctx` 服务。
2. 需要宿主工具函数时就地实现。本插件只用到两个纯数据工具：`createUserMessage`（对齐 `packages/llm/llm/src/message.ts` 的 `createMessage`：展开入参 + `role:'user'` + 新 id）与 `BlockAssembler`（对齐 `packages/llm/llm/src/assembler.ts`：按 index 累积增量、`block-end` 闭合块优先、`finish` 缺省 `{kind:'stop'}`）。
3. 只有浏览器半（`src/client.js`）的 `require('@deepseek-ai/dsh-client-*')` 是安全的——那是客户端模块表注入，不走 Node 解析。
4. 回归护栏：`test/bundle.test.mjs` 有一条断言，`src/index.js` 不得出现 `from '@deepseek-ai/` / `require('@deepseek-ai/`。

## 验证命令

```bash
node dsh-session-title-regenerate/test/bundle.test.mjs                                                   # 24/24
cd ~/.dsh/profiles/web && node --input-type=module -e "await import('dsh-session-title-regenerate')"      # OK（默认解析）
grep -rnE "from '@deepseek-ai/|require\('@deepseek-ai/" dsh-session-title-regenerate/src/index.js      # 无输出（注释里提到包名不算）
```
