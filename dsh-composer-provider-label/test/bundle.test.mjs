// Behavioural harness for dsh-composer-provider-label.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with a
// fake React + ui-primitives and a fake cordis ctx, then drives the registered
// `conversation.input.right` component through a minimal hook shim so the
// whole resolution path (projection -> catalog -> aliases -> tooltip) is
// executed and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: React semantics are
// approximated (one effect run per slot, state visible only after an explicit
// re-render). Visual/layout behaviour (Tooltip positioning, ellipsis width,
// theme tokens) still needs the manual checks in ACCEPTANCE.md.
//
// Each test re-evaluates the bundle in a FRESH module so module-level cache
// (catalog/aliases/listeners/event binding) never leaks across cases.
//
// Run: node dsh-composer-provider-label/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const indexPath = path.join(here, '..', 'src', 'index.js')
const PKG_ID = 'dsh-composer-provider-label'
const NS = 'composer-provider-label'
const SLOT = 'conversation.input.right'
const SETTINGS_NS = 'dsh-composer-provider-label'
const BUILTIN = { 'deepseek-official': 'office' }

const source = fs.readFileSync(bundlePath, 'utf8')

// --- tiny React shim (per-test instance) -------------------------------------

function makeReact() {
  let slots = []
  let index = 0
  let dirty = false
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true,
      type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        dirty = true
      }]
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
  }
  return {
    React,
    beginRender() { index = 0; dirty = false },
    freshInstance() { slots = []; index = 0; dirty = false },
    isDirty: () => dirty,
  }
}

// --- fresh browser globals + module load -------------------------------------

/** Evaluate the bundle once in a fresh window; returns the factory map. */
function bootModule(language) {
  const factories = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) } }
  const navigator = { languages: [language || 'zh-CN'], language: language || 'zh-CN' }
  const document = { body: {}, createElement: () => ({ style: {}, setAttribute() {} }) }
  // eslint-disable-next-line no-new-func -- mirroring browser classic-script evaluation
  new Function('window', 'navigator', 'document', source)(window, navigator, document)
  return { window, factories }
}

function makeLocale(log) {
  const registered = []
  return {
    registered,
    register: (ns, dicts) => { log.registered.push([ns, dicts]); return () => {} },
    // translate() returning undefined forces __t's navigator-languages fallback,
    // which is how each test pins the language.
    translate: () => undefined,
    subscribe: () => () => {},
  }
}

/**
 * A fake cordis ctx. `remote` may gain session/settings/$on later; get() reads
 * live so a late-arriving controller is picked up by the next render's
 * __ensureLoaded. ctx.on records handlers (so tests can fire connection/reset);
 * remote.$on handlers are recorded too.
 */
function makeCtx({ locale, remote, log }) {
  const registered = []
  const handlers = { on: [], remoteEvents: [], reset: [] }
  const ctx = {
    registered,
    log,
    get(name) {
      if (name === 'locale') return locale
      if (name === 'remote') return remote
      if (name === 'remote.session') return remote && remote.session
      if (name === 'remote.settings') return remote && remote.settings
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
    on(event, handler) {
      handlers.on.push([event, handler])
      if (event === 'connection/reset') handlers.reset.push(handler)
      return () => {}
    },
    inject(names, fn) {
      const sub = { get: (n) => ctx.get(n), locale }
      if (remote) sub.remote = remote
      fn(sub)
    },
    slots: {
      inject: (_slot, build) => { build(); return {} },
      register: (options, component) => {
        registered.push({ options, component })
        return { dispose() {} }
      },
    },
  }
  if (remote && typeof remote.$on === 'function') {
    const original = remote.$on
    remote.$on = (event, handler) => {
      handlers.remoteEvents.push([event, handler])
      return typeof original === 'function' ? undefined : () => {}
    }
  }
  // Simulate the real guarded context: reading `ctx.remote` as a bare property
  // when the service has not been injected throws (this is exactly what killed
  // apply on a real profile — the property fallback in __bindEvents used to
  // live outside its try/catch).
  if (remote === undefined || remote === null) {
    Object.defineProperty(ctx, 'remote', {
      configurable: true,
      enumerable: false,
      get() { throw new Error('cannot get property "remote" without inject') },
    })
  }
  ctx.handlers = handlers
  return ctx
}

function requireStub(React) {
  return (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Tooltip: (props) => props.children }
    }
    throw new Error(`unexpected require("${specifier}")`)
  }
}

/**
 * Boot one module, apply the plugin with the given remote handles, and return
 * everything needed to drive the registered component.
 */
