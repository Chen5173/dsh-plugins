// dsh-plugin-manager: HOST half.
//
// Runs in the `dsh web` process (unsandboxed Node). Exposes the management
// surface the browser panel calls:
//
//   GET  /__dsh-plugin-manager/status   — health/diagnostics
//   GET  /__dsh-plugin-manager/list     — repo scan + per-plugin profile state
//   POST /__dsh-plugin-manager/set-enabled  {dir, enabled}  — activate/disable
//   POST /__dsh-plugin-manager/remove        {dir}          — remove (row + devDep)
//   POST /__dsh-plugin-manager/migrate       {}             — one-click takeover
//
// Activation model (design.md): the manager is the ONLY local bundle in the
// profile (`dsh.profile.bundles`); each managed dsh-* sibling stays resolvable
// as a profile devDependency (link:) and gets a canonical stable-id insert row
// in the profile cordis.patch.yml. That file is live-watched by DSH's patch HMR
// (patchReload:'live'), so host-side rows start/stop immediately; client-side
// UI needs one page reload (the panel tells the user, never auto-reloads).
//
// Profile discovery: ctx.baseUrl is the profile directory file:URL (anchored on
// dirname(<profile>/cordis.yml) by the boot loader), so this host never needs
// to hardcode 'web' — it reads the directory it is actually running in.
//
// All file mutations are bracketed by timestamped backups of package.json and
// cordis.patch.yml. YAML round-trips use the profile's own js-yaml via
// createRequire(profile/package.json) — the profile uses pnpm's hoisted
// nodeLinker, so js-yaml (a transitive of dsh-mcp-manager) sits at the top of
// the profile's node_modules (verified on this machine).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

import {
  MANAGER_ID,
  DEFAULT_PROFILE,
  HTTP_PREFIX,
  YAML_PKG,
  YAML_PKG_RANGE,
  dshHome,
  profileDirOf,
  patchPathOf,
  manifestPathOf,
  repoRootOfPluginSrc,
  listRepoPluginDirs,
  readPluginMeta,
  readManifest,
  makeYamlEngine,
  readPatchRows,
  writePatchRows,
  upsertManaged,
  removeManaged,
  deriveStates,
  planMigration,
  linkSpecOf,
  staleLinkSpec,
  pluginRootsOf,
} from './host-core.js'

const name = 'dsh-plugin-manager'
const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootOfPluginSrc(HERE)
/** Root actually scanned for plugin packages (sub-plugins/ when present). */
const PLUGINS_ROOT = pluginRootsOf(REPO_ROOT)[0]

/** Visible diagnostics for the /status endpoint. */
export const HOST_DIAG = {
  repoRoot: REPO_ROOT,
  pluginsRoot: PLUGINS_ROOT,
  profileName: DEFAULT_PROFILE,
  endpointsRegistered: false,
  yamlResolved: false,
  yamlError: null,
}

// --- tiny HTTP helpers -------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch { /* connection already gone */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// --- pnpm --------------------------------------------------------------------

