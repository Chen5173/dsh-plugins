// dsh-hindsight-model: HOST half — cordis wiring.
//
// Responsibilities that must live host-side:
//   - the profile `.env` and the daemon log are files;
//   - `reg query` / `Get-NetTCPConnection` are child processes;
//   - DSH's resolved API keys have no client-facing remote surface, so the only
//     place a plaintext key can be obtained is here.
//
// Everything non-trivial (parsing, merging, judgement) lives in ./host-core.js
// and is driven by the injected `deps` below, which the offline harness fakes.
//
// No @deepseek-ai/* imports: a `link:`-ed host half cannot resolve them, and
// the plugin needs nothing beyond injected services (see design.md D1).
//
// Verified: 2026-09-13, change 2026-09-13-add-hindsight-model-panel.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import {
  API_PREFIX,
  PLUGIN_ID,
  createCore,
  parseDaemonProbe,
} from './host-core.js'

export const name = 'hindsight-model'

/** Every service is optional: a missing one degrades a feature, never apply(). */
export const inject = []

const ROUTES = {
  state: `${API_PREFIX}/state`,
  save: `${API_PREFIX}/save`,
  dshModel: `${API_PREFIX}/dsh-model`,
  verify: `${API_PREFIX}/verify`,
  cleanEnv: `${API_PREFIX}/clean-env`,
}

/** The exact route table, exported so the harness can assert it. */
export const ROUTE_TABLE = Object.values(ROUTES)

export { PLUGIN_ID, API_PREFIX, ROUTES }

// --- real deps --------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32'

/** Resolve a bare tool name to something CreateProcess will find. */
function toolPath(tool) {
  if (!IS_WINDOWS) return null
  if (tool === 'reg') return 'reg.exe'
  if (tool === 'powershell') return 'powershell.exe'
  return tool
}

function runCommand(args) {
  return new Promise((resolve) => {
    const [tool, ...rest] = Array.isArray(args) ? args : []
    const file = toolPath(tool)
    if (!file) {
      resolve({ ok: false, stdout: '', stderr: `unsupported platform for ${tool}`, error: 'unsupported-platform' })
      return
    }
    execFile(file, rest, { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? String(error.message || error) : null,
      })
    })
  })
}

async function httpGetJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`http ${response.status}`)
  return response.json()
}

/** `prefix*` listing without pulling in a glob dependency. */
function listByPrefix(pattern) {
  const dir = path.dirname(pattern)
  const prefix = path.basename(pattern)
  if (!prefix.endsWith('*')) return []
  const head = prefix.slice(0, -1)
  try {
    return fs.readdirSync(dir).filter((entry) => entry.startsWith(head)).map((entry) => path.join(dir, entry))
  } catch {
    return []
  }
}

