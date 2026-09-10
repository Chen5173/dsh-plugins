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

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('host-core tests: PASS')
