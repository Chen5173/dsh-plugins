// dsh-open-session-workdir: CLIENT half — the whole plugin lives here.
//
// One icon button in the session header action row that hands the CURRENT
// session's working directory to the host desktop opener (Windows Explorer on
// Windows). There is no host endpoint, no model tool and no path allowlist of
// our own: the path goes to the core client service `workspaces.openPath`,
// which calls the host's `host.openPath` and already does the platform dispatch
// and the shell-free native call.
//
// Why `workspaces.openPath` and not the more obvious
// `remote.session.openWorkspacePath`: both land on the same host opener, but
// the latter is a shared funnel that dsh-better-sidebar shadows in order to pull
// chat file links into its own sidebar editor. Its folder branch only recognises
// `'.'`-style paths, so an absolute directory gets read as a file and the GUI
// answers `"<path>" is a directory`. `host.openPath` is not intercepted. See
// test/interception.test.mjs, which mounts their real code to prove it.
//
// Gate (both must hold, or nothing renders):
//   1. the host answers `session.canOpenWorkspacePath()` with true — probed
//      once per page life and cached module-side, because that helper already
//      encodes the darwin/win32/WSL/DISPLAY knowledge we must not re-derive
//      from the browser (browser platform != host platform under a remote GUI);
//   2. the session summary carries a non-empty `cwd`.
//
// Feedback:
//   - success  -> core `Toast` (a 4s top-centre banner; it takes a STRING, so
//     it cannot host a button — see the failure card below).
//   - failure  -> Toast with the reason PLUS an anchored card that keeps the
//     full path visible and offers 复制路径. The card exists because the spec
//     requires a real copy affordance, not just selectable text.
//   - failure classification is POST-hoc (design D5): only after the open
//     failed do we probe `directoryPicker.list(cwd)`. A pre-flight probe would
//     pay a gateway round trip on every success AND would wrongly report
//     "unreachable" on profiles that ship no browse picker.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns the plugin's exports (apply etc.). No JSX: plain
// React.createElement. Theme tokens only (--dsw-*).
window.__ModuleLoader__.load({
  id: 'dsh-open-session-workdir',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useCallback, useEffect, useRef, useState } = React
    const {
      IconCheckOutline16,
      IconCloseOutline16,
      IconCopyOutline16,
      IconFolderOpenOutline16,
      IconLoadingOutline16,
      IconWarningOutline16,
      Toast,
      Tooltip,
      writeClipboard,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'open-workdir'
    const ROW_ORDER = 25
    const NS = 'open-session-workdir'

    /** Upper bound for the open call: PowerShell cold start is seconds, not ms. */
    const OPEN_TIMEOUT_MS = 8000
    /** Upper bound for the capability probe and the post-hoc reachability probe. */
    const PROBE_TIMEOUT_MS = 4000
    /** How long the failure card stays up before it retires itself. */
    const FAILURE_CARD_MS = 14000

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'button.title': '打开工作目录',
      'button.busy': '正在打开…',
      'toast.opened': '已交给系统打开',
      'toast.reopened': '该目录已在文件管理器中打开',
      'card.unreachable': '该目录当前无法访问（可能已被删除或移动）',
      'card.timeout': '打开请求超时，宿主未响应',
      'card.failed': '打开失败',
      'card.noOpener': '找不到可用的打开通道（workspaces.openPath、connection.api.host.openPath、remote.session.openWorkspacePath 都不可达）',
      'card.hostNote': '目录是在宿主机器上打开的，不是浏览器所在机器',
      'card.path': '路径',
      'card.copy': '复制路径',
      'card.copied': '已复制',
      'card.copyFailed': '复制失败',
      'card.close': '关闭',
      'error.unknown': '宿主未返回原因',
    }

    const enDict = {
      'button.title': 'Open working directory',
      'button.busy': 'Opening…',
      'toast.opened': 'Handed to the system to open',
      'toast.reopened': 'That folder is already open in the file manager',
      'card.unreachable': 'This directory is currently unreachable (it may have been deleted or moved)',
      'card.timeout': 'The open request timed out with no host response',
      'card.failed': 'Opening failed',
      'card.noOpener': 'No usable opener channel resolved (workspaces.openPath, connection.api.host.openPath and remote.session.openWorkspacePath are all unreachable)',
      'card.hostNote': 'The directory opens on the host machine, not the one running this browser',
      'card.path': 'Path',
      'card.copy': 'Copy path',
      'card.copied': 'Copied',
      'card.copyFailed': 'Copy failed',
      'card.close': 'Close',
      'error.unknown': 'the host returned no reason',
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

    /** Resolve a key through the locale service, falling back to the sniffed dict. */
    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    /** Re-render on locale snapshot changes (covers entries registered without the `t` seat). */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- host capability gate -------------------------------------------------

    /**
    * Two core services, on purpose. `remote.session` answers the desktop
    * question; `workspaces.openPath` performs the open. The open does NOT go
    * through `remote.session.openWorkspacePath` even though that is the more
    * obvious name: dsh-better-sidebar shadows exactly that method to pull chat
    * file links into its own editor, and a directory handed to it comes back as
    * `"<path>" is a directory`. Both routes land on the same host
    * `openNativePath`, so the only thing lost by switching is the hijack.
    */
    var __sessionRemote = null
    var __workspaces = null
    var __connection = null
    /**
    * The scope handed to us by ctx.inject. The apply-time ctx answers get() with
    * undefined for services that mount later — that is what made both the
    * `remote.session` and the opener lookups fail in the field — while the
    * scoped ctx an inject callback receives resolves them. Every lazy lookup
    * therefore tries this scope BEFORE the apply ctx.
    */
    var __scope = null
    /** Kept so the opener can be looked up again at click time, not just at apply time. */
    var __ctx = null
    /** False until a probe settles on true: an unprobed host shows no button. */
    var __canOpen = false
    var __listeners = new Set()

    function __notify() {
      for (const listener of __listeners) {
        try { listener() } catch { /* one bad subscriber must not stall the rest */ }
      }
    }

    function __setCanOpen(value) {
      const next = value === true
      if (next === __canOpen) return
      __canOpen = next
      __notify()
    }

    /** Subscribe the calling component to gate flips. */
    function useCanOpen() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        __listeners.add(listener)
        return () => { __listeners.delete(listener) }
      }, [])
      return __canOpen
    }

    // --- remote Result helpers ------------------------------------------------
    // The generated client proxy wraps every @Remote in {ok:true,value} /
    // {ok:false,error:{code,message}}; a bare value is accepted too so an older
    // or newer proxy shape degrades to "assume ok" rather than a false failure.

    function __isOk(result) {
      if (result === undefined || result === null) return true
      if (typeof result === 'object' && 'ok' in result) return result.ok === true
      return true
    }

    function __value(result) {
      if (result && typeof result === 'object' && 'value' in result) return result.value
      return result
    }

    /** The host reason arrives wrapped in the runtime's own sentence; keep the useful part. */
    function __hostReason(message) {
      return String(message || '').trim().replace(/^path open failed:\s*/i, '')
    }

    class __Deadline extends Error {}

    /**
    * Bound a promise whose API has no signal parameter of its own
    * (`workspaces.openPath` takes only the path). A late settle after a timeout
    * is swallowed here so it cannot surface as an unhandled rejection — the race
    * already reported it, and the open itself may still land.
    */
    function withDeadline(promise, ms) {
      const tracked = Promise.resolve(promise)
      tracked.catch(() => {})
      let timer
      return Promise.race([
        tracked.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new __Deadline('deadline')), ms)
        }),
      ])
    }

    /** AbortSignal with a deadline; falls back where AbortSignal.timeout is absent. */
    function makeDeadline(ms) {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms)
      }
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('timeout')), ms)
      return controller.signal
    }

    /**
    * Read a service by its cordis name. `ctx.get(name)` is the primary channel
    * and works for dotted paths (`remote.session`), which is how an *external*
    * plugin must reach a controller: injecting the bare `remote` hands back the
    * remote root with no controllers mounted, and reading `ctx.remote.session`
    * only works for core bundles that share the container scope. The plain
    * property is kept as a fallback for non-dotted names because `ctx.get` can
    * come back undefined while the property is populated.
    */
    function __readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const viaGet = ctx.get(name)
          if (viaGet) return viaGet
        }
      } catch { /* unknown or unmounted name: fall through */ }
      if (name.indexOf('.') !== -1) return null
      try {
        return (ctx && ctx[name]) || null
      } catch {
        return null
      }
    }

    /**
    * Reach one controller of the remote root, through every channel that has
    * ever worked: the dotted cordis name first (the only one an external bundle
    * can rely on), then the root object, then the plain `ctx.remote` property
    * that core bundles use.
    */
    function __readRemote(ctx, controller) {
      if (!ctx) return null
      const viaDotted = __readService(ctx, 'remote.' + controller)
      if (viaDotted) return viaDotted
      const root = __readService(ctx, 'remote')
      try {
        return (root && root[controller]) || (ctx.remote && ctx.remote[controller]) || null
      } catch {
        return null
      }
    }

    /**
    * The visibility gate is exactly the spec'd condition: the host can reach a
    * desktop at all, per `session.canOpenWorkspacePath()` — a zero-parameter
    * Remote that no other plugin shadows. We deliberately do NOT test for
    * `session.openWorkspacePath`: it exists even when another plugin has
    * hijacked it, which is how the "is a directory" misroute got through.
    *
    * The opener route is resolved lazily at click time instead (see
    * __resolveOpener). Gating visibility on it looked tidy but was the fragile
    * part: `workspaces` may not be mounted yet when apply() runs, and a wait
    * that never fires silently deletes the button. A missing opener is rare
    * enough to be a failure-card message, not a disappearance.
    *
    * A closed gate is invisible by design, which makes "where is my button"
    * undebuggable from the outside. Every decision therefore announces itself
    * once on the console under a single prefix, so opening DevTools is enough —
    * no expressions to type, no guessing which build is loaded.
    */
    var __logged = new Set()

    /**
    * Paths this page has already handed to the desktop, so a repeat click can say
    * "that folder is already open" instead of re-announcing the hand-off. Windows
    * reuses the window a folder already has open — and a background process may
    * fail to raise it — so a second click on the same directory shows nothing at
    * all, which reads as a broken button.
    */
    var __openedPaths = new Set()
    /**
    * Every click logs its argument and its outcome. Deduplicating the success
    * line looked like the tidy choice and cost a debugging round: the only way
    * to tell "works in session A, not in session B" apart is to see both
    * paths. Two lines per click is the price of that.
    */
    function __report(message) {
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info('[open-session-workdir] ' + message)
        }
      } catch { /* a missing console must never break the UI */ }
    }
    function __say(key, message) {
      if (__logged.has(key)) return
      __logged.add(key)
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info('[open-session-workdir] ' + message)
        }
      } catch { /* a missing console must never break the UI */ }
    }

    function __probeCanOpen() {
      const session = __sessionRemote || __remoteController('session')
      if (!session) {
        __say('no-session-remote', 'gate CLOSED: the `remote.session` controller is not available yet')
        __setCanOpen(false)
        return
      }
      if (typeof session.canOpenWorkspacePath !== 'function') {
        __say('no-capability', 'gate CLOSED: `remote.session.canOpenWorkspacePath` is missing (core too old?)')
        __setCanOpen(false)
        return
      }
      let pending
      try {
        pending = Promise.resolve(session.canOpenWorkspacePath())
      } catch (error) {
        __say('probe-threw', 'gate CLOSED: canOpenWorkspacePath() threw — ' + (error && error.message))
        __setCanOpen(false)
        return
      }
      pending.then((result) => {
        const open = __isOk(result) && __value(result) === true
        __say('settled', open
          ? 'gate OPEN: host can open native paths'
          : 'gate CLOSED: canOpenWorkspacePath() answered ' + JSON.stringify(result) + ' (no desktop on the host?)')
        __setCanOpen(open)
      }).catch((error) => {
        __say('probe-rejected', 'gate CLOSED: canOpenWorkspacePath() rejected — ' + (error && error.message))
        __setCanOpen(false)
      })
    }

    /**
    * The apiproxy client answers `host.openPath` with a `{result:{ok,…}}`
    * envelope (the typert proxy wraps it one level shallower). Unwrap both
    * shapes and turn a failed Result into a thrown Error so every opener
    * channel looks the same to the caller: resolve, or reject with a message.
    */
    /** A compact, honest description of whatever a channel handed back. */
    function __shape(value) {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      if (typeof value !== 'object') return typeof value + ' ' + String(value).slice(0, 60)
      if (typeof value[Symbol.iterator] === 'function' && !('ok' in value)) return 'iterable (not a RemoteResult)'
      const keys = Object.keys(value).slice(0, 8).join(',')
      let verdict = 'no-ok-key'
      if ('ok' in value) verdict = 'ok=' + String(value.ok)
      else if ('result' in value && value.result && typeof value.result === 'object') verdict = 'result.ok=' + String(value.result.ok)
      return '{' + keys + '} ' + verdict
    }

    async function __unwrapOpen(pending, channel) {
      const response = await pending
      const result = response && typeof response === 'object' && 'result' in response ? response.result : response
      // `resolved ok` alone is not trustworthy: __isOk(undefined) is also true,
      // so a channel that returns nothing looks identical to a confirmed open.
      // Anything that is not a present, ok Result gets its raw shape dumped.
      if (!__isOk(result) || result === undefined || result === null) {
        __report('raw response via ' + (channel || 'unknown') + ': ' + __shape(response))
      }
      if (__isOk(result)) return __value(result)
      const error = result && result.error
      const message = typeof error === 'string' ? error
        : (error && (error.message || error.code)) || 'host refused the open'
      throw new Error(message)
    }

    /**
    * Reach the host's native path opener. Two channels, tried in order, both
    * landing on the same `host.openPath` RPC and neither shadowed by another
    * plugin:
    *   1. `workspaces.openPath(path)` — the core client service. It is provided
    *      with `ctx.reflect.provide` INSIDE WorkspaceRuntime's own child scope,
    *      so an external bundle cannot see it (unlike `sessions`, which the
    *      runtime provides on rootCtx). Kept in case that scope ever widens.
    *   2. `connection.api.host.openPath({path}, signal)` — the raw apiproxy
    *      client the runtime itself hands to WorkspaceRuntime. `connection` is
    *      a plain `ctx.provide`, so it IS container-visible, and this layer
    *      accepts an AbortSignal, which restores real cancellation.
    */
    function __lookup(name) {
      // Injected scope first: it is the only one that sees late-mounted services.
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readService(scope, name)
        if (found) return found
      }
      return null
    }

    /**
    * Invoke a remote method through the namespace's own registry, bypassing any
    * replacement sitting on the instance. `methods` and `invokeRemote` are TS
    * `private`, which compiles to plain runtime properties, and the registry
    * still holds the implementation core registered.
    */
    /**
    * The caller context the gateway uses to pick WHICH session a scoped remote
    * addresses: identity(callerCtx) is sessions.scopeOf(ctx), and the namespace's
    * own ctx is the ROOT one, so it tags nothing. The clicked session's own scope
    * is the only ctx carrying its id, so it is preferred whenever the list
    * service can hand one out.
    */
    function __callerCtxFor(session, sessionId) {
      try {
        const sessions = __lookup('sessions')
        if (sessions && typeof sessions.scope === 'function' && sessionId) {
          const scoped = sessions.scope(sessionId)
          if (scoped) return scoped
        }
      } catch { /* fall through to the namespace ctx */ }
      return session.ctx
    }

    function __pristineInvoker(session, method, callerCtx) {
      try {
        const record = session.methods && typeof session.methods.get === 'function'
          ? session.methods.get(method)
          : undefined
        if (!record || typeof session.invokeRemote !== 'function') return null
        // One value only, matching how core invokes it. The generated proxy is
        // what wires an AbortSignal into the transport's cancellation channel;
        // calling invokeRemote directly must not hand it a signal it will try
        // to serialise as payload. The client-side race still bounds the wait.
        __say('record-shape', 'gateway branch selection: ' + JSON.stringify({
          direct: !!record.direct, scoped: !!record.scoped,
          callerIsSessionScope: callerCtx !== session.ctx,
        }))
        return (path) => session.invokeRemote(record.direct, record.scoped, callerCtx, [{ path }])
      } catch {
        return null
      }
    }

    /**
    * The route that works on the build we actually run against.
    *
    * The gateway installs every remote method as a CONFIGURABLE GETTER that
    * reads its own registry (packages/api/gateway: `configurable: true,
    * get: function(){...}`). A plugin that shadows the method — dsh-better-sidebar
    * does exactly this, to route opens into its own editor pane — replaces that
    * accessor with a plain value property, and that is what turned an absolute
    * directory into `"...dsh-plugins" is a directory`.
    *
    * So the discriminator is structural rather than name-based: if the own
    * descriptor is no longer an accessor, the public entry has been replaced,
    * and we invoke the pristine record the namespace still holds. If those
    * internals ever change shape we degrade back to the public method — an
    * intercepted open still beats no open at all.
    */
    function __openViaSession(session, path, sessionId) {
      let descriptor
      try {
        descriptor = Object.getOwnPropertyDescriptor(session, 'openWorkspacePath')
      } catch { descriptor = undefined }
      const intercepted = descriptor !== undefined && typeof descriptor.get !== 'function'
      if (intercepted) {
        const pristine = __pristineInvoker(session, 'openWorkspacePath', __callerCtxFor(session, sessionId))
        __say('pristine-shape', 'pristine registry reachable: ' + JSON.stringify({
          hasMethods: !!(session.methods && typeof session.methods.get === 'function'),
          hasInvokeRemote: typeof session.invokeRemote === 'function',
          hasCtx: !!session.ctx,
          recordKinds: pristine ? 'usable' : 'none',
        }))
        __say('intercepted', 'remote.session.openWorkspacePath is shadowed by another plugin — invoking the pristine registration'
          + (pristine ? '' : ' (internals moved; falling back to the shadowed entry)'))
        if (pristine) return __unwrapOpen(pristine(path), 'pristine-registry')
      }
      return __unwrapOpen(session.openWorkspacePath({ path }), 'public-accessor')
    }

    /**
    * Openers, tried in order. Only one needs to exist:
    *   1. `workspaces.openPath(path)` — present on some builds; gone in
    *      0.1.2-alpha.2, where WorkspaceRuntime no longer defines it.
    *   2. `connection.api.host.openPath({path}, signal)` — the apiproxy client
    *      layer; 0.1.1-rc.2 had it, 0.1.2-alpha.2 dropped `api` from the handle.
    *   3. `remote.session.openWorkspacePath({path}, signal)` — the route core's
    *      own ui-chat uses, and the only one left on 0.1.2-alpha.2. Reached
    *      through the pristine registry when another plugin has shadowed it.
    */
    function __resolveOpener() {
      const ws = __workspaces || __lookup('workspaces')
      if (ws && typeof ws.openPath === 'function') {
        return { label: 'workspaces.openPath', open: (path) => __unwrapOpen(ws.openPath(path), 'workspaces-service') }
      }
      const connection = __connection || __lookup('connection')
      let host = null
      try {
        host = connection && connection.api && connection.api.host
      } catch { /* a half-mounted handle must not throw out of a click */ }
      if (host && typeof host.openPath === 'function') {
        return {
          label: 'connection.api.host.openPath',
          open: (path, signal) => __unwrapOpen(host.openPath({ path }, signal), 'apiproxy'),
        }
      }
      const session = __sessionRemote || __remoteController('session')
      if (session && typeof session.openWorkspacePath === 'function') {
        return { label: 'remote.session.openWorkspacePath', open: (path, _signal, sessionId) => __openViaSession(session, path, sessionId) }
      }
      __say('opener-miss', 'no opener channel: workspaces=' + (ws ? 'present but no openPath()' : 'unresolved')
        + ', connection=' + (connection ? 'present but no api.host.openPath()' : 'unresolved')
        + ', remote.session=' + (session ? 'present but no openWorkspacePath()' : 'unresolved')
        + ' (injected scope ' + (__scope ? 'captured' : 'MISSING') + ')')
      return null
    }

    // --- styles (theme tokens only) -------------------------------------------

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

    const cardStyle = {
      position: 'fixed',
      zIndex: 1000,
      width: 360,
      maxWidth: 'calc(100vw - 24px)',
      padding: '10px 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #fff))',
      // A floating card is a level-3 surface; the literal is only the fallback
      // for a build that has no shadow scale.
      boxShadow: 'var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,.22))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 12,
      lineHeight: '18px',
    }

    const cardTitleStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontWeight: 500,
    }

    const cardNoteStyle = {
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      marginTop: 6,
    }

    const pathRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
    }

    const pathTextStyle = {
      flex: 1,
      minWidth: 0,
      margin: 0,
      padding: '3px 6px',
      borderRadius: 4,
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
      fontSize: 11,
      lineHeight: '16px',
      wordBreak: 'break-all',
      userSelect: 'text',
    }

    const actionButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 11,
      lineHeight: '16px',
      cursor: 'pointer',
      flex: 'none',
    }

    // --- failure card ---------------------------------------------------------

    /**
    * Anchored failure feedback: reason, the full host path (selectable), the
    * host-vs-browser note, and a real copy affordance. Portalled to body and
    * positioned from the trigger so a clipped header cannot cut it off.
    */
    function FailureCard({ failure, t, onClose }) {
      const ref = useRef(null)

      useEffect(() => {
        const timer = setTimeout(onClose, FAILURE_CARD_MS)
        return () => clearTimeout(timer)
      }, [onClose])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      // Place under the trigger, clamped into the viewport. Measured on mount and
      // on resize; the anchor element is captured when the failure was raised.
      const [pos, setPos] = useState(null)
      useEffect(() => {
        const measure = () => {
          const anchor = failure.anchor
          if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return
          const rect = anchor.getBoundingClientRect()
          const width = ref.current ? ref.current.offsetWidth : 360
          const height = ref.current ? ref.current.offsetHeight : 120
          const left = Math.min(
            Math.max(12, rect.right - width),
            Math.max(12, window.innerWidth - width - 12),
          )
          const top = rect.bottom + 8 + height > window.innerHeight - 12
            ? Math.max(12, rect.top - height - 8)
            : rect.bottom + 8
          setPos({ left, top })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [failure])

      const [copied, setCopied] = useState(null) // 'copied' | 'failed' | null

      const copy = useCallback(() => {
        Promise.resolve(writeClipboard(failure.path)).then((ok) => {
          setCopied(ok ? 'copied' : 'failed')
          setTimeout(() => setCopied(null), 2000)
        }, () => setCopied('failed'))
      }, [failure.path])

      return ReactDOM.createPortal(React.createElement('div', {
        ref,
        role: 'alert',
        style: { ...cardStyle, left: pos ? pos.left : -9999, top: pos ? pos.top : -9999 },
      }, [
        React.createElement('div', { key: 'title', style: cardTitleStyle },
          React.createElement(IconWarningOutline16, { size: 14 }),
          React.createElement('span', null, failure.title)),
        failure.detail
          ? React.createElement('div', { key: 'detail', style: cardNoteStyle }, failure.detail)
          : null,
        React.createElement('div', { key: 'note', style: cardNoteStyle }, t('card.hostNote')),
        React.createElement('div', { key: 'path', style: pathRowStyle }, [
          React.createElement('code', { key: 'p', style: pathTextStyle, title: t('card.path') }, failure.path),
          React.createElement('button', {
            key: 'c',
            type: 'button',
            style: actionButtonStyle,
            onClick: copy,
          }, React.createElement(IconCopyOutline16, { size: 12 }), copied === 'copied' ? t('card.copied') : copied === 'failed' ? t('card.copyFailed') : t('card.copy')),
        ]),
        React.createElement('button', {
          key: 'close',
          type: 'button',
          'aria-label': t('card.close'),
          title: t('card.close'),
          onClick: onClose,
          style: { ...actionButtonStyle, position: 'absolute', top: 6, right: 6, padding: '2px 4px' },
        }, React.createElement(IconCloseOutline16, { size: 12 })),
      ]), document.body)
    }

    /** Look one controller up across every scope that might resolve it. */
    function __remoteController(controller) {
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readRemote(scope, controller)
        if (found) return found
      }
      return null
    }

    // --- the header button ----------------------------------------------------

    function OpenWorkdirButton({ sessionId, useSessions, t: seatT }) {
      const t = typeof seatT === 'function' ? seatT : __t
      useLocaleRevision()
      const canOpen = useCanOpen()
      const cwd = useSessions ? useSessions((state) => {
        const summary = state && state.byId ? state.byId[sessionId] : undefined
        return summary && typeof summary.cwd === 'string' ? summary.cwd : ''
      }) : ''

      const buttonRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null) // {seq, text, icon}
      const [failure, setFailure] = useState(null) // {seq, title, detail, path, anchor}
      const seqRef = useRef(0)

      // A flip of the gate, or a session switch that drops cwd, retires the card:
      // it would otherwise keep pointing at a directory the button no longer means.
      useEffect(() => {
        setFailure(null)
      }, [sessionId, canOpen])

      const showToast = useCallback((text, icon) => {
        seqRef.current += 1
        setToast({ seq: seqRef.current, text, icon })
      }, [])

      const closeFailure = useCallback(() => setFailure(null), [])

      const raiseFailure = useCallback((title, detail, path) => {
        seqRef.current += 1
        setFailure({
          seq: seqRef.current,
          title,
          detail,
          path,
          anchor: buttonRef.current,
        })
      }, [])

      const open = useCallback(async () => {
        const path = cwd
        if (busy || typeof path !== 'string' || path === '') return
        // Every click is announced with the exact path, because "works in one
        // session, not in another" can only be read off a difference in the
        // argument. Deduped success logging hid that, which was a mistake.
        __report('click: session=' + String(sessionId).slice(0, 18) + ' path=' + JSON.stringify(path))
        const opener = __resolveOpener()
        if (!opener) {
          // The host says it can open paths, but no opener channel resolved.
          // Say exactly that rather than vanishing the button — a silent
          // disappearance is undebuggable.
          __say('no-opener', 'no opener channel resolved (workspaces.openPath / connection.api.host.openPath)')
          raiseFailure(t('card.noOpener'), '', path)
          return
        }
        setBusy(true)
        setFailure(null)
        let hostMessage = ''
        let timedOut = false
        try {
          // The cwd is passed through verbatim: it is already a host-absolute
          // path, and normalising it would only introduce UNC / trailing
          // separator differences the core opener has no reason to see.
          // Both channels are methods (they read `this`), so keep the receiver.
          // The signal is honoured by the apiproxy layer; the race is the
          // backstop for the channel that ignores it.
          await withDeadline(
            opener.open(path, makeDeadline(OPEN_TIMEOUT_MS), sessionId),
            OPEN_TIMEOUT_MS,
          )
        } catch (error) {
          if (error instanceof __Deadline || (error && error.name === 'AbortError')) timedOut = true
          else hostMessage = __hostReason(error && error.message)
        }
        setBusy(false)
        __report('open attempt via ' + opener.label + ': '
          + (timedOut ? 'TIMED OUT after ' + OPEN_TIMEOUT_MS + 'ms'
            : hostMessage !== '' ? 'FAILED — ' + hostMessage : 'host confirmed'))

        if (!timedOut && hostMessage === '') {
          // Two different successes deserve two different sentences: the desktop
          // reuses the window a folder already has open (and may not raise it), so
          // a repeat click produces no visible window at all. Without this, the
          // user cannot tell "already open" from "the button is broken".
          const reopened = __openedPaths.has(path)
          __openedPaths.add(path)
          showToast(t(reopened ? 'toast.reopened' : 'toast.opened'), React.createElement(IconCheckOutline16, { size: 14 }))
          return
        }

        // Post-hoc reachability probe (design D5): only runs on the failure
        // path, and only when a browse picker is actually wired up. Absent the
        // picker we keep the host's own reason instead of guessing "unreachable".
        let unreachable = false
        // Only consulted after a failure, so it is resolved lazily and its
        // absence merely degrades the wording instead of blocking the open.
        const picker = __remoteController('directoryPicker')
        if (!timedOut && picker && typeof picker.list === 'function') {
          let probe = null
          try {
            probe = await picker.list(path, makeDeadline(PROBE_TIMEOUT_MS))
          } catch {
            probe = { ok: false }
          }
          unreachable = !__isOk(probe)
        }

        if (timedOut) raiseFailure(t('card.timeout'), hostMessage, path)
        else if (unreachable) raiseFailure(t('card.unreachable'), hostMessage, path)
        else raiseFailure(t('card.failed'), hostMessage || t('error.unknown'), path)
      }, [busy, cwd, raiseFailure, showToast, t])

      if (!canOpen) return null
      if (typeof cwd !== 'string' || cwd === '') {
        __say('no-cwd:' + sessionId, 'gate OPEN, but this session summary carries no `cwd` — nothing to open, so no button')
        return null
      }
      __say('rendered', 'button rendered for cwd=' + cwd)

      const title = busy ? t('button.busy') : t('button.title')

      return React.createElement(React.Fragment, null,
        React.createElement(Tooltip, { label: title, side: 'bottom', delayMs: 400 },
          React.createElement('button', {
            ref: buttonRef,
            type: 'button',
            title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : 'false',
            style: { ...buttonStyle, ...(busy ? { opacity: 0.6 } : {}) },
            onClick: () => { void open() },
          }, React.createElement(busy ? IconLoadingOutline16 : IconFolderOpenOutline16, { size: 16 }))),
        toast
          ? React.createElement(Toast, {
            key: toast.seq,
            text: toast.text,
            icon: toast.icon,
            anchor: buttonRef.current,
            onDone: () => setToast(null),
          })
          : null,
        failure
          ? React.createElement(FailureCard, { key: failure.seq, failure, t, onClose: closeFailure })
          : null)
    }

    // --- apply ----------------------------------------------------------------

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
    * Read a service the way the working precedent plugins do, but through BOTH
    * channels: `ctx.get(name)` first, then the plain property. Returning early
    * on a `get` miss is a real trap — `ctx.get('remote')` can come back
    * undefined while `ctx.remote` is populated — and the old property-only read
    * is what used to work, so neither channel alone is safe.
    */
    function __readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const viaGet = ctx.get(name)
          if (viaGet) return viaGet
        }
      } catch { /* unmounted or unknown name: fall through to the property */ }
      try {
        return (ctx && ctx[name]) || null
      } catch {
        return null
      }
    }

    function apply(ctx) {
      __ctx = ctx
      __sessionRemote = __remoteController('session')
      if (!__sessionRemote) {
        ctx.inject(['remote.session'], (sub) => {
          __scope = sub
          __sessionRemote = __readRemote(sub, 'session')
          __probeCanOpen()
        })
      }
      __workspaces = __readService(ctx, 'workspaces')
      if (!__workspaces) {
        ctx.inject(['workspaces'], (sub) => {
          __scope = sub
          __workspaces = __readService(sub, 'workspaces')
        })
      }
      // The opener lives here in the build we ship against: `connection` is a
      // container-visible plain provide, and `api.host.openPath` is the same RPC
      // WorkspaceRuntime calls — with no plugin able to shadow it.
      __connection = __readService(ctx, 'connection')
      if (!__connection) {
        ctx.inject(['connection'], (sub) => {
          __scope = sub
          __connection = __readService(sub, 'connection')
          __say('connection-late', 'connection resolved via its inject scope')
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          __scope = sub
          adoptLocale(__readService(sub, 'locale') || sub.locale, ctx)
        })
      }
      ctx.on('locale/change', () => __notify())
      __say('services', 'apply: remote.session=' + (__sessionRemote ? 'ok' : 'pending inject')
        + ', workspaces=' + (__workspaces ? 'ok' : 'pending inject')
        + ', connection=' + (__connection ? 'ok' : 'pending inject')
        + ', locale=' + (__locale ? 'ok' : 'missing'))
      __probeCanOpen()
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, OpenWorkdirButton))
    }

    // The loader gates apply() until `slots` exists; `remote`/`remote.session`
    // answers the desktop-capability probe and `workspaces` performs the open,
    // both resolved independently above. This list is the bundle's package
    // preload list (it OVERRIDES package.json `dsh.client.inject`), and none of
    // these are package names, so it stays minimal and honest.
    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-open-session-workdir/src/client.js