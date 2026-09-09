// Behavioural harness for dsh-session-title-regenerate (host + client).
//
// WHY THIS EXISTS
// The plugin has two halves:
//   - src/index.js is a plain ESM cordis plugin with NO host-package import:
//     it reaches the host only through injected ctx services (commands / llm /
//     sessionTitle) and carries its own local message + stream helpers. The
//     harness drives the command handler with a fake ctx / agent / llm stream,
//     so this whole file runs with no node_modules at all.
//   - src/client.js is a browser classic-script bundle (no build step), so it
//     is materialized the way @deepseek-ai/dsh-client-modules does —
//     window.__ModuleLoader__.load({id, factory}) then factory(require) — with
//     real module ids and stub UI primitives. apply() registers the header
//     button and the feedback overlay; the DOM-injected sidebar menu item and
//     the shared flow are driven through the test-only hooks
//     (window.__sessionTitleRegenTest, gated by window.__DSH_TEST__).
//
// It is a LOGIC harness, not a browser render: no React rendering, no portal.
// Visual behaviour still needs the manual checks in README.
//
// Run: node dsh-session-title-regenerate/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as hostApply, inject as hostInject, name as hostName } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientBundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-session-title-regenerate'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((resolve) => setImmediate(resolve))

// =============================================================================
// Host-side fakes
// =============================================================================

/** One eligible user/message event in the session log. */
function userEvent(seq, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    data: { source: { kind }, content: [{ type: 'text', text }] },
  }
}

/** Fake agent whose session exposes the log and the last request header. */
function makeAgent({ events = [], route = { provider: 'deepseek', model: 'deepseek-chat' }, id = 'sess-1' } = {}) {
  return {
    session: {
      id,
      snapshotEvents: () => events,
      requestHeader: () => (route ? { config: route } : undefined),
    },
  }
}

/**
 * Fake host ctx: llm.stream (async generator, scriptable), sessionTitle.rename
 * (spy), commands.register (captures the definition).
 */
function makeHost({ streamImpl, rename } = {}) {
  const calls = { streamOptions: [], rename: [], registered: [] }
  const llm = {
    async *stream(options) {
      calls.streamOptions.push(options)
      if (typeof streamImpl === 'function') yield* streamImpl(options)
    },
  }
  const sessionTitle = {
    rename(session, title) {
      calls.rename.push({ session, title })
      return { title, eventSeq: 99 }
    },
  }
  const commands = {
    register(definition) {
      calls.registered.push(definition)
      return () => {}
    },
  }
  const ctx = { llm, sessionTitle, commands, get: (n) => ({ llm, sessionTitle, commands }[n]) }
  return { ctx, calls, llm, sessionTitle, commands }
}

/** An llm stream that emits one text block then a finish reason. */
function* textStream(text, finish = { kind: 'stop' }) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: finish }
}

function registeredDefinition(host, ctx = host.ctx) {
  hostApply(ctx, undefined)
  assert.equal(host.calls.registered.length, 1)
  return host.calls.registered[0]
}

function signal() {
  return new AbortController().signal
}

// =============================================================================
// Host: registration
// =============================================================================

test('host exports cordis contract and registers the command', () => {
  assert.equal(hostName, 'session-title-regenerate')
  assert.deepEqual(hostInject.sort(), ['commands', 'llm', 'sessionTitle'].sort())
  const host = makeHost({})
  const def = registeredDefinition(host)
  assert.equal(def.name, 'regenerate-title')
  assert.equal(def.recordInput, false)
  assert.equal(typeof def.description, 'string')
  assert.equal(typeof def.handler, 'function')
})

// =============================================================================
// Host: link-install safety
// =============================================================================

