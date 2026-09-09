// Behavioural harness for dsh-plugin-manager/src/client.js.
//
// Materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({ id, factory }) then factory(require) — with a
// minimal deps-aware React shim and a stateful fetch stub, then asserts:
//   1. the bundle registers id 'dsh-plugin-manager';
//   2. apply() registers the settings.section 'local-plugins' (order 16);
//   3. rendering the section fetches /list and shows one row per plugin with
//      the right state text + controls;
//   4. toggling posts set-enabled and shows a reload hint for client plugins
//      (never an automatic reload);
//   5. legacy rows show the migrate banner and migrate asks for confirmation.
//
// It is a LOGIC harness, not a browser render: real React reconciliation, CSS
// variables and layout are approximated. Real-browser checks are listed in
// ACCEPTANCE.md.
//
// Run: node dsh-plugin-manager/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-plugin-manager'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

const factories = new Map()
const fetchCalls = []
const confirms = []
let reloaded = false
const windowObj = {
  __DSH_TEST__: true,
  location: { reload: () => { reloaded = true } },
  confirm: (msg) => { confirms.push(msg); return true },
}
windowObj.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }
globalThis.window = windowObj
globalThis.document = { addEventListener() {}, removeEventListener() {} }

// Stateful server stub the bundle's `fetch` parameter talks to.
const state = {
  legacyDetected: false,
  plugins: [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ],
}
function payload() {
  return { ok: true, data: { repoRoot: 'D:/repo', profileName: 'web', legacyDetected: state.legacyDetected, plugins: state.plugins } }
}
async function fetchStub(url, opts) {
  fetchCalls.push({ url, opts })
  if (url === '/__dsh-plugin-manager/list') return { ok: true, json: async () => payload() }
  if (url === '/__dsh-plugin-manager/set-enabled') {
    const body = JSON.parse((opts && opts.body) || '{}')
    const p = state.plugins.find((x) => x.dir === body.dir)
    if (p) {
      p.active = body.enabled !== false
      p.state = p.active ? 'active' : 'disabled'
    }
    return { ok: true, json: async () => payload() }
  }
  if (url === '/__dsh-plugin-manager/remove') {
    const body = JSON.parse((opts && opts.body) || '{}')
    state.plugins = state.plugins.filter((x) => x.dir !== body.dir)
    return { ok: true, json: async () => payload() }
  }
  if (url === '/__dsh-plugin-manager/migrate') {
    state.legacyDetected = false
    state.plugins = state.plugins.map((p) => (p.state === 'legacy' ? { ...p, state: 'active', active: true, legacyBundle: false } : p))
    return { ok: true, json: async () => payload() }
  }
  return { ok: false, json: async () => ({ ok: false, error: 'not found' }) }
}

// --- minimal React shim ------------------------------------------------------

function sameDeps(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function makeReact() {
  let slots = []
  let index = 0
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
        const v = typeof next === 'function' ? next(slot.value) : next
        slot.value = v
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
  }
  return {
    React,
    begin() { index = 0 },
    fresh() { slots = []; index = 0 },
  }
}

const { React, begin, fresh } = makeReact()
function requireStub(specifier) {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', 'fetch', source)(
  globalThis.window, globalThis.navigator, globalThis.document, fetchStub,
)

const tests = []
const test = (name, fn) => tests.push([name, fn])

function factoryApi() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  return factory(requireStub)
}

// Mount helpers: get the section component via apply()/slots.
function mountSection() {
  const api = factoryApi()
  let registered = null
  let section = null
  const slots = {
    inject: (name, cb) => { registered = cb },
    register: (opts, comp) => { section = comp },
  }
  api.apply({ slots })
  assert.ok(registered, 'slots.inject called')
  registered(slots)
  assert.ok(section, 'section registered')
  return section
}

// Walking helpers.
function walk(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.__element) {
    if (pred(node)) out.push(node)
    const ch = node.props && node.props.children
    if (Array.isArray(ch)) for (const c of ch) walk(c, pred, out)
    else if (ch && typeof ch === 'object') walk(ch, pred, out)
  }
  return out
}
const byType = (tree, type) => walk(tree, (n) => n.type === type)
const textOf = (node) => {
  const parts = []
  const collect = (n) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return }
    if (n && n.__element) {
      const ch = n.props && n.props.children
      if (Array.isArray(ch)) ch.forEach(collect)
      else if (ch !== undefined && ch !== null) collect(ch)
    }
  }
  collect(node)
  return parts.join('')
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

