// Behavioural harness for dsh-hindsight-model (host core + HTTP contract + panel).
//
// WHY THIS EXISTS
// Two halves need executing rather than eyeballing:
//
//   - the HOST core (src/host-core.js + src/index.js) is plain logic over an
//     injected deps object, so it can be driven with a virtual filesystem, a
//     fake command runner and a mock cordis ctx. The branch that matters most is
//     the one nobody can see by hand: whether a profile write survives, and
//     whether "applied" is only claimed when the process really restarted.
//   - the CLIENT half is a browser classic-script bundle with no build step, so
//     it is materialized the way @deepseek-ai/dsh-client-modules does —
//     window.__ModuleLoader__.load({id, factory}) then factory(require) — behind
//     a minimal hooks-aware React shim, then rendered far enough to assert the
//     four layers, the three field states and the button gating.
//
// It is a LOGIC harness, not a browser render. Real styling, the clipboard and
// real host round-trips are approximated; the parts that need a real browser are
// listed in ACCEPTANCE.md.
//
// Run: node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG_ID = 'dsh-hindsight-model'
const SECTION_ID = 'hindsight-model'

const core = await import(pathToFileURL(path.join(here, '..', 'src', 'host-core.js')).href)
const hostIndex = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- fixtures ---------------------------------------------------------------

const HINDSIGHT_HOME = 'C:\\fake\\.hindsight'
const CODING_AGENT_JSON = JSON.stringify({
  serverMode: 'daemon',
  apiPort: 9077,
  daemonProfile: 'coding-agent',
  embedVersion: 'latest',
  embedPackagePath: 'C:\\fake\\.hindsight\\embed-project',
})

/** A realistic profile: template comments, a blank line, then the live keys. */
const PROFILE_ENV = [
  '# Hindsight profile — generated, comments are part of the template',
  '# HINDSIGHT_API_LLM_PROVIDER=openai',
  '',
  'HINDSIGHT_API_LLM_PROVIDER=deepseek',
  'HINDSIGHT_API_LLM_API_KEY=codemaker-managed',
  'HINDSIGHT_API_LLM_MODEL=deepseek-flash',
  'HINDSIGHT_API_PORT=9077',
  'HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:15721/v1',
  'HF_ENDPOINT=https://hf-mirror.com',
  'HINDSIGHT_API_SOME_FUTURE_KEY=keep-me',
  '',
].join('\n')

/** Two startup blocks: the parser must take the LAST one. */
const PROFILE_LOG = [
  '2026-09-11 09:00:01 INFO Starting daemon',
  '2026-09-11 09:00:12 INFO OpenAI-compatible client initialized: provider=openai, model=gpt-4o-mini, base_url=https://api.openai.com/v1, reasoning_effort=not sent',
  '2026-09-11 09:00:13 INFO Verifying connection: openai/gpt-4o-mini',
  '2026-09-11 09:00:20 ERROR Connection failed: 401 unauthorized',
  '2026-09-12 18:55:50 INFO OpenAI-compatible client initialized: provider=deepseek, model=deepseek-flash, base_url=http://127.0.0.1:15721/v1, reasoning_effort=not sent',
  '2026-09-12 18:56:07 INFO Verifying connection: deepseek/deepseek-flash',
  '2026-09-12 18:56:11 INFO Connection verified: deepseek/deepseek-flash',
  '',
].join('\n')

const REG_QUERY_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    C:\\Windows',
  '    HINDSIGHT_API_LLM_API_KEY    REG_SZ    codemaker-managed',
  '    HINDSIGHT_API_LLM_MODEL    REG_SZ    deepseek-flash',
  '',
].join('\r\n')

const PROCESS_ENV = { HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' }

// --- virtual filesystem + fake deps -----------------------------------------

/** Windows paths reach the plugin with either separator; compare on one form. */
const normPath = (p) => String(p).replace(/\\/g, '/')

function makeVfs(files = {}, mtimes = {}) {
  const map = new Map(Object.entries(files).map(([key, text]) => [normPath(key), text]))
  const times = {}
  for (const [key, value] of Object.entries(mtimes)) times[normPath(key)] = value
  return {
    map,
    times,
    get: (p) => map.get(normPath(p)),
    has: (p) => map.has(normPath(p)),
    keys: () => [...map.keys()],
    readText: (p) => (map.has(normPath(p)) ? map.get(normPath(p)) : null),
    mtimeOf: (p) => (times[normPath(p)]
      ? new Date(times[normPath(p)])
      : (map.has(normPath(p)) ? new Date('2026-09-12T10:50:12Z') : null)),
    writeText: (p, text) => { map.set(normPath(p), String(text)) },
    removeFile: (p) => { map.delete(normPath(p)) },
    ensureDir: () => {},
    rename: (from, to) => {
      if (!map.has(normPath(from))) throw new Error(`ENOENT: ${from}`)
      map.set(normPath(to), map.get(normPath(from)))
      map.delete(normPath(from))
    },
    glob: (pattern) => [...map.keys()].filter((key) => key.startsWith(normPath(pattern).replace(/\*$/, ''))),
    timestamp: () => '2026-09-13T10-00-00-000Z',
    isoNow: () => '2026-09-13T10:00:00.000Z',
    run: async () => ({ ok: false, stdout: '', stderr: 'not faked in this test' }),
    httpGetJson: async () => { throw new Error('not faked') },
    env: {},
  }
}

/** Standard deps: profile + log + layout present, daemon listening since T. */
function makeDeps(overrides = {}) {
  const deps = makeVfs({
    [`${HINDSIGHT_HOME}\\coding-agent.json`]: CODING_AGENT_JSON,
    [`${HINDSIGHT_HOME}\\profiles\\coding-agent.env`]: PROFILE_ENV,
    [`${HINDSIGHT_HOME}\\profiles\\coding-agent.log`]: PROFILE_LOG,
  }, {
    [`${HINDSIGHT_HOME}\\profiles\\coding-agent.env`]: '2026-09-12T10:50:12Z',
  })
  deps.hindsightHome = HINDSIGHT_HOME
  const calls = []
  const userEnvOutput = overrides.userEnvOutput === undefined ? REG_QUERY_OUTPUT : overrides.userEnvOutput
  deps.run = async (args) => {
    calls.push(args)
    if (args[0] === 'reg' && args[1] === 'query') {
      return { ok: true, stdout: userEnvOutput, stderr: '' }
    }
    if (args[0] === 'powershell') {
      return { ok: true, stdout: '16280|2026-09-12T18:55:46.0000000+08:00', stderr: '' }
    }
    if (args[0] === 'reg' && args[1] === 'delete') {
      return { ok: true, stdout: 'The operation completed successfully.', stderr: '' }
    }
    return { ok: false, stdout: '', stderr: 'unexpected' }
  }
  deps.env = PROCESS_ENV
  deps.calls = calls
  return Object.assign(deps, overrides)
}

/** A mock cordis ctx exposing exactly the services the plugin reads. */
function makeCtx({ withWebServer = true, services = {}, slots = null } = {}) {
  const registered = []
  const effects = []
  const table = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'codemaker', model: 'deepseek-flash' }),
    },
    llm: {
      listProviders: () => [{ id: 'codemaker', name: 'Codemaker' }, { id: 'sense-nova', name: 'SenseNova' }],
      listConfigurableProviders: () => [
        { provider: 'codemaker', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'codemaker'] },
        { provider: 'sense-nova', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sense-nova'] },
      ],
    },
    settings: {
      get: (ns) => (ns === 'llm-pi-ai'
        ? { providers: { codemaker: { baseURL: 'http://127.0.0.1:15721/v1', apiKeyEnv: 'CODEMAKER_API_KEY' } } }
        : undefined),
    },
    credentials: {
      resolve: async (ref) => (ref === 'CODEMAKER_API_KEY' ? { value: 'sk-super-secret-value', source: 'CODEMAKER_API_KEY' } : undefined),
    },
    ...services,
  }
  const ctx = {
    effect: (fn) => { effects.push(fn); return fn() },
    inject: () => {},
    get: (key) => table[key],
    slots: slots || null,
    _registered: registered,
    _effects: effects,
  }
  if (withWebServer) {
    ctx.get = (key) => (key === 'webServer'
      ? { register: (route) => { registered.push(route); return () => {} } }
      : table[key])
  }
  return ctx
}

