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
    if (args[0] === 'powershell' && String(args[4] || '').includes('Stop-Process')) {
      // Stopping no longer goes through the CLI: the plugin identifies the
      // listener and terminates it, so the runner is where the daemon dies.
      deps.daemonAlive = false
      return { ok: true, stdout: '', stderr: '' }
    }
    if (args[0] === 'powershell') {
      return deps.daemonAlive === false
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: '16280|python|2026-09-12T18:55:46.0000000+08:00|python.exe -m hindsight_api.main --daemon --idle-timeout 0 --port 9077', stderr: '' }
    }
    if (args[0] === 'reg' && args[1] === 'delete') {
      return { ok: true, stdout: 'The operation completed successfully.', stderr: '' }
    }
    return { ok: false, stdout: '', stderr: 'unexpected' }
  }
  deps.env = PROCESS_ENV
  deps.calls = calls
  deps.daemonAlive = true
  // The daemon block reports a health result; answer /health and leave the rest
  // to the individual tests.
  deps.httpGetJson = async (url) => {
    if (url.endsWith('/health')) return { status: 'healthy', database: 'connected' }
    throw new Error('not faked')
  }
  deps.spawnCalls = []
  deps.spawn = async (file, args, options) => {
    deps.spawnCalls.push({ file, args, options })
    // Model reality: a stop frees the port, a start takes it back. Without this
    // a restart would (correctly) stall waiting for the port.
    const action = args[args.length - 1]
    if (action === 'stop') deps.daemonAlive = false
    if (action === 'start') deps.daemonAlive = true
    return { ok: true, code: 0, stdout: 'done', stderr: '' }
  }
  deps.sleep = async () => {}
  return Object.assign(deps, overrides)
}

/** A mock cordis ctx exposing exactly the services the plugin reads. */
function makeCtx({ withWebServer = true, services = {}, slots = null, on = null } = {}) {
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
  // `on` is opt-in: a host WITHOUT it is the interesting degrade case, so the
  // default ctx deliberately has no event bus at all.
  if (typeof on === 'function') ctx.on = on
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
  const probe = core.parseDaemonProbe('16280|python|2026-09-12T18:55:46.0000000+08:00|"py.exe" -m hindsight_api.main --daemon --port 9077')
  assert.equal(probe.pid, 16280)
  assert.equal(probe.name, 'python')
  assert.equal(probe.startTime instanceof Date, true)
  assert.ok(probe.commandLine.includes('hindsight_api.main'))
  assert.deepEqual(core.parseDaemonProbe(''), { pid: null, name: null, commandLine: null, startTime: null })
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
      : { ok: true, stdout: '16280|python|2026-09-12T10:40:00.0000000+08:00|python.exe -m hindsight_api.main --daemon --idle-timeout 0 --port 9077', stderr: '' }),
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

test('routes: apply() registers exactly the seven exact routes', () => {
  const ctx = makeCtx()
  hostIndex.apply(ctx)
  assert.equal(ctx._registered.length, 7)
  assert.deepEqual(ctx._registered.map((r) => r.path).sort(), Object.values(hostIndex.ROUTES).sort())
  assert.ok(ctx._registered.some((r) => r.path === hostIndex.ROUTES.daemon), 'the lifecycle route is mounted')
  assert.ok(ctx._registered.some((r) => r.path === hostIndex.ROUTES.auto), 'the auto-start switch route is mounted')
  assert.deepEqual([...new Set(ctx._registered.map((r) => r.kind))], ['exact'])
  assert.equal(ctx._effects.length, 7, 'every registration is wrapped in ctx.effect')
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
  daemon: {
    canControl: true,
    reason: null,
    running: true,
    pid: 16280,
    health: { known: true, reachable: true, status: 'healthy', database: 'connected' },
    commands: {
      start: 'uv run --directory "C:\fake\embed" hindsight-embed daemon --profile coding-agent start',
      stop: 'uv run --directory "C:\fake\embed" hindsight-embed daemon --profile coding-agent stop',
    },
  },
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
  assert.equal(pre.length, 2, 'one for the commands the panel runs, one for the manual restart')
  const preText = pre.map((node) => textOf(node)).join(' ')
  assert.ok(preText.includes('--profile coding-agent'))
  assert.ok(preText.includes('Remove-Item Env:'), 'the manual command still carries its own cleanup')
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

// ============================================================================
// 11. daemon lifecycle
// ============================================================================

test('sanitizedEnv: every profile-owned key is stripped, nothing else is touched', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: 'h',
    HINDSIGHT_API_LLM_MODEL: 'deepseek-v4-flash',
    HINDSIGHT_API_LLM_API_KEY: 'sk-outer',
    HINDSIGHT_API_PORT: '9077',
    HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: '0',
    HF_ENDPOINT: 'https://hf-mirror.com',
  }
  const clean = core.sanitizedEnv(env)
  for (const key of core.MANAGED_KEYS) assert.equal(clean[key], undefined, `${key} must be stripped`)
  assert.equal(clean.PATH, '/usr/bin')
  assert.equal(clean.HOME, 'h')
  assert.equal(env.HINDSIGHT_API_LLM_MODEL, 'deepseek-v4-flash', 'the caller env is never mutated')
})

