// Behavioural harness for dsh-open-session-workdir/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with real
// module ids and stub UI primitives, and drives the header component through a
// minimal hook shim so the click path (open call, failure classification,
// timeout, copy) is executed and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: React semantics are approximated
// (one effect run per slot, state visible only after an explicit re-render).
// Visual/layout/portal behaviour still needs the manual checks in tasks.md.
// The cross-plugin case — does dsh-better-sidebar steal the open? — lives in
// interception.test.mjs, which mounts their REAL code.
//
// Run: node dsh-open-session-workdir/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-open-session-workdir'
const NS = 'open-session-workdir'
const OPEN_TIMEOUT_MS = 8000

// --- browser-ish globals -----------------------------------------------------

const clipboardWrites = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    languages: ['zh-CN'],
    language: 'zh-CN',
    clipboard: { writeText: async (text) => { clipboardWrites.push(text) } },
  },
})
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
}
globalThis.document = {
  body: {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, select() {} }),
}

const factories = new Map()
globalThis.window.__ModuleLoader__ = {
  load: ({ id, factory }) => factories.set(id, factory),
}

// --- stub externals ----------------------------------------------------------

const IconStub = () => null

function makeReact() {
  let slots = []
  let index = 0
  let dirty = false
  const hookStore = new WeakMap()
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true,
      type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        dirty = true
      }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useEffect(effect) {
      const i = index++
      if (!(i in slots)) slots[i] = { ran: false }
      const slot = slots[i]
      if (!slot.ran) {
        slot.ran = true
        effect()
      }
    },
    useCallback: (fn) => {
      const i = index++
      if (!(i in slots)) slots[i] = fn
      return slots[i]
    },
    useMemo: (fn) => fn(),
  }
  return {
    React,
    /** Re-render the SAME instance: hook state survives, the index rewinds. */
    beginRender() { index = 0; dirty = false },
    /** First render of a new instance: hook state starts empty. */
    freshInstance() { slots = []; index = 0; dirty = false },
    isDirty: () => dirty,
    /**
    * Run a nested component with its OWN hook list, keyed by the element node,
    * so walking a tree cannot borrow (and corrupt) the parent's slots.
    */
    withScope(node, fn) {
      const savedSlots = slots
      const savedIndex = index
      if (!hookStore.has(node)) hookStore.set(node, [])
      slots = hookStore.get(node)
      index = 0
      try {
        return fn()
      } finally {
        slots = savedSlots
        index = savedIndex
      }
    },
  }
}

const { React, beginRender, freshInstance, isDirty, withScope } = makeReact()

const primitives = {
  IconCheckOutline16: IconStub,
  IconCloseOutline16: IconStub,
  IconCopyOutline16: IconStub,
  IconFolderOpenOutline16: IconStub,
  IconLoadingOutline16: IconStub,
  IconWarningOutline16: IconStub,
  // Real Toast is a string-only banner; the stub just records what was shown.
  Toast: ({ text }) => ({ __toast: text }),
  Tooltip: ({ children }) => children,
  writeClipboard: async (text) => {
    await globalThis.navigator.clipboard.writeText(text)
    return true
  },
}

const ReactDOM = { createPortal: (node) => node }