// --- fake req/res -----------------------------------------------------------

function makeReq(method, body) {
  const listeners = {}
  const req = {
    method,
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); return req },
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const fn of listeners.data || []) fn(Buffer.from(JSON.stringify(body)))
    }
    for (const fn of listeners.end || []) fn()
  })
  return req
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text || '' },
    json() { return JSON.parse(this.body) },
  }
}

async function callHandler(handler, method, body) {
  const res = makeRes()
  await handler(makeReq(method, body), res)
  return res
}

// --- minimal React shim (hooks + shallow render) -----------------------------

function makeReact() {
  const Fragment = Symbol('Fragment')
  let hookStates = []
  let hookCursor = 0
  let dirty = false
  let effectQueue = []

  const createElement = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
  })

  const depsChanged = (prev, deps) => !prev || !deps
    || deps.length !== prev.deps.length
    || deps.some((value, index) => !Object.is(value, prev.deps[index]))

  const api = {
    createElement,
    Fragment,
    useState(initial) {
      const index = hookCursor++
      if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
      return [hookStates[index], (next) => {
        hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next
        dirty = true
      }]
    },
    // Deps are honoured: a shim that re-runs effects on every render would
    // re-trigger the panel's load() and silently wipe an edit under test.
    useCallback(fn, deps) {
      const index = hookCursor++
      const prev = hookStates[index]
      const value = depsChanged(prev, deps) ? fn : prev.value
      hookStates[index] = { deps, value }
      return value
    },
    useMemo(fn, deps) {
      const index = hookCursor++
      const prev = hookStates[index]
      const value = depsChanged(prev, deps) ? fn() : prev.value
      hookStates[index] = { deps, value }
      return value
    },
    useEffect(fn, deps) {
      const index = hookCursor++
      const prev = hookStates[index]
      if (depsChanged(prev, deps)) effectQueue.push(fn)
      hookStates[index] = { deps, value: null }
    },
    useRef(initial) { const index = hookCursor++; if (!(index in hookStates)) hookStates[index] = { current: initial }; return hookStates[index] },
    __reset() { hookStates = []; hookCursor = 0; dirty = false; effectQueue = [] },
    __render(node) {
      hookCursor = 0
      dirty = false
      effectQueue = []
      const tree = renderNode(node, api)
      const effects = effectQueue.slice()
      effectQueue = []
      return { tree, effects, dirtyNow: () => dirty }
    },
  }
  return api
}

function renderNode(node, React) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node) }
  if (Array.isArray(node)) return { type: '#frag', children: node.map((child) => renderNode(child, React)) }
  if (node.type === React.Fragment) {
    return { type: '#frag', children: node.children.map((child) => renderNode(child, React)) }
  }
  if (typeof node.type === 'function') {
    return renderNode(node.type(node.props), React)
  }
  return { type: node.type, props: node.props, children: node.children.map((child) => renderNode(child, React)) }
}

function walk(node, visit) {
  if (!node) return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    if (node.type === '#text') parts.push(node.text)
    if (node.type === 'input') parts.push(String(node.props.value ?? ''))
    if (node.type === 'pre') {
      for (const child of node.children || []) walk(child, (inner) => { if (inner.type === '#text') parts.push(inner.text) })
    }
  })
  return parts.join(' ')
}

function findAll(tree, predicate) {
  const out = []
  walk(tree, (node) => { if (predicate(node)) out.push(node) })
  return out
}

const buttonsByText = (tree, label) => findAll(tree, (node) => node.type === 'button' && textOf({ ...node, children: node.children }).includes(label))

/** Mount a component, flushing effects until the tree stops changing. */
async function mount(element, React, { passes = 12 } = {}) {
  React.__reset()
  let tree = null
  for (let pass = 0; pass < passes; pass += 1) {
    const result = React.__render(element)
    tree = result.tree
    for (const effect of result.effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!result.dirtyNow() && pass > 0) break
  }
  return tree
}

// --- client bundle materialization ------------------------------------------

const factories = new Map()
globalThis.window = {
  __DSH_TEST__: true,
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  addEventListener() {},
  removeEventListener() {},
}
// Node 24 exposes `navigator` as a getter-only global, so redefine it.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

const bundleSource = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
const React = makeReact()
new Function('window', 'navigator', 'document', bundleSource)(globalThis.window, globalThis.navigator, {})
const clientFactory = factories.get(PKG_ID)
assert.ok(clientFactory, 'the bundle must register a factory under its package id')
const clientModule = clientFactory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
})
const clientTest = globalThis.window.__dshHindsightModelTest


// ============================================================================
// 2. pure functions
// ============================================================================

test('env parse: comments and blank lines never become keys', () => {
  const parsed = core.parseEnv(PROFILE_ENV)
  assert.equal(parsed.byKey.get('HINDSIGHT_API_LLM_MODEL'), 'deepseek-flash')
  assert.equal(parsed.byKey.has('# HINDSIGHT_API_LLM_PROVIDER'), false)
  assert.equal(parsed.entries.length, 7, 'seven live keys, the commented template line excluded')
  assert.equal(parsed.byKey.get('HINDSIGHT_API_SOME_FUTURE_KEY'), 'keep-me')
})

test('env merge: only the touched line changes, byte for byte', () => {
  const next = core.applyEnvChanges(PROFILE_ENV, { HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' })
  const before = PROFILE_ENV.split('\n')
  const after = next.split('\n')
  assert.equal(before.length, after.length)
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].startsWith('HINDSIGHT_API_LLM_MODEL=')) {
      assert.equal(after[i], 'HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash')
    } else {
      assert.equal(after[i], before[i], `line ${i} must be untouched`)
    }
  }
})