/** Spawn pnpm in the profile dir (Windows needs the .cmd shim → shell). */
function execPnpm(profileDir, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: profileDir,
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 1, error: String(err.message || err), stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code == null ? 1 : code, error: code === 0 ? null : stderr.trim(), stdout, stderr })
    })
  })
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.bak-${stamp}`
  fs.copyFileSync(file, dest)
  return dest
}

function writeJsonPretty(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

// --- resolution --------------------------------------------------------------

/**
 * Resolve the context the manager operates on. Profile directory comes from the
 * running loader's ctx.baseUrl (file URL of <profile>/), falling back to
 * $DSH_HOME/profiles/<config.profile || 'web'> when no web surface exists.
 */
function resolveContext(config, baseUrl) {
  const home = dshHome()
  let profileDir = null
  let profileName = config && typeof config.profile === 'string' && config.profile.trim() !== ''
    ? config.profile.trim()
    : null
  if (baseUrl) {
    try {
      profileDir = fileURLToPath(baseUrl)
    } catch { profileDir = null }
  }
  if (!profileDir) profileDir = profileDirOf(home, profileName || DEFAULT_PROFILE)
  if (!profileName) profileName = path.basename(profileDir)
  return {
    home,
    profileName,
    profileDir,
    patchFile: patchPathOf(home, profileName),
    manifestFile: manifestPathOf(home, profileName),
    repoRoot: REPO_ROOT,
    pluginsRoot: PLUGINS_ROOT,
  }
}

/** Resolve the profile's own js-yaml through createRequire(profile package). */
function requireProfileYaml(profileDir) {
  try {
    const req = createRequire(path.join(profileDir, 'package.json'))
    const jsyaml = req(YAML_PKG)
    if (jsyaml && typeof jsyaml.load === 'function' && typeof jsyaml.dump === 'function') {
      return { jsyaml, error: null }
    }
    return { jsyaml: null, error: `${YAML_PKG} did not load from profile node_modules` }
  } catch (e) {
    return { jsyaml: null, error: (e && (e.message || e.code)) || String(e) }
  }
}

async function ensureYaml(profileDir) {
  const first = requireProfileYaml(profileDir)
  if (first.jsyaml) return { engine: makeYamlEngine(first.jsyaml), error: null, installed: false }
  const res = await execPnpm(profileDir, ['add', '-D', `${YAML_PKG}@${YAML_PKG_RANGE}`])
  if (!res.ok) return { engine: null, error: `js-yaml unavailable and install failed: ${res.error || res.stderr}` }
  const second = requireProfileYaml(profileDir)
  if (!second.jsyaml) return { engine: null, error: `js-yaml still unavailable after install: ${second.error}` }
  return { engine: makeYamlEngine(second.jsyaml), error: null, installed: true }
}

function readPlugins(repoRoot) {
  return listRepoPluginDirs(repoRoot).map((dir) => readPluginMeta(repoRoot, dir))
}

function snapshot(ctx, config) {
  const c = resolveContext(config, ctx && ctx.baseUrl)
  const plugins = readPlugins(c.repoRoot)
  const manifest = readManifest(c.manifestFile)
  const yaml = requireProfileYaml(c.profileDir)
  const rows = yaml.jsyaml ? readPatchRows(makeYamlEngine(yaml.jsyaml), c.patchFile) : []
  const derived = deriveStates({ repoPlugins: plugins, manifest, rows })
  const legacyDetected = derived.some((p) => p.legacyBundle)
  return { c, manifest, rows, plugins, derived, legacyDetected, yamlError: yaml.error }
}

function listPayload(s) {
  return {
    ok: true,
    data: {
      repoRoot: s.c.repoRoot,
      pluginsRoot: s.c.pluginsRoot,
      profileName: s.c.profileName,
      profileDir: s.c.profileDir,
      patchFile: s.c.patchFile,
      managerId: MANAGER_ID,
      legacyDetected: s.legacyDetected,
      yamlError: s.yamlError,
      plugins: s.derived,
    },
  }
}

// --- actions -----------------------------------------------------------------

async function ensureDevDep(c, pkgName, absDir) {
  const manifest = readManifest(c.manifestFile)
  const inDeps = Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, pkgName)
  const inDev = Object.prototype.hasOwnProperty.call(manifest.devDependencies || {}, pkgName)
  const spec = linkSpecOf(absDir)
  // Already linked to the right directory → nothing to do. A devDep pointing
  // elsewhere (e.g. the pre-move flat path after dirs moved into sub-plugins/)
  // is repaired below instead of being trusted.
  const stale = inDev ? staleLinkSpec(manifest, { name: pkgName, dirPath: absDir }) : null
  if (inDev && !stale) return { installed: true, ranPnpm: false, error: null }
  const backup = backupFile(c.manifestFile)
  const manifest2 = { ...manifest }
  manifest2.dependencies = { ...(manifest.dependencies || {}) }
  delete manifest2.dependencies[pkgName]
  manifest2.devDependencies = { ...(manifest.devDependencies || {}), [pkgName]: spec }
  writeJsonPretty(c.manifestFile, manifest2)
  const res = await execPnpm(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    return { installed: false, ranPnpm: true, error: res.error || 'pnpm install failed' }
  }
  return { installed: true, ranPnpm: true, error: null, backup }
}

async function dropDevDep(c, pkgName) {
  const manifest = readManifest(c.manifestFile)
  const hadDep = Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, pkgName)
  const hadDev = Object.prototype.hasOwnProperty.call(manifest.devDependencies || {}, pkgName)
  if (!hadDep && !hadDev) return { removed: true, ranPnpm: false, error: null }
  const backup = backupFile(c.manifestFile)
  const manifest2 = { ...manifest }
  manifest2.dependencies = { ...(manifest.dependencies || {}) }
  manifest2.devDependencies = { ...(manifest.devDependencies || {}) }
  delete manifest2.dependencies[pkgName]
  delete manifest2.devDependencies[pkgName]
  writeJsonPretty(c.manifestFile, manifest2)
  const res = await execPnpm(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    return { removed: false, ranPnpm: true, error: res.error || 'pnpm install failed' }
  }
  return { removed: true, ranPnpm: true, error: null, backup }
}

// --- HTTP registration -------------------------------------------------------

function registerHttp(ctx, host, config) {
  if (!host || typeof host.register !== 'function') return
  const __cfg = config || {}

  const h = async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase()
      const url = (req.url || '').split('?')[0]

      if (url === `${HTTP_PREFIX}/status` && method === 'GET') {
        const c = resolveContext(__cfg, ctx && ctx.baseUrl)
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-plugin-manager',
          repoRoot: c.repoRoot,
          pluginsRoot: c.pluginsRoot,
          profileName: c.profileName,
          profileDir: c.profileDir,
          patchFile: c.patchFile,
          endpointsRegistered: true,
          yamlResolved: HOST_DIAG.yamlResolved,
          yamlError: HOST_DIAG.yamlError,
        })
        return
      }

      if (url === `${HTTP_PREFIX}/list` && method === 'GET') {
        sendJson(res, 200, listPayload(snapshot(ctx, __cfg)))
        return
      }

      if ((url === `${HTTP_PREFIX}/set-enabled` || url === `${HTTP_PREFIX}/remove` || url === `${HTTP_PREFIX}/migrate`) && method === 'POST') {
        let args = {}
        const body = await readBody(req)
        if (body) {
          try { args = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: 'bad json body' }); return }
        }
        if (url === `${HTTP_PREFIX}/set-enabled` || url === `${HTTP_PREFIX}/remove`) {
          const dir = String(args.dir || '').trim()
          const snap0 = snapshot(ctx, __cfg)
          const meta = dir ? readPluginMeta(snap0.c.repoRoot, dir) : null
          if (!meta || !meta.valid) {
            sendJson(res, 400, { ok: false, error: `unknown or invalid plugin dir: ${dir || '(empty)'}` })
            return
          }
          // Prefer a fresh snapshot for state decisions.
          const s = snapshot(ctx, __cfg)
          const st = s.derived.find((p) => p.dir === dir)
          const c = s.c
          const y = await ensureYaml(c.profileDir)
          if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
          HOST_DIAG.yamlResolved = true
          HOST_DIAG.yamlError = null
          let rows = readPatchRows(y.engine, c.patchFile)

          if (url.endsWith('/set-enabled')) {
            const enabled = args.enabled !== false
            // Legacy layout: the bundle layer already owns this id — a second
            // insert would collide loader-wide. Ask the user to migrate first.
            if (st && st.legacyBundle) {
              sendJson(res, 409, {
                ok: false,
                code: 'legacy-layout',
                error: `${meta.name} 仍以旧布局(dependencies+bundles)安装，请先执行「一键接管/迁移」再开关`,
              })
              return
            }
            if (enabled) {
              const check = readManifest(c.manifestFile)
              const present = Object.prototype.hasOwnProperty.call(check.devDependencies || {}, meta.name)
                || Object.prototype.hasOwnProperty.call(check.dependencies || {}, meta.name)
              if (!present) {
                const ins = await ensureDevDep(c, meta.name, meta.dirPath)
                if (!ins.installed) {
                  sendJson(res, 500, { ok: false, error: `install ${meta.name} failed: ${ins.error || 'unknown'}` })
                  return
                }
              }
            }
            rows = upsertManaged(rows, meta.rowId, meta.name, enabled)
            writePatchRows(y.engine, c.patchFile, rows)
            sendJson(res, 200, listPayload(snapshot(ctx, __cfg)))
            return
          }

          // remove — only for non-legacy managed rows
          if (st && st.legacyBundle) {
            sendJson(res, 409, {
              ok: false,
              code: 'legacy-layout',
              error: `${meta.name} 仍以旧布局安装，请先执行「一键接管/迁移」再移除`,
            })
            return
          }
          rows = removeManaged(rows, meta.rowId)
          writePatchRows(y.engine, c.patchFile, rows)
          const dropped = await dropDevDep(c, meta.name)
          const payload = listPayload(snapshot(ctx, __cfg))
          if (!dropped.removed) payload.warning = `row removed; devDependency cleanup failed: ${dropped.error || 'unknown'}`
          sendJson(res, 200, payload)
          return
        }

        // migrate
        const s = snapshot(ctx, __cfg)
        const c = s.c
        const y = await ensureYaml(c.profileDir)
        if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
        HOST_DIAG.yamlResolved = true
        HOST_DIAG.yamlError = null
        const plan = planMigration({
          repoPlugins: s.plugins,
          manifest: s.manifest,
          rows: s.rows,
          repoRoot: c.repoRoot,
        })
        if (!plan.needsMigration) {
          sendJson(res, 200, { ok: true, noop: true, data: { ...listPayload(snapshot(ctx, __cfg)).data } })
          return
        }
        const bakManifest = fs.existsSync(c.manifestFile) ? backupFile(c.manifestFile) : null
        const bakPatch = fs.existsSync(c.patchFile) ? backupFile(c.patchFile) : null
        try {
          writeJsonPretty(c.manifestFile, plan.newManifest)
          writePatchRows(y.engine, c.patchFile, plan.finalRows)
          const resPnpm = await execPnpm(c.profileDir, ['install'])
          if (!resPnpm.ok) {
            throw new Error(`pnpm install failed: ${resPnpm.error || resPnpm.stderr.trim()}`)
          }
          sendJson(res, 200, {
            ok: true,
            backups: [bakManifest, bakPatch].filter(Boolean),
            summary: plan.summary,
            data: { ...listPayload(snapshot(ctx, __cfg)).data },
          })
        } catch (e) {
          if (bakManifest) { try { fs.copyFileSync(bakManifest, c.manifestFile) } catch { /* best effort */ } }
          if (bakPatch) { try { fs.copyFileSync(bakPatch, c.patchFile) } catch { /* best effort */ } }
          sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
    }
  }

  ctx.effect(() => host.register({ kind: 'prefix', path: HTTP_PREFIX, handler: h }))
  HOST_DIAG.endpointsRegistered = true
}

// --- plugin ------------------------------------------------------------------

function apply(ctx, config = {}) {
  const c0 = resolveContext(config, ctx && ctx.baseUrl)
  HOST_DIAG.profileName = c0.profileName
  HOST_DIAG.repoRoot = c0.repoRoot
  const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (ws !== undefined) {
    registerHttp(ctx, ws, config)
  } else {
    try {
      ctx.inject(['webServer'], (sub) => {
        registerHttp(ctx, sub && sub.webServer ? sub.webServer : sub, config)
      })
    } catch {
      // terminal-only profile: no web surface, nothing to serve.
    }
  }
  // Lazy yaml diag for /status
  const probe = requireProfileYaml(c0.profileDir)
  HOST_DIAG.yamlResolved = Boolean(probe.jsyaml)
  HOST_DIAG.yamlError = probe.error
}

export { apply, inject, name, registerHttp }
