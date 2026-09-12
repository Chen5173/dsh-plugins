// Behavioural harness for dsh-esc-rewind/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally. This harness materializes the bundle the way
// @deepseek-ai/dsh-client-modules does — window.__ModuleLoader__.load({id,
// factory}) then factory(require) — with a minimal deps-aware React shim and
// fake client services (sessions/workspaces/conversation/uiConversation/
// commandUi), then drives the pure decision helpers, the ESC capture listener,
// the doRewind engine and the /rewind contribution so the logic is executed
// and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: real Lexical/React rendering,
// DOM overlay detection and host round-trips are approximated. The parts that
// need a real browser are listed in ACCEPTANCE.md.
//
// Run: node dsh-esc-rewind/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-esc-rewind'
const NS = 'esc-rewind'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

// Minimal localStorage so the persisted /rewind history cache is exercised.
const lsStore = new Map()
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)) },
  removeItem: (k) => { lsStore.delete(k) },
}

let keydownHandler = null
let keydownCapture = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  addEventListener: (type, fn, capture) => {
    if (type === 'keydown') { keydownHandler = fn; keydownCapture = capture === true }
  },
  removeEventListener: (type) => { if (type === 'keydown') keydownHandler = null },
}

const factories = new Map()
globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }

// --- deps-aware React shim ---------------------------------------------------

function sameDeps(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function makeReact() {
  let slots = []
  let index = 0
  let dirty = false
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true, type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        const v = typeof next === 'function' ? next(slot.value) : next
        if (v !== slot.value) { slot.value = v; dirty = true }
      }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useEffect(effect, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { init: false, deps: undefined, cleanup: undefined }
      const slot = slots[i]
      if (!slot.init || !sameDeps(slot.deps, deps)) {
        if (typeof slot.cleanup === 'function') { try { slot.cleanup() } catch { /* noop */ } }
        slot.cleanup = effect()
        slot.deps = deps
        slot.init = true
      }
    },
    useCallback(fn, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { fn, deps }
      const slot = slots[i]
      if (!sameDeps(slot.deps, deps)) { slot.fn = fn; slot.deps = deps }
      return slot.fn
    },
    useMemo(fn, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { init: false, deps: undefined, value: undefined }
      const slot = slots[i]
      if (!slot.init || !sameDeps(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; slot.init = true }
      return slot.value
    },
  }
  return {
    React,
    beginRender() { index = 0; dirty = false },
    freshInstance() { slots = []; index = 0; dirty = false },
    isDirty: () => dirty,
  }
}

const { React, beginRender, freshInstance, isDirty } = makeReact()

const toasts = []
const primitives = {
  Toast: ({ text }) => { toasts.push(text); return { __toast: text } },
  // Headless modal stub: the harness never materializes its subtree.
  Modal: ({ children, ...rest }) => ({ __modal: true, rest, children }),
}

function requireStub(specifier) {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', source)(globalThis.window, globalThis.navigator, globalThis.document)

const tests = []
const test = (name, fn) => tests.push([name, fn])

function freshApply() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  return factory(requireStub)
}

// --- fake services -----------------------------------------------------------

function makeChatNode({ kind, seq, time = 0, text = '', images = [], extra = {} }) {
  if (kind === 'assistant') {
    return { kind, anchorSeq: seq, data: { status: extra.status || 'settled', blocks: text ? [{ kind: 'text', text }] : [], time } }
  }
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const image of images) content.push({ type: 'image', attachment: { attachmentId: image } })
  return { kind, anchorSeq: seq, data: { kind, seq, time, content, source: {} } }
}