test('env merge: an absent key is appended, ordering of the rest preserved', () => {
  const next = core.applyEnvChanges(PROFILE_ENV, { HINDSIGHT_API_LLM_BASE_URL: 'http://example.test/v1', BRAND_NEW: 'x' })
  const nonEmpty = next.split('\n').filter((line) => line !== '')
  assert.equal(nonEmpty[nonEmpty.length - 1], 'BRAND_NEW=x', 'appended as the last live line')
  assert.ok(next.indexOf('HINDSIGHT_API_SOME_FUTURE_KEY=keep-me') < next.indexOf('BRAND_NEW=x'))
  assert.ok(next.endsWith('\n'), 'the trailing newline is not eaten')
})

test('env merge: null deletes the key line; CRLF and trailing newline survive', () => {
  const crlf = PROFILE_ENV.replace(/\n/g, '\r\n')
  const deleted = core.applyEnvChanges(crlf, { HINDSIGHT_API_LLM_API_KEY: null })
  assert.equal(deleted.includes('HINDSIGHT_API_LLM_API_KEY'), false)
  assert.ok(deleted.includes('\r\n'), 'CRLF style preserved')
  assert.equal(/\n(?<!\r\n)/.test(deleted), false, 'no bare LF introduced')
  const changed = core.applyEnvChanges(crlf, { HF_ENDPOINT: 'https://mirror.test' })
  assert.equal(changed.split('\r\n').filter((l) => l === 'HF_ENDPOINT=https://mirror.test').length, 1)
  assert.equal(changed.endsWith('\r\n'), true, 'trailing newline preserved')
})

test('env merge: values may contain = and stay unquoted', () => {
  const next = core.applyEnvChanges(PROFILE_ENV, { HINDSIGHT_API_LLM_BASE_URL: 'http://h/v1?a=b=c' })
  assert.ok(next.includes('HINDSIGHT_API_LLM_BASE_URL=http://h/v1?a=b=c'))
  const reparsed = core.parseEnv(next)
  assert.equal(reparsed.byKey.get('HINDSIGHT_API_LLM_BASE_URL'), 'http://h/v1?a=b=c')
})

test('log parse: the LAST startup block wins, with its own connectivity verdict', () => {
  const parsed = core.parseStartupLog(PROFILE_LOG)
  assert.equal(parsed.found, true)
  assert.equal(parsed.provider, 'deepseek')
  assert.equal(parsed.model, 'deepseek-flash')
  assert.equal(parsed.baseUrl, 'http://127.0.0.1:15721/v1')
  assert.equal(parsed.connected, true)
  assert.ok(parsed.line > 3, 'must come from the later block')
})

test('log parse: a failed connection in the last block is reported as false', () => {
  const parsed = core.parseStartupLog([
    'INFO OpenAI-compatible client initialized: provider=x, model=y, base_url=z',
    'INFO Verifying connection: x/y',
    'ERROR Connection failed: boom',
  ].join('\n'))
  assert.equal(parsed.connected, false)
})

test('log parse: missing log / no startup block are both "not found", never invented', () => {
  assert.equal(core.parseStartupLog(null).found, false)
  assert.equal(core.parseStartupLog('').found, false)
  assert.equal(core.parseStartupLog('INFO daemon booting\nINFO ready').found, false)
})

test('conflicts: two outer sources stay separate and only real differences count', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const result = core.computeConflicts({
    keys: core.MANAGED_KEYS,
    profileMap,
    userEnv: { HINDSIGHT_API_LLM_MODEL: 'deepseek-flash', HINDSIGHT_API_LLM_PROVIDER: 'openai' },
    processEnv: { HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' },
  })
  assert.deepEqual(result.userLevel.map((c) => c.key), ['HINDSIGHT_API_LLM_PROVIDER'], 'same value is not a conflict')
  assert.deepEqual(result.processLevel.map((c) => c.key), ['HINDSIGHT_API_LLM_MODEL'])
})

test('conflicts: a secret is described by length, never by value', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const result = core.computeConflicts({
    keys: core.MANAGED_KEYS,
    profileMap,
    userEnv: { HINDSIGHT_API_LLM_API_KEY: 'a-much-longer-outer-key' },
    processEnv: {},
  })
  const hit = result.userLevel.find((c) => c.key === 'HINDSIGHT_API_LLM_API_KEY')
  assert.ok(hit)
  assert.equal(hit.outer.secret, true)
  assert.equal(JSON.stringify(result).includes('a-much-longer-outer-key'), false, 'plaintext must not appear')
})

test('applied judgement: strictly later start wins; equal counts as NOT applied', () => {
  const mtime = new Date('2026-09-12T10:50:12Z')
  assert.equal(core.isEffectivelyApplied(new Date('2026-09-12T10:55:46Z'), mtime).applied, true)
  assert.equal(core.isEffectivelyApplied(new Date('2026-09-12T10:40:00Z'), mtime).applied, false)
  assert.equal(core.isEffectivelyApplied(mtime, mtime).applied, false, 'same instant ⇒ not proven')
  assert.deepEqual(core.isEffectivelyApplied(null, mtime), { known: false, applied: false, reason: 'daemon-not-running' })
  assert.deepEqual(core.isEffectivelyApplied(new Date(), null), { known: false, applied: false, reason: 'env-missing' })
})

test('restart command: values come from the caller and conflicts are cleared first', () => {
  const command = core.buildRestartCommand({
    daemonProfile: 'my-profile',
    embedPackagePath: 'C:\\somewhere\\embed',
    conflictKeys: ['HINDSIGHT_API_LLM_MODEL', 'HINDSIGHT_API_LLM_API_KEY'],
  })
  const lines = command.split('\n')
  assert.ok(lines[0].startsWith('Remove-Item '), 'cleanup must precede any daemon call')
  assert.ok(lines[0].includes('Env:HINDSIGHT_API_LLM_API_KEY') && lines[0].includes('Env:HINDSIGHT_API_LLM_MODEL'))
  assert.ok(command.includes('--profile my-profile'))
  assert.ok(command.includes('--directory "C:\\somewhere\\embed"'))
  assert.ok(command.indexOf(' stop') < command.indexOf(' start'))
  assert.equal(core.buildRestartCommand({ daemonProfile: null, embedPackagePath: 'x', conflictKeys: [] }), null)
})

test('restart command: no conflicts still yields a usable restart', () => {
  const command = core.buildRestartCommand({ daemonProfile: 'p', embedPackagePath: 'd', conflictKeys: [] })
  assert.equal(command.split('\n').length, 2)
  assert.equal(command.includes('Remove-Item'), false)
})

test('reg query and daemon probe parsing', () => {
  const env = core.parseRegQuery(REG_QUERY_OUTPUT)
  assert.equal(env.HINDSIGHT_API_LLM_MODEL, 'deepseek-flash')
  assert.equal(env.Path, 'C:\\Windows')
  const probe = core.parseDaemonProbe('16280|2026-09-12T18:55:46.0000000+08:00')
  assert.equal(probe.pid, 16280)
  assert.equal(probe.startTime instanceof Date, true)
  assert.deepEqual(core.parseDaemonProbe(''), { pid: null, startTime: null })
})

