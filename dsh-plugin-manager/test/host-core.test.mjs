// Pure-logic tests for dsh-plugin-manager host-core (no DSH host, no real profile).
//
// Run: node dsh-plugin-manager/test/host-core.test.mjs
//
// Fixtures are created under a temporary dir and removed afterwards. The YAML
// file IO is exercised through a JSON-subset engine stub (JSON is valid YAML
// and round-trips deterministically); exercising the real js-yaml `!!js`
// schema is a live-profile acceptance item (js-yaml lives in the profile's
// node_modules, not in this repo).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANAGER_DIR,
  RETIRED_PLUGIN_DIRS,
  listRepoPluginDirs,
  readPluginMeta,
  rowIdOfDir,
  linkSpecOf,
  findRow,
  upsertManaged,
  removeManaged,
  stripOverrideRows,
  deriveStates,
  planMigration,
  makeYamlEngine,
  PLUGINS_DIRNAME,
  pluginRootsOf,
  pluginAbsDirOf,
  staleLinkSpec,
  INTENT_DEBOUNCE_MS,
  mergeIntent,
  applyIntents,
  upsertManagedMany,
  batchPlan,
  BATCH_REASONS,
  removePlan,
  REMOVE_REASONS,
  LINK_STATES,
  linkStateOf,
  sameLinkTarget,
  relinkPlan,
  RELINK_REASONS,
} from '../src/host-core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-test-'))

/** JSON-subset yaml stub: fixtures are JSON, so load/dump === parse/stringify. */
function jsonEngine() {
  return {
    loadText(text) { return JSON.parse(text) },
    dumpText(rows) { return JSON.stringify(rows) },
  }
}

