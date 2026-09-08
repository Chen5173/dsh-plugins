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
      'err.rename': '重命名失败',
      'err.fork': '分叉会话失败',
      'err.archive': '归档会话失败',
      'rename': '重命名',
      'rename.title': '重命名会话',
      'menu.fork': '分叉会话',
      'menu.archiveSession': '归档会话',
      'actions.session.aria': '会话“{name}”的操作',
      'action.confirm': '确定',
      'action.cancel': '取消',
      'status.running': '进行中',
      'status.completed': '已完成',
      'status.idle': '空闲',
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
      'err.rename': 'Failed to rename session',
      'err.fork': 'Failed to fork session',
      'err.archive': 'Failed to archive session',
      'rename': 'Rename',
      'rename.title': 'Rename session',
      'menu.fork': 'Fork session',
      'menu.archiveSession': 'Archive session',
      'actions.session.aria': 'Session actions for {name}',
      'action.confirm': 'OK',
      'action.cancel': 'Cancel',
      'status.running': 'Running',
      'status.completed': 'Completed',
      'status.idle': 'Idle',
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
    function __t(key, params) {
      let text = key
      if (__locale && typeof __locale.t === 'function') {
        try {
          const localized = __locale.t(NS, key)
          if (localized != null && String(localized) !== key) text = String(localized)
        } catch { /* fall through */ }
      }
      if (text === key) {
        const dict = localeLang() === 'en' ? enDict : zhDict
        if (Object.prototype.hasOwnProperty.call(dict, key)) text = dict[key]
      }
      if (params) {
        for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
      }
      return text
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
          running: s.running === true,
          completed: s.completed === true,
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

    // Core ic_ds_triangle_right_fill_14: solid triangle pointing right;
    // the core rotates it 90° for the open (expanded) state.
    const TRIANGLE_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4.25 2.82782L4.25 11.1722C4.25 11.6622 4.84243 11.9076 5.18891 11.5611L9.36109 7.38891C9.57588 7.17412 9.57588 6.82588 9.36109 6.61109L5.18891 2.43891C4.84243 2.09243 4.25 2.33782 4.25 2.82782Z" fill="currentColor"/></svg>'
    // Core row-action icons (ui-primitives, verbatim paths).
    const ELLIPSIS_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.55146 8.00001C4.55146 8.63513 4.03659 9.15001 3.40146 9.15001C2.76634 9.15001 2.25146 8.63513 2.25146 8.00001C2.25146 7.36488 2.76634 6.85001 3.40146 6.85001C4.03659 6.85001 4.55146 7.36488 4.55146 8.00001Z" fill="currentColor"/><path d="M9.1476 8.00001C9.1476 8.63513 8.63273 9.15001 7.9976 9.15001C7.36248 9.15001 6.8476 8.63513 6.8476 8.00001C6.8476 7.36488 7.36248 6.85001 7.9976 6.85001C8.63273 6.85001 9.1476 7.36488 9.1476 8.00001Z" fill="currentColor"/><path d="M13.7486 8.00001C13.7486 8.63513 13.2338 9.15001 12.5986 9.15001C11.9635 9.15001 11.4486 8.63513 11.4486 8.00001C11.4486 7.36488 11.9635 6.85001 12.5986 6.85001C13.2338 6.85001 13.7486 7.36488 13.7486 8.00001Z" fill="currentColor"/></svg>'
    const EDIT_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z" fill="currentColor"/></svg>'
    const BRANCH_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z" fill="currentColor"/></svg>'
    const ARCHIVE_SVG = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z" fill="currentColor"/><path d="M12.7962 12.5661V11.0832H7.20548V12.5661L12.7962 12.5661Z" fill="currentColor"/></svg>'

    // --- status dots (mirror core StateDot) -----------------------------------
    var __chaseStyleInjected = false
    function injectChaseStyle() {
      if (__chaseStyleInjected) return
      __chaseStyleInjected = true
      try {
        if (!document.head) return
        const style = document.createElement('style')
        style.setAttribute('data-dsh-time-bucket-style', '1')
        style.textContent = '@keyframes dsh-time-bucket-chase{0%,12.4%{opacity:1}12.5%,24.9%{opacity:.6}25%,37.4%{opacity:.35}37.5%,100%{opacity:.15}}'
        document.head.appendChild(style)
      } catch { /* non-browser test env */ }
    }
    /** 10px state dot HTML: 'ongoing' = blue pixel chase, otherwise a green
     *  solid dot with a soft halo (core StateDot semantics; aria-hidden). */
    function statusDotHtml(state) {
      if (state === 'ongoing') {
        const xs = [0, 4, 8, 8, 8, 4, 0, 0]
        const ys = [0, 0, 0, 4, 8, 8, 8, 4]
        let rects = ''
        for (let i = 0; i < 8; i++) {
          rects += '<rect x="' + xs[i] + '" y="' + ys[i] + '" width="2" height="2" style="fill:currentColor;opacity:.15;animation:dsh-time-bucket-chase 1s infinite;animation-delay:' + ((i - 8) * 125) + 'ms"/>'
        }
        return '<svg width="10" height="10" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" style="flex:none;color:var(--dsw-static-deepseek-450,#4d9fff)"><g fill="currentColor">' + rects + '</g></svg>'
      }
      return '<span aria-hidden="true" style="position:relative;display:inline-block;flex:none;width:10px;height:10px;color:var(--dsw-alias-state-success-primary,#3fbf7f)">'
        + '<span style="position:absolute;inset:0;border-radius:50%;background:currentColor;opacity:.1"></span>'
        + '<span style="position:absolute;inset:20%;border-radius:50%;background:currentColor"></span></span>'
    }

    // --- hover card (mirror core HoverCard: 500ms dwell, right of row, holdable) ---
    var __hoverCard = null
    var __hoverRow = null
    var __hoverTimer = null
    var __hoverCloseTimer = null
    var __hoverPlace = null

    function placeHover() {
      const row = __hoverRow
      const card = __hoverCard
      if (!row || !card) return
      const r = row.getBoundingClientRect()
      const h = card.offsetHeight || 0
      let top = r.top
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
      card.style.left = (r.right + 8) + 'px'
      card.style.top = top + 'px'
    }
    function hideHover() {
      if (__hoverTimer) { clearTimeout(__hoverTimer); __hoverTimer = null }
      if (__hoverCloseTimer) { clearTimeout(__hoverCloseTimer); __hoverCloseTimer = null }
      if (__hoverPlace) {
        try { window.removeEventListener('scroll', __hoverPlace, true) } catch { /* */ }
        try { window.removeEventListener('resize', __hoverPlace) } catch { /* */ }
        __hoverPlace = null
      }
      if (__hoverCard) { try { __hoverCard.remove() } catch { /* */ } __hoverCard = null }
      __hoverRow = null
    }
    function showHover(row, nowMs) {
      // Re-anchor on the live row: a re-render may have replaced the element
      // while the dwell timer was pending (stale rects break fixed placement).
      const liveRow = row && __hostList
        ? __hostList.querySelector('[data-dsh-time-bucket-row="' + row.id + '"]')
        : null
      if (!liveRow) { hideHover(); return }
      try {
        hideHover()
        __hoverRow = liveRow
        injectChaseStyle()
      const card = el('div', {
        'data-dsh-time-bucket-hover': '1',
        role: 'tooltip',
        style: {
          position: 'fixed', zIndex: 1100, width: 244, boxSizing: 'border-box',
          padding: '12px 16px', borderRadius: 12,
          background: 'var(--dsw-hovercard-bg, #2c2c2e)',
          boxShadow: 'var(--dsw-shadow-lv3, 0 6px 24px rgba(0,0,0,.28))',
          color: 'var(--dsw-alias-label-primary, #e8e8ea)',
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      })
      const titleDiv = el('div', { style: { overflowWrap: 'break-word', wordBreak: 'break-word', fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #fff)' } })
      titleDiv.textContent = row.blank ? __t('session.new') : row.title
      card.appendChild(titleDiv)
      if (!row.blank) {
        card.appendChild(el('div', {
          text: relativeLabel(row.updatedAt, nowMs, __t),
          style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #cfd3d6)' },
        }))
      }
      const statusRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #adb2b8)' } })
      const statusKey = row.running ? 'status.running' : (row.completed ? 'status.completed' : 'status.idle')
      statusRow.innerHTML = statusDotHtml(row.running ? 'ongoing' : 'done')
      statusRow.appendChild(el('span', { text: __t(statusKey) }))
      card.appendChild(statusRow)
      // The card itself is hit-testable (pointer may rest on it).
      card.addEventListener('mouseenter', () => { if (__hoverCloseTimer) { clearTimeout(__hoverCloseTimer); __hoverCloseTimer = null } })
      card.addEventListener('mouseleave', () => { hideHover() })
      document.body.appendChild(card)
      __hoverCard = card
      __hoverPlace = () => { placeHover() }
      window.addEventListener('scroll', __hoverPlace, true)
      window.addEventListener('resize', __hoverPlace)
      placeHover()
      } catch { hideHover() }
    }
    /** Arm the 500ms dwell; cancels any pending close (grace re-entry). */
    function armHover(row, nowMs) {
      if (__hoverTimer) { clearTimeout(__hoverTimer); __hoverTimer = null }
      if (__hoverCloseTimer) { clearTimeout(__hoverCloseTimer); __hoverCloseTimer = null }
      __hoverTimer = setTimeout(() => { showHover(row, nowMs) }, 500)
    }
    /** Cancel a pending show but keep the card if open (grace on leave). */
    function disarmHover() {
      if (__hoverTimer) { clearTimeout(__hoverTimer); __hoverTimer = null }
      if (!__hoverCard) return
      if (__hoverCloseTimer) { clearTimeout(__hoverCloseTimer); __hoverCloseTimer = null }
      __hoverCloseTimer = setTimeout(() => { hideHover() }, 150)
    }

    // --- row action menu + rename box (self-drawn, core-equivalent) ------------
    var __rowMenu = null
    var __rowMenuRow = null
    var __rowMenuListeners = null
    var __renameBox = null
    var __renameSessionId = null
    var __renameDown = null

    function closeRowMenu() {
      if (__rowMenuListeners) {
        try { document.removeEventListener('pointerdown', __rowMenuListeners.onDown, true) } catch { /* */ }
        try { document.removeEventListener('keydown', __rowMenuListeners.onKey) } catch { /* */ }
        __rowMenuListeners = null
      }
      if (__rowMenu) { try { __rowMenu.remove() } catch { /* */ } __rowMenu = null }
      if (__rowMenuRow) {
        let hovered = false
        try { if (__rowMenuRow.matches) hovered = __rowMenuRow.matches(':hover') } catch { /* */ }
        const ra = __rowMenuRow.querySelector('[data-dsh-time-bucket-rowactions]')
        const tm = __rowMenuRow.querySelector('[data-dsh-time-bucket-time]')
        if (ra) ra.style.display = hovered ? 'inline-flex' : 'none'
        if (tm) tm.style.display = hovered ? 'none' : ''
      }
      __rowMenuRow = null
    }
    function rowMenuItem(iconHtml, label, onClick) {
      const item = el('button', {
        type: 'button', role: 'menuitem',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34,
          padding: '5px 10px', border: 'none', background: 'transparent', borderRadius: 10,
          color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, lineHeight: '22px',
          textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
        },
      })
      item.appendChild(el('span', { html: iconHtml, style: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' } }))
      item.appendChild(el('span', { text: label, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }))
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' })
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
      item.addEventListener('click', (event) => { event.stopPropagation(); onClick() })
      return item
    }
    function openRowMenu(row, anchorBtn, title) {
      closeRowMenu()
      __rowMenuRow = row
      const ra = row.querySelector('[data-dsh-time-bucket-rowactions]')
      const tm = row.querySelector('[data-dsh-time-bucket-time]')
      if (ra) ra.style.display = 'inline-flex'
      if (tm) tm.style.display = 'none'
      const menu = el('div', {
        'data-dsh-time-bucket-menu': '1',
        role: 'menu',
        style: {
          position: 'fixed', zIndex: 1200, minWidth: 190, padding: 4, borderRadius: 10,
          background: 'var(--dsw-alias-surface-overlay, #232326)',
          border: '1px solid var(--dsw-alias-stroke-overlay, rgba(128,128,128,.24))',
          boxShadow: '0 6px 24px rgba(0,0,0,.28)',
          fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary, #d8d8dc)',
        },
      })
      menu.appendChild(rowMenuItem(EDIT_SVG, __t('rename'), () => { closeRowMenu(); openRenameBox(row, title) }))
      menu.appendChild(rowMenuItem(BRANCH_SVG, __t('menu.fork'), () => { closeRowMenu(); void forkSession(row) }))
      menu.appendChild(rowMenuItem(ARCHIVE_SVG, __t('menu.archiveSession'), () => { closeRowMenu(); void archiveSession(row) }))
      document.body.appendChild(menu)
      __rowMenu = menu
      const r = anchorBtn.getBoundingClientRect()
      const mw = menu.offsetWidth || 190
      let left = r.left
      if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8)
      let top = r.bottom + 4
      const mh = menu.offsetHeight || 130
      if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8)
      menu.style.left = left + 'px'
      menu.style.top = top + 'px'
      const onDown = (event) => {
        const target = event.target
        if (target instanceof Node && menu.contains(target)) return
        closeRowMenu()
      }
      const onKey = (event) => { if (event.key === 'Escape') closeRowMenu() }
      __rowMenuListeners = { onDown, onKey }
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('keydown', onKey)
    }
    function closeRenameBox() {
      if (__renameBox) { try { __renameBox.remove() } catch { /* */ } __renameBox = null }
      if (__renameDown) {
        try { document.removeEventListener('pointerdown', __renameDown, true) } catch { /* */ }
        __renameDown = null
      }
      __renameSessionId = null
    }
    function openRenameBox(row, title) {
      closeRenameBox()
      __renameSessionId = row.id
      const box = el('div', {
        'data-dsh-time-bucket-rename': '1',
        role: 'dialog',
        style: {
          position: 'fixed', zIndex: 1201, width: 300, boxSizing: 'border-box', padding: '12px 14px',
          borderRadius: 12, background: 'var(--dsw-alias-surface-overlay, #232326)',
          border: '1px solid var(--dsw-alias-stroke-overlay, rgba(128,128,128,.24))',
          boxShadow: '0 6px 24px rgba(0,0,0,.28)',
          display: 'flex', flexDirection: 'column', gap: 10,
        },
      })
      box.appendChild(el('div', { text: __t('rename.title'), style: { fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } }))
      const input = document.createElement('input')
      input.type = 'text'
      input.value = row.blank ? '' : row.title
      Object.assign(input.style, {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-button-elevated-fill, rgba(128,128,128,.08))',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '18px', outline: 'none',
      })
      input.setAttribute('aria-label', __t('rename.title'))
      box.appendChild(input)
      const actions = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } })
      const cancelBtn = el('button', {
        type: 'button', text: __t('action.cancel'),
        style: { padding: '5px 12px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #b0b0b4)', fontSize: 13, cursor: 'pointer' },
      })
      const okBtn = el('button', {
        type: 'button', text: __t('action.confirm'),
        style: { padding: '5px 12px', borderRadius: 8, border: 'none', background: 'var(--dsw-alias-accent, #4d9fff)', color: '#fff', fontSize: 13, cursor: 'pointer' },
      })
      cancelBtn.addEventListener('click', () => closeRenameBox())
      okBtn.addEventListener('click', () => { void submitRename(input.value) })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void submitRename(input.value) }
        if (event.key === 'Escape') closeRenameBox()
      })
      actions.appendChild(cancelBtn)
      actions.appendChild(okBtn)
      box.appendChild(actions)
      document.body.appendChild(box)
      __renameBox = box
      const r = row.getBoundingClientRect()
      const bh = box.offsetHeight || 150
      let left = r.right - 300
      if (left < 8) left = 8
      let top = r.top
      if (top + bh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - bh - 8)
      box.style.left = left + 'px'
      box.style.top = top + 'px'
      const onDown = (event) => {
        const target = event.target
        if (target instanceof Node && box.contains(target)) return
        closeRenameBox()
      }
      __renameDown = onDown
      document.addEventListener('pointerdown', onDown, true)
      setTimeout(() => { try { input.focus(); input.select() } catch { /* */ } }, 0)
    }
    async function submitRename(value) {
      const id = __renameSessionId
      const text = String(value || '').trim()
      closeRenameBox()
      if (!id || !text) return
      try {
        if (!__sessions || typeof __sessions.scope !== 'function' || typeof __sessions.sessionOf !== 'function') { statusText(__t('err.rename'), true); return }
        const scoped = __sessions.scope(id)
        const face = scoped && __sessions.sessionOf(scoped)
        if (!face || typeof face.rename !== 'function') { statusText(__t('err.rename'), true); return }
        const result = await face.rename(text)
        if (!result || result.ok === false) {
          statusText(__t('err.rename') + (result && result.error ? ': ' + result.error.message : ''), true)
          return
        }
      } catch (error) { statusText(__t('err.rename') + ': ' + String((error && error.message) || error), true) }
    }
    async function forkSession(row) {
      try {
        if (!__sessions || typeof __sessions.fork !== 'function') { statusText(__t('err.fork'), true); return }
        const childId = await __sessions.fork({ sessionId: row.id })
        if (childId) { try { __sessions.open(childId) } catch { /* list may lag */ } }
      } catch (error) { statusText(__t('err.fork') + ': ' + String((error && error.message) || error), true) }
    }
    async function archiveSession(row) {
      try {
        if (!__workspaces || typeof __workspaces.archiveSession !== 'function') { statusText(__t('err.archive'), true); return }
        await __workspaces.archiveSession(row.id)
      } catch (error) { statusText(__t('err.archive') + ': ' + String((error && error.message) || error), true) }
    }

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
      // Keep an open hover card across re-renders: remember the hovered
      // session and re-anchor it on the rebuilt row below. Row menus and the
      // rename box are closed (their row elements are being replaced).
      const hoverId = __hoverRow ? __hoverRow.id : null
      closeRowMenu()
      closeRenameBox()
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
          hideHover()
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
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', margin: '2px 0 6px',
              padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 8,
              cursor: 'pointer', textAlign: 'left', fontSize: 14, lineHeight: '20px',
              color: 'var(--dsw-alias-label-secondary, #b0b0b4)',
            },
          })
          // The triangle lives in a 16px slot like the core project row's
          // chevron (core: slot 16x20, gap 6, pad 0 8px).
          const chevron = el('span', {
            html: TRIANGLE_SVG,
            style: { flex: 'none', width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.7))', transition: 'transform 150ms ease' },
          })
          // Core behavior: pointing right when collapsed, rotated 90° down when expanded.
          chevron.style.transform = folded ? 'rotate(0deg)' : 'rotate(90deg)'
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
                display: 'flex', alignItems: 'center', gap: 0, width: '100%', margin: '2px 0',
                padding: '6px 10px', border: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                font: 'inherit', fontSize: 13, lineHeight: '18px',
                color: row.current ? 'var(--dsw-alias-label-primary, #d8d8dc)' : 'var(--dsw-alias-label-secondary, #b0b0b4)',
                background: row.current ? 'var(--dsw-alias-interactive-bg-selected, rgba(128,128,128,.22))' : 'transparent',
              },
            })
            // Leading status slot, same rule as the core flat list: only while
            // running (blue chase) or completed (green dot). Core gap:0, and the
            // title owns the 4px left gap (title margin, like fPQ3ha_title).
            if (row.running || row.completed) {
              const slot = el('span', {
                style: { width: 16, height: 20, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
              })
              slot.setAttribute('aria-label', __t(row.running ? 'status.running' : 'status.completed'))
              slot.innerHTML = statusDotHtml(row.running ? 'ongoing' : 'done')
              btn.appendChild(slot)
            }
            const label = el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 6px 0 4px' } })
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
            let timeEl = null
            if (!row.blank) {
              timeEl = el('span', {
                'data-dsh-time-bucket-time': '1',
                text: relativeLabel(row.updatedAt, nowMs, __t),
                style: { flex: 'none', fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)' },
              })
              btn.appendChild(timeEl)
            }
            // Row actions (…): hidden by default, revealed on row hover and
            // while its menu is open; the time label hides alongside (core).
            let rowActionsEl = null
            if (!row.blank) {
              rowActionsEl = el('span', { 'data-dsh-time-bucket-rowactions': '1', style: { flex: 'none', display: 'none', alignItems: 'center' } })
              const more = el('button', {
                type: 'button',
                'aria-label': __t('actions.session.aria', { name: row.title }),
                style: {
                  width: 16, height: 16, padding: 0, border: 'none', background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', borderRadius: 4, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
                },
                html: ELLIPSIS_SVG,
              })
              more.addEventListener('click', (event) => {
                event.stopPropagation()
                hideHover()
                if (__rowMenu && __rowMenuRow === btn) closeRowMenu()
                else openRowMenu(btn, more, row.title)
              })
              rowActionsEl.appendChild(more)
              btn.appendChild(rowActionsEl)
            }
            btn.addEventListener('mouseenter', () => {
              if (!row.current) btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
              if (rowActionsEl) rowActionsEl.style.display = 'inline-flex'
              if (timeEl) timeEl.style.display = 'none'
              armHover(row, nowMs)
            })
            btn.addEventListener('mouseleave', () => {
              btn.style.background = row.current ? 'var(--dsw-alias-interactive-bg-selected, rgba(128,128,128,.22))' : 'transparent'
              if (__rowMenuRow !== btn) {
                if (rowActionsEl) rowActionsEl.style.display = 'none'
                if (timeEl) timeEl.style.display = ''
              }
              disarmHover()
            })
            btn.addEventListener('click', () => { hideHover(); openSession(row.id) })
            __hostList.appendChild(btn)
          }
        }
        // Re-anchor an open hover card on the rebuilt row, or close it.
        if (hoverId) {
          const live = __hostList.querySelector('[data-dsh-time-bucket-row="' + hoverId + '"]')
          if (live && __hoverCard) { __hoverRow = live; placeHover() }
          else hideHover()
        }
      } catch (error) {
        hideHover()
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
      hideHover()
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
          hideHover()
          closeRowMenu()
          closeRenameBox()
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