function makeServices(overrides = {}) {
  const calls = {
    cancels: [],
    forks: [],
    creates: [],
    opens: [],
    archived: [],
    queueRemoves: [],
    renames: [],
    readAttachments: [],
    loadThrough: [],
    loadOlder: [],
  }
  const bindings = {}
  const summaries = {}
  let nextId = 1

  const makeBinding = (id, runningNow) => {
    const live = { running: runningNow === true, queue: [], hasMore: false }
    const face = {
      sessionId: id,
      live,
      getSnapshot: () => live,
      cancel: async () => { calls.cancels.push(id); live.running = false; return { ok: true } },
      updateQueue: async (itemId, action) => {
        calls.queueRemoves.push([itemId, action])
        if (action && action.kind === 'remove') {
          live.queue = live.queue.filter((item) => item.id !== itemId)
        }
        return { ok: true }
      },
      rename: async (title) => { calls.renames.push([id, title]); summaries[id].title = title; return { ok: true, value: { title, seq: 0 } } },
      readAttachment: async (attachmentId) => { calls.readAttachments.push(attachmentId); return { ok: false } },
      loadThrough: async (seq) => {
        calls.loadThrough.push([id, seq])
        if (typeof overrides.onLoadThrough === 'function') await overrides.onLoadThrough(face, seq)
        live.hasMore = false
      },
      loadOlder: async () => {
        calls.loadOlder.push(id)
        if (typeof overrides.onLoadOlder === 'function') await overrides.onLoadOlder(face)
        live.hasMore = false
      },
    }
    bindings[id] = { sessionId: id, session: face }
    return face
  }

  const sessions = {
    list: { getSnapshot: () => ({ ids: Object.keys(summaries), byId: { ...summaries } }) },
    binding: (id) => bindings[id] || undefined,
    fork: async (opts) => {
      calls.forks.push(opts)
      const childId = 'child-' + (nextId++)
      summaries[childId] = { id: childId, title: 'Fork Title', displayTitle: 'Fork Title' }
      makeBinding(childId, false)
      return childId
    },
    create: async (opts) => {
      calls.creates.push(opts || {})
      const childId = 'blank-' + (nextId++)
      summaries[childId] = { id: childId, blank: true, displayTitle: childId }
      makeBinding(childId, false)
      return childId
    },
    open: (id) => { calls.opens.push(id) },
  }
  const workspaces = {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: Object.keys(summaries) }] }) },
    archiveSession: async (id) => { calls.archived.push(id) },
  }
  const conversation = {
    createDraftImages: (files) => files.map((file, i) => ({ id: 'img-' + (nextId++) + '-' + i, file })),
    releaseDraftImage: () => {},
  }
  const contributions = []
  const uiConversation = {
    binding: (id) => {
      const chat = overrides.chatOf ? overrides.chatOf(id) : null
      // Real core: SnapshotStore/ObservableSnapshot expose getSnapshot().
      return { snapshot: { getSnapshot: () => ({ views: { get: (key) => (key === 'chat' ? chat : undefined) } }) } }
    },
  }
  const commandUi = {
    register: (contribution) => { contributions.push(contribution); return () => {} },
  }

  // Fake client remote.settings controller (delete-mode switch persistence).
  const settingsCalls = { describes: 0, updates: [] }
  let settingsValue = { deleteOldOnRewind: false }
  let settingsDescribeError = null
  let settingsUpdateError = null
  const settings = {
    describe: async () => {
      settingsCalls.describes += 1
      if (settingsDescribeError) throw settingsDescribeError
      return {
        namespaces: [
          { ns: 'esc-rewind', value: { ...settingsValue }, revision: 1 },
        ],
      }
    },
    update: async (ns, patch, rev) => {
      settingsCalls.updates.push([ns, patch, rev])
      if (settingsUpdateError) throw settingsUpdateError
      if (ns === 'esc-rewind') settingsValue = { ...settingsValue, ...patch }
      return { ns, value: { ...settingsValue }, revision: (rev || 0) + 1 }
    },
  }
  const setSettingsValue = (v) => { settingsValue = { deleteOldOnRewind: v === true } }
  const setSettingsDescribeError = (e) => { settingsDescribeError = e || null }
  const setSettingsUpdateError = (e) => { settingsUpdateError = e || null }

  const state = { bindings, summaries, sessions, workspaces, conversation, uiConversation, commandUi, contributions, calls,
    settings, settingsCalls, setSettingsValue, setSettingsDescribeError, setSettingsUpdateError }
  state.seed = (id, { running = false, title = 'Title', queue = [] } = {}) => {
    summaries[id] = { id, title, displayTitle: title }
    const face = makeBinding(id, running)
    face.live.queue = queue
    bindings[id] = { sessionId: id, session: face }
  }
  state.setRunning = (id, running) => {
    const binding = bindings[id]
    if (binding && binding.session && binding.session.live) {
      binding.session.live.running = running
    }
  }
  state.setHasMore = (id, hasMore) => {
    const binding = bindings[id]
    if (binding && binding.session && binding.session.live) {
      binding.session.live.hasMore = hasMore
    }
  }
  return state
}

function makeCtx(services) {
  const registered = []
  if (services && typeof services === 'object') services.registered = registered
  const ctx = {
    registered,
    get: (name) => (services[name] !== undefined ? services[name] : undefined),
    effect: () => () => {},
    on: () => () => {},
    inject: (names, cb) => {
      const sub = {}
      let complete = true
      for (const name of names) {
        if (services[name] !== undefined) sub[name] = services[name]
        else complete = false
      }
      if (complete) cb(sub)
      return () => {}
    },
    slots: {
      inject: (slotName, build) => { build() },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
  return ctx
}

function applyWith(services) {
  freshApply().apply(makeCtx(services))
  return services
}

// --- internals ---------------------------------------------------------------

function internals() {
  return globalThis.window.__dsewInternals
}

function moduleState() {
  // Reads current internal module state through the exported probe.
  return globalThis.window.__dsewProbe ? globalThis.window.__dsewProbe() : null
}

// --- node-list scenario helpers ----------------------------------------------

const settled = (seq, text) => makeChatNode({ kind: 'assistant', seq, text, extra: { status: 'settled' } })
const interrupted = (seq, text) => makeChatNode({ kind: 'assistant', seq, text, extra: { status: 'interrupted' } })
const runningAssistant = (seq) => makeChatNode({ kind: 'assistant', seq, text: '', extra: { status: 'running' } })
const user = (seq, text, images) => makeChatNode({ kind: 'user', seq, text, images })

function chatOf(nodes) {
  const order = []
  const map = new Map()
  nodes.forEach((node, i) => {
    const key = String(i)
    order.push(key)
    map.set(key, node)
  })
  return { order, nodes: { get: (k) => map.get(k) }, legacy: null }
}

// --- component mounting ------------------------------------------------------

function mount({ services, sessionId, chat, running = false, draft = '', interruptedTail = false }) {
  const component = services.registered[0].component
  const env = {
    sessionId,
    chat,
    running,
    draft,
    inputs: [],
  }
  env.inputActions = {
    setDraft: (text) => { env.inputs.push(['setDraft', text]); env.draft = text },
    addImages: (ids) => { env.inputs.push(['addImages', ids]); return true },
  }
  env.state = { running, subagent: null, queue: [] }
  const props = () => ({
    sessionId: env.sessionId,
    useSession: (sel) => sel(env.state),
    useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? env.chat : undefined) } }),
    useInput: (sel) => sel({ draft: env.draft }),
    inputActions: env.inputActions,
    t: (k, vars) => k,
  })
  const render = (first) => { if (first) freshInstance(); else beginRender(); return component(props()) }
  const materialize = (tree) => {
    if (tree && tree.__element && typeof tree.type === 'function') { try { tree.type(tree.props) } catch { /* noop */ } }
    if (tree && tree.props && tree.props.children) {
      const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
      for (const kid of kids) materialize(kid)
    }
    return tree
  }
  env.render = () => { let tree = render(true); if (isDirty()) tree = render(false); return materialize(tree) }
  env.rerender = () => { let tree = render(false); if (isDirty()) tree = render(false); return materialize(tree) }
  env.press = (key, extra = {}) => {
    let prevented = false
    const event = { key, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      preventDefault() { prevented = true }, stopPropagation() {}, ...extra }
    keydownHandler(event)
    env.rerender()
    return prevented
  }
  env.render()
  return env
}