function requireStub(specifier) {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return ReactDOM
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', source)(
  globalThis.window,
  globalThis.navigator,
  globalThis.document,
)

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
* A stand-in host shaped like the core that ACTUALLY runs here (0.1.2-alpha.2,
* symlinked from the dev checkout, while dsh-client-runtime is still 0.1.1-rc.2):
*  - `workspaces` exists but WorkspaceRuntime no longer defines `openPath`,
*  - `connection` exists but the handle lost its `api` field,
*  - `remote.session.openWorkspacePath` is the only opener left, and the gateway
*    installs it as a CONFIGURABLE GETTER backed by a `methods` registry.
* `legacyWorkspaces` / `legacyConnection` restore the older shapes so the first
* two channels stay covered.
*
* `open` may be undefined (success), an Error (thrown), a Result object
* (`{ok:false,error}`), or a function. `open: 'no-opener'` removes all three.
*/
function makeHost({ canOpen = { ok: true, value: true }, open, picker, legacyWorkspaces = false, legacyConnection = false, sessionScope = false } = {}) {
  const calls = { open: [], list: [], signals: [], shadowed: [], callerCtx: [] }
  const gone = open === 'no-opener'
  const envelope = (value) => ({ ok: true, value: value === undefined ? { opened: true } : value })
  const runOpen = async (target, signal) => {
    calls.open.push(target)
    calls.signals.push(signal)
    if (typeof open === 'function') return envelope(await open(target, signal))
    if (open instanceof Error) throw open
    if (open && typeof open === 'object' && 'ok' in open) return open
    return envelope(open)
  }
  // The pristine registration, exactly as the gateway keeps it in `methods`.
  const record = { direct: (request, signal) => runOpen(request.path, signal) }
  const session = {
    canOpenWorkspacePath: async () => canOpen,
    methods: { get: (name) => (name === 'openWorkspacePath' && !gone ? record : undefined) },
    invokeRemote: (direct, scoped, callerCtx, args) => {
      calls.callerCtx.push(callerCtx)
      return direct(args[0], args[1])
    },
    ctx: {},
  }
  if (!gone) {
    // Core installs an accessor; the getter returns a fresh invoker each read.
    Object.defineProperty(session, 'openWorkspacePath', {
      configurable: true,
      enumerable: true,
      get() {
        return (request, signal) => {
          calls.shadowed.push('public-getter')
          return runOpen(request.path, signal)
        }
      },
    })
  }
  const remote = { session }
  if (picker !== null) {
    remote.directoryPicker = {
      list: async (...args) => {
        calls.list.push(args)
        return typeof picker === 'function' ? picker(...args) : (picker ?? { ok: true, value: {} })
      },
    }
  }
  const connection = legacyConnection && !gone
    ? { api: { host: { openPath: (payload, signal) => runOpen(payload.path, signal).then((value) => ({ result: value })) } } }
    : { isLoopback: true, generation: {}, state: {}, reconnect() {} }
  const workspaces = gone ? undefined
    : legacyWorkspaces ? { openPath: (target) => runOpen(target, undefined) } : { pickDirectory: async () => ({}) }
  // `sessions.scope(id)` is the only ctx that carries a session tag; the
  // namespace's own ctx is the root one and tags nothing.
  const sessions = sessionScope ? { scope: (id) => ({ sessionTag: id }) } : undefined
  return { remote, workspaces, connection, calls, session, record, sessions }
}

/** What dsh-better-sidebar does: replace the accessor with a plain value property. */
function shadowOpenWorkspacePath(session, calls, behaviour) {
  Object.defineProperty(session, 'openWorkspacePath', {
    configurable: true, enumerable: true, writable: true,
    value: (request, signal) => { calls.shadowed.push('shadow'); return behaviour(request, signal) },
  })
}

/** Materialize the factory once per scenario: the bundle keeps module state. */
function freshApply() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  return factory(requireStub)
}

function makeCtx(host, locale, { late = false, noGet = false, bareRoot = false, blind = false } = {}) {
  const registered = []
  const injected = []
  const { remote, workspaces, connection, sessions } = host
  // Cordis answers dotted names: `remote.session` is the controller itself.
  // `bareRoot` models the real external-plugin hazard we hit — injecting the
  // bare `remote` yields the root with NO controllers mounted on it.
  const services = {
    locale,
    remote: bareRoot ? {} : remote,
    'remote.session': remote && remote.session,
    sessions,
    'remote.directoryPicker': remote && remote.directoryPicker,
    workspaces,
    connection,
  }
  /**
  * `blind` is the FIELD shape and boot() turns it on by default: the apply-time
  * ctx answers NOTHING — not via get, not via properties. Every service arrives
  * later, through the scope handed to an ctx.inject callback. Assuming otherwise
  * is what failed twice in production (`remote.session`, then `connection`).
  * `late` is the same blindness narrowed to the services that mount after apply.
  */
  const propBlind = blind || late
  const getBlind = blind || late || noGet
  const scoped = { get: (name) => services[name], effect: (fn) => fn(), on: () => {} }
  return {
    registered,
    injected,
    remote: propBlind ? undefined : (bareRoot ? {} : remote),
    sessions: propBlind ? undefined : sessions,
    workspaces: propBlind ? undefined : workspaces,
    connection: propBlind ? undefined : connection,
    locale: propBlind ? undefined : locale,
    get: (name) => (getBlind ? undefined : services[name]),
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => { injected.push(names); fn(scoped) },
    slots: {
      inject: (slotName, build) => { build(); return { registered } },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
}

/** Boot one scenario: fresh bundle state, applied, gate settled, rendered. */
async function boot(hostOptions = {}, renderOptions) {
  const host = makeHost(hostOptions)
  const ctx = makeCtx(host, hostOptions.locale, {
    late: !!hostOptions.late, noGet: !!hostOptions.noGet,
    bareRoot: !!hostOptions.bareRoot, blind: hostOptions.blind !== false,
  })
  ctx.__host = host
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  return { ...host, ctx, component, view: renderHeader(component, renderOptions) }
}

/** Render the registered header component; rerender() keeps its hook state. */
function renderHeader(component, { sessionId = 'sess-1', cwd = 'D:\\My Project\\中文 dir' } = {}) {
  const state = { byId: { [sessionId]: { cwd } } }
  const useSessions = (selector) => selector(state)
  const t = (key) => key
  const props = { sessionId, useSessions, t }
  const render = (first) => {
    if (first) freshInstance()
    else beginRender()
    return component(props)
  }
  let tree = render(true)
  if (isDirty()) tree = render(false)
  return { tree, rerender: () => ({ tree: render(false) }), state }
}

/**
* Walk the element tree, invoking function components so their output is
* walkable too (FailureCard/Tooltip render through components, not markup).
*/
function findProps(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findProps(child, predicate, found)
    return found
  }
  if (!node.__element) return found
  if (predicate(node)) found.push(node)
  if (typeof node.type === 'function' && node.type !== IconStub) {
    let output
    try { output = withScope(node, () => node.type(node.props)) } catch { output = null }
    if (output) findProps(output, predicate, found)
    return found
  }
  findProps(node.props.children, predicate, found)
  return found
}

/** Collect every rendered string in a subtree (function components expanded). */
function collectText(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (!node || typeof node !== 'object' || !node.__element) return out
  if (typeof node.type === 'function' && node.type !== IconStub) {
    let output
    try { output = withScope(node, () => node.type(node.props)) } catch { output = null }
    if (output) collectText(output, out)
    return out
  }
  collectText(node.props.children, out)
  return out
}

const hasText = (node, text) => collectText(node).includes(text)
const findButton = (tree) => findProps(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function')[0]
const findToast = (tree) => findProps(tree, (n) => n.type === primitives.Toast)[0]
const findByText = (tree, text) => (hasText(tree, text) ? text : null)
const findButtonWithText = (tree, text) => findProps(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function')
  .find((button) => hasText(button, text))

/** Click the header button, then return the post-click tree of the same instance. */
async function clickAndSettle(view) {
  await findButton(view.tree).props.onClick()
  await tick()
  return view.rerender().tree
}

// --- assertions --------------------------------------------------------------

test('bundle registers under the package id and declares its services', () => {
  assert.ok(factories.has(PKG_ID), 'no __ModuleLoader__.load for the package id')
  const exports = freshApply()
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers one header entry at the agreed slot/id/order', () => {
  const ctx = makeCtx(makeHost())
  freshApply().apply(ctx)
  assert.equal(ctx.registered.length, 1)
  const { options } = ctx.registered[0]
  assert.equal(options.name, 'conversation.session.header.actions')
  assert.equal(options.id, 'open-workdir')
  assert.equal(options.order, 25)
  assert.equal(options.locale, undefined, 'no locale seat without the locale service')
})

test('with the locale service present the entry declares its namespace', () => {
  const locale = { register: () => () => {}, translate: () => undefined, subscribe: () => () => {} }
  const ctx = makeCtx(makeHost(), locale)
  freshApply().apply(ctx)
  assert.equal(ctx.registered[0].options.locale, NS)
})

test('gate closed (host has no desktop) renders nothing', async () => {
  const { view } = await boot({ canOpen: { ok: true, value: false } })
  assert.equal(view.tree, null, 'button must not render when canOpenWorkspacePath() is false')
})

test('probe failure closes the gate instead of leaving a dead button', async () => {
  const host = makeHost()
  host.remote.session.canOpenWorkspacePath = async () => { throw new Error('gateway down') }
  const ctx = makeCtx(host)
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  assert.equal(renderHeader(component).tree, null)
})

test('no opener channel at all reports a precise failure instead of vanishing', async () => {
  const { view } = await boot({ open: 'no-opener' }, { cwd: 'D:\\exists' })
  assert.ok(findButton(view.tree), 'the gate is the host capability, not our route existing')
  const after = await clickAndSettle(view)
  assert.ok(findByText(after, 'card.noOpener'), 'must name the missing service, not fail silently')
})

test('services mounted after apply still open the gate', async () => {
  // The bug this guards: one combined ctx.inject(['remote','workspaces']) waits
  // on BOTH, so a name the loader cannot resolve parks it forever and the
  // button silently never appears. Each service gets its own independent wait.
  const host = makeHost()
  const ctx = makeCtx(host, undefined, { late: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  assert.deepEqual(ctx.injected, [['remote.session'], ['workspaces'], ['connection'], ['locale']], 'waits must be per-service')
  assert.ok(findButton(renderHeader(component).tree), 'late-mounted services must still render the button')
})

test('a service reachable only as a ctx property is still found', async () => {
  // ctx.get('remote') can come back undefined while ctx.remote is populated.
  // Reading only get() used to park the gate closed and delete the button.
  const host = makeHost()
  const ctx = makeCtx(host, undefined, { noGet: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  assert.ok(findButton(renderHeader(component).tree), 'the property channel must be a working fallback')
})

test('a bare remote root with no controllers still opens the gate', async () => {
  // What actually broke in the field: `remote` resolved, `remote.session` did
  // not exist on it. The dotted cordis name is the channel that works.
  const host = makeHost()
  const ctx = makeCtx(host, undefined, { bareRoot: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  assert.ok(findButton(renderHeader(component).tree), 'must reach the controller by its dotted name')
})

test('a closed gate announces why on the console', async () => {
  const logs = []
  const realInfo = console.info
  console.info = (...args) => { logs.push(args.join(' ')) }
  try {
    await boot({ canOpen: { ok: true, value: false } })
  } finally {
    console.info = realInfo
  }
  assert.ok(logs.some((l) => l.includes('[open-session-workdir]') && /CLOSED/.test(l)),
    'an invisible decision must still be observable: ' + JSON.stringify(logs))
})

test('session without a cwd renders nothing', async () => {
  const { view } = await boot({}, { cwd: '' })
  assert.equal(view.tree, null)
})

test('gate open + cwd renders the button', async () => {
  const { view } = await boot({})
  assert.ok(view.tree, 'expected a rendered tree')
  assert.ok(findButton(view.tree), 'expected a clickable button')
})

test('click hands the cwd to the opener verbatim', async () => {
  const cwd = 'D:\\My Project\\中文 dir'
  const { view, calls } = await boot({}, { cwd })
  await clickAndSettle(view)
  assert.deepEqual(calls.open, [cwd], 'path must be passed through untouched')
})

test('the apiproxy channel carries an AbortSignal, so the open is cancellable', async () => {
  // Only that layer takes a signal. The session route deliberately passes none,
  // because calling invokeRemote directly would hand it a signal to serialise.
  const { view, calls } = await boot({ legacyConnection: true })
  await clickAndSettle(view)
  assert.equal(calls.open.length, 1)
  const signal = calls.signals[0]
  assert.ok(signal && typeof signal.aborted === 'boolean', 'host.openPath must receive a signal')
})

test('workspaces.openPath wins when a build makes it container-visible', async () => {
  const { view, calls } = await boot({ legacyWorkspaces: true })
  await clickAndSettle(view)
  assert.deepEqual(calls.open, ['D:\\My Project\\中文 dir'])
  assert.equal(calls.signals[0], undefined, 'the service route takes no signal, and must be preferred')
})

test('the bundle touches no state-changing session API', () => {
  /**
  * Task 5.2 ("clicking must not change session state") is provable statically,
  * which is stronger than eyeballing one run: the real mutating surface of the
  * session remote is enumerated from the installed typert metadata, and the
  * bundle must not reference ANY of it. Derived, not hand-typed, so a core that
  * adds a mutator shows up here instead of in a bug report.
  */
  const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const MUTATING = [
    'attachment', 'cancel', 'control', 'create', 'follow', 'fork', 'prompt',
    'refreshTitle', 'rename', 'rewind', 'selectModel', 'updateQueue',
  ]
  const touched = MUTATING.filter((m) => source.includes('.' + m + '('))
  assert.deepEqual(touched, [], 'the plugin may only read cwd and hand a path to the opener')
  // And the two session methods it does call are exactly the probe and the open.
  const sessionCalls = ['canOpenWorkspacePath', 'openWorkspacePath'].filter((m) => source.includes('.' + m + '('))
  assert.deepEqual(sessionCalls, ['canOpenWorkspacePath', 'openWorkspacePath'])
})

test('a scoped open is addressed with the clicked session scope, not the root ctx', async () => {
  // The gateway resolves WHICH session a scoped remote hits by asking
  // sessions.scopeOf(callerCtx). Passing the namespace ctx tags nothing, so a
  // second session can silently address the wrong one — the shape behind
  // "works in one session, not in another".
  const host = makeHost({ sessionScope: true })
  shadowOpenWorkspacePath(host.session, host.calls, async (request) => {
    throw new Error(request.path + ' is a directory')
  })
  const ctx = makeCtx(host, undefined, { blind: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  await clickAndSettle(renderHeader(component))
  assert.deepEqual(host.calls.open, ['D:\\My Project\\中文 dir'], 'the pristine path did the work')
  assert.deepEqual(host.calls.callerCtx, [{ sessionTag: 'sess-1' }],
    'the gateway must be told which session this open belongs to')
  assert.notEqual(host.calls.callerCtx[0], host.session.ctx,
    'the namespace ctx is the ROOT one: scopeOf() tags nothing')
})

test('the session route is used when the newer core dropped the other two', async () => {
  // 0.1.2-alpha.2: workspaces lost openPath, connection lost api. ui-chat in the
  // same checkout calls remote.session.openWorkspacePath, and so must we.
  const { view, calls } = await boot({})
  await clickAndSettle(view)
  assert.equal(calls.open.length, 1, 'the session channel must open the path')
  assert.deepEqual(calls.shadowed, ['public-getter'], 'unshadowed, the public accessor is the entry point')
})

test('a shadowed openWorkspacePath is bypassed through the pristine registry', async () => {
  // The exact interception that produced `"...dsh-plugins" is a directory`.
  const host = makeHost({})
  shadowOpenWorkspacePath(host.session, host.calls, async (request) => {
    throw new Error(request.path + ' is a directory')
  })
  const ctx = makeCtx(host, undefined, { blind: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  const view = renderHeader(component)
  await clickAndSettle(view)
  assert.deepEqual(host.calls.shadowed, [], 'detection is structural: the shadow is never even called')
  assert.deepEqual(host.calls.open, ['D:\\My Project\\中文 dir'], 'the pristine registration must have done the work')
  assert.ok(!findByText(view.tree, 'is a directory'), 'the interception error must not surface')
})

test('if the pristine registry moves, we still call the shadowed entry', async () => {
  // Degrade to "intercepted" rather than "absent": internals can drift.
  const host = makeHost({})
  shadowOpenWorkspacePath(host.session, host.calls, async (request) => {
    throw new Error(request.path + ' is a directory')
  })
  delete host.session.methods
  const ctx = makeCtx(host, undefined, { blind: true })
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  const view = renderHeader(component)
  const after = await clickAndSettle(view)
  assert.deepEqual(host.calls.shadowed, ['shadow'], 'with no registry to fall back on, the public entry is used')
  assert.ok(findByText(after, 'card.failed'), 'and its failure is reported honestly instead of vanishing')
})

test('a failed Result envelope is reported as a host failure, not as success', async () => {
  // host.openPath answers {result:{ok:false,error}} instead of throwing.
  const { view } = await boot({ open: { ok: false, error: { message: 'Invoke-Item refused' } } }, { cwd: 'D:\\exists' })
  const after = await clickAndSettle(view)
  assert.ok(findByText(after, 'card.failed'), 'a failed envelope must not look like an open')
  assert.ok(findByText(after, 'Invoke-Item refused'))
})

test('success surfaces a toast that does not over-promise', async () => {
  const { view } = await boot({})
  const after = await clickAndSettle(view)
  const toast = findToast(after)
  assert.ok(toast, 'expected a toast')
  assert.equal(toast.props.text, 'toast.opened')
})

test('failure with an unreachable directory says so and keeps the path', async () => {
  const cwd = 'D:\\gone\\dir'
  const { view } = await boot({
    open: new Error('path open failed: Invoke-Item : 找不到路径'),
    picker: { ok: false, error: { message: 'ENOENT' } },
  }, { cwd })
  const after = await clickAndSettle(view)
  assert.ok(findByText(after, 'card.unreachable'), 'expected the unreachable classification')
  assert.ok(findByText(after, cwd), 'the full path must stay visible')
})

test('failure on a reachable directory surfaces the host reason, unwrapped', async () => {
  const cwd = 'D:\\exists'
  const { view } = await boot({
    open: new Error('path open failed: opener refused'),
    picker: { ok: true, value: { entries: [] } },
  }, { cwd })
  const after = await clickAndSettle(view)
  assert.ok(findByText(after, 'card.failed'), 'expected the generic failure classification')
  assert.ok(findByText(after, 'opener refused'), 'host reason must be shown without the runtime prefix')
  assert.equal(findByText(after, 'path open failed: opener refused'), null, 'the wrapper sentence must be stripped')
})

test('no browse picker wired up must not masquerade as "unreachable"', async () => {
  const { view } = await boot({ open: new Error('boom'), picker: null }, { cwd: 'D:\\maybe' })
  const after = await clickAndSettle(view)
  assert.ok(findByText(after, 'card.failed'), 'must fall back to the host reason, not claim unreachable')
  assert.ok(findByText(after, 'boom'))
})

test('a stalled opener is reported as a timeout, not as a plain failure', async () => {
  // The deadline is a client-side race (openPath takes no signal), so shrink
  // only that one timer instead of sleeping 8s.
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === OPEN_TIMEOUT_MS ? realSetTimeout(fn, 0) : realSetTimeout(fn, ms, ...rest))
  try {
    const { view } = await boot({ open: () => new Promise(() => {}) }, { cwd: 'D:\\slow' })
    await findButton(view.tree).props.onClick()
    // The deadline is a macrotask, so crossing microtasks is not enough: drain
    // a few real timer turns so the race can lose.
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0))
    const after = view.rerender().tree
    assert.ok(findByText(after, 'card.timeout'), 'expected the timeout copy')
    assert.ok(findButton(after), 'the button must be clickable again after a timeout')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('copy affordance writes the absolute host path to the clipboard', async () => {
  const cwd = 'D:\\host\\only'
  const { view } = await boot({ open: new Error('nope'), picker: { ok: false } }, { cwd })
  const after = await clickAndSettle(view)
  const copyButton = findButtonWithText(after, 'card.copy')
  assert.ok(copyButton, 'expected a copy-path button in the failure feedback')
  await copyButton.props.onClick()
  await tick()
  assert.deepEqual(clipboardWrites, [cwd])
})

test('consecutive clicks each start their own request', async () => {
  const { view, calls } = await boot({})
  await findButton(view.tree).props.onClick()
  await tick()
  await findButton(view.rerender().tree).props.onClick()
  await tick()
  await findButton(view.rerender().tree).props.onClick()
  await tick()
  assert.equal(calls.open.length, 3, 'a settled request must leave the button clickable')
})

test('switching sessions retargets the path without a reload', async () => {
  const host = makeHost()
  const ctx = makeCtx(host)
  const component = (freshApply().apply(ctx), ctx.registered[0].component)
  await tick()
  await clickAndSettle(renderHeader(component, { sessionId: 'a', cwd: 'D:\\first' }))
  await clickAndSettle(renderHeader(component, { sessionId: 'b', cwd: 'D:\\second' }))
  assert.deepEqual(host.calls.open, ['D:\\first', 'D:\\second'])
})

test('locale dictionaries are registered under the plugin namespace', () => {
  const registered = []
  const locale = { register: (ns, dicts) => { registered.push([ns, Object.keys(dicts)]); return () => {} }, translate: () => undefined, subscribe: () => () => {} }
  const ctx = makeCtx(makeHost(), locale)
  freshApply().apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0][0], NS)
  assert.deepEqual(registered[0][1], ['zh', 'en'])
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error && error.message}`)
  }
}
console.log(failed === 0 ? `\n${tests.length}/${tests.length} passed` : `\n${failed}/${tests.length} FAILED`)
process.exit(failed === 0 ? 0 : 1)