function filesystemDeps() {
  const hindsightHome = path.join(os.homedir(), '.hindsight')
  return {
    hindsightHome,
    readText: (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    mtimeOf: (p) => {
      try {
        return fs.statSync(p).mtime
      } catch {
        return null
      }
    },
    writeText: (p, text) => fs.writeFileSync(p, text, 'utf8'),
    removeFile: (p) => {
      try {
        fs.rmSync(p, { force: true })
      } catch { /* nothing to clean up */ }
    },
    ensureDir: (p) => fs.mkdirSync(p, { recursive: true }),
    rename: (from, to) => fs.renameSync(from, to),
    glob: listByPrefix,
    timestamp: () => new Date().toISOString().replace(/[:.]/g, '-'),
    isoNow: () => new Date().toISOString(),
    run: runCommand,
    httpGetJson,
    env: process.env,
  }
}

// --- DSH side ---------------------------------------------------------------

/**
 * Read DSH's model facts through injected services only.
 *
 * Three things are worth remembering:
 *  - `agentDefaultModel` is a service whose read is a METHOD (`currentSelection()`),
 *    not a property;
 *  - a provider route's `baseURL` appears in NO enumerable API — it can only be
 *    reached by locating the configurable-provider entry and drilling into the
 *    settings namespace along `settingsPath`;
 *  - the resolved secret may only ever be used host-side. Nothing in this file
 *    logs it or returns it to a caller that serializes a response.
 */
export function createDshReader(ctx) {
  const get = (service) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(service) : null
    } catch {
      return null
    }
  }

  function routeOf(provider) {
    const llm = get('llm')
    const settings = get('settings')
    if (!llm || !settings || !provider) return null
    let entry = null
    try {
      entry = (llm.listConfigurableProviders() || []).find((candidate) => candidate.provider === provider) || null
    } catch {
      return null
    }
    if (!entry) return null
    let node
    try {
      node = settings.get(entry.settingsNs)
    } catch {
      return null
    }
    for (const segment of entry.settingsPath || []) {
      if (node === null || node === undefined) return null
      node = node[segment]
    }
    if (!node) return null
    return {
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath || [],
      baseURL: typeof node.baseURL === 'string' ? node.baseURL : null,
      apiKeyEnv: typeof node.apiKeyEnv === 'string' ? node.apiKeyEnv : null,
    }
  }

  /** Resolve the DSH-side key. The value NEVER leaves the host process. */
  async function resolveApiKey() {
    const credentials = get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') return null
    const selection = currentSelection()
    if (!selection || !selection.provider) return null
    const route = routeOf(selection.provider)
    if (!route || !route.apiKeyEnv) return null
    try {
      const resolved = await credentials.resolve(route.apiKeyEnv)
      if (!resolved || typeof resolved.value !== 'string') return null
      return { value: resolved.value, source: route.apiKeyEnv }
    } catch {
      return null
    }
  }

  function currentSelection() {
    const service = get('agentDefaultModel')
    if (!service) return null
    try {
      const selection = typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : null
      if (!selection) return null
      return {
        provider: selection.provider ?? null,
        model: selection.model ?? null,
        reasoningEffort: selection.reasoningEffort ?? null,
      }
    } catch {
      return null
    }
  }

  /** Metadata-only view of the DSH key: never the plaintext. */
  async function keyMetadata() {
    const selection = currentSelection()
    const route = selection && selection.provider ? routeOf(selection.provider) : null
    if (!route || !route.apiKeyEnv) return { hasValue: false, length: null, source: null }
    const credentials = get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') {
      return { hasValue: false, length: null, source: route.apiKeyEnv }
    }
    try {
      const resolved = await credentials.resolve(route.apiKeyEnv)
      if (!resolved || typeof resolved.value !== 'string') {
        return { hasValue: false, length: null, source: route.apiKeyEnv }
      }
      return { hasValue: true, length: resolved.value.length, source: route.apiKeyEnv }
    } catch {
      return { hasValue: false, length: null, source: route.apiKeyEnv }
    }
  }

  /** Everything the panel is allowed to know about the DSH side. */
  async function snapshot() {
    const missing = []
    if (!get('agentDefaultModel')) missing.push('agentDefaultModel')
    if (!get('llm')) missing.push('llm')
    if (!get('settings')) missing.push('settings')
    if (!get('credentials')) missing.push('credentials')
    const selection = currentSelection()
    const route = selection && selection.provider ? routeOf(selection.provider) : null
    const key = await keyMetadata()
    let providers = []
    try {
      const llm = get('llm')
      providers = llm && typeof llm.listProviders === 'function' ? (llm.listProviders() || []) : []
    } catch {
      providers = []
    }
    return {
      available: missing.length === 0,
      missing,
      selection,
      route,
      key,
      providers,
    }
  }

  return { snapshot, currentSelection, routeOf, keyMetadata, resolveApiKey }
}

// --- transport --------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, error: 'body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, error: 'invalid JSON body' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'request error' }))
  })
}

/**
 * Build the route handlers over a core + DSH reader.
 * Exported so the harness can drive the contract without a real server.
 */
export function createHandlers({ core, dsh }) {
  const guard = (fn) => async (req, res) => {
    let body = {}
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req)
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      body = parsed.value
    }
    try {
      await fn(req, res, body)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  return {
    [ROUTES.state]: guard(async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      sendJson(res, 200, await core.collectState({ dsh }))
    }),

    [ROUTES.dshModel]: guard(async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // `snapshot()` carries key METADATA only; the plaintext stays host-side.
      sendJson(res, 200, { ok: true, dsh: await dsh.snapshot() })
    }),

    [ROUTES.save]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      let resolvedKey
      if (body && body.useDshKey === true) {
        const resolved = await dsh.resolveApiKey()
        if (!resolved) {
          sendJson(res, 400, { ok: false, error: 'no DSH API key is resolvable for the current route' })
          return
        }
        resolvedKey = resolved.value
      }
      const result = core.save(body && body.changes, { resolvedKey })
      if (!result.ok) {
        const status = result.code === 'invalid-changes' ? 400 : 500
        sendJson(res, status, result)
        return
      }
      sendJson(res, 200, result)
    }),

    [ROUTES.verify]: guard(async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }
      sendJson(res, 200, await core.verify())
    }),

    [ROUTES.cleanEnv]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // Deleting user-level environment variables is irreversible in the shell;
      // require an explicit confirmation flag on the request itself.
      if (!body || body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: 'confirmation required' })
        return
      }
      const result = await core.cleanEnv({ keys: body.keys })
      sendJson(res, result.ok ? 200 : 500, result)
    }),
  }
}

/** Attach the route table to a host that exposes `register`. */
export function registerRoutes(ctx, host, handlers) {
  for (const [routePath, handler] of Object.entries(handlers)) {
    ctx.effect(() => host.register({ kind: 'exact', path: routePath, handler }))
  }
}

export function apply(ctx) {
  const core = createCore(filesystemDeps())
  const dsh = createDshReader(ctx)
  const handlers = createHandlers({ core, dsh })

  const mount = (host) => {
    if (!host || typeof host.register !== 'function') return
    registerRoutes(ctx, host, handlers)
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (webServer) {
    mount(webServer)
    return
  }
  // Terminal / Electron have no webServer: stay silent rather than throwing.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => mount(sub && sub.webServer ? sub.webServer : sub))
    }
  } catch { /* no webServer on this composition */ }
}

export const _module = { createCore, createDshReader, createHandlers, parseDaemonProbe, ROUTES }