test('daemonArgs: argv comes from the machine layout, and restart is not a CLI subcommand', () => {
  const dir = ['C:', 'x', '.hindsight', 'embed-project'].join('/')
  const start = core.daemonArgs({ embedPackagePath: dir, daemonProfile: 'coding-agent', action: 'start' })
  assert.deepEqual(start, ['run', '--directory', dir, 'hindsight-embed', 'daemon', '--profile', 'coding-agent', 'start'])
  assert.equal(start.includes('restart'), false)
  assert.equal(core.daemonArgs({ embedPackagePath: dir, daemonProfile: 'coding-agent', action: 'restart' }), null)
  assert.equal(core.daemonArgs({ embedPackagePath: null, daemonProfile: 'p', action: 'start' }), null)
  assert.equal(core.daemonArgs({ embedPackagePath: 'd', daemonProfile: null, action: 'start' }), null)
  assert.match(core.daemonCommandLine(start), /^uv run --directory /)
  const spaced = core.daemonCommandLine(core.daemonArgs({ embedPackagePath: 'a b/c', daemonProfile: 'p', action: 'stop' }))
  assert.ok(spaced.includes('"a b/c"'), 'a path with a space is quoted')
})

test('tailForDisplay: bounded, and it never lets a credential through', () => {
  const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(core.tailForDisplay(noisy).split('\n').length, 12, 'only the tail is kept')
  const secretish = 'sk-abcdef123456\nHINDSIGHT_API_LLM_API_KEY=codemaker-managed\nTOKEN: abcdefghijklmnop'
  const shown = core.tailForDisplay(secretish)
  assert.equal(shown.includes('sk-abcdef123456'), false)
  assert.equal(shown.includes('codemaker-managed'), false)
  assert.equal(shown.includes('abcdefghijklmnop'), false)
  assert.equal(shown.length > 0, true, 'the shape of the failure is still visible')
})

test('daemon: an unknown action is refused before anything is spawned', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('nope')
  assert.equal(result.code, 'bad-action')
  assert.equal(deps.spawnCalls.length, 0)
})

test('daemon: stop and restart need an explicit confirmation flag', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  for (const action of ['stop', 'restart']) {
    const result = await impl.daemonAction(action)
    assert.equal(result.code, 'confirm-required', `${action} must require confirmation`)
  }
  assert.equal(deps.spawnCalls.length, 0, 'nothing runs before the confirmation')
  const started = await impl.daemonAction('start')
  assert.equal(started.ok, true, 'start is harmless and needs no confirmation')
})

test('daemon: stopping something already stopped is idempotent success', async () => {
  const deps = makeDeps()
  deps.daemonAlive = false
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('stop', { confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'already-stopped')
  assert.equal(deps.spawnCalls.length, 0, 'no point spawning a stop for a dead daemon')
})

test('daemon: start spawns uv with the SANITIZED environment', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('start')
  assert.equal(result.ok, true)
  assert.equal(result.code, 'started')
  assert.equal(deps.spawnCalls.length, 1)
  const call = deps.spawnCalls[0]
  assert.equal(call.file, 'uv')
  assert.equal(call.args[call.args.length - 1], 'start')
  for (const key of core.MANAGED_KEYS) {
    assert.equal(call.options.env[key], undefined, `${key} must not reach the child`)
  }
  assert.equal(result.state.daemon.running, true, 'the receipt carries a refreshed snapshot')
})

test('daemon: restart is stop → wait for the port → start, in that order', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('restart', { confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'restarted')
  assert.deepEqual(deps.spawnCalls.map((c) => c.args[c.args.length - 1]), ['start'],
    'only the start is a CLI call — the stop is the plugin\'s identified kill')
  assert.equal(deps.calls.some((args) => String(args[4] || '').includes('Stop-Process')), true,
    'the stop terminated the identified process')
  assert.equal(result.steps.length, 2)
  assert.deepEqual(result.steps.map((s) => s.action), ['stop', 'start'])
})