function boot({ language = 'zh-CN', remote } = {}) {
  const { window, factories } = bootModule(language)
  const { React, beginRender, freshInstance, isDirty } = makeReact()
  const log = { registered: [] }
  const locale = makeLocale(log)
  const ctx = makeCtx({ locale, remote, log })
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  const exports_ = factory(requireStub(React))
  assert.equal(typeof exports_.apply, 'function')
  exports_.apply(ctx)
  const entry = ctx.registered[0]
  const Component = entry ? entry.component : null

  const renderStable = (ComponentRef, props, first) => {
    if (first) freshInstance()
    else beginRender()
    let tree = ComponentRef(props)
    let guard = 0
    while (isDirty() && guard < 6) {
      beginRender()
      tree = ComponentRef(props)
      guard += 1
    }
    return tree
  }

  const env = {
    window,
    ctx,
    log,
    entry,
    Component,
    render: (props) => renderStable(Component, props, true),
    rerender: (props) => renderStable(Component, props, false),
    flush: async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
  return env
}

/** Unwrap the Tooltip wrapper: { tooltip, text, aria } or null when nothing renders. */
function labelOf(tree) {
  if (!tree || !tree.__element) return null
  const tooltip = tree.props && tree.props.label
  const span = tree.props && tree.props.children
  const text = span && span.props && span.props.children
  const aria = span && span.props && span.props['aria-label']
  return { tooltip, text, aria }
}

// --- fake catalog + projection ----------------------------------------------

function catalogOf(overrides = {}) {
  const catalog = {
    default: { provider: 'codemaker', model: 'deepseek-v4-flash' },
    routableProviders: ['deepseek-official', 'ark', 'codemaker', 'bai', 'openroputer'],
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'ark', name: 'ARK (Coding Plan)', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'codemaker', name: 'codemaker', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'bai', name: 'B.AI', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'openroputer', name: 'Open Router', models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash' }] },
    ],
    failures: [],
    ...overrides,
  }
  return catalog
}

function projectionOf(next, lastUsed = null) {
  return { lastUsed, next }
}

/** Props the runtime hands a session-scoped input.right entry: a live useProjection hook. */
function compProps(sessionId, projection) {
  return { sessionId, useProjection: (key) => (key === 'modelSelection' ? projection : undefined) }
}

const SESS = { provider: 'ark', model: 'deepseek-v4-flash' }
const OFFICIAL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

// --- tests -------------------------------------------------------------------

const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- registration & locale ---------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  const { window, factories } = bootModule('zh-CN')
  const { React } = makeReact()
  const exports_ = factories.get(PKG_ID)(requireStub(React))
  assert.deepEqual(exports_.inject, ['slots'])
  assert.equal(typeof exports_.apply, 'function')
  assert.ok(window.__cpl, 'diagnostics handle published on window.__cpl')
})

test('apply registers one entry on conversation.input.right at id/order 10', () => {
  const env = boot()
  assert.equal(env.ctx.registered.length, 1)
  const { options } = env.ctx.registered[0]
  assert.equal(options.name, SLOT)
  assert.equal(options.id, 'composer-provider-label')
  assert.equal(options.order, 10)
})

test('locale dictionaries are registered under the plugin namespace', () => {
  const env = boot()
  assert.equal(env.log.registered.length, 1)
  assert.equal(env.log.registered[0][0], NS)
  assert.deepEqual(Object.keys(env.log.registered[0][1]), ['zh', 'en'])
})

// --- route resolution --------------------------------------------------------

test('no session renders nothing', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const tree = env.render(compProps(undefined, projectionOf(SESS)))
  assert.equal(tree, null)
})

test('no projection and no catalog renders nothing', () => {
  const env = boot()
  assert.equal(env.render({ sessionId: 's1', projection: undefined }), null)
})

test('explicit projection.next renders immediately, display name lands after catalog', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const early = env.render(compProps('s1', projectionOf(SESS)))
  // Catalog still loading: route known from the projection, so we show the raw id.
  assert.equal(labelOf(early).text, 'ark')
  await env.flush()
  const late = env.rerender(compProps('s1', projectionOf(SESS)))
  const label = labelOf(late)
  assert.equal(label.text, 'ARK')
  assert.match(label.tooltip, /ARK \(Coding Plan\)/)
})

test('follows the profile default when the session never selected a model', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(null, null)))
  assert.equal(labelOf(tree).text, 'codemaker')
})

test('official provider shows office via the built-in alias', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  const label = labelOf(tree)
  assert.equal(label.text, 'office')
  assert.match(label.tooltip, /DeepSeek/) // full registered name still visible
})

test('provider absent from the catalog falls back to its raw id', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const route = { provider: 'unknown-router', model: 'x' }
  env.render(compProps('s1', projectionOf(route)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.equal(labelOf(tree).text, 'unknown-router')
})

// --- tooltip content & source classification --------------------------------

test('tooltip carries provider full name, model id and an explicit-source note', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(label.tooltip, /ARK \(Coding Plan\)/)
  assert.match(label.tooltip, /deepseek-v4-flash/)
  assert.match(label.tooltip, /本会话显式选择/)
})

