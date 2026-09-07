// dsh-composer-provider-label: CLIENT half — the whole visible feature lives here.
//
// One read-only provider label beside the composer's model selector. The model
// selector (core ModelSelect, `conversation.input.model`) shows only the model
// name (`ModelSelect.tsx:197-200` falls back to provider/model only when the
// model is not in the catalog), so two providers serving the same model —
// ark / codemaker / bai / openroputer all carry `deepseek-v4-flash` in a
// typical settings.yaml — are indistinguishable. This plugin registers one
// compact label into the EMPTY `conversation.input.right` list slot
// (InputBar.tsx:461-467 renders it immediately left of the model seat), so the
// row reads `office · DeepSeek-V4-Flash · high` with zero DOM injection and
// zero shadowing of the shipped model seat.
//
// Data is all public contract, resolved with the SAME rule the core directory
// uses (`projection.next ?? catalog.default`):
//   - current route  -> `useProjection('modelSelection')` standard slot prop
//   - display names  -> `remote.session.modelCatalog()` (group.name), one call
//                       cached per host generation, refreshed on the same three
//                       signals core's ModelDirectoryResolver listens to
//                       (`llm/adapters-updated`, `settings/document-updated`,
//                       `connection/reset`)
//   - short names    -> built-in {deepseek-official → office}, overlaid by the
//                       optional `dsh-composer-provider-label.providerAliases`
//                       settings section (read once via remote.settings.describe)
//
// Everything degrades, never crashes: no session / no projection / no catalog
// yet / describe failing → render nothing or fall back to the raw provider id.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns { apply, inject }. No JSX: plain React.createElement.
// Theme tokens only (--dsw-alias-*), never hardcoded colours.