test('change validation: unknown keys, non-strings and newlines are all rejected', () => {
  assert.equal(core.validateChanges({ HINDSIGHT_API_LLM_MODEL: 'x' }).ok, true)
  assert.equal(core.validateChanges({ HINDSIGHT_API_LLM_MODEL: null }).ok, true)
  assert.equal(core.validateChanges({ SOMETHING_ELSE: 'x' }).ok, false)
  assert.equal(core.validateChanges({ HINDSIGHT_API_LLM_MODEL: 42 }).ok, false)
  assert.equal(core.validateChanges({ HINDSIGHT_API_LLM_MODEL: 'a\nb' }).ok, false)
  assert.equal(core.validateChanges({}).ok, false)
})

test('field defaults are declared for the keys that have one', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  assert.equal(core.defaultValueOf('HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL', profileMap), 'BAAI/bge-small-en-v1.5')
  assert.equal(core.defaultValueOf('HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT', profileMap), '0')
  assert.equal(core.defaultValueOf('HINDSIGHT_API_LLM_MODEL', profileMap), 'deepseek-v4-flash', 'from the deepseek provider default')
  assert.equal(core.defaultValueOf('HINDSIGHT_API_RETAIN_LLM_MODEL', profileMap), null, 'no invented default')
})

// ============================================================================
// 3-4. root layer reading + writing
// ============================================================================

test('layout: missing or unparseable coding-agent.json degrades instead of throwing', () => {
  const missing = core.createCore(makeDeps({ readText: () => null }))
  assert.equal(missing.readLayout().ok, false)
  const broken = core.createCore(makeVfs({ [`${HINDSIGHT_HOME}\\coding-agent.json`]: '{not json' }))
  assert.equal(broken.readLayout().ok, false)
  const ok = core.createCore(makeDeps())
  assert.deepEqual(
    { p: ok.readLayout().daemonProfile, port: ok.readLayout().apiPort },
    { p: 'coding-agent', port: 9077 },
  )
})

test('layer ①: the live keys are read from the file, unknown keys preserved', () => {
  const impl = core.createCore(makeDeps())
  const layer = impl.readProfileLayer(impl.readLayout())
  assert.equal(layer.known, true)
  assert.equal(layer.parsed.byKey.get('HINDSIGHT_API_LLM_BASE_URL'), 'http://127.0.0.1:15721/v1')
  assert.equal(layer.parsed.byKey.get('HINDSIGHT_API_SOME_FUTURE_KEY'), 'keep-me')
})

test('layer ②: the runtime layer reports the last startup block', () => {
  const impl = core.createCore(makeDeps())
  const layer = impl.readRuntimeLayer(impl.readLayout())
  assert.equal(layer.known, true)
  assert.equal(layer.startup.model, 'deepseek-flash')
  assert.equal(layer.startup.connected, true)
})

test('layer ②: a log without a startup block is unknown, not guessed', () => {
  const base = makeDeps()
  const originalReadText = base.readText
  const impl = core.createCore(Object.assign(base, {
    readText: (p) => (normPath(p).endsWith('.log') ? 'INFO daemon booting\nINFO ready' : originalReadText(p)),
  }))
  const layer = impl.readRuntimeLayer(impl.readLayout())
  assert.equal(layer.known, false)
  assert.equal(layer.reason, 'no-startup-block')
})

test('layer ④: a listener PID gives StartTime; no listener is unknown', async () => {
  const impl = core.createCore(makeDeps())
  const probe = await impl.readDaemonProbe(9077)
  assert.equal(probe.pid, 16280)
  const idle = core.createCore(makeDeps({ run: async () => ({ ok: true, stdout: '', stderr: '' }) }))
  const none = await idle.readDaemonProbe(9077)
  assert.equal(none.known, false)
  assert.equal(none.reason, 'daemon-not-running')
})

test('collectState: four layers, masked secrets and three distinct field states', async () => {
  const impl = core.createCore(makeDeps())
  const state = await impl.collectState()
  assert.equal(state.layers.profile.known, true)
  assert.equal(state.layers.runtime.known, true)
  assert.equal(state.layers.applied.applied, true)
  assert.equal(state.layers.applied.basis, 'values', 'the file/process triple agreement is the primary evidence')
  assert.deepEqual(state.layers.applied.mismatched, [])
  const byKey = Object.fromEntries(state.fields.map((f) => [f.key, f]))
  // The machine's real shape: user-level HKCU agrees with the file, and it is
  // the HOST PROCESS env that disagrees — so that is the reported conflict.
  assert.deepEqual(state.layers.conflicts.userLevel, [], 'HKCU agrees with the file, so it is not a conflict')
  assert.deepEqual(state.layers.conflicts.processLevel.map((c) => c.key), ['HINDSIGHT_API_LLM_MODEL'])
  assert.equal(byKey.HINDSIGHT_API_LLM_MODEL.state, 'overridden', 'the process env wins over the file on next start')
  assert.equal(byKey.HINDSIGHT_API_LLM_PROVIDER.state, 'set')
  assert.equal(byKey.HINDSIGHT_API_RETAIN_LLM_MODEL.state, 'unset')
  assert.equal(byKey.HINDSIGHT_API_RETAIN_LLM_MODEL.fallback, null)
  const secret = state.layers.profile.entries.find((e) => e.key === 'HINDSIGHT_API_LLM_API_KEY')
  assert.deepEqual(secret.value, { secret: true, length: 17 })
  assert.equal(JSON.stringify(state).includes('codemaker-managed'), false, 'the key value itself must not be serialized')
})

test('judgeApplied: the running process read the same triple ⇒ applied, even if the file is newer', () => {
  // The real-machine shape measured 2026-09-13: file 18:56:29, process 18:55:46,
  // both saying deepseek/deepseek-flash. A timing-only rule would cry wolf.
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const startup = { found: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:15721/v1' }
  const verdict = core.judgeApplied({
    profileMap,
    startup,
    startTime: new Date('2026-09-12T10:55:46Z'),
    envMtime: new Date('2026-09-12T10:56:29Z'),
  })
  assert.equal(verdict.applied, true)
  assert.equal(verdict.reason, 'consistent')
  assert.equal(verdict.basis, 'values')
  assert.equal(verdict.rewrittenAfterStart, true, 'the timing facet is still reported, as a caveat')
})

test('judgeApplied: a differing field is named, and the verdict is not applied', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const verdict = core.judgeApplied({
    profileMap,
    startup: { found: true, provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:15721/v1' },
    startTime: new Date('2026-09-12T10:55:46Z'),
    envMtime: new Date('2026-09-12T10:50:12Z'),
  })
  assert.equal(verdict.applied, false)
  assert.equal(verdict.reason, 'mismatch')
  assert.deepEqual(verdict.mismatched, ['model'])
  assert.equal(verdict.runtime.model, 'deepseek-v4-flash')
})

test('judgeApplied: a field the log never carried is not counted as a disagreement', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const verdict = core.judgeApplied({
    profileMap,
    startup: { found: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl: null },
    startTime: new Date('2026-09-12T10:55:46Z'),
    envMtime: new Date('2026-09-12T10:50:12Z'),
  })
  assert.equal(verdict.applied, true)
  assert.deepEqual(verdict.mismatched, [])
})

