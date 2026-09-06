// Behavioural harness for dsh-composer-history-recall/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with a
// minimal deps-aware React shim and a fake composer DOM, then drives the
// document capture keydown handler directly so the recall logic (entry gating,
// browse advance, boundaries, resets, history derivation, locale) is executed
// and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: real Lexical selection geometry
// and the composer's own key handling are approximated by the fake caret. The
// parts that need a real browser are listed in ACCEPTANCE.md.
//
// Run: node dsh-composer-history-recall/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-composer-history-recall'
const NS = 'composer-history-recall'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

let currentSelection = null
let keydownHandler = null
let keydownCapture = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => currentSelection,
}
globalThis.document = {
  body: {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  activeElement: null,
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

function makeCtx(locale) {
  const registered = []
  return {
    registered,
    locale,
    get: (name) => (name === 'locale' ? locale : undefined),
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => { fn({ locale }) },
    slots: {
      inject: (slotName, build) => { build(); return { registered } },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
}

// --- fake composer DOM -------------------------------------------------------

function makeComposerEditor(blockTexts) {
  const editorEl = {
    hasAttribute: (a) => a === 'data-composer-input',
    contains: () => true,
    children: [],
  }
  editorEl.children = blockTexts.map((text) => ({ parentElement: editorEl, _text: text }))
  return editorEl
}
function caretIn(editorEl, line, offset) {
  const block = editorEl.children[line]
  const textNode = { nodeType: 3, parentElement: block, textContent: block._text }
  return { rangeCount: 1, isCollapsed: true, anchorNode: textNode, anchorOffset: offset }
}

function makeChat(nodes) {
  // Real ChatSnapshot shape: raw ConversationNode[] under legacy.nodes, plus a
  // view-node store whose get() returns renderer nodes with payload under .data.
  const raw = nodes.map((n, i) => ({ kind: n.kind, seq: i, time: 0, content: n.content, source: {} }))
  const viewMap = new Map(nodes.map((n) => [n.key, { kind: n.kind, target: 'chat', data: { kind: n.kind, content: n.content } }]))
  return {
    order: nodes.map((n) => n.key),
    nodes: { get: (k) => viewMap.get(k) },
    legacy: { nodes: raw },
  }
}
function userNode(key, text) { return { key, kind: 'user', content: [{ type: 'text', text }] } }
function assistantNode(key, text) { return { key, kind: 'assistant', content: [{ type: 'text', text }] } }

// --- scenario driver ---------------------------------------------------------

function mount({ chat, draft = '', occurrences = [], sessionId = 'sess-1' } = {}) {
  const locale = { register: () => () => {}, translate: () => undefined, subscribe: () => () => {} }
  const ctx = makeCtx(locale)
  freshApply().apply(ctx)
  const component = ctx.registered[0].component

  const drafts = []
  const env = {
    drafts,
    chat,
    draft,
    occurrences,
    sessionId,
    editor: makeComposerEditor(draft === '' ? [''] : draft.split('\n')),
  }
  env.inputActions = { setDraft: (text) => { drafts.push(text); env.draft = text; env.editor = makeComposerEditor(text === '' ? [''] : text.split('\n')) } }
  env.useConversation = (selector) => selector({ views: { get: (t) => (t === 'chat' ? env.chat : undefined) } })
  env.useInput = (selector) => selector({ draft: env.draft, occurrences: env.occurrences, phase: 'plain', draftRev: 0 })

  const props = () => ({
    sessionId: env.sessionId,
    useConversation: env.useConversation,
    useInput: env.useInput,
    inputActions: env.inputActions,
    t: (k) => k,
  })
  const render = (first) => { if (first) freshInstance(); else beginRender(); return component(props()) }
  // A returned element whose type is a function (the Toast stub) must be invoked
  // for its side effect to register — the shim does not walk the tree.
  const materialize = (tree) => {
    if (tree && tree.__element && typeof tree.type === 'function') { try { tree.type(tree.props) } catch { /* noop */ } }
    return tree
  }
  env.render = () => { let tree = render(true); if (isDirty()) tree = render(false); return materialize(tree) }
  env.rerender = () => { let tree = render(false); if (isDirty()) tree = render(false); return materialize(tree) }
  env.focus = (line = 0, offset = 0) => { document.activeElement = env.editor; currentSelection = caretIn(env.editor, line, offset) }
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

// --- assertions --------------------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  assert.ok(factories.has(PKG_ID), 'no __ModuleLoader__.load for the package id')
  const exports = freshApply()
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers one overlay entry at the agreed slot/id/order', () => {
  const ctx = makeCtx({ register: () => () => {}, translate: () => undefined, subscribe: () => () => {} })
  freshApply().apply(ctx)
  assert.equal(ctx.registered.length, 1)
  const { options } = ctx.registered[0]
  assert.equal(options.name, 'conversation.input.overlay')
  assert.equal(options.id, 'composer-history-recall')
  assert.equal(options.order, 50)
})

test('locale dictionaries are registered under the plugin namespace', () => {
  const registered = []
  const locale = { register: (ns, dicts) => { registered.push([ns, Object.keys(dicts)]); return () => {} }, translate: () => undefined, subscribe: () => () => {} }
  freshApply().apply(makeCtx(locale))
  assert.equal(registered.length, 1)
  assert.equal(registered[0][0], NS)
  assert.deepEqual(registered[0][1], ['zh', 'en'])
})

test('the keydown listener is attached in the capture phase', () => {
  const env = mount({ chat: makeChat([userNode('1', 'hello')]) })
  assert.ok(keydownHandler, 'no keydown listener attached')
  assert.equal(keydownCapture, true, 'listener must be capture-phase')
  assert.equal(env.render(), null, 'bridge renders nothing without a toast')
})

test('ArrowUp on an empty focused composer recalls the newest sent message', () => {
  const env = mount({ chat: makeChat([userNode('1', 'first'), assistantNode('2', 'reply'), userNode('3', 'second')]) })
  env.focus(0, 0)
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, true, 'recall must consume the event')
  assert.deepEqual(env.drafts, ['second'], 'newest user message first, assistant ignored')
})

test('history is newest-first, user-only, blanks dropped', () => {
  const env = mount({ chat: makeChat([
    userNode('1', 'first'), assistantNode('2', 'reply'), userNode('3', 'second'),
    userNode('4', '   '), userNode('5', 'third'),
  ]) })
  env.focus(0, 0)
  env.press('ArrowUp'); env.press('ArrowUp'); env.press('ArrowUp')
  assert.deepEqual(env.drafts, ['third', 'second', 'first'])
})

test('consecutive ArrowUp walks older; boundary stays and toasts', () => {
  const env = mount({ chat: makeChat([userNode('1', 'a'), userNode('2', 'b')]) })
  env.focus(0, 0)
  env.press('ArrowUp') // b
  env.press('ArrowUp') // a
  const atOldest = env.press('ArrowUp') // boundary
  assert.equal(atOldest, true, 'boundary still consumes so the caret does not move')
  assert.deepEqual(env.drafts, ['b', 'a'], 'no further setDraft at the boundary')
  assert.ok(toasts.includes('toast.oldest'), 'expected the reached-oldest toast')
})

test('ArrowDown past newest exits browse and restores the saved draft', () => {
  const env = mount({ chat: makeChat([userNode('1', 'a'), userNode('2', 'b')]), draft: '' })
  env.focus(0, 0)
  env.press('ArrowUp') // b (savedDraft '')
  env.press('ArrowUp') // a
  env.press('ArrowDown') // b
  env.press('ArrowDown') // exit -> restore ''
  assert.deepEqual(env.drafts, ['b', 'a', 'b', ''])
})

test('entry from a non-empty first-line draft preserves it as savedDraft', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: 'typing' })
  env.focus(0, 0)
  env.press('ArrowUp') // recall older, savedDraft 'typing'
  env.press('ArrowDown') // exit -> restore 'typing'
  assert.deepEqual(env.drafts, ['older', 'typing'])
})

