// dsh-composer-history-recall: CLIENT half — the whole plugin lives here.
//
// Terminal-style history recall in the composer: while the composer is focused,
// ArrowUp on the FIRST line walks the current session's previously-SENT user
// messages back in time, ArrowDown walks forward, and the chosen text is written
// into the draft via the core `inputActions.setDraft` — never auto-submitted.
// There is no host endpoint, no model tool and no message store of our own: the
// history is read from the already-assembled 'chat' view (useConversation) and
// the write goes through the public input action face.
//
// Why a document capture listener instead of the composer's own keyboard:
// the composer is a Lexical contenteditable whose keyboard face (ComposerKeyboard)
// is package-private ("never across a plugin boundary"), so a plugin cannot hook
// it. We listen on document in the CAPTURE phase (runs before Lexical's own
// handler), gate hard on "is the composer focused + is this a safe recall", and
// otherwise return without touching the event so multi-line caret movement and
// the slash/mention menus keep working.
//
// Diagnostics: a read-only snapshot is published on window.__dshr so a user can
// open DevTools, press the arrows, and report exactly which gate (if any) bailed.
// It records counters and the last decision only — never message content.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns { apply, inject }. No JSX: plain React.createElement.

window.__ModuleLoader__.load({
  id: 'dsh-composer-history-recall',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // --- self-owned controls (0.2.0 contract: no host client package imports) ---
    // The 0.2.0 module table refuses require() of a package that is not a boot
    // row ("runtime mirror of the bundle purity gate"). @deepseek-ai/dsh-client-ui-primitives
    // is not guaranteed to be a row on a 0.2.0 profile, so the primitives
    // import below is OPTIONAL: when it resolves (pre-0.2.0 installs) it wins,
    // otherwise the plugin renders with its own token-based controls mirroring
    // the host look (copied minimal from the primitives' 0.2.0 sources).
    var _uc_primitives = null
    try {
      _uc_primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch { _uc_primitives = null }

    /** Inline SVG icon factory (16x16 currentColor, host style). */
    function _ucIcon(pathD, size) {
      return React.createElement('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 16 16',
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: { flex: 'none', display: 'inline-block', verticalAlign: 'middle' },
        'aria-hidden': true,
      }, React.createElement('path', { d: pathD, fill: 'currentColor' }))
    }
    const uIconRefresh = (p) => _ucIcon('M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z', p && p.size)
    const uIconCheck = (p) => _ucIcon('M13.5 3.5L6.5 12.5L2.5 8', p && p.size)
    const uIconWarning = (p) => _ucIcon('M8 1.5L15 14H1L8 1.5ZM8 6V9.5M8 11.5V11.6', p && p.size)
    const uIconClose = (p) => _ucIcon('M4 4L12 12M12 4L4 12', p && p.size)
    const uIconCopy = (p) => _ucIcon('M5.5 5.5H12.5V12.5H5.5V5.5ZM3.5 10.5V3.5H10.5', p && p.size)
    const uIconFolderOpen = (p) => _ucIcon('M1.5 4H6L7.5 5.5H14.5V12.5H1.5V4ZM1.5 6.5V12.5L4 7.5H14.5', p && p.size)
    const uIconLoading = (p) => _ucIcon('M8 1.5V4M8 12V14.5M1.5 8H4M12 8H14.5M3.4 3.4L5.2 5.2M10.8 10.8L12.6 12.6M12.6 3.4L10.8 5.2M5.2 10.8L3.4 12.6', p && p.size)
    const uIconChevronDown = (p) => _ucIcon('M3 5.5L8 10.5L13 5.5', p && p.size)
    const uIconCheckCircle = (p) => _ucIcon('M8 1.5C11.59 1.5 14.5 4.41 14.5 8C14.5 11.59 11.59 14.5 8 14.5C4.41 14.5 1.5 11.59 1.5 8C1.5 4.41 4.41 1.5 8 1.5ZM5.5 8L7.2 9.7L10.5 6.5', p && p.size)
    const IconRefreshOutline16 = uIconRefresh
    const IconCheckOutline16 = uIconCheck
    const IconWarningOutline16 = uIconWarning
    const IconCloseOutline16 = uIconClose
    const IconCopyOutline16 = uIconCopy
    const IconFolderOpenOutline16 = uIconFolderOpen
    const IconLoadingOutline16 = uIconLoading
    const IconChevronDownOutline14 = uIconChevronDown
    const IconCheckCircleOutlineRegular = uIconCheckCircle

    /** Self-owned Toast: top-center banner mirroring the primitives surface. */
    function UcToast({ text, icon, tone, onDone, holdMs }) {
      const latestOnDone = React.useRef(onDone)
      React.useLayoutEffect(() => { latestOnDone.current = onDone }, [onDone])
      React.useEffect(() => {
        const timer = setTimeout(() => { try { latestOnDone.current() } catch { /* noop */ } }, (holdMs || 3000) + 1000)
        return () => { clearTimeout(timer) }
      }, [holdMs])
      const portal = (typeof document !== 'undefined' && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal)
        ? ReactDOM.createPortal : null
      const el = React.createElement('div', {
        role: 'alert',
        style: {
          position: 'fixed', top: 40, left: '50%', zIndex: 1100, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: 10, width: 'max-content',
          maxWidth: 'min(640px, calc(100vw - 48px))', padding: '12px 16px',
          borderRadius: 'var(--dsw-radius-lg)',
          background: 'var(--dsw-alias-toast-bg)', color: 'var(--dsw-alias-toast-label)',
          fontSize: 14, lineHeight: '22px', boxShadow: 'var(--dsw-shadow-lv3)',
          transform: 'translateX(-50%)', opacity: 1,
        },
      }, [
        tone === 'success'
          ? React.createElement('span', { key: 'i', style: { display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--dsw-alias-state-success-primary)' }, 'aria-hidden': true },
            React.createElement(IconCheckCircleOutlineRegular, { size: 16 }))
          : (icon !== undefined && icon !== null
            ? React.createElement('span', { key: 'i', style: { display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--dsw-alias-state-warn-label)' }, 'aria-hidden': true }, icon)
            : null),
        React.createElement('span', { key: 't', style: { minWidth: 0 } }, text),
      ])
      return portal ? portal(el, document.body) : el
    }

    /** Self-owned Tooltip: hover bubble; children's handlers are chained. */
    function UcTooltip({ label, side, delayMs, children }) {
      const [pos, setPos] = React.useState(null)
      const anchor = React.useRef(null)
      const timer = React.useRef(null)
      const side_ = side || 'top'
      const show = () => {
        const el = anchor.current
        if (!el) return
        const r = el.getBoundingClientRect()
        let left = r.left + r.width / 2
        let top = r.top - 8
        if (side_ === 'bottom') top = r.bottom + 8
        setPos({ left, top })
      }
      const delayed = (fn) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(fn, delayMs || 0)
      }
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      const child = React.Children.only(children)
      return React.createElement(React.Fragment, null, [
        React.cloneElement(child, {
          ref: (el) => { anchor.current = el; if (typeof child.ref === 'function') child.ref(el) },
          onMouseEnter: (e) => { if (child.props.onMouseEnter) child.props.onMouseEnter(e); delayed(show) },
          onMouseLeave: (e) => { if (child.props.onMouseLeave) child.props.onMouseLeave(e); if (timer.current) clearTimeout(timer.current); setPos(null) },
          onFocus: (e) => { if (child.props.onFocus) child.props.onFocus(e); delayed(show) },
          onBlur: (e) => { if (child.props.onBlur) child.props.onBlur(e); if (timer.current) clearTimeout(timer.current); setPos(null) },
        }),
        pos === null ? null : React.createElement('span', {
          role: 'tooltip',
          style: {
            position: 'fixed', left: pos.left, top: pos.top, zIndex: 1200,
            transform: side_ === 'bottom' ? 'translateX(-50%)' : 'translateX(-50%) translateY(-100%)',
            padding: '4px 8px', borderRadius: 'var(--dsw-radius-md)',
            background: 'var(--dsw-alias-tooltip-bg)', color: 'var(--dsw-alias-tooltip-label)',
            fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap',
            boxShadow: 'var(--dsw-shadow-lv2)', pointerEvents: 'none',
          },
        }, typeof label === 'function' ? label() : label),
      ])
    }

    /** Resolve the shared controls: prefer the primitives row (pre-0.2.0), else self-owned. */
    const Toast = (_uc_primitives && _uc_primitives.Toast) || UcToast
    const Tooltip = (_uc_primitives && _uc_primitives.Tooltip) || UcTooltip
    const Menu = (_uc_primitives && _uc_primitives.Menu) || null
    const writeClipboard = (_uc_primitives && _uc_primitives.writeClipboard) || (async (text) => {
      try { await navigator.clipboard.writeText(text); return { ok: true } } catch (e) { return { ok: false, error: e } }
    })


    const SLOT = 'conversation.input.overlay'
    const ROW_ID = 'composer-history-recall'
    const ROW_ORDER = 50
    const NS = 'composer-history-recall'
    const COMPOSER_ATTR = 'data-composer-input'
    var EMPTY_HISTORY = []

    // --- diagnostics (read-only; no message content) --------------------------
    var __diag = {
      loaded: true,
      applied: false,
      mounted: 0,
      hasActions: false,
      hasConv: false,
      hasInput: false,
      historyLen: 0,
      chatPresent: false,
      legacyLen: -1,
      orderLen: -1,
      kinds: null,
      keys: 0,
      lastKey: null,
      lastGate: 'init',
      recalls: 0,
    }
    try { if (typeof window !== 'undefined') window.__dshr = __diag } catch { /* no window */ }

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'toast.oldest': '已是最早一条历史',
      'toast.newest': '已退出历史浏览',
    }
    const enDict = {
      'toast.oldest': 'Oldest history entry',
      'toast.newest': 'Left history browsing',
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

    /** Re-render on locale snapshot changes so toast copy follows the language. */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- caret / history readers (pure, DOM-injected so they are testable) ----

    /** Resolve the focused composer root, or null when focus is elsewhere. */
    function focusedComposer() {
      if (typeof document === 'undefined') return null
      const ae = document.activeElement
      if (!ae || typeof ae !== 'object') return null
      if (typeof ae.closest === 'function') {
        const root = ae.closest('[' + COMPOSER_ATTR + ']')
        if (root) return root
      }
      if (typeof ae.hasAttribute === 'function' && ae.hasAttribute(COMPOSER_ATTR)) return ae
      return null
    }

    /**
     * Locate the caret's logical line inside the composer root.
     * @param editorEl - the [data-composer-input] element.
     * @returns { line, lineCount, beforeCaret } or null when the selection is
     *   not a collapsed caret inside one of the root's direct block children.
     */
    function readCaretLine(editorEl) {
      const sel = (typeof window !== 'undefined' && typeof window.getSelection === 'function')
        ? window.getSelection()
        : null
      if (!sel || !sel.rangeCount || sel.isCollapsed !== true) return null
      const node = sel.anchorNode
      if (!node || typeof editorEl.contains !== 'function' || !editorEl.contains(node)) return null
      const kids = editorEl.children || []
      // Caret anchored on the root itself (empty editor): use the offset child.
      if (node === editorEl) {
        if (kids.length === 0) return { line: 0, lineCount: 1, beforeCaret: '' }
        var oi = Math.min(Math.max(sel.anchorOffset || 0, 0), kids.length - 1)
        return { line: oi, lineCount: kids.length, beforeCaret: '' }
      }
      let block = node.nodeType === 3 ? node.parentElement : node
      while (block && block.parentElement !== editorEl) block = block.parentElement
      if (!block) return null
      var idx = -1
      for (var i = 0; i < kids.length; i += 1) {
        if (kids[i] === block) { idx = i; break }
      }
      if (idx < 0) return null
      var beforeCaret = ''
      if (node.nodeType === 3 && typeof node.textContent === 'string') {
        beforeCaret = node.textContent.slice(0, sel.anchorOffset || 0)
      }
      return { line: idx, lineCount: kids.length, beforeCaret: beforeCaret }
    }

    /** True when the caret sits inside an active slash/mention trigger token. */
    function isTriggerToken(beforeCaret) {
      return /(?:^|\s)[/@]\S*$/.test(beforeCaret || '')
    }

    /**
     * Project the 'chat' view snapshot into a newest-first list of sent user
     * messages. Assistant / command / steering nodes are ignored; blank entries
     * are dropped.
     * @param chat - ChatSnapshot | undefined.
     * @returns readonly string[] newest-first.
     */
    function deriveHistory(chat) {
      if (!chat) return EMPTY_HISTORY
      // Primary: the raw ordered ConversationNode[] compatibility slice. The
      // view-node store (chat.nodes.get) returns renderer nodes whose payload
      // sits under .data, so reading .content off them yields nothing.
      var list = null
      if (chat.legacy && Array.isArray(chat.legacy.nodes)) {
        list = chat.legacy.nodes
      } else if (Array.isArray(chat.order) && chat.nodes && typeof chat.nodes.get === 'function') {
        list = []
        for (const key of chat.order) {
          const view = chat.nodes.get(key)
          if (view) list.push(view)
        }
      }
      if (!list) return EMPTY_HISTORY
      const out = []
      for (const node of list) {
        if (!node || node.kind !== 'user') continue
        const blocks = Array.isArray(node.content) ? node.content
          : (node.data && Array.isArray(node.data.content) ? node.data.content : [])
        var text = ''
        for (const block of blocks) {
          // Real LLM ContentBlock is keyed by `type` (TextBlock = {type:'text',
          // text}); older/other projections use `kind`. Accept either.
          const btype = block && (block.type || block.kind)
          if (btype === 'text' && typeof block.text === 'string') {
            text += (text ? '\n' : '') + block.text
          }
        }
        text = text.trim()
        if (text) out.push(text)
      }
      out.reverse()
      return out
    }

    // --- the bridge component -------------------------------------------------

    function HistoryRecallBridge({ sessionId, useConversation, useInput, inputActions, t: seatT }) {
      const t = typeof seatT === 'function' ? seatT : __t
      useLocaleRevision()

      const chat = useConversation
        ? useConversation((s) => (s && s.views && typeof s.views.get === 'function' ? s.views.get('chat') : undefined))
        : undefined
      const input = useInput ? useInput((s) => s) : undefined
      const history = useMemo(() => deriveHistory(chat), [chat])

      __diag.mounted += 1
      __diag.hasActions = !!(inputActions && typeof inputActions.setDraft === 'function')
      __diag.hasConv = typeof useConversation === 'function'
      __diag.hasInput = typeof useInput === 'function'
      __diag.historyLen = history.length
      __diag.chatPresent = !!chat
      __diag.legacyLen = chat && chat.legacy && Array.isArray(chat.legacy.nodes) ? chat.legacy.nodes.length : -1
      __diag.orderLen = chat && Array.isArray(chat.order) ? chat.order.length : -1
      if (chat && chat.legacy && Array.isArray(chat.legacy.nodes)) {
        const kc = {}
        for (const n of chat.legacy.nodes) { const k = n && n.kind; if (k) kc[k] = (kc[k] || 0) + 1 }
        __diag.kinds = kc
      }

      // Refs the document listener reads, kept fresh on every render.
      const historyRef = useRef(history)
      historyRef.current = history
      const inputRef = useRef(input)
      inputRef.current = input
      const actionsRef = useRef(inputActions)
      actionsRef.current = inputActions
      const tRef = useRef(t)
      tRef.current = t

      // Browse state (refs: no re-render needed to advance).
      const indexRef = useRef(null)        // null = not browsing; else index into history
      const savedDraftRef = useRef('')     // draft captured on entry, restored on exit
      const lastWrittenRef = useRef('')    // the exact string WE last wrote (edit detection)
      const sessionRef = useRef(sessionId)

      const [toast, setToast] = useState(null)
      const toastSeq = useRef(0)
      const showToast = useCallback((text) => {
        if (!Toast) return
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])

      // Session switch: drop the browse cursor so the next ArrowUp re-enters
      // against the NEW session's history (design D4 reset ③).
      useEffect(() => {
        if (sessionRef.current !== sessionId) {
          sessionRef.current = sessionId
          indexRef.current = null
          savedDraftRef.current = ''
          lastWrittenRef.current = ''
        }
      }, [sessionId])

      // External-edit / send reset (design D4 reset ①②): whenever the draft
      // settles to something we did not just write, leave browse mode. Runs on
      // the committed draft value, so it is free of the setDraft async lag.
      const draft = input && typeof input.draft === 'string' ? input.draft : ''
      useEffect(() => {
        if (indexRef.current !== null && draft !== lastWrittenRef.current) {
          indexRef.current = null
        }
      }, [draft])

      // The single document capture listener, attached once for the component's
      // life (the overlay only mounts with a session, so capabilities exist).
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined
        }
        const onKey = (event) => {
          if (!event) return
          const key = event.key
          if (key !== 'ArrowUp' && key !== 'ArrowDown') return
          __diag.keys += 1
          __diag.lastKey = key
          if (event.isComposing === true || event.keyCode === 229) { __diag.lastGate = 'composing'; return }
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) { __diag.lastGate = 'modifier'; return }

          const actions = actionsRef.current
          if (!actions || typeof actions.setDraft !== 'function') { __diag.lastGate = 'no-actions'; return }
          const editorEl = focusedComposer()
          if (!editorEl) { __diag.lastGate = 'not-focused'; return }
          const current = inputRef.current
          if (!current) { __diag.lastGate = 'no-input'; return }
          const hist = historyRef.current

          const consume = () => {
            try { event.preventDefault() } catch { /* synthetic events may omit it */ }
            try { event.stopPropagation() } catch { /* same */ }
          }
          const write = (text) => {
            lastWrittenRef.current = text
            actions.setDraft(text)
          }

          if (indexRef.current === null) {
            // Entry is ArrowUp-only (ArrowDown has nothing newer to offer).
            if (key !== 'ArrowUp') { __diag.lastGate = 'down-noop'; return }
            if (!hist || hist.length === 0) { __diag.lastGate = 'no-history'; return }
            if (current.occurrences && current.occurrences.length > 0) { __diag.lastGate = 'has-chips'; return }
            const caret = readCaretLine(editorEl)
            var firstLine
            var beforeCaret = ''
            if (caret) {
              firstLine = caret.line === 0
              beforeCaret = caret.beforeCaret
            } else if ((current.draft || '') === '') {
              firstLine = true // empty composer is unambiguously the first line
            } else {
              __diag.lastGate = 'caret-unknown'; return
            }
            if (!firstLine) { __diag.lastGate = 'not-first-line'; return }
            if (isTriggerToken(beforeCaret)) { __diag.lastGate = 'trigger-token'; return }
            savedDraftRef.current = typeof current.draft === 'string' ? current.draft : ''
            indexRef.current = 0
            __diag.recalls += 1
            __diag.lastGate = 'recall:0'
            write(hist[0])
            consume()
            return
          }

          // Browsing: advance freely.
          if (key === 'ArrowUp') {
            const next = indexRef.current + 1
            if (next >= hist.length) {
              __diag.lastGate = 'boundary-oldest'
              showToast(tRef.current('toast.oldest'))
              consume()
              return
            }
            indexRef.current = next
            __diag.recalls += 1
            __diag.lastGate = 'recall:' + next
            write(hist[next])
            consume()
            return
          }
          const next = indexRef.current - 1
          if (next < 0) {
            indexRef.current = null
            __diag.lastGate = 'exit-browse'
            write(savedDraftRef.current)
            consume()
            return
          }
          indexRef.current = next
          __diag.recalls += 1
          __diag.lastGate = 'recall:' + next
          write(hist[next])
          consume()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [showToast])

      if (!toast) return null
      return React.createElement(Toast, {
        key: toast.seq,
        text: toast.text,
        onDone: () => setToast(null),
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

    function apply(ctx) {
      __diag.applied = true
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
        })
      }
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, HistoryRecallBridge))
    }

    // The loader gates apply() until `slots` exists (to register the overlay
    // entry). Locale is wired lazily so the plugin still loads without it.
    return { apply, inject: ['slots'] }
  },
})
