// dsh-esc-rewind: CLIENT half — the whole plugin lives here.
//
// Two entry points, one rewind engine:
//
//  1. Keyboard: while a session's turn is RUNNING, ESC once stops it; with the
//     turn stopped (ESC-stop or the toolbar Stop button) ESC again "rewinds"
//     the whole last exchange — the engine forks a branch from the previous
//     completed turn, archives the original session, opens the branch and
//     restores the prompt (text + best-effort images) into the composer.
//     Natural completions never arm; editing the draft, sending, or switching
//     sessions disarms.
//
//  2. Command: a client-owned `/rewind` contribution (ctx.commandUi popupSelect)
//     opens the core picker whose options cover the ENTIRE conversation: when
//     the picker opens, options() first pages ALL history into the client
//     window with one session.loadThrough(0) call (the same turn-jump loader
//     the core chat uses), then lists every user exchange newest-first with
//     round number + relative time. Because everything is loaded before the
//     rows render, the native shell's search + arrow navigation can reach any
//     exchange, however old — nothing is dynamically appended afterwards.
//     Picking one restarts from before it (same engine, including the
//     first-exchange fallback to a fresh same-workspace session).
//
//  DSH is append-only: no plugin can delete messages in place, so "rewind" is
//  expressed with the officially supported, non-destructive primitives — fork
//  a branch (like the core Branch button), archive the original (the row-menu
//  Archive action keeps the log recoverable). The only client services used:
//  sessions (binding/fork/open/create/loadOlder/loadThrough), workspaces
//  (archiveSession), conversation (cancel/updateQueue/createDrafts — pre-0.1.5
//  core spells the last one createDraftImages; both are probed by capability),
//  uiConversation (per-session node snapshots), commandUi (the '/'-menu).
//
// Why a document capture listener: the composer is a Lexical contenteditable
// whose keyboard face is package-private, so the ESC bridge listens on
// document in the CAPTURE phase (before every core bubble-phase Escape close)
// and — hard-gated on "session rewindable + no overlay/menu open + no foreign
// text field" — otherwise returns without touching the event.
//
// Diagnostics: a read-only snapshot is published on window.__dsew plus the pure
// node/decision helpers (for the logic harness) — counters and last decisions
// only, never full message content.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns { apply, inject }. No JSX: plain React.createElement.