test('multi-line draft with caret on a middle line does not hijack ArrowUp', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: 'l1\nl2\nl3' })
  env.focus(1, 0) // middle block
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false, 'must pass through to the editor')
  assert.deepEqual(env.drafts, [], 'no recall when caret is not on the first line')
})

test('caret on the first block of a multi-line draft enters browse', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: 'l1\nl2\nl3' })
  env.focus(0, 1) // first block
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, true)
  assert.deepEqual(env.drafts, ['older'])
})

test('reference chips in the draft suppress recall', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: '', occurrences: [{ occurrenceId: 1 }] })
  env.focus(0, 0)
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false, 'occurrences>0 must pass through')
  assert.deepEqual(env.drafts, [])
})

test('an active slash/mention token suppresses recall', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: '/comm' })
  env.focus(0, 5) // caret after "/comm"
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false, 'slash token must defer to the command menu')
  assert.deepEqual(env.drafts, [])
})

test('no history keeps ArrowUp native', () => {
  const env = mount({ chat: makeChat([assistantNode('1', 'only reply')]), draft: '' })
  env.focus(0, 0)
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false)
  assert.deepEqual(env.drafts, [])
})

test('unfocused composer ignores the arrow keys', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]) })
  document.activeElement = { hasAttribute: () => false }
  currentSelection = null
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false)
  assert.deepEqual(env.drafts, [])
})

