// dsh-esc-rewind: node half (host behaviour for the optional DELETE mode).
//
// The rewind feature itself stays client-driven (fork / open / archive are all
// official CLIENT services). What a client cannot do — DSH has no public
// "delete a session" remote verb — is permanently remove an old session after a
// rewind. That is exactly what this half adds, but ONLY when the user turns the
// global switch on:
//
//   settings namespace `esc-rewind.deleteOldOnRewind`  (default false)
//     registered here so the settings page / settings.yaml can show it and the
//     client half can read it through `remote.settings.describe()`.
//
//   POST /__esc-rewind/session/delete   (webServer HTTP endpoint)
//     permanently deletes one session, but ONLY a childless one: a subagent
//     child is listed through its OWN header (parentSession), so removing the
//     parent log orphans it permanently — and a running child loses the parent
//     its settlement notice is addressed to. Refuses with 409 + {reason} and
//     the client degrades to archive. Then: refuses a live agent, flushes a live
//     session, removes its on-disk log dir (both id spellings), drops the
//     projection-cache row, and — only after the log is confirmed gone —
//     removes the workspace/archive accounting. Mirrors the storage facts the
//     installed @huanlin/dsh-plugin-session-delete proved against LIVE storage
//     services (no "resurrected" session after the next periodic flush), but is
//     self-contained here: no dependency on any third-party endpoint.
//
//   `esc_rewind_session_delete` model tool (best-effort)
//     same deleteSessionCore through ctx.tools, for terminal/edit-mode callers.
//
// Everything is optional: webServer may not exist (terminal-only), schemastery
// / tools may not resolve for an externally-installed bundle, storageDomain may
// be absent. Each capability registers lazily and degrades silently — the
// client falls back to archive mode (the safe default) whenever the delete
// channel is unreachable. The empty-apply era of this file is over, but the
// "never block apply on an absent service" rule is unchanged: inject stays [].
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const name = 'esc-rewind'
/** Settings namespace (client half mirrors this exact key). */
export const NS = 'esc-rewind'
/** Settings field holding the global delete-mode switch. */
export const SETTINGS_FIELD = 'deleteOldOnRewind'
/** Default composition value (safety first: archive, never delete). */
export const DEFAULT_DELETE_OLD = false
/** HTTP endpoint path served by the host webServer when present. */
export const DELETE_PATH = '/__esc-rewind/session/delete'
/** Read-only status probe path (diagnostics / ACCEPTANCE 5.10). */
export const STATUS_PATH = '/__esc-rewind/status'

/** No hard host dependencies: every service is reached lazily. */
const inject = []

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Refusal reasons the client maps to dedicated toasts (stable contract strings). */
export const BLOCK_REASON_CHILDREN = 'subagents'
export const BLOCK_REASON_UNKNOWN = 'subagents-unknown'

class DeleteError extends Error {
  constructor(message, status, details) {
    super(message)
    this.status = status
    this.details = details || null
  }
}

// --- path helpers ------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** Both id spellings (raw uuid and `session-` prefixed) across every store. */
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}

/** Locate ~/.dsh/sessions/<slug>/<sessionId>/ by scanning every slug dir. */
export function findSessionDirs(sessionId, rootOverride) {
  const root = rootOverride || sessionsRoot()
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, e.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}

/** Remove every on-disk session directory for both id spellings. */
export function removeSessionDirs(sessionId, rootOverride) {
  const dirs = findSessionDirs(sessionId, rootOverride)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length > 0
}

// --- live storage mutation (memory + disk stay consistent) -------------------

/**
 * Drop the session from the projection-cache domain and (optionally) the
 * workspace/archive accounting. Uses the opened domain facilities (the
 * authoritative in-memory state) so a periodic flush can never re-publish a
 * stale row. All id spellings are cleaned because projcache/workspace rows may
 * carry either the raw uuid or the `session-` prefixed form.
 */