test('host: src/index.js imports no host package (link-install safe)', () => {
  const source = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
  assert.ok(!/from\s+'@deepseek-ai\//.test(source), 'host half must not import host packages')
  assert.ok(!/require\('@deepseek-ai\//.test(source), 'host half must not require host packages')
})

// =============================================================================
// Host: happy path
// =============================================================================

test('host: success — collects messages, lowest reasoning, commits via rename', async () => {
  const events = [userEvent(1, '帮我写一个Dsh插件'), userEvent(2, '要支持右键菜单')]
  const agent = makeAgent({ events })
  const host = makeHost({ streamImpl: () => textStream('“帮我写一个Dsh插件”  ') })
  const def = registeredDefinition(host)

  const result = await def.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.equal(result.text, '帮我写一个Dsh插件')

  const options = host.calls.streamOptions[0]
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-chat')
  assert.equal(options.reasoningEffort, 'off')
  assert.equal(options.purpose, 'session-title')
  assert.equal(options.maxTokens, 100)
  assert.equal(options.sessionId, 'sess-1')
  assert.equal(typeof options.system, 'string')
  assert.ok(options.system.includes('60'))
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  // Both user questions travel to the model, framed as JSON.
  const framed = options.messages[0].content[0].text
  assert.ok(framed.includes('帮我写一个Dsh插件'))
  assert.ok(framed.includes('要支持右键菜单'))

  assert.equal(host.calls.rename.length, 1)
  assert.equal(host.calls.rename[0].session, agent.session)
  assert.equal(host.calls.rename[0].title, '帮我写一个Dsh插件')
})

test('host: config provider/model overrides the session route', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hello')] })
  const host = makeHost({ streamImpl: () => textStream('hello world') })
  hostApply(host.ctx, { provider: 'lite', model: 'lite-model' })
  const def = host.calls.registered[0]

  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(host.calls.streamOptions[0].provider, 'lite')
  assert.equal(host.calls.streamOptions[0].model, 'lite-model')
})

// =============================================================================
// Host: error paths
// =============================================================================

test('host: no user messages -> error, no llm call', async () => {
  const agent = makeAgent({ events: [] })
  const host = makeHost({})
  const def = registeredDefinition(host)

  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有'))
  assert.equal(host.calls.streamOptions.length, 0)
  assert.equal(host.calls.rename.length, 0)
})

test('host: non-user messages are ignored', async () => {
  const events = [userEvent(1, 'from tool', 'tool')]
  const agent = makeAgent({ events })
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.equal(host.calls.streamOptions.length, 0)
})

test('host: missing route -> error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')], route: null })
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('路由'))
  assert.equal(host.calls.streamOptions.length, 0)
})

test('host: empty model output -> error, rename not called', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('   \n  ') })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有产生'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: finish kind max-tokens -> error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('partial', { kind: 'max-tokens' }) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('maxTokens'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: finish kind error surfaces the provider message', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('', { kind: 'error', failure: { message: 'boom', code: 'E' } }) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('boom'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: abort -> cancelled error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({
    streamImpl(options) {
      if (options.signal.aborted) throw new Error('aborted by signal')
      return textStream('title')
    },
  })
  const def = registeredDefinition(host)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const result = await def.handler({ agent, signal: controller.signal })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('取消'))
})

// =============================================================================
// Host: normalization & policy
// =============================================================================

test('host: output normalized to one clean line without quotes, capped at 60 code points', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const long = 'x'.repeat(90)
  const host = makeHost({ streamImpl: () => textStream(`\u201C${long}\u201D\n\nsecond line`) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text.length, 60)
  assert.ok(!result.text.includes('"'))
  assert.ok(!result.text.includes('\n'))
  assert.equal(host.calls.rename[0].title, result.text)
})

test('host: unsupported reasoning effort retries without it', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  let calls = 0
  const host = makeHost({
    streamImpl(options) {
      calls += 1
      if (calls === 1) {
        const error = new Error('provider does not support reasoning effort "off"')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      return textStream('retried title')
    },
  })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'retried title')
  assert.equal(calls, 2)
  assert.equal(host.calls.streamOptions[0].reasoningEffort, 'off')
  assert.ok(!('reasoningEffort' in host.calls.streamOptions[1]))
})

test('host: input is truncated by the byte budget', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'short'), userEvent(2, 'Z'.repeat(500))] })
  const host = makeHost({ streamImpl: () => textStream('ok title') })
  hostApply(host.ctx, { maxInputBytes: 40 })
  const def = host.calls.registered[0]
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  const framed = host.calls.streamOptions[0].messages[0].content[0].text
  assert.ok(framed.includes('short'))
  assert.ok(!framed.includes('ZZZZ'))
})

test('host: reads events through the 0.1.1 `events` getter shape', async () => {
  const events = [userEvent(1, '老接口标题')]
  const agent = {
    session: {
      id: 'sess-1',
      get events() { return events },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    },
  }
  const host = makeHost({ streamImpl: () => textStream('老接口标题') })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '老接口标题')
})

test('host: unknown event API degrades to empty input without throwing', async () => {
  const agent = { session: { id: 'sess-1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有'))
  assert.equal(host.calls.streamOptions.length, 0)
})

// =============================================================================
// Client-side harness
// =============================================================================

// --- browser-ish globals -----------------------------------------------------