test('modifier and IME-composing arrows are never hijacked', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]) })
  env.focus(0, 0)
  assert.equal(env.press('ArrowUp', { shiftKey: true }), false)
  assert.equal(env.press('ArrowUp', { isComposing: true }), false)
  assert.equal(env.press('ArrowUp', { keyCode: 229 }), false)
  assert.deepEqual(env.drafts, [])
})

test('ArrowDown before entering browse is a no-op', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: '' })
  env.focus(0, 0)
  const prevented = env.press('ArrowDown')
  assert.equal(prevented, false, 'nothing newer than the live draft')
  assert.deepEqual(env.drafts, [])
})

test('manual edit while browsing resets the cursor to newest', () => {
  const env = mount({ chat: makeChat([userNode('1', 'a'), userNode('2', 'b')]), draft: '' })
  env.focus(0, 0)
  env.press('ArrowUp') // b
  env.press('ArrowUp') // a (index 1)
  // simulate the user typing: draft diverges from what we wrote
  env.draft = 'a edited'
  env.editor = makeComposerEditor(['a edited'])
  env.rerender() // draft effect fires -> index reset
  env.focus(0, 0)
  env.press('ArrowUp') // re-enter from newest
  assert.deepEqual(env.drafts, ['b', 'a', 'b'], 'after edit, ArrowUp restarts at newest')
})

test('switching sessions resets the cursor and uses the new history', () => {
  const env = mount({ chat: makeChat([userNode('1', 'old-session')]), draft: '' })
  env.focus(0, 0)
  env.press('ArrowUp') // old-session
  // switch session: new chat + new sessionId
  env.chat = makeChat([userNode('9', 'new-session')])
  env.sessionId = 'sess-2'
  env.draft = ''
  env.editor = makeComposerEditor([''])
  env.rerender() // session effect resets index
  env.focus(0, 0)
  env.press('ArrowUp')
  assert.deepEqual(env.drafts, ['old-session', 'new-session'])
})

test('recall never auto-submits: submit is never called', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]) })
  let submitted = 0
  env.inputActions.submit = () => { submitted += 1 }
  env.focus(0, 0)
  env.press('ArrowUp'); env.press('ArrowUp'); env.press('ArrowDown')
  assert.equal(submitted, 0, 'the bridge must not submit')
})

test('empty composer with an unreadable selection still recalls (caret fallback)', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: '' })
  document.activeElement = env.editor // focused composer
  currentSelection = null // selection read fails -> readCaretLine returns null
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, true, 'empty draft is unambiguously the first line')
  assert.deepEqual(env.drafts, ['older'])
})

test('a non-empty draft with an unreadable selection passes through (no false recall)', () => {
  const env = mount({ chat: makeChat([userNode('1', 'older')]), draft: 'some text' })
  document.activeElement = env.editor
  currentSelection = null
  const prevented = env.press('ArrowUp')
  assert.equal(prevented, false, 'cannot prove first-line, so defer to the editor')
  assert.deepEqual(env.drafts, [])
})

test('diagnostics surface reports the wiring state on window.__dshr', () => {
  const env = mount({ chat: makeChat([userNode('1', 'a'), userNode('2', 'b')]) })
  const d = globalThis.window.__dshr
  assert.equal(d.applied, true)
  assert.equal(d.hasActions, true)
  assert.equal(d.hasConv, true)
  assert.equal(d.historyLen, 2)
  env.focus(0, 0)
  env.press('ArrowUp')
  assert.equal(d.recalls, 1)
  assert.equal(d.lastGate, 'recall:0')
})

test('deriveHistory falls back to view-node .data.content when legacy slice is absent', () => {
  const viewOnly = {
    order: ['1', '2'],
    nodes: { get: (k) => ({ kind: 'user', target: 'chat', data: { content: [{ type: 'text', text: k === '1' ? 'older' : 'newer' }] } }) },
  }
  const env = mount({ chat: viewOnly })
  env.focus(0, 0)
  env.press('ArrowUp')
  assert.deepEqual(env.drafts, ['newer'], 'newest-first via the view-node fallback')
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