test('daemon: a restart whose stop never frees the port fails loudly', async () => {
  const deps = makeDeps()
  const originalRun = deps.run
  deps.run = async (args) => {
    // A "stop" that reports success but leaves the port bound.
    if (args[0] === 'powershell' && String(args[4] || '').includes('Stop-Process')) {
      return { ok: true, stdout: '', stderr: '' }
    }
    return originalRun(args)
  }
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('restart', { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'port-busy')
  assert.equal(deps.spawnCalls.length, 0, 'no start is attempted while the port is still held')
})

test('daemon: one action at a time', async () => {
  const deps = makeDeps()
  let release
  deps.spawn = async (file, args) => {
    deps.spawnCalls.push({ file, args })
    await new Promise((resolve) => { release = resolve })
    return { ok: true, code: 0, stdout: '', stderr: '' }
  }
  const impl = core.createCore(deps)
  const first = impl.daemonAction('start')
  // The in-flight flag is set synchronously, but the first action is still
  // awaiting its probe — let it reach spawn before releasing the gate.
  for (let i = 0; i < 10 && typeof release !== 'function'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const second = await impl.daemonAction('start')
  assert.equal(second.code, 'busy', 'a second action is refused while one is running')
  assert.equal(typeof release, 'function', 'the first action did reach spawn')
  release()
  assert.equal((await first).ok, true)
})

test('daemon: a host without spawn support says so instead of pretending', async () => {
  const deps = makeDeps()
  delete deps.spawn
  const impl = core.createCore(deps)
  const state = await impl.collectState()
  assert.equal(state.daemon.canControl, false)
  assert.equal(state.daemon.reason, 'this host cannot spawn processes')
  const result = await impl.daemonAction('start')
  assert.equal(result.code, 'no-spawn')
})

test('collectState: the daemon block reports status, health and the real commands', async () => {
  const impl = core.createCore(makeDeps())
  const state = await impl.collectState()
  assert.equal(state.daemon.running, true)
  assert.equal(state.daemon.pid, 16280)
  assert.equal(state.daemon.health.reachable, true)
  assert.equal(state.daemon.health.status, 'healthy')
  assert.ok(state.daemon.commands.start.includes('--profile coding-agent'))
  assert.ok(state.daemon.commands.stop.includes('Stop-Process'), 'the stop is the identified kill, not the CLI')
  assert.ok(state.daemon.commands.stop.includes('9077'), 'and it is scoped to this port')
})

test('collectState: an unreachable daemon reports unhealthy, not unknown', async () => {
  const deps = makeDeps()
  deps.daemonAlive = false
  const impl = core.createCore(deps)
  const state = await impl.collectState()
  assert.equal(state.daemon.running, false)
  assert.equal(state.daemon.health.reachable, false)
})

test('endpoint /daemon: method, action and confirmation are all enforced', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const route = hostIndex.ROUTES.daemon

  assert.equal((await callHandler(handlers[route], 'GET')).status, 405)
  assert.equal((await callHandler(handlers[route], 'POST', { action: 'nope' })).status, 400)
  assert.equal((await callHandler(handlers[route], 'POST', { action: 'stop' })).status, 400, 'no confirm ⇒ 400')
  assert.equal(deps.spawnCalls.length, 0)

  const ok = await callHandler(handlers[route], 'POST', { action: 'start' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(ok.json().code, 'started')
  assert.equal(ok.json().state.daemon.running, true)

  const confirmed = await callHandler(handlers[route], 'POST', { action: 'stop', confirm: true })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.json().code, 'stopped')
})

test('endpoint /daemon: the response never carries a plaintext key', async () => {
  const deps = makeDeps()
  deps.spawn = async (file, args, options) => {
    deps.spawnCalls.push({ file, args, options })
    deps.daemonAlive = args[args.length - 1] === 'start'
    return { ok: true, code: 0, stdout: 'starting with HINDSIGHT_API_LLM_API_KEY=codemaker-managed', stderr: 'sk-abcdef123456' }
  }
  const impl = core.createCore(deps)
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const res = await callHandler(handlers[hostIndex.ROUTES.daemon], 'POST', { action: 'start' })
  assert.equal(res.status, 200)
  assert.equal(res.body.includes('codemaker-managed'), false, 'output is redacted')
  assert.equal(res.body.includes('sk-abcdef123456'), false)
  assert.equal(res.body.includes('sk-super-secret-value'), false)
})

/** Re-render an already-mounted component until it settles. */
async function settle(element, React) {
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    const result = React.__render(element)
    tree = result.tree
    for (const effect of result.effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!result.dirtyNow()) break
  }
  return tree
}

test('panel render: the daemon block offers the lifecycle actions with live status', async () => {
  stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('守护进程'), 'the block has a heading')
  assert.ok(text.includes('运行中') && text.includes('PID 16280'), 'status and pid are shown')
  assert.ok(text.includes('healthy'), 'the health result is shown')
  for (const label of ['启动', '停止', '重启']) {
    assert.ok(buttonsByText(tree, label).length > 0, `missing action: ${label}`)
  }
  assert.ok(text.includes('会中断进行中的记忆操作'), 'the warning is always visible')
  assert.ok(text.includes('面板实际执行的命令'), 'the commands actually run are shown')
  assert.ok(text.includes('--profile coding-agent'), 'and they come from the machine layout')
  assert.ok(text.includes('外层同名变量不会被写回 profile'), 'the environment sanitization is explained')
  assert.ok(text.includes('不向无法确认的进程发信号'), 'and so is the stop\'s safety property')
})

test('panel render: start does not need confirmation', async () => {
  const calls = stubFetch(PANEL_STATE)
  const tree = await mount(React.createElement(clientTest.Section), React)
  await buttonsByText(tree, '启动')[0].props.onClick()
  const sent = calls.find((c) => c.url.endsWith('/daemon'))
  assert.ok(sent, 'start is sent straight away')
  assert.deepEqual(JSON.parse(sent.init.body), { action: 'start' })
})

test('panel render: stop asks first, and only then sends confirm:true', async () => {
  const calls = stubFetch(PANEL_STATE)
  const element = React.createElement(clientTest.Section)
  const tree = await mount(element, React)
  buttonsByText(tree, '停止')[0].props.onClick()
  const asked = await settle(element, React)
  assert.equal(calls.some((c) => c.url.endsWith('/daemon')), false, 'the first click sends nothing')
  assert.ok(textOf(asked).includes('确认停止'), 'the button turned into a confirmation')
  assert.ok(buttonsByText(asked, '取消').length > 0, 'and it can be cancelled')

  await buttonsByText(asked, '确认停止')[0].props.onClick()
  const sent = calls.find((c) => c.url.endsWith('/daemon'))
  assert.ok(sent, 'the confirmation sends the action')
  assert.deepEqual(JSON.parse(sent.init.body), { action: 'stop', confirm: true })
})

test('panel render: restart goes through the same confirmation gate', async () => {
  const calls = stubFetch(PANEL_STATE)
  const element = React.createElement(clientTest.Section)
  const tree = await mount(element, React)
  buttonsByText(tree, '重启')[0].props.onClick()
  const asked = await settle(element, React)
  assert.equal(calls.some((c) => c.url.endsWith('/daemon')), false)
  assert.ok(textOf(asked).includes('确认重启'))
  await buttonsByText(asked, '确认重启')[0].props.onClick()
  const sent = calls.find((c) => c.url.endsWith('/daemon'))
  assert.deepEqual(JSON.parse(sent.init.body), { action: 'restart', confirm: true })
})

test('panel render: cancelling the confirmation leaves the daemon alone', async () => {
  const calls = stubFetch(PANEL_STATE)
  const element = React.createElement(clientTest.Section)
  const tree = await mount(element, React)
  buttonsByText(tree, '停止')[0].props.onClick()
  const asked = await settle(element, React)
  buttonsByText(asked, '取消')[0].props.onClick()
  const back = await settle(element, React)
  assert.equal(calls.some((c) => c.url.endsWith('/daemon')), false, 'nothing was sent')
  assert.ok(buttonsByText(back, '停止').length > 0, 'and the plain button is back')
})