export async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = typeof ctx.get === 'function' ? ctx.get('storageDomain') : null
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch { /* unit closed or table absent: nothing to clean */ }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
            })
            workspaceRemoved = true
          }
        }
      } catch { /* unit closed or table absent */ }
      try {
        const g = ws.global
        if (g && typeof g.get === 'function' && typeof g.set === 'function') {
          const state = g.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
            await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      } catch { /* no global slot or unit closed */ }
    }
  }

  return { projRemoved, workspaceRemoved }
}

// --- live-session teardown ----------------------------------------------------

/** Refuse / stop a live agent owning the session (time-boxed quiescence). */
export async function stopAgentIfRunning(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  if (typeof agent.cancel === 'function') {
    try { agent.cancel({ kind: 'user' }) } catch { /* agent may already be settling */ }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ])
    } catch { /* ignore: proceed with deletion anyway */ }
  }
  return true
}

/** Flush a live session before detaching it (no pending writes re-create files). */
export async function flushSessionIfLive(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session)
        flushed = true
      } catch { /* ignore: deletion proceeds and removes the log anyway */ }
    }
  }
  return flushed
}

/** Remove the session from the in-memory store (emits session/disposed). */
export function detachLiveSession(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch { /* ignore */ }
  return detached
}

// --- subagent guard ----------------------------------------------------------

/**
 * Count one session's durable direct subagent children before anything
 * destructive runs. A child is reachable only through its own header
 * (`parentSession`), so deleting the parent orphans it for good, and a child
 * that is still running loses the parent its settlement notice is addressed to.
 * Returns { known, blocked, reason, children, running, error }: an absent
 * `subagents` service is `known:false` (nothing can own a child), while a
 * failing listing is `known:null` + blocked — the irreversible step is never
 * taken when the absence of children cannot be proven.
 */
export async function subagentGuardOf(ctx, sessionId) {
  const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : null
  if (!subagents || typeof subagents.listChildren !== 'function') {
    return { known: false, blocked: false, reason: null, children: 0, running: 0, error: null }
  }
  let entries
  try {
    entries = await subagents.listChildren(sessionId)
  } catch (error) {
    const message = (error && error.message) ? error.message : String(error)
    return { known: null, blocked: true, reason: BLOCK_REASON_UNKNOWN, children: 0, running: 0, error: message }
  }
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : []
  const running = list.filter((entry) => entry.activity === 'running').length
  return {
    known: true,
    blocked: list.length > 0,
    reason: list.length > 0 ? BLOCK_REASON_CHILDREN : null,
    children: list.length,
    running,
    error: null,
  }
}

// --- core delete -------------------------------------------------------------

/**
 * Permanently delete one session end-to-end. Ordering keeps live storage and
 * on-disk units in sync: refuse/flush/detach a live owner, remove the on-disk
 * log FIRST, drop projection rows, re-sweep the disk (a mid-flight dispose may
 * have re-created it), then — only once no dir remains — remove workspace
 * accounting. A filesystem refusal throws BEFORE workspace accounting changes,
 * so a half-deleted session cannot fall out of its group into "Ungrouped".
 * The subagent guard runs first and refuses (409) without touching anything.
 */
export async function deleteSessionCore(ctx, sessionId, rootOverride) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) {
    throw new DeleteError(`invalid session id: ${String(sessionId)}`, 400)
  }
  const guard = await subagentGuardOf(ctx, sessionId)
  HOST_DIAG.lastGuard = { sessionId, ...guard }
  if (guard.blocked) {
    throw new DeleteError(guard.reason === BLOCK_REASON_CHILDREN
      ? `refusing to delete session "${sessionId}": it still owns ${guard.children} subagent session(s) (${guard.running} running)`
      : `refusing to delete session "${sessionId}": subagent state unavailable (${guard.error})`,
    409,
    { reason: guard.reason, children: guard.children, running: guard.running })
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  const firstDirRemoved = removeSessionDirs(sessionId, rootOverride)
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const secondDirRemoved = removeSessionDirs(sessionId, rootOverride)
  await new Promise((resolve) => setImmediate(resolve))
  const thirdDirRemoved = removeSessionDirs(sessionId, rootOverride)

  const remainingDirs = findSessionDirs(sessionId, rootOverride)
  if (remainingDirs.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }

  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved || thirdDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved, projRemoved, workspaceRemoved }
}