// --- tests -------------------------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  assert.ok(factories.has(PKG_ID), 'no __ModuleLoader__.load for the package id')
  const exports = freshApply()
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers one overlay entry and the /rewind contribution', () => {
  const services = makeServices()
  applyWith(services)
  assert.equal(services.registered.length, 2, 'overlay bridge + header dispose toggle')
  const overlay = services.registered.find((r) => r.options.name === 'conversation.input.overlay')
  assert.ok(overlay, 'overlay bridge registered')
  assert.equal(overlay.options.id, 'esc-rewind')
  assert.equal(overlay.options.order, 60)
  const header = services.registered.find((r) => r.options.name === 'conversation.session.header.actions')
  assert.ok(header, 'header dispose toggle registered')
  assert.equal(header.options.id, 'esc-rewind-dispose')
  assert.equal(header.options.order, 28)
  assert.equal(services.contributions.length, 1)
  assert.equal(services.contributions[0].name, 'rewind')
  assert.equal(services.contributions[0].ui.kind, 'popupSelect')
})

test('pure decisions: first ESC stops a running turn', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'stop')
})

test('pure decisions: ESC again while running (stop issued) rewinds', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: true })
  assert.equal(d.action, 'rewind')
  assert.equal(d.exchange.seq, 3)
})

test('pure decisions: armed interrupted tail arms on first ESC, rewinds on second', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 3)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 3)
})

test('pure decisions: natural completion never rewinds', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), settled(4, 'full answer')]
  const d = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'none')
})

test('pure decisions: an unsettled user-tail question arms first, rewinds second', () => {
  // Tail is a just-sent user question with no assistant reply yet — not settled,
  // so an empty-draft ESC is allowed to rewind (tailUnsettled), but only on the
  // second ESC. Rewind target is that last (unanswered) question itself.
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), user(4, 'q3 waiting')]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 4)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 4)
})

test('pure decisions: an unrecognised-status assistant tail arms first, rewinds second', () => {
  const unknown = makeChatNode({ kind: 'assistant', seq: 4, text: 'x', extra: { status: 'unknown' } })
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), unknown]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 3)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 3)
})

test('pure decisions: an edited draft disarms the armed state', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]
  const d = internals().decideEsc({ running: false, draft: 'typing a new prompt', list, stopIssued: false })
  assert.equal(d.action, 'none')
})

test('pure decisions: a running first exchange can still stop', () => {
  const list = [user(1, 'only question'), runningAssistant(2)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'stop')
})

test('pure decisions: images and text both survive exchange derivation', () => {
  const list = [user(1, 'with image', ['att-1'])]
  const exs = internals().buildExchanges(list)
  assert.equal(exs.length, 1)
  assert.equal(exs[0].text, 'with image')
  assert.deepEqual(exs[0].imageRefs.map((r) => r.attachmentId), ['att-1'])
  assert.equal(exs[0].isFirst, true)
})

test('exchanges anchor on the previous settled assistant only', () => {
  // interrupted + settled variants: anchor must be the settled one
  const list = [user(1, 'q0'), interrupted(2, 'aborted'), user(3, 'q1'), settled(4, 'ok'), user(5, 'q2')]
  const exs = internals().buildExchanges(list)
  assert.equal(exs[0].anchorSeq, null) // nothing settled before q0
  assert.equal(exs[0].isFirst, true)
  assert.equal(exs[1].anchorSeq, null) // only an interrupted assistant before q1 -> no clean boundary
  assert.equal(exs[1].isFirst, false)
  assert.equal(exs[2].anchorSeq, 4)    // settled assistant before q2
  assert.equal(internals().qualifyExchange(exs[0]), true)  // first exchange: allowed (fresh session)
  assert.equal(internals().qualifyExchange(exs[1]), false) // no boundary -> not offered
  assert.equal(internals().qualifyExchange(exs[2]), true)
})

test('ESC stop integration: first ESC cancels the running turn and hints', async () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  const prevented = env.press('Escape')
  assert.equal(prevented, true, 'ESC must be consumed on stop')
  assert.deepEqual(services.calls.cancels, ['s1'])
  assert.ok(toasts.length > 0, 'stop hint toast expected')
})