test('panel render: a host that cannot spawn disables the actions and says why', async () => {
  const degraded = JSON.parse(JSON.stringify(PANEL_STATE))
  degraded.daemon = {
    canControl: false,
    reason: 'this host cannot spawn processes',
    running: false,
    pid: null,
    health: { known: false, reachable: false, status: null, database: null },
    commands: { start: null, stop: null },
  }
  stubFetch(degraded)
  const tree = await mount(React.createElement(clientTest.Section), React)
  for (const label of ['启动', '停止', '重启']) {
    assert.equal(buttonsByText(tree, label)[0].props.disabled, true, `${label} must be disabled`)
  }
  const text = textOf(tree)
  assert.ok(text.includes('启停不可用'))
  assert.ok(text.includes('this host cannot spawn processes'), 'and the missing piece is named')
  assert.ok(text.includes('读取'), 'while the rest of the panel still works')
})

test('panel render: a stopped daemon reads as stopped, not as a failure', async () => {
  const stopped = JSON.parse(JSON.stringify(PANEL_STATE))
  stopped.daemon.running = false
  stopped.daemon.pid = null
  stopped.daemon.health = { known: true, reachable: false, status: null, database: null }
  stubFetch(stopped)
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('已停止'))
  assert.ok(text.includes('健康：—'), 'a stopped daemon has no health result to report')
})

test('identify: only a positively identified Hindsight listener may be signalled', () => {
  const cmd = 'python.exe -m hindsight_api.main --daemon --idle-timeout 0 --port 9077'
  assert.equal(core.identifyHindsightProcess({ name: 'python', commandLine: cmd, port: 9077 }).ok, true)
  assert.equal(core.identifyHindsightProcess({ name: 'python', commandLine: cmd, port: 1234 }).ok, false,
    'a listener on another port is not ours to kill')
  assert.equal(core.identifyHindsightProcess({ name: 'python', commandLine: 'python.exe -m http.server 9077', port: 9077 }).ok, false,
    'a different module is not our daemon')
  assert.equal(core.identifyHindsightProcess({ name: 'python', commandLine: 'python.exe -m hindsight_api.main --port 9077', port: 9077 }).ok, false,
    'the daemon flag is required too')
  assert.equal(core.identifyHindsightProcess({ name: 'svchost', commandLine: cmd, port: 9077 }).ok, false,
    'an unexpected process name is refused even with a matching command line')
  assert.equal(core.identifyHindsightProcess({ name: 'python', commandLine: null, port: 9077 }).ok, false,
    'unknown identity is refused')
})