// --- settings section (optional, dynamic schemastery like sibling plugins) ----

/** Host-side diagnostics: whether the settings namespace registered. */
export const HOST_DIAG = {
  settingsSectionRegistered: false,
  settingsSectionError: null,
  settingsValue: DEFAULT_DELETE_OLD,
  /** Last subagent guard outcome (diagnostics / status probe). */
  lastGuard: null,
}

/**
 * Zero-dependency section schema compatible with the settings provider's use
 * of a schemastery schema. The provider only ever calls:
 *   - `schema(mergedValue)`  → resolve(): validate + apply defaults;
 *   - `schema.toJSON()`      → describe(): serialize for the settings page;
 *   - `redactSecrets(schema, value)` → walks it; a function (not a record)
 *     hits the walker's default branch and passes the value through — correct
 *     for a schema that declares no `role('secret')` field.
 * Returns a plain object `{ [field]: boolean }` (defaults applied), which is
 * exactly what z.object({ field: z.boolean().default(...) }) would admit.
 */
function fallbackSectionSchema(field, fallback) {
  const schema = (input) => {
    const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
    const raw = source[field]
    const out = { ...source }
    out[field] = typeof raw === 'boolean' ? raw : fallback
    return out
  }
  schema.toJSON = () => ({
    type: 'object',
    properties: {
      [field]: { type: 'boolean', default: fallback },
    },
  })
  return schema
}

function installSettingsSection(ctx, settings) {
  if (!settings || typeof settings.installSection !== 'function') {
    HOST_DIAG.settingsSectionError = 'settings-service-unavailable'
    return
  }
  const register = (Config) => {
    if (!Config) {
      HOST_DIAG.settingsSectionError = 'no-schema'
      return
    }
    settings.installSection(ctx, NS, Config, { [SETTINGS_FIELD]: DEFAULT_DELETE_OLD }, {
      // No host-side derivation; the client reads the resolved value through
      // remote.settings.describe(). Plain declarable namespace.
      setSource(source) {
        try {
          const current = source()
          HOST_DIAG.settingsValue = current && typeof current === 'object'
            ? current[SETTINGS_FIELD] === true
            : DEFAULT_DELETE_OLD
        } catch { /* source not ready yet */ }
      },
      onChange() {
        HOST_DIAG.settingsSectionRegistered = true
      },
    })
    HOST_DIAG.settingsSectionRegistered = true
  }

  // Preferred path: a real schemastery schema (proper settings-page rendering).
  // This import is dynamic and fully optional: an external link: bundle may not
  // resolve `@deepseek-ai/schemastery` from its own directory (the DSH host
  // resolves a bundle's bare specifiers against the plugin source dir, not the
  // host's closure — title-regenerate only works because it ships a local stub).
  // When it fails we MUST still register the namespace, otherwise the client's
  // settings.update() is rejected with "namespace is not registered".
  Promise.resolve()
    .then(() => import('@deepseek-ai/schemastery'))
    .then((mod) => {
      const z = mod && mod.default
      if (!z || typeof z.object !== 'function' || typeof z.boolean !== 'function') {
        HOST_DIAG.settingsSectionError = 'schemastery-incompatible-fallback'
        register(fallbackSectionSchema(SETTINGS_FIELD, DEFAULT_DELETE_OLD))
        return
      }
      register(z.object({
        [SETTINGS_FIELD]: z.boolean().default(DEFAULT_DELETE_OLD),
      }))
    })
    .catch((error) => {
      // External link: bundle cannot resolve schemastery — use the zero-dep
      // schema so the namespace is still registered and the switch persists.
      HOST_DIAG.settingsSectionError = (error && error.message) ? error.message : String(error)
      register(fallbackSectionSchema(SETTINGS_FIELD, DEFAULT_DELETE_OLD))
    })
}

// --- HTTP endpoint (optional: only when a web surface exists) -----------------

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