test('post-stop hint: switching INTO an already-unsettled session does NOT hint', () => {
  // e.g. a 429-failed turn where the tail is unsettled but NEVER went running→idle
  // in this session: the user just opened the session, so running stays false the
  // whole time. No falling edge → no tooltip. (prevRunning is null on mount.)
  const env = mount({
    services: applyWith(makeServices()),
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]),
    running: false,
  })
  env.render()
  toasts.length = 0
  env.rerender()
  assert.ok(toasts.length === 0, 'must not hint when merely switching into an unsettled session')
})

test('post-stop hint: toolbar-Stop (running→idle falling edge) does hint once', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  env.render()
  // Simulate the host settling after the toolbar Stop: running true→false with an
  // unsettled (interrupted) tail.
  services.setRunning('s1', false)
  env.state.running = false
  env.chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')])
  toasts.length = 0
  env.rerender()
  assert.ok(toasts.length > 0, 'post-stop hint appears after a real running→idle stop')
})

test('ESC twice rewinds: fork at the previous settled boundary, archive, open, stage restore', async () => {
  const services = makeServices()
  services.seed('s1', { running: true, title: 'Original Title' })
  applyWith(services)
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  env.press('Escape') // stop (cancels)
  assert.equal(services.calls.cancels.length, 1)
  // model the host settling: now interrupted tail, not running
  services.setRunning('s1', false)
  env.chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')])
  env.running = false
  env.rerender()
  toasts.length = 0
  // second ESC while still "running" (before settle) is the double-tap case:
  services.setRunning('s1', true)
  env.running = true
  env.rerender()
  env.press('Escape') // rewind
  // ensureIdle cancels again then settles
  services.setRunning('s1', false)
  await new Promise((r) => setTimeout(r, 30)) // let the async rewind finish
  assert.equal(services.calls.forks.length, 1)
  assert.equal(services.calls.forks[0].sessionId, 's1')
  assert.equal(services.calls.forks[0].atSeq, 2, 'anchor = previous settled assistant')
  assert.equal(services.calls.forks[0].increaseTitle, false)
  assert.ok(services.calls.archived.includes('s1'), 'original session archived')
  assert.equal(services.calls.opens[0], services.calls.forks[0] && services.calls.opens[0], 'child opened')
  const childId = services.calls.opens[0]
  assert.ok(childId, 'a child session was opened')
})

test('/rewind reads the whole history up front and lists every exchange newest first', async () => {
  // The loaded window starts with only the recent tail (2 exchanges); the full
  // history has 4 exchanges and only appears after the picker's loadThrough.
  const fullChat = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), runningAssistant(8),
  ])
  const tailChat = chatOf([user(5, 'recent question'), settled(6, 'recent reply'), user(7, 'newest question'), runningAssistant(8)])
  const model = { full: false }
  const services = makeServices({
    chatOf: () => (model.full ? fullChat : tailChat),
    // Simulate the host delivering every older page once loadThrough lands.
    onLoadThrough: () => { model.full = true },
  })
  services.seed('s1', { title: 'T' })
  services.setHasMore('s1', true)
  applyWith(services)
  const contribution = services.contributions[0]
  assert.equal(contribution.available({ sessionId: 's1' }), true, 'normal session always offers /rewind')
  const options = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  // With no older history loaded the loader runs loadThrough(0) to page it in.
  assert.deepEqual(services.calls.loadThrough, [['s1', 0]], 'loadThrough(0) pages the entire history')
  assert.equal(options.length, 4, 'every exchange across the whole history is offered')
  assert.equal(options[0].value, '7', 'newest first')
  assert.equal(options[1].value, '5')
  assert.equal(options[2].value, '3')
  assert.equal(options[3].value, '1', 'the very first exchange is reachable even though it was never rendered')

  // Second open in the same page: the live window is already fully loaded, so
  // NO further host call happens — this is the load-once guarantee.
  const optionsAgain = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  assert.equal(services.calls.loadThrough.length, 1, 'second open does not re-load the history')
  assert.equal(optionsAgain.length, 4, 'same full list served from the loaded window')
})

test('cached record serves after a reload; new messages trigger one merge reload', async () => {
  const tailChat = chatOf([user(5, 'recent question'), settled(6, 'recent reply'), user(7, 'newest question'), runningAssistant(8)])
  const fullChat = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), runningAssistant(8),
  ])
  const fullChatPlusNew = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), settled(8, 'newest reply'), user(9, 'brand new question'), runningAssistant(10),
  ])
  const model = { chat: tailChat, fullTarget: fullChat }
  const services = makeServices({
    chatOf: () => model.chat,
    // loadThrough delivers the whole log (up to the current tail) into the
    // window, like the host does.
    onLoadThrough: () => { model.chat = model.fullTarget },
  })
  services.seed('cache-s1', { title: 'T' })
  services.setHasMore('cache-s1', true)
  applyWith(services)
  const contribution = services.contributions[0]

  // First open: full load once, persisted to localStorage.
  const first = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(first.length, 4)
  assert.equal(services.calls.loadThrough.length, 1)

  // Simulate a page reload: page-local state is gone, localStorage record lives.
  internals()._module.resetHistoryCache()
  model.chat = tailChat
  services.setHasMore('cache-s1', true)

  // Second open with NO new content: served from the cached record, no host call.
  const afterReload = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(afterReload.length, 4, 'full list restored from the cached record')
  assert.equal(services.calls.loadThrough.length, 1, 'no host call when the record is still fresh')

  // Now the session grew (one new exchange): the cache watermark is older than
  // the newest live exchange → one merge reload fetches the new content too.
  model.fullTarget = fullChatPlusNew
  model.chat = fullChatPlusNew
  services.setHasMore('cache-s1', true)
  const afterGrowth = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(services.calls.loadThrough.length, 2, 'one reload happens when the session grew')
  assert.equal(afterGrowth.length, 5, 'merged list includes the newest exchange')
  assert.equal(afterGrowth[0].value, '9', 'brand-new exchange is at the top, not lost to the cache')
})

