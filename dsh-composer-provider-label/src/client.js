// dsh-composer-provider-label: CLIENT half — the whole visible feature lives here.
//
// One provider label beside the composer's model selector, now also the entry to
// a two-level provider/model picker. The core model seat
// (\`conversation.input.model\`) shows only the model name, so two providers
// serving the same model (ark / codemaker / bai / openroputer all carry
// \`deepseek-v4-flash\` in a typical settings.yaml) are indistinguishable. This
// plugin registers one compact entry into the EMPTY \`conversation.input.right\`
// list slot (InputBar.tsx:461-467 renders it immediately left of the model
// seat), so the row reads \`office · DeepSeek-V4-Flash · high\` with zero DOM
// injection and zero shadowing of the shipped model seat.
//
// DATA (all public contract, same resolution rule the core directory uses —
// \`projection.next ?? catalog.default\`):
//   - current route  -> \`useProjection('modelSelection')\` standard slot prop
//   - display names  -> \`remote.session.modelCatalog()\` (group.name), one call
//                       cached per host generation, refreshed on the same three
//                       signals core's ModelDirectoryResolver listens to
//                       (\`llm/adapters-updated\`, \`settings/document-updated\`,
//                       \`connection/reset\`)
//   - short names    -> built-in {deepseek-official → office}, overlaid by the
//                       optional \`dsh-composer-provider-label.providerAliases\`
//                       settings section (read once via remote.settings.describe;
//                       note: that section only installs when the host half can
//                       resolve schemastery — it cannot in a \`link:\` install, so
//                       in practice the built-in aliases are what ship)
//
// WRITE (single whitelisted verb): \`remote.session.selectModel({sessionId,
// provider, model, reasoningEffort?})\` — the only state-changing call this
// bundle may make (audited by the test harness). A selection is ALWAYS a
// complete provider+model pair: picking a provider resolves a model (keep the
// current one when it still belongs to that provider, else the profile default
// when it belongs there, else the provider's first advertised model). The host
// additionally persists the profile default as a side effect of that call —
// shipped behaviour, deliberately not announced in the UI.
//
// MENU: core \`Menu\` primitive (\`@deepseek-ai/dsh-client-ui-primitives\`),
// rendered IN PLACE with \`side='top'\` (same strategy as the shipped model seat;
// the portal mode only re-measures on open/scroll/resize, so a pane swap would
// leave the card mis-positioned). Panes are ours (\`root\` | \`provider\` | \`model\`)
// because the primitive's submenu rows cannot be opened programmatically, carry
// no selection mark, and disable the card's scroll cap. The display-scope
// toggle lives in the primitive's pinned \`footer\`; its value persists in
// localStorage only (no settings key — see the host-half note above).
//
// Everything degrades, never crashes: no session / no projection / no catalog
// yet / describe failing → render nothing or fall back to the raw provider id;
// a catalog failure surfaces a retry entry; a client without the \`Menu\`
// primitive falls back to the v1 read-only label.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// \`require\` and returns { apply, inject }. No JSX: plain React.createElement.
// Theme tokens only (--dsw-alias-*), never hardcoded colours.

