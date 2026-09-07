// Behavioural harness for dsh-session-time-bucket/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with
// the window.__DSH_TEST__ hook enabled, and asserts the pure projection
// logic (calendar bucket boundaries, visibility filtering, workspace-title
// prefix, empty-bucket hiding, bucket ordering, locale copy) plus the
// bundle contract. DOM mounting itself is left to ACCEPTANCE.md.
//
// Run: node dsh-session-time-bucket/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-session-time-bucket'

// --- browser-ish globals ------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

const factories = new Map()
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 1,
  clearInterval() {},
}
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  createTextNode: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { appendChild() {} },
}

// localStorage stub: the follower reads the core's persisted view store.
const storage = new Map()
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}

// --- load the bundle ----------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', source)(globalThis.window, globalThis.navigator, globalThis.document)

const tests = []
const test = (name, fn) => tests.push([name, fn])

const factory = factories.get(PKG_ID)
assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
// This plugin requires nothing from the module loader (no React, no primitives).
const exports = factory(() => { throw new Error('unexpected require()') })
const hooks = globalThis.window.__sessionTimeBucketTest
assert.ok(hooks, 'window.__DSH_TEST__ hook object missing')

const { bucketKeyOf, collectRows, rowTitle, deriveBuckets, relativeLabel, workspaceTitleBySession, isFlatUpdatedView, __t, enDict } = hooks
const DAY = 86400000
// Fixed local "now": 2026-09-06 12:00 (Sep 6 is a Sunday; weekday is irrelevant).
const nowMs = new Date(2026, 8, 6, 12, 0, 0).getTime()
const startToday = new Date(2026, 8, 6).getTime()

// --- assertions ----------------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('calendar bucket boundaries (local natural days)', () => {
  // today: [startToday, +inf)
  assert.equal(bucketKeyOf(startToday, nowMs), 'today')
  assert.equal(bucketKeyOf(startToday + 2 * 3600 * 1000, nowMs), 'today')
  // yesterday: [startToday-1d, startToday)
  assert.equal(bucketKeyOf(startToday - 1, nowMs), 'yesterday')
  assert.equal(bucketKeyOf(startToday - DAY + 3 * 3600 * 1000, nowMs), 'yesterday')
  // last7: [startToday-7d, startToday-1d)
  assert.equal(bucketKeyOf(startToday - 3 * DAY, nowMs), 'last7')
  assert.equal(bucketKeyOf(startToday - 6 * DAY, nowMs), 'last7')
  assert.equal(bucketKeyOf(startToday - DAY - 1, nowMs), 'last7')
  // last30: [startToday-30d, startToday-7d)
  assert.equal(bucketKeyOf(startToday - 7 * DAY - 1, nowMs), 'last30')
  assert.equal(bucketKeyOf(startToday - 29 * DAY, nowMs), 'last30')
  // older
  assert.equal(bucketKeyOf(startToday - 30 * DAY - 1, nowMs), 'older')
  assert.equal(bucketKeyOf(startToday - 400 * DAY, nowMs), 'older')
})

test('startOfLocalDay is DST/midnight-safe for the reference instant', () => {
  assert.equal(hooks.startOfLocalDay(startToday + 12 * 3600 * 1000), startToday)
})

test('workspaceTitleBySession maps membership to titles', () => {
  const items = [
    { workspaceId: 'w1', title: 'dsh-tmp', sessionIds: ['a', 'b'] },
    { workspaceId: 'w2', title: 'repo', sessionIds: ['c'] },
  ]
  const map = workspaceTitleBySession(items)
  assert.equal(map.a, 'dsh-tmp')
  assert.equal(map.b, 'dsh-tmp')
  assert.equal(map.c, 'repo')
  assert.equal(map.z, undefined)
})

test('collectRows applies core-equivalent visibility', () => {
  const byId = {
    a: { id: 'a', displayTitle: '会话A', updatedAt: nowMs, blank: false },
    b: { id: 'b', displayTitle: '子代理', updatedAt: nowMs, origin: 'subagent', blank: false },
    c: { id: 'c', displayTitle: '别的空白', updatedAt: nowMs, blank: true },
    d: { id: 'd', displayTitle: '当前空白', updatedAt: nowMs, blank: true },
    e: { id: 'e', displayTitle: '已归档', updatedAt: nowMs, blank: false },
    f: { id: 'f', displayTitle: '', updatedAt: nowMs, blank: false },
    g: { id: 'g', displayTitle: '运行中', updatedAt: nowMs, blank: false, running: true },
    h: { id: 'h', displayTitle: '已完成', updatedAt: nowMs, blank: false, completed: true },
  }
  const list = { byId, current: 'd' }
  const rows = collectRows(list, ['e'], workspaceTitleBySession([{ workspaceId: 'w', title: 'ws-a', sessionIds: ['a'] }]))
  const ids = rows.map((row) => row.id).sort()
  assert.deepEqual(ids, ['a', 'd', 'f', 'g', 'h'])
  const a = rows.find((row) => row.id === 'a')
  const d = rows.find((row) => row.id === 'd')
  assert.equal(a.wsTitle, 'ws-a')
  assert.equal(a.blank, false)
  assert.equal(a.current, false)
  assert.equal(d.blank, true)
  assert.equal(d.current, true)
  assert.equal(d.wsTitle, undefined)
  const f = rows.find((row) => row.id === 'f')
  assert.equal(f.title, '')
  const g = rows.find((row) => row.id === 'g')
  assert.equal(g.running, true)
  assert.equal(g.completed, false)
  const h = rows.find((row) => row.id === 'h')
  assert.equal(h.running, false)
  assert.equal(h.completed, true)
})