test('judgeApplied: with no startup block it falls back to timing and says so', () => {
  const profileMap = core.parseEnv(PROFILE_ENV).byKey
  const stale = core.judgeApplied({
    profileMap,
    startup: { found: false },
    startTime: new Date('2026-09-12T10:40:00Z'),
    envMtime: new Date('2026-09-12T10:50:12Z'),
  })
  assert.equal(stale.basis, 'timing')
  assert.equal(stale.applied, false)
  assert.equal(stale.reason, 'stale')
  const fresh = core.judgeApplied({
    profileMap,
    startup: null,
    startTime: new Date('2026-09-12T10:55:46Z'),
    envMtime: new Date('2026-09-12T10:50:12Z'),
  })
  assert.equal(fresh.applied, true)
  assert.equal(fresh.runtimeKnown, false, 'the fallback must not pretend it saw the process values')
})

test('collectState: a daemon that is not running makes layers ② and ④ unknown', async () => {
  const impl = core.createCore(makeDeps({ run: async (args) => (args[0] === 'reg'
    ? { ok: true, stdout: REG_QUERY_OUTPUT, stderr: '' }
    : { ok: true, stdout: '', stderr: '' }) }))
  const state = await impl.collectState()
  assert.equal(state.layers.runtime.known, false, 'a log on disk is history, not current state')
  assert.equal(state.layers.runtime.reason, 'daemon-not-running')
  assert.equal(state.layers.applied.known, false)
  assert.equal(state.layers.applied.reason, 'daemon-not-running')
})

test('save: backs up first, rewrites only the touched line, keeps a future key', () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = impl.save({ HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' })
  assert.equal(result.ok, true)
  const envPath = `${HINDSIGHT_HOME}\\profiles\\coding-agent.env`
  assert.equal(deps.get(result.backupPath), PROFILE_ENV, 'backup holds the pre-write bytes')
  const after = deps.get(envPath)
  assert.ok(after.includes('HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash'))
  assert.ok(after.includes('# Hindsight profile — generated, comments are part of the template'))
  assert.ok(after.includes('HINDSIGHT_API_SOME_FUTURE_KEY=keep-me'))
  assert.equal(deps.has(`${envPath}.tmp-2026-09-13T10-00-00-000Z`), false, 'the temp file is renamed away')
})

test('save: a write failure rolls the file back to the backup', () => {
  const deps = makeDeps()
  const envPath = `${HINDSIGHT_HOME}\\profiles\\coding-agent.env`
  const impl = core.createCore(Object.assign(deps, {
    rename: () => { throw new Error('EACCES: rename blocked') },
  }))
  const result = impl.save({ HINDSIGHT_API_LLM_MODEL: 'nope' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'write-failed')
  assert.equal(deps.get(envPath), PROFILE_ENV, 'content restored')
  assert.equal(result.backupPath && deps.get(result.backupPath), PROFILE_ENV)
})

test('save: unmanaged keys are refused before anything is written', () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = impl.save({ TOTALLY_NOT_OURS: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-changes')
  assert.equal(deps.keys().some((k) => k.includes('.bak-')), false, 'no backup for a refused write')
})

test('save: null removes a key without disturbing its neighbours', () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  impl.save({ HINDSIGHT_API_RETAIN_LLM_MODEL: null })
  const after = deps.get(`${HINDSIGHT_HOME}\\profiles\\coding-agent.env`)
  assert.equal(after.includes('HINDSIGHT_API_RETAIN_LLM_MODEL'), false)
  assert.equal(after, PROFILE_ENV, 'deleting an absent key is a no-op')
})

test('verify: names the differing fields instead of a bare "not applied"', async () => {
  const base = makeDeps()
  const originalReadText = base.readText
  const impl = core.createCore(Object.assign(base, {
    readText: (p) => (normPath(p).endsWith('.log')
      ? 'INFO OpenAI-compatible client initialized: provider=deepseek, model=deepseek-v4-flash, base_url=http://127.0.0.1:15721/v1'
      : originalReadText(p)),
  }))
  const result = await impl.verify()
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'mismatch')
  assert.deepEqual(result.mismatched, ['model'])
  assert.equal(result.file.model, 'deepseek-flash')
  assert.equal(result.runtime.model, 'deepseek-v4-flash')
})

test('verify: the measured real-machine shape is reported as applied', async () => {
  // file newer than the process (upstream rewrote it) but the same values ⇒ applied.
  const deps = makeDeps({ mtimeOf: (p) => (normPath(p).endsWith('.env') ? new Date('2026-09-12T10:56:29Z') : null) })
  deps.httpGetJson = async (url) => (url.endsWith('/banks')
    ? { banks: [{ bank_id: 'coding-agent::demo' }] }
    : { requests: [{ provider: 'deepseek', model: 'deepseek-flash', operation: 'retain', status: 'success' }] })
  const impl = core.createCore(deps)
  const result = await impl.verify()
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'consistent')
  assert.equal(result.basis, 'values')
  assert.equal(result.rewrittenAfterStart, true, 'the caveat is still surfaced')
  assert.equal(result.runtime.model, 'deepseek-flash')
  assert.equal(result.requests[0].status, 'success')
})

test('verify: no LLM-call lookup is attempted when the verdict is "not applied"', async () => {
  let probed = false
  const deps = makeDeps({
    run: async (args) => (args[0] === 'reg'
      ? { ok: true, stdout: REG_QUERY_OUTPUT, stderr: '' }
      : { ok: true, stdout: '16280|2026-09-12T10:40:00.0000000+08:00', stderr: '' }),
  })
  deps.httpGetJson = async () => { probed = true; return {} }
  const base = makeDeps()
  const impl = core.createCore(Object.assign(deps, {
    readText: (p) => (normPath(p).endsWith('.log') ? 'INFO nothing' : base.readText(p)),
  }))
  const result = await impl.verify()
  assert.equal(result.applied, false)
  assert.equal(result.basis, 'timing')
  assert.equal(probed, false, 'nothing to confirm, so nothing is queried')
})

// ============================================================================
// 5. DSH side
// ============================================================================

test('dsh: the default selection is read through the service method', async () => {
  const reader = hostIndex.createDshReader(makeCtx())
  assert.deepEqual(reader.currentSelection(), { provider: 'codemaker', model: 'deepseek-flash', reasoningEffort: null })
  const snapshot = await reader.snapshot()
  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.missing, [])
})

test('dsh: baseURL is reached by drilling settingsPath, never by enumerating providers', () => {
  const reader = hostIndex.createDshReader(makeCtx())
  const route = reader.routeOf('codemaker')
  assert.equal(route.baseURL, 'http://127.0.0.1:15721/v1')
  assert.equal(route.apiKeyEnv, 'CODEMAKER_API_KEY')
  assert.equal(reader.routeOf('not-registered'), null)
})