test('/rewind availability: subagent and blank sessions are excluded', () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  services.summaries.s1.origin = 'subagent'
  services.seed('s2', { title: 'T2' })
  services.summaries.s2.blank = true
  services.seed('s3', { title: 'T3' })
  applyWith(services)
  const contribution = services.contributions[0]
  assert.equal(contribution.available({ sessionId: 's1' }), false, 'subagent transcript: no rewind')
  assert.equal(contribution.available({ sessionId: 's2' }), false, 'blank session: no rewind')
  assert.equal(contribution.available({ sessionId: 's3' }), true)
})

test('/rewind option rows carry text, image fallback, round and time', async () => {
  const fullChat = chatOf([user(1, '', ['att-1']), settled(2, 'a1'), user(3, 'plain question'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => fullChat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const contribution = services.contributions[0]
  const options = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  assert.equal(options.length, 2)
  assert.equal(options[0].value, '3', 'newest first')
  assert.equal(options[1].value, '1')
  assert.match(options[1].label, /图片消息/, 'image-only exchange gets a text placeholder')
  assert.match(options[0].detail, /第 1 轮/, 'round number shown')
})

test('/rewind engine: first exchange degrades to a fresh same-workspace session', async () => {
  const chat = chatOf([user(1, 'only question'), runningAssistant(2)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const first = internals()._module.exchangesOfSession('s1').find((ex) => ex.isFirst === true)
  assert.ok(first, 'first exchange present')
  const result = await internals()._module.doRewind('s1', first)
  assert.equal(result.ok, true)
  assert.equal(services.calls.forks.length, 0, 'no fork for a first exchange')
  assert.equal(services.calls.creates.length, 1)
  assert.equal(services.calls.creates[0].workspaceId, 'w1')
  assert.ok(services.calls.archived.includes('s1'))
})

test('pending restore applies the prompt on the branch mount', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const chat = chatOf([user(1, 'please rewrite'), settled(2, 'old reply'), user(3, 'rewind me'), runningAssistant(4)])
  const env = mount({ services, sessionId: 's1', chat, running: true })
  toasts.length = 0
  env.press('Escape') // stop
  services.setRunning('s1', true)
  env.rerender()
  env.press('Escape') // rewind (double-tap path)
  services.setRunning('s1', false)
  await new Promise((r) => setTimeout(r, 30))
  // Now the child mounts: simulate the branch bridge with an empty draft.
  const childId = services.calls.opens[0]
  assert.ok(childId)
  const childEnv = mount({ services, sessionId: childId, chat: chatOf([]), draft: '' })
  await new Promise((r) => setTimeout(r, 150)) // allow the 80ms restore timer
  childEnv.rerender() // materialize the Toast the timer published
  const setDraftCalls = childEnv.inputs.filter(([op]) => op === 'setDraft')
  assert.equal(setDraftCalls.length, 1, 'prompt restored exactly once on the branch')
  assert.equal(setDraftCalls[0][1], 'rewind me')
  assert.ok(toasts.some((t) => t === 'rewind.done'), 'done toast expected')
})

// --- delete mode (group 7) ---------------------------------------------------

/** Mount the header dispose toggle (registered[1] = header slot entry). */
function mountHeader({ services, sessionId, summary }) {
  const component = services.registered.find((r) => r.options.name === 'conversation.session.header.actions').component
  const env = { clicks: 0 }
  const props = () => ({
    sessionId,
    t: (k) => k,
    useSessions: (sel) => sel({ byId: { [sessionId]: summary } }),
  })
  const render = (first) => { if (first) freshInstance(); else beginRender(); return component(props()) }
  const materialize = (tree) => {
    if (tree && tree.__element && typeof tree.type === 'function') { try { tree.type(tree.props) } catch { /* noop */ } }
    if (tree && tree.props && tree.props.children) {
      const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
      for (const kid of kids) materialize(kid)
    }
    return tree
  }
  env.render = () => { let tree = render(true); if (isDirty()) tree = render(false); return materialize(tree) }
  env.rerender = () => { let tree = render(false); if (isDirty()) tree = render(false); return materialize(tree) }
  env.buttonOf = (tree) => {
    // Fragment wraps [button, toast?]
    const children = tree && tree.props && tree.props.children
    const list = Array.isArray(children) ? children : [children]
    return list.find((c) => c && c.props && c.props.type === 'button' && typeof c.props.onClick === 'function')
  }
  env.click = () => {
    env.clicks += 1
    const button = env.buttonOf(env.rerender())
    if (button && typeof button.props.onClick === 'function') button.props.onClick()
  }
  env.render()
  return env
}

/** Stub global fetch for one test; restores the previous value afterwards. */
async function withFetch(stub, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete globalThis.fetch
    else globalThis.fetch = previous
  }
}

test('delete mode: describe true arms delete; describe failure falls back to archive', async () => {
  const services = makeServices()
  applyWith(services)
  assert.equal(internals()._module.deleteModeOn(), false, 'default is archive')
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), true, 'delete armed after describe true')
  services.setSettingsValue(false)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), false)
  services.setSettingsDescribeError(new Error('settings down'))
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), false, 'describe failure must never arm delete')
})