test('rowTitle prefixes workspace / ungrouped and honors the switch', () => {
  const plain = { blank: false, title: '写插件', wsTitle: 'dsh-tmp' }
  assert.equal(rowTitle(plain, true, '未分组'), '[dsh-tmp] 写插件')
  assert.equal(rowTitle({ ...plain, wsTitle: undefined }, true, '未分组'), '[未分组] 写插件')
  assert.equal(rowTitle({ ...plain, wsTitle: '' }, true, '未分组'), '[未分组] 写插件')
  assert.equal(rowTitle(plain, false, '未分组'), '写插件')
  assert.equal(rowTitle({ ...plain, blank: true }, true, '未分组'), '')
})

test('deriveBuckets groups, sorts newest-first and hides empty buckets', () => {
  const mk = (id, updatedAt, extra) => ({ id, title: id, updatedAt, blank: false, wsTitle: undefined, current: false, ...extra })
  const rows = [
    mk('o', startToday - 40 * DAY),                 // older
    mk('d', startToday - 3 * DAY + 1000),           // last7
    mk('y', startToday - 1),                        // yesterday
    mk('t1', startToday + 3600 * 1000),             // today (older of the two)
    mk('t2', startToday + 7200 * 1000),             // today (newest)
    // no last30 row on purpose
  ]
  const buckets = deriveBuckets(rows, nowMs)
  assert.deepEqual(buckets.map((b) => b.key), ['today', 'yesterday', 'last7', 'older'])
  assert.deepEqual(buckets[0].rows.map((r) => r.id), ['t2', 't1'])
  assert.deepEqual(buckets[1].rows.map((r) => r.id), ['y'])
  assert.deepEqual(buckets[2].rows.map((r) => r.id), ['d'])
  assert.deepEqual(buckets[3].rows.map((r) => r.id), ['o'])
})

test('follows the core view store: enhances only 单列表+最近更新', () => {
  const view = (groupBy, orderBy) => storage.set('dsh.workspace.view.v5', JSON.stringify({ groupBy, orderBy }))
  view('flat', 'updated')
  assert.equal(isFlatUpdatedView(), true)
  view('workspace', 'updated')
  assert.equal(isFlatUpdatedView(), false)
  view('flat', 'manual')
  assert.equal(isFlatUpdatedView(), false)
  view('workspace', 'manual')
  assert.equal(isFlatUpdatedView(), false)
  storage.delete('dsh.workspace.view.v5')
  assert.equal(isFlatUpdatedView(), false)
  storage.set('dsh.workspace.view.v5', '{broken')
  assert.equal(isFlatUpdatedView(), false)
  storage.delete('dsh.workspace.view.v5')
})

test('zh copy resolves and en dictionary exists', () => {
  assert.equal(__t('bucket.today'), '今天')
  assert.equal(__t('bucket.yesterday'), '昨天')
  assert.equal(__t('bucket.last7'), '前7天')
  assert.equal(__t('bucket.last30'), '前30天')
  assert.equal(__t('bucket.older'), '更早')
  assert.equal(__t('ungrouped'), '未分组')
  assert.equal(enDict['bucket.today'], 'Today')
  assert.equal(enDict['ungrouped'], 'Ungrouped')
})

test('relative time labels humanize instants', () => {
  const at = (delta) => relativeLabel(nowMs - delta, nowMs, __t)
  assert.equal(at(5 * 1000), '刚刚')
  assert.equal(at(2 * 60 * 1000), '2分钟前')
  assert.equal(at(3 * 3600 * 1000), '3小时前')
  assert.equal(at(2 * DAY), '2天前')
  assert.equal(at(40 * DAY), '1个月前')
  assert.equal(at(400 * DAY), '1年前')
  assert.equal(__t('rel.day'), '{n}天前')
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  -', name) }
  catch (error) { failed += 1; console.error('FAIL-', name); console.error(error) }
}
console.log(`\n${tests.length - failed}/${tests.length} assertions passed`)
if (failed > 0) process.exitCode = 1