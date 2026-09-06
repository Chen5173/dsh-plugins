// Integration probe: my plugin's click path vs dsh-better-sidebar's REAL
// openWorkspacePath shadow.
//
// WHY THIS FILE EXISTS
// dsh-better-sidebar shadows `remote.session.openWorkspacePath` (its
// registerOpenPathInterception) so that chat file links open in its sidebar
// editor. My header button calls the same method to mean "open this DIRECTORY in
// the OS file manager", so the shadow swallowed it and the editor answered
// `"D:\..." is a directory`.
//
// Rather than re-implement their decision logic (which would only test my guess
// about it), this probe EXTRACTS the two real functions from the installed
// bundle by brace matching and mounts them. If they ever change shape, the
// extraction fails loudly instead of silently passing a stale model.
//
// The assertion is the user's symptom itself: an OS open must reach the host
// opener, and the sidebar editor must NOT be opened for a directory.
//
// Run: node dsh-open-session-workdir/test/interception.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-open-session-workdir'

// --- locate the installed interceptor ---------------------------------------

function findSidebarBundle() {
  const candidates = [
    process.env.DSH_BETTER_SIDEBAR,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client-registry.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const sidebarPath = findSidebarBundle()
if (sidebarPath === null) {
  console.log('SKIP: dsh-better-sidebar is not installed here — nothing to intercept.')
  console.log('      (the unit suite in bundle.test.mjs still covers the plugin logic)')
  process.exit(0)
}

/** Pull one top-level `function NAME(...) { ... }` out of the bundle by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.greaterThan?.(start, -1)
  assert.ok(start !== -1, `function ${name} not found in ${path.basename(sidebarPath)} — their bundle changed shape`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') { // skip string literals
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
      continue
    }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 1; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

const sidebarSource = fs.readFileSync(sidebarPath, 'utf8')
const isFolderRevealPathSrc = extractFunction(sidebarSource, 'isFolderRevealPath')
const wrapOpenWorkspacePathSrc = extractFunction(sidebarSource, 'wrapOpenWorkspacePath')
// Guard against a silent mis-extraction: the real folder test is a suffix regex.
assert.ok(isFolderRevealPathSrc.includes('isFolderRevealPath'), 'extraction lost its own name')
assert.ok(wrapOpenWorkspacePathSrc.includes('takeoverEnabled'), 'extracted the wrong body')

const { isFolderRevealPath, wrapOpenWorkspacePath } = new Function(
  `${isFolderRevealPathSrc}\n${wrapOpenWorkspacePathSrc}\nreturn { isFolderRevealPath, wrapOpenWorkspacePath }`,
)()

// --- browser-ish globals + stub react (same shape as bundle.test.mjs) ---------

const clipboardWrites = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN', clipboard: { writeText: async (t) => { clipboardWrites.push(t) } } },
})
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 }
globalThis.document = { body: {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
const factories = new Map()
globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }

const IconStub = () => null
let slots = []
let index = 0
let dirty = false
const React = {
  createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = index++
    if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = slots[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; dirty = true }]
  },
  useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
  useEffect(effect) { const i = index++; if (!(i in slots)) slots[i] = { ran: false }; const s = slots[i]; if (!s.ran) { s.ran = true; effect() } },
  useCallback: (fn) => { const i = index++; if (!(i in slots)) slots[i] = fn; return slots[i] },
  useMemo: (fn) => fn(),
}
const primitives = {
  IconCheckOutline16: IconStub, IconCloseOutline16: IconStub, IconCopyOutline16: IconStub,
  IconFolderOpenOutline16: IconStub, IconLoadingOutline16: IconStub, IconWarningOutline16: IconStub,
  Toast: () => null,
  Tooltip: ({ children }) => children,
  writeClipboard: async (text) => { await globalThis.navigator.clipboard.writeText(text); return true },
}
function requireStub(spec) {
  if (spec === 'react') return React
  if (spec === 'react-dom') return { createPortal: (node) => node }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${spec}")`)
}
new Function('window', 'navigator', 'document', fs.readFileSync(bundlePath, 'utf8'))(
  globalThis.window, globalThis.navigator, globalThis.document,
)

// --- the scenario: a host where BOTH plugins are installed -------------------

const SESSION_ID = 'sess-1'
const CWD = 'D:\\ChenSirDocument\\Dsh-Projects\\dsh-plugins'

const events = { osOpens: [], sidebarOpens: [], reveals: [] }

/**
* `remote.session` exactly as the gateway mounts it on the core that ACTUALLY
* runs here (0.1.2-alpha.2): each method is an own CONFIGURABLE ACCESSOR whose
* getter delegates to `invokeRemote(record.direct, ...)`, and `methods` is the
* registry holding that pristine record. Both routes land on the same host
* openNativePath -- the only difference is whether a plugin sits in front.
*/
const openNativePath = async (request, signal) => {
  events.osOpens.push({ via: 'host.openNativePath', path: request.path, signal: Boolean(signal) })
  return { ok: true, value: { opened: true } }
}
const sessionNamespace = {
  canOpenWorkspacePath: async () => ({ ok: true, value: true }),
  methods: new Map([['openWorkspacePath', { direct: openNativePath }]]),
  ctx: {},
}
sessionNamespace.invokeRemote = (direct, scoped, callerCtx, args) => direct(args[0], args[1])
Object.defineProperty(sessionNamespace, 'openWorkspacePath', {
  configurable: true,
  enumerable: true,
  get() {
    const record = sessionNamespace.methods.get('openWorkspacePath')
    return (request, signal) => sessionNamespace.invokeRemote(record.direct, undefined, sessionNamespace.ctx, [request, signal])
  },
})

/**
* The other two channels as 0.1.2-alpha.2 really leaves them: WorkspaceRuntime
* no longer defines openPath, and the connection handle lost its `api` field.
* Both are present-but-useless, which is exactly why earlier copies of this probe
* passed while the button still failed in the browser.
*/
const workspaces = { pickDirectory: async () => ({ ok: true, value: {} }) }
const connection = { isLoopback: true, generation: {}, state: {}, reconnect() {} }

const remote = { session: sessionNamespace }

// Install their REAL shadow, with takeover fully on (the user's configuration).
wrapOpenWorkspacePath(sessionNamespace, {
  takeoverEnabled: () => true,
  currentSessionId: () => SESSION_ID,
  openInSidebar: (p, sid) => { events.sidebarOpens.push({ path: p, sessionId: sid }) },
  revealInExplorer: (p, sid) => { events.reveals.push({ path: p, sessionId: sid }) },
})

function makeCtx() {
  const registered = []
  /**
  * Faithful to an EXTERNAL bundle: cordis answers the dotted controller name,
  * while the bare `remote` root has no controllers mounted on it. The property
  * form `ctx.remote.session` (what core bundles use) is deliberately absent --
  * that missing shape is exactly what made the button vanish in the field.
  */
  const services = {
    remote: {},
    'remote.session': remote.session,
    'remote.directoryPicker': remote.directoryPicker,
    workspaces,
    connection,
  }
  const scoped = () => ({ get: (name) => services[name], effect: (fn) => fn(), on: () => {} })
  return {
    registered,
    remote: undefined,
    workspaces: undefined,
    connection: undefined,
    sessions: { list: { getSnapshot: () => ({ current: SESSION_ID, byId: { [SESSION_ID]: { cwd: CWD } } }) } },
    // The FIELD shape: the apply-time ctx resolves nothing at all, so every
    // service must arrive through the scope an inject callback is handed.
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => fn(scoped()),
    slots: {
      inject: (_slot, build) => { build(); return {} },
      register: (_options, component) => { registered.push(component); return { dispose() {} } },
    },
  }
}

function render(component) {
  const state = { byId: { [SESSION_ID]: { cwd: CWD } } }
  const props = { sessionId: SESSION_ID, useSessions: (sel) => sel(state), t: (k) => k }
  const run = (fresh) => { if (fresh) { slots = [] } index = 0; dirty = false; return component(props) }
  let tree = run(true)
  if (dirty) tree = run(false)
  return { tree, rerender: () => { index = 0; dirty = false; return { tree: component(props) } } }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (!node.__element) return
  visit(node)
  if (typeof node.type === 'function' && node.type !== IconStub) {
    let output
    try { output = node.type(node.props) } catch { output = null }
    if (output) walk(output, visit)
    return
  }
  walk(node.props.children, visit)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const tickTwice = async () => { await tick(); await tick(); await tick() }

// --- run ---------------------------------------------------------------------

(async () => {
  // Sanity: their real predicate does not recognise an absolute directory.
  assert.equal(isFolderRevealPath(CWD), false,
    'probe precondition: isFolderRevealPath should not treat an absolute dir as a reveal')

  const component = factories.get(PKG_ID)(requireStub)
  const ctx = makeCtx()
  component.apply(ctx)
  const header = ctx.registered[0]
  await tickTwice()

  const { tree } = render(header)
  let button
  walk(tree, (node) => { if (!button && node.type === 'button' && typeof node.props.onClick === 'function') button = node })
  assert.ok(button, 'the header button must render (gate open + cwd present)')

  await button.props.onClick()
  await tickTwice()

  const sidebarOpened = events.sidebarOpens.length
  const osOpened = events.osOpens.length
  console.log(`  intercepted calls -> sidebar editor : ${sidebarOpened}`)
  console.log(`  calls that reached the OS opener    : ${osOpened} ${JSON.stringify(events.osOpens.map((e) => e.via))}`)

  const problems = []
  if (sidebarOpened > 0) {
    problems.push(`directory was routed to the sidebar editor (${JSON.stringify(events.sidebarOpens[0])}) — this is the "is a directory" error the user saw`)
  }
  if (osOpened === 0) {
    problems.push('nothing ever reached a native opener: Windows Explorer would not open')
  }

  if (problems.length > 0) {
    console.log('\nFAIL — dsh-better-sidebar steals the open:')
    for (const problem of problems) console.log(`  - ${problem}`)
    console.log('\nfix: call an unshadowed route (connection.api.host.openPath -> host.openPath)')
    console.log('     instead of remote.session.openWorkspacePath, which better-sidebar shadows.')
    process.exit(1)
  }

  console.log('\nPASS — the open reached host.openNativePath and never entered the sidebar editor.')
  process.exit(0)
})().catch((error) => {
  console.log(`\nERROR: ${error && error.message}`)
  process.exit(1)
})