test('delete mode: setDeleteMode persists and toasts the outcome', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  // Mount the overlay bridge so a toast listener is registered (in the GUI the
  // header toggle click goes through the same fan-out).
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(true)
  assert.equal(result.ok, true)
  assert.deepEqual(services.settingsCalls.updates[0][0], 'esc-rewind')
  assert.equal(services.settingsCalls.updates[0][1].deleteOldOnRewind, true)
  env.rerender() // surface the toast
  assert.ok(toasts.includes('已开启：回退将删除旧会话（不可恢复）'), 'enabled toast shown')
  assert.equal(internals()._module.deleteModeOn(), true)
  toasts.length = 0
  await internals()._module.setDeleteMode(false)
  env.rerender()
  assert.equal(services.settingsCalls.updates[1][1].deleteOldOnRewind, false)
  assert.ok(toasts.includes('已关闭：回退将归档旧会话'), 'disabled toast shown')
})

test('delete mode: failed settings write rolls back to the previous value', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), true)
  services.setSettingsUpdateError(new Error('write rejected'))
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(false)
  assert.equal(result.ok, false)
  assert.equal(internals()._module.deleteModeOn(), true, 'rolls back to delete after failed write')
  env.rerender()
  assert.ok(toasts.some((t) => t.startsWith('切换失败：')), 'error toast shown')
})

test('delete mode: doRewind deletes the old session after the branch opens', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target)
  const fetches = []
  await withFetch(async (url, opts) => {
    fetches.push([url, opts])
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }, async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true)
  })
  assert.deepEqual(fetches[0][0], '/__esc-rewind/session/delete')
  assert.equal(JSON.parse(fetches[0][1].body).sessionId, 's1')
  assert.ok(!services.calls.archived.includes('s1'), 'delete mode must NOT archive')
  env.rerender()
  assert.ok(toasts.includes('旧会话已删除'), 'deleted toast shown')
})

test('delete mode: failed delete degrades to archive and warns', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target, 'target exchange found')
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }), async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true, 'rewind itself still succeeds')
  })
  assert.ok(services.calls.archived.includes('s1'), 'failed delete falls back to archive')
  env.rerender()
  assert.ok(toasts.includes('删除失败，已改为归档'), 'degrade warning shown')
})

test('delete mode: first-exchange degradation deletes the old session too', async () => {
  const chat = chatOf([user(1, 'only question'), runningAssistant(2)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const first = internals()._module.exchangesOfSession('s1').find((ex) => ex.isFirst === true)
  assert.ok(first, 'first exchange present')
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), async () => {
    const result = await internals()._module.doRewind('s1', first)
    assert.equal(result.ok, true)
  })
  assert.equal(services.calls.creates.length, 1, 'fresh same-workspace session created')
  assert.ok(!services.calls.archived.includes('s1'), 'no archive in delete mode')
  env.rerender()
  assert.ok(toasts.includes('旧会话已删除'), 'deleted toast shown')
})

test('header toggle: renders archive glyph by default and flips to delete on click', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  toasts.length = 0
  const env = mountHeader({ services, sessionId: 's1', summary: { title: 'T' } })
  const first = env.buttonOf(env.rerender())
  assert.ok(first, 'button renders')
  assert.equal(first.props.title, 'dispose.title.archive', 'archive state by default')
  env.click()
  await new Promise((r) => setTimeout(r, 0)) // async settings write
  assert.equal(internals()._module.deleteModeOn(), true, 'click arms delete mode')
  env.rerender() // surface the toast the click published
  assert.ok(toasts.includes('已开启：回退将删除旧会话（不可恢复）'))
  const second = env.buttonOf(env.rerender())
  assert.equal(second.props.title, 'dispose.title.delete', 'delete state after toggle')
})

test('header toggle: hidden for subagent and blank sessions', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const subagent = mountHeader({ services, sessionId: 's1', summary: { title: 'T', origin: 'subagent' } })
  assert.equal(subagent.render(), null, 'subagent session: no toggle')
  const blank = mountHeader({ services, sessionId: 's1', summary: { title: 'T', blank: true } })
  assert.equal(blank.render(), null, 'blank session: no toggle')
  const normal = mountHeader({ services, sessionId: 's1', summary: { title: 'T' } })
  assert.ok(normal.render(), 'normal session: toggle visible')
})

test('delete mode: ESC stop hint carries the irreversible warning', async () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  env.press('Escape')
  assert.ok(toasts.includes('esc.hint.delete'), 'warning hint used in delete mode')
  assert.ok(!toasts.includes('esc.hint'), 'plain hint not used')
})

test('capability audit: delete goes through the self-hosted channel only', () => {
  const clientSource = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
  // The client must not reach any third-party endpoint or host surface: the
  // only delete path is the self-owned DELETE_ENDPOINT (fetched), with the
  // archive fallback via workspaces.archiveSession. No chameleon endpoints.
  assert.ok(!/__chameleon|@huanlin/.test(clientSource), 'no third-party delete endpoint referenced')
  assert.ok(clientSource.includes("'/__esc-rewind/session/delete'"), 'self-owned delete endpoint constant present')
  assert.ok(clientSource.includes('archiveSession'), 'archive fallback present')
  const hostSource = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
  assert.ok(hostSource.includes("'/__esc-rewind/session/delete'"), 'host half serves the self-owned endpoint')
  assert.ok(!/__chameleon/.test(hostSource), 'host half does not call chameleon')
})