const windowEvents = []
class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type
    this.detail = (opts && opts.detail) || {}
  }
}

/** Minimal selector matcher for the selectors this plugin uses. */
function matches(node, sel) {
  if (sel === 'span') return node.tagName === 'SPAN'
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1)
    // `class*=substring` — substring match on the class attribute.
    if (inner.startsWith('class*=')) {
      return String(node.className || '').includes(inner.slice('class*='.length))
    }
    const eq = inner.match(/^([a-z][a-z0-9-]*)=(.*)$/)
    if (eq) {
      const [, attr, value] = eq
      if (value.startsWith('*') && value.endsWith('*')) {
        return String(node.attrs[attr] || '').includes(value.slice(1, -1))
      }
      if (value.startsWith('*')) return String(node.attrs[attr] || '').includes(value.slice(1))
      if (value.endsWith('*')) return String(node.attrs[attr] || '').includes(value.slice(0, -1))
      return node.attrs[attr] === value
    }
    const presence = inner.match(/^[a-z][a-z0-9-]*$/)
    if (presence) return node.attrs[presence[0]] !== undefined
  }
  return false
}

function findIn(node, sel, all, out) {
  if (matches(node, sel)) {
    if (!all) return node
    out.push(node)
  }
  for (const child of node.children || []) {
    const found = findIn(child, sel, all, out)
    if (!all && found) return found
  }
  return all ? out : null
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    style: {},
    children: [],
    handlers: {},
    className: '',
    innerText: '',
    textContent: '',
    innerHTML: '',
    setAttribute(k, v) { el.attrs[k] = String(v) },
    appendChild(child) { el.children.push(child); return child },
    insertBefore(child, ref) {
      const i = el.children.indexOf(ref)
      if (i >= 0) el.children.splice(i, 0, child)
      else el.children.push(child)
      return child
    },
    addEventListener(type, fn) { el.handlers[type] = fn },
    querySelector(sel) {
      const found = findIn(el, sel, false, null)
      if (found) return found
      // Convenience: the injected button sets label via querySelector('span').
      if (sel === 'span' && el.tagName === 'BUTTON') {
        const span = makeElement('SPAN')
        el.appendChild(span)
        return span
      }
      return null
    },
    querySelectorAll(sel) {
      const out = []
      findIn(el, sel, true, out)
      return out
    },
  }
  return el
}

function makeDocument() {
  // Faithful to the core Menu: native items live inside a role=presentation
  // viewport that is a CHILD of the [role=menu] element; plugin-injected items
  // (session-delete etc.) are appended as DIRECT children of [role=menu].
  const menuEl = makeElement('DIV')
  menuEl.setAttribute('role', 'menu')
  menuEl.className = 'uV2eYG_menu'
  const viewport = makeElement('DIV')
  viewport.setAttribute('role', 'presentation')
  menuEl.appendChild(viewport)
  const titleEl = makeElement('SPAN')
  titleEl.className = 'uV2eYG_title'
  titleEl.innerText = 'Foo'
  const rowEl = makeElement('DIV')
  rowEl.className = 'uV2eYG_sessionRow uV2eYG_menuOpen'
  rowEl.appendChild(titleEl)
  const body = makeElement('BODY')
  return {
    body,
    menuEl,
    viewport,
    rowEl,
    createElement: (tag) => makeElement(tag),
    querySelector: (sel) => (sel === '[role=menu]' ? menuEl : null),
    querySelectorAll: (sel) => (sel === '[class*=sessionRow]' ? [rowEl] : []),
  }
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})
globalThis.CustomEvent = FakeCustomEvent
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  dispatchEvent: (e) => { windowEvents.push(e) },
  addEventListener() {},
  removeEventListener() {},
  MutationObserver: globalThis.MutationObserver,
}
globalThis.document = makeDocument()

const factories = new Map()

const IconStub = () => null
const primitives = {
  IconCheckOutline16: IconStub,
  IconLoadingOutline16: IconStub,
  IconRefreshOutline16: IconStub,
  IconWarningOutline16: IconStub,
  Toast: ({ text }) => ({ __toast: text }),
}

function makeReactStub() {
  const React = {
    createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props || {}), children } }),
    Fragment: Symbol('Fragment'),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useRef(initial) { return { current: initial } },
    useCallback: (fn) => fn,
  }
  return React
}
const ReactStub = makeReactStub()

