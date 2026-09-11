// Guard for the repo-root INSTALL SHELL manifest (`<repo>/package.json`).
//
// Why this file exists at all: the repo is a git repository, and users install
// it with a git spec —
//
//   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
//
// `dsh plugin` forwards that to `pnpm add`, which clones the WHOLE repository
// and treats the checkout root as the package. So the root manifest decides
// three things the inner package cannot: the installed package NAME (which is
// also the profile `dependencies` key, the `dsh.profile.bundles` layer name and
// the activation row id), whether the clone is recognised as a bundle at all
// (`dsh.bundle.patch`), and which file the host/client halves load.
//
// Measured on this machine (isolated DSH_HOME, local git remote):
//   - root manifest present, named dsh-plugin-manager  -> dep key
//     `dsh-plugin-manager`, bundles gains exactly one `dsh-plugin-manager`,
//     `dsh --dump-default-config` composes `- id: dsh-plugin-manager`, and the
//     manager scans the clone's sub-plugins/ and finds all 6 children.
//   - root manifest ABSENT -> pnpm names the dependency after the repo dir
//     (`dsh-plugins.git`), reconcile prints "declares no dsh.bundle — installed
//     as a plain dependency, not a profile layer", and nothing ever activates.
//
// The shell must stay a pure FORWARDER: same identity as the inner package, no
// dependencies of its own, and no activation rows (children are activated only
// by rows the manager writes into the profile's cordis.patch.yml — a second
// row with the same id fails `dsh web` boot with `duplicate loader entry id`).
// Renaming the shell, dropping a forward, or adding a child-plugin dependency
// must all turn this test red.
//
// Run: node dsh-plugin-manager/test/root-install-shell.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANAGER_ID,
  PLUGINS_DIRNAME,
  listRepoPluginDirs,
  pluginAbsDirOf,
  pluginRootsOf,
  readPluginMeta,
  repoRootOfPluginSrc,
} from '../src/host-core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(here, '..')
const REPO_ROOT = path.resolve(PKG_DIR, '..')

const rootManifestPath = path.join(REPO_ROOT, 'package.json')
const innerManifestPath = path.join(PKG_DIR, 'package.json')