test('dsh: a missing drill-down path yields null rather than throwing', () => {
  const ctx = makeCtx({ services: { llm: { listConfigurableProviders: () => [{ provider: 'x', settingsNs: 'nope', settingsPath: ['a', 'b'] }] } } })
  const reader = hostIndex.createDshReader(ctx)
  assert.equal(reader.routeOf('x'), null)
})

test('dsh: the key is resolvable host-side but never appears in the snapshot', async () => {
  const reader = hostIndex.createDshReader(makeCtx())
  const resolved = await reader.resolveApiKey()
  assert.equal(resolved.value, 'sk-super-secret-value', 'host-side resolution works')
  const snapshot = JSON.stringify(await reader.snapshot())
  assert.equal(snapshot.includes('sk-super-secret-value'), false, 'plaintext must not be serialized')
  const meta = await reader.keyMetadata()
  assert.deepEqual(meta, { hasValue: true, length: 21, source: 'CODEMAKER_API_KEY' })
})

test('dsh: missing services degrade to available:false with the gap named', async () => {
  const ctx = makeCtx({ services: { credentials: undefined, llm: undefined } })
  const reader = hostIndex.createDshReader(ctx)
  const snapshot = await reader.snapshot()
  assert.equal(snapshot.available, false)
  assert.deepEqual(snapshot.missing, ['llm', 'credentials'])
  assert.equal(snapshot.selection.provider, 'codemaker', 'the parts that DO resolve still come through')
})

// ============================================================================
// 6. cleaning user-level conflicts
// ============================================================================

test('cleanEnv: the export must succeed before anything is deleted', async () => {
  const deps = makeDeps({
    userEnvOutput: [
      'HKEY_CURRENT_USER\\Environment',
      '    HINDSIGHT_API_LLM_MODEL    REG_SZ    deepseek-v4-flash',
      '',
    ].join('\r\n'),
    writeText: () => { throw new Error('EACCES: read-only') },
  })
  const impl = core.createCore(deps)
  const result = await impl.cleanEnv({})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'export-failed')
  assert.equal(deps.calls.some((args) => args[1] === 'delete'), false, 'no deletion without a backup')
})

test('cleanEnv: nothing to clean is a no-op, not an empty backup file', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = await impl.cleanEnv({})
  assert.deepEqual(result, { ok: true, removed: [], backupPath: null })
  assert.equal(deps.calls.some((args) => args[1] === 'delete'), false)
})

test('cleanEnv: exports the values, then deletes only the conflicting keys', async () => {
  // A user-level value that disagrees with the file — the case worth cleaning.
  const deps = makeDeps({
    userEnvOutput: [
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    C:\\Windows',
      '    HINDSIGHT_API_LLM_MODEL    REG_SZ    deepseek-v4-flash',
      '    HINDSIGHT_API_LLM_API_KEY    REG_SZ    codemaker-managed',
      '',
    ].join('\r\n'),
  })
  const impl = core.createCore(deps)
  const result = await impl.cleanEnv({})
  assert.equal(result.ok, true)
  assert.deepEqual(result.removed, ['HINDSIGHT_API_LLM_MODEL'], 'only the disagreeing key is touched')
  const payload = JSON.parse(deps.get(result.backupPath))
  assert.equal(payload.scope, 'HKCU\\Environment')
  assert.equal(payload.keys.HINDSIGHT_API_LLM_MODEL, 'deepseek-v4-flash')
  const deletions = deps.calls.filter((args) => args[1] === 'delete').map((args) => args[4])
  assert.deepEqual(deletions, ['HINDSIGHT_API_LLM_MODEL'])
  assert.ok(result.backupPath.includes('/backups/hkcuenv-'), 'the export lands in the backups directory')
})

// ============================================================================
// 7. HTTP contract
// ============================================================================

test('routes: apply() registers exactly the five exact routes', () => {
  const ctx = makeCtx()
  hostIndex.apply(ctx)
  assert.equal(ctx._registered.length, 5)
  assert.deepEqual(ctx._registered.map((r) => r.path).sort(), Object.values(hostIndex.ROUTES).sort())
  assert.deepEqual([...new Set(ctx._registered.map((r) => r.kind))], ['exact'])
  assert.equal(ctx._effects.length, 5, 'every registration is wrapped in ctx.effect')
})

test('routes: a host without webServer never blows up apply()', () => {
  const ctx = makeCtx({ withWebServer: false })
  assert.doesNotThrow(() => hostIndex.apply(ctx))
  assert.equal(ctx._registered.length, 0)
})

test('endpoint contract: wrong method is 405 JSON, bad body is 400', async () => {
  const impl = core.createCore(makeDeps())
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const state = await callHandler(handlers[hostIndex.ROUTES.state], 'POST', {})
  assert.equal(state.status, 405)
  assert.match(state.headers['content-type'], /application\/json/)
  const verify = await callHandler(handlers[hostIndex.ROUTES.verify], 'POST', {})
  assert.equal(verify.status, 200)
  const clean = await callHandler(handlers[hostIndex.ROUTES.cleanEnv], 'POST', {})
  assert.equal(clean.status, 400, 'deleting env vars needs an explicit confirmation')
  assert.equal(clean.json().error, 'confirmation required')
})

test('endpoint contract: an unmanaged key is 400, a managed one is written', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const rejected = await callHandler(handlers[hostIndex.ROUTES.save], 'POST', { changes: { NOT_OURS: 'x' } })
  assert.equal(rejected.status, 400)
  const accepted = await callHandler(handlers[hostIndex.ROUTES.save], 'POST', { changes: { HINDSIGHT_API_LLM_MODEL: 'm2' } })
  assert.equal(accepted.status, 200)
  assert.ok(deps.get(`${HINDSIGHT_HOME}\\profiles\\coding-agent.env`).includes('HINDSIGHT_API_LLM_MODEL=m2'))
})

test('endpoint contract: useDshKey writes the resolved key without ever echoing it', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const res = await callHandler(handlers[hostIndex.ROUTES.save], 'POST', { changes: {}, useDshKey: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.includes('sk-super-secret-value'), false, 'the response must not carry the plaintext')
  assert.ok(deps.get(`${HINDSIGHT_HOME}\\profiles\\coding-agent.env`).includes('HINDSIGHT_API_LLM_API_KEY=sk-super-secret-value'))
})

test('endpoint contract: /state and /dsh-model never serialize a plaintext key', async () => {
  const impl = core.createCore(makeDeps())
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  for (const route of [hostIndex.ROUTES.state, hostIndex.ROUTES.dshModel]) {
    const res = await callHandler(handlers[route], 'GET')
    assert.equal(res.status, 200)
    assert.equal(res.body.includes('sk-super-secret-value'), false, `${route} leaked the key`)
    assert.equal(res.body.includes('codemaker-managed'), false, `${route} leaked the profile key`)
  }
})