function writeRepo(root, dirs) {
  for (const dir of dirs) {
    const dp = path.join(root, dir)
    fs.mkdirSync(dp, { recursive: true })
    fs.writeFileSync(
      path.join(dp, 'package.json'),
      JSON.stringify({
        name: dir,
        description: `${dir} description`,
        main: 'src/index.js',
        exports: { '.': './src/index.js', './client': './src/client.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      }),
    )
  }
}

function samplePlugins(root) {
  writeRepo(root, [
    'dsh-aaa',
    'dsh-bbb',
    'dsh-ccc',
  ])
  fs.mkdirSync(path.join(root, 'dsh-notreal'), { recursive: true }) // no package.json
  return listRepoPluginDirs(root).map((d) => readPluginMeta(root, d))
}

// --- repo scanning -----------------------------------------------------------

{
  const repo = path.join(tmpRoot, 'scan')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(repo, ['dsh-one', 'dsh-two'])
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
  const dirs = listRepoPluginDirs(repo)
  assert.deepEqual(dirs, ['dsh-one', 'dsh-two'], 'only dsh-* dirs, manager excluded when absent')
  const meta = readPluginMeta(repo, 'dsh-one')
  assert.equal(meta.valid, true)
  assert.equal(meta.name, 'dsh-one')
  assert.equal(meta.rowId, 'one')
  assert.equal(meta.hasClient, true)
  const bad = readPluginMeta(repo, 'dsh-two')
  fs.rmSync(path.join(repo, 'dsh-two', 'package.json'))
  const bad2 = readPluginMeta(repo, 'dsh-two')
  assert.equal(bad.valid, true)
  assert.equal(bad2.valid, false)
  assert.equal(bad2.error, 'no-plugin-package')
  assert.equal(rowIdOfDir('dsh-session-time-bucket'), 'session-time-bucket')
  assert.equal(linkSpecOf('D:\\a b\\c'), 'link:D:/a b/c')
}

{
  // Retired plugin dirs: the source stays in the repo, the panel never lists it.
  const repo = path.join(tmpRoot, 'retired')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(path.join(repo, PLUGINS_DIRNAME), ['dsh-keep', ...RETIRED_PLUGIN_DIRS])
  writeRepo(repo, [...RETIRED_PLUGIN_DIRS]) // the half-migrated copy must be skipped too
  assert.ok(RETIRED_PLUGIN_DIRS.length > 0, 'sanity: the retired list is expected to hold the superseded plugin')
  assert.deepEqual(
    listRepoPluginDirs(repo),
    ['dsh-keep'],
    'a retired plugin dir is skipped by the scan even when it sits in both roots',
  )
  assert.equal(
    readPluginMeta(repo, RETIRED_PLUGIN_DIRS[0]).valid,
    true,
    'the retired plugin keeps a readable manifest: retirement is a scan exclusion, not a deletion',
  )
}

// --- patch row transforms ----------------------------------------------------

{
  // baseline: mcp-style rows + a plain override row + our managed insert rows
  const rows = [
    { id: 'dsh-liquid-glass', disabled: false },
    { insert: [{ id: 'mcp-CodeMap', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'CodeMap' } }] },
    { insert: [{ id: 'aaa', name: 'dsh-aaa' }] },
  ]
  assert.equal(findRow(rows, 'aaa').kind, 'item')
  assert.equal(findRow(rows, 'dsh-liquid-glass').kind, 'row')
  assert.equal(findRow(rows, 'nope'), null)

  // disable existing insert item (keeps row, sets disabled)
  let next = upsertManaged(rows, 'aaa', 'dsh-aaa', false)
  assert.equal(next.length, 3, 'row count unchanged when disabling existing item')
  assert.equal(findRow(next, 'aaa').item.disabled, true)

  // re-enable
  next = upsertManaged(next, 'aaa', 'dsh-aaa', true)
  assert.equal(findRow(next, 'aaa').item.disabled, undefined)

  // add a brand-new managed plugin
  next = upsertManaged(next, 'bbb', 'dsh-bbb', true)
  assert.equal(next.length, 4)
  assert.equal(findRow(next, 'bbb').item.name, 'dsh-bbb')
  assert.equal(findRow(next, 'bbb').item.disabled, undefined)

  // convert a plain override row into canonical insert item
  let withOverride = [{ id: 'ccc', name: 'dsh-ccc', disabled: true }]
  let converted = upsertManaged(withOverride, 'ccc', 'dsh-ccc', true)
  assert.equal(converted.length, 1)
  assert.equal(converted[0].insert[0].id, 'ccc')
  assert.equal(converted[0].insert[0].disabled, undefined)

  // remove: deletes item, drops emptied row, keeps other rows
  let removed = removeManaged(rows, 'aaa')
  assert.equal(findRow(removed, 'aaa'), null)
  assert.equal(findRow(removed, 'mcp-CodeMap').item.name, '@deepseek-ai/dsh-mcp-client', 'foreign rows untouched')
  removed = removeManaged(removed, 'mcp-CodeMap')
  assert.equal(findRow(removed, 'mcp-CodeMap'), null)
  assert.equal(removed.some((r) => r.id === 'dsh-liquid-glass'), true, 'override row untouched')

  // stripOverrideRows removes only the given ids
  const s = stripOverrideRows([{ id: 'aaa', disabled: true }, { id: 'keep', disabled: true }], ['aaa'])
  assert.equal(s.length, 1)
  assert.equal(s[0].id, 'keep')
}

// --- state derivation --------------------------------------------------------

{
  const repo = path.join(tmpRoot, 'states')
  fs.mkdirSync(repo, { recursive: true })
  const plugins = samplePlugins(repo) // aaa, bbb, ccc valid + notreal invalid
  const manifest = {
    dependencies: { 'dsh-aaa': 'link:./dsh-aaa', 'dsh-ccc': 'link:./dsh-ccc' },
    devDependencies: { 'dsh-bbb': 'link:./dsh-bbb' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-aaa', 'dsh-ccc'] } },
  }
  const rows = [
    { insert: [{ id: 'bbb', name: 'dsh-bbb' }] },          // active row
    { id: 'ccc', name: 'dsh-ccc', disabled: true },        // legacy-disabled override
  ]
  const states = deriveStates({ repoPlugins: plugins, manifest, rows })
  const byDir = Object.fromEntries(states.map((s) => [s.dir, s]))

  assert.equal(byDir['dsh-aaa'].state, 'legacy', 'in bundles+deps = legacy (active)')
  assert.equal(byDir['dsh-aaa'].active, true)
  assert.equal(byDir['dsh-bbb'].state, 'active', 'devDep + enabled row = active')
  assert.equal(byDir['dsh-bbb'].active, true)
  assert.equal(byDir['dsh-bbb'].installWhere, 'devDependencies')
  assert.equal(byDir['dsh-ccc'].state, 'legacy', 'disabled override on bundle row still legacy')
  assert.equal(byDir['dsh-ccc'].active, false)
  assert.equal(byDir['dsh-notreal'].state, 'invalid')
  assert.equal(states.length, 4)

  // uninstalled + inactive
  const man2 = { dependencies: {}, devDependencies: { 'dsh-aaa': 'link:./dsh-aaa' } }
  const st2 = deriveStates({ repoPlugins: plugins.filter((p) => p.dir === 'dsh-aaa'), manifest: man2, rows: [] })
  assert.equal(st2[0].state, 'inactive')
  const man3 = { dependencies: {}, devDependencies: {} }
  const st3 = deriveStates({ repoPlugins: plugins.filter((p) => p.dir === 'dsh-aaa'), manifest: man3, rows: [] })
  assert.equal(st3[0].state, 'uninstalled')
}

// --- migration planning ------------------------------------------------------

{
  const repo = path.join(tmpRoot, 'migrate')
  fs.mkdirSync(repo, { recursive: true })
  const plugins = listRepoPluginDirs(writeRepo(repo, ['dsh-aaa', 'dsh-bbb', 'dsh-ccc']) || repo).map((d) => readPluginMeta(repo, d))
  // Legacy profile: all three in dependencies, two in bundles; one disabled by override
  const manifest = {
    name: 'dsh-profile-web',
    dependencies: {
      'dsh-aaa': 'link:D:/repo/dsh-aaa',
      'dsh-bbb': 'link:D:/repo/dsh-bbb',
      'dsh-ccc': 'link:D:/repo/dsh-ccc',
      'dsh-local-plugins': 'link:D:/repo',
    },
    devDependencies: { 'dsh-zzz': 'link:D:/elsewhere' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-aaa', 'dsh-bbb', 'dsh-local-plugins'] } },
  }
  const rows = [{ id: 'ccc', name: 'dsh-ccc', disabled: true }] // disabled override for ccc
  const plan = planMigration({ repoPlugins: plugins, manifest, rows, repoRoot: repo })

  assert.equal(plan.needsMigration, true)
  const nm = plan.newManifest
  assert.equal(nm.devDependencies['dsh-aaa'], linkSpecOf(path.join(repo, 'dsh-aaa')))
  assert.equal(nm.dependencies['dsh-aaa'], undefined)
  assert.equal(nm.dependencies['dsh-local-plugins'], undefined, 'umbrella retired from deps')
  assert.deepEqual(nm.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app', 'dsh-plugin-manager'], 'bundles: only manager remains local')
  assert.equal(nm.devDependencies['dsh-zzz'], 'link:D:/elsewhere', 'foreign devDep untouched')

  const final = plan.finalRows
  assert.equal(findRow(final, 'aaa').item.name, 'dsh-aaa')
  assert.equal(findRow(final, 'aaa').item.disabled, undefined, 'aaa stays active')
  assert.equal(findRow(final, 'bbb').item.disabled, undefined, 'bbb stays active')
  assert.equal(findRow(final, 'ccc').item.disabled, true, 'ccc stays disabled')
  assert.equal(final.some((r) => r.id === 'ccc'), false, 'plain override row converted away')
}

// --- plan with already-migrated profile is a no-op ---------------------------

{
  const repo = path.join(tmpRoot, 'nomigrate')
  fs.mkdirSync(repo, { recursive: true })
  const plugins = listRepoPluginDirs(writeRepo(repo, ['dsh-aaa']) || repo).map((d) => readPluginMeta(repo, d))
  const manifest = {
    dependencies: { 'dsh-plugin-manager': 'link:D:/repo/dsh-plugin-manager' },
    devDependencies: { 'dsh-aaa': linkSpecOf(path.join(repo, 'dsh-aaa')) },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-plugin-manager'] } },
  }
  const rows = [{ insert: [{ id: 'aaa', name: 'dsh-aaa' }] }]
  const plan = planMigration({ repoPlugins: plugins, manifest, rows, repoRoot: repo })
  assert.equal(plan.needsMigration, false, 'migrated profile: no further changes')
  assert.deepEqual(plan.summary.moved, [])
}

// --- sub-plugins/ nested layout (preferred plugin root) ----------------------

{
  const repo = path.join(tmpRoot, 'nested')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(path.join(repo, PLUGINS_DIRNAME), ['dsh-one', 'dsh-two', MANAGER_DIR])

  assert.deepEqual(
    pluginRootsOf(repo),
    [path.join(repo, PLUGINS_DIRNAME), repo],
    'nested root first, repo root kept as the legacy fallback',
  )
  assert.deepEqual(listRepoPluginDirs(repo), ['dsh-one', 'dsh-two'], 'nested plugins found, manager dir excluded')
  const meta = readPluginMeta(repo, 'dsh-one')
  assert.equal(meta.valid, true)
  assert.equal(meta.dirPath, path.join(repo, PLUGINS_DIRNAME, 'dsh-one'), 'dirPath resolves into sub-plugins/')
  assert.equal(pluginAbsDirOf(repo, 'dsh-one'), path.join(repo, PLUGINS_DIRNAME, 'dsh-one'))
  assert.equal(pluginAbsDirOf(repo, 'dsh-absent'), path.join(repo, 'dsh-absent'), 'unknown dir falls back to flat path')
}

{
  // Half-migrated repo: the same plugin dir exists in both roots → union, nested wins.
  const repo = path.join(tmpRoot, 'partial')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(repo, ['dsh-flat'])
  writeRepo(path.join(repo, PLUGINS_DIRNAME), ['dsh-flat', 'dsh-moved'])

  assert.deepEqual(listRepoPluginDirs(repo), ['dsh-flat', 'dsh-moved'], 'union of both roots, deduped by name')
  assert.equal(pluginAbsDirOf(repo, 'dsh-flat'), path.join(repo, PLUGINS_DIRNAME, 'dsh-flat'), 'nested copy wins')
  assert.equal(readPluginMeta(repo, 'dsh-flat').dirPath, path.join(repo, PLUGINS_DIRNAME, 'dsh-flat'))
}

{
  // Migration must link the directory the plugin actually lives in.
  const repo = path.join(tmpRoot, 'nested-migrate')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(path.join(repo, PLUGINS_DIRNAME), ['dsh-aaa'])
  const plugins = listRepoPluginDirs(repo).map((d) => readPluginMeta(repo, d))
  const manifest = {
    dependencies: { 'dsh-aaa': 'link:D:/old/dsh-aaa' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-plugin-manager'] } },
  }
  const plan = planMigration({ repoPlugins: plugins, manifest, rows: [], repoRoot: repo })
  assert.equal(
    plan.newManifest.devDependencies['dsh-aaa'],
    linkSpecOf(path.join(repo, PLUGINS_DIRNAME, 'dsh-aaa')),
    'migrated devDep points at sub-plugins/, not the repo root',
  )
}

{
  // Stale-link detection drives the self-heal on enable.
  const repo = path.join(tmpRoot, 'stale')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(path.join(repo, PLUGINS_DIRNAME), ['dsh-aaa'])
  const meta = readPluginMeta(repo, 'dsh-aaa')

  assert.equal(staleLinkSpec({ devDependencies: {} }, meta), null, 'absent devDep is not a stale link')
  assert.equal(
    staleLinkSpec({ devDependencies: { 'dsh-aaa': 'link:D:/elsewhere' } }, { name: 'dsh-other', dirPath: meta.dirPath }),
    null,
    'only the given package name is ours to repair',
  )
  assert.equal(
    staleLinkSpec({ devDependencies: { 'dsh-aaa': linkSpecOf(meta.dirPath) } }, meta),
    null,
    'already-correct spec needs no repair',
  )
  assert.deepEqual(
    staleLinkSpec({ devDependencies: { 'dsh-aaa': 'link:D:/repo/dsh-aaa' } }, meta),
    { from: 'link:D:/repo/dsh-aaa', to: linkSpecOf(meta.dirPath) },
    'a link pointing at the old flat path is reported with both specs',
  )
}

// --- pending switch intents (debounced writes) -------------------------------

{
  // One write costs DSH core a full config-tree re-application (~1 s host
  // stall), so intents are keyed by row id and never queue twice.
  assert.equal(typeof INTENT_DEBOUNCE_MS, 'number')
  assert.ok(INTENT_DEBOUNCE_MS > 0 && INTENT_DEBOUNCE_MS <= 1000, 'debounce window is a sane number of ms')

  const empty = []
  const a = mergeIntent(empty, { id: 'aaa', name: 'dsh-aaa', enabled: true })
  assert.deepEqual(a, [{ id: 'aaa', name: 'dsh-aaa', enabled: true }])
  assert.deepEqual(empty, [], 'mergeIntent never mutates the input list')

  const ab = mergeIntent(a, { id: 'bbb', name: 'dsh-bbb', enabled: false })
  assert.equal(ab.length, 2, 'different rows coexist')
  assert.deepEqual(ab[1], { id: 'bbb', name: 'dsh-bbb', enabled: false })

  const reclicked = mergeIntent(ab, { id: 'aaa', name: 'dsh-aaa', enabled: false })
  assert.equal(reclicked.length, 2, 're-clicking a row replaces its intent instead of queueing a second write')
  assert.deepEqual(reclicked.filter((it) => it.id === 'aaa'), [{ id: 'aaa', name: 'dsh-aaa', enabled: false }])
  assert.deepEqual(reclicked.filter((it) => it.id === 'bbb'), [{ id: 'bbb', name: 'dsh-bbb', enabled: false }])

  assert.deepEqual(mergeIntent(undefined, { id: 'x', enabled: true }), [{ id: 'x', name: 'x', enabled: true }], 'tolerates a missing list')
  assert.equal(mergeIntent(a, { id: 'aaa', enabled: true })[0].enabled, true, 'enabled defaults to true unless explicitly false')

  // applyIntents is the identity on an empty list and equals what the flush writes.
  const rows = [{ insert: [{ id: 'aaa', name: 'dsh-aaa' }] }]
  assert.deepEqual(applyIntents(rows, []), rows, 'no intents = identity')
  assert.deepEqual(applyIntents(rows, undefined), rows)

  const off = applyIntents(rows, [{ id: 'aaa', name: 'dsh-aaa', enabled: false }])
  assert.equal(off[0].insert[0].disabled, true, 'queued off intent lands as disabled')
  const on = applyIntents(rows, [{ id: 'aaa', name: 'dsh-aaa', enabled: true }])
  assert.equal('disabled' in on[0].insert[0], false)
  assert.equal(rows[0].insert[0].disabled, undefined, 'input rows are not mutated')

  const fresh = applyIntents(rows, [{ id: 'ccc', name: 'dsh-ccc', enabled: true }])
  assert.equal(fresh.length, 2, 'an intent for an unknown row becomes a new canonical insert item')
  assert.deepEqual(fresh[1].insert[0], { id: 'ccc', name: 'dsh-ccc' })
}

// --- bulk removal planning (全部移除) -----------------------------------------

{
  const repo = path.join(tmpRoot, 'remove')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(repo, ['dsh-aaa', 'dsh-bbb', 'dsh-ccc', 'dsh-ddd', 'dsh-old'])
  fs.mkdirSync(path.join(repo, 'dsh-notreal'), { recursive: true }) // no package.json → invalid
  const plugins = listRepoPluginDirs(repo).map((d) => readPluginMeta(repo, d))

  // 与批量开关同一份六态现场：aaa 已激活、bbb 已停用（有行）、ccc 仅依赖（无行）、
  // ddd 从未安装、old 旧布局、notreal 非插件目录。
  const manifest = {
    dependencies: {
      'dsh-aaa': 'link:./dsh-aaa',
      'dsh-bbb': 'link:./dsh-bbb',
      'dsh-ccc': 'link:./dsh-ccc',
      'dsh-old': 'link:./dsh-old',
    },
    dsh: { profile: { bundles: ['dsh-old'] } },
  }
  const rows = [
    { insert: [{ id: 'aaa', name: 'dsh-aaa' }] },
    { insert: [{ id: 'bbb', name: 'dsh-bbb', disabled: true }] },
  ]
  const states = deriveStates({ repoPlugins: plugins, manifest, rows })

  const plan = removePlan(states)
  // 有痕迹的三项都计入：active（行+依赖）、disabled（行+依赖）、inactive（仅依赖=陈旧链接）。
  assert.equal(plan.count, 3, 'remove counts every plugin that left a trace in the profile')
  assert.deepEqual(plan.targets.map((t) => [t.dir, t.state]), [
    ['dsh-aaa', 'active'],
    ['dsh-bbb', 'disabled'],
    ['dsh-ccc', 'inactive'],
  ])
  assert.deepEqual(Object.fromEntries(plan.skipped.map((s) => [s.dir, s.reason])), {
    'dsh-ddd': REMOVE_REASONS.notInstalled,
    'dsh-notreal': REMOVE_REASONS.invalidDir,
    'dsh-old': REMOVE_REASONS.legacyLayout,
  }, 'skipped rows carry machine-readable reasons')

  // N=0 的判据：全新现场（谁都没装过）不该给出可点的按钮。
  const fresh = deriveStates({ repoPlugins: plugins.filter((p) => p.dir !== 'dsh-notreal' && p.dir !== 'dsh-old'), manifest: {}, rows: [] })
  assert.equal(removePlan(fresh).count, 0, 'nothing installed and no rows → N=0')
  assert.equal(removePlan(fresh).skipped.length, 4)

  // 纯函数：不改输入，容忍空/非法入参，未知状态走兜底 reason。
  assert.equal(states.length, 6, 'removePlan does not modify its input')
  assert.deepEqual(removePlan([]), { targets: [], skipped: [], count: 0 })
  assert.equal(removePlan(undefined).count, 0)
  assert.equal(removePlan([{ dir: 'dsh-weird', name: 'dsh-weird', valid: true, state: 'who-knows', installed: true }]).targets.length, 0)
  assert.equal(
    removePlan([{ dir: 'dsh-weird', name: 'dsh-weird', valid: true, state: 'who-knows', installed: true }]).skipped[0].reason,
    REMOVE_REASONS.unsupportedState,
  )
  // 只有行没有依赖（或反之）也算有痕迹 —— 半状态同样必须能被清掉。
  assert.equal(removePlan([{ dir: 'dsh-x', rowId: 'x', name: 'dsh-x', valid: true, state: 'inactive', installed: false, hasRow: true }]).count, 1)
  assert.equal(removePlan([{ dir: 'dsh-y', rowId: 'y', name: 'dsh-y', valid: true, state: 'inactive', installed: true, hasRow: false }]).count, 1)
}

// --- batch switch planning (全部开启 / 全部关闭) ------------------------------

{
  const repo = path.join(tmpRoot, 'batch')
  fs.mkdirSync(repo, { recursive: true })
  writeRepo(repo, ['dsh-aaa', 'dsh-bbb', 'dsh-ccc', 'dsh-ddd', 'dsh-old'])
  fs.mkdirSync(path.join(repo, 'dsh-notreal'), { recursive: true }) // no package.json → invalid
  const plugins = listRepoPluginDirs(repo).map((d) => readPluginMeta(repo, d))

  // 一份刻意混合的现场：aaa 已激活、bbb 已停用（有行）、ccc 仅依赖（无行）、
  // ddd 从未安装（无行无依赖）、old 旧布局（bundles + 依赖）、notreal 非插件目录。
  const manifest = {
    dependencies: {
      'dsh-aaa': 'link:./dsh-aaa',
      'dsh-bbb': 'link:./dsh-bbb',
      'dsh-ccc': 'link:./dsh-ccc',
      'dsh-old': 'link:./dsh-old',
    },
    dsh: { profile: { bundles: ['dsh-old'] } },
  }
  const rows = [
    { insert: [{ id: 'aaa', name: 'dsh-aaa' }] },
    { insert: [{ id: 'bbb', name: 'dsh-bbb', disabled: true }] },
  ]
  const states = deriveStates({ repoPlugins: plugins, manifest, rows })
  const byDir = Object.fromEntries(states.map((s) => [s.dir, s.state]))
  assert.deepEqual(byDir, {
    'dsh-aaa': 'active',
    'dsh-bbb': 'disabled',
    'dsh-ccc': 'inactive',
    'dsh-ddd': 'uninstalled',
    'dsh-notreal': 'invalid',
    'dsh-old': 'legacy',
  }, 'fixture covers all six states')

  // 全部开启：只动「已停用」与「未安装」，其余全部跳过。
  const on = batchPlan(states, true)
  assert.equal(on.count, 2, 'enable counts disabled + not-installed only')
  assert.deepEqual(on.targets.map((t) => [t.dir, t.state, t.needsInstall]), [
    ['dsh-bbb', 'disabled', false],
    ['dsh-ddd', 'uninstalled', true],
  ])
  const onSkip = Object.fromEntries(on.skipped.map((s) => [s.dir, s.reason]))
  assert.deepEqual(onSkip, {
    'dsh-aaa': BATCH_REASONS.alreadyActive,
    'dsh-ccc': BATCH_REASONS.inactiveDepOnly,
    'dsh-notreal': BATCH_REASONS.invalidDir,
    'dsh-old': BATCH_REASONS.legacyLayout,
  }, 'skipped rows carry machine-readable reasons')
  assert.ok(on.targets.every((t) => t.valid !== false), 'invalid dirs never become targets')

  // 全部关闭：只动「已激活」；不给从未启用过的插件凭空补行。
  const off = batchPlan(states, false)
  assert.equal(off.count, 1, 'disable counts active only')
  assert.deepEqual(off.targets.map((t) => [t.dir, t.needsInstall]), [['dsh-aaa', false]])
  const offSkip = Object.fromEntries(off.skipped.map((s) => [s.dir, s.reason]))
  assert.deepEqual(offSkip, {
    'dsh-bbb': BATCH_REASONS.alreadyDisabled,
    'dsh-ccc': BATCH_REASONS.inactiveDepOnly,
    'dsh-ddd': BATCH_REASONS.notInstalled,
    'dsh-notreal': BATCH_REASONS.invalidDir,
    'dsh-old': BATCH_REASONS.legacyLayout,
  })

  // 纯函数：不改输入，容忍空/非法入参。
  assert.equal(states.length, 6, 'batchPlan does not modify its input')
  assert.deepEqual(batchPlan([], true), { enabled: true, targets: [], skipped: [], count: 0 })
  assert.equal(batchPlan(undefined, false).count, 0)
  assert.equal(batchPlan([{ dir: 'dsh-weird', name: 'dsh-weird', valid: true, state: 'who-knows' }], true).targets.length, 0)
  assert.equal(batchPlan([{ dir: 'dsh-weird', name: 'dsh-weird', valid: true, state: 'who-knows' }], true).skipped[0].reason, BATCH_REASONS.unsupportedState)

  // 全部已激活 → 关闭 N=6、开启 N=0（按钮置灰的判据）。
  const allActive = deriveStates({
    repoPlugins: plugins.filter((p) => p.dir !== 'dsh-notreal' && p.dir !== 'dsh-old'),
    manifest: { dependencies: { 'dsh-aaa': 'x', 'dsh-bbb': 'x', 'dsh-ccc': 'x', 'dsh-ddd': 'x' } },
    rows: ['aaa', 'bbb', 'ccc', 'ddd'].map((id) => ({ insert: [{ id, name: `dsh-${id}` }] })),
  })
  assert.equal(batchPlan(allActive, false).count, 4)
  assert.equal(batchPlan(allActive, true).count, 0, 'nothing to enable when everything is active')
}

// --- one-pass row transform for a batch --------------------------------------

{
  const rows = [
    { id: 'dsh-liquid-glass', disabled: false },
    { insert: [{ id: 'mcp-CodeMap', name: '@deepseek-ai/dsh-mcp-client' }] },
    { insert: [{ id: 'aaa', name: 'dsh-aaa' }] },
    { insert: [{ id: 'bbb', name: 'dsh-bbb', disabled: true }] },
  ]
  const entries = [
    { id: 'aaa', name: 'dsh-aaa', enabled: false },
    { id: 'bbb', name: 'dsh-bbb', enabled: true },
    { id: 'ccc', name: 'dsh-ccc', enabled: true }, // brand-new row
  ]
  const batch = upsertManagedMany(rows, entries)
  const sequential = entries.reduce((acc, e) => upsertManaged(acc, e.id, e.name, e.enabled), rows)
  assert.deepEqual(batch, sequential, 'batch transform equals step-by-step upsertManaged')
  assert.equal(findRow(batch, 'aaa').item.disabled, true)
  assert.equal('disabled' in findRow(batch, 'bbb').item, false)
  assert.deepEqual(findRow(batch, 'ccc').item, { id: 'ccc', name: 'dsh-ccc' })
  assert.equal(findRow(batch, 'mcp-CodeMap').item.name, '@deepseek-ai/dsh-mcp-client', 'foreign rows untouched')
  assert.equal(batch.some((r) => r.id === 'dsh-liquid-glass'), true, 'plain override rows untouched')
  assert.equal('disabled' in rows[2].insert[0], false, 'input rows are never mutated')
  assert.equal(rows[3].insert[0].disabled, true, 'other input rows keep their own state')
  assert.deepEqual(upsertManagedMany(rows, []), rows, 'empty batch = identity')
  assert.deepEqual(upsertManagedMany(rows, undefined), rows, 'missing batch = identity')
}

// --- yaml engine with a real parser is constructible (js-yaml optional) ------

{
  // If js-yaml happens to be resolvable from here (developer install), exercise it.
  try {
    const jsyaml = await import('js-yaml')
    const eng = makeYamlEngine(jsyaml.default || jsyaml)
    const text = eng.dumpText([{ id: 'a', disabled: false }, { insert: [{ id: 'b', name: 'dsh-b' }] }])
    const back = eng.loadText(text)
    assert.equal(back.length, 2)
    assert.equal(back[1].insert[0].id, 'b')
  } catch {
    // js-yaml not installed here — covered by live-profile acceptance instead.
  }
}

// --- stale-link detection & relink planning ----------------------------------

/** Fake link IO for the state matrix: only listed paths exist; realpath is identity. */
function fakeLinkIo({ exists = [], platform = 'win32' } = {}) {
  return {
    platform,
    exists: (p) => exists.some((candidate) => sameLinkTarget(candidate, p, platform)),
    realpath: (p) => String(p),
  }
}

{
  const here2 = 'D:/repo/sub-plugins/dsh-aaa'
  const meta = { dir: 'dsh-aaa', name: 'dsh-aaa', dirPath: here2 }

  // 无键 → absent
  assert.equal(linkStateOf({}, meta, fakeLinkIo({ exists: [here2] })), LINK_STATES.absent)

  // 正确键 → fresh
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': linkSpecOf(here2) } }, meta, fakeLinkIo({ exists: [here2] })),
    LINK_STATES.fresh,
  )

  // 仅大小写 / 分隔符差异 → fresh（Windows 上必须容忍）
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': 'link:D:\\Repo\\Sub-Plugins\\DSH-AAA' } }, meta, fakeLinkIo({ exists: [here2] })),
    LINK_STATES.fresh,
  )
  assert.equal(sameLinkTarget('D:/Repo/X/', 'D:\\Repo\\X', 'win32'), true)
  assert.equal(sameLinkTarget('/repo/x', '/repo/X', 'linux'), false)

  // 指向别处（两处都存在）→ stale-mismatch
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': 'link:D:/old/dsh-aaa' } }, meta, fakeLinkIo({ exists: [here2, 'D:/old/dsh-aaa'] })),
    LINK_STATES.mismatch,
  )

  // 目标不存在（但本仓库里有实际目录）→ stale-target-missing
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': 'link:D:/gone/dsh-aaa' } }, meta, fakeLinkIo({ exists: [here2] })),
    LINK_STATES.missing,
  )

  // 连实际目录都不存在 → stale-unresolved（只能提示）
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': 'link:D:/gone/dsh-aaa' } }, meta, fakeLinkIo({ exists: [] })),
    LINK_STATES.unresolved,
  )

  // 非 link: spec → 需要改写
  assert.equal(
    linkStateOf({ devDependencies: { 'dsh-aaa': '^1.0.0' } }, meta, fakeLinkIo({ exists: [here2] })),
    LINK_STATES.mismatch,
  )

  // IO 抛错 → unknown（只提示，绝不猜）
  const throwing = { platform: 'win32', exists: () => true, realpath: () => { throw new Error('boom') } }
  assert.equal(linkStateOf({ devDependencies: { 'dsh-aaa': linkSpecOf(here2) } }, meta, throwing), LINK_STATES.unknown)
}

{
  // relinkPlan：可自动修 / 只能提示 两类分开，且管理器自身不参与
  const derived = [
    { dir: 'dsh-fresh', name: 'dsh-fresh', dirPath: '/r/dsh-fresh', linkState: LINK_STATES.fresh, linkDeclared: 'link:/r/dsh-fresh', linkExpected: 'link:/r/dsh-fresh' },
    { dir: 'dsh-absent', name: 'dsh-absent', dirPath: '/r/dsh-absent', linkState: LINK_STATES.absent },
    { dir: 'dsh-moved', name: 'dsh-moved', dirPath: '/r/sub-plugins/dsh-moved', linkState: LINK_STATES.mismatch, linkDeclared: 'link:/old/dsh-moved' },
    { dir: 'dsh-gone', name: 'dsh-gone', dirPath: '/r/sub-plugins/dsh-gone', linkState: LINK_STATES.missing, linkDeclared: 'link:/nope/dsh-gone' },
    { dir: 'dsh-lost', name: 'dsh-lost', dirPath: '/r/sub-plugins/dsh-lost', linkState: LINK_STATES.unresolved, linkDeclared: 'link:/nope/dsh-lost' },
    { dir: 'dsh-weird', name: 'dsh-weird', dirPath: '/r/dsh-weird', linkState: LINK_STATES.unknown },
    { dir: MANAGER_DIR, name: MANAGER_DIR, dirPath: '/r/dsh-plugin-manager', linkState: LINK_STATES.mismatch },
  ]
  const plan = relinkPlan(derived)
  assert.deepEqual(plan.auto.map((p) => p.dir), ['dsh-moved', 'dsh-gone'])
  assert.deepEqual(plan.manual.map((p) => p.dir), ['dsh-lost', 'dsh-weird'])
  assert.equal(plan.count, 2)
  assert.equal(plan.manualCount, 2)
  assert.equal(plan.manual[0].reason, RELINK_REASONS[LINK_STATES.unresolved])
  assert.equal(plan.auto[0].expected, null, '期望值由 host 侧补齐，规划不改形状')
  assert.equal(relinkPlan(undefined).count, 0)
  assert.equal(relinkPlan([{ dir: 'x', linkState: LINK_STATES.fresh }]).count, 0)
}

{
  // deriveStates 带上链接态三件套；batchPlan 把「有行且链接陈旧」也纳入开启目标
  const repoRoot = path.join(tmpRoot, 'linkstate')
  fs.mkdirSync(path.join(repoRoot, 'sub-plugins', 'dsh-aaa'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'sub-plugins', 'dsh-aaa', 'package.json'), JSON.stringify({ name: 'dsh-aaa', main: 'index.js' }))
  fs.mkdirSync(path.join(repoRoot, 'sub-plugins', 'dsh-bbb'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'sub-plugins', 'dsh-bbb', 'package.json'), JSON.stringify({ name: 'dsh-bbb', main: 'index.js' }))
  const repoPlugins = ['dsh-aaa', 'dsh-bbb'].map((dir) => readPluginMeta(repoRoot, dir))
  const manifest = {
    devDependencies: {
      'dsh-aaa': 'link:D:/old/dsh-aaa',            // 陈旧：指向别处
      'dsh-bbb': linkSpecOf(repoPlugins[1].dirPath), // 正常
    },
  }
  const rows = [
    { id: 'aaa', disabled: false },
    { id: 'bbb', disabled: true },
  ]
  const io = fakeLinkIo({ exists: [repoPlugins[0].dirPath, repoPlugins[1].dirPath, 'D:/old/dsh-aaa'] })
  const derived = deriveStates({ repoPlugins, manifest, rows, io })
  assert.equal(derived[0].linkState, LINK_STATES.mismatch)
  assert.equal(derived[0].linkDeclared, 'link:D:/old/dsh-aaa')
  assert.equal(derived[0].linkExpected, linkSpecOf(repoPlugins[0].dirPath))
  assert.equal(derived[1].linkState, LINK_STATES.fresh)
  assert.equal(derived[1].linkDeclared, linkSpecOf(repoPlugins[1].dirPath))

  const plan = batchPlan(derived, true)
  const aaa = plan.targets.find((t) => t.dir === 'dsh-aaa')
  assert.ok(aaa, '有行且链接陈旧的项也要进「全部开启」目标')
  assert.equal(aaa.needsInstall, true)
  const bbb = plan.targets.find((t) => t.dir === 'dsh-bbb')
  assert.equal(bbb.needsInstall, false, '已停用但链接正确 → 只需写行')

  // 「未激活(仅依赖)」的陈旧项不凭空补行（保持既有语义；修复走单行开启/重定位）
  const noRow = deriveStates({
    repoPlugins: [repoPlugins[0]],
    manifest: { devDependencies: { 'dsh-aaa': 'link:D:/old/dsh-aaa' } },
    rows: [],
    io,
  })
  assert.equal(noRow[0].state, 'inactive')
  const plan2 = batchPlan(noRow, true)
  assert.equal(plan2.targets.length, 0)
  assert.equal(plan2.skipped[0].reason, BATCH_REASONS.inactiveDepOnly)
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('host-core tests: PASS')
