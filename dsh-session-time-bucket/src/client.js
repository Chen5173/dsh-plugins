// dsh-session-time-bucket: CLIENT half — the whole feature lives here.
//
// Follow-the-core architecture (no own entry, no popover, no full-section
// takeover):
//   · the plugin rides the core "单列表 + 最近更新" view: it reads the workspace
//     browser viewing store that the core persists under localStorage key
//     'dsh.workspace.view.v5' ({ groupBy: 'workspace'|'flat', orderBy:
//     'manual'|'updated', ... }); while the core is in flat + updated mode the
//     plugin hides ONLY the core list area and renders the same sessions as
//     time buckets — 今天 / 昨天 / 前7天 / 前30天 / 更早 by local calendar day,
//     newest-first inside each bucket.
//   · the core section header stays fully visible and live (分组方式 / 排序方式
//     menus, search, ＋新建) — switching back to 按工作区 or 手动排序, or starting
//     a search, exits the enhancement automatically and restores the core list.
//   · rows ALWAYS carry the owning workspace prefix: [工作区] 标题, or [未分组] 标题
//     for sessions outside every workspace; plus a trailing relative time.
//     Group headers show a count and fold (chevron + hover, folded state
//     persisted under 'dsh.sessionTimeBucket.v1').
//   · rail (icon) sidebar and search mode never take over.
//
// Data comes only from two core client services (never scraping the DOM):
//   - sessions  -> list.getSnapshot() { ids, byId: {SessionSummary}, current }
//   - workspaces-> list.getSnapshot() { items: WorkspaceView[], archivedSessionIds }
// Sessions open via sessions.open(id).
//
// No React: plain DOM + inline styles + --dsw-* tokens. A 1s reconcile watcher
// re-reads the core view store and re-asserts the takeover / exit; services
// subscribe for instant re-renders while active.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); returns { apply, inject: ['slots'] }.
window.__ModuleLoader__.load({
  id: 'dsh-session-time-bucket',
  factory: (require) => {
    const NS = 'session-time-bucket'
    const STORE_KEY = 'dsh.sessionTimeBucket.v1'
    const CORE_VIEW_KEY = 'dsh.workspace.view.v5'
    const BUCKET_ORDER = ['today', 'yesterday', 'last7', 'last30', 'older']
    const DAY_MS = 86400000

    // --- locale ---------------------------------------------------------------
    const zhDict = {
      'bucket.today': '今天',
      'bucket.yesterday': '昨天',
      'bucket.last7': '前7天',
      'bucket.last30': '前30天',
      'bucket.older': '更早',
      'ungrouped': '未分组',
      'session.new': '新会话',
      'empty.none': '暂无会话',
      'err.noServices': '缺少会话/工作区服务，时间桶模式不可用',
      'err.open': '打开会话失败',
      'rel.now': '刚刚',
      'rel.minute': '{n}分钟前',
      'rel.hour': '{n}小时前',
      'rel.day': '{n}天前',
      'rel.month': '{n}个月前',
      'rel.year': '{n}年前',
    }
    const enDict = {
      'bucket.today': 'Today',
      'bucket.yesterday': 'Yesterday',
      'bucket.last7': 'Last 7 days',
      'bucket.last30': 'Last 30 days',
      'bucket.older': 'Older',
      'ungrouped': 'Ungrouped',
      'session.new': 'New Session',
      'empty.none': 'No sessions',
      'err.noServices': 'Session/workspace services unavailable; time-bucket mode is off',
      'err.open': 'Failed to open session',
      'rel.now': 'just now',
      'rel.minute': '{n}m ago',
      'rel.hour': '{n}h ago',
      'rel.day': '{n}d ago',
      'rel.month': '{n}mo ago',
      'rel.year': '{n}y ago',
    }

    var __locale = null
    function localeLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }
    function __t(key) {
      if (__locale && typeof __locale.t === 'function') {
        try {
          const localized = __locale.t(NS, key)
          if (localized != null && String(localized) !== key) return String(localized)
        } catch { /* fall through */ }
      }
      const dict = localeLang() === 'en' ? enDict : zhDict
      return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
    }

    // --- services -------------------------------------------------------------
    var __ctx = null
    var __scope = null
    var __sessions = null
    var __workspaces = null
    var __servicesOk = false
    var __subscribed = false

    function __readService(scope, name) {
      if (!scope) return null
      try { if (typeof scope.get === 'function') { const viaGet = scope.get(name); if (viaGet) return viaGet } } catch { /* */ }
      try { if (scope[name]) return scope[name] } catch { /* */ }
      return null
    }
    function __lookup(name) {
      for (const scope of [__scope, __ctx]) { const found = __readService(scope, name); if (found) return found }
      return null
    }
    function refreshServiceStatus() {
      const sessions = __sessions || __lookup('sessions')
      if (sessions) __sessions = sessions
      const workspaces = __workspaces || __lookup('workspaces')
      if (workspaces) __workspaces = workspaces
      __servicesOk = !!(
        __sessions && __sessions.list && typeof __sessions.list.getSnapshot === 'function'
        && __workspaces && __workspaces.list && typeof __workspaces.list.getSnapshot === 'function'
        && typeof __sessions.open === 'function'
      )
      if (__servicesOk) ensureSubscriptions()
      return __servicesOk
    }
    function ensureSubscriptions() {
      if (__subscribed || !__servicesOk) return
      try {
        if (__sessions.list && typeof __sessions.list.subscribe === 'function') __sessions.list.subscribe(() => { if (__mode) renderList() })
        if (__workspaces.list && typeof __workspaces.list.subscribe === 'function') __workspaces.list.subscribe(() => { if (__mode) renderList() })
        __subscribed = true
      } catch { /* best-effort */ }
    }

    // --- persistence (folded buckets only) ------------------------------------
    /** localStorage access that also works inside the Node test harness
     *  (which stubs window.localStorage but has no global localStorage). */
    function getStorage() {
      try {
        if (typeof localStorage !== 'undefined') return localStorage
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
      } catch { /* */ }
      return null
    }
    function readStore() {
      const storage = getStorage()
      try {
        const raw = storage && storage.getItem(STORE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          return {
            folded: Array.isArray(parsed.folded) ? parsed.folded.filter((k) => BUCKET_ORDER.indexOf(k) >= 0) : [],
          }
        }
      } catch { /* storage unavailable */ }
      return { folded: [] }
    }
    function writeStore(state) {
      const storage = getStorage()
      try {
        if (storage) storage.setItem(STORE_KEY, JSON.stringify({
          folded: Array.isArray(state.folded) ? state.folded.filter((k) => BUCKET_ORDER.indexOf(k) >= 0) : [],
        }))
      } catch { /* never break the UI over persistence */ }
    }
    var __store = readStore()
    function isBucketFolded(key) { return Array.isArray(__store.folded) && __store.folded.indexOf(key) >= 0 }
    function setBucketFolded(key, folded) {
      const set = new Set(Array.isArray(__store.folded) ? __store.folded : [])
      if (folded) set.add(key); else set.delete(key)
      __store.folded = BUCKET_ORDER.filter((k) => set.has(k))
      writeStore(__store)
      renderList()
    }

    // --- core view follower ---------------------------------------------------
    /** Read the workspace browser viewing store the core persists on every change. */
    function readCoreView() {
      const storage = getStorage()
      try {
        const raw = storage && storage.getItem(CORE_VIEW_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return { groupBy: parsed.groupBy, orderBy: parsed.orderBy }
      } catch { return null }
    }
    /** True only while the core is in 单列表 (flat) + 最近更新 (updated) mode. */
    function isFlatUpdatedView() {
      const view = readCoreView()
      return !!view && view.groupBy === 'flat' && view.orderBy === 'updated'
    }

    // --- pure bucketing / projection (exposed for the logic harness) ----------
    function startOfLocalDay(ms) {
      const d = new Date(ms)
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    }
    function bucketKeyOf(updatedAtMs, nowMs) {
      const startToday = startOfLocalDay(nowMs)
      if (updatedAtMs >= startToday) return 'today'
      if (updatedAtMs >= startToday - DAY_MS) return 'yesterday'
      if (updatedAtMs >= startToday - 7 * DAY_MS) return 'last7'
      if (updatedAtMs >= startToday - 30 * DAY_MS) return 'last30'
      return 'older'
    }
    function workspaceTitleBySession(items) {
      const map = {}
      for (const item of items || []) {
        const title = item && (item.title || '')
        for (const id of (item.sessionIds || [])) if (map[id] === undefined) map[id] = title
      }
      return map
    }
    function collectRows(list, archived, titleBySession) {
      const archivedSet = new Set(archived || [])
      const rows = []
      const byId = (list && list.byId) || {}
      const current = list && list.current
      for (const id of Object.keys(byId)) {
        const s = byId[id]
        if (!s) continue
        if (s.origin === 'subagent') continue
        if (archivedSet.has(id)) continue
        if (s.blank === true && id !== current) continue
        rows.push({
          id,
          title: s.blank === true ? '' : String(s.displayTitle || s.title || ''),
          blank: s.blank === true,
          current: id === current,
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
          wsTitle: titleBySession[id],
        })
      }
      return rows
    }
    function rowTitle(row, showWorkspace, ungroupedLabel) {
      if (row.blank) return ''
      if (!showWorkspace) return row.title
      return '[' + (row.wsTitle ? row.wsTitle : ungroupedLabel) + '] ' + row.title
    }
    function deriveBuckets(rows, nowMs) {
      const buckets = {}
      for (const key of BUCKET_ORDER) buckets[key] = []
      for (const row of rows || []) buckets[bucketKeyOf(row.updatedAt, nowMs)].push(row)
      const out = []
      for (const key of BUCKET_ORDER) {
        const list = buckets[key]
        if (list.length === 0) continue
        list.sort((a, b) => (b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))))
        out.push({ key, rows: list })
      }
      return out
    }
    function relativeLabel(ms, nowMs, resolve) {
      const ref = typeof nowMs === 'number' ? nowMs : Date.now()
      const diff = Math.max(0, ref - ms)
      const MIN = 60000
      const HOUR = 3600000
      const interpolate = (key, n) => String(resolve(key) || key).replace('{n}', String(n))
      if (diff < MIN) return interpolate('rel.now', 0)
      if (diff < HOUR) return interpolate('rel.minute', Math.floor(diff / MIN))
      if (diff < DAY_MS) return interpolate('rel.hour', Math.floor(diff / HOUR))
      if (diff < 30 * DAY_MS) return interpolate('rel.day', Math.max(1, Math.floor(diff / DAY_MS)))
      if (diff < 365 * DAY_MS) return interpolate('rel.month', Math.max(1, Math.floor(diff / (30 * DAY_MS))))
      return interpolate('rel.year', Math.max(1, Math.floor(diff / (365 * DAY_MS))))
    }

    // --- DOM helpers ----------------------------------------------------------
    function el(tag, attrs, children) {
      const node = document.createElement(tag)
      if (attrs) {
        for (const key of Object.keys(attrs)) {
          const value = attrs[key]
          if (value == null) continue
          if (key === 'style' && typeof value === 'object') { for (const prop of Object.keys(value)) node.style[prop] = value[prop] }
          else if (key === 'class') { node.className = value }
          else if (key === 'text') { node.textContent = value }
          else if (key === 'html') { node.innerHTML = value }
          else if (key.startsWith('data-')) { node.setAttribute(key, value) }
          else { node.setAttribute(key, value) }
        }
      }
      for (const child of children || []) {
        if (child == null) continue
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      return node
    }

    const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

    // --- live state -----------------------------------------------------------
    var __mode = false
    var __core = null
    var __host = null             // list replacement node (status line + bucket list)
    var __hostList = null
    var __statusEl = null
    var __statusTimer = null
    var __watch = null

    // --- anchors --------------------------------------------------------------
    function findViewButton() {
      const candidates = document.querySelectorAll('button')
      for (let i = 0; i < candidates.length; i++) {
        const label = String(candidates[i].getAttribute('aria-label') || '').trim()
        if (label === '视图选项' || label === 'View options') return candidates[i]
      }
      return null
    }
    function locateCore() {
      try {
        const viewButton = findViewButton()
        if (!viewButton) return null
        const headerActions = viewButton.closest('[class*="headerActions"]') || viewButton.parentElement
        const header = headerActions && (headerActions.closest('[class*="sectionHeader"]') || headerActions.parentElement)
        if (!header) return null
        const root = header.parentElement
        if (!root) return null
        const listArea = root.querySelector('[class*="listArea"]')
        const rail = !!root.className && String(root.className).indexOf('rail') >= 0
        return { header, root, listArea, rail }
      } catch { return null }
    }
    /** Search expansion swaps the flat list for the search tree inside listArea:
     *  never take over while a search is active. */
    function isSearchActive(root) {
      if (!root) return false
      try {
        if (root.querySelector('[class*="searchExpanded"]')) return true
        if (root.querySelector('[class*="searchTree"]')) return true
      } catch { /* */ }
      return false
    }

    // --- takeover UI ----------------------------------------------------------
    function statusText(text, isError) {
      if (!__statusEl) return
      __statusEl.textContent = text
      __statusEl.style.display = 'block'
      __statusEl.style.color = isError ? 'var(--dsw-alias-text-danger, #ff6b6b)' : 'var(--dsw-alias-label-tertiary, #8a8a8e)'
      if (__statusTimer) { clearTimeout(__statusTimer); __statusTimer = null }
      __statusTimer = setTimeout(() => {
        if (__statusEl) __statusEl.style.display = 'none'
        __statusTimer = null
      }, 3000)
    }

    function hideCoreList() {
      if (!__core) return
      if (__core.listArea) __core.listArea.style.display = 'none'
    }
    function restoreCoreList() {
      if (!__core) return
      if (__core.listArea) __core.listArea.style.display = ''
    }
    function mountHost() {
      if (__host && document.contains(__host)) return
      const core = __core
      if (!core || !core.root) return
      const host = el('div', {
        'data-dsh-time-bucket-host': '1',
        style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 },
      })
      __statusEl = el('div', {
        'data-dsh-time-bucket-status': '1',
        style: { display: 'none', fontSize: 11, lineHeight: '15px', padding: '4px 12px 0', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' },
      })
      host.appendChild(__statusEl)
      __hostList = el('div', { 'data-dsh-time-bucket-list': '1', style: { flex: '1 1 auto', overflowY: 'auto', padding: '2px 4px 12px' } })
      host.appendChild(__hostList)
      try {
        if (core.listArea && core.listArea.nextSibling) core.root.insertBefore(host, core.listArea.nextSibling)
        else core.root.appendChild(host)
      } catch { try { core.root.appendChild(host) } catch { /* */ } }
      __host = host
    }
    function unmountHost() {
      if (__host) { try { __host.remove() } catch { /* */ } }
      __host = null
      __hostList = null
      __statusEl = null
    }

    // --- rendering ------------------------------------------------------------
    function renderList() {
      if (!__mode || !__hostList || !__servicesOk) return
      try {
        const nowMs = Date.now()
        const listSnap = __sessions.list.getSnapshot()
        const wsSnap = __workspaces.list.getSnapshot()
        const items = (wsSnap && wsSnap.items) || []
        const archived = (wsSnap && wsSnap.archivedSessionIds) || []
        const rows = collectRows(listSnap, archived, workspaceTitleBySession(items))
        const buckets = deriveBuckets(rows, nowMs)
        const ungroupedLabel = __t('ungrouped')
        __hostList.textContent = ''
        if (buckets.length === 0) {
          __hostList.appendChild(el('div', { text: __t('empty.none'), style: { padding: '18px 12px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: 12, textAlign: 'center' } }))
          return
        }
        for (const bucket of buckets) {
          const key = bucket.key
          const folded = isBucketFolded(key)
          const head = el('button', {
            type: 'button',
            'data-dsh-time-bucket-group': key,
            'aria-expanded': folded ? 'false' : 'true',
            style: {
              display: 'flex', alignItems: 'center', gap: 4, width: '100%', margin: '2px 0',
              padding: '6px 10px', border: 'none', background: 'transparent', borderRadius: 6,
              cursor: 'pointer', textAlign: 'left', fontSize: 13, lineHeight: '18px',
              color: 'var(--dsw-alias-label-secondary, #b0b0b4)',
            },
          })
          const chevron = el('span', {
            html: CHEVRON_SVG,
            style: { flex: 'none', width: 12, height: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.7))', transition: 'transform 120ms ease' },
          })
          if (folded) chevron.style.transform = 'rotate(-90deg)'
          head.appendChild(chevron)
          head.appendChild(el('span', { text: __t('bucket.' + key), style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }))
          head.appendChild(el('span', { text: String(bucket.rows.length), style: { flex: 'none', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.7))' } }))
          head.addEventListener('click', () => { setBucketFolded(key, !isBucketFolded(key)) })
          head.addEventListener('mouseenter', () => { head.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' })
          head.addEventListener('mouseleave', () => { head.style.background = 'transparent' })
          __hostList.appendChild(head)
          if (folded) continue
          for (const row of bucket.rows) {
            const btn = el('button', {
              type: 'button',
              'data-dsh-time-bucket-row': row.id,
              style: {
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', margin: '1px 0',
                padding: '5px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                font: 'inherit', fontSize: 13, lineHeight: '18px',
                color: row.current ? 'var(--dsw-alias-label-primary, #d8d8dc)' : 'var(--dsw-alias-label-secondary, #b0b0b4)',
                background: row.current ? 'var(--dsw-alias-interactive-bg-selected, rgba(128,128,128,.22))' : 'transparent',
              },
            })
            const label = el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } })
            if (row.blank) {
              label.textContent = __t('session.new')
              btn.style.color = 'var(--dsw-alias-label-tertiary, #8a8a8e)'
            } else {
              // 显示工作区 is always on in follow mode: [工作区] 标题 / [未分组] 标题.
              const prefixText = row.wsTitle ? row.wsTitle : ungroupedLabel
              label.appendChild(el('span', { text: '[' + prefixText + '] ', style: { color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.85))' } }))
              label.appendChild(document.createTextNode(row.title))
            }
            btn.appendChild(label)
            btn.appendChild(el('span', {
              text: relativeLabel(row.updatedAt, nowMs, __t),
              style: { flex: 'none', fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.75))' },
            }))
            btn.addEventListener('mouseenter', () => { if (!row.current) btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' })
            btn.addEventListener('mouseleave', () => { btn.style.background = row.current ? 'var(--dsw-alias-interactive-bg-selected, rgba(128,128,128,.22))' : 'transparent' })
            btn.addEventListener('click', () => { openSession(row.id) })
            __hostList.appendChild(btn)
          }
        }
      } catch (error) {
        if (__hostList) {
          __hostList.textContent = ''
          __hostList.appendChild(el('div', { text: String((error && error.message) || error), style: { padding: '12px', color: 'var(--dsw-alias-text-danger, #ff6b6b)', fontSize: 12 } }))
        }
      }
    }

    // --- actions --------------------------------------------------------------
    function openSession(id) {
      if (!__sessions || typeof __sessions.open !== 'function') return
      try { __sessions.open(id) } catch (error) { statusText(__t('err.open') + ': ' + String((error && error.message) || error), true) }
    }

    // --- mode control ---------------------------------------------------------
    function enterMode() {
      if (__mode) return
      if (!refreshServiceStatus()) { statusText(__t('err.noServices'), true); return }
      const core = locateCore()
      if (!core || core.rail) return
      __core = core
      __mode = true
      hideCoreList()
      mountHost()
      renderList()
    }
    function exitMode() {
      if (!__mode) return
      __mode = false
      restoreCoreList()
      unmountHost()
      __core = null
    }

    // --- watcher --------------------------------------------------------------
    function tick() {
      try {
        if (!refreshServiceStatus()) return
        const core = locateCore()
        if (core && !core.rail && isFlatUpdatedView() && !isSearchActive(core.root)) {
          if (!__mode) {
            __core = core
            __mode = true
            hideCoreList()
            mountHost()
            renderList()
          } else {
            hideCoreList()
            if (!__host || !document.contains(__host)) { __core = core; mountHost(); renderList() }
          }
          return
        }
        if (__mode) exitMode()
      } catch { /* watcher never crashes the UI */ }
    }

    // --- apply ----------------------------------------------------------------
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try { if (typeof locale.register === 'function') ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict })) } catch { /* */ }
    }
    function apply(ctx) {
      __ctx = ctx
      refreshServiceStatus()
      if (!__sessions) ctx.inject(['sessions'], (sub) => { __scope = sub; __sessions = __readService(sub, 'sessions') || sub.sessions; refreshServiceStatus() })
      if (!__workspaces) ctx.inject(['workspaces'], (sub) => { __scope = sub; __workspaces = __readService(sub, 'workspaces') || sub.workspaces; refreshServiceStatus() })
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) ctx.inject(['locale'], (sub) => { __scope = sub; adoptLocale(__readService(sub, 'locale') || sub.locale, ctx); tick() })
      ctx.on('locale/change', () => { tick() })
      ensureSubscriptions()
      if (!__watch) {
        __watch = window.setInterval(() => { tick() }, 1000)
        try { tick() } catch { /* DOM may not be ready yet */ }
      }
    }

    // Test-only hooks (window.__DSH_TEST__ is set by test/bundle.test.mjs only).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__sessionTimeBucketTest = {
        bucketKeyOf, startOfLocalDay, workspaceTitleBySession, collectRows, rowTitle, deriveBuckets, relativeLabel,
        readCoreView, isFlatUpdatedView,
        BUCKET_ORDER, __t, zhDict, enDict,
        reset() {
          __scope = null; __ctx = null; __sessions = null; __workspaces = null; __servicesOk = false; __subscribed = false
          __mode = false; __core = null
          unmountHost()
          if (__statusTimer) { clearTimeout(__statusTimer); __statusTimer = null }
          if (__watch) { clearInterval(__watch); __watch = null }
        },
      }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-session-time-bucket/src/client.js