export function registerHttp(ctx, host) {
  if (!host || typeof host.register !== 'function') return
  // Read-only status probe: confirms the host half is live, the settings
  // namespace registered, and the current delete-mode value. No mutation.
  ctx.effect(() => host.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-esc-rewind',
        settingsSectionRegistered: HOST_DIAG.settingsSectionRegistered,
        settingsSectionError: HOST_DIAG.settingsSectionError,
        deleteOldOnRewind: HOST_DIAG.settingsValue === true,
        lastGuard: HOST_DIAG.lastGuard,
      })
    },
  }))
  ctx.effect(() => host.register({
    kind: 'exact',
    path: DELETE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let args = {}
      try {
        const body = await readBody(req)
        if (body) args = JSON.parse(body)
      } catch {
        sendJson(res, 400, { error: 'bad json body' })
        return
      }
      const sessionId = String(args.sessionId || '').trim()
      if (!sessionId) {
        sendJson(res, 400, { error: 'sessionId required' })
        return
      }
      try {
        const result = await deleteSessionCore(ctx, sessionId)
        sendJson(res, 200, { ok: true, removed: [sessionId], ...result })
      } catch (e) {
        const status = e instanceof DeleteError && e.status ? e.status : 500
        const details = e instanceof DeleteError && e.details ? e.details : null
        sendJson(res, status, details ? { error: e.message, ...details } : { error: e.message })
      }
    },
  }))
}

// --- model tool (best-effort: for terminal/edit-mode callers) -----------------

function registerDeleteTool(ctx, tools) {
  if (!tools || typeof tools.register !== 'function') return
  Promise.resolve().then(() => import('@deepseek-ai/dsh-tools')).then((mod) => {
    const defineTool = mod && mod.defineTool
    if (typeof defineTool !== 'function') return
    tools.register(defineTool({
      name: 'esc_rewind_session_delete',
      description: 'Permanently delete one session of this workbench (used by dsh-esc-rewind delete mode after a rewind): stops the agent if it is running (cancel + quiescence), then removes its persisted log, projection-cache row and workspace accounting. Irreversible.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'The session id to delete (uuid or session-<uuid> form).' },
      },
      output: { schema: { type: 'string' } },
      render(_args, value) { return [{ type: 'text', text: value }] },
      async execute(args) {
        const sessionId = String(args.sessionId || '').trim()
        try {
          const result = await deleteSessionCore(ctx, sessionId)
          return [
            `deleted: ${sessionId}`,
            `log dir removed: ${result.dirRemoved}`,
            `projection row removed: ${result.projRemoved}`,
            `workspace accounting removed: ${result.workspaceRemoved}`,
          ].join('\n')
        } catch (e) {
          return `delete failed: ${e.message}`
        }
      },
    }))
  }).catch(() => { /* tools unavailable: the HTTP endpoint still serves web */ })
}

// --- plugin ------------------------------------------------------------------

function apply(ctx) {
  // Settings section (optional): register the delete-mode switch namespace.
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : null
  if (settings !== undefined) {
    installSettingsSection(ctx, settings)
  } else {
    try {
      ctx.inject(['settings'], (sub) => {
        installSettingsSection(ctx, sub && sub.settings ? sub.settings : sub)
      })
    } catch { /* no settings service: switch stays default (archive) */ }
  }

  // HTTP delete endpoint (optional): register when a web surface appears.
  const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (ws !== undefined) {
    registerHttp(ctx, ws)
  } else {
    try {
      ctx.inject(['webServer'], (sub) => {
        registerHttp(ctx, sub && sub.webServer ? sub.webServer : sub)
      })
    } catch { /* terminal-only: no endpoint, client falls back to archive */ }
  }

  // Model tool (best-effort).
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
  if (tools !== undefined) {
    registerDeleteTool(ctx, tools)
  } else {
    try {
      ctx.inject(['tools'], (sub) => {
        registerDeleteTool(ctx, sub && sub.tools ? sub.tools : sub)
      })
    } catch { /* tools absent: skip */ }
  }
}

export { apply, inject, name, fallbackSectionSchema }