// ============================================================================
// 8. the settings panel
// ============================================================================

const PANEL_STATE = {
  ok: true,
  layout: { ok: true, daemonProfile: 'coding-agent', apiPort: 9077, embedPackagePath: 'C:\\fake\\embed' },
  layers: {
    profile: {
      known: true,
      path: 'C:\\fake\\.hindsight\\profiles\\coding-agent.env',
      mtime: '2026-09-12T18:50:12.000Z',
      entries: [
        { key: 'HINDSIGHT_API_LLM_PROVIDER', value: { secret: false, value: 'deepseek' } },
        { key: 'HINDSIGHT_API_LLM_API_KEY', value: { secret: true, length: 17 } },
      ],
    },
    runtime: { known: true, provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:15721/v1', connected: true },
    conflicts: {
      userLevelKnown: true,
      userLevel: [{ key: 'HINDSIGHT_API_LLM_PROVIDER', outer: { secret: false, value: 'openai' }, onDisk: { secret: false, value: 'deepseek' } }],
      processLevel: [{ key: 'HINDSIGHT_API_LLM_MODEL', outer: { secret: false, value: 'deepseek-v4-flash' }, onDisk: { secret: false, value: 'deepseek-flash' } }],
    },
    applied: { known: true, applied: true, pid: 16280, startTime: '2026-09-12T18:55:46.000Z', envMtime: '2026-09-12T18:50:12.000Z' },
  },
  fields: [
    { key: 'HINDSIGHT_API_LLM_PROVIDER', state: 'overridden', onDisk: { secret: false, value: 'deepseek' }, fallback: 'openai' },
    { key: 'HINDSIGHT_API_LLM_MODEL', state: 'overridden', onDisk: { secret: false, value: 'deepseek-flash' }, fallback: 'deepseek-v4-flash' },
    { key: 'HINDSIGHT_API_LLM_BASE_URL', state: 'set', onDisk: { secret: false, value: 'http://127.0.0.1:15721/v1' }, fallback: null },
    { key: 'HINDSIGHT_API_LLM_API_KEY', state: 'set', onDisk: { secret: true, length: 17 }, fallback: null },
    { key: 'HINDSIGHT_API_RETAIN_LLM_MODEL', state: 'unset', onDisk: null, fallback: null },
    { key: 'HINDSIGHT_API_REFLECT_LLM_MODEL', state: 'unset', onDisk: null, fallback: null },
    { key: 'HINDSIGHT_API_EMBEDDINGS_PROVIDER', state: 'unset', onDisk: null, fallback: 'local' },
    { key: 'HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL', state: 'unset', onDisk: null, fallback: 'BAAI/bge-small-en-v1.5' },
    { key: 'HINDSIGHT_API_RERANKER_PROVIDER', state: 'unset', onDisk: null, fallback: 'local' },
    { key: 'HINDSIGHT_API_RERANKER_LOCAL_MODEL', state: 'unset', onDisk: null, fallback: 'cross-encoder/ms-marco-MiniLM-L-6-v2' },
    { key: 'HINDSIGHT_API_PORT', state: 'set', onDisk: { secret: false, value: '9077' }, fallback: null },
    { key: 'HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT', state: 'unset', onDisk: null, fallback: '0' },
    { key: 'HF_ENDPOINT', state: 'set', onDisk: { secret: false, value: 'https://hf-mirror.com' }, fallback: null },
  ],
  groups: core.KEY_GROUPS,
  restart: { command: 'Remove-Item Env:HINDSIGHT_API_LLM_PROVIDER -ErrorAction SilentlyContinue\nuv run --directory "C:\\fake\\embed" hindsight-embed daemon --profile coding-agent stop\nuv run --directory "C:\\fake\\embed" hindsight-embed daemon --profile coding-agent start', conflictKeys: ['HINDSIGHT_API_LLM_PROVIDER', 'HINDSIGHT_API_LLM_MODEL'] },
  backups: ['C:\\fake\\.hindsight\\profiles\\coding-agent.env.bak-2026-09-13T10-00-00-000Z'],
  dsh: {
    available: true,
    missing: [],
    selection: { provider: 'codemaker', model: 'deepseek-flash', reasoningEffort: null },
    route: { baseURL: 'http://127.0.0.1:15721/v1', apiKeyEnv: 'CODEMAKER_API_KEY' },
    key: { hasValue: true, length: 21, source: 'CODEMAKER_API_KEY' },
    providers: [],
  },
}

function stubFetch(state, { dshModel } = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    const body = url.endsWith('/dsh-model') ? { ok: true, dsh: dshModel || state.dsh } : state
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

test('panel: registers one settings.section at order 17 between 16 and 18', () => {
  let registration = null
  const ctx = {
    slots: {
      inject: (name, fn) => { assert.equal(name, 'settings.section'); fn() },
      register: (meta, Component) => { registration = { meta, Component } },
    },
  }
  clientModule.apply(ctx)
  assert.equal(registration.meta.id, SECTION_ID)
  assert.equal(registration.meta.order, 17)
  assert.equal(typeof registration.meta.label, 'function')
  assert.equal(typeof registration.Component, 'function')
  assert.deepEqual(clientModule.inject, ['slots'])
})

test('panel helpers: a secret is shown as a mask, never as a value', () => {
  assert.equal(clientTest.renderValue({ secret: true, length: 17 }), '••••••••••(17)')
  assert.equal(clientTest.renderValue({ secret: false, value: 'deepseek' }), 'deepseek')
  assert.equal(clientTest.renderValue(null), '—')
})

test('panel helpers: the three field states are visibly distinct', () => {
  const labels = ['set', 'unset', 'overridden'].map((s) => clientTest.stateBadge(s).text)
  assert.equal(new Set(labels).size, 3, labels.join('/'))
})

test('panel helpers: the draft seeds from disk but leaves secrets empty', () => {
  const draft = clientTest.draftFromState(PANEL_STATE)
  assert.equal(draft.HINDSIGHT_API_LLM_MODEL, 'deepseek-flash')
  assert.equal(draft.HINDSIGHT_API_LLM_API_KEY, '', 'a secret is never sent back to the browser')
  assert.equal(draft.HINDSIGHT_API_RETAIN_LLM_MODEL, '')
})

test('panel helpers: the save body carries only real changes, empty means delete', () => {
  const baseline = clientTest.draftFromState(PANEL_STATE)
  assert.equal(clientTest.hasPendingChanges({ draft: baseline, baseline, secretDraft: '', useDshKey: false }), false)
  const edited = { ...baseline, HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' }
  const body = clientTest.buildSaveBody({ draft: edited, baseline, secretDraft: '', useDshKey: false })
  assert.deepEqual(body.changes, { HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash' })
  const cleared = { ...baseline, HF_ENDPOINT: '' }
  assert.deepEqual(clientTest.buildSaveBody({ draft: cleared, baseline, secretDraft: '', useDshKey: false }).changes, { HF_ENDPOINT: null })
})

test('panel helpers: useDshKey sends NO key material at all', () => {
  const baseline = clientTest.draftFromState(PANEL_STATE)
  const body = clientTest.buildSaveBody({ draft: baseline, baseline, secretDraft: 'typed-anyway', useDshKey: true })
  assert.deepEqual(body, { changes: {}, useDshKey: true })
  assert.equal(JSON.stringify(body).includes('typed-anyway'), false)
  const typed = clientTest.buildSaveBody({ draft: baseline, baseline, secretDraft: 'sk-typed', useDshKey: false })
  assert.equal(typed.changes.HINDSIGHT_API_LLM_API_KEY, 'sk-typed', 'typing a key is how you set one')
})

test('panel render: all four layers and both conflict groups are on screen', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  for (const marker of ['① 权威落盘', '② 运行中实际生效', '③ 冲突源', '④ 生效判据']) {
    assert.ok(text.includes(marker), `missing layer heading: ${marker}`)
  }
  assert.ok(text.includes('用户级环境变量'), 'user-level conflict group')
  assert.ok(text.includes('宿主进程环境变量'), 'process-level conflict group')
  assert.ok(text.includes('本插件清不掉'), 'the capability boundary is stated')
  assert.ok(text.includes('••••••••••(17)'), 'the secret is masked on screen')
  assert.ok(text.includes('未设 → 回落默认：BAAI/bge-small-en-v1.5'), 'an unset vector key names its fallback')
  const pre = findAll(tree, (node) => node.type === 'pre')
  assert.equal(pre.length, 1)
  assert.ok(textOf(pre[0]).includes('--profile coding-agent'))
})

test('panel render: an unknown daemon never renders as success', async () => {
  const degraded = JSON.parse(JSON.stringify(PANEL_STATE))
  degraded.layers.runtime = { known: false, reason: 'log-missing' }
  degraded.layers.applied = { known: false, applied: false, reason: 'daemon-not-running', pid: null, startTime: null, envMtime: null }
  stubFetch(degraded)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('未知'), 'unknown must be spelled out')
  assert.ok(text.includes('守护进程未在运行'))
  assert.equal(text.includes('已生效 '), false)
})

test('panel render: a missing DSH service disables the read button and names the gap', async () => {
  const degraded = JSON.parse(JSON.stringify(PANEL_STATE))
  degraded.dsh = { available: false, missing: ['credentials'], selection: null, route: null, key: { hasValue: false }, providers: [] }
  stubFetch(degraded)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('缺少宿主能力：credentials'))
  const readButton = buttonsByText(tree, '从 DSH 读取')[0]
  assert.ok(readButton, 'the read button still renders')
  assert.equal(readButton.props.disabled, true, 'but it is disabled')
})

test('panel render: Save is disabled until something actually changes', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const save = buttonsByText(tree, '保存')[0]
  assert.ok(save)
  assert.equal(save.props.disabled, true, 'a pristine form has nothing to save')
})

/** How many inputs sit inside a <td> — zero once the form is a row list. */
function inputsInsideCells(tree) {
  let found = 0
  const visit = (node, inCell) => {
    if (!node) return
    const now = inCell || node.type === 'td'
    if (node.type === 'input' && now) found += 1
    for (const child of node.children || []) visit(child, now)
  }
  visit(tree, false)
  return found
}

/** Type into one field and settle the resulting re-renders. */
async function editField(element, key, value) {
  let tree = await mount(element, React)
  const input = findAll(tree, (node) => node.type === 'input' && node.props['aria-label'] === key)[0]
  assert.ok(input, `input for ${key} must be rendered`)
  input.props.onChange({ target: { value } })
  for (let pass = 0; pass < 6; pass += 1) {
    const result = React.__render(element)
    tree = result.tree
    for (const effect of result.effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!result.dirtyNow()) break
  }
  return tree
}

test('panel render: the form is a row list, not the cramped four-column table', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  // The form is no longer a table at all: no input may sit inside a cell.
  assert.equal(inputsInsideCells(tree), 0, 'the settings form is a row list, not a table')
  assert.equal(text.includes('落盘值'), true, 'the conflicts table still labels its columns')
  // …and each field still shows its label, its raw key and its state.
  for (const marker of ['provider', 'HINDSIGHT_API_LLM_PROVIDER', '已设置', '被外层覆盖']) {
    assert.ok(text.includes(marker), `field row is missing ${marker}`)
  }
  // Every rendered input spans the row rather than living in a cell.
  const inputs = findAll(tree, (node) => node.type === 'input' && node.props['aria-label'])
  assert.equal(inputs.length, 13, 'all thirteen managed keys render an input')
  for (const input of inputs) {
    assert.match(String(input.props.style.flex), /^1 1 /, 'inputs are flex-sized, not column-sized')
  }
})