window.__ModuleLoader__.load({
  id: 'dsh-composer-provider-label',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState } = React
    const { Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

    const SLOT = 'conversation.input.right'
    const ROW_ID = 'composer-provider-label'
    const ROW_ORDER = 10
    const NS = 'composer-provider-label'
    const SETTINGS_NS = 'dsh-composer-provider-label'

    /** Default short-name map, mirrored by the node half (tests assert equality). */
    const BUILTIN_ALIASES = Object.freeze({ 'deepseek-official': 'office' })
    /** Tooltip line separator, matching core's ` · ` effort separator. */
    const SEP = ' · '

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'aria.provider': '模型提供方',
      'tooltip.provider': '提供方',
      'tooltip.model': '模型',
      'tooltip.source': '路由来源',
      'source.explicit': '本会话显式选择',
      'source.reused': '沿用上一条请求',
      'source.default': '跟随 profile 默认',
    }

    const enDict = {
      'aria.provider': 'Model provider',
      'tooltip.provider': 'Provider',
      'tooltip.model': 'Model',
      'tooltip.source': 'Route source',
      'source.explicit': 'explicitly chosen for this session',
      'source.reused': 'carried over from the last request',
      'source.default': 'following the profile default',
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

    /** Re-render on locale snapshot changes (entries without the `t` seat). */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- read-only diagnostics (no message content) ---------------------------
    var __diag = {
      loaded: true,
      applied: false,
      mounted: 0,
      catalogStatus: 'idle',
      lastProvider: null,
      lastShort: null,
      aliasSource: 'builtin',
    }
    try { if (typeof window !== 'undefined') window.__cpl = __diag } catch { /* no window */ }

    // --- module cache: catalog + aliases (per host generation) ----------------

    var __catalog = null
    var __catalogStatus = 'idle' // idle | loading | ready | error
    var __catalogGeneration = 0
    var __catalogInflight = null
    var __aliases = Object.assign({}, BUILTIN_ALIASES)
    var __aliasLoadQueued = false
    var __listeners = new Set()

    function __notify() {
      for (const listener of [...__listeners]) {
        try { listener() } catch { /* one bad subscriber must not stall the rest */ }
      }
    }

    function __subscribe(listener) {
      __listeners.add(listener)
      return () => { __listeners.delete(listener) }
    }

    // --- service resolution (mirrors dsh-open-session-workdir's proven shape) --

    var __ctx = null
    var __scope = null
    var __session = null
    var __settings = null
    var __remoteRoot = null

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

    function __readRemoteController(ctx, controller) {
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

    function __sessionOf() {
      if (__session) return __session
      for (const scope of [__scope, __ctx]) {
        const controller = __readRemoteController(scope, 'session')
        if (controller) { __session = controller; return controller }
      }
      return null
    }

    function __settingsOf() {
      if (__settings) return __settings
      for (const scope of [__scope, __ctx]) {
        const controller = __readRemoteController(scope, 'settings')
        if (controller) { __settings = controller; return controller }
      }
      return null
    }

    // --- remote Result envelope helpers ---------------------------------------

    function __isOk(result) {
      if (result === undefined || result === null) return true
      if (typeof result === 'object' && 'ok' in result) return result.ok === true
      return true
    }

    function __value(result) {
      if (result && typeof result === 'object' && 'value' in result) return result.value
      return result
    }

    // --- pure display helpers (exported on __diag for the harness) -------------

    /**
     * Strip a trailing parenthetical tail and its preceding space:
     * `ARK (Coding Plan)` -> `ARK`; `A (B) (C)` -> `A (B)` (last tail only);
     * a name that is nothing but a parenthetical is kept whole.
     */
    function stripParenthetical(text) {
      const source = String(text === undefined || text === null ? '' : text).trim()
      const match = source.match(/^(.*?)\s*[（(][^）)]*[）)]$/)
      if (match && match[1] && match[1].trim()) return match[1].trim()
      return source
    }

    /** Raw (untrimmed) provider display name from the catalog, or null. */
    function providerDisplayName(providerId, catalog) {
      if (!providerId || !catalog || !Array.isArray(catalog.groups)) return null
      const group = catalog.groups.find((entry) => entry && entry.id === providerId)
      if (group && typeof group.name === 'string' && group.name) return group.name
      return null
    }

    /** Short label: aliases (user over built-in) -> stripped display name -> raw id. */
    function shortNameOf(providerId, catalog, aliases) {
      if (!providerId) return ''
      const aliased = aliases && aliases[providerId]
      if (typeof aliased === 'string' && aliased.length > 0) return aliased
      const display = providerDisplayName(providerId, catalog)
      if (display) return stripParenthetical(display) || display
      return providerId
    }

    /**
     * Effective route = `projection.next` (session's durable next-request
     * selection) -> `lastUsed` -> catalog.default. Same rule as core's
     * ModelDirectory.current, so the label can never disagree with the model
     * name the core selector renders.
     */
    function resolveRoute(projection, catalog) {
      if (projection) {
        if (projection.next && projection.next.provider) return projection.next
        if (projection.lastUsed && projection.lastUsed.provider) return projection.lastUsed
      }
      if (catalog && catalog.default && catalog.default.provider) return catalog.default
      return null
    }

    function sameRoute(left, right) {
      return !!(left && right && left.provider === right.provider && left.model === right.model)
    }

    /** Classify where the effective route came from (for the tooltip). */
    function routeSourceKey(projection, route) {
      if (!projection || !route) return 'source.default'
      if (projection.next && projection.next.provider) {
        if (projection.lastUsed && sameRoute(projection.next, projection.lastUsed)) return 'source.reused'
        return 'source.explicit'
      }
      if (projection.lastUsed && projection.lastUsed.provider && sameRoute(route, projection.lastUsed)) {
        return 'source.reused'
      }
      return 'source.default'
    }

    // --- catalog + aliases loading (render-driven, one in-flight each) ---------

    function __invalidateCatalog(clear) {
      __catalogGeneration += 1
      __catalogInflight = null
      __catalogStatus = 'idle'
      if (clear) __catalog = null
    }

    function __startCatalogLoad(session) {
      if (__catalogInflight) return
      const generation = __catalogGeneration
      __catalogStatus = 'loading'
      __notify()
      const operation = Promise.resolve()
        .then(() => session.modelCatalog())
        .then((response) => {
          if (generation !== __catalogGeneration) return
          if (__isOk(response)) {
            __catalog = __value(response) || null
            __catalogStatus = 'ready'
          } else {
            __catalogStatus = 'error'
          }
          __notify()
        })
        .catch(() => {
          if (generation !== __catalogGeneration) return
          __catalogStatus = 'error'
          __notify()
        })
        .finally(() => {
          if (generation === __catalogGeneration) __catalogInflight = null
        })
      __catalogInflight = operation
    }

    function __loadAliases(settings) {
      Promise.resolve()
        .then(() => settings.describe())
        .then((response) => {
          if (!__isOk(response)) return
          const view = __value(response)
          const rows = view && Array.isArray(view.namespaces) ? view.namespaces : []
          const row = rows.find((entry) => entry && entry.ns === SETTINGS_NS)
          const value = row && row.value && typeof row.value === 'object' ? row.value.providerAliases : undefined
          if (value === undefined || value === null || typeof value !== 'object') return
          // User entries overlay the built-in map; the built-ins stay as a floor.
          const merged = Object.assign({}, BUILTIN_ALIASES)
          for (const key of Object.keys(value)) {
            const entry = value[key]
            if (typeof entry === 'string' && entry.length > 0) merged[key] = entry
          }
          __aliases = merged
          __diag.aliasSource = 'settings'
          __notify()
        })
        .catch(() => { /* keep built-in aliases */ })
    }

    /** Kick pending loads once the required controllers are in reach. */
    function __ensureLoaded() {
      const session = __sessionOf()
      if (session && typeof session.modelCatalog === 'function') {
        if (__catalogStatus !== 'loading' && __catalogStatus !== 'ready') __startCatalogLoad(session)
      }
      const settings = __settingsOf()
      if (settings && typeof settings.describe === 'function' && !__aliasLoadQueued) {
        __aliasLoadQueued = true
        __loadAliases(settings)
      }
    }

    // --- the label ------------------------------------------------------------

    const labelStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '11em',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 'none',
      fontSize: 'inherit',
      lineHeight: 'inherit',
    }

    function ProviderLabel({ sessionId, useProjection }) {
      useLocaleRevision()
      // Hooks stay unconditional; the early return below comes after them.
      const projection = typeof useProjection === 'function'
        ? useProjection('modelSelection')
        : undefined
      const [, force] = useState(0)
      useEffect(() => {
        __diag.mounted += 1
        return __subscribe(() => force((value) => value + 1))
      }, [])
      __ensureLoaded()

      if (!sessionId) return null
      const route = resolveRoute(projection, __catalog)
      if (!route || !route.provider) return null

      const providerId = route.provider
      const modelId = typeof route.model === 'string' && route.model ? route.model : providerId
      const fullName = providerDisplayName(providerId, __catalog) || providerId
      const shortName = shortNameOf(providerId, __catalog, __aliases)
      const sourceKey = routeSourceKey(projection, route)

      __diag.lastProvider = providerId
      __diag.lastShort = shortName
      __diag.catalogStatus = __catalogStatus

      const aria = __t('aria.provider') + ': ' + shortName
      const tooltip = [
        __t('tooltip.provider') + ': ' + fullName,
        __t('tooltip.model') + ': ' + modelId,
        __t('tooltip.source') + ': ' + __t(sourceKey),
      ].join(SEP)

      return React.createElement(
        Tooltip,
        { label: tooltip, side: 'top', delayMs: 500 },
        React.createElement('span', { style: labelStyle, 'aria-label': aria, role: 'text', tabIndex: 0 }, shortName),
      )
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

    let __eventsBound = false
    function __bindEvents(ctx) {
      if (__eventsBound) return
      // Never read `ctx.remote` as a bare property here: on a real guarded
      // context an uninjected service name throws `cannot get property
      // "remote" without inject`. __readService swallows that; the property
      // fallback must not live outside its try/catch.
      const remote = __remoteRoot || __readService(ctx, 'remote') || null
      if (!remote || typeof remote.$on !== 'function') return
      __remoteRoot = remote
      __eventsBound = true
      ctx.effect(() => {
        const disposers = []
        const on = (event, handler) => {
          try {
            const disposer = remote.$on(event, handler)
            if (typeof disposer === 'function') disposers.push(disposer)
          } catch { /* a subscriber failure must not break apply */ }
        }
        on('llm/adapters-updated', () => { __invalidateCatalog(false); __notify() })
        on('settings/document-updated', (ns) => {
          __invalidateCatalog(false)
          if (!ns || ns === SETTINGS_NS) {
            // Our own namespace changed: allow one fresh describe on next render.
            __aliasLoadQueued = false
            __settings = null // drop the cached handle so describe re-resolves if needed
          }
          __notify()
        })
        try {
          const resetDisposer = ctx.on('connection/reset', () => {
            __invalidateCatalog(true)
            __aliasLoadQueued = false
            __settings = null
            __notify()
          })
          if (typeof resetDisposer === 'function') disposers.push(resetDisposer)
        } catch { /* ctx.on unavailable: rely on remote events */ }
        return () => { for (const disposer of disposers) { try { disposer() } catch { /* noop */ } } }
      }, 'composer-provider-label: refresh')
    }

    function apply(ctx) {
      __ctx = ctx
      __diag.applied = true

      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(__readService(sub, 'locale') || sub.locale, ctx)
        })
      }

      // Capture the controllers on the scope an inject callback hands us (the
      // apply-time ctx answers get() with undefined for services mounted later).
      __session = __readRemoteController(ctx, 'session')
      if (!__session) {
        ctx.inject(['remote.session'], (sub) => {
          __scope = sub
          __session = __readRemoteController(sub, 'session')
          __notify()
        })
      }
      __settings = __readRemoteController(ctx, 'settings')
      if (!__settings) {
        ctx.inject(['remote.settings'], (sub) => {
          __scope = sub
          __settings = __readRemoteController(sub, 'settings')
          __notify()
        })
      }

      __bindEvents(ctx)
      if (!__eventsBound) {
        ctx.inject(['remote'], (sub) => {
          __scope = sub
          __remoteRoot = __readService(sub, 'remote') || null
          __bindEvents(ctx)
        })
      }

      ctx.on('locale/change', () => __notify())

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, ProviderLabel))
    }

    // Pure display helpers exposed for the logic harness (read-only; the browser
    // ignores them). Mirrors the window.__dshr diagnostics affordance.
    __diag.pure = {
      stripParenthetical,
      providerDisplayName,
      shortNameOf,
      resolveRoute,
      routeSourceKey,
      BUILTIN_ALIASES,
    }

    // The loader gates apply() until `slots` exists (to register the right-slot
    // entry). remote.session / remote.settings / remote / locale are wired
    // lazily through separate ctx.inject calls so no single wait can block the
    // row — missing capabilities degrade, never hang. This list is the bundle's
    // package preload list (it OVERRIDES package.json `dsh.client.inject`).
    return { apply, inject: ['slots'] }
  },
})