function requireStub(specifier) {
  if (specifier === 'react') return ReactStub
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the client bundle --------------------------------------------------

const clientSource = fs.readFileSync(clientBundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', clientSource)(
  globalThis.window,
  globalThis.navigator,
  globalThis.document,
)

/**
 * Fake client ctx shaped like the REAL runtime for the `remote` root: the bare
 * root exposes every controller as an accessor that THROWS
 * `cannot get property "remote.commands" without inject` until the dotted name
 * has been injected. Only `ctx.get('remote.commands')` / an inject scope
 * resolves the commands controller — mirroring the gateway's configurable
 * getters that external plugins must not read directly.
 */
function makeRemoteRoot() {
  const root = {}
  Object.defineProperty(root, 'commands', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('cannot get property "remote.commands" without inject')
    },
  })
  return root
}

/** Fake client ctx: services resolved through get(), slots captured. */
function makeClientCtx({ remoteCommands, sessions, locale }) {
  const registered = []
  const services = {
    remote: makeRemoteRoot(),
    'remote.commands': remoteCommands,
    sessions,
    locale,
  }
  return {
    registered,
    get: (n) => services[n],
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => {
      fn({
        get: (n) => services[n],
        effect: (fn2) => fn2(),
        on: () => {},
      })
    },
    slots: {
      inject: (name, build) => { build() },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
}

function bootClient({ remoteCommands, sessions, locale }) {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `client bundle did not register id "${PKG_ID}"`)
  // Module-level service handles persist across boots in the same bundle
  // instance; reset them so every scenario starts from a clean slate.
  const prev = globalThis.window.__sessionTitleRegenTest
  if (prev && typeof prev.reset === 'function') prev.reset()
  // Reset the fake menu to a fresh core-shaped tree (empty role=presentation
  // viewport under the [role=menu]) so injection starts from scratch.
  const menu = globalThis.document.menuEl
  menu.children.length = 0
  const viewport = globalThis.document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  globalThis.document.viewport = viewport
  const ctx = makeClientCtx({ remoteCommands, sessions, locale })
  const exports = factory(requireStub)
  exports.apply(ctx)
  return { ctx, hooks: globalThis.window.__sessionTitleRegenTest }
}

// =============================================================================
// Client: slot registration
// =============================================================================

test('client: registers header button and feedback overlay slots', () => {
  const { ctx } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const names = ctx.registered.map((r) => r.options.name)
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('shell.overlay'))
  const header = ctx.registered.find((r) => r.options.name === 'conversation.session.header.actions')
  assert.equal(header.options.id, 'regenerate-title')
  assert.equal(typeof header.component, 'function')
  const overlay = ctx.registered.find((r) => r.options.name === 'shell.overlay')
  assert.equal(overlay.options.id, 'session-title-regen-feedback')
})

// =============================================================================
// Client: shared flow (test hooks)
// =============================================================================

test('client: executeRegenerate resolves a successful command result despite throwing remote-root accessor', async () => {
  const executeCalls = []
  const remoteCommands = {
    execute: async (sessionId, line, images) => {
      executeCalls.push({ sessionId, line, images })
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '新标题' } } }
    },
  }
  // Production shape: reading `remote.commands` on the bare root throws
  // "cannot get property ... without inject"; the flow must still work because
  // it resolves the controller through the injected dotted name.
  assert.throws(() => {
    const { ctx } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
    ctx.get('remote').commands
  }, /without inject/)
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.deepEqual(result, { ok: true, title: '新标题' })
  assert.equal(executeCalls.length, 1)
  assert.equal(executeCalls[0].sessionId, 'sess-9')
  assert.equal(executeCalls[0].line, '/regenerate-title')
  assert.deepEqual(executeCalls[0].images, [])
})

test('client: executeRegenerate surfaces a handler error result', async () => {
  const remoteCommands = {
    execute: async () => ({ ok: true, value: { commandId: 'c2', result: { kind: 'error', text: '这个会话还没有可总结的用户提问' } } }),
  }
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.equal(result.message, '这个会话还没有可总结的用户提问')
})

test('client: executeRegenerate surfaces a failed remote result', async () => {
  const remoteCommands = {
    execute: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }),
  }
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.equal(result.message, 'boom')
})

test('client: executeRegenerate reports a missing command channel', async () => {
  const { hooks } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.ok(result.message.length > 0)
})