test('panel render: an overridden field names the value that actually wins', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('实为宿主进程：deepseek-v4-flash'), 'the winning outer value is shown, not just a warning')
})

test('panel render: an unedited field shows no history note at all', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  assert.equal(textOf(tree).includes('原值 '), false, 'nothing changed yet, so there is no "was" to show')
})

test('panel render: editing a field surfaces the value it is replacing', async () => {
  stubFetch(PANEL_STATE)
  const tree = await editField(React.createElement(clientTest.Section), 'HINDSIGHT_API_LLM_MODEL', 'deepseek-v4-flash')
  assert.ok(textOf(tree).includes('原值 deepseek-flash'), 'the previous value becomes visible once it matters')
  const save = buttonsByText(tree, '保存')[0]
  assert.equal(save.props.disabled, false, 'and Save wakes up')
})

test('panel render: the secret field never renders its value, only a mask', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const secret = findAll(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'HINDSIGHT_API_LLM_API_KEY')[0]
  assert.equal(secret.props.type, 'password')
  assert.equal(secret.props.value, '', 'a secret is never sent back into the field')
  assert.equal(secret.props.disabled, true, 'and it stays locked until 「修改」 is pressed')
  assert.ok(textOf(tree).includes('已设置：••••••••••(17)'), 'its presence is shown as a mask with a length')
})

test('panel render: no restart command ⇒ it says why instead of showing a blank box', async () => {
  const noCommand = JSON.parse(JSON.stringify(PANEL_STATE))
  noCommand.restart = { command: null, conflictKeys: [] }
  stubFetch(noCommand)
  const tree = await mount(React.createElement(clientTest.Section), React)
  assert.ok(textOf(tree).includes('读不到本机 Hindsight 配置'))
})

test('panel render: a failing host endpoint shows the reason, not an empty panel', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) })
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('出错：boom'), 'the failure is surfaced')
  assert.ok(text.includes('重新读取'), 'and a retry is offered')
})

// --- runner -----------------------------------------------------------------

let passed = 0
const failures = []
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  - ${name}`)
  } catch (error) {
    failures.push([name, error])
    console.log(`  NOT OK - ${name}`)
    console.log(`          ${(error && error.message || error).toString().split('\n').slice(0, 6).join('\n          ')}`)
  }
}
console.log(`\n${passed}/${tests.length} tests passed`)
if (failures.length > 0) process.exit(1)