test('daemon: an unidentifiable listener is refused, never killed', async () => {
  const deps = makeDeps()
  let killed = false
  deps.run = async (args) => {
    if (args[0] === 'powershell' && String(args[4] || '').includes('Stop-Process')) {
      killed = true
      return { ok: true, stdout: '', stderr: '' }
    }
    // Something else holds the port: a node server, not the Hindsight daemon.
    return { ok: true, stdout: '9999|node|2026-09-12T18:55:46.0000000+08:00|node.exe server.js --port 9077', stderr: '' }
  }
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('stop', { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-identified')
  assert.equal(killed, false, 'upstream\'s "never signal what you cannot identify" rule is preserved')
  assert.ok(result.steps[0].output.includes('拒绝向无法确认的进程发信号'))
})

// ============================================================================
// 9. auto start: launcher form, self-heal plan, backoff, origin (pure)
// ============================================================================

/** A minimal well-formed PE image declaring one subsystem. */
function peImage(subsystem) {
  const bytes = new Uint8Array(0x200)
  bytes[0] = 0x4d
  bytes[1] = 0x5a // 'MZ'
  const lfanew = 0x80
  bytes[0x3c] = lfanew
  bytes[lfanew] = 0x50
  bytes[lfanew + 1] = 0x45 // 'PE\0\0'
  const at = lfanew + 24 + 68
  bytes[at] = subsystem & 0xff
  bytes[at + 1] = (subsystem >> 8) & 0xff
  return bytes
}

test('launcher form: only the PE header decides (2 = console-free, 3 = console)', () => {
  assert.equal(core.peSubsystemOf(peImage(2)), 2)
  assert.equal(core.launcherFormOf(2), 'gui')
  assert.equal(core.peSubsystemOf(peImage(3)), 3)
  assert.equal(core.launcherFormOf(3), 'console')
})

test('launcher form: unreadable bytes are unknown, never a guess', () => {
  assert.equal(core.launcherFormOf(core.peSubsystemOf(new Uint8Array(0))), 'unknown')
  assert.equal(core.launcherFormOf(core.peSubsystemOf(null)), 'unknown')
  assert.equal(core.peSubsystemOf(new Uint8Array(0x200)), null, 'no MZ signature')
  assert.equal(core.peSubsystemOf(peImage(2).slice(0, 0x40)), null, 'e_lfanew past the buffer is not a PE')
  assert.equal(core.launcherFormFromName('pythonw.exe'), 'gui')
  assert.equal(core.launcherFormFromName('python.exe'), 'console')
  assert.equal(core.launcherFormFromName('something-else'), 'unknown')
})

test('self-heal plan: console is replaced only when the same release ships a console-free launcher', () => {
  assert.deepEqual(
    core.planLauncherHeal({ form: 'console', guiSourceAvailable: true }),
    { action: 'replace', reason: 'console-launcher' },
  )
  const blocked = core.planLauncherHeal({ form: 'console', guiSourceAvailable: false })
  assert.equal(blocked.action, 'none')
  assert.equal(blocked.reason, 'no-gui-source')
  assert.equal(blocked.blocked, true, 'a missing source is NOT permission to start')
  assert.equal(core.planLauncherHeal({ form: 'gui', guiSourceAvailable: true }).blocked, false)
  assert.equal(core.planLauncherHeal({ form: 'unknown', guiSourceAvailable: true }).action, 'none')
})

test('launcher source: pyvenv.cfg home points at the same release built for venvs', () => {
  const cfg = 'home = C:\\Users\\x\\AppData\\Roaming\\uv\\python\\cpython-3.12-windows-x86_64-none\r\ninclude-system-site-packages = false\n'
  assert.equal(core.parsePyvenvHome(cfg), 'C:\\Users\\x\\AppData\\Roaming\\uv\\python\\cpython-3.12-windows-x86_64-none')
  assert.equal(core.guiLauncherSourceOf('C:\\base\\'), 'C:\\base\\Lib\\venv\\scripts\\nt\\pythonw.exe')
  assert.equal(core.parsePyvenvHome(''), null)
  assert.equal(core.guiLauncherSourceOf(null), null)
})

test('backoff: 1/5/15/30 minutes capped, and one notice per distinct failure', () => {
  assert.deepEqual(core.BACKOFF_STEPS_MS, [60_000, 300_000, 900_000, 1_800_000])
  assert.equal(core.backoffDelayMs(1), 60_000)
  assert.equal(core.backoffDelayMs(3), 900_000)
  assert.equal(core.backoffDelayMs(9), 1_800_000, 'capped')
  assert.equal(core.backoffDelayMs(0), 0)

  const first = core.advanceAutoAttempt({}, { ok: false, code: 'start-failed', at: 'T1', now: 1_000 })
  assert.equal(first.state.failures, 1)
  assert.equal(first.state.backoffUntil, 61_000)
  assert.ok(first.notice, 'the first failure is worth a notice')
  const second = core.advanceAutoAttempt(first.state, { ok: false, code: 'start-failed', at: 'T2', now: 2_000 })
  assert.equal(second.state.failures, 2)
  assert.equal(second.state.backoffUntil, 302_000)
  assert.equal(second.notice, null, 'the same failure is not repeated')
  const recovered = core.advanceAutoAttempt(second.state, { ok: true, code: 'started', at: 'T3', now: 3_000 })
  assert.equal(recovered.state.failures, 0)
  assert.equal(recovered.state.backoffUntil, 0)
})

test('backoff window gates the next attempt', () => {
  const { state } = core.advanceAutoAttempt({}, { ok: false, code: 'start-failed', now: 10_000 })
  assert.equal(core.autoAttemptDue(state, 40_000), false, 'inside the first 1-minute window')
  assert.equal(core.autoAttemptDue(state, 70_001), true)
  assert.equal(core.autoAttemptDue({ failures: 0, backoffUntil: 0 }, 1), true)
})

test('origin: auto/manual only when THIS process started that pid', () => {
  const base = { known: true, pid: 42, imageName: 'pythonw.exe', imageForm: 'gui' }
  assert.equal(core.classifyDaemonOrigin({ ...base, startedBy: { pid: 42, reason: 'auto' } }).origin, 'auto')
  assert.equal(core.classifyDaemonOrigin({ ...base, startedBy: { pid: 42, reason: 'manual' } }).origin, 'manual')
  assert.equal(core.classifyDaemonOrigin({ ...base, startedBy: { pid: 7, reason: 'auto' } }).origin, 'external', 'a stale pid is not ours')
  assert.equal(core.classifyDaemonOrigin({ ...base }).origin, 'external')
  assert.equal(core.classifyDaemonOrigin({ known: false, pid: null }).origin, 'unknown')
})

test('origin: a console-capable image carries the window risk', () => {
  assert.equal(core.classifyDaemonOrigin({ known: true, pid: 1, imageName: 'python.exe', imageForm: 'console' }).consoleRisk, true)
  assert.equal(
    core.classifyDaemonOrigin({ known: true, pid: 1, imageName: 'python.exe', imageForm: 'unknown' }).consoleRisk,
    true,
    'falls back to the image name when the bytes cannot be read',
  )
  assert.equal(core.classifyDaemonOrigin({ known: true, pid: 1, imageName: 'pythonw.exe', imageForm: 'unknown' }).consoleRisk, false)
})

test('daemon probe: the image path is read, and the older 4-field shape still parses', () => {
  const modern = core.parseDaemonProbe('16280|pythonw|2026-09-12T18:55:46.0000000+08:00|C:\\base\\pythonw.exe|-m hindsight_api.main --daemon --port 9077')
  assert.equal(modern.pid, 16280)
  assert.equal(modern.exePath, 'C:\\base\\pythonw.exe')
  assert.equal(modern.commandLine, '-m hindsight_api.main --daemon --port 9077', 'the command line stays last: it may contain the separator')
  const legacy = core.parseDaemonProbe('16280|python|2026-09-12T18:55:46.0000000+08:00|python.exe -m hindsight_api.main --daemon --port 9077')
  assert.equal(legacy.exePath, null)
  assert.equal(legacy.commandLine, 'python.exe -m hindsight_api.main --daemon --port 9077')
})

// ============================================================================
// 10. on-demand auto start (core + host wiring)
// ============================================================================

/** Deps with binary access, for the launcher self-heal branches. */
function makeBinaryDeps({ launcherForm = 3, sourceForm = 2, failRename = false } = {}) {
  const deps = makeDeps()
  const embed = 'C:\\fake\\.hindsight\\embed-project'
  const venv = `${embed}\\.venv`
  const files = new Map()
  files.set(normPath(`${venv}\\Scripts\\pythonw.exe`), peImage(launcherForm))
  files.set(normPath('C:\\base\\cpython-3.12\\Lib\\venv\\scripts\\nt\\pythonw.exe'), peImage(sourceForm))
  deps.writeText(`${venv}\\pyvenv.cfg`, 'home = C:\\base\\cpython-3.12\ninclude-system-site-packages = false\n')
  deps.readBinary = (p) => files.get(normPath(p)) || null
  deps.writeBinary = (p, bytes) => { files.set(normPath(p), bytes) }
  deps.removeFile = (p) => { files.delete(normPath(p)) }
  deps.rename = (from, to) => {
    if (failRename) throw new Error('EPERM: rename refused')
    if (!files.has(normPath(from))) throw new Error(`ENOENT: ${from}`)
    files.set(normPath(to), files.get(normPath(from)))
    files.delete(normPath(from))
  }
  const originalRun = deps.run
  deps.run = async (args) => {
    // Modern probe shape: the image path rides along, so the origin/console-risk
    // assertions follow the ACTUAL bytes in the fake venv rather than a name.
    if (args[0] === 'powershell' && !String(args[4] || '').includes('Stop-Process')) {
      if (!deps.daemonAlive) return { ok: true, stdout: '', stderr: '' }
      const line = `16280|pythonw|2026-09-12T18:55:46.0000000+08:00|${venv}\Scripts\pythonw.exe|-m hindsight_api.main --daemon --idle-timeout 0 --port 9077`
      return { ok: true, stdout: line, stderr: '' }
    }
    return originalRun(args)
  }
  deps.binaryFiles = files
  deps.embed = embed
  deps.venv = venv
  return deps
}

test('auto start: a healthy daemon is adopted — no spawn, no writes, same pid', async () => {
  const deps = makeDeps() // daemonAlive ⇒ the probe finds a listener
  const impl = core.createCore(deps)
  const result = await impl.ensureDaemon({ reason: 'auto' })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'adopted')
  assert.equal(deps.spawnCalls.length, 0, 'adoption never spawns')
  assert.equal(result.pid, 16280)
  const state = await impl.collectState()
  assert.equal(state.auto.triggers, 1)
  assert.equal(state.auto.lastResult.code, 'adopted')
  assert.equal(state.auto.starting, false)
})

test('auto start: an unhealthy daemon starts in the BACKGROUND, through the sanitized CLI path', async () => {
  const deps = makeDeps()
  deps.daemonAlive = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const spawned = []
  deps.spawn = async (file, args, options) => {
    spawned.push({ file, args, options })
    await gate // stays in flight until this test lets go
    deps.daemonAlive = true
    return { ok: true, code: 0, stdout: 'started', stderr: '' }
  }
  const impl = core.createCore(deps)

  // Reaching the next line at all is the non-blocking proof: the spawn is parked
  // on `gate`, so a trigger that waited for the cold start would hang right here.
  const result = await impl.ensureDaemon({ reason: 'auto' })
  assert.equal(result.code, 'starting', 'the trigger returns while the cold start is still running')

  release()
  await result.started
  assert.equal(spawned.length, 1, 'exactly one start, through the shared path')
  assert.equal(
    spawned[0].args.join(' '),
    'run --directory C:\\fake\\.hindsight\\embed-project hindsight-embed daemon --profile coding-agent start',
    'the same command the panel buttons run',
  )
  for (const key of core.MANAGED_KEYS) {
    assert.equal(key in (spawned[0].options.env || {}), false, `${key} is stripped from the child env`)
  }
  const state = await impl.collectState()
  assert.equal(state.auto.lastResult.ok, true)
  assert.equal(state.auto.lastResult.code, 'started')
  assert.equal(state.auto.starting, false)
})

test('auto start: failures back off; success lifts the window', async () => {
  const deps = makeDeps()
  deps.daemonAlive = false
  let clock = 1_000_000
  deps.now = () => clock
  deps.spawn = async () => ({ ok: false, code: 1, stdout: '', stderr: 'uv exploded' })
  const impl = core.createCore(deps)

  const first = await impl.ensureDaemon({ reason: 'auto' })
  await first.started
  let state = await impl.collectState()
  assert.equal(state.auto.failures, 1)
  assert.equal(state.auto.retryInMs, 60_000)
  assert.equal(state.auto.lastResult.ok, false)

  const blocked = await impl.ensureDaemon({ reason: 'auto' })
  assert.equal(blocked.code, 'backoff', 'a session inside the window must not retry')
  assert.equal(deps.spawnCalls.length, 0, 'and must not spawn')

  clock += 60_001
  deps.spawn = async () => { deps.daemonAlive = true; return { ok: true, code: 0, stdout: 'ok', stderr: '' } }
  const third = await impl.ensureDaemon({ reason: 'auto' })
  assert.equal(third.code, 'starting')
  await third.started
  state = await impl.collectState()
  assert.equal(state.auto.failures, 0)
  assert.equal(state.auto.retryInMs, 0)
})

test('auto start: the switch turns the trigger off, and an unwritable switch says so', async () => {
  const deps = makeDeps()
  deps.daemonAlive = false
  deps.readAutoStart = () => false
  const impl = core.createCore(deps)
  assert.equal((await impl.ensureDaemon()).code, 'disabled')
  assert.equal(deps.spawnCalls.length, 0)
  const refused = await impl.setAutoStart(true)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'settings-unavailable')
  assert.equal((await impl.setAutoStart('yes')).code, 'invalid-value')
})