function readJson(file) {
  assert.ok(fs.existsSync(file), `expected manifest to exist: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Resolve one exports/main value to an absolute path the way Node would. */
function resolveSpec(manifestFile, spec) {
  assert.equal(typeof spec, 'string', `${path.basename(manifestFile)}: export spec must be a string, got ${JSON.stringify(spec)}`)
  assert.match(spec, /^\.\//, `${path.basename(manifestFile)}: export spec must be a relative './…' path, got ${spec}`)
  return path.resolve(path.dirname(manifestFile), spec)
}

const root = fs.existsSync(rootManifestPath) ? readJson(rootManifestPath) : null
const inner = readJson(innerManifestPath)

const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- identity ----------------------------------------------------------------

test('repo root carries an install manifest at all', () => {
  assert.ok(root, `${rootManifestPath} must exist — without it a git install names the package after the repo directory and never becomes a bundle`)
})

test('shell name IS the plugin identity: dsh-plugin-manager, same as the inner package', () => {
  assert.equal(root.name, MANAGER_ID, 'bundle layer name / activation row id / browser module-table id all come from this field')
  assert.equal(root.name, inner.name, 'shell and inner package must agree, or the two install entry points create two different plugins')
})

test('shell is private and never published to a registry', () => {
  assert.equal(root.private, true, 'the shell only exists so the repository can be installed; publishing it would put a second copy of the manager on npm')
})

test('shell is ESM like every cordis bundle body', () => {
  assert.equal(root.type, 'module', 'src/index.js uses ESM named exports (apply/inject/name); a CJS root would break the loader')
})

test('shell declares no dependencies of any kind', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const value = root[field]
    assert.ok(
      value === undefined || (typeof value === 'object' && Object.keys(value).length === 0),
      `shell must not declare ${field}: pnpm would install children into the profile and reconcile could re-add them as bundle layers`,
    )
  }
})

test('shell mentions no child plugin anywhere in its manifest', () => {
  const children = listRepoPluginDirs(REPO_ROOT).map((dir) => readPluginMeta(REPO_ROOT, dir).name)
  assert.ok(children.length > 0, 'sanity: the repo is expected to contain managed child plugins')
  const haystack = JSON.stringify(root)
  for (const name of children) {
    assert.ok(!haystack.includes(name), `shell must not reference child plugin "${name}" — children are activated only by rows the manager writes into the profile patch file`)
  }
})

// --- forwarding --------------------------------------------------------------

test('main and exports["."] forward to the inner host half, and that file exists', () => {
  assert.equal(root.main, `${MANAGER_ID}/src/index.js`)
  const viaMain = path.resolve(REPO_ROOT, root.main)
  const viaExports = resolveSpec(rootManifestPath, root.exports['.'])
  const innerTarget = resolveSpec(innerManifestPath, inner.exports['.'])
  assert.equal(viaExports, innerTarget, 'exports["."] must land on the same file the inner package serves')
  assert.ok(fs.existsSync(viaMain), `main target missing: ${viaMain}`)
  assert.ok(fs.existsSync(viaExports), `exports["."] target missing: ${viaExports}`)
})

test('exports["./client"] forwards to the inner client half, and that file exists', () => {
  const viaRoot = resolveSpec(rootManifestPath, root.exports['./client'])
  const innerTarget = resolveSpec(innerManifestPath, inner.exports['./client'])
  assert.equal(viaRoot, innerTarget, 'client-modules resolves "./client" from the installed bundle; a missing forward fails boot with "declares dsh.client but exports no ./client bundle"')
  assert.ok(fs.existsSync(viaRoot), `exports["./client"] target missing: ${viaRoot}`)
})

test('dsh.client matches the inner declaration exactly', () => {
  assert.deepEqual(root.dsh?.client, inner.dsh?.client, 'the installed manifest is the one the web plugin table reads, so inject/platform must match the package')
})

test('dsh.bundle.patch points at the inner package patch file', () => {
  const declared = root.dsh?.bundle?.patch
  assert.equal(typeof declared, 'string', 'without dsh.bundle.patch, `dsh plugin add` installs a plain dependency and never a profile layer')
  const patchFile = path.resolve(REPO_ROOT, declared)
  assert.equal(patchFile, path.resolve(PKG_DIR, 'cordis.patch.yml'), 'the only activation-row source is the manager package patch')
  assert.ok(fs.existsSync(patchFile), `bundle patch missing: ${patchFile}`)
})

// --- the shell must not grow a patch layer of its own ------------------------

test('repo root has no cordis.patch.yml of its own', () => {
  const rootPatch = path.join(REPO_ROOT, 'cordis.patch.yml')
  assert.ok(!fs.existsSync(rootPatch), 'a root patch file would be a second umbrella layer writing rows the manager already owns → duplicate loader entry id at boot')
})

test('the manager patch inserts exactly one row: the manager itself', () => {
  const text = fs.readFileSync(path.resolve(PKG_DIR, 'cordis.patch.yml'), 'utf8')
  const ids = [...text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.deepEqual(ids, [MANAGER_ID], `bundle patch must carry only its own row, found ${JSON.stringify(ids)}`)
})

// --- the install entry points really are equivalent --------------------------

test('installing the repo root yields the same plugin id as installing the package dir', () => {
  const rootId = root.dsh.bundle.patch
  const innerId = inner.dsh.bundle.patch
  assert.equal(path.resolve(REPO_ROOT, rootId), path.resolve(PKG_DIR, innerId))
  assert.equal(root.name, inner.name)
})

test('from the installed layout the shell still resolves repo root and sub-plugins', () => {
  // pnpm clones the repo and hoists it to <profile>/node_modules/<name>, so the
  // host half runs from <pkg>/dsh-plugin-manager/src — exactly the in-repo
  // layout. repoRootOfPluginSrc must therefore land on the clone root, and the
  // clone root must expose sub-plugins/ (the whole point of shipping the shell
  // without a `files` allow-list).
  const srcDir = path.join(PKG_DIR, 'src')
  const repoRoot = repoRootOfPluginSrc(srcDir)
  assert.equal(repoRoot, REPO_ROOT)
  const roots = pluginRootsOf(repoRoot)
  assert.equal(roots[0], path.join(REPO_ROOT, PLUGINS_DIRNAME), 'first scanned root must be sub-plugins/')
  const dirs = listRepoPluginDirs(repoRoot)
  assert.ok(dirs.length > 0, 'children must be discoverable from the installed root')
  assert.ok(!dirs.includes(MANAGER_ID), 'the manager never manages itself')
  for (const dir of dirs) {
    const meta = readPluginMeta(repoRoot, dir)
    assert.ok(meta.valid, `child ${dir} has no readable plugin manifest`)
  }
})

test('shell does not restrict the clone with a files allow-list', () => {
  assert.equal(root.files, undefined, 'a `files` allow-list would drop sub-plugins/ from a packed install and leave the manager with nothing to manage')
})

test('shell provides no profile bundle list of its own', () => {
  assert.equal(root.dsh?.profile, undefined, 'the shell must not carry dsh.profile — only a profile directory lists bundles, and a root list is how the retired umbrella re-introduced duplicate rows')
})

test('the browser bundle registers under exactly the shell package name', () => {
  // client-modules locates a client row's package by matching the registered
  // module-table id against the manifest name; a drift means the panel silently
  // never appears even though the host half booted fine.
  const clientSrc = fs.readFileSync(path.join(PKG_DIR, 'src', 'client.js'), 'utf8')
  const registered = clientSrc.match(/__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/)
  assert.ok(registered, 'client half must register a module-table id')
  assert.equal(registered[1], root.name, 'the registered client id must equal the installed package name')
  assert.equal(registered[1], inner.name)
})

test('no child plugin carries a bundle layer, a patch file, or the manager name', () => {
  // The umbrella accident was a second layer inserting rows the manager already
  // owns; these three properties are what keep `add <child dir>` harmless.
  for (const dir of listRepoPluginDirs(REPO_ROOT)) {
    const abs = pluginAbsDirOf(REPO_ROOT, dir)
    const pkg = readJson(path.join(abs, 'package.json'))
    assert.equal(pkg.dsh?.bundle, undefined, `${dir} must not declare dsh.bundle`)
    assert.ok(!fs.existsSync(path.join(abs, 'cordis.patch.yml')), `${dir} must not ship its own cordis.patch.yml`)
    assert.notEqual(pkg.name, MANAGER_ID, `${dir} must not reuse the manager package name`)
  }
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(e && e.stack ? e.stack : e)
  }
}
if (failed > 0) {
  console.error(`root-install-shell tests: ${failed} failed`)
  process.exit(1)
}
console.log('root-install-shell tests: PASS')
