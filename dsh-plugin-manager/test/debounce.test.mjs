// Handler-level harness for the host half (src/index.js).
//
// WHY THIS FILE EXISTS
// A single write to the profile's cordis.patch.yml costs DSH core a full
// config-tree re-application that blocks the host event loop for 681-1184 ms
// (measured with a 5 ms /status probe; an identical-bytes write costs nothing,
// so the price is the config change itself). The regression this file locks
// down is therefore about COUNT, not milliseconds: N switch requests inside the
// debounce window must reach disk as exactly ONE write.
//
// It drives the REAL registerHttp() handler with a fake web-server and fake
// req/res against a throwaway $DSH_HOME, so the seam is the actual endpoint —
// not a re-implementation of it. The temp profile gets its js-yaml through a
// junction to the live profile's copy (the same resolution contract the plugin
// uses); when that copy is unavailable the file skips instead of installing
// anything.
//
// Run: node dsh-plugin-manager/test/debounce.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.join(here, '..', 'src', 'index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- skip when the profile's js-yaml is not reachable (never run pnpm here) ---

const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const realYaml = path.join(realHome, 'profiles', 'web', 'node_modules', 'js-yaml')
if (!fs.existsSync(realYaml)) {
  console.log(`debounce tests: SKIP (no js-yaml at ${realYaml})`)
  process.exit(0)
}

// --- throwaway profile -------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-debounce-'))
const profileDir = path.join(tmpRoot, 'profiles', 'web')
fs.mkdirSync(profileDir, { recursive: true })

const ROWS = ['dsh-session-time-bucket', 'dsh-esc-rewind']
const rowId = (dir) => dir.replace(/^dsh-/, '')

fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'web',
  private: true,
  devDependencies: Object.fromEntries(ROWS.map((d) => [d, `link:D:/repo/sub-plugins/${d}`])),
}, null, 2)}\n`, 'utf8')

const patchFile = path.join(profileDir, 'cordis.patch.yml')
const seedRows = () => `- insert:\n${ROWS.map((d) => `    - id: ${rowId(d)}\n      name: ${d}`).join('\n')}\n`
fs.writeFileSync(patchFile, seedRows(), 'utf8')

// js-yaml via junction, mirroring the live profile's hoisted install.
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
fs.symlinkSync(realYaml, path.join(profileDir, 'node_modules', 'js-yaml'), 'junction')

const probe = createRequire(path.join(profileDir, 'package.json'))
try {
  const jsyaml = probe('js-yaml')
  assert.equal(typeof jsyaml.load, 'function')
} catch (e) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log(`debounce tests: SKIP (js-yaml not resolvable from the temp profile: ${e && e.message})`)
  process.exit(0)
}

process.env.DSH_HOME = tmpRoot
const { registerHttp } = await import(pathToFileURL(indexPath).href)

// --- fake web server + req/res ----------------------------------------------

let handler = null
let dispose = null
const ctx = {
  baseUrl: pathToFileURL(`${profileDir}${path.sep}`).href,
  effect(callback) {
    const cleanup = callback()
    dispose = () => { if (typeof cleanup === 'function') cleanup() }
  },
}
const host = {
  register(options) {
    handler = options.handler
    return () => { handler = null }
  },
}

registerHttp(ctx, host, {})
assert.equal(typeof handler, 'function', 'registerHttp installed a prefix handler')

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) { status = code },
      end(chunk) { payload += chunk === undefined ? '' : String(chunk); resolve({ status, json: JSON.parse(payload) }) },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
  })
}

/** Count patch-file writes for `ms`, sampling the mtime the way a watcher would. */
async function countWrites(ms) {
  const seen = new Set()
  let last = fs.statSync(patchFile).mtimeMs
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await sleep(10)
    const m = fs.statSync(patchFile).mtimeMs
    if (m !== last) { seen.add(m); last = m }
  }
  return seen.size
}

const stateOf = (res, dir) => {
  const p = (res.json.data.plugins || []).find((x) => x.dir === dir)
  return p ? p.state : '(missing)'
}

try {
  // --- one burst, one write -------------------------------------------------
  fs.writeFileSync(patchFile, seedRows(), 'utf8')

  const writes = countWrites(1200)
  const first = await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: false })
  assert.equal(first.status, 200)
  const second = await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[1], enabled: false })
  assert.equal(second.status, 200)

  // Responses are optimistic-consistent: the queued state is already reported,
  // so the panel never has to wait for the flush to show the target position.
  assert.equal(stateOf(first, ROWS[0]), 'disabled', 'first response already reports the requested state')
  assert.equal(stateOf(second, ROWS[1]), 'disabled', 'second response already reports the requested state')

  const status = await call('GET', '/__dsh-plugin-manager/status')

  assert.equal(await writes, 1, 'two quick switches produced exactly ONE patch-file write')

  const text = fs.readFileSync(patchFile, 'utf8')
  assert.equal((text.match(/disabled: true/g) || []).length, 2, 'the single write carries both rows')
  assert.ok(text.includes(`id: ${rowId(ROWS[0])}`) && text.includes(`id: ${rowId(ROWS[1])}`))

  assert.ok(status.json.pendingWrites >= 1, 'queued writes are visible in /status while the burst is in flight')
  assert.equal(status.json.lastFlushError, null)

  const drained = await call('GET', '/__dsh-plugin-manager/status')
  assert.equal(drained.json.pendingWrites, 0, 'queue drains after the flush')

  // --- re-clicking a row replaces its intent (still one write) --------------
  fs.writeFileSync(patchFile, seedRows(), 'utf8')
  const rerun = countWrites(1200)
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: false })
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: true })
  assert.equal(await rerun, 1, 'off-then-on inside the window is one write, not two')
  assert.doesNotMatch(fs.readFileSync(patchFile, 'utf8'), /disabled: true/, 'only the last intent for that row landed')

  // --- dispose while queued: best-effort synchronous flush (design.md R7) ---
  fs.writeFileSync(patchFile, seedRows(), 'utf8')
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[1], enabled: false })
  dispose()
  assert.match(fs.readFileSync(patchFile, 'utf8'), /disabled: true/, 'queued intent survives a host shutdown')
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log('debounce tests: PASS')