test('auto start: with a writable switch the value round-trips', async () => {
  const deps = makeDeps()
  let stored = null
  deps.readAutoStart = () => (stored === null ? true : stored)
  deps.writeAutoStart = async (value) => { stored = value; return { ok: true } }
  const impl = core.createCore(deps)
  assert.equal((await impl.setAutoStart(false)).ok, true)
  assert.equal(stored, false)
  assert.equal((await impl.ensureDaemon()).code, 'disabled')
  await impl.setAutoStart(true)
  assert.equal((await impl.ensureDaemon()).code, 'adopted')
})

test('auto start: a host without session capabilities degrades to manual and says so', async () => {
  const deps = makeDeps()
  const impl = core.createCore(deps)
  assert.equal(impl.noteHostEvents('missing'), 'missing')
  const state = await impl.collectState()
  assert.equal(state.auto.hostEvents, 'missing')
  assert.equal(state.auto.enabled, true, 'the manual capability is untouched')
})

test('self-heal: a console launcher is swapped for the console-free one, after a backup', async () => {
  const deps = makeBinaryDeps({ launcherForm: 3, sourceForm: 2 })
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('start', { confirm: true })
  assert.equal(result.ok, true)
  const launcher = normPath(`${deps.venv}\\Scripts\\pythonw.exe`)
  const backup = normPath(`${deps.embed}\\pythonw.exe.uv-orig-2026-09-13T10-00-00-000Z`)
  assert.equal(core.peSubsystemOf(deps.binaryFiles.get(launcher)), 2, 'the launcher now declares the console-free subsystem')
  assert.equal(core.peSubsystemOf(deps.binaryFiles.get(backup)), 3, 'the original bytes survive in the backup')
  const healStep = result.steps.find((step) => step.action === 'heal')
  assert.equal(healStep.code, 'replaced')
  assert.equal(result.state.auto.heal.occurred, true, 'the panel is told a replacement happened')
  assert.ok(result.state.auto.healed.backupPath.endsWith('pythonw.exe.uv-orig-2026-09-13T10-00-00-000Z'))
})