window.__ModuleLoader__.load({
  id: 'dsh-esc-rewind',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // Toast is an optional affordance: if the primitives package is absent we
    // degrade to silent handling, never a crash.
    var Toast = null
    try {
      Toast = require('@deepseek-ai/dsh-client-ui-primitives').Toast || null
    } catch {
      Toast = null
    }

    const SLOT = 'conversation.input.overlay'
    const ROW_ID = 'esc-rewind'
    const ROW_ORDER = 60
    /** Session-header slot hosting the dispose-mode toggle (delete mode). */
    const HEADER_SLOT = 'conversation.session.header.actions'
    const HEADER_ROW_ID = 'esc-rewind-dispose'
    const HEADER_ORDER = 28
    const NS = 'esc-rewind'
    /** Settings namespace/field (node half registers the same keys). */
    const SETTINGS_NS = 'esc-rewind'
    const SETTINGS_FIELD = 'deleteOldOnRewind'
    /** Host delete endpoint (node half serves it when a web surface exists). */
    const DELETE_ENDPOINT = '/__esc-rewind/session/delete'
    const COMPOSER_ATTR = 'data-composer-input'
    const REWIND_COMMAND = 'rewind'
    /** How many draft images a rewind may try to restore. */
    const MAX_IMAGES = 9
    /** Pending composer-restore expiry (ms). */
    const PENDING_TTL_MS = 30000
    /** Safety cap for the loadOlder fallback loop (loadThrough is preferred). */
    const MAX_OLDER_PAGES = 400

    // --- module state ---------------------------------------------------------

    /** Services captured lazily via ctx.inject inside apply(). */
    var __svc = {
      sessions: null,
      workspaces: null,
      conversation: null,
      uiConversation: null,
      commandUi: null,
    }
    /**
     * Global delete-mode switch (client cache of settings `deleteOldOnRewind`).
     * false (default) = after a rewind the old session is ARCHIVED (recoverable);
     * true = the old session is permanently DELETED via the host half. Read from
     * remote.settings.describe() once settings is reachable; any failure falls
     * back to false (safety first — never delete because a read failed).
     */
    var __deleteMode = false
    /** Whether describe() has been consulted at least once (diagnostics). */
    var __deleteModeLoaded = false
    /** Lazy handle to the client remote.settings controller. */
    var __settings = null
    /** Whether the settings/document-updated subscription was established. */
    var __settingsEventsBound = false
    /** Subscribers notified when the delete-mode switch changes (header icons). */
    var __disposeListeners = new Set()
    /** One outstanding "restore me after I mount" draft, keyed by target session. */
    var __pending = null
    /** sessionId -> seq of the run for which we already issued an ESC stop. */
    var __stopMarks = new Map()
    /** sessionIds currently inside a rewind (dedupe double triggers). */
    var __busy = new Set()
    /** Toast fan-out: listeners registered by mounted bridges. */
    var __toastListeners = new Set()
    /**
     * sessionIds whose conversation window this page has already fully loaded
     * (window anchored at the very start and growing live at the tail). Once
     * set, /rewind reads the live snapshot and never re-pages the whole log.
     */
    var __fullLoaded = new Set()
    /**
     * Per-session known user exchanges (chronological, full fields), kept in
     * memory and mirrored to localStorage (keyed by session) so a page reload
     * can serve /rewind from the record instead of re-reading the whole log.
     * Freshness: each entry carries watermarkSeq (newest user exchange seq at
     * build time); when the live tail shows something newer, the cache is
     * stale and a reload merges the delta.
     */
    var __known = new Map()
    const CACHE_PREFIX = 'dsh-esc-rewind.history.'
    /** Upper bound for a persisted entry (localStorage quota safety). */
    const CACHE_MAX_BYTES = 2500000
    /** Locale helpers (wired lazily, like the sibling plugins). */
    var __locale = null

    // 核心世代标志（命令描述契约用）：'string' = 旧核心当值渲染，'function' = 新核心会调用。
    var __commandDescShape = 'string'

    var __diag = {
      loaded: true,
      applied: false,
      mounted: 0,
      services: { sessions: false, workspaces: false, conversation: false, uiConversation: false, commandUi: false, settings: false },
      escStops: 0,
      rewinds: 0,
      pendingApplied: 0,
      historyLoads: 0,
      /** 自动弹出的「再按 Esc 回退」提示次数（非用户按键路径）。 */
      hintToasts: 0,
      /** 最近一次提示的判据：'tail-interrupted' | 'turn-aborted' | null。 */
      lastHint: null,
      lastGate: 'init',
      lastAction: null,
      rewindAvail: null,
      imageFail: null,
      // 草稿附件桥接探测结果：createDrafts（新）/createDraftImages（旧）/null（都缺）；
      // addAttachments（新）/addImages（旧）/null（都缺）。真机排障时一眼看出核心世代。
      draftCreateApi: null,
      draftRestoreApi: null,
      // 命令描述契约形态：0.1.5-rc.2 起核心把 `description` 由字符串改成 `() => string`。
      // 值 = 'function'（新契约，核心会调用） / 'string'（旧契约，核心当值渲染）。
      commandDescShape: 'string',
      // 回退前后的「未落定输入」处理：清掉的排队项数 / 是否因清不掉而放弃回退 /
      // 子会话打开后清掉的继承残留数（见 settlePendingInputs）。
      pendingCleared: 0,
      pendingBlocked: false,
      childPendingCleared: 0,
      titleFail: null,
      archiveFail: null,
      deleteFail: null,
      settingsReadFail: null,
      deleteMode: false,
      deleteModeLoaded: false,
      settingsEventsBound: false,
      disposeToggles: 0,
      lastDelete: null,
      lastRewind: null,
    }
    try { if (typeof window !== 'undefined') window.__dsew = __diag } catch { /* no window */ }

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'esc.hint': '已停止 · 再按 Esc 回退本轮',
      'rewind.busy': '正在回退…',
      'rewind.done': '已回退，可改写问题后重新发送',
      'rewind.error': '回退失败：{msg}',
      'rewind.cmd.desc': '从历史某个回合重新开始（原会话将归档）',
      'rewind.loading': '正在读取全部历史…',
      'rewind.load.fail': '读取历史失败：{msg}',
      'rewind.image.only': '（图片消息）',
      'rewind.round': '第 {n} 轮',
      'rewind.none': '没有可回退的历史回合',
      'rewind.pending': '该会话还有没发出的消息在排队，等它落定后再回退（避免把它复制进新分支）',
      'esc.hint.delete': '已停止 · 再按 Esc 将删除本轮并重来（不可恢复）',
      'dispose.title.archive': '回退后归档旧会话（可恢复）',
      'dispose.title.delete': '回退后删除旧会话（不可恢复）',
      'dispose.on': '已开启：回退将删除旧会话（不可恢复）',
      'dispose.off': '已关闭：回退将归档旧会话',
      'dispose.error': '切换失败：{msg}',
      'rewind.deleted': '旧会话已删除',
      'rewind.delete.fail': '删除失败，已改为归档',
    }
    const enDict = {
      'esc.hint': 'Stopped · press Esc again to rewind this turn',
      'rewind.busy': 'Rewinding…',
      'rewind.done': 'Rewound — edit the prompt and resend',
      'rewind.error': 'Rewind failed: {msg}',
      'rewind.cmd.desc': 'Restart from an earlier exchange (the original session is archived)',
      'rewind.loading': 'Reading the whole history…',
      'rewind.load.fail': 'Failed to read history: {msg}',
      'rewind.image.only': '(image message)',
      'rewind.round': 'Turn {n}',
      'rewind.none': 'No rewindable exchanges in this session',
      'rewind.pending': 'A message is still queued in this session — rewind once it lands (avoids copying it into the new branch)',
      'esc.hint.delete': 'Stopped · press Esc again to DELETE this turn and restart (irreversible)',
      'dispose.title.archive': 'After rewinding, archive the old session (recoverable)',
      'dispose.title.delete': 'After rewinding, DELETE the old session (irreversible)',
      'dispose.on': 'Enabled: rewinding will delete the old session (irreversible)',
      'dispose.off': 'Disabled: rewinding will archive the old session',
      'dispose.error': 'Switch failed: {msg}',
      'rewind.deleted': 'Old session deleted',
      'rewind.delete.fail': 'Delete failed — archived instead',
    }

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** Resolve a key through the locale service, falling back to the sniffed dict. */
    function __t(key, vars) {
      let text = null
      if (__locale && typeof __locale.translate === 'function') {
        const candidate = __locale.translate(NS, key)
        if (typeof candidate === 'string' && candidate !== key) text = candidate
      }
      if (text === null) text = (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
      if (vars) {
        for (const k of Object.keys(vars)) {
          text = text.split('{' + k + '}').join(String(vars[k]))
        }
      }
      return text
    }

    // --- pure node readers (shape-tolerant across core versions) --------------

    /** Normalize one view/record node's kind, or null. */
    function nodeKind(node) {
      if (!node) return null
      if (typeof node.kind === 'string') return node.kind
      const data = node.data
      if (data && typeof data.kind === 'string') return data.kind
      return null
    }

    /** Normalize one node's durable seq (view anchor or record seq). */
    function nodeSeq(node) {
      if (!node) return null
      if (typeof node.seq === 'number') return node.seq
      if (typeof node.anchorSeq === 'number') return node.anchorSeq
      const data = node.data
      if (data) {
        if (typeof data.seq === 'number') return data.seq
        if (typeof data.anchorSeq === 'number') return data.anchorSeq
      }
      return null
    }

    /** Normalize one node's epoch-ms time. */
    function nodeTime(node) {
      if (!node) return null
      if (typeof node.time === 'number') return node.time
      const data = node.data
      if (data && typeof data.time === 'number') return data.time
      return null
    }

    /** Ordered content blocks of a message node (user/steering/context). */
    function contentOf(node) {
      if (!node) return []
      if (Array.isArray(node.content)) return node.content
      const data = node.data
      if (data && Array.isArray(data.content)) return data.content
      return []
    }

    /** The assistant lifecycle status ('running'|'settled'|'interrupted'|null). */
    function assistantStatusOf(node) {
      const kind = nodeKind(node)
      if (kind !== 'assistant') return null
      if (node && (node.status === 'running' || node.status === 'settled' || node.status === 'interrupted')) {
        return node.status
      }
      const data = node && node.data
      if (data) {
        if (data.status === 'running' || data.status === 'settled' || data.status === 'interrupted') return data.status
        if (data.interrupted === true) return 'interrupted'
        if (Array.isArray(data.blocks) && data.finalNode) return 'settled'
        if (Array.isArray(data.blocks)) return 'running'
      }
      if (node && node.interrupted === true) return 'interrupted'
      if (node && Array.isArray(node.blocks)) return 'settled'
      return 'settled'
    }

    /** Concatenated plain text of a message node's content blocks. */
    function nodeText(node) {
      const blocks = contentOf(node)
      let text = ''
      for (const block of blocks) {
        if (!block) continue
        const type = block.type || block.kind
        if (type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text
      }
      return text.trim()
    }

    /** Durable image attachment references embedded in a message node's content. */
    function nodeImageRefs(node) {
      const refs = []
      const blocks = contentOf(node)
      for (const block of blocks) {
        if (!block) continue
        const type = block.type || block.kind
        if (type !== 'image') continue
        const source = block.attachment || block.image || null
        const attachmentId = source && (source.attachmentId || source.id)
        if (attachmentId) {
          refs.push({
            attachmentId,
            mediaType: (source.mediaType) || 'image/png',
            name: source.name,
          })
        }
      }
      return refs
    }

    // --- draft-attachment bridge (shape-tolerant across core generations) -----

    /**
     * 创建浏览器侧草稿附件，返回其 id 数组。
     * - 0.1.5-rc.2 起核心把「图片草稿」泛化为「附件草稿」，签名变为
     *   `createDrafts(sessionId, files)`；旧版是 `createDraftImages(files)`。
     *   两代都返回 `[{ id }]`，所以只按能力探测选名字，不按版本号分支。
     * - 参数类型：conversation -- object|undefined：注入的 conversation 服务；
     *   sessionId -- string：目标会话（新签名需要）；files -- File[]
     * - 返回值：string[]｜null —— id 数组；两代 API 都不可用时返回 null
     */
    function createDraftAttachments(conversation, sessionId, files) {
      if (!conversation || !Array.isArray(files) || files.length === 0) return null
      __diag.draftCreateApi = null
      try {
        if (typeof conversation.createDrafts === 'function' && sessionId) {
          __diag.draftCreateApi = 'createDrafts'
          const drafts = conversation.createDrafts(sessionId, files)
          return Array.isArray(drafts) ? drafts.map((draft) => draft && draft.id).filter(Boolean) : []
        }
        if (typeof conversation.createDraftImages === 'function') {
          __diag.draftCreateApi = 'createDraftImages'
          const drafts = conversation.createDraftImages(files)
          return Array.isArray(drafts) ? drafts.map((draft) => draft && draft.id).filter(Boolean) : []
        }
      } catch (error) {
        __diag.imageFail = (error && error.message) ? error.message : String(error)
      }
      return null
    }

    /**
     * 释放未被采用的草稿附件（回退失败时不留垃圾草稿）。
     * - 新名 `releaseDraftAttachment(id)`（0.1.5-rc.2 起），旧名 `releaseDraftImage(id)`。
     * - 参数类型：conversation -- object|undefined；id -- string
     * - 返回值：boolean —— true 表示已调用某个世代的释放 API
     */
    function releaseDraftAttachment(conversation, id) {
      if (!conversation || !id) return false
      if (typeof conversation.releaseDraftAttachment === 'function') {
        conversation.releaseDraftAttachment(id)
        return true
      }
      if (typeof conversation.releaseDraftImage === 'function') {
        conversation.releaseDraftImage(id)
        return true
      }
      return false
    }

    /**
     * 把草稿附件 id 交回编辑器（回退后恢复原提问里的图片）。
     * - 新名 `addAttachments(ids)`（0.1.5-rc.2 起），旧名 `addImages(ids)`。
     * - 参数类型：actions -- object|undefined：槽位注入的 inputActions；ids -- string[]
     * - 返回值：boolean —— true 表示已交给某个世代的 API
     */
    function restoreDraftAttachments(actions, ids) {
      if (!actions || !Array.isArray(ids) || ids.length === 0) return false
      if (typeof actions.addAttachments === 'function') {
        __diag.draftRestoreApi = 'addAttachments'
        try { actions.addAttachments(ids); return true } catch { return false }
      }
      if (typeof actions.addImages === 'function') {
        __diag.draftRestoreApi = 'addImages'
        try { actions.addImages(ids); return true } catch { return false }
      }
      __diag.draftRestoreApi = null
      return false
    }

    /** Ordered node list from a 'chat' view snapshot (tolerant of shapes). */
    function chatNodeList(chat) {
      if (!chat) return []
      // Raw ConversationNode[] records path.
      if (chat.legacy) {
        if (Array.isArray(chat.legacy.nodes)) return chat.legacy.nodes.filter(Boolean)
        if (Array.isArray(chat.legacy)) return chat.legacy.filter(Boolean)
      }
      if (Array.isArray(chat)) return chat.filter(Boolean)
      // View-node store path: order keys + nodes.get(key).
      if (Array.isArray(chat.order) && chat.nodes && typeof chat.nodes.get === 'function') {
        const out = []
        for (const key of chat.order) {
          const node = chat.nodes.get(key)
          if (node) out.push(node)
        }
        return out
      }
      return []
    }

    /** One selectable rewind point (a user exchange start). */
    function buildExchanges(list) {
      const out = []
      for (let i = 0; i < list.length; i += 1) {
        const node = list[i]
        if (nodeKind(node) !== 'user') continue
        let anchorSeq = null
        for (let j = i - 1; j >= 0; j -= 1) {
          const prior = list[j]
          if (nodeKind(prior) === 'assistant' && assistantStatusOf(prior) === 'settled') {
            anchorSeq = nodeSeq(prior)
            break
          }
        }
        out.push({
          index: i,
          seq: nodeSeq(node),
          time: nodeTime(node),
          text: nodeText(node),
          imageRefs: nodeImageRefs(node),
          anchorSeq,
          isFirst: i === 0,
        })
      }
      return out
    }

    /** Whether an exchange can be forked to (blank first turn or after a completed turn). */
    function qualifyExchange(ex) {
      if (!ex) return false
      if (ex.isFirst) return true
      return ex.anchorSeq !== null && ex.anchorSeq !== undefined
    }

    /** Newest (chronologically last) user exchange. */
    function lastExchange(list) {
      const exchanges = buildExchanges(list)
      return exchanges.length === 0 ? null : exchanges[exchanges.length - 1]
    }

    /**
     * - 函数功能：取「对话尾部是 assistant 行」时的生命周期状态；尾部不是 assistant 行（例如本轮刚发出的 user 提问）时返回 null，表示本轮尚未定型。
     * - 参数类型：
     *     list: Array -- 会话节点列表，例如 [user(1,'q'), { kind:'assistant', seq:2, interrupted:true }]
     * - 返回值：
     *     retval: string|null -- 'running' | 'settled' | 'interrupted'，或 null（尾部非 assistant / 空列表）
     * - 调用样例：
     *     tailStatus(list) === 'interrupted'   // 该轮被中断（用户停止）
     */
    function tailStatus(list) {
      const tail = list && list.length ? list[list.length - 1] : null
      if (!tail || nodeKind(tail) !== 'assistant') return null
      return assistantStatusOf(tail)
    }

    /**
     * - 函数功能：判断对话尾部是否为「被中断（用户停止）」的 assistant 回复——即宿主写入的耐久停止证据。
     * - 参数类型：
     *     list: Array -- 会话节点列表，例如 [{ kind:'assistant', seq:2, blocks:[…], interrupted:true }]
     * - 返回值：
     *     retval: boolean -- true 表示尾部是带 interrupted 证据的 assistant 行
     * - 调用样例：
     *     tailInterrupted(list) === true
     */
    function tailInterrupted(list) {
      return tailStatus(list) === 'interrupted'
    }

    /**
     * - 函数功能：读「最后一轮」的 turn/end 终态证据（宿主写入、只有该轮真正收尾后才存在），用于区分「用户停止（aborted/user）」与「自然结束（completed/error/…）」；覆盖「尚未产出任何内容即被停」的回合（此时对话里没有 assistant 行）。
     * - 参数类型：
     *     chat: object -- 会话 chat 视图快照，例如 { timeline: { turnOrder:[1,2], turns: Map{…} } }
     * - 返回值：
     *     retval: string|null -- 'aborted:user' | 'aborted:<cause>' | 'completed' | 'error' | 'max-tokens' | 'blocked' | 'interrupted'；缺失或形状不符为 null
     * - 调用样例：
     *     lastTurnEndEvidence(chat) === 'aborted:user'
     *
     * 注意：kind 为 'interrupted' 的是持久化层崩溃修复标记（loop 不产出），不是用户停止。
     */
    function lastTurnEndEvidence(chat) {
      const timeline = chat && chat.timeline
      if (!timeline) return null
      const order = timeline.turnOrder
      const turns = timeline.turns
      if (!Array.isArray(order) || order.length === 0) return null
      if (!turns || typeof turns.get !== 'function') return null
      const turn = turns.get(order[order.length - 1])
      const end = turn && turn.end
      const reason = end && end.data && end.data.reason
      const kind = reason && typeof reason.kind === 'string' ? reason.kind : null
      if (kind === null) return null
      if (kind !== 'aborted') return kind
      const cause = reason.reason && typeof reason.reason.kind === 'string' ? reason.reason.kind : 'unknown'
      return 'aborted:' + cause
    }

    /** Whether the conversation tail ended abnormally, i.e. is NOT a naturally
     *  settled assistant. Running / interrupted / unrecognised / non-assistant
     *  tails (e.g. a just-sent user question without a reply yet) all qualify.
     *  An empty or settled tail does not arm a rewind. */
    function tailUnsettled(list) {
      const tail = list && list.length ? list[list.length - 1] : null
      if (!tail) return false
      if (nodeKind(tail) === 'assistant') return assistantStatusOf(tail) !== 'settled'
      return true
    }

    /**
     * Pure ESC decision. Returns { action, exchange }:
     *   'none'   — let Escape fall through to core (menus/close/etc.).
     *   'stop'   — cancel the running turn (first ESC).
     *   'rewind' — second ESC: stop (if needed) then fork/archive/open/restore.
     */
    function decideEsc(opts) {
      const running = opts && opts.running === true
      const draft = typeof opts.draft === 'string' ? opts.draft : ''
      const list = Array.isArray(opts.list) ? opts.list : []
      const exchange = lastExchange(list)
      const qualified = !!exchange && qualifyExchange(exchange)
      if (running) {
        if (opts.stopIssued === true && qualified) return { action: 'rewind', exchange }
        return { action: 'stop', exchange: qualified ? exchange : null }
      }
      if (qualified && draft === '' && tailUnsettled(list)) {
        // Non-running two-step arming: first ESC arms, second (stopIssued) rewinds.
        if (opts.stopIssued === true) return { action: 'rewind', exchange }
        return { action: 'arm', exchange }
      }
      return { action: 'none', exchange: null }
    }

    /** Short single-line snippet for picker rows. */
    function snippet(text, max) {
      const flat = String(text || '').replace(/\s+/g, ' ').trim()
      if (flat.length <= max) return flat
      return flat.slice(0, max) + '…'
    }

    /** Relative-ish clock label for picker rows. */
    function timeLabel(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      try {
        const date = new Date(ms)
        const now = new Date()
        const sameDay = date.toDateString() === now.toDateString()
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        if (sameDay) return hh + ':' + mm
        return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + hh + ':' + mm
      } catch {
        return ''
      }
    }

    function imageFileName(mediaType) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
      return 'image.' + (ext[mediaType] || 'png')
    }

    // --- toast fan-out --------------------------------------------------------

    function publishToast(text) {
      for (const listener of [...__toastListeners]) {
        try { listener(text) } catch { /* listener errors never break the turn */ }
      }
    }

    // --- service helpers (guarded, version-tolerant) --------------------------

    function sleep(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    function summaryOf(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null
        const state = sessions.list.getSnapshot()
        const row = state && state.byId ? state.byId[sessionId] : undefined
        return row || null
      } catch { return null }
    }

    function workspaceOf(sessionId) {
      try {
        const workspaces = __svc.workspaces
        if (!workspaces || !workspaces.list || typeof workspaces.list.getSnapshot !== 'function') return null
        const state = workspaces.list.getSnapshot()
        const items = state && Array.isArray(state.items) ? state.items : []
        for (const workspace of items) {
          if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
            return workspace.workspaceId
          }
        }
        return null
      } catch { return null }
    }

    function readSnapshot(value) {
      if (!value) return null
      if (typeof value.getSnapshot === 'function') return value.getSnapshot()
      if (typeof value.get === 'function') return value.get()
      return value
    }

    /** Imperative 'chat' snapshot for one session (for the /rewind command). */
    function snapshotChat(sessionId) {
      try {
        const uiConversation = __svc.uiConversation
        if (!uiConversation || typeof uiConversation.binding !== 'function') return null
        const binding = uiConversation.binding(sessionId)
        if (!binding) return null
        const snapshot = readSnapshot(binding.snapshot)
        if (!snapshot || !snapshot.views || typeof snapshot.views.get !== 'function') return null
        return snapshot.views.get('chat') || null
      } catch {
        return null
      }
    }

    function exchangesOfSession(sessionId) {
      return buildExchanges(chatNodeList(snapshotChat(sessionId)))
    }

    function findExchange(sessionId, seq) {
      const matches = exchangesOfSession(sessionId).filter((ex) => String(ex.seq) === String(seq))
      return matches.length ? matches[0] : null
    }

    /** Session-level facts (all guarded, never throws). */
    function sessionFacts(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions) return { hasMore: false, blank: false }
        const binding = sessions.binding(sessionId)
        if (!binding || !binding.session) return { hasMore: false, blank: false }
        const snapshot = typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null
        const summary = summaryOf(sessionId)
        return {
          hasMore: !!(snapshot && snapshot.hasMore),
          blank: !!(summary && summary.blank),
        }
      } catch {
        return { hasMore: false, blank: false }
      }
    }

    /** True when the session is a subagent transcript (forking is not offered there). */
    function isSubagentSession(sessionId) {
      const summary = summaryOf(sessionId)
      if (summary && summary.origin === 'subagent') return true
      return false
    }

    /** Wait until the assembled node count stops growing (assembler flush settles). */
    async function waitForSettled(sessionId, timeoutMs) {
      const limit = timeoutMs || 8000
      const started = Date.now()
      let last = -1
      let stable = 0
      for (;;) {
        const count = chatNodeList(snapshotChat(sessionId)).length
        const facts = sessionFacts(sessionId)
        if (count === last) stable += 1
        else { stable = 0; last = count }
        if (stable >= 2 && !facts.hasMore) return true
        if (Date.now() - started > limit) return true
        await sleep(150)
      }
    }

    // --- full-history refresh with load-once + cache --------------------------

    function cacheKey(sessionId) { return CACHE_PREFIX + sessionId }

    function localCacheGet(sessionId) {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(cacheKey(sessionId))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || !Array.isArray(parsed.exchanges) || typeof parsed.watermarkSeq !== 'number') return null
        return parsed
      } catch {
        return null
      }
    }

    function localCacheSet(sessionId, entry) {
      try {
        if (typeof localStorage === 'undefined') return
        const serialized = JSON.stringify(entry)
        if (serialized.length > CACHE_MAX_BYTES) return // too big: memory only
        localStorage.setItem(cacheKey(sessionId), serialized)
      } catch {
        /* quota/availability: memory entry still works for this page */
      }
    }

    /** In-memory + (on first touch) localStorage entry for one session. */
    function entryOf(sessionId) {
      const inMemory = __known.get(sessionId)
      if (inMemory) return inMemory
      const persisted = localCacheGet(sessionId)
      if (persisted) __known.set(sessionId, persisted)
      return persisted
    }

    /** Newest user-exchange seq across a chronological list (-1 when none). */
    function maxExchangeSeq(exchanges) {
      let max = -1
      for (const ex of exchanges) {
        const seq = Number(ex && ex.seq)
        if (Number.isFinite(seq) && seq > max) max = seq
      }
      return max
    }

    /** Remember a (chronological) exchange list for a session. */
    function rememberExchanges(sessionId, exchanges, persist) {
      const entry = { watermarkSeq: maxExchangeSeq(exchanges), exchanges }
      __known.set(sessionId, entry)
      if (persist) localCacheSet(sessionId, entry)
      return entry
    }

    /**
     * The best-known full exchange list for /rewind: memory → localStorage →
     * live window (whatever is currently assembled).
     */
    function knownExchangesOf(sessionId) {
      const entry = entryOf(sessionId)
      if (entry && Array.isArray(entry.exchanges)) return entry.exchanges
      return exchangesOfSession(sessionId)
    }

    /** Page-local reset of the full-load flags and caches (diagnostics/tests). */
    function resetHistoryCache() {
      __fullLoaded.clear()
      __known.clear()
    }

    /** Bring the ENTIRE conversation in, but only when needed (load-once). */
    async function refreshHistory(sessionId, signal) {
      const live = exchangesOfSession(sessionId)
      const liveLatest = maxExchangeSeq(live)
      const facts = sessionFacts(sessionId)

      // 1) This page already has the window anchored at the start: the live
      //    snapshot IS the whole history (new messages append at the tail and
      //    are always included). No request, nothing stale.
      if (__fullLoaded.has(sessionId) && !facts.hasMore) {
        const all = exchangesOfSession(sessionId)
        rememberExchanges(sessionId, all, false)
        return { ok: true, exchanges: all, from: 'live' }
      }

      // 2) Short-session fast path: hasMore false AND the very first exchange
      //    is visible → the window already covers everything.
      if (!facts.hasMore && live.some((ex) => ex.isFirst === true)) {
        __fullLoaded.add(sessionId)
        rememberExchanges(sessionId, live, true)
        return { ok: true, exchanges: live, from: 'live' }
      }

      // 3) Fresh record/cache that already reaches the newest exchange: serve
      //    it without touching the host (this is what makes the second open —
      //    and an open after a page reload with no new messages — instant).
      const known = entryOf(sessionId)
      if (known && known.watermarkSeq >= liveLatest && known.watermarkSeq >= 0) {
        return { ok: true, exchanges: known.exchanges, from: 'cache' }
      }

      // 4) No usable record, or the session grew since the record was taken
      //    (watermark older than the newest live exchange): load the whole log
      //    once and merge everything (this is the only "full reload" case).
      const sessions = __svc.sessions
      if (!sessions) return { ok: false, code: 'services-unavailable', exchanges: known ? known.exchanges : [] }
      const binding = sessions.binding(sessionId)
      if (!binding || !binding.session) {
        return { ok: false, code: 'no-binding', exchanges: known ? known.exchanges : [] }
      }
      const face = binding.session
      let all = known ? known.exchanges : []
      try {
        if (typeof face.loadThrough === 'function') {
          await face.loadThrough(0)
        } else {
          let guard = 0
          while (sessionFacts(sessionId).hasMore && guard < MAX_OLDER_PAGES) {
            if (signal && signal.aborted) break
            guard += 1
            await face.loadOlder()
          }
        }
        await waitForSettled(sessionId)
        __diag.historyLoads += 1
        all = exchangesOfSession(sessionId)
        __fullLoaded.add(sessionId)
        rememberExchanges(sessionId, all, true)
        return { ok: true, exchanges: all, from: 'load' }
      } catch (error) {
        return {
          ok: false,
          code: (error && error.message) ? error.message : String(error),
          exchanges: all,
        }
      }
    }

    async function sessionRunning(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions) return false
        const binding = sessions.binding(sessionId)
        if (!binding || !binding.session) return false
        const snapshot = typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null
        return !!(snapshot && snapshot.running)
      } catch { return false }
    }

    /** Cancel the running turn and wait until the session is quiescent. */
    async function ensureIdle(sessionId, timeoutMs) {
      const limit = timeoutMs || 8000
      const binding = __svc.sessions && __svc.sessions.binding(sessionId)
      if (!binding || !binding.session) return true
      const face = binding.session
      const running = async () => {
        try {
          const snapshot = typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
          return !!(snapshot && snapshot.running)
        } catch { return false }
      }
      if (!(await running())) return true
      try { await face.cancel() } catch { /* host may already be stopping */ }
      const start = Date.now()
      while (await running()) {
        if (Date.now() - start > limit) return false
        await sleep(120)
      }
      return true
    }

    /** Drop still-pending (queued, unexecuted) messages of this session. */
    async function clearQueue(sessionId) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (!binding || !binding.session) return
        const snapshot = typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null
        const queue = snapshot && Array.isArray(snapshot.queue) ? snapshot.queue : []
        for (const item of queue) {
          if (!item) continue
          try { await binding.session.updateQueue(item.id, { kind: 'remove' }) } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
    }

    /** 读取一个会话的当前快照（拿不到就返回 null）。 */
    function sessionSnapshotOf(sessionId) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (!binding || !binding.session) return null
        if (typeof binding.session.getSnapshot !== 'function') return null
        return binding.session.getSnapshot() || null
      } catch { return null }
    }

    /**
     * 把会话的「未落定输入」清干净并**确认**清空——回退前必须做，否则 fork 的
     * 事件种子会把这条 pending 输入一起复制进子会话（实测：子会话会执行它，
     * 而用户新发的那条排队等待，看起来就像同一条消息被执行了又被挂起）。
     *
     * 为什么必须「确认」而不是「发一次删除就算」：删除要作为事件落进宿主日志，
     * 且必须落在 fork 切点**之前**，子会话重放种子时才看不到这条插入。
     *
     * - 参数类型：sessionId -- string；options.budgetMs -- 有界等待预算（默认 1500ms）
     * - 返回值：{ cleared, remaining, empty } —— cleared=已请求删除的条数；
     *   remaining=预算用尽后仍未清空的条数；empty=是否已确认空
     */
    async function settlePendingInputs(sessionId, options) {
      const budgetMs = (options && typeof options.budgetMs === 'number') ? options.budgetMs : 1500
      const stepMs = 60
      const deadline = Date.now() + budgetMs
      let cleared = 0
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      for (;;) {
        const snapshot = sessionSnapshotOf(sessionId)
        const queue = snapshot && Array.isArray(snapshot.queue) ? snapshot.queue.filter(Boolean) : []
        if (queue.length === 0) return { cleared, remaining: 0, empty: true }
        for (const item of queue) {
          try {
            const binding = __svc.sessions && __svc.sessions.binding(sessionId)
            if (binding && binding.session) {
              await binding.session.updateQueue(item.id, { kind: 'remove' })
              cleared += 1
            }
          } catch { /* 单条失败不阻断：下一轮重试 */ }
        }
        if (Date.now() >= deadline) {
          const after = sessionSnapshotOf(sessionId)
          const left = after && Array.isArray(after.queue) ? after.queue.filter(Boolean).length : 0
          return { cleared, remaining: left, empty: left === 0 }
        }
        await sleep(stepMs)
      }
    }

    // --- the rewind engine ----------------------------------------------------

    /**
     * Rewind one session to just before a user exchange: cancel + clear the
     * queue, resolve images best-effort, fork (or create a fresh session for
     * the first exchange), keep the title, archive the original, open the
     * child, and queue a pending composer restore for the child.
     */
    async function doRewind(sessionId, exchange) {
      const sessions = __svc.sessions
      const workspaces = __svc.workspaces
      if (!sessions || !workspaces) return { ok: false, code: 'services-unavailable' }
      if (__busy.has(sessionId)) return { ok: false, code: 'busy' }
      __busy.add(sessionId)
      try {
        const binding = sessions.binding(sessionId)
        if (!binding) return { ok: false, code: 'no-binding' }
        const idle = await ensureIdle(sessionId)
        if (!idle) return { ok: false, code: 'stop-timeout' }
        // 未落定输入必须先清掉并**确认**为空再 fork：宿主的 fork 用事件种子重建子
        // 会话，父会话里那条刚发出、还没落盘的排队输入会被一并复制过去，于是子会话
        // 会先执行它，而用户此刻新发的消息只能排队（真机实测的「一条在执行、一条在
        // 等待、内容相同」）。清不掉就放弃本次回退，宁可不回退也不复制一份输入。
        const settled = await settlePendingInputs(sessionId)
        __diag.pendingCleared = settled.cleared
        if (!settled.empty) {
          __diag.pendingBlocked = true
          __diag.lastGate = 'pending-input'
          publishToast(__t('rewind.pending'))
          return { ok: false, code: 'pending-input' }
        }
        __diag.pendingBlocked = false

        // Best-effort image restore (D11): durable refs -> bytes -> draft files.
        let imageDraftIds = []
        const imageRefs = exchange && Array.isArray(exchange.imageRefs) ? exchange.imageRefs : []
        if (imageRefs.length > 0 && __svc.conversation
          && (typeof __svc.conversation.createDrafts === 'function'
            || typeof __svc.conversation.createDraftImages === 'function')
          && typeof File !== 'undefined') {
          const files = []
          try {
            for (const ref of imageRefs.slice(0, MAX_IMAGES)) {
              if (!ref || !ref.attachmentId) continue
              const result = await binding.session.readAttachment(ref.attachmentId).catch(() => null)
              if (!result || !result.ok || !result.value) continue
              const attachment = result.value.attachment || {}
              const data = result.value.data
              const name = attachment.name || imageFileName(ref.mediaType || attachment.mediaType)
              files.push(new File([data], name, { type: attachment.mediaType || 'image/png' }))
            }
          } catch (error) {
            __diag.imageFail = (error && error.message) ? error.message : String(error)
          }
          imageDraftIds = createDraftAttachments(__svc.conversation, sessionId, files) || []
        }

        try {
          const oldSummary = summaryOf(sessionId)
          const oldTitle = oldSummary ? (oldSummary.title || oldSummary.displayTitle) : null
          let childId
          if (exchange.isFirst === true) {
            // First-exchange edge (D9/D18): no history to fork — new blank
            // session in the same workspace.
            const workspaceId = workspaceOf(sessionId)
            childId = workspaceId
              ? await sessions.create({ workspaceId })
              : await sessions.create()
          } else {
            childId = await sessions.fork({ sessionId, atSeq: exchange.anchorSeq, increaseTitle: false })
          }
          // Keep the original title on the branch (D10).
          if (oldTitle) {
            try {
              const childSummary = summaryOf(childId)
              const childTitle = childSummary ? (childSummary.title || childSummary.displayTitle) : null
              if (childTitle && childTitle !== oldTitle) {
                const childBinding = sessions.binding(childId)
                if (childBinding) await childBinding.session.rename(oldTitle)
              }
            } catch (error) {
              __diag.titleFail = (error && error.message) ? error.message : String(error)
            }
          }
          // Open the branch BEFORE disposing the original: opening the child
          // first means the archive/delete only affects the original (never
          // clears the current selection out from under the user).
          sessions.open(childId)
          // 兜底：万一父会话的 pending 输入还是在切点之前挤进了种子，打开分支后
          // 立刻清掉它——否则子会话会替用户把那条旧消息执行掉。
          const childSettled = await settlePendingInputs(childId, { budgetMs: 600 })
          __diag.childPendingCleared = childSettled.cleared
          armPendingRestore(childId, (exchange && exchange.text) || '', imageDraftIds)
          // Dispose the original AFTER the child exists (D8) and — in delete
          // mode — only after the branch is confirmed open & usable (D7). A
          // failed delete degrades to archive; a failed archive is recorded.
          if (deleteModeOn()) {
            await deleteOldSession(sessionId)
          } else {
            try { await workspaces.archiveSession(sessionId) } catch (error) {
              __diag.archiveFail = (error && error.message) ? error.message : String(error)
            }
          }
          __diag.rewinds += 1
          __diag.lastRewind = { from: sessionId, to: childId, seq: exchange ? exchange.seq : null }
          return { ok: true, childId }
        } catch (error) {
          // Release drafts we created but never delivered.
          if (imageDraftIds.length > 0 && __svc.conversation) {
            try { for (const id of imageDraftIds) releaseDraftAttachment(__svc.conversation, id) } catch { /* noop */ }
          }
          throw error
        }
      } finally {
        __busy.delete(sessionId)
      }
    }

    /** Stage a composer restore for the just-opened branch (applied on mount). */
    function armPendingRestore(sessionId, text, imageDraftIds) {
      __pending = { sessionId, text, imageDraftIds }
      __diag.pendingApplied = 0
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          if (__pending && __pending.sessionId === sessionId) __pending = null
        }, PENDING_TTL_MS)
      }
    }

    function issueStop(sessionId, exchange) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (binding && binding.session && typeof binding.session.cancel === 'function') {
          binding.session.cancel().catch(() => { /* host already quiescent */ })
        }
      } catch { /* noop */ }
      if (exchange) __stopMarks.set(sessionId, exchange.seq)
    }

    // --- delete mode: settings read/write + host delete channel ----------------

    /**
     * Safely resolve the client remote.settings controller from any scope.
     * EVERY candidate gets its OWN try: a real guarded cordis context THROWS
     * on an uninjected bare property (`cannot get property "settings" without
     * inject`), so one shared try would abort after the first candidate and
     * never reach `ctx.remote.settings` — the exact bug this reader avoids.
     * Candidate order mirrors core's ui-settings usage (`ctx.remote.settings`)
     * and the sibling plugin's `get('remote.settings')` fallback.
     */
    function readRemoteSettings(scope) {
      if (!scope) return null
      // 1) sub.get('remote.settings') — an injected dotted name answers.
      try {
        if (typeof scope.get === 'function') {
          const viaGet = scope.get('remote.settings')
          if (viaGet) return viaGet
        }
      } catch { /* unmounted name: next candidate */ }
      // 2) literal dotted key — how a scope can mount an injected dotted name.
      try {
        const viaKey = scope['remote.settings']
        if (viaKey) return viaKey
      } catch { /* guarded */ }
      // 3) remote root, then its `settings` controller.
      let remote = null
      try {
        if (typeof scope.get === 'function') remote = scope.get('remote') || null
      } catch { /* not injected on this scope */ }
      if (!remote) {
        try { remote = scope.remote || null } catch { /* guarded */ }
      }
      if (remote) {
        try {
          const viaRemote = remote.settings || null
          if (viaRemote) return viaRemote
        } catch { /* guarded */ }
      }
      // 4) nested `scope.remote.settings` (same object, different mount).
      try {
        if (scope.remote && scope.remote.settings) return scope.remote.settings
      } catch { /* guarded */ }
      // 4b) short service name on scopes that mount the controller directly.
      try {
        if (typeof scope.get === 'function') {
          const shortGet = scope.get('settings')
          if (shortGet && typeof shortGet.describe === 'function') return shortGet
        }
      } catch { /* not injected here */ }
      // 5) bare `scope.settings` last: on a guarded ctx this is the candidate
      //    most likely to throw, and it must not short-circuit 1–4 above.
      try {
        const viaProp = scope.settings || null
        if (viaProp && typeof viaProp.describe === 'function') return viaProp
      } catch { /* guarded */ }
      return null
    }

    /** Unwrap a typert RemoteResult envelope ({ok,value}|{ok:false,error}). */
    function unwrapResult(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const err = response.error
          const msg = (err && (err.message || err.code)) || 'settings-request-failed'
          const failure = new Error(String(msg))
          failure.remoteError = err || null
          throw failure
        }
        return Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response
      }
      return response
    }

    /** Read the delete-mode switch from remote.settings (falls back to false). */
    async function loadDeleteMode() {
      __deleteMode = false
      try {
        const settings = __settings
        if (!settings || typeof settings.describe !== 'function') {
          __deleteModeLoaded = true
          return false
        }
        const view = unwrapResult(await settings.describe())
        const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : []
        const row = namespaces.find((entry) => entry && entry.ns === SETTINGS_NS)
        const value = row && row.value && typeof row.value === 'object' ? row.value[SETTINGS_FIELD] : undefined
        __deleteMode = value === true
        __deleteModeLoaded = true
        __diag.deleteMode = __deleteMode
        __diag.deleteModeLoaded = true
      } catch (error) {
        // Any failure lands on the safe side: archive, never delete.
        __deleteMode = false
        __deleteModeLoaded = true
        __diag.deleteMode = false
        __diag.deleteModeLoaded = true
        __diag.settingsReadFail = (error && error.message) ? error.message : String(error)
      }
      notifyDisposeListeners()
      return __deleteMode
    }

    /** Persist the switch through remote.settings (never deletes on failure). */
    async function setDeleteMode(next) {
      const previous = __deleteMode
      const want = next === true
      try {
        const settings = __settings
        if (!settings || typeof settings.update !== 'function') {
          throw new Error('settings-unavailable')
        }
        unwrapResult(await settings.update(SETTINGS_NS, { [SETTINGS_FIELD]: want }, undefined))
        __deleteMode = want
        __deleteModeLoaded = true
        __diag.deleteMode = __deleteMode
        __diag.disposeToggles += 1
        notifyDisposeListeners()
        publishToast(__t(want ? 'dispose.on' : 'dispose.off'))
        return { ok: true }
      } catch (error) {
        // The write failed (or was refused): restore the displayed mode.
        __deleteMode = previous
        __diag.deleteFail = (error && error.message) ? error.message : String(error)
        publishToast(__t('dispose.error', { msg: __diag.deleteFail }))
        notifyDisposeListeners()
        return { ok: false, code: __diag.deleteFail }
      }
    }

    /** Notify mounted header icons (and diagnostics) that the switch changed. */
    function notifyDisposeListeners() {
      for (const listener of [...__disposeListeners]) {
        try { listener() } catch { /* listener errors never break the switch */ }
      }
    }

    /**
     * Permanently delete one session through the host half. Called ONLY after
     * the new branch is open and usable (see doRewind); a failure degrades to
     * archiving the old session so nothing is ever lost to a failed delete.
     * Returns { deleted, archived } — archived=true means the fallback ran.
     */
    async function deleteOldSession(sessionId) {
      let deleted = false
      try {
        if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
        const response = await fetch(DELETE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok !== true) {
          throw new Error(body.error || ('delete-failed-' + response.status))
        }
        deleted = true
        __diag.lastDelete = { sessionId, ok: true }
      } catch (error) {
        __diag.deleteFail = (error && error.message) ? error.message : String(error)
        __diag.lastDelete = { sessionId, ok: false, error: __diag.deleteFail }
      }
      if (deleted) {
        publishToast(__t('rewind.deleted'))
        return { deleted: true, archived: false }
      }
      // Degrade: keep the old session recoverable instead of leaving a half state.
      let archived = false
      try {
        const workspaces = __svc.workspaces
        if (workspaces && typeof workspaces.archiveSession === 'function') {
          await workspaces.archiveSession(sessionId)
          archived = true
        }
      } catch (error) {
        __diag.archiveFail = (error && error.message) ? error.message : String(error)
      }
      publishToast(__t('rewind.delete.fail'))
      return { deleted: false, archived }
    }

    /** True when delete mode is armed (safe default: archive). */
    function deleteModeOn() {
      return __deleteMode === true
    }

    // --- 核心世代探测（命令描述契约） ----------------------------------------

    /**
     * 标记「核心 ≥ 0.1.5-rc.2 的命令契约（description 为函数）」。
     * - 参数类型：无（幂等；重复调用只覆盖同一个标志）
     * - 返回值：无
     */
    function markModernCore() {
      __commandDescShape = 'function'
      __diag.commandDescShape = 'function'
    }

    /**
     * 探测核心世代。**不读版本号**，只用 0.1.5-rc.2 起才存在的两个能力信号：
     * 1) 新增的 `main.conversation` 槽位注册成功；
     * 2) 槽位标准 props 里出现 `useResource` / `usePanelInfo`（由 EscBridge 上报）。
     * 任一成立即判定新契约。信号都缺席时保持旧契约（安全默认：旧核心把
     * description 当值渲染，函数会抛 "Functions are not valid as a React child"）。
     * - 参数类型：ctx -- 客户端 cordis 上下文
     * - 返回值：无
     */
    function probeCoreGeneration(ctx) {
      try {
        ctx.slots.inject('main.conversation', () => markModernCore())
      } catch { /* 旧核心没有这个槽位：保持旧契约 */ }
    }

    // --- /rewind contribution (ctx.commandUi popupSelect, full history) -------

    function registerRewindContribution(commandUi) {
      try {
        const disposer = commandUi.register({
          name: REWIND_COMMAND,
          // 契约双代兼容：旧核心读这个属性当字符串渲染，新核心读到的值必须是函数。
          // 用 getter 在「读取时」决定形态，所以探测晚于注册也没关系。
          get description() {
            if (__commandDescShape === 'function') return () => __t('rewind.cmd.desc')
            return __t('rewind.cmd.desc')
          },
          // Availability is decoupled from the loaded history window: a normal
          // (non-subagent, non-blank) session can always open /rewind, which
          // reads the whole history before showing the options.
          available: (session) => {
            try {
              if (!session || !session.sessionId) { __diag.rewindAvail = { reason: 'no-session' }; return false }
              if (isSubagentSession(session.sessionId)) { __diag.rewindAvail = { reason: 'subagent' }; return false }
              if (sessionFacts(session.sessionId).blank) { __diag.rewindAvail = { reason: 'blank' }; return false }
              __diag.rewindAvail = { reason: 'ok' }
              return true
            } catch (error) {
              __diag.rewindAvail = { reason: 'error', msg: (error && error.message) ? error.message : String(error) }
              return false
            }
          },
          ui: {
            kind: 'popupSelect',
            options: async (session, signal) => {
              const sessionId = session && session.sessionId
              if (!sessionId) return []
              // Load-once: only the first open (per page, or after the session
              // grew past a cached record) hits the host; repeats read the
              // live window / cache. The shell shows its native loading status
              // on that first call.
              const loaded = await refreshHistory(sessionId, signal)
              if (!loaded.ok) publishToast(__t('rewind.load.fail', { msg: loaded.code || 'unknown' }))
              const exchanges = (loaded.exchanges || [])
                .filter(qualifyExchange)
                .reverse()
              return exchanges.map((ex, index) => ({
                id: String(ex.seq) + ':' + index,
                value: String(ex.seq),
                label: snippet(ex.text, 72) || __t('rewind.image.only'),
                detail: [
                  __t('rewind.round', { n: String(index + 1) }),
                  timeLabel(ex.time),
                ].filter(Boolean).join(' · '),
              }))
            },
            onSelect: async (option, session) => {
              const sessionId = session && session.sessionId
              if (!sessionId || !option || option.value === undefined) return
              // Look the exchange up in the same record the options were built
              // from (covers exchanges the current chat window does not hold).
              const exchange = knownExchangesOf(sessionId)
                .filter(qualifyExchange)
                .find((ex) => String(ex.seq) === String(option.value))
              if (!exchange) return
              publishToast(__t('rewind.busy'))
              const result = await doRewind(sessionId, exchange)
              if (!result.ok) {
                publishToast(__t('rewind.error', { msg: result.code || 'unknown' }))
              }
            },
          },
        })
        __diag.services.commandUi = true
        return disposer
      } catch (error) {
        __diag.lastGate = 'contribution:' + ((error && error.message) ? error.message : String(error))
        return null
      }
    }

    // --- the bridge component -------------------------------------------------

    function EscBridge({ sessionId, useSession, useConversation, useInput, inputActions, t: seatT, usePanelInfo, useResource }) {
      const t = typeof seatT === 'function' ? seatT : __t
      // 世代探测的第二信号：0.1.5-rc.2 起槽位会额外下发这两个标准 props。
      if (typeof usePanelInfo === 'function' || typeof useResource === 'function') markModernCore()

      const session = useSession ? useSession((s) => s) : undefined
      const running = !!(session && session.running)
      const subagent = !!(session && session.subagent)
      const chat = useConversation
        ? useConversation((s) => (s && s.views && typeof s.views.get === 'function' ? s.views.get('chat') : undefined))
        : undefined
      const list = useMemo(() => chatNodeList(chat), [chat])
      const exchanges = useMemo(() => buildExchanges(list), [list])
      const target = exchanges.length ? exchanges[exchanges.length - 1] : null
      // 提示判据所需的两份「耐久证据」（都是原始值，便于放进 effect 依赖）：
      // 尾部 assistant 行的状态，以及最后一轮 turn/end 的终态。
      const tailState = tailStatus(list)
      const roundEnd = lastTurnEndEvidence(chat)
      const input = useInput ? useInput((s) => s) : undefined
      const draft = input && typeof input.draft === 'string' ? input.draft : ''

      __diag.mounted += 1
      __diag.services.sessions = !!__svc.sessions
      __diag.services.workspaces = !!__svc.workspaces
      __diag.services.conversation = !!__svc.conversation
      __diag.services.uiConversation = !!__svc.uiConversation

      // Refs the document listener reads (fresh on every render).
      const sessionRef = useRef(sessionId)
      sessionRef.current = sessionId
      const runningRef = useRef(running)
      runningRef.current = running
      const subagentRef = useRef(subagent)
      subagentRef.current = subagent
      const listRef = useRef(list)
      listRef.current = list
      const targetRef = useRef(target)
      targetRef.current = target
      const draftRef = useRef(draft)
      draftRef.current = draft
      const tRef = useRef(t)
      tRef.current = t
      const stopMarkRef = useRef(null)
      // One-hint-per-exchange guard (ESC stop and toolbar-Stop both arm; the
      // armed-tail effect must not re-toast what the ESC handler already did).
      const hintedRef = useRef(null)
      // 上一次 running→idle 下降沿记下的「候选回合」＝该回合首个 user 节点的 seq。
      // 下降沿只证明「本会话刚结束了一轮」，并不证明它是被停止的（自然结束同形），
      // 因此这里只记候选，等本轮定型（尾部出现 assistant 行 / turn/end 落定）后再结算。
      const stopCandidateRef = useRef(null)
      // Track the previous render's running flag so the post-stop hint can only
      // be considered after a running→idle falling edge in this session — never
      // when just switching into an already-unsettled session (running stays
      // false the whole time, so there is no edge).
      const prevRunningRef = useRef(null)
      // One-restore-per-branch guard for the staged composer restore.
      const pendingAppliedRef = useRef(false)

      const [toast, setToast] = useState(null)
      const toastSeq = useRef(0)
      const showToast = useCallback((text) => {
        if (!Toast) return
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])

      // Subscribe to cross-entry toast fan-out (keyboard + /rewind onSelect).
      useEffect(() => {
        __toastListeners.add(showToast)
        return () => { __toastListeners.delete(showToast) }
      }, [showToast])

      // Reset per-session state when the active session changes.
      useEffect(() => {
        stopMarkRef.current = null
        prevRunningRef.current = null
        stopCandidateRef.current = null
      }, [sessionId])

      // The single document capture listener for this session's lifetime.
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined
        }
        const onKey = (event) => {
          if (!event || event.key !== 'Escape') return
          if (event.isComposing === true || event.keyCode === 229) { __diag.lastGate = 'composing'; return }
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) { __diag.lastGate = 'modifier'; return }
          if (subagentRef.current) { __diag.lastGate = 'subagent'; return }

          // ESC layering: any open overlay/menu/dialog or a foreign text field
          // keeps this Escape for core (close the overlay), never hijacked.
          if (hasOpenOverlay(event)) { __diag.lastGate = 'overlay'; return }

          const stopIssued = stopMarkRef.current === (targetRef.current && targetRef.current.seq)
          // decideEsc 内部用 listRef 实时重算「尾部非 settled」，不再传渲染期快照
          // （旧代码传的 unsettled 参数在函数体内从未被读取，属死参数）。
          const decision = decideEsc({
            running: runningRef.current,
            draft: draftRef.current,
            list: listRef.current,
            stopIssued,
          })

          if (decision.action === 'none') { __diag.lastGate = 'idle-or-settled'; return }

          const consume = () => {
            try { event.preventDefault() } catch { /* synthetic */ }
            try { event.stopPropagation() } catch { /* synthetic */ }
          }

          if (decision.action === 'stop') {
            consume()
            __diag.escStops += 1
            __diag.lastAction = 'stop'
            __diag.lastGate = 'esc-stop'
            stopMarkRef.current = targetRef.current ? targetRef.current.seq : null
            if (targetRef.current && targetRef.current.seq !== null && targetRef.current.seq !== undefined) {
              hintedRef.current = targetRef.current.seq
            }
            issueStop(sessionRef.current, targetRef.current)
            // In delete mode the next ESC is terminal: the hint must say so.
            publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
            return
          }

          if (decision.action === 'arm') {
            // Non-running first ESC: only arm (remember this target so the next
            // ESC treats stopIssued=true and rewinds). No issueStop — nothing is
            // running. Mirrors the running-path hint so the user knows the next
            // ESC rewinds.
            consume()
            __diag.lastAction = 'arm'
            __diag.lastGate = 'esc-arm'
            stopMarkRef.current = targetRef.current ? targetRef.current.seq : null
            publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
            return
          }

          if (decision.action === 'rewind' && decision.exchange) {
            consume()
            __diag.lastAction = 'rewind'
            __diag.lastGate = 'esc-rewind'
            stopMarkRef.current = null
            publishToast(tRef.current('rewind.busy'))
            doRewind(sessionRef.current, decision.exchange).then((result) => {
              if (!result.ok) {
                publishToast(tRef.current('rewind.error', { msg: result.code || 'unknown' }))
              }
            })
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [])

      // 工具栏 Stop 也补「再按 Esc 回退」提示：下降沿只用来记候选，是否提示由
      // **宿主耐久停止证据**结算（尾部 assistant 带 interrupted，或该轮 turn/end
      // 为 aborted/user）。这样与「running 位 / 对话投影谁先到」无关：自然结束
      // （尾部 settled、或 turn/end 为 completed 等）会被静默丢弃，不再误弹。
      useEffect(() => {
        const wasRunning = prevRunningRef.current
        prevRunningRef.current = running
        // 下降沿：本会话刚结束了一轮（可能是主动停止，也可能是自然结束）。
        if (wasRunning === true && !running) {
          stopCandidateRef.current = target ? target.seq : null
        }
        const candidate = stopCandidateRef.current
        if (candidate === null || candidate === undefined) return
        if (running) return
        // 候选只对「当轮」有效：用户发了新消息（target.seq 变了）即作废。
        if (!target || target.seq !== candidate) {
          stopCandidateRef.current = null
          return
        }
        // 未定型：尾部还没有 assistant 行（如运行中的行在投影里不产出节点时，
        // 尾巴是刚发出的 user 提问），且该轮还没有 turn/end 终态 → 等下一帧。
        // 结算顺序（先确定的停止证据，后收尾终态）：
        //   1) 尾部带 interrupted —— 有内容被停，直接判定停止；
        //   2) 该轮 turn/end 为 aborted/user —— 无内容被停，或最后一步无内容、
        //      尾部停在上一步那条 settled 行上（settled 尾此时是**歧义**证据）；
        //   3) 其它 turn/end 终态（completed/error/max-tokens/blocked/非 user 的
        //      abort）—— 判定自然结束，静默丢弃候选；
        //   4) 该轮尚未收尾而尾部已是 settled —— 保持等待，等 turn/end 落定再判，
        //      避免把「后续步骤被停」误判成自然结束（宁晚勿错）。
        let evidence = null
        if (tailState === 'interrupted') evidence = 'tail-interrupted'
        else if (roundEnd === 'aborted:user') evidence = 'turn-aborted'
        else if (roundEnd !== null) evidence = 'settled'
        if (evidence === null) return
        stopCandidateRef.current = null
        if (evidence === 'settled') return
        if (draft !== '' || !qualifyExchange(target)) return
        if (hintedRef.current === target.seq) return
        hintedRef.current = target.seq
        __diag.hintToasts += 1
        __diag.lastHint = evidence
        publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
      }, [running, draft, target, tailState, roundEnd])

      // Apply the staged composer restore once the rewound branch mounts.
      useEffect(() => {
        if (pendingAppliedRef.current) return
        if (!inputActions) return
        const pending = __pending
        if (!pending || pending.sessionId !== sessionId) return
        if (draft !== '') {
          // The user already started typing in the new branch: never clobber.
          if (__pending && __pending.sessionId === sessionId) __pending = null
          return
        }
        // Give the branch's input store a beat to hydrate, then apply once.
        const timer = setTimeout(() => {
          const still = __pending
          if (!still || still.sessionId !== sessionId || pendingAppliedRef.current) return
          pendingAppliedRef.current = true
          try {
            if (still.text) inputActions.setDraft(still.text)
          } catch { /* input not ready yet; drop rather than loop */ }
          try {
            if (still.imageDraftIds && still.imageDraftIds.length) restoreDraftAttachments(inputActions, still.imageDraftIds)
          } catch { /* images are best-effort */ }
          __pending = null
          __diag.pendingApplied += 1
          publishToast(tRef.current('rewind.done'))
        }, 80)
        return () => clearTimeout(timer)
      }, [sessionId, draft, inputActions])

      if (!toast) return null
      return React.createElement(Toast, {
        key: toast.seq,
        text: toast.text,
        onDone: () => setToast(null),
      })
    }

    /** True when the focused composer has an active '/' or '@' trigger token at the caret. */
    function composerTriggerTokenOpen() {
      if (typeof document === 'undefined') return false
      try {
        const ae = document.activeElement
        if (!ae || typeof ae.closest !== 'function') return false
        const root = ae.closest('[' + COMPOSER_ATTR + ']')
        if (!root) return false
        const sel = (typeof window !== 'undefined' && typeof window.getSelection === 'function')
          ? window.getSelection()
          : null
        if (!sel || !sel.rangeCount || sel.isCollapsed !== true) return false
        const node = sel.anchorNode
        if (!node) return false
        const beforeCaret = node.nodeType === 3 && typeof node.textContent === 'string'
          ? node.textContent.slice(0, sel.anchorOffset || 0)
          : ''
        return /(?:^|\s)[/@]\S*$/.test(beforeCaret || '')
      } catch {
        return false
      }
    }

    /** True when an open overlay/menu/dialog, a trigger token, or a non-composer
     *  text field owns Escape (we must yield so core closes it first). */
    function hasOpenOverlay(event) {
      if (typeof document === 'undefined') return false
      try {
        const path = event && typeof event.composedPath === 'function' ? event.composedPath() : null
        const ancestors = path && path.length ? path : []
        if (typeof event !== 'undefined' && event.target) ancestors.push(event.target)
        for (const el of ancestors) {
          if (!el || typeof el !== 'object' || typeof el.closest !== 'function') continue
          if (el.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [data-dsh-overlay]')) {
            return true
          }
          const editable = el.closest('input, textarea, [contenteditable="true"]')
          if (editable && !editable.closest('[' + COMPOSER_ATTR + ']')) return true
        }
      } catch { /* tolerant */ }
      if (composerTriggerTokenOpen()) return true
      return false
    }

    // --- session-header dispose-mode toggle (archive ⇄ delete) ----------------

    /** 28x28 icon button matching the header actions row (sibling plugins). */
    const disposeBtnStyle = {
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

    /** Archive cabinet glyph (default state: old session is archived). */
    const ARCHIVE_PATH = 'M3.5 2.5h9v11h-9zM1.75 4.75h1.75v-1.5h9v1.5h1.75v-1.5a1.5 1.5 0 0 0-1.5-1.5h-10a1.5 1.5 0 0 0-1.5 1.5zM8 8h1.5v2.5H8z'

    /** Trash-with-X glyph (delete mode: old session is permanently removed). */
    const DELETE_PATH = 'M6.2 4.9l1.8 1.8 1.8-1.8 1.3 1.3-1.8 1.8 1.8 1.8-1.3 1.3-1.8-1.8-1.8 1.8-1.3-1.3 1.8-1.8-1.8-1.8zM4 2.5l-1.5 12h11l-1.5-12zM5.2 4h5.6l1 10H4.2z'

    /** True when the session should show the dispose toggle (normal only). */
    function disposeVisible({ sessionId, summary }) {
      if (!sessionId) return false
      if (summary) {
        if (summary.origin === 'subagent') return false
        if (summary.blank === true) return false
      }
      return true
    }

    /**
     * Header icon button: archive ⇄ delete (global preference). Renders for
     * normal (non-subagent, non-blank) sessions only; clicking flips the switch
     * through remote.settings and toasts the outcome.
     */
    function DisposeToggle(props) {
      const t = (props && props.t) || __t
      const sessionId = props && props.sessionId
      // useSessions gives the session list snapshot (sibling plugins' header
      // buttons read running/blank/origin from it). Tolerate absence.
      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const [, force] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const toastSeq = React.useRef(0)
      const showToast = React.useCallback((text) => {
        if (!Toast) return
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])
      React.useEffect(() => {
        __toastListeners.add(showToast)
        return () => { __toastListeners.delete(showToast) }
      }, [showToast])
      React.useEffect(() => {
        const listener = () => force((v) => v + 1)
        __disposeListeners.add(listener)
        return () => { __disposeListeners.delete(listener) }
      }, [])
      if (!disposeVisible({ sessionId, summary })) return null
      const on = deleteModeOn()
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          title: t(on ? 'dispose.title.delete' : 'dispose.title.archive'),
          'aria-label': t(on ? 'dispose.title.delete' : 'dispose.title.archive'),
          style: on
            ? { ...disposeBtnStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
            : disposeBtnStyle,
          onClick: () => { setDeleteMode(!on) },
        }, React.createElement('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          'aria-hidden': true,
          style: { flex: 'none' },
        }, React.createElement('path', { d: on ? DELETE_PATH : ARCHIVE_PATH }))),
        toast
          ? React.createElement(Toast, { key: toast.seq, text: toast.text, onDone: () => setToast(null) })
          : null,
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

    /** Lazily bind one client service into __svc without blocking apply. */
    function bindService(ctx, name) {
      try {
        const disposer = ctx.inject([name], (sub) => {
          try { __svc[name] = sub[name] || null } catch { __svc[name] = null }
        })
        if (typeof disposer === 'function') return disposer
      } catch { /* service may be absent on older hosts */ }
      return null
    }

    function apply(ctx) {
      __diag.applied = true
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        try {
          ctx.inject(['locale'], (sub) => { adoptLocale(sub.locale, ctx) })
        } catch { /* no locale service */ }
      }

      const disposers = []
      const names = ['sessions', 'workspaces', 'conversation', 'uiConversation', 'commandUi']
      for (const name of names) {
        try {
          const disposer = bindService(ctx, name)
          if (disposer) disposers.push(disposer)
        } catch { /* keep going */ }
      }
      try {
        ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* noop */ } } })
      } catch { /* effect may be absent in the harness */ }

      // 命令描述契约的世代探测（不读版本号，见 probeCoreGeneration）。
      probeCoreGeneration(ctx)

      // Register the conversation overlay bridge once the slot exists.
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, EscBridge))

      // Register the session-header dispose toggle (archive ⇄ delete).
      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: HEADER_ROW_ID,
        order: HEADER_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, DisposeToggle))

      // Delete-mode switch: resolve the client remote.settings controller
      // through the SAFE reader (each candidate guarded on its own, because a
      // bare property read throws on a real guarded ctx), bind it once, load
      // the value, and re-read when our namespace changes. All optional —
      // absent settings simply means archive mode.
      const bindSettings = (scope) => {
        if (!__settings) {
          const settings = readRemoteSettings(scope)
          if (settings) {
            __settings = settings
            __diag.services.settings = true
            loadDeleteMode()
          }
        }
        // Event subscription needs the remote root; own try, never blocks the
        // settings binding above.
        if (!__settingsEventsBound) {
          let remote = null
          try {
            if (scope && typeof scope.get === 'function') remote = scope.get('remote') || null
          } catch { /* not injected on this scope */ }
          if (!remote) {
            try { remote = scope && scope.remote ? scope.remote : null } catch { /* guarded */ }
          }
          if (remote && typeof remote.$on === 'function') {
            __settingsEventsBound = true
            __diag.settingsEventsBound = true
            try {
              const disposer = remote.$on('settings/document-updated', (ns) => {
                if (!ns || ns === SETTINGS_NS) {
                  if (!__settings) {
                    const found = readRemoteSettings(scope)
                    if (found) { __settings = found; __diag.services.settings = true }
                  }
                  loadDeleteMode()
                }
              })
              if (typeof disposer === 'function') disposers.push(disposer)
            } catch { /* event subscription optional */ }
          }
        }
      }
      try { bindSettings(ctx) } catch { /* the injects below still get a shot */ }
      // Inject the dotted service name, and the bare remote root as a second
      // chance: either scope can answer `remote.settings`.
      const injectSettings = (names) => {
        try {
          const disposer = ctx.inject(names, (sub) => bindSettings(sub))
          if (typeof disposer === 'function') disposers.push(disposer)
        } catch { /* absent: stays archive mode */ }
      }
      if (!__settings || !__settingsEventsBound) injectSettings(['remote.settings'])
      if (!__settings || !__settingsEventsBound) injectSettings(['remote'])

      // Register the /rewind contribution once commandUi is bound. The
      // contribution re-checks availability per candidate pass, so registering
      // before a session exists is harmless.
      try {
        const commandDisposer = ctx.inject(['commandUi'], (sub) => {
          if (sub && sub.commandUi) {
            const disposer = registerRewindContribution(sub.commandUi)
            if (disposer) disposers.push(disposer)
          }
        })
        if (typeof commandDisposer === 'function') disposers.push(commandDisposer)
      } catch { /* commandUi absent: /rewind just won't exist */ }
    }

    // Expose internals for the logic harness + diagnostics.
    function exposeInternals() {
      if (typeof window === 'undefined') return
      try {
        window.__dsewInternals = {
          nodeKind, nodeSeq, nodeTime, nodeText, nodeImageRefs, assistantStatusOf,
          chatNodeList, buildExchanges, qualifyExchange, lastExchange, tailInterrupted,
          tailStatus, lastTurnEndEvidence,
          tailUnsettled, decideEsc, snippet, timeLabel,
          _module: {
            publishToast, doRewind, issueStop, ensureIdle, clearQueue,
            settlePendingInputs, probeCoreGeneration, markModernCore, sessionSnapshotOf,
            createDraftAttachments, releaseDraftAttachment, restoreDraftAttachments,
            exchangesOfSession, isSubagentSession, sessionFacts,
            refreshHistory, knownExchangesOf, resetHistoryCache,
            loadDeleteMode, setDeleteMode, deleteOldSession, deleteModeOn,
            disposeVisible, notifyDisposeListeners, readRemoteSettings, unwrapResult,
            getSettings: () => __settings,
          },
        }
      } catch { /* no window */ }
    }
    exposeInternals()

    return { apply, inject: ['slots'] }
  },
})
