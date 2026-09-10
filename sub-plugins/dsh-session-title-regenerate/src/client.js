// dsh-session-title-regenerate: CLIENT half.
//
// Two entry points, one shared flow:
//   1. session-header action button  (conversation.session.header.actions)
//   2. sidebar session-row "..." menu item (DOM injection, title-matched) —
//      core ui-workspace hard-codes that menu (rename/fork/archive) with no
//      extension slot, so the item is injected at the DOM level exactly like
//      @huanlin/dsh-plugin-session-delete does.
//
// Both trigger the host's `/regenerate-title` command through
// `remote.commands.execute(sessionId, '/regenerate-title', [])` — a core
// Remote whose `agent` lookup auto-resumes non-open sessions, so the item
// works on ANY session row without switching the conversation. The host
// commits the new title via sessionTitle.rename; the client list updates
// through the title projection. Success/failure feedback is a shared Toast
// rendered by a root-scoped `shell.overlay` occupant that listens for a
// window event both entry points dispatch.
//
// The DOM-injected menu item has no session id (the row DOM carries none), so
// its click resolves the row title against the client sessions list store
// (exact -> fork-suffix-stripped -> contains), mirroring session-delete.
//
// Locale: all client copy lives in the zh/en dictionaries below and follows
// the client's active language through the `locale` service. Without the
// service a browser-language sniff selects the dictionary. Host-side error
// strings are returned verbatim by the command handler and are zh-first.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports (apply etc.).
// No JSX: plain React.createElement. Theme tokens only (--dsw-*).
window.__ModuleLoader__.load({
  id: 'dsh-session-title-regenerate',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const {
      IconCheckOutline16,
      IconLoadingOutline16,
      IconRefreshOutline16,
      IconWarningOutline16,
      Toast,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'regenerate-title'
    // Header-action ordering: schedule-catalog(10) -> job-list(20) ->
    // open-session-workdir(25) -> this button(27) -> session-delete(30).
    const ROW_ORDER = 27
    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'session-title-regen-feedback'
    const NS = 'session-title-regenerate'
    const COMMAND = '/regenerate-title'
    const RESULT_EVENT = 'session-title-regen:result'

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'header.button': '重新生成标题',
      'header.busy': '正在生成标题…',
      'menu.regenerate': '重新生成标题',
      'toast.success': '标题已更新：',
      'toast.failed': '重新生成标题失败',
      'toast.noCommand': '当前 DSH 版本没有可用的命令通道（remote.commands 缺失）',
      'toast.noSession': '未能定位该会话，请刷新会话列表后重试',
    }

    const enDict = {
      'header.button': 'Regenerate title',
      'header.busy': 'Regenerating title…',
      'menu.regenerate': 'Regenerate title',
      'toast.success': 'Title updated: ',
      'toast.failed': 'Failed to regenerate title',
      'toast.noCommand': 'No command channel available in this DSH build (remote.commands missing)',
      'toast.noSession': 'Could not locate that session; refresh the session list and try again',
    }

    var __locale = null

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** 解析一条文案：优先 locale 服务，回退浏览器语言嗅探字典。 */
    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    /** 随 locale 快照变化重渲染（覆盖未带 t 座位的条目）。 */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- services -------------------------------------------------------------

    var __scope = null
    var __ctx = null
    var __commands = null
    var __sessionsSvc = null

    /** 读取一个 cordis 服务（先 get 再属性回退）。 */
    function __readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const viaGet = ctx.get(name)
          if (viaGet) return viaGet
        }
      } catch { /* unmounted or unknown: fall through */ }
      if (name.indexOf('.') !== -1) return null
      try {
        return (ctx && ctx[name]) || null
      } catch {
        return null
      }
    }

    /** 在注入作用域与应用 ctx 两级查找一个服务名。 */
    function __lookup(name) {
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readService(scope, name)
        if (found) return found
      }
      return null
    }

    /**
     * 解析 `remote.commands` 控制器。外部插件不能直接读 bare `remote` 根的
     * `.commands`：网关把它装成需要先注入的访问器，直接读会抛
     * `cannot get property "remote.commands" without inject`。必须先经
     * `ctx.get('remote.commands')`（dotted cordis 名）或在注入作用域里取。
     * 与 open-session-workdir 读 `remote.session` 是同一个坑、同一种解法。
     * - 参数类型：scope -- Context 或注入作用域。
     * - 返回值：commands 控制器 | null。
     * - 调用样例：const commands = __readCommands(__ctx)
     */
    function __readCommands(scope) {
      try {
        if (scope && typeof scope.get === 'function') {
          const viaGet = scope.get('remote.commands')
          if (viaGet) return viaGet
        }
      } catch { /* 尚未注入：fall through 到兜底路径 */ }
      try {
        const root = scope && (typeof scope.get === 'function' ? scope.get('remote') : scope.remote)
        if (root && root.commands) return root.commands
      } catch { /* bare-root 访问器同样要求注入：忽略 */ }
      return null
    }

    /** 在注入作用域与应用 ctx 两级查找 commands 控制器。 */
    function __lookupCommands() {
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readCommands(scope)
        if (found) return found
      }
      return null
    }

    // --- shared flow ----------------------------------------------------------

    /**
     * 触发一次标题重新生成（命令通道）。
     * - 参数类型：sessionId -- string：目标会话 id。
     * - 返回值：Promise<{ok, message?, title?}>：命令结果。
     * - 调用样例：const r = await executeRegenerate(sessionId)
     */
    async function executeRegenerate(sessionId) {
      // 必须拿到已注入的 commands 控制器：不能读 bare remote 根的 .commands。
      const commands = __commands || __lookupCommands()
      if (!commands || typeof commands.execute !== 'function') {
        return { ok: false, message: __t('toast.noCommand') }
      }
      let result
      try {
        result = await commands.execute(sessionId, COMMAND, [])
      } catch (error) {
        return { ok: false, message: (error && error.message) ? String(error.message) : String(error) }
      }
      if (!result || !result.ok) {
        const err = result && result.error
        const message = (err && (err.message || err.code)) || __t('toast.failed')
        return { ok: false, message: String(message) }
      }
      const value = result.value
      const outcome = value && value.result ? value.result : null
      if (!outcome || outcome.kind === 'error') {
        const text = outcome && typeof outcome.text === 'string' ? outcome.text : __t('toast.failed')
        return { ok: false, message: text }
      }
      const title = typeof outcome.text === 'string' ? outcome.text : ''
      return { ok: true, title }
    }

    /**
     * 派发统一结果事件，由 overlay 宿主渲染 Toast。
     * - 参数类型：ok -- boolean；message -- string；title -- string（成功时的标题）。
     * - 返回值：无。
     * - 调用样例：notify(true, '', '写插件')
     */
    function notify(ok, message, title) {
      try {
        window.dispatchEvent(new CustomEvent(RESULT_EVENT, {
          detail: { ok: ok === true, message: message || '', title: title || '' },
        }))
      } catch { /* a missing window must never break the UI */ }
    }

    // --- 标题 -> 会话 id 解析（菜单项用） --------------------------------------

    /** 归一化标题文本（仅显示层比较用）。 */
    function normalizeTitle(t) {
      return String(t || '').trim().replace(/\s+/g, ' ')
    }

    /** 去掉 fork 会话的 ' (N)' 后缀，便于标题匹配。 */
    function stripForkSuffix(t) {
      return normalizeTitle(t).replace(/\s*\(\d+\)\s*$/, '')
    }

    /**
     * 从客户端会话列表 store 按标题反查会话 id（行 DOM 不携带 id）。
     * 匹配级别：精确 -> 去 fork 后缀 -> 互相包含。
     * - 参数类型：title -- string：行标题文本。
     * - 返回值：string | null：会话 id 或 null。
     * - 调用样例：const id = resolveSessionIdByTitle(title)
     */
    function resolveSessionIdByTitle(title) {
      const want = normalizeTitle(title)
      if (!want) return null
      const wantBase = stripForkSuffix(want)
      const svc = __sessionsSvc || __lookup('sessions')
      if (!svc || !svc.list) return null
      let byId = null
      try {
        const snap = svc.list.getSnapshot()
        byId = snap && snap.byId ? snap.byId : {}
      } catch { return null }
      const ids = Object.keys(byId)
      for (const id of ids) {
        if (normalizeTitle(byId[id].title) === want) return id
      }
      if (wantBase) {
        for (const id of ids) {
          if (stripForkSuffix(byId[id].title) === wantBase) return id
        }
      }
      let best = null
      for (const id of ids) {
        const t = normalizeTitle(byId[id].title)
        if (t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) best = id
      }
      return best
    }

    // --- header button ---------------------------------------------------------

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer',
      flex: 'none',
    }

    /**
     * 会话头部操作区的"重新生成标题"按钮。
     * - 参数类型：props -- {sessionId, useSessions, t}：槽位注入的座席。
     * - 返回值：React 元素（null 当无 sessionId）。
     * - 调用样例：由 slots 以 conversation.session.header.actions 注册。
     */
    function RegenerateTitleButton(props) {
      const t = (typeof props.t === 'function') ? props.t : __t
      useLocaleRevision()
      const sessionId = props.sessionId
      const [busy, setBusy] = useState(false)

      const run = useCallback(async () => {
        if (busy || !sessionId) return
        setBusy(true)
        const result = await executeRegenerate(sessionId)
        setBusy(false)
        if (result.ok) notify(true, __t('toast.success'), result.title)
        else notify(false, result.message || __t('toast.failed'))
      }, [busy, sessionId, t])

      if (!sessionId) return null
      const title = busy ? t('header.busy') : t('header.button')
      return React.createElement('button', {
        type: 'button',
        title,
        'aria-label': title,
        'aria-busy': busy ? 'true' : 'false',
        style: { ...buttonStyle, ...(busy ? { opacity: 0.6 } : {}) },
        onClick: () => { void run() },
      }, React.createElement(busy ? IconLoadingOutline16 : IconRefreshOutline16, { size: 16 }))
    }

    // --- sidebar session-row "..." menu injection ------------------------------

    // The core menu is hard-coded with no extension slot (verified against
    // ui-workspace 0.1.1-rc.2 and 0.1.2-rc.1). We inject at the DOM level,
    // exactly like @huanlin/dsh-plugin-session-delete does.
    //
    // The core renders its items inside the menu's content viewport:
    //   <div role="menu">
    //     <div role="presentation">            <- native items live here
    //       <div class="itemWrap"><button role="menuitem">重命名</button></div>
    //       ...
    //     </div>
    //   </div>
    // while plugin-injected items (session-delete etc.) are appended as DIRECT
    // children of [role=menu] (siblings AFTER the viewport). So to read as an
    // official action rather than a plugin afterthought, we append our own item
    // INTO that viewport: it lands directly under 重命名/分叉/归档 and above
    // every plugin group, with no separator of ours.

    /**
     * 定位原生菜单项所在的内容区：第一个同时带 role=presentation 且内含
     * role=menuitem 的容器（核心 Menu 的 viewport）。找不到则回退到 menu 本身。
     * - 参数类型：menu -- Element：打开的 [role=menu]。
     * - 返回值：Element -- 应注入的容器。
     * - 调用样例：const root = menuContentRoot(menu)
     */
    function menuContentRoot(menu) {
      try {
        const presentational = menu.querySelectorAll('[role=presentation]')
        for (let i = 0; i < presentational.length; i++) {
          const node = presentational[i]
          if (node && node.querySelector && node.querySelector('[role=menuitem]')) return node
        }
      } catch { /* degraded DOM: fall back to the menu itself */ }
      return menu
    }

    /**
     * 把"重新生成标题"注入原生内容区（viewport），使其紧跟官方三项、位于所有
     * 直接 append 到 [role=menu] 的插件项之前。不创建自己的分隔线。
     * - 参数类型：menu -- Element：打开的 [role=menu]；item -- Element：待插入项。
     * - 返回值：无。
     * - 调用样例：insertMenuEntry(menu, item)
     */
    function insertMenuEntry(menu, item) {
      const root = menuContentRoot(menu)
      try {
        root.appendChild(item)
      } catch {
        menu.appendChild(item)
      }
    }

    /**
     * 从打开的会话行读取标题文本。
     * - 参数类型：row -- Element：会话行 DOM。
     * - 返回值：string | ''：行内标题。
     * - 调用样例：const title = readRowTitle(row)
     */
    function readRowTitle(row) {
      if (!row || typeof row.querySelector !== 'function') return ''
      const titleEl = row.querySelector('[class*=title]')
      return titleEl ? String(titleEl.innerText || titleEl.textContent || '').trim() : ''
    }

    /**
     * 找到当前处于菜单打开状态的会话行。
     * - 参数类型：无。
     * - 返回值：Element | null。
     * - 调用样例：const row = findOpenSessionRow()
     */
    function findOpenSessionRow() {
      const rows = document.querySelectorAll('[class*=sessionRow]')
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    /** 菜单注入项的 hover/离开背景反馈。 */
    function bindMenuItemHover(item) {
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent'
      })
    }

    /**
     * 向已打开的 [role=menu] 注入"重新生成标题"菜单项（幂等）。
     * - 参数类型：无。
     * - 返回值：无。
     * - 调用样例：由 MutationObserver 回调调用。
     */
    function ensureMenuItem() {
      const menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector('[data-session-title-regen]')) return
      const row = findOpenSessionRow()
      if (!row) return // 不是会话行菜单
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-session-title-regen', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:var(--dsw-alias-label-primary,inherit)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      // DeepSeek circular refresh icon (matches the ui-workspace regenerate
      // affordance glyph the user asked to mirror), 16x16 currentColor.
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = __t('menu.regenerate')
      bindMenuItemHover(item)
      item.addEventListener('click', () => {
        const title = readRowTitle(row)
        if (!title) return
        const sessionId = resolveSessionIdByTitle(title)
        if (!sessionId) {
          notify(false, __t('toast.noSession'))
          return
        }
        executeRegenerate(sessionId).then((result) => {
          if (result.ok) notify(true, __t('toast.success'), result.title)
          else notify(false, result.message || __t('toast.failed'))
        })
      })
      insertMenuEntry(menu, item)
    }

    /** 语言切换时刷新已注入菜单项的文案。 */
    function refreshMenuLabel() {
      const items = document.querySelectorAll('[data-session-title-regen]')
      for (let i = 0; i < items.length; i++) {
        const span = items[i].querySelector('span')
        if (span) span.textContent = __t('menu.regenerate')
      }
    }

    var __menuInstalled = false

    /** 安装菜单注入：一次性 MutationObserver 常驻观察 body。 */
    function installMenuInjection() {
      if (__menuInstalled) return
      __menuInstalled = true
      try { ensureMenuItem() } catch { /* never crash the UI */ }
      const observer = new MutationObserver(() => {
        try { ensureMenuItem() } catch { /* never crash the UI */ }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- feedback overlay host -------------------------------------------------

    /**
     * shell.overlay 占位：监听结果事件并渲染一条 Toast。
     * - 参数类型：无（槽位组件）。
     * - 返回值：React 元素（无事件时 null）。
     * - 调用样例：由 slots 以 shell.overlay 注册。
     */
    function TitleFeedbackHost() {
      const [toast, setToast] = useState(null) // {seq, ok, message}
      const seqRef = useRef(0)

      useEffect(() => {
        const handler = (e) => {
          const d = (e && e.detail) || {}
          seqRef.current += 1
          setToast({
            seq: seqRef.current,
            ok: d.ok === true,
            message: (d.ok ? (d.title || '') : (d.message || '')),
          })
        }
        window.addEventListener(RESULT_EVENT, handler)
        return () => window.removeEventListener(RESULT_EVENT, handler)
      }, [])

      if (!toast) return null
      const text = toast.ok
        ? __t('toast.success') + toast.message
        : (toast.message || __t('toast.failed'))
      const icon = toast.ok
        ? React.createElement(IconCheckOutline16, { size: 14 })
        : React.createElement(IconWarningOutline16, { size: 14 })
      return React.createElement(Toast, {
        key: toast.seq,
        text,
        icon,
        onDone: () => setToast(null),
      })
    }

    // --- apply ----------------------------------------------------------------

    /** 接管 locale 服务并注册中英文字典。 */
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep the existing copy */ }
    }

    /**
     * 客户端插件入口：注册头部按钮、反馈 overlay 与菜单注入。
     * - 参数类型：ctx -- Context（client root）。
     * - 返回值：无。
     * - 调用样例：由 dsh-client-modules 按 inject/apply 约定调用。
     */
    function apply(ctx) {
      __ctx = ctx
      // remote.commands 是 dotted 控制器：必须经 ctx.get('remote.commands') 或
      // 注入作用域取得，直接读 bare `remote` 根的 .commands 会抛 without inject。
      __commands = __readCommands(__ctx)
      if (!__commands) {
        ctx.inject(['remote.commands'], (sub) => {
          __scope = sub
          __commands = __readCommands(sub)
        })
      }
      __sessionsSvc = __lookup('sessions')
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => {
          __scope = sub
          __sessionsSvc = sub.sessions
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          __scope = sub
          adoptLocale(__readService(sub, 'locale') || sub.locale, ctx)
          refreshMenuLabel()
        })
      }
      ctx.on('locale/change', refreshMenuLabel)
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, RegenerateTitleButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: OVERLAY_ID,
        order: 100,
        ...(__locale ? { locale: NS } : {}),
      }, TitleFeedbackHost))
      installMenuInjection()
    }

    // Test-only hooks: exposed only when the harness sets window.__DSH_TEST__,
    // so the logic harness can drive the module-scoped helpers without a
    // browser (see test/bundle.test.mjs). `reset` clears the module-level
    // service handles so each harness boot starts from a clean slate. Inert
    // in production (apply runs once per page life).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__sessionTitleRegenTest = {
        executeRegenerate,
        resolveSessionIdByTitle,
        ensureMenuItem,
        findOpenSessionRow,
        readRowTitle,
        __t,
        reset() {
          __scope = null
          __ctx = null
          __commands = null
          __sessionsSvc = null
          __locale = null
          __menuInstalled = false
        },
      }
    }

    // The loader gates apply() until `slots` exists; remote/sessions/locale
    // are resolved independently above through deferred injects.
    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-session-title-regenerate/src/client.js