test('client: resolves session id from the list store by title (exact/fork/contains)', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          a: { title: 'Foo' },
          b: { title: 'Foo (1)' },
          c: { title: 'Bar' },
          d: { title: 'Foxtrot' },
        },
      }),
    },
  }
  const { hooks } = bootClient({ remoteCommands: undefined, sessions, locale: undefined })
  assert.equal(hooks.resolveSessionIdByTitle('Foo'), 'a')
  assert.equal(hooks.resolveSessionIdByTitle('Foo (1)'), 'b')
  assert.equal(hooks.resolveSessionIdByTitle('Foxt'), 'd')
  assert.equal(hooks.resolveSessionIdByTitle('Bar'), 'c')
  assert.equal(hooks.resolveSessionIdByTitle('zzz-not-there'), null)
})

// =============================================================================
// Client: sidebar "..." menu DOM injection
// =============================================================================

test('client: injects the regenerate item into the open session-row menu and fires the flow', async () => {
  const executeCalls = []
  const remoteCommands = {
    execute: async (sessionId) => {
      executeCalls.push(sessionId)
      return { ok: true, value: { commandId: 'c3', result: { kind: 'success', text: 'Foo 新标题' } } }
    },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { a: { title: 'Foo' } },
      }),
    },
  }
  const { hooks } = bootClient({ remoteCommands, sessions, locale: undefined })

  // The apply-time injection already ran; the fake document holds the open menu.
  const menu = globalThis.document.menuEl
  const item = menu.querySelector('[data-session-title-regen]')
  assert.ok(item, 'menu item should be injected')
  assert.equal(item.attrs['data-session-title-regen'], '1')
  assert.equal(item.attrs.role, 'menuitem')
  const label = item.querySelector('span')
  assert.equal(label.textContent, '重新生成标题')

  // Clicking it resolves the row title 'Foo' -> session 'a' and fires the flow.
  await item.handlers.click()
  await tick()
  assert.deepEqual(executeCalls, ['a'])
  assert.ok(windowEvents.some((e) => e.type === 'session-title-regen:result' && e.detail.ok === true))

  // Idempotent: a second ensureMenuItem call must not duplicate the item.
  hooks.ensureMenuItem()
  assert.equal(menu.querySelectorAll('[data-session-title-regen]').length, 1)
})

test('client: menu item lands inside the viewport, after the official items and before sibling plugin items', () => {
  const remoteCommands = { execute: async () => ({ ok: true, value: { commandId: 'c4', result: { kind: 'success', text: 'x' } } }) }
  const sessions = { list: { getSnapshot: () => ({ byId: { a: { title: 'Foo' } } }) } }
  const { hooks } = bootClient({ remoteCommands, sessions, locale: undefined })

  // Rebuild a faithful core-shaped menu from scratch: native items
  // (rename/fork/archive) live in the role=presentation viewport; session-delete's
  // item is a DIRECT child of [role=menu] AFTER the viewport (its observer ran
  // first). Reset the module flag so ensureMenuItem re-injects cleanly.
  const menu = globalThis.document.menuEl
  menu.children.length = 0
  const viewport = globalThis.document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  globalThis.document.viewport = viewport
  const mkItem = () => {
    const b = globalThis.document.createElement('button')
    b.setAttribute('role', 'menuitem')
    return b
  }
  const rename = mkItem()
  const fork = mkItem()
  const archive = mkItem()
  viewport.appendChild(rename)
  viewport.appendChild(fork)
  viewport.appendChild(archive)
  const deleteItem = mkItem()
  deleteItem.setAttribute('data-chameleon-delete', '1')
  menu.appendChild(deleteItem)

  hooks.reset()
  hooks.ensureMenuItem()

  // Ours is appended INSIDE the viewport, right after the native trio.
  const ourItem = viewport.children.find((c) => c.attrs && c.attrs['data-session-title-regen'])
  assert.ok(ourItem, 'regenerate item must be injected into the viewport')
  assert.equal(viewport.children.indexOf(ourItem), 3)
  assert.equal(viewport.children[0], rename)
  assert.equal(viewport.children[1], fork)
  assert.equal(viewport.children[2], archive)
  assert.equal(viewport.children.length, 4, 'viewport grows by exactly one — no separator')

  // The delete plugin item stays a sibling AFTER the viewport => visually below ours.
  const menuChildren = menu.children
  assert.ok(menuChildren.indexOf(deleteItem) > menuChildren.indexOf(viewport))
})

// =============================================================================
// Runner
// =============================================================================

let failed = 0
for (const [name, fn] of tests) {
  try {
    const maybe = fn()
    if (maybe && typeof maybe.then === 'function') await maybe
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
if (failed > 0) process.exit(1)