// --- host half (src/index.js, real ESM — delete core + endpoint) -------------

let hostMod = null
test('host half: deleteSessionCore removes log dir, projcache and workspace rows', async () => {
  const { pathToFileURL } = await import('node:url')
  hostMod = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
  const os = await import('node:os')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsew-host-'))
  try {
    const sid = '11111111-2222-3333-4444-555555555555'
    const slug = path.join(root, 'myslug')
    fs.mkdirSync(path.join(slug, sid), { recursive: true })
    fs.writeFileSync(path.join(slug, sid, 'session.jsonl'), '{}')
    fs.mkdirSync(path.join(slug, 'session-' + sid), { recursive: true })
    // Fake storageDomain: projcache + workspace tables + archived global.
    const tables = {}
    const makeTable = (seed) => {
      const map = new Map(Object.entries(seed || {}))
      return {
        get: (k) => map.get(k),
        entries: () => [...map.entries()],
        put: async (k, v) => { map.set(k, v) },
        delete: async (k) => { map.delete(k) },
      }
    }
    const proj = makeTable({ [sid]: { identity: {} }, other: { identity: {} } })
    const wsTable = makeTable({ w1: { sessionIds: [sid, 'other'] } })
    const wsGlobal = { state: { archivedSessionIds: ['session-' + sid, 'zz'] }, get: () => wsGlobal.state, set: async (v) => { wsGlobal.state = v } }
    const sd = {
      get: (n) => n === 'session_projcache'
        ? { table: (t) => (t === 'sessions' ? proj : null) }
        : n === 'workspace' ? { table: (t) => (t === 'workspaces' ? wsTable : null), global: wsGlobal } : null,
    }
    const ctx = { get: (n) => (n === 'storageDomain' ? sd : undefined) }
    const result = await hostMod.deleteSessionCore(ctx, sid, root)
    assert.equal(result.dirRemoved, true)
    assert.equal(result.projRemoved, true)
    assert.equal(result.workspaceRemoved, true)
    assert.deepEqual(hostMod.findSessionDirs(sid, root), [], 'log dir gone')
    assert.equal(proj.get(sid), undefined, 'projcache row gone')
    assert.equal(proj.get('other') !== undefined, true, 'other rows untouched')
    assert.deepEqual(wsTable.get('w1').sessionIds, ['other'])
    assert.deepEqual(wsGlobal.state.archivedSessionIds, ['zz'])
    // Idempotency: a second delete is a 404-style error, not a throw-crash.
    await assert.rejects(() => hostMod.deleteSessionCore(ctx, sid, root), /session not found/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('host half: settings field and endpoint constants are stable', () => {
  assert.equal(hostMod.NS, 'esc-rewind')
  assert.equal(hostMod.SETTINGS_FIELD, 'deleteOldOnRewind')
  assert.equal(hostMod.DEFAULT_DELETE_OLD, false)
  assert.equal(hostMod.DELETE_PATH, '/__esc-rewind/session/delete')
  assert.equal(hostMod.STATUS_PATH, '/__esc-rewind/status')
  assert.deepEqual(hostMod.sessionIdVariants('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])
})

test('host half: fallback schema registers the namespace without schemastery', async () => {
  const { pathToFileURL } = await import('node:url')
  // In the test environment @deepseek-ai/schemastery cannot resolve from the
  // plugin dir (same as an external link: bundle in a real host), so
  // installSettingsSection must register through the zero-dep fallback schema.
  let installed = null
  const fakeSettings = {
    installSection: (owner, ns, Config, entry, hooks) => {
      installed = { owner, ns, Config, entry, hooks }
      hooks.setSource(() => entry)
    },
  }
  // Wait for the dynamic schemastery import to fail and the fallback to run.
  await new Promise((r) => setTimeout(r, 150))
  // Re-run through a tiny driver: export installSettingsSection? Not exported;
  // drive the public apply() with a settings service present.
  const hostCtx = {
    get: (name) => (name === 'settings' ? fakeSettings : name === 'webServer' || name === 'tools' ? undefined : undefined),
    effect: () => () => {},
    inject: () => () => {},
  }
  const exports = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
  exports.apply(hostCtx)
  await new Promise((r) => setTimeout(r, 200)) // dynamic import settle
  assert.ok(installed, 'installSection was called despite schemastery being unresolvable')
  assert.equal(installed.ns, 'esc-rewind')
  // The fallback schema must validate+default like z.boolean().default(false).
  assert.equal(installed.Config({})[hostMod.SETTINGS_FIELD], false, 'default false')
  assert.equal(installed.Config({ deleteOldOnRewind: true })[hostMod.SETTINGS_FIELD], true, 'true passes through')
  assert.equal(typeof installed.Config.toJSON, 'function', 'serializable for describe')
  assert.equal(exports.HOST_DIAG.settingsSectionRegistered, true, 'diag reports registered')
})

test('host half: registerHttp serves status + delete, rejecting wrong method/missing id', async () => {
  const registered = []
  const host = {
    register: (entry) => { registered.push(entry); return () => {} },
  }
  // cordis ctx.effect runs the registration callback immediately.
  const ctx = { get: () => undefined, effect: (fn) => { const dispose = fn(); return dispose || (() => {}) } }
  hostMod.registerHttp(ctx, host)
  assert.equal(registered.length, 2, 'status + delete endpoints registered')
  const status = registered.find((e) => e.path === hostMod.STATUS_PATH)
  const del = registered.find((e) => e.path === hostMod.DELETE_PATH)
  assert.ok(status && del, 'both endpoints present')
  assert.equal(status.kind, 'exact')
  assert.equal(del.kind, 'exact')
  // Status probe answers GET with diagnostics (no mutation).
  const resStatus = { writeHead: (s, h) => { resStatus.status = s }, end: (b) => { resStatus.body = b } }
  await status.handler({ method: 'GET' }, resStatus)
  assert.equal(resStatus.status, 200)
  assert.match(resStatus.body, /settingsSectionRegistered/)
  // Wrong method → 405 on the delete endpoint.
  const res405 = { writeHead: (s, h) => { res405.status = s }, end: (b) => { res405.body = b } }
  await del.handler({ method: 'GET' }, res405)
  assert.equal(res405.status, 405)
  // Missing sessionId → 400.
  const res400 = { writeHead: (s, h) => { res400.status = s }, end: (b) => { res400.body = b } }
  const req400 = { on: (ev, cb) => { if (ev === 'end') cb() }, destroy: () => {} }
  await del.handler({ method: 'POST' }, res400)
  assert.equal(res400.status, 400)
})

// --- settings reader shapes (guards a real cordis ctx puts on the surface) ----

test('settings reader: a guarded ctx whose bare `settings` read THROWS still binds', () => {
  applyWith(makeServices())
  const reader = internals()._module.readRemoteSettings
  const controller = { describe: async () => ({ ok: true, value: { namespaces: [] } }) }
  // Real guard shape: an uninjected bare property read throws, while the
  // service actually lives at scope.remote.settings.
  const guarded = {
    get settings() { throw new Error('cannot get property "settings" without inject') },
    get remote() { return { settings: controller, $on: () => () => {} } },
  }
  assert.equal(reader(guarded), controller, 'resolves through scope.remote.settings')
  // Same via get('remote.settings').
  const viaGet = { get: (name) => { if (name === 'remote.settings') return controller; throw new Error('no such service: ' + name) } }
  assert.equal(reader(viaGet), controller, 'resolves through get("remote.settings")')
  // Same via the get('remote') root.
  const viaRoot = { get: (name) => { if (name === 'remote') return { settings: controller }; throw new Error('nope') } }
  assert.equal(reader(viaRoot), controller, 'resolves through the remote root')
  // Nothing reachable → null, never a throw.
  const empty = {
    get settings() { throw new Error('guarded') },
    get remote() { throw new Error('guarded') },
    get() { throw new Error('guarded') },
  }
  assert.equal(reader(empty), null, 'all candidates throwing degrades to null')
})

test('settings envelope: ok:true unwraps the value, ok:false raises the message', () => {
  applyWith(makeServices())
  const unwrap = internals()._module.unwrapResult
  assert.deepEqual(unwrap({ ok: true, value: { namespaces: [{ ns: 'x' }] } }), { namespaces: [{ ns: 'x' }] })
  assert.throws(() => unwrap({ ok: false, error: { code: 'settings/rejected', message: 'no such namespace' } }), /no such namespace/)
  assert.deepEqual(unwrap({ namespaces: [] }), { namespaces: [] }, 'plain payloads pass through')
})

test('regression: applying with a guard-shaped ctx binds settings and toggles', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  const settingsService = services.settings
  const factory = factories.get(PKG_ID)
  const remoteRoot = { settings: settingsService, $on: () => () => {} }
  // Wrap the harness ctx in the guard shape the real runtime uses: only the
  // injected names answer, every other bare property or get() THROWS, and the
  // settings controller is reachable as `remote.settings` on that scope.
  const base = makeCtx(services)
  const registered = base.registered
  services.registered = registered
  const guardSlot = (name) => {
    if (name === 'remote') return remoteRoot
    if (name === 'remote.settings') return settingsService
    throw new Error('cannot get property "' + name + '" without inject')
  }
  const ctx = Object.assign({}, base, {
    get: (name) => {
      if (name === 'slots' || name === 'locale' || name === 'commandUi' || name === 'sessions' || name === 'workspaces' || name === 'conversation' || name === 'uiConversation') return base.get(name)
      return guardSlot(name)
    },
    inject: (names, cb) => {
      const sub = {
        get: guardSlot,
        get remote() { return remoteRoot },
        get settings() { throw new Error('cannot get property "settings" without inject') },
      }
      sub['remote.settings'] = settingsService
      cb(sub)
      return () => {}
    },
  })
  factory(requireStub).apply(ctx)
  assert.equal(registered.length, 2, 'both slot entries registered on a guard ctx')
  assert.equal(internals()._module.getSettings(), settingsService, 'settings controller bound through the guard shape')
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(true)
  assert.equal(result.ok, true, 'write succeeds when the controller is reachable')
  env.rerender()
  assert.ok(!toasts.some((text) => String(text).indexOf('settings-unavailable') !== -1), 'never claims settings-unavailable')
  assert.equal(internals()._module.deleteModeOn(), true)
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    toasts.length = 0
    keydownHandler = null
    keydownCapture = null
    lsStore.clear()
    try { internals()._module.resetHistoryCache() } catch { /* module not bound yet */ }
    await fn()
    console.log('  ok  -', name)
  } catch (error) {
    failed += 1
    console.error('FAIL -', name)
    console.error(error && error.stack ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
process.exit(failed > 0 ? 1 : 0)