test('tooltip reports a carried-over last request when next equals lastUsed', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(SESS, SESS)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(SESS, SESS))))
  assert.match(label.tooltip, /沿用上一条请求/)
})

test('tooltip reports the profile default when nothing was ever chosen', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(null, null))))
  assert.match(label.tooltip, /跟随 profile 默认/)
})

// --- user-configured aliases (settings namespace) ----------------------------

test('user aliases from the settings namespace override built-in and display names', async () => {
  const describe = async () => ({
    ok: true,
    value: {
      namespaces: [{ ns: SETTINGS_NS, value: { providerAliases: { codemaker: 'cm' } } }],
    },
  })
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe },
    },
  })
  const route = { provider: 'codemaker', model: 'deepseek-v4-flash' }
  env.render(compProps('s1', projectionOf(route)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.equal(labelOf(tree).text, 'cm')
})

test('describe failure keeps the built-in alias map and never errors', async () => {
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe: async () => { throw new Error('settings provider down') } },
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, 'office')
})

test('describe without our namespace keeps the built-in alias map', async () => {
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, 'office')
})

// --- refresh on the three signals --------------------------------------------

test('llm/adapters-updated reloads the catalog', async () => {
  let calls = 0
  const modelCatalog = async () => {
    calls += 1
    return { ok: true, value: calls === 1 ? catalogOf() : catalogOf({ groups: [{ id: 'ark', name: 'ARK Two' }] }) }
  }
  const env = boot({
    remote: {
      session: { modelCatalog },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  assert.equal(calls, 1)
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(SESS)))).text, 'ARK')
  const adapter = env.ctx.handlers.remoteEvents.find(([e]) => e === 'llm/adapters-updated')
  assert.ok(adapter, 'llm/adapters-updated was subscribed')
  adapter[1]() // invalidates + notifies; the next render re-loads
  env.rerender(compProps('s1', projectionOf(SESS)))
  await env.flush()
  assert.equal(calls, 2, 'adapter update invalidated and reloaded the catalog')
  const tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(labelOf(tree).text, 'ARK Two')
})

test('settings/document-updated for our namespace reloads the alias map', async () => {
  let aliasVersion = 0
  const describe = async () => {
    aliasVersion += 1
    const aliases = aliasVersion === 1 ? {} : { 'deepseek-official': '火山官方' }
    return { ok: true, value: { namespaces: [{ ns: SETTINGS_NS, value: { providerAliases: aliases } }] } }
  }
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(OFFICIAL)))).text, 'office')
  const doc = env.ctx.handlers.remoteEvents.find(([e]) => e === 'settings/document-updated')
  assert.ok(doc, 'settings/document-updated was subscribed')
  doc[1](SETTINGS_NS) // invalidates catalog + allows one fresh alias describe
  env.rerender(compProps('s1', projectionOf(OFFICIAL))) // queued alias reload
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, '火山官方')
})

test('connection/reset is subscribed and reloads through a fresh read', async () => {
  let calls = 0
  const modelCatalog = async () => {
    calls += 1
    const name = calls === 1 ? 'ARK' : 'New Ark Branding'
    return { ok: true, value: { default: { provider: 'ark', model: 'deepseek-v4-flash' }, groups: [{ id: 'ark', name }] } }
  }
  const env = boot({
    remote: {
      session: { modelCatalog },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(null, null)))).text, 'ARK')
  assert.ok(env.ctx.handlers.reset.length >= 1, 'connection/reset was subscribed via ctx.on')
  env.ctx.handlers.reset[0]() // clears the catalog; the next render re-loads
  env.rerender(compProps('s1', projectionOf(null, null)))
  await env.flush()
  assert.equal(calls, 2, 'reset invalidated and reloaded the catalog')
  const tree = env.rerender(compProps('s1', projectionOf(null, null)))
  assert.equal(labelOf(tree).text, 'New Ark Branding')
})

// --- language ----------------------------------------------------------------