// --- tests -------------------------------------------------------------------

test('bundle registers the settings.section (local-plugins, order 16)', () => {
  const api = factoryApi()
  assert.deepEqual(api.inject, ['slots'])
  let registered = null
  const entry = []
  const slots = {
    inject: (name, cb) => { registered = cb },
    register: (opts, comp) => entry.push({ opts, comp }),
  }
  api.apply({ slots })
  assert.equal(typeof registered, 'function', 'slots.inject callback captured')
  registered(slots)
  assert.equal(entry.length, 1)
  assert.equal(entry[0].opts.name, 'settings.section')
  assert.equal(entry[0].opts.id, 'local-plugins')
  assert.equal(entry[0].opts.order, 16)
  assert.equal(entry[0].opts.label(), '本地插件')
  assert.equal(typeof entry[0].comp, 'function')
})

test('renders plugin rows from /list with state text and no auto reload', async () => {
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const texts = textOf(tree)
  assert.match(texts, /dsh-aaa/)
  assert.match(texts, /dsh-bbb/)
  assert.match(texts, /dsh-bad/)
  assert.match(texts, /已激活/)
  assert.match(texts, /非插件目录/)
  assert.ok(fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/list'), 'list fetched on mount')
  assert.equal(reloaded, false, 'no automatic reload on plain render')
})

test('toggling a client plugin posts set-enabled and shows a reload hint (no auto reload)', async () => {
  fetchCalls.length = 0
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const switches = walk(tree, (n) => n.props && n.props.role === 'switch')
  assert.equal(switches.length, 2, 'one switch for aaa and bbb, none for the invalid row')
  const bbbEl = byType(tree, 'li').find((li) => /dsh-bbb/.test(textOf(li)))
  const bbbSwitch = walk(bbbEl, (n) => n.props && n.props.role === 'switch')[0]
  bbbSwitch.props.onClick()
  await flush()
  begin()
  const after = section()
  const setCalls = fetchCalls.filter((c) => c.url === '/__dsh-plugin-manager/set-enabled')
  assert.equal(setCalls.length, 1)
  assert.equal(JSON.parse(setCalls[0].opts.body).dir, 'dsh-bbb')
  assert.equal(JSON.parse(setCalls[0].opts.body).enabled, true)
  assert.match(textOf(after), /刷新页面使界面生效/, 'reload hint shown after client-plugin toggle')
  assert.equal(reloaded, false, 'no automatic reload after toggle')
})

test('legacy rows show migrate banner; migrate asks confirmation', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  state.legacyDetected = true
  state.plugins = [
    { dir: 'dsh-old', rowId: 'old', name: 'dsh-old', description: 'old', valid: true, hasClient: false, state: 'legacy', active: true, legacyBundle: true },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const texts = textOf(tree)
  assert.match(texts, /一键接管/, 'migrate banner visible when legacy detected')
  assert.match(texts, /旧布局/)
  const migrateBtn = byType(tree, 'button').find((b) => /一键接管/.test(textOf(b)))
  migrateBtn.props.onClick()
  await flush()
  assert.ok(confirms.length >= 1, 'migrate asks for confirmation')
  assert.ok(fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/migrate'), 'migrate endpoint called')
  assert.equal(reloaded, false, 'migrate does not auto-reload')
  // restore baseline state
  state.legacyDetected = false
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
})

test('pure helper exports map every state', () => {
  factoryApi()
  const t = windowObj.__dshPluginManagerTest
  assert.ok(t, 'test hooks exported')
  assert.equal(t.stateText('active'), '已激活')
  assert.equal(t.stateText('disabled'), '已停用')
  assert.equal(t.stateText('legacy'), '旧布局')
  assert.equal(t.stateText('uninstalled'), '未激活')
  assert.equal(t.stateText('inactive'), '未激活(仅依赖)')
  assert.equal(t.stateText('invalid'), '非插件目录')
  assert.equal(t.API, '/__dsh-plugin-manager')
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(e && e.stack ? e.stack : e)
  }
}
if (failed > 0) {
  console.error(`bundle tests: ${failed} failed`)
  process.exit(1)
}
console.log('bundle tests: PASS')
