// dsh-session-time-bucket: CLIENT half — the whole feature lives here.
//
// Standalone architecture (no core-menu injection):
//   · an own entry icon is appended next to the core "view options" button in the
//     sidebar section header;
//   · clicking it opens a SELF-DRAWN popover replicating the requested layout:
//       分组方式
//         · 按时间桶   (radio; picking it reveals a hairline-separated 显示工作区 row)
//       picking it and clicking outside / Escape activates the mode;
//   · activating TAKES OVER the section (the earliest-approved behaviour): the core
//     header + list are hidden and replaced by a compact plugin header
//     (entry → 按时间桶 · 显示工作区 · ＋新建 · ×退出) above the time-bucketed list.
//   · while active, opening the popover again (entry button) shows 按时间桶 selected,
//     a 显示工作区 switch (live) and unchecking 按时间桶 exits back to core.
//
// Time buckets: 今天 / 昨天 / 前7天 / 前30天 / 更早 by local calendar day, ordered by
// session updatedAt desc; group headers show count and fold (chevron + hover, state
// persisted); rows carry [workspace] title when 显示工作区 is on ([未分组] outside every
// workspace) and a trailing relative time; empty buckets hidden; archived + subagent
// rows filtered like core.
//
// Data comes only from two core client services (never scraping the DOM):
//   - sessions  -> list.getSnapshot() { ids, byId: {SessionSummary}, current }
//   - workspaces-> list.getSnapshot() { items: WorkspaceView[], archivedSessionIds }
// Sessions open via sessions.open(id); new sessions use sessions.create following the
// current session's workspace (fallback: no-arg create), then open.
//
// No React: plain DOM + inline styles + --dsw-* tokens. Mode / 显示工作区 / folded
// buckets persist under a localStorage key; a 1s reconcile watcher re-asserts the
// takeover, auto-enters the persisted on-state and auto-exits on the rail sidebar.
//
// Bundle format (client-modules protocol): classic script registering a factory via
// window.__ModuleLoader__.load({ id, factory }); returns { apply, inject: ['slots'] }.
window.__ModuleLoader__.load({
  id: 'dsh-session-time-bucket',
  factory: (require) => {
    const NS = 'session-time-bucket'
    const STORE_KEY = 'dsh.sessionTimeBucket.v1'
    const BUCKET_ORDER = ['today', 'yesterday', 'last7', 'last30', 'older']
    const DAY_MS = 86400000

    // --- locale ---------------------------------------------------------------
    const zhDict = {
      'entry.aria': '按时间桶分组',
      'popover.groupBy': '分组方式',
      'option.timeBucket': '按时间桶',
      'toggle.showWorkspace': '显示工作区',
      'popover.hint': '勾选后点击空白处生效',
      'mode.title': '按时间桶',
      'action.new': '新建会话',
      'action.exit': '退出按时间桶',
      'bucket.today': '今天',
      'bucket.yesterday': '昨天',
      'bucket.last7': '前7天',
      'bucket.last30': '前30天',
      'bucket.older': '更早',
      'ungrouped': '未分组',
      'session.new': '新会话',
      'empty.none': '暂无会话',
      'err.noServices': '缺少会话/工作区服务，时间桶模式不可用',
      'err.create': '新建会话失败',
      'new.created': '已创建新会话',
      'rel.now': '刚刚',
      'rel.minute': '{n}分钟前',
      'rel.hour': '{n}小时前',
      'rel.day': '{n}天前',
      'rel.month': '{n}个月前',
      'rel.year': '{n}年前',
    }
    const enDict = {
      'entry.aria': 'Group by time bucket',
      'popover.groupBy': 'Group by',
      'option.timeBucket': 'Time bucket',
      'toggle.showWorkspace': 'Show workspace',
      'popover.hint': 'Tick it, then click outside to apply',
      'mode.title': 'Time bucket',
      'action.new': 'New session',
      'action.exit': 'Exit time bucket',
      'bucket.today': 'Today',
      'bucket.yesterday': 'Yesterday',
      'bucket.last7': 'Last 7 days',
      'bucket.last30': 'Last 30 days',
      'bucket.older': 'Older',
      'ungrouped': 'Ungrouped',
      'session.new': 'New Session',
      'empty.none': 'No sessions',
      'err.noServices': 'Session/workspace services unavailable; time-bucket mode is off',
      'err.create': 'Failed to create session',
      'new.created': 'New session created',
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
        && typeof __sessions.open === 'function' && typeof __sessions.create === 'function'
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

    // --- persistence ----------------------------------------------------------
    function readStore() {
      try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          return {
            on: parsed.on === true,
            showWorkspace: parsed.showWorkspace === true,
            folded: Array.isArray(parsed.folded) ? parsed.folded.filter((k) => BUCKET_ORDER.indexOf(k) >= 0) : [],
          }
        }
      } catch { /* storage unavailable */ }
      return { on: false, showWorkspace: false, folded: [] }
    }
    function writeStore(state) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          on: state.on === true,
          showWorkspace: state.showWorkspace === true,
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

    const CLOCK_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex:none"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 1.5h1v3.2l2.1 1.26-.5.86L7.5 8.5V4.5z" fill="currentColor"/></svg>'
    const PLUS_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex:none"><path d="M8 3.25a.75.75 0 0 1 .75.75v3.25H12a.75.75 0 0 1 0 1.5H8.75V12a.75.75 0 0 1-1.5 0V8.75H4a.75.75 0 0 1 0-1.5h3.25V4a.75.75 0 0 1 .75-.75z" fill="currentColor"/></svg>'
    const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex:none"><path d="M4.47 3.76a.75.75 0 0 0-1.06 1.06L6.94 8l-3.53 3.18a.75.75 0 1 0 1.06 1.18L8 9.06l3.53 3.06a.75.75 0 1 0 1.06-1.18L9.06 8l3.53-3.18a.75.75 0 0 0-1.06-1.06L8 6.94 4.47 3.76z" fill="currentColor"/></svg>'
    const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

    // --- live state -----------------------------------------------------------
    var __mode = false
    var __entry = null            // entry button (icon) inside core header actions
    var __popoverOpen = false
    var __popListeners = null
    var __core = null
    var __host = null             // takeover node (mini header + status + list)
    var __hostList = null
    var __statusEl = null
    var __statusTimer = null
    var __watch = null
    var __busyNew = false

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

    // --- entry button + popover ----------------------------------------------
    function ensureEntry() {
      const viewButton = findViewButton()
      if (!viewButton) return false
      const headerActions = viewButton.parentElement
      if (!headerActions) return false
      if (__entry && document.contains(__entry)) return true
      if (__entry) { try { __entry.remove() } catch { /* */ } }
      const entry = el('button', {
        type: 'button',
        'data-dsh-time-bucket-entry': '1',
        'aria-label': __t('entry.aria'),
        title: __t('entry.aria'),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6, background: 'transparent',
          color: __mode ? 'var(--dsw-alias-accent, #4d9fff)' : 'var(--dsw-alias-label-tertiary, #8a8a8e)',
          cursor: 'pointer', flex: 'none',
        },
        html: CLOCK_ICON,
      })
      entry.addEventListener('click', (event) => { event.stopPropagation(); togglePopover() })
      try { headerActions.appendChild(entry) } catch { /* noop */ }
      __entry = entry
      return true
    }
    function removeEntry() {
      if (__entry) { try { __entry.remove() } catch { /* */ } }
      __entry = null
    }

    function detachPopListeners() {
      if (!__popListeners) return
      try { document.removeEventListener('pointerdown', __popListeners.onDown, true) } catch { /* */ }
      try { document.removeEventListener('keydown', __popListeners.onKey) } catch { /* */ }
      __popListeners = null
    }
    function closePopover() {
      if (!__popoverOpen) return
      __popoverOpen = false
      const popover = document.querySelector('[data-dsh-time-bucket-popover]')
      if (popover) popover.remove()
    }

    /** Open the self-drawn popover. Off mode: radio 按时间桶 + reveal 显示工作区.
     *  On mode: shows 按时间桶 selected + 显示工作区 (live) ; uncheck exits. */
    function openPopover() {
      closePopover()
      detachPopListeners()
      __popoverOpen = true
      const select = __mode   // when active the option is pre-selected

      const popover = el('div', {
        'data-dsh-time-bucket-popover': '1',
        role: 'menu',
        style: {
          position: 'fixed', zIndex: 1200, minWidth: 200,
          padding: '4px', borderRadius: 10,
          background: 'var(--dsw-alias-surface-overlay, #232326)',
          border: '1px solid var(--dsw-alias-stroke-overlay, rgba(128,128,128,.24))',
          boxShadow: '0 6px 24px rgba(0,0,0,.28)',
          fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #d8d8dc)',
        },
      })
      popover.appendChild(el('div', {
        text: __t('popover.groupBy'),
        style: { padding: '4px 10px 2px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' },
      }))

      const row = el('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': select ? 'true' : 'false',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34,
          padding: '5px 10px', border: 'none', background: 'transparent', borderRadius: 10,
          color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14,
          lineHeight: '22px', textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
        },
      })
      row.appendChild(el('span', { text: __t('option.timeBucket'), style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }))
      const check = el('span', {
        'data-dsh-time-bucket-pcheck': '1',
        text: '✓',
        style: { display: select ? 'block' : 'none', flex: 'none', color: 'var(--dsw-alias-label-primary)' },
      })
      row.appendChild(check)
      popover.appendChild(row)

      const sep = el('div', { role: 'separator', 'data-dsh-time-bucket-psep': '1', style: { display: select ? 'block' : 'none', height: 0.5, margin: '4px 2px', background: 'var(--dsw-alias-stroke-default, rgba(128,128,128,.2))' } })
      popover.appendChild(sep)

      const wsRow = el('label', {
        'data-dsh-time-bucket-pws': '1',
        style: { display: select ? 'flex' : 'none', alignItems: 'center', gap: 8, width: '100%', minHeight: 34, padding: '5px 10px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px', boxSizing: 'border-box' },
      })
      const wsInput = document.createElement('input')
      wsInput.type = 'checkbox'
      wsInput.checked = __store.showWorkspace
      Object.assign(wsInput.style, { width: 14, height: 14, margin: 0, flex: 'none', accentColor: 'var(--dsw-alias-accent, #4d9fff)' })
      wsInput.setAttribute('aria-label', __t('toggle.showWorkspace'))
      wsInput.addEventListener('click', (event) => { event.stopPropagation() })
      wsInput.addEventListener('change', () => {
        __store.showWorkspace = wsInput.checked
        writeStore(__store)
        if (__mode) { renderList(); syncMiniHeaderSwitch() }
      })
      wsRow.appendChild(wsInput)
      wsRow.appendChild(el('span', { text: __t('toggle.showWorkspace'), style: { flex: 1 } }))
      popover.appendChild(wsRow)

      popover.appendChild(el('div', {
        text: __t('popover.hint'),
        style: { display: select ? 'none' : 'block', padding: '2px 10px 4px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: 11, lineHeight: '15px' },
      }))

      const setSelected = (on) => {
        check.style.display = on ? 'block' : 'none'
        row.setAttribute('aria-checked', on ? 'true' : 'false')
        sep.style.display = on ? 'block' : 'none'
        wsRow.style.display = on ? 'flex' : 'none'
      }

      row.addEventListener('click', (event) => {
        event.stopPropagation()
        if (__mode) {
          // Active mode: unchecking exits back to core immediately.
          exitMode()
          setSelected(false)
          return
        }
        const nowOn = check.style.display !== 'block'
        setSelected(nowOn)
      })

      document.body.appendChild(popover)
      // Position under the entry (mini-header entry or core-header entry).
      const anchorEl = __entry && document.contains(__entry) ? __entry : document.querySelector('[data-dsh-time-bucket-entry]')
      const rect = anchorEl && anchorEl.getBoundingClientRect
        ? anchorEl.getBoundingClientRect()
        : { left: 0, bottom: 40 }
      const pw = popover.offsetWidth || 200
      let left = rect.left
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8)
      popover.style.left = left + 'px'
      popover.style.top = ((rect.bottom || 40) + 6) + 'px'

      const apply = () => {
        const on = check.style.display === 'block'
        if (!__mode && on) {
          __store.on = true
          writeStore(__store)
          enterMode()
        }
      }
      const onDown = (event) => {
        const target = event.target
        if (target instanceof Node) {
          const anchorEl2 = __entry && document.contains(__entry) ? __entry : document.querySelector('[data-dsh-time-bucket-entry]')
          if (popover.contains(target)) return
          if (anchorEl2 && anchorEl2.contains(target)) return
        }
        apply()
        closePopover()
        detachPopListeners()
      }
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        apply()
        closePopover()
        detachPopListeners()
      }
      __popListeners = { onDown, onKey }
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('keydown', onKey)
    }

    function togglePopover() {
      if (__popoverOpen) {
        closePopover()
        detachPopListeners()
        return
      }
      openPopover()
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

    function buttonStyle() {
      return {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6, background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', cursor: 'pointer', flex: 'none',
      }
    }

    function syncMiniHeaderSwitch() {
      try {
        const input = document.querySelector('[data-dsh-time-bucket-switch] input')
        if (input) input.checked = __store.showWorkspace
      } catch { /* noop */ }
    }

    function buildMiniHeader() {
      const bar = el('div', {
        'data-dsh-time-bucket-miniheader': '1',
        style: { display: 'flex', alignItems: 'center', gap: 2, padding: '4px 6px', flex: 'none', minHeight: 30 },
      })
      // Entry (opens the popover; active state lets you uncheck to exit / toggle 显示工作区).
      const entry = el('button', {
        type: 'button', 'aria-label': __t('entry.aria'), title: __t('entry.aria'),
        style: { ...buttonStyle(), color: 'var(--dsw-alias-accent, #4d9fff)' },
        html: CLOCK_ICON,
      })
      entry.addEventListener('click', (event) => { event.stopPropagation(); togglePopover() })
      bar.appendChild(entry)

      bar.appendChild(el('span', {
        text: __t('mode.title'),
        style: { color: 'var(--dsw-alias-label-primary, #d8d8dc)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', marginRight: 'auto', overflow: 'hidden', textOverflow: 'ellipsis' },
      }))

      const wsToggle = el('label', {
        'data-dsh-time-bucket-switch': '1',
        style: { display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #b0b0b4)', fontSize: 12, whiteSpace: 'nowrap' },
      })
      const wsInput = document.createElement('input')
      wsInput.type = 'checkbox'
      wsInput.checked = __store.showWorkspace
      Object.assign(wsInput.style, { width: 13, height: 13, margin: 0, accentColor: 'var(--dsw-alias-accent, #4d9fff)' })
      wsInput.setAttribute('aria-label', __t('toggle.showWorkspace'))
      wsInput.addEventListener('change', () => {
        __store.showWorkspace = wsInput.checked
        writeStore(__store)
        renderList()
      })
      wsToggle.appendChild(wsInput)
      wsToggle.appendChild(document.createTextNode(__t('toggle.showWorkspace')))
      bar.appendChild(wsToggle)

      const newBtn = el('button', { type: 'button', 'aria-label': __t('action.new'), title: __t('action.new'), style: buttonStyle(), html: PLUS_ICON })
      newBtn.addEventListener('click', () => { void createNewSession() })
      bar.appendChild(newBtn)

      const exitBtn = el('button', { type: 'button', 'aria-label': __t('action.exit'), title: __t('action.exit'), style: buttonStyle(), html: CLOSE_ICON })
      exitBtn.addEventListener('click', () => { exitMode() })
      bar.appendChild(exitBtn)

      __statusEl = el('div', {
        'data-dsh-time-bucket-status': '1',
        style: { display: 'none', fontSize: 11, lineHeight: '15px', padding: '0 10px 4px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' },
      })
      const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', flex: 'none' } })
      wrap.appendChild(bar)
      wrap.appendChild(__statusEl)
      return wrap
    }

    function hideCore() {
      if (!__core) return
      if (__core.header) __core.header.style.display = 'none'
      if (__core.listArea) __core.listArea.style.display = 'none'
    }
    function restoreCore() {
      if (!__core) return
      if (__core.header) __core.header.style.display = ''
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
      host.appendChild(buildMiniHeader())
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
            } else if (__store.showWorkspace) {
              const prefixText = row.wsTitle ? row.wsTitle : ungroupedLabel
              label.appendChild(el('span', { text: '[' + prefixText + '] ', style: { color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.85))' } }))
              label.appendChild(document.createTextNode(row.title))
            } else {
              label.textContent = row.title
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
      try { __sessions.open(id) } catch (error) { statusText(String((error && error.message) || error), true) }
    }
    async function createNewSession() {
      if (__busyNew || !__servicesOk) return
      __busyNew = true
      try {
        const listSnap = __sessions.list.getSnapshot()
        const wsSnap = __workspaces.list.getSnapshot()
        const current = listSnap && listSnap.current
        let workspaceId
        if (current) {
          const items = (wsSnap && wsSnap.items) || []
          for (const item of items) {
            if ((item.sessionIds || []).indexOf(current) >= 0) { workspaceId = item.workspaceId; break }
          }
        }
        const id = workspaceId ? await __sessions.create({ workspaceId }) : await __sessions.create()
        try { __sessions.open(id) } catch { /* list may lag a frame */ }
        statusText(__t('new.created'), false)
      } catch (error) {
        statusText(__t('err.create') + ': ' + String((error && error.message) || error), true)
      } finally {
        __busyNew = false
      }
    }

    // --- mode control ---------------------------------------------------------
    function enterMode() {
      if (__mode) return
      if (!refreshServiceStatus()) { statusText(__t('err.noServices'), true); return }
      const core = locateCore()
      if (!core || core.rail) return
      __core = core
      __mode = true
      hideCore()
      mountHost()
      renderList()
      refreshEntryColor()
    }
    function exitMode() {
      if (!__mode) return
      __mode = false
      __store.on = false
      writeStore(__store)
      closePopover()
      restoreCore()
      unmountHost()
      __core = null
      refreshEntryColor()
    }
    function refreshEntryColor() {
      try {
        if (__entry) __entry.style.color = __mode ? 'var(--dsw-alias-accent, #4d9fff)' : 'var(--dsw-alias-label-tertiary, #8a8a8e)'
      } catch { /* noop */ }
    }

    // --- watcher --------------------------------------------------------------
    function tick() {
      try {
        if (!refreshServiceStatus()) return
        if (__mode) {
          const core = locateCore()
          if (!core || core.rail) { exitMode(); return }
          if (core.header && core.header.style.display !== 'none') core.header.style.display = 'none'
          if (core.listArea && core.listArea.style.display !== 'none') core.listArea.style.display = 'none'
          if (!__host || !document.contains(__host)) { __core = core; mountHost(); renderList() }
          return
        }
        // Off mode: keep the entry icon beside 视图选项 and honor a persisted on-state.
        if (__entry && !document.contains(__entry)) removeEntry()
        if (findViewButton()) {
          if (ensureEntry() && __store.on) enterMode()
        } else if (__entry) {
          removeEntry()
        }
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
        BUCKET_ORDER, __t, zhDict, enDict,
        reset() {
          __scope = null; __ctx = null; __sessions = null; __workspaces = null; __servicesOk = false; __subscribed = false
          __mode = false; __store = { on: false, showWorkspace: false, folded: [] }
          if (__entry) { try { __entry.remove() } catch { /* */ } __entry = null }
          closePopover(); detachPopListeners()
          if (__watch) { clearInterval(__watch); __watch = null }
        },
      }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-session-time-bucket/src/client.js