test('self-heal: an already console-free launcher means zero writes', async () => {
  const deps = makeBinaryDeps({ launcherForm: 2, sourceForm: 2 })
  const before = [...deps.binaryFiles.keys()]
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('start', { confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.steps.some((step) => step.action === 'heal'), false, 'nothing worth reporting')
  assert.equal(result.state.auto.heal.code, 'not-needed')
  assert.deepEqual([...deps.binaryFiles.keys()], before, 'no file was created or replaced')
})

test('self-heal: a console launcher with no console-free source refuses to start', async () => {
  const deps = makeBinaryDeps({ launcherForm: 3, sourceForm: 3 })
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('start', { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher-blocked')
  assert.equal(deps.spawnCalls.length, 0, 'nothing was started')
  assert.equal(core.peSubsystemOf(deps.binaryFiles.get(normPath(`${deps.venv}\\Scripts\\pythonw.exe`))), 3, 'the launcher is untouched')
})

test('self-heal: a failed swap blocks the start and leaves no half-written state', async () => {
  const deps = makeBinaryDeps({ launcherForm: 3, sourceForm: 2, failRename: true })
  const impl = core.createCore(deps)
  const result = await impl.daemonAction('start', { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher-blocked')
  assert.equal(deps.spawnCalls.length, 0)
  assert.equal(core.peSubsystemOf(deps.binaryFiles.get(normPath(`${deps.venv}\\Scripts\\pythonw.exe`))), 3, 'original bytes stay in place')
  assert.deepEqual([...deps.binaryFiles.keys()].filter((key) => key.includes('.heal-')), [], 'the staging file is cleaned up')
})

test('origin: what this plugin started is "ours"; a foreign console daemon is external + risky', async () => {
  const mine = makeBinaryDeps({ launcherForm: 2, sourceForm: 2 })
  const owned = core.createCore(mine)
  await owned.daemonAction('start', { confirm: true })
  const ownedState = await owned.collectState()
  assert.equal(ownedState.origin.origin, 'manual')
  assert.equal(ownedState.origin.consoleRisk, false)

  const foreign = makeBinaryDeps({ launcherForm: 2, sourceForm: 2 })
  const originalRun = foreign.run
  const foreignProbe = '999|python|2026-09-12T18:55:46.0000000+08:00|C:\\base\\python.exe|-m hindsight_api.main --daemon --port 9077'
  foreign.daemonAlive = true
  foreign.run = async (args) => (args[0] === 'powershell' ? { ok: true, stdout: foreignProbe, stderr: '' } : originalRun(args))
  foreign.readBinary = (p) => (normPath(p) === normPath('C:\\base\\python.exe') ? peImage(3) : null)
  const other = core.createCore(foreign)
  const foreignState = await other.collectState()
  assert.equal(foreignState.origin.origin, 'external')
  assert.equal(foreignState.origin.consoleRisk, true, 'a console image is flagged for the panel')
})

test('host: apply() subscribes the session-start trigger; the /auto route writes the switch', async () => {
  const seen = []
  const installed = []
  let written = null
  const ctx = makeCtx({
    on: (name, handler) => { seen.push([name, handler]); return () => {} },
    services: {
      settings: {
        // The REAL shape: register() hands back the owner scope, which is the
        // only way a host half can write. installSection() returns nothing.
        register: (ns, schema, options) => {
          installed.push({ ns, base: options && options.base })
          return {
            get: () => ({ autoStart: true }),
            update: async (patch) => { written = patch },
          }
        },
      },
    },
  })
  hostIndex.apply(ctx)
  assert.deepEqual(seen.map(([name]) => name), ['agent/session-start'], 'one plain session hook, nothing on the per-step middleware chain')
  await new Promise((resolve) => setImmediate(resolve)) // the section schema is imported dynamically
  assert.equal(installed.length, 1)
  assert.equal(installed[0].ns, 'hindsight-model')
  assert.deepEqual(installed[0].base, { autoStart: true })

  const impl = core.createCore(makeDeps())
  const handlers = hostIndex.createHandlers({ core: impl, dsh: hostIndex.createDshReader(makeCtx()) })
  const bad = await callHandler(handlers[hostIndex.ROUTES.auto], 'GET', {})
  assert.equal(bad.status, 405)
  const invalid = await callHandler(handlers[hostIndex.ROUTES.auto], 'POST', { enabled: 'yes' })
  assert.equal(invalid.status, 400)
  const unavailable = await callHandler(handlers[hostIndex.ROUTES.auto], 'POST', { enabled: false })
  assert.equal(unavailable.status, 500, 'no writable settings service ⇒ an honest failure, not a silent no-op')
  assert.equal(unavailable.json().code, 'settings-unavailable')
})

test('panel render: the auto-start switch states its policy, and is disabled when settings are unwritable', async () => {
  stubFetch(PANEL_STATE) // the fixture has no auto block at all
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('自动启动'), 'the switch is part of the daemon block')
  assert.ok(text.includes('开关不可写'), 'an unwritable switch says why')
  assert.ok(text.includes('已经在跑就采纳'), 'and the policy is spelled out, not implied')
  const toggle = buttonsByText(tree, '开启自动启动')
  assert.equal(toggle.length, 1)
  assert.equal(toggle[0].props.disabled, true, 'no writable settings service ⇒ no flipping')
})

test('panel render: a writable switch flips the settings key through /auto', async () => {
  const auto = {
    enabled: true,
    writable: true,
    reason: null,
    triggers: 4,
    lastTriggerAt: 'T',
    lastResult: { at: 'T', ok: true, code: 'adopted' },
    failures: 0,
    retryInMs: 0,
    starting: false,
    notice: null,
    heal: { code: 'not-needed' },
    healed: null,
    hostEvents: 'subscription-ok',
    origin: { origin: 'auto', consoleRisk: false },
  }
  const calls = stubFetch({ ...PANEL_STATE, auto, origin: auto.origin })
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('上次自动启动：已采纳现成的守护进程'), 'the last outcome is shown')
  assert.ok(text.includes('启动来源：自动（本插件）'), 'so is who started it')

  await buttonsByText(tree, '关闭自动启动')[0].props.onClick()
  const sent = calls.find((call) => call.url.endsWith('/auto'))
  assert.ok(sent, 'the switch posts to /auto')
  assert.deepEqual(JSON.parse(sent.init.body), { enabled: false })
})

test('panel render: cold start, backoff, self-heal and a missing event bus are all visible', async () => {
  const auto = {
    enabled: true,
    writable: true,
    reason: null,
    triggers: 2,
    lastTriggerAt: 'T',
    lastResult: { at: 'T', ok: false, code: 'start-failed' },
    failures: 2,
    retryInMs: 120_000,
    starting: true,
    notice: { kind: 'auto-start-failed', failures: 1, code: 'start-failed' },
    heal: { occurred: true, code: 'replaced' },
    healed: { at: 'T', backupPath: 'C:\\fake\\embed\\pythonw.exe.uv-orig-T', source: 'C:\\base\\pythonw.exe' },
    hostEvents: 'subscription-ok',
    origin: { origin: 'external', consoleRisk: true },
  }
  stubFetch({ ...PANEL_STATE, auto, origin: auto.origin })
  const tree = await mount(React.createElement(clientTest.Section), React)
  const text = textOf(tree)
  assert.ok(text.includes('正在后台冷启动'), 'a cold start in flight is announced')
  assert.ok(text.includes('上次自动启动失败') && text.includes('已退避'), 'failures and the retry window are shown')
  assert.ok(text.includes('替换了解释器启动器'), 'a launcher replacement is reported, never silent')
  assert.ok(text.includes('启动来源：外部（本插件之外）') && text.includes('有控制台窗口风险'), 'a foreign console daemon is flagged')

  stubFetch({
    ...PANEL_STATE,
    auto: { ...auto, starting: false, triggers: 0, failures: 0, retryInMs: 0, healed: null, heal: { code: 'not-needed' }, hostEvents: 'missing', origin: { origin: 'unknown', consoleRisk: false } },
    origin: { origin: 'unknown', consoleRisk: false },
  })
  const second = await mount(React.createElement(clientTest.Section), React)
  const secondText = textOf(second)
  assert.ok(secondText.includes('宿主未提供会话事件'), 'a host without session events says so instead of failing silently')
  assert.ok(secondText.includes('启动来源：未知'), 'an unidentifiable daemon is unknown, not guessed')
})

test('host: an installSection-only service registers the namespace but leaves the switch read-only', async () => {
  const seen = []
  const ctx = makeCtx({
    services: {
      settings: {
        // Older/leaner providers expose installSection but no scope handle.
        installSection: (context, ns, schema, entry, hooks) => {
          seen.push({ ns, entry })
          hooks.setSource(() => ({ autoStart: false }))
          hooks.onChange()
        },
      },
    },
  })
  assert.doesNotThrow(() => hostIndex.apply(ctx))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 1, 'the namespace is still registered, so the settings page shows the key')
  assert.deepEqual(seen[0].entry, { autoStart: true }, 'with the documented default')
  assert.equal(hostIndex.HOST_DIAG.settingsSectionRegistered, true)
  assert.equal(hostIndex.HOST_DIAG.settingsSectionError, 'settings-scope-unavailable', 'and the panel is told why writes are off')
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