test('labels follow the client language', async () => {
  const en = boot({ language: 'en-US', remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  en.render(compProps('s1', projectionOf(SESS)))
  await en.flush()
  const enLabel = labelOf(en.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(enLabel.aria, /Model provider/)
  assert.match(enLabel.tooltip, /explicitly chosen/)

  const zh = boot({ language: 'zh-CN', remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  zh.render(compProps('s1', projectionOf(SESS)))
  await zh.flush()
  const zhLabel = labelOf(zh.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(zhLabel.aria, /模型提供方/)
})

// --- pure helpers ------------------------------------------------------------

test('pure: stripParenthetical trims only the trailing parenthetical', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  assert.equal(pure.stripParenthetical('ARK (Coding Plan)'), 'ARK')
  assert.equal(pure.stripParenthetical('ARK（正式）'), 'ARK')
  assert.equal(pure.stripParenthetical('A (B) (C)'), 'A (B)')
  assert.equal(pure.stripParenthetical('B.AI'), 'B.AI')
  assert.equal(pure.stripParenthetical('(only)'), '(only)')
  assert.equal(pure.stripParenthetical(''), '')
})

test('pure: resolveRoute follows next -> lastUsed -> default', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const catalog = catalogOf()
  const next = { provider: 'ark', model: 'm' }
  const last = { provider: 'bai', model: 'm' }
  assert.equal(pure.resolveRoute({ next, lastUsed: last }, catalog), next)
  assert.equal(pure.resolveRoute({ next: null, lastUsed: last }, catalog), last)
  assert.equal(pure.resolveRoute({ next: null, lastUsed: null }, catalog).provider, 'codemaker')
  assert.equal(pure.resolveRoute(null, catalog).provider, 'codemaker')
  assert.equal(pure.resolveRoute({ next: null, lastUsed: null }, null), null)
})

test('pure: routeSourceKey classifies explicit / reused / default', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const next = { provider: 'ark', model: 'm' }
  assert.equal(pure.routeSourceKey({ next, lastUsed: null }, next), 'source.explicit')
  assert.equal(pure.routeSourceKey({ next, lastUsed: next }, next), 'source.reused')
  assert.equal(pure.routeSourceKey({ next: null, lastUsed: null }, null), 'source.default')
  assert.equal(pure.routeSourceKey(null, { provider: 'ark' }), 'source.default')
})

test('pure: client built-in alias map matches the node half', async () => {
  const env = boot()
  assert.deepEqual(env.window.__cpl.pure.BUILTIN_ALIASES, BUILTIN)
  const node = await import('../src/index.js')
  assert.deepEqual(node.BUILTIN_ALIASES, BUILTIN)
  assert.equal(node.NS, SETTINGS_NS)
  assert.deepEqual(node.inject, [])
})

// --- node half ---------------------------------------------------------------

test('node half apply never throws when settings is absent', async () => {
  const node = await import('../src/index.js')
  let called = false
  const ctx = { inject: (names, fn) => { called = true; fn({}) } }
  assert.doesNotThrow(() => node.apply(ctx))
  assert.equal(called, true, 'the lazy settings inject was registered')
})

test('node half installs nothing when settings lacks installSection', async () => {
  const node = await import('../src/index.js')
  let registered = 0
  const ctx = { inject: (_names, fn) => fn({ settings: { register: () => { registered += 1 } } }) }
  assert.doesNotThrow(() => node.apply(ctx))
  assert.equal(registered, 0, 'only installSection (not register) may be used')
})

// --- capability audit (spec: read-only display) ------------------------------

test('capability audit: the bundle never calls a state-changing session remote', () => {
  const clientSource = fs.readFileSync(bundlePath, 'utf8')
  const nodeSource = fs.readFileSync(indexPath, 'utf8')
  // Every session remote that changes session/model state; a display-only
  // plugin must never reach any of them. `modelCatalog` (read) is allowed.
  const forbidden = [
    'selectModel', 'session/selectModel', 'updateQueue', 'prompt(', 'rename(',
    'fork(', 'create(', 'attachment(', 'cancel(', 'control(', 'rewind(', 'follow(',
  ]
  for (const token of forbidden) {
    assert.ok(!clientSource.includes(token), `client bundle must not reference state-changing "${token}"`)
    assert.ok(!nodeSource.includes(token), `node half must not reference state-changing "${token}"`)
  }
  // The only session remote it reads is the model catalog; the only settings
  // call is the read-only describe.
  assert.ok(clientSource.includes('modelCatalog'), 'client reads session.modelCatalog')
  assert.ok(clientSource.includes('describe'), 'client reads settings.describe')
  // Theme tokens only: no hardcoded colours.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(clientSource), 'no hex colour literals')
  assert.ok(!clientSource.includes('rgb('), 'no rgb() colour literals')
  assert.ok(!clientSource.includes('hsl('), 'no hsl() colour literals')
  // Writes to settings (update/replace/mutate) are forbidden too.
  for (const token of ['settings.mutate', 'settings.update', 'settings.replace']) {
    assert.ok(!clientSource.includes(token), `client must not write settings via ${token}`)
  }
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
  }
}
console.log(failed === 0 ? `\n${tests.length}/${tests.length} passed` : `\n${failed}/${tests.length} FAILED`)
process.exit(failed === 0 ? 0 : 1)