window.__ModuleLoader__.load({
  id: 'dsh-composer-provider-label',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Tooltip = primitives.Tooltip
    // Optional: a client without the Menu primitive degrades to the v1 label.
    const Menu = primitives && primitives.Menu
    const IconChevronDownOutline14 = primitives && primitives.IconChevronDownOutline14

    const SLOT = 'conversation.input.right'
    const ROW_ID = 'composer-provider-label'
    const ROW_ORDER = 10
    const NS = 'composer-provider-label'
    const SETTINGS_NS = 'dsh-composer-provider-label'
    const STORE_KEY = 'dsh.composer-provider-label.v1'
    const SCOPE_ALL = 'all'
    const SCOPE_PROVIDER = 'provider'

    /** Default short-name map, mirrored by the node half (tests assert equality). */
    const BUILTIN_ALIASES = Object.freeze({ 'deepseek-official': 'office' })
    /** Tooltip line separator, matching core's \` · \` effort separator. */
    const SEP = ' · '
    /** Scope class on the menu wrapper; the injected stylesheet keys off it. */
    const PICKER_CLASS = 'cpl-picker'
    const STYLE_ID = 'dsh-composer-provider-label-style'
    /**
     * Visible height of the scrolling items area: five dense rows (34px) plus the
     * back row (34px), its separator (9px) and the card padding (8px) ≈ 224px.
     * A longer list scrolls inside the card instead of growing past the viewport
     * (in-place cards have no viewport clamping, so an unbounded list would push
     * its own first rows off screen).
     */
    const LIST_MAX_HEIGHT = 224

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'aria.provider': '模型提供方',
      'aria.select': '选择提供方与模型',
      'aria.busy': '正在切换模型',
      'tooltip.provider': '提供方',
      'tooltip.model': '模型',
      'tooltip.effort': '推理档',
      'tooltip.source': '路由来源',
      'source.explicit': '本会话显式选择',
      'source.reused': '沿用上一条请求',
      'source.default': '跟随 profile 默认',
      'menu.provider': '提供方',
      'menu.model': '模型',
      'menu.back': '返回',
      'menu.scope.all': '全部提供方',
      'menu.scope.provider': '仅当前提供方',
      'menu.retry': '重试加载',
      'menu.currentRoute': '当前路由',
      'menu.failed': '加载失败',
      'menu.empty.all': '暂无可用模型',
      'menu.empty.provider': '该提供方暂无可用模型',
      'menu.showAll': '切回全部提供方',
      'menu.unavailable': '该会话不允许切换模型',
      'menu.noModel': '未选择',
      'error.catalog': '模型目录加载失败',
      'error.write': '切换失败',
    }

    const enDict = {
      'aria.provider': 'Model provider',
      'aria.select': 'Choose provider and model',
      'aria.busy': 'Switching model',
      'tooltip.provider': 'Provider',
      'tooltip.model': 'Model',
      'tooltip.effort': 'Reasoning effort',
      'tooltip.source': 'Route source',
      'source.explicit': 'explicitly chosen for this session',
      'source.reused': 'carried over from the last request',
      'source.default': 'following the profile default',
      'menu.provider': 'Provider',
      'menu.model': 'Model',
      'menu.back': 'Back',
      'menu.scope.all': 'All providers',
      'menu.scope.provider': 'Current provider only',
      'menu.retry': 'Retry loading',
      'menu.currentRoute': 'Current route',
      'menu.failed': 'Failed to load',
      'menu.empty.all': 'No models available',
      'menu.empty.provider': 'No models for this provider',
      'menu.showAll': 'Show all providers',
      'menu.unavailable': 'This session cannot switch models',
      'menu.noModel': 'Not selected',
      'error.catalog': 'Failed to load the model catalog',
      'error.write': 'Switch failed',
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

    /** Re-render on locale snapshot changes (entries without the \`t\` seat). */
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
      scope: SCOPE_ALL,
      writes: 0,
      lastWrite: null,
      writeStatus: 'idle',
    }
    try { if (typeof window !== 'undefined') window.__cpl = __diag } catch { /* no window */ }

    // --- module cache: catalog + aliases + scope (per host generation) --------

    var __catalog = null
    var __catalogStatus = 'idle' // idle | loading | ready | error
    var __catalogGeneration = 0
    var __catalogInflight = null
    var __aliases = Object.assign({}, BUILTIN_ALIASES)
    var __aliasLoadQueued = false
    var __listeners = new Set()
    var __write = { status: 'idle', sessionId: null, message: null }

    function __notify() {
      for (const listener of [...__listeners]) {
        try { listener() } catch { /* one bad subscriber must not stall the rest */ }
      }
    }

    function __subscribe(listener) {
      __listeners.add(listener)
      return () => { __listeners.delete(listener) }
    }

    // --- display-scope preference (localStorage only; no settings key) --------

    /** localStorage access that also works inside the Node test harness. */
    function getStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage
      } catch { /* access denied */ }
      try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
      } catch { /* access denied */ }
      return null
    }

    /** Normalize a stored/raw value to one of the two supported scopes. */
    function parseScope(raw) {
      return raw === SCOPE_PROVIDER ? SCOPE_PROVIDER : SCOPE_ALL
    }

    function readScope(storage) {
      try {
        const raw = storage && storage.getItem(STORE_KEY)
        if (!raw) return SCOPE_ALL
        const parsed = JSON.parse(raw)
        return parseScope(parsed && parsed.scope)
      } catch {
        return SCOPE_ALL
      }
    }

    function writeScope(storage, scope) {
      try {
        if (storage) storage.setItem(STORE_KEY, JSON.stringify({ scope: parseScope(scope) }))
      } catch { /* storage full/unavailable: the in-memory scope still applies */ }
    }

    var __listScope = readScope(getStorage())
    __diag.scope = __listScope

    // --- scoped stylesheet (the one bit of DOM this bundle adds) --------------

    var __styleInjected = false

    /**
     * Cap the menu's scrolling area once per page. The core Menu primitive owns
     * the card's DOM, so the only way to bound its height is a scoped rule; the
     * selector is anchored to the className we hand the primitive, so it cannot
     * leak onto other menus. A missing head (tests, exotic clients) is a silent
     * skip: the primitive's own viewport cap still applies.
     */
    function ensureStyleSheet() {
      if (__styleInjected) return
      try {
        const doc = typeof document !== 'undefined' ? document : null
        const head = doc && doc.head
        if (!head || typeof doc.createElement !== 'function') return
        __styleInjected = true
        if (typeof doc.getElementById === 'function' && doc.getElementById(STYLE_ID)) return
        const style = doc.createElement('style')
        style.id = STYLE_ID
        style.textContent = '.' + PICKER_CLASS + ' [role="menu"] > div:first-child {'
          + ' max-height: ' + LIST_MAX_HEIGHT + 'px; overflow-y: auto; }'
        if (typeof head.appendChild === 'function') head.appendChild(style)
      } catch { /* no DOM: the primitive's own viewport cap still applies */ }
    }

    // --- service resolution (mirrors dsh-open-session-workdir's proven shape) --

    var __ctx = null
    var __scope = null
    var __session = null
    var __settings = null
    var __sessions = null
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

    /** The \`sessions\` client service, used only to detect subagent-owned sessions. */
    function __sessionsOf() {
      if (__sessions) return __sessions
      for (const scope of [__scope, __ctx]) {
        const service = __readService(scope, 'sessions')
        if (service) { __sessions = service; return service }
      }
      return null
    }

    /**
     * Whether this session may have its model route switched from the client.
     * Addressed subagent sessions cannot; when the service is unreachable we stay
     * optimistic and let the host reject (it answers \`session/agent-busy\`).
     */
    function canSelect(sessionId) {
      const sessions = __sessionsOf()
      try {
        if (sessions && typeof sessions.subagentAddress === 'function') {
          return sessions.subagentAddress(sessionId) === undefined
        }
      } catch { /* fall through to optimistic */ }
      return true
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

    /** Human-readable failure text from a RemoteResult envelope. */
    function __errorText(result) {
      if (result && typeof result === 'object' && result.error) {
        const code = result.error.code ? String(result.error.code) : ''
        const message = result.error.message ? String(result.error.message) : ''
        if (code && message) return code + ': ' + message
        return message || code
      }
      return __t('error.write')
    }

    // --- pure display helpers (exported on __diag for the harness) -------------

    /**
     * Strip a trailing parenthetical tail and its preceding space:
     * \`ARK (Coding Plan)\` -> \`ARK\`; \`A (B) (C)\` -> \`A (B)\` (last tail only);
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
     * Effective route = \`projection.next\` (session's durable next-request
     * selection) -> \`lastUsed\` -> catalog.default. Same rule as core's
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

    /** Advertised models of one provider (empty when unknown / failed). */
    function modelsOf(catalog, providerId) {
      if (!providerId || !catalog || !Array.isArray(catalog.groups)) return []
      const group = catalog.groups.find((entry) => entry && entry.id === providerId)
      return group && Array.isArray(group.models) ? group.models : []
    }

    /** The catalog entry for one exact route, or null. */
    function modelEntryOf(catalog, providerId, modelId) {
      const models = modelsOf(catalog, providerId)
      for (const model of models) {
        if (model && model.id === modelId) return model
      }
      return null
    }

    /** Short model label: display name with its parenthetical tail stripped. */
    function modelShortNameOf(model, modelId) {
      if (model && typeof model.name === 'string' && model.name) {
        return stripParenthetical(model.name) || model.name
      }
      return modelId ? String(modelId) : ''
    }

    /** Localized label of an effort id for one catalog model, or undefined. */
    function effortLabelOf(model, effortId) {
      if (!model || !model.reasoning || !Array.isArray(model.reasoning.efforts)) return undefined
      if (effortId === undefined || effortId === null || effortId === '') return undefined
      const found = model.reasoning.efforts.find((entry) => entry && entry.id === effortId)
      return found && typeof found.name === 'string' && found.name ? found.name : String(effortId)
    }

    /** The effort the effective route would use (explicit, else the model default). */
    function effectiveEffortOf(route, model) {
      if (route && route.reasoningEffort) return route.reasoningEffort
      if (model && model.reasoning && model.reasoning.defaultEffort) return model.reasoning.defaultEffort
      return undefined
    }

    /**
     * Resolve the complete selection a provider click must submit.
     * Keep the current model when it still belongs to the clicked provider;
     * otherwise prefer the profile default when it belongs there; otherwise the
     * provider's first advertised model. The current effort is preserved only
     * when the new model still advertises it.
     */
    function chooseSelection(providerId, current, catalog) {
      if (!providerId) return null
      const models = modelsOf(catalog, providerId)
      const currentModelId = current && current.provider === providerId ? current.model : null
      let modelId = null
      if (currentModelId && models.some((model) => model && model.id === currentModelId)) {
        modelId = currentModelId
      } else {
        const fallback = catalog && catalog.default && catalog.default.provider === providerId
          ? catalog.default.model
          : null
        if (fallback && models.some((model) => model && model.id === fallback)) {
          modelId = fallback
        } else if (models.length > 0) {
          modelId = models[0].id
        }
      }
      if (!modelId) return null
      const entry = modelEntryOf(catalog, providerId, modelId)
      const wanted = current && current.reasoningEffort
      const effort = wanted && entry && entry.reasoning && Array.isArray(entry.reasoning.efforts)
        && entry.reasoning.efforts.some((level) => level && level.id === wanted)
        ? wanted
        : undefined
      return { provider: providerId, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    }

    /**
     * Rows of the provider level, in catalog order, plus failures (disabled) and
     * a synthetic first row when the current provider is not advertised.
     */
    function providerRows(catalog, currentProviderId, aliases) {
      const rows = []
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      const failures = catalog && Array.isArray(catalog.failures) ? catalog.failures : []
      const advertised = new Set(groups.map((group) => group && group.id).filter(Boolean))
      if (currentProviderId && !advertised.has(currentProviderId)) {
        rows.push({
          id: currentProviderId,
          label: shortNameOf(currentProviderId, catalog, aliases),
          detail: providerDisplayName(currentProviderId, catalog) || currentProviderId,
          current: true,
          synthetic: true,
          disabled: false,
          failure: null,
        })
      }
      for (const group of groups) {
        if (!group || !group.id) continue
        rows.push({
          id: group.id,
          label: shortNameOf(group.id, catalog, aliases),
          detail: typeof group.name === 'string' ? group.name : group.id,
          current: group.id === currentProviderId,
          synthetic: false,
          disabled: false,
          failure: null,
        })
      }
      for (const failure of failures) {
        if (!failure || !failure.id) continue
        if (advertised.has(failure.id)) continue // advertised wins; never emit a duplicate id
        rows.push({
          id: failure.id,
          label: shortNameOf(failure.id, catalog, aliases),
          detail: typeof failure.name === 'string' ? failure.name : failure.id,
          current: failure.id === currentProviderId,
          synthetic: false,
          disabled: true,
          failure: typeof failure.message === 'string' ? failure.message : '',
        })
      }
      return rows
    }

    /**
     * Rows of the model level for one display scope. \`all\` emits a heading per
     * provider (alias + display name) followed by its models; \`provider\` emits
     * only the current provider's models and no heading.
     */
    function modelRows(catalog, current, scope, aliases) {
      const rows = []
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      const wanted = parseScope(scope) === SCOPE_PROVIDER ? (current && current.provider) : null
      for (const group of groups) {
        if (!group || !group.id || !Array.isArray(group.models)) continue
        if (wanted && group.id !== wanted) continue
        if (!wanted) {
          rows.push({
            kind: 'heading',
            id: 'heading:' + group.id,
            text: shortNameOf(group.id, catalog, aliases) + SEP + (group.name || group.id),
          })
        }
        for (const model of group.models) {
          if (!model || !model.id) continue
          rows.push({
            kind: 'model',
            id: 'model:' + group.id + ':' + model.id,
            provider: group.id,
            model: model.id,
            label: modelShortNameOf(model, model.id),
            detail: model.id,
            selected: !!(current && current.provider === group.id && current.model === model.id),
          })
        }
      }
      return rows
    }

    // --- catalog + aliases loading (render-driven, one in-flight each) ---------

    function __invalidateCatalog(clear) {
      __catalogGeneration += 1
      __catalogInflight = null
      __catalogStatus = 'idle'
      if (clear) __catalog = null
    }

    function __startCatalogLoad(session, force) {
      if (__catalogInflight) return
      if (!session || typeof session.modelCatalog !== 'function') return
      if (force) __invalidateCatalog(false)
      const generation = __catalogGeneration
      __catalogStatus = 'loading'
      __diag.catalogStatus = 'loading'
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
          __diag.catalogStatus = __catalogStatus
          __notify()
        })
        .catch(() => {
          if (generation !== __catalogGeneration) return
          __catalogStatus = 'error'
          __diag.catalogStatus = 'error'
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
        // Only the initial/invalidated state loads implicitly. A failure waits for
        // the retry entry: auto-retrying on every render would storm the host and
        // flicker the error entry between 'loading' and 'error'.
        if (__catalogStatus === 'idle') __startCatalogLoad(session)
      }
      const settings = __settingsOf()
      if (settings && typeof settings.describe === 'function' && !__aliasLoadQueued) {
        __aliasLoadQueued = true
        __loadAliases(settings)
      }
    }

    // --- the write path (the ONLY state-changing call in this bundle) ---------

    /**
     * Submit one complete selection for one session. Returns whether the host
     * accepted it; every outcome lands on the shared write state so the label
     * can show busy/error without a toast.
     */
    function __selectRoute(session, sessionId, selection) {
      if (!session || typeof session.selectModel !== 'function' || !selection) {
        __write = { status: 'error', sessionId, message: __t('error.write') }
        __diag.writeStatus = 'error'
        __notify()
        return Promise.resolve(false)
      }
      __write = { status: 'selecting', sessionId, message: null }
      __diag.writeStatus = 'selecting'
      __diag.lastWrite = {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }
      __notify()
      const request = {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
      __diag.writes += 1
      return Promise.resolve()
        .then(() => session.selectModel(request))
        .then((result) => {
          if (!__isOk(result)) {
            __write = { status: 'error', sessionId, message: __errorText(result) }
            __diag.writeStatus = 'error'
            __notify()
            return false
          }
          __write = { status: 'idle', sessionId: null, message: null }
          __diag.writeStatus = 'idle'
          __notify()
          return true
        })
        .catch((error) => {
          __write = {
            status: 'error',
            sessionId,
            message: String(error && error.message ? error.message : error),
          }
          __diag.writeStatus = 'error'
          __notify()
          return false
        })
    }

    // --- the label + menu -----------------------------------------------------

    const labelStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '2px',
      maxWidth: '11em',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flex: 'none',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      background: 'transparent',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      font: 'inherit',
    }

    const readOnlyStyle = Object.assign({}, labelStyle, { cursor: 'default' })

    const errorDotStyle = {
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      marginLeft: '4px',
      background: 'var(--dsw-alias-state-error-primary)',
      flex: 'none',
    }

    const rowLabelStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      minWidth: 0,
    }

    const rowTitleStyle = { flex: 'none', color: 'var(--dsw-alias-label-primary)' }
    const rowValueStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      textAlign: 'right',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const rowChevronStyle = { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' }

    const rowCopyStyle = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: '2px' }
    const rowDetailStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '12px',
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** Two-column row: title on the left, current value + chevron on the right. */
    function entryRow(title, value) {
      return React.createElement('span', { style: rowLabelStyle }, [
        React.createElement('span', { key: 'title', style: rowTitleStyle }, title),
        React.createElement('span', { key: 'value', style: rowValueStyle }, value),
        React.createElement('span', { key: 'chevron', style: rowChevronStyle },
          IconChevronDownOutline14
            ? React.createElement(IconChevronDownOutline14, { className: undefined })
            : '\u203A'),
      ])
    }

    /** Stacked row: primary label over a muted detail line. */
    function stackedRow(label, detail, extra) {
      const children = [
        React.createElement('span', { key: 'label', style: { color: 'var(--dsw-alias-label-primary)' } }, label),
      ]
      if (detail) children.push(React.createElement('span', { key: 'detail', style: rowDetailStyle }, detail))
      if (extra) children.push(React.createElement('span', { key: 'extra', style: rowDetailStyle }, extra))
      return React.createElement('span', { style: rowCopyStyle }, children)
    }

    /**
     * Render the composer entry: the v1 read-only label when the Menu primitive
     * is unavailable, otherwise the label plus the two-level picker.
     */
    function ProviderLabel({ sessionId, useProjection }) {
      useLocaleRevision()
      // Hooks stay unconditional; the early returns below come after them.
      const projection = typeof useProjection === 'function'
        ? useProjection('modelSelection')
        : undefined
      const [, force] = useState(0)
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [focused, setFocused] = useState(false)
      useEffect(() => {
        __diag.mounted += 1
        return __subscribe(() => force((value) => value + 1))
      }, [])
      __ensureLoaded()

      if (!sessionId) return null
      const session = __sessionOf()
      const route = resolveRoute(projection, __catalog)
      const catalogFailed = __catalogStatus === 'error'

      // No known route yet: only a catalog failure is worth an entry point.
      if (!route || !route.provider) {
        if (!catalogFailed || !Menu) return null
        const retry = () => { __startCatalogLoad(session, true) }
        return React.createElement(
          Tooltip,
          { label: __t('error.catalog'), side: 'top', delayMs: 300 },
          React.createElement('button', {
            type: 'button',
            'aria-label': __t('error.catalog'),
            onClick: retry,
            style: Object.assign({}, labelStyle, { color: 'var(--dsw-alias-state-error-primary)' }),
          }, '!'),
        )
      }

      const providerId = route.provider
      const modelId = typeof route.model === 'string' && route.model ? route.model : ''
      const fullName = providerDisplayName(providerId, __catalog) || providerId
      const shortName = shortNameOf(providerId, __catalog, __aliases)
      const sourceKey = routeSourceKey(projection, route)
      const modelEntry = modelEntryOf(__catalog, providerId, modelId)
      const modelShort = modelId ? modelShortNameOf(modelEntry, modelId) : ''
      const effort = effectiveEffortOf(route, modelEntry)
      const effortLabel = effortLabelOf(modelEntry, effort)

      __diag.lastProvider = providerId
      __diag.lastShort = shortName
      __diag.catalogStatus = __catalogStatus

      const busy = __write.status === 'selecting' && __write.sessionId === sessionId
      const writeFailed = __write.status === 'error' && __write.sessionId === sessionId
      const writable = canSelect(sessionId)

      const tooltipLines = [
        __t('tooltip.provider') + ': ' + fullName,
        __t('tooltip.model') + ': ' + (modelId || __t('menu.noModel')),
      ]
      if (effortLabel !== undefined) tooltipLines.push(__t('tooltip.effort') + ': ' + effortLabel)
      tooltipLines.push(__t('tooltip.source') + ': ' + __t(sourceKey))
      if (catalogFailed) tooltipLines.push(__t('error.catalog'))
      if (writeFailed && __write.message) tooltipLines.push(__t('error.write') + ': ' + __write.message)
      const tooltip = tooltipLines.join(SEP)

      const aria = busy
        ? __t('aria.busy')
        : __t('aria.provider') + ': ' + shortName

      const anchorChildren = [shortName]
      if (writeFailed || catalogFailed) {
        anchorChildren.push(React.createElement('span', { key: 'error', style: errorDotStyle }))
      }
      if (focused || open) {
        anchorChildren.push(React.createElement('span', {
          key: 'chevron',
          style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
        }, IconChevronDownOutline14
          ? React.createElement(IconChevronDownOutline14, { className: undefined })
          : '\u203A'))
      }

      // Degrade: no Menu primitive -> the v1 read-only label.
      if (!Menu) {
        return React.createElement(
          Tooltip,
          { label: tooltip, side: 'top', delayMs: 500 },
          React.createElement('span', {
            style: Object.assign({}, readOnlyStyle, busy ? { opacity: 0.6 } : null),
            'aria-label': aria,
            role: 'text',
            tabIndex: 0,
          }, anchorChildren),
        )
      }

      const close = () => { setOpen(false); setPane('root') }
      const actions = {}
      const items = []
      const footer = []
      const selectedIds = []

      const pushItem = (id, label, options) => {
        items.push({ id, label, ...(options && options.disabled ? { disabled: true } : {}) })
        if (options && options.action) actions[id] = options.action
      }
      const pushSeparator = (id) => { items.push({ type: 'separator', id }) }
      const pushHeading = (id, text) => { items.push({ type: 'label', id, text }) }

      const catalog = __catalog
      const retryRow = () => {
        pushItem('retry', __t('menu.retry'), {
          action: () => { __startCatalogLoad(session, true) },
        })
        pushSeparator('sep:retry')
      }

      if (pane === 'root') {
        if (catalogFailed || (catalog && Array.isArray(catalog.failures) && catalog.failures.length > 0)) retryRow()
        pushItem('provider', entryRow(__t('menu.provider'), shortName), { action: () => setPane('provider') })
        pushItem('model', entryRow(__t('menu.model'), modelShort || __t('menu.noModel')), { action: () => setPane('model') })
      }

      if (pane === 'provider') {
        pushItem('back', '\u2039 ' + __t('menu.back'), { action: () => setPane('root') })
        pushSeparator('sep:back')
        const rows = providerRows(catalog, providerId, __aliases)
        for (const row of rows) {
          if (row.current) selectedIds.push('provider:' + row.id)
          const detail = row.synthetic ? __t('menu.currentRoute') + SEP + row.detail : row.detail
          const extra = row.failure ? __t('menu.failed') + ': ' + row.failure : undefined
          pushItem('provider:' + row.id, stackedRow(row.label, detail, extra), {
            disabled: row.disabled || !writable,
            action: () => {
              if (!writable) return
              const selection = chooseSelection(row.id, route, catalog)
              if (!selection) return
              void __selectRoute(session, sessionId, selection).then((ok) => { if (ok) setPane('model') })
            },
          })
        }
      }

      if (pane === 'model') {
        pushItem('back', '\u2039 ' + __t('menu.back'), { action: () => setPane('root') })
        pushSeparator('sep:back')
        if (catalogFailed || (catalog && Array.isArray(catalog.failures) && catalog.failures.length > 0)) retryRow()
        const rows = modelRows(catalog, route, __listScope, __aliases)
        for (const row of rows) {
          if (row.kind === 'heading') { pushHeading(row.id, row.text); continue }
          if (row.selected) selectedIds.push(row.id)
          pushItem(row.id, stackedRow(row.label, row.detail), {
            disabled: !writable,
            action: () => {
              if (!writable) return
              const entry = modelEntryOf(catalog, row.provider, row.model)
              const wanted = route && route.reasoningEffort
              const keep = wanted && entry && entry.reasoning && Array.isArray(entry.reasoning.efforts)
                && entry.reasoning.efforts.some((level) => level && level.id === wanted)
                ? wanted
                : undefined
              void __selectRoute(session, sessionId, {
                provider: row.provider,
                model: row.model,
                ...(keep === undefined ? {} : { reasoningEffort: keep }),
              }).then((ok) => { if (ok) close() })
            },
          })
        }
        if (rows.length === 0) {
          pushItem('empty', __listScope === SCOPE_PROVIDER ? __t('menu.empty.provider') : __t('menu.empty.all'), {
            disabled: true,
          })
          if (__listScope === SCOPE_PROVIDER) {
            pushItem('scope:all', __t('menu.showAll'), {
              action: () => {
                __listScope = SCOPE_ALL
                __diag.scope = __listScope
                writeScope(getStorage(), __listScope)
                __notify()
              },
            })
          }
        }
      }

      if (!writable) {
        pushSeparator('sep:unavailable')
        pushItem('unavailable', __t('menu.unavailable'), { disabled: true })
      }

      footer.push({ id: 'scope:all', label: __t('menu.scope.all') })
      footer.push({ id: 'scope:provider', label: __t('menu.scope.provider') })
      selectedIds.push(__listScope === SCOPE_ALL ? 'scope:all' : 'scope:provider')
      actions['scope:all'] = () => {
        __listScope = SCOPE_ALL
        __diag.scope = __listScope
        writeScope(getStorage(), __listScope)
        __notify()
      }
      actions['scope:provider'] = () => {
        __listScope = SCOPE_PROVIDER
        __diag.scope = __listScope
        writeScope(getStorage(), __listScope)
        __notify()
      }

      const onSelect = (id) => {
        const action = actions[id]
        if (typeof action === 'function') action()
      }

      const anchor = React.createElement(
        Tooltip,
        { label: tooltip, side: 'top', delayMs: 500 },
        React.createElement('button', {
          type: 'button',
          style: Object.assign({}, labelStyle, busy ? { opacity: 0.6 } : null),
          'aria-label': aria,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-busy': busy || undefined,
          disabled: false,
          onMouseEnter: () => setFocused(true),
          onMouseLeave: () => setFocused(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onClick: () => { if (open) close(); else setOpen(true) },
        }, anchorChildren),
      )

      return React.createElement(Menu, {
        open,
        anchor,
        items,
        footer,
        selectedIds,
        onSelect,
        onClose: close,
        side: 'top',
        align: 'start',
        dense: true,
        className: PICKER_CLASS,
      })
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
      // Never read \`ctx.remote\` as a bare property here: on a real guarded
      // context an uninjected service name throws \`cannot get property
      // "remote" without inject\`. __readService swallows that; the property
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
      ensureStyleSheet()

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
      __sessions = __readService(ctx, 'sessions')
      if (!__sessions) {
        ctx.inject(['sessions'], (sub) => {
          __scope = sub
          __sessions = __readService(sub, 'sessions')
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

    // Pure display/selection helpers exposed for the logic harness (read-only;
    // the browser ignores them). Mirrors the window.__dshr diagnostics affordance.
    __diag.pure = {
      stripParenthetical,
      providerDisplayName,
      shortNameOf,
      resolveRoute,
      routeSourceKey,
      modelsOf,
      modelEntryOf,
      modelShortNameOf,
      effortLabelOf,
      effectiveEffortOf,
      chooseSelection,
      providerRows,
      modelRows,
      parseScope,
      readScope,
      writeScope,
      canSelect,
      BUILTIN_ALIASES,
      STORE_KEY,
      SCOPE_ALL,
      SCOPE_PROVIDER,
      LIST_MAX_HEIGHT,
      PICKER_CLASS,
    }

    // The loader gates apply() until \`slots\` exists (to register the right-slot
    // entry). remote.session / remote.settings / remote / sessions / locale are
    // wired lazily through separate ctx.inject calls so no single wait can block
    // the row — missing capabilities degrade, never hang. This list is the
    // bundle's package preload list (it OVERRIDES package.json \`dsh.client.inject\`).
    return { apply, inject: ['slots'] }
  },
})
