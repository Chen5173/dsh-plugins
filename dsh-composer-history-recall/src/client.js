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

    // Toast is an optional affordance (design D6): if the primitives package is
    // absent we degrade to silent boundary handling, never a crash.
    var Toast = null
    try {
      Toast = require('@deepseek-ai/dsh-client-ui-primitives').Toast || null
    } catch {
      Toast = null
    }

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
