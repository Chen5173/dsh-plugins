// dsh-hindsight-model: HOST half core.
//
// Hindsight (Vectorize's long-term memory layer) runs as a SEPARATE Python
// daemon. It shares nothing with DSH — not the process, not the credentials,
// not even the notion of "the host agent's model" — so its inference model has
// to be configured on its own, in ~/.hindsight/profiles/<profile>.env.
//
// Three facts from the upstream sources shape everything below:
//
//  1. There is no hot reload (`HindsightConfig._config_cache` is process-local,
//     no HTTP reload endpoint exists), so a change only takes effect after the
//     daemon restarts.
//  2. The daemon start path REWRITES that authoritative .env:
//     `cli.py` loads the profile into os.environ WITHOUT overwriting keys that
//     are already there, `daemon_embed_manager.ensure_running()/_start_daemon()`
//     merge `{**profile_config, **config}` and then `_register_profile()`
//     persists the merged HINDSIGHT_API_* keys back through
//     `profile_manager.create_profile()`, which does
//     `write_text(render_config(config))` — a WHOLE-FILE rewrite. So an outer
//     environment variable of the same name silently wins and is written back
//     over whatever the panel saved.
//  3. `profile create` is therefore never safe to call from here; the panel
//     edits the file line by line instead, and the restart command it hands the
//     user clears those outer variables first.
//
// This module is plain logic over an injected `deps` object: no cordis types, no
// @deepseek-ai/* imports (a `link:`-ed host half cannot resolve them). That also
// makes every branch drivable from the offline harness.
//
// Verified: 2026-09-13, change 2026-09-13-add-hindsight-model-panel.

export const PLUGIN_ID = 'dsh-hindsight-model'
export const NS = 'hindsight-model'
export const API_PREFIX = '/__hindsight-model'

/** Disambiguates "missing" from a legitimate empty value on the file layer. */
export const MISSING = Symbol('missing')

// --- the config surface the panel owns --------------------------------------

/**
 * The four groups the settings panel exposes. Model keys for the vector stack
 * are provider-specific upstream (`HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL`); the
 * panel deliberately exposes only the `local` branch, which is the one this
 * machine actually runs.
 */
export const KEY_GROUPS = [
  {
    id: 'llm',
    keys: [
      'HINDSIGHT_API_LLM_PROVIDER',
      'HINDSIGHT_API_LLM_MODEL',
      'HINDSIGHT_API_LLM_BASE_URL',
      'HINDSIGHT_API_LLM_API_KEY',
    ],
  },
  {
    id: 'perOp',
    keys: [
      'HINDSIGHT_API_RETAIN_LLM_MODEL',
      'HINDSIGHT_API_REFLECT_LLM_MODEL',
    ],
  },
  {
    id: 'vectors',
    keys: [
      'HINDSIGHT_API_EMBEDDINGS_PROVIDER',
      'HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL',
      'HINDSIGHT_API_RERANKER_PROVIDER',
      'HINDSIGHT_API_RERANKER_LOCAL_MODEL',
    ],
  },
  {
    id: 'misc',
    keys: [
      'HINDSIGHT_API_PORT',
      'HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT',
      'HF_ENDPOINT',
    ],
  },
]

/** Every key the panel is allowed to write. Anything else is rejected. */
export const MANAGED_KEYS = KEY_GROUPS.flatMap((group) => group.keys)

/** Keys whose value must never leave the host process or reach a log. */
export function isSecretKey(key) {
  return typeof key === 'string' && /(API_KEY|_KEY|_SECRET|_TOKEN)$/.test(key)
}

/**
 * Built-in defaults, so a key that is simply absent can say what it falls back
 * to. Snapshotted from `hindsight_api/config.py` (DEFAULT_* constants) and the
 * embed daemon manager; deliberately not fetched at runtime.
 */
export const KEY_DEFAULTS = {
  HINDSIGHT_API_LLM_PROVIDER: 'openai',
  HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'local',
  HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: 'BAAI/bge-small-en-v1.5',
  HINDSIGHT_API_RERANKER_PROVIDER: 'local',
  HINDSIGHT_API_RERANKER_LOCAL_MODEL: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
  HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: '0',
}

/** `PROVIDER_DEFAULT_MODELS` snapshot, used to hint an unset model key. */
export const PROVIDER_DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  'openai-responses': 'gpt-5.6',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-3.5-flash',
  groq: 'openai/gpt-oss-120b',
  minimax: 'MiniMax-M3',
  deepseek: 'deepseek-v4-flash',
  zai: 'glm-4.5-flash',
  'opencode-go': 'deepseek-v4-flash',
  atlas: 'deepseek-ai/deepseek-v4-pro',
  ollama: 'gemma3:12b',
  'ollama-cloud': 'gemma3:12b',
  llamacpp: 'gemma-4-e2b-it',
  lmstudio: 'local-model',
}

/** Keys that must be cleared before a restart may trust the profile .env. */
export const CONFLICT_CANDIDATE_KEYS = MANAGED_KEYS

// --- pure functions ---------------------------------------------------------

/**
 * Parse a profile `.env` into addressable lines.
 *
 * Deliberately key-based, never line-based: `HINDSIGHT_API_LLM_BASE_URL` is
 * appended to the tail of the file by `render_config()` and has no template
 * line, so line numbers are not stable across renders.
 */
export function parseEnv(text) {
  const source = typeof text === 'string' ? text : ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  const entries = []
  const byKey = new Map()
  const lineOfKey = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i])
    if (!match) continue
    const [, key, rawValue] = match
    entries.push({ key, value: rawValue, line: i })
    if (!byKey.has(key)) {
      byKey.set(key, rawValue)
      lineOfKey.set(key, i)
    }
  }
  return { eol, lines, trailingNewline, entries, byKey, lineOfKey }
}

/**
 * Apply `{ KEY: value | null }` to the profile text and return the new text.
 *
 * - an existing key is rewritten in place, so every other line (comments,
 *   template rows, unknown keys, ordering) stays byte-for-byte identical;
 * - an absent key is appended at the tail;
 * - `null` removes the key's line;
 * - the input's line-ending style and trailing-newline state are preserved.
 */
export function applyEnvChanges(text, changes) {
  const { eol, lines, trailingNewline, lineOfKey } = parseEnv(text)
  const body = trailingNewline ? lines.slice(0, -1) : lines.slice()
  const removals = new Set()
  const appends = []
  for (const [key, value] of Object.entries(changes || {})) {
    const at = lineOfKey.get(key)
    if (value === null) {
      if (at !== undefined) removals.add(at)
      continue
    }
    const rendered = `${key}=${String(value)}`
    if (at !== undefined) body[at] = rendered
    else appends.push(rendered)
  }
  const kept = body.filter((_, index) => !removals.has(index))
  const out = kept.concat(appends).join(eol)
  return trailingNewline ? out + eol : out
}

/**
 * Find the LAST startup block in the daemon log.
 *
 * One block reads:
 *   OpenAI-compatible client initialized: provider=…, model=…, base_url=…
 *   Verifying connection: <provider>/<model>
 *   Connection verified: <provider>/<model>
 * The first line is the config the daemon actually read; the last two are a real
 * round-trip against the endpoint. It is the hardest evidence available.
 */
export function parseStartupLog(text) {
  const empty = {
    found: false,
    provider: null,
    model: null,
    baseUrl: null,
    verifyLine: null,
    connected: null,
    line: null,
  }
  if (typeof text !== 'string' || text === '') return empty
  const lines = text.split(/\r?\n/)
  let initIndex = -1
  let initLine = null
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('OpenAI-compatible client initialized')) {
      initIndex = i
      initLine = lines[i]
    }
  }
  if (initIndex === -1) return empty
  const field = (name) => {
    const match = new RegExp(`${name}\\s*=\\s*([^,\\s]+)`).exec(initLine)
    return match ? match[1] : null
  }
  let verifyLine = null
  let connected = null
  for (let i = initIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.includes('Verifying connection')) {
      verifyLine = line.trim()
      connected = null
    } else if (verifyLine !== null && line.includes('Connection verified')) {
      connected = true
    } else if (verifyLine !== null && connected === null && /error|failed|refused|timed? ?out/i.test(line)) {
      connected = false
    }
  }
  return {
    found: true,
    provider: field('provider'),
    model: field('model'),
    baseUrl: field('base_url'),
    verifyLine,
    connected,
    line: initIndex + 1,
  }
}

/** Render a value for display: secrets collapse to their length. */
export function displayValue(key, value) {
  if (value === undefined || value === null) return null
  if (isSecretKey(key)) return { secret: true, length: String(value).length }
  return { secret: false, value: String(value) }
}

/**
 * Compare the outer sources against the authoritative file.
 *
 * Two groups are reported separately and never merged: the OS user-level
 * environment is cleanable by this plugin, the host process environment is not
 * (it comes from whatever launched `dsh web`).
 */
export function computeConflicts({ keys, profileMap, userEnv, processEnv }) {
  const list = Array.isArray(keys) ? keys : MANAGED_KEYS
  const userLevel = []
  const processLevel = []
  for (const key of list) {
    const onDisk = profileMap instanceof Map ? profileMap.get(key) : undefined
    const outer = userEnv ? userEnv[key] : undefined
    if (outer !== undefined && outer !== onDisk) {
      userLevel.push({ key, outer: displayValue(key, outer), onDisk: displayValue(key, onDisk) })
    }
    const inProcess = processEnv ? processEnv[key] : undefined
    if (inProcess !== undefined && inProcess !== onDisk) {
      processLevel.push({ key, outer: displayValue(key, inProcess), onDisk: displayValue(key, onDisk) })
    }
  }
  return { userLevel, processLevel }
}

/**
 * The timing judgement, kept as the FALLBACK evidence only.
 *
 * Measured on the real machine (2026-09-13): the profile file was written at
 * 18:56:29 while the daemon had started at 18:55:46 — the upstream start path
 * itself rewrites that file (`_register_profile()` → `create_profile()`), so
 * "file newer than process" happens on a perfectly healthy configuration. Used
 * alone it would cry wolf forever, so it is consulted only when the running
 * process's own values cannot be read.
 *
 * Equal timestamps count as not proven — better a false "not yet" than a false
 * "applied".
 */
export function isEffectivelyApplied(startTime, envMtime) {
  const start = startTime instanceof Date ? startTime.getTime() : NaN
  const mtime = envMtime instanceof Date ? envMtime.getTime() : NaN
  if (Number.isNaN(start)) return { known: false, applied: false, reason: 'daemon-not-running' }
  if (Number.isNaN(mtime)) return { known: false, applied: false, reason: 'env-missing' }
  return start > mtime
    ? { known: true, applied: true, reason: 'applied' }
    : { known: true, applied: false, reason: 'stale' }
}

/** The three keys whose agreement decides whether a configuration is in effect. */
export const TRIPLE_KEYS = {
  provider: 'HINDSIGHT_API_LLM_PROVIDER',
  model: 'HINDSIGHT_API_LLM_MODEL',
  baseUrl: 'HINDSIGHT_API_LLM_BASE_URL',
}

/** The inference triple as written in the authoritative file. */
export function tripleOfFile(profileMap) {
  const read = (key) => (profileMap instanceof Map && profileMap.has(key) ? profileMap.get(key) : null)
  return {
    provider: read(TRIPLE_KEYS.provider),
    model: read(TRIPLE_KEYS.model),
    baseUrl: read(TRIPLE_KEYS.baseUrl),
  }
}

const asIso = (value) => (value instanceof Date ? value.toISOString() : null)

/**
 * Decide whether the configuration on disk is the one in effect.
 *
 * Primary evidence is the running process's own reading of it (its startup
 * block): the triple either matches the file, or it does not — and a mismatch
 * names exactly which fields differ. The start-time/mtime ordering is only a
 * fallback for when no startup block is available, because the upstream start
 * path rewrites that file itself and would otherwise make a healthy setup look
 * stale forever.
 */
export function judgeApplied({ profileMap, startup, startTime, envMtime }) {
  const timing = isEffectivelyApplied(startTime, envMtime)
  const file = tripleOfFile(profileMap)
  const rewrittenAfterStart = timing.known ? !timing.applied : null
  const runtime = startup && startup.found
    ? { provider: startup.provider, model: startup.model, baseUrl: startup.baseUrl }
    : null
  const usable = runtime && Object.values(runtime).some((value) => value !== null && value !== undefined)

  if (!usable) {
    return {
      known: timing.known,
      applied: timing.known ? timing.applied : false,
      reason: timing.reason,
      basis: 'timing',
      runtimeKnown: false,
      file,
      runtime: null,
      mismatched: [],
      startTime: asIso(startTime),
      envMtime: asIso(envMtime),
      rewrittenAfterStart,
    }
  }

  // Only fields the process actually reported are compared: a log line that
  // never carried `base_url` must not read as a disagreement.
  const mismatched = ['provider', 'model', 'baseUrl'].filter(
    (field) => runtime[field] !== null && runtime[field] !== undefined && runtime[field] !== file[field],
  )
  return {
    known: true,
    applied: mismatched.length === 0,
    reason: mismatched.length === 0 ? 'consistent' : 'mismatch',
    basis: 'values',
    runtimeKnown: true,
    file,
    runtime,
    mismatched,
    startTime: asIso(startTime),
    envMtime: asIso(envMtime),
    rewrittenAfterStart,
  }
}

/** One field's three states, kept distinct: set / unset / overridden. */
export function fieldState(key, profileMap, conflicts) {
  const overridden = conflicts
    && (conflicts.userLevel.some((c) => c.key === key) || conflicts.processLevel.some((c) => c.key === key))
  if (overridden) return 'overridden'
  return profileMap instanceof Map && profileMap.has(key) ? 'set' : 'unset'
}

/** What an unset key falls back to, or null when that is provider-dependent. */
export function defaultValueOf(key, profileMap) {
  if (Object.prototype.hasOwnProperty.call(KEY_DEFAULTS, key)) return KEY_DEFAULTS[key]
  if (key === 'HINDSIGHT_API_LLM_MODEL') {
    const provider = profileMap instanceof Map ? profileMap.get('HINDSIGHT_API_LLM_PROVIDER') : undefined
    return (provider && PROVIDER_DEFAULT_MODELS[provider]) || null
  }
  return null
}

/**
 * The restart command handed to the user.
 *
 * The plugin never starts or stops the daemon itself. What it CAN do is make the
 * command correct: clear the outer variables that would otherwise be written
 * back over the profile, then restart. `Remove-Item Env:` affects only this
 * PowerShell session (and children), which is exactly the scope needed.
 */
export function buildRestartCommand({ daemonProfile, embedPackagePath, conflictKeys }) {
  if (!daemonProfile || !embedPackagePath) return null
  const keys = Array.from(new Set(Array.isArray(conflictKeys) ? conflictKeys : [])).sort()
  const lines = []
  if (keys.length > 0) {
    lines.push(`Remove-Item ${keys.map((key) => `Env:${key}`).join(', ')} -ErrorAction SilentlyContinue`)
  }
  lines.push(`uv run --directory "${embedPackagePath}" hindsight-embed daemon --profile ${daemonProfile} stop`)
  lines.push(`uv run --directory "${embedPackagePath}" hindsight-embed daemon --profile ${daemonProfile} start`)
  return lines.join('\n')
}

/** Parse `reg query HKCU\Environment` output into a plain map. */
export function parseRegQuery(stdout) {
  const out = {}
  if (typeof stdout !== 'string') return out
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD|QWORD|BINARY)\s+(.*)$/.exec(line)
    if (match) out[match[1]] = match[2]
  }
  return out
}

/** Parse `"<pid>|<iso8601>"` produced by the daemon probe. */
export function parseDaemonProbe(stdout) {
  const empty = { pid: null, name: null, commandLine: null, startTime: null }
  if (typeof stdout !== 'string') return empty
  // `pid|name|startTime|commandLine` — the command line is last because it can
  // itself contain the separator, so the split is bounded.
  const parts = stdout.trim().split('|')
  if (parts.length < 3) return empty
  const pid = Number(parts[0])
  const name = parts[1] || null
  const stamp = parts[2]
  const commandLine = parts.length > 3 ? parts.slice(3).join('|') : null
  // PowerShell's `ToString('o')` emits seven fractional-second digits; V8 parses
  // that fine (verified), but the value carries a LOCAL offset, so every
  // comparison against a filesystem mtime must stay instant-based, never
  // string-based.
  const date = new Date(stamp)
  // Two shapes are accepted: the original `pid|name|startTime|commandLine`, and
  // the current `pid|name|startTime|exePath|commandLine` (the image path was
  // added so the panel can tell a console-capable interpreter from a
  // console-free one). The command line is ALWAYS last: it can itself contain
  // the separator, so the split has to be bounded from the left.
  const withImage = parts.length >= 5
  const exePath = withImage ? (parts[3] || null) : null
  const rest = withImage ? parts.slice(4) : parts.slice(3)
  return {
    pid: Number.isFinite(pid) ? pid : null,
    name,
    exePath,
    commandLine: rest.length > 0 ? rest.join('|') : null,
    startTime: Number.isNaN(date.getTime()) ? null : date,
  }
}

// --- launcher form (pure) ---------------------------------------------------

/** PE optional-header subsystem values that matter here. */
export const PE_SUBSYSTEM_GUI = 2
export const PE_SUBSYSTEM_CONSOLE = 3

/**
 * The subsystem declared by one PE image, or null when the bytes are not a PE
 * image we can read. Only the file's own header is consulted: no version
 * probing, no upstream internals, no guessing from names.
 */
export function peSubsystemOf(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 0x40) return null
  const u16 = (at) => bytes[at] | ((bytes[at + 1] || 0) << 8)
  const u32 = (at) => (u16(at) | (u16(at + 2) << 16)) >>> 0
  if (u16(0) !== 0x5a4d) return null // 'MZ'
  const lfanew = u32(0x3c)
  if (lfanew < 0x40 || lfanew + 24 + 70 > bytes.length) return null
  if (u32(lfanew) !== 0x00004550) return null // 'PE\0\0'
  return u16(lfanew + 24 + 68)
}

/** `gui` never allocates a console; `console` does; anything else is unknown. */
export function launcherFormOf(subsystem) {
  if (subsystem === PE_SUBSYSTEM_GUI) return 'gui'
  if (subsystem === PE_SUBSYSTEM_CONSOLE) return 'console'
  return 'unknown'
}

/** Name-based fallback, used only when the image bytes cannot be read. */
export function launcherFormFromName(name) {
  const text = String(name === undefined || name === null ? '' : name).toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('pythonw')) return 'gui'
  if (text.includes('python')) return 'console'
  return 'unknown'
}

/** `home = <base install>` out of a venv's `pyvenv.cfg`. */
export function parsePyvenvHome(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*home\s*=\s*(.+?)\s*$/)
    if (match && match[1]) return match[1]
  }
  return null
}

/** Where the SAME interpreter release keeps its console-free venv launcher. */
export function guiLauncherSourceOf(home) {
  if (!home) return null
  return `${String(home).replace(/[\\/]+$/, '')}\\Lib\\venv\\scripts\\nt\\pythonw.exe`
}

/**
 * Decide whether the launcher must be replaced before the daemon starts.
 *
 * `console` ⇒ replace, but ONLY when a console-free launcher of the same release
 * exists: "no source" is not permission to start (the whole point is to avoid
 * the window). `gui` and `unknown` both leave the disk untouched.
 */
export function planLauncherHeal({ form, guiSourceAvailable } = {}) {
  if (form === 'console') {
    return guiSourceAvailable
      ? { action: 'replace', reason: 'console-launcher' }
      : { action: 'none', reason: 'no-gui-source', blocked: true }
  }
  if (form === 'gui') return { action: 'none', reason: 'already-gui', blocked: false }
  return { action: 'none', reason: 'form-unknown', blocked: false }
}

// --- on-demand auto start (pure) --------------------------------------------

/** Backoff after N consecutive failures: 1 / 5 / 15 / 30 minutes, then capped. */
export const BACKOFF_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000]
export const AUTO_ORIGINS = ['auto', 'manual', 'external', 'unknown']

export function backoffDelayMs(failures) {
  const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0
  if (n === 0) return 0
  return BACKOFF_STEPS_MS[Math.min(n, BACKOFF_STEPS_MS.length) - 1]
}

/**
 * Fold one attempt into the auto-start bookkeeping.
 *
 * `notice` is non-null only when the picture CHANGED (first failure, or a
 * different outcome than last time) — that is what keeps the panel from
 * repeating the same line on every session. A success clears the backoff.
 */
export function advanceAutoAttempt(state, { ok, code, at, now } = {}) {
  const prev = state && typeof state === 'object' ? state : {}
  const failures = ok === true ? 0 : (prev.failures || 0) + 1
  const lastResult = { at: at === undefined ? null : at, ok: ok === true, code: code === undefined ? null : code }
  const previous = prev.lastResult || null
  // A notice marks a CHANGE of outcome, not every escalation: the failure count
  // and the retry window ride along in the state, so the panel stays truthful
  // without repeating the same line on every session.
  const changed = !previous || previous.code !== lastResult.code
  return {
    state: {
      ...prev,
      failures,
      lastResult,
      backoffUntil: ok === true ? 0 : (now || 0) + backoffDelayMs(failures),
    },
    notice: changed && ok !== true ? { kind: 'auto-start-failed', failures, code: lastResult.code } : null,
  }
}

/** Whether a trigger is allowed to attempt a start now (backoff window aside). */
export function autoAttemptDue(state, now) {
  const current = state && typeof state === 'object' ? state : {}
  if (!current.failures) return true
  if (!current.backoffUntil) return true
  return !(now < current.backoffUntil)
}

/**
 * Who started the running daemon, and can it pop a console window?
 *
 * Evidence only: the listener's pid, its image name/path (and, when readable,
 * the subsystem of that image) plus what THIS process did — never a marker file
 * and never upstream state.
 */
export function classifyDaemonOrigin({ known, pid, imageName, imageForm, startedBy } = {}) {
  const form = imageForm && imageForm !== 'unknown' ? imageForm : launcherFormFromName(imageName)
  const consoleRisk = form === 'console'
  if (!known || pid === null || pid === undefined) return { origin: 'unknown', consoleRisk: false, form }
  const mine = startedBy && startedBy.pid === pid ? startedBy.reason : null
  if (mine === 'auto' || mine === 'manual') return { origin: mine, consoleRisk, form }
  return { origin: 'external', consoleRisk, form }
}

/**
 * Is the process holding this port REALLY the Hindsight daemon?
 *
 * Upstream refuses to signal a listener it cannot positively identify (its
 * issue #3520): failing to reclaim a port is recoverable, terminating an
 * unrelated service that merely holds it is not. We keep that property — the
 * command line must name the daemon module, be a daemon, and be bound to the
 * port we are looking at.
 *
 * Measured on this machine:
 *   python.exe -m hindsight_api.main --daemon --idle-timeout 0 --port 9077
 */
export function identifyHindsightProcess({ name, commandLine, port }) {
  const cmd = typeof commandLine === 'string' ? commandLine : ''
  if (!cmd) return { ok: false, reason: 'process-identity-unknown' }
  if (!/(^|[\\/\s])hindsight_api\.main\b/.test(cmd)) return { ok: false, reason: 'not-a-hindsight-daemon' }
  if (!/(^|\s)--daemon\b/.test(cmd)) return { ok: false, reason: 'not-a-hindsight-daemon' }
  if (port && !new RegExp(`--port\\s+${port}(\\s|$)`).test(cmd)) return { ok: false, reason: 'bound-to-another-port' }
  const procName = typeof name === 'string' ? name.toLowerCase() : ''
  if (procName && !/python|hindsight/.test(procName)) return { ok: false, reason: `unexpected process name: ${name}` }
  return { ok: true, reason: null }
}

/** Validate a requested change set against the managed surface. */
export function validateChanges(changes) {
  const errors = []
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { ok: false, errors: ['changes must be an object'] }
  }
  const keys = Object.keys(changes)
  if (keys.length === 0) return { ok: false, errors: ['no changes supplied'] }
  for (const key of keys) {
    if (!MANAGED_KEYS.includes(key)) errors.push(`unmanaged key: ${key}`)
    const value = changes[key]
    if (value !== null && typeof value !== 'string') errors.push(`value for ${key} must be a string or null`)
    if (typeof value === 'string' && value.includes('\n')) errors.push(`value for ${key} must not contain newlines`)
  }
  return { ok: errors.length === 0, errors }
}

// --- daemon lifecycle -------------------------------------------------------

/** The three actions the panel exposes. `restart` is NOT a CLI subcommand. */
export const DAEMON_ACTIONS = ['start', 'stop', 'restart']

/** Generous by design: `uv` cold-starts, and stopping waits for a real exit. */
export const ACTION_TIMEOUT_MS = { start: 120000, stop: 90000 }

/** How long to wait for the port to free between a restart's stop and start. */
export const PORT_FREE_WAIT = { attempts: 40, intervalMs: 250 }

/**
 * A copy of `env` with every profile-owned key removed.
 *
 * This is the whole reason the plugin spawns the daemon itself instead of
 * handing the user a command: `cli.py` loads the profile into `os.environ`
 * WITHOUT overwriting keys that are already there, so any outer variable of the
 * same name wins and is then written back over the profile by
 * `_register_profile()`. Stripping them makes the profile the only source of
 * truth. The input object is never mutated.
 */
export function sanitizedEnv(env, keys = MANAGED_KEYS) {
  const out = { ...(env || {}) }
  for (const key of keys) delete out[key]
  return out
}

/**
 * argv (minus the executable) for one daemon action.
 *
 * `uv run --directory <embed-project> hindsight-embed daemon --profile <p> …`
 * Returns null when the machine's layout cannot produce a command — the panel
 * then disables the block instead of guessing.
 */
export function daemonArgs({ embedPackagePath, daemonProfile, action }) {
  if (!embedPackagePath || !daemonProfile) return null
  if (action !== 'start' && action !== 'stop') return null
  return ['run', '--directory', embedPackagePath, 'hindsight-embed', 'daemon', '--profile', daemonProfile, action]
}

/** What the user would have typed, for display and audit. */
export function daemonCommandLine(args) {
  if (!Array.isArray(args) || args.length === 0) return null
  return `uv ${args.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')}`
}

/** Credential-shaped tokens must never reach a log or a response. */
function redactLine(line) {
  return line
    .replace(/([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET)[A-Za-z0-9_-]*\s*[=:]\s*)(\S+)/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-<redacted>')
}

/** The tail of a command's output, redacted and bounded. */
export function tailForDisplay(text, { lines = 12, maxChars = 1200 } = {}) {
  if (typeof text !== 'string' || text === '') return ''
  const kept = text.split(/\r?\n/).map(redactLine).slice(-lines).join('\n').trim()
  return kept.length > maxChars ? `…${kept.slice(-maxChars)}` : kept
}

// --- IO over injected deps --------------------------------------------------

/**
 * Build the host-side core over an injected `deps` object.
 *
 * @param {object} deps
 * @param {string} deps.hindsightHome        absolute path of ~/.hindsight
 * @param {(p: string) => (string | null)} deps.readText
 * @param {(p: string) => (Date | null)} deps.mtimeOf
 * @param {(p: string, text: string) => void} deps.writeText
 * @param {(p: string) => void} deps.removeFile
 * @param {(p: string) => void} deps.ensureDir
 * @param {(from: string, to: string) => void} deps.rename
 * @param {(pattern: string) => string[]} [deps.glob]        newest-first backup listing
 * @param {() => string} deps.timestamp      filesystem-safe stamp, e.g. 2026-09-13T10-21-25-123Z
 * @param {() => string} deps.isoNow         ISO timestamp for exports
 * @param {(args: string[]) => Promise<{ok: boolean, stdout: string, stderr: string}>} deps.run
 * @param {(url: string) => Promise<any>} [deps.httpGetJson] daemon HTTP probe
 * @param {Record<string, string | undefined>} deps.env
 */
export function createCore(deps) {
  const { hindsightHome } = deps
  const configPath = `${hindsightHome}/coding-agent.json`

  /** Read the machine's Hindsight layout instead of hardcoding anything. */
  function readLayout() {
    const text = deps.readText(configPath)
    if (text === null || text === undefined) {
      return { ok: false, reason: 'coding-agent.json not found', daemonProfile: null, apiPort: null, embedPackagePath: null }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'coding-agent.json is not valid JSON', daemonProfile: null, apiPort: null, embedPackagePath: null }
    }
    return {
      ok: true,
      reason: null,
      daemonProfile: parsed.daemonProfile || null,
      apiPort: Number.isFinite(Number(parsed.apiPort)) ? Number(parsed.apiPort) : null,
      embedPackagePath: parsed.embedPackagePath || null,
    }
  }

  const envPathOf = (profile) => (profile ? `${hindsightHome}/profiles/${profile}.env` : null)
  const logPathOf = (profile) => (profile ? `${hindsightHome}/profiles/${profile}.log` : null)

  /** Layer ①: the authoritative file on disk. */
  function readProfileLayer(layout) {
    const path = envPathOf(layout.daemonProfile)
    if (!path) return { known: false, reason: 'profile-unknown', path: null, parsed: null }
    const text = deps.readText(path)
    if (text === null || text === undefined) {
      return { known: false, reason: 'profile-missing', path, parsed: null }
    }
    return { known: true, reason: null, path, parsed: parseEnv(text), text }
  }

  /** Layer ②: what the running process actually read, from its startup block. */
  function readRuntimeLayer(layout) {
    const path = logPathOf(layout.daemonProfile)
    if (!path) return { known: false, reason: 'profile-unknown', path: null, startup: null }
    const text = deps.readText(path)
    if (text === null || text === undefined) {
      return { known: false, reason: 'log-missing', path, startup: null }
    }
    const startup = parseStartupLog(text)
    if (!startup.found) return { known: false, reason: 'no-startup-block', path, startup }
    return { known: true, reason: null, path, startup }
  }

  /** Layer ③a: the OS user-level environment. */
  async function readUserLevelEnv() {
    const result = await deps.run(['reg', 'query', 'HKCU\\Environment'])
    if (!result || !result.ok) return { known: false, reason: 'reg-query-failed', map: {} }
    return { known: true, reason: null, map: parseRegQuery(result.stdout) }
  }

  /** Layer ③b: this host process's own environment. */
  function readProcessEnv() {
    const map = {}
    for (const key of CONFLICT_CANDIDATE_KEYS) {
      if (deps.env && deps.env[key] !== undefined) map[key] = deps.env[key]
    }
    return map
  }

  /** Layer ④: has the daemon actually restarted since the file changed? */
  async function readDaemonProbe(apiPort) {
    const unknown = { known: false, reason: 'port-unknown', pid: null, name: null, exePath: null, commandLine: null, startTime: null }
    if (!apiPort) return unknown
    // The command line is what lets a stop identify the process before
    // signalling it, so the probe collects it up front. The image path rides
    // along — BEFORE the command line, which may itself contain the separator —
    // because "can this interpreter allocate a console?" is a property of the
    // image, not of the port.
    const script = [
      `$c = Get-NetTCPConnection -LocalPort ${apiPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
      'if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;',
      "  if ($p) { $ci = Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $c.OwningProcess) -ErrorAction SilentlyContinue;",
      "    Write-Output (\"$($c.OwningProcess)|$($p.ProcessName)|$($p.StartTime.ToString('o'))|$($ci.ExecutablePath)|$($ci.CommandLine)\") } }",
    ].join('; ')
    const result = await deps.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
    if (!result || !result.ok) {
      return { known: false, reason: 'probe-failed', pid: null, name: null, exePath: null, commandLine: null, startTime: null }
    }
    const parsed = parseDaemonProbe(result.stdout)
    if (parsed.pid === null) {
      return { known: false, reason: 'daemon-not-running', pid: null, name: null, exePath: null, commandLine: null, startTime: null }
    }
    return {
      known: true,
      reason: null,
      pid: parsed.pid,
      name: parsed.name,
      exePath: parsed.exePath || null,
      commandLine: parsed.commandLine,
      startTime: parsed.startTime,
    }
  }

  /**
   * The daemon's own health report.
   *
   * A refused connection is a RESULT ("not reachable"), not an unknown — the
   * panel is asked to show a health result, and "unreachable" is exactly that.
   */
  async function readHealth(apiPort) {
    if (!apiPort || typeof deps.httpGetJson !== 'function') {
      return { known: false, reachable: false, status: null, database: null }
    }
    try {
      const body = await deps.httpGetJson(`http://127.0.0.1:${apiPort}/health`)
      return {
        known: true,
        reachable: true,
        status: (body && body.status) || null,
        database: (body && body.database) || null,
      }
    } catch {
      return { known: true, reachable: false, status: null, database: null }
    }
  }

  /** Collect the whole four-layer picture plus everything the panel renders. */
  async function collectState({ dsh } = {}) {
    const layout = readLayout()
    const profile = readProfileLayer(layout)
    const runtime = readRuntimeLayer(layout)
    const userLevel = await readUserLevelEnv()
    const processEnv = readProcessEnv()
    const probe = await readDaemonProbe(layout.apiPort)
    const health = probe.known ? await readHealth(layout.apiPort) : { known: false, reachable: false, status: null, database: null }
    const envMtime = profile.path ? deps.mtimeOf(profile.path) : null
    const origin = daemonOriginOf(probe)

    const profileMap = profile.parsed ? profile.parsed.byKey : new Map()
    const conflicts = computeConflicts({
      keys: MANAGED_KEYS,
      profileMap,
      userEnv: userLevel.map,
      processEnv,
    })
    // Both the "running values" layer and the verdict depend on the daemon
    // actually being up: a log on disk is history, not current state.
    const applied = probe.known
      ? judgeApplied({ profileMap, startup: runtime.startup, startTime: probe.startTime, envMtime })
      : {
          known: false,
          applied: false,
          reason: probe.reason === 'daemon-not-running' ? 'daemon-not-running' : probe.reason,
          basis: 'timing',
          runtimeKnown: false,
          file: tripleOfFile(profileMap),
          runtime: null,
          mismatched: [],
          startTime: null,
          envMtime: asIso(envMtime),
          rewrittenAfterStart: null,
        }

    const conflictKeys = [
      ...conflicts.userLevel.map((c) => c.key),
      ...conflicts.processLevel.map((c) => c.key),
    ]

    const fields = MANAGED_KEYS.map((key) => ({
      key,
      state: fieldState(key, profileMap, conflicts),
      onDisk: displayValue(key, profileMap.get(key)),
      fallback: defaultValueOf(key, profileMap),
    }))

    const dshRead = dsh ? await dsh.snapshot() : { available: false, missing: ['host'] }

    return {
      ok: true,
      layout: {
        ok: layout.ok,
        reason: layout.reason,
        daemonProfile: layout.daemonProfile,
        apiPort: layout.apiPort,
        embedPackagePath: layout.embedPackagePath,
      },
      layers: {
        profile: {
          known: profile.known,
          reason: profile.reason,
          path: profile.path,
          mtime: envMtime ? envMtime.toISOString() : null,
          entries: profile.parsed ? profile.parsed.entries.map((e) => ({
            key: e.key,
            value: displayValue(e.key, e.value),
          })) : [],
        },
        runtime: {
          known: runtime.known && probe.known,
          reason: probe.known ? runtime.reason : 'daemon-not-running',
          path: runtime.path,
          provider: runtime.startup ? runtime.startup.provider : null,
          model: runtime.startup ? runtime.startup.model : null,
          baseUrl: runtime.startup ? runtime.startup.baseUrl : null,
          connected: runtime.startup ? runtime.startup.connected : null,
        },
        conflicts: {
          userLevelKnown: userLevel.known,
          userLevelReason: userLevel.reason,
          userLevel: conflicts.userLevel,
          processLevel: conflicts.processLevel,
        },
        applied: {
          known: applied.known,
          applied: applied.applied,
          reason: applied.reason,
          basis: applied.basis,
          runtimeKnown: applied.runtimeKnown,
          mismatched: applied.mismatched,
          file: applied.file,
          runtime: applied.runtime,
          rewrittenAfterStart: applied.rewrittenAfterStart,
          pid: probe.pid,
          startTime: applied.startTime,
          envMtime: applied.envMtime,
        },
      },
      fields,
      groups: KEY_GROUPS,
      restart: {
        command: buildRestartCommand({
          daemonProfile: layout.daemonProfile,
          embedPackagePath: layout.embedPackagePath,
          conflictKeys,
        }),
        conflictKeys,
      },
      daemon: {
        // The panel may only drive the lifecycle when it can build a real
        // command AND this host can spawn. Otherwise the block is disabled and
        // says which piece is missing.
        canControl: typeof deps.spawn === 'function' && layout.ok && Boolean(layout.embedPackagePath),
        reason: layout.ok
          ? (typeof deps.spawn === 'function' ? null : 'this host cannot spawn processes')
          : layout.reason,
        running: probe.known,
        pid: probe.pid,
        health,
        commands: daemonCommands(),
      },
      // Requirement "启动来源可见": who started this daemon, and can it pop a
      // console? Evidence = the listener's image + what THIS process did.
      origin,
      auto: autoView(origin),
      backups: listBackups(),
      dsh: dshRead,
    }
  }

  /** Timestamped backups sitting next to the profile, newest first. */
  function listBackups() {
    const layout = readLayout()
    const base = layout.daemonProfile ? `${hindsightHome}/profiles/${layout.daemonProfile}.env` : null
    if (!base || typeof deps.glob !== 'function') return []
    return deps.glob(`${base}.bak-*`).sort().reverse().slice(0, 10)
  }

  /**
   * Save the requested changes with a timestamped backup and an atomic write.
   * Returns the backup path so the panel can show it.
   */
  function save(changes, { resolvedKey } = {}) {
    // "Use the DSH key" IS a change: fold it in before validating, so a request
    // that asks for nothing except the key is not rejected as empty.
    const effective = { ...(changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {}) }
    if (resolvedKey !== undefined && resolvedKey !== null) {
      effective.HINDSIGHT_API_LLM_API_KEY = resolvedKey
    }

    const validation = validateChanges(effective)
    if (!validation.ok) return { ok: false, code: 'invalid-changes', errors: validation.errors }

    const layout = readLayout()
    const envPath = envPathOf(layout.daemonProfile)
    if (!envPath) return { ok: false, code: 'no-profile', errors: ['daemonProfile unknown'] }
    const before = deps.readText(envPath)
    if (before === null || before === undefined) {
      return { ok: false, code: 'profile-missing', errors: [envPath] }
    }

    const next = applyEnvChanges(before, effective)

    const stamp = deps.timestamp()
    const backupPath = `${envPath}.bak-${stamp}`
    const tmpPath = `${envPath}.tmp-${stamp}`
    try {
      deps.writeText(backupPath, before)
    } catch (error) {
      return { ok: false, code: 'backup-failed', errors: [String((error && error.message) || error)] }
    }
    try {
      deps.writeText(tmpPath, next)
      deps.rename(tmpPath, envPath)
    } catch (error) {
      // Roll back to the backup so a half-written file is never left behind.
      try {
        deps.writeText(envPath, before)
        deps.removeFile(tmpPath)
      } catch { /* best effort: the backup on disk is still authoritative */ }
      return { ok: false, code: 'write-failed', errors: [String((error && error.message) || error)], backupPath }
    }
    return { ok: true, backupPath, changed: Object.keys(effective) }
  }

  /**
   * Answer "which values are in effect right now" without writing anything.
   * A restart that did not happen must not be reported as success.
   */
  async function verify() {
    const layout = readLayout()
    const profile = readProfileLayer(layout)
    const runtime = readRuntimeLayer(layout)
    const probe = await readDaemonProbe(layout.apiPort)
    const envMtime = profile.path ? deps.mtimeOf(profile.path) : null
    const profileMap = profile.parsed ? profile.parsed.byKey : new Map()

    if (!probe.known) {
      return {
        ok: true,
        applied: false,
        reason: 'daemon-not-running',
        basis: 'timing',
        runtimeKnown: false,
        mismatched: [],
        file: tripleOfFile(profileMap),
        runtime: null,
        requests: null,
      }
    }

    const applied = judgeApplied({ profileMap, startup: runtime.startup, startTime: probe.startTime, envMtime })
    const requestRows = applied.applied ? await readRecentRequests(layout.apiPort) : null

    return {
      ok: true,
      applied: applied.applied,
      reason: applied.reason,
      basis: applied.basis,
      runtimeKnown: applied.runtimeKnown,
      file: applied.file,
      runtime: applied.runtime
        ? { ...applied.runtime, connected: runtime.startup ? runtime.startup.connected : null }
        : null,
      mismatched: applied.mismatched,
      startTime: applied.startTime,
      envMtime: applied.envMtime,
      rewrittenAfterStart: applied.rewrittenAfterStart,
      requests: requestRows,
    }
  }

  /** Last few real LLM calls, as independent confirmation of the model in use. */
  async function readRecentRequests(apiPort, limit = 5) {
    if (!apiPort || typeof deps.httpGetJson !== 'function') return null
    try {
      const banks = await deps.httpGetJson(`http://127.0.0.1:${apiPort}/v1/default/banks`)
      const list = Array.isArray(banks && banks.banks) ? banks.banks : []
      const bank = list.length > 0 ? (list[0].bank_id || list[0].id || list[0].name) : null
      if (!bank) return null
      const recent = await deps.httpGetJson(`http://127.0.0.1:${apiPort}/v1/default/banks/${encodeURIComponent(bank)}/llm-requests`)
      const rows = Array.isArray(recent && recent.requests) ? recent.requests : (Array.isArray(recent) ? recent : [])
      return rows.slice(0, limit).map((row) => ({
        provider: row.provider ?? null,
        model: row.model ?? null,
        operation: row.operation ?? null,
        status: row.status ?? null,
      }))
    } catch {
      return null
    }
  }

  /**
   * Export the conflicting user-level variables, and only then delete them.
   * A failed export aborts the whole operation — nothing is removed.
   */
  async function cleanEnv({ keys } = {}) {
    const userLevel = await readUserLevelEnv()
    if (!userLevel.known) {
      return { ok: false, code: 'reg-query-failed', errors: ['could not read HKCU\\Environment'] }
    }
    const profile = readProfileLayer(readLayout())
    const profileMap = profile.parsed ? profile.parsed.byKey : new Map()
    const targets = Array.isArray(keys) && keys.length > 0
      ? keys.filter((key) => MANAGED_KEYS.includes(key))
      : computeConflicts({ keys: MANAGED_KEYS, profileMap, userEnv: userLevel.map, processEnv: {} })
        .userLevel.map((c) => c.key)
    if (targets.length === 0) return { ok: true, removed: [], backupPath: null }

    const backupDir = `${hindsightHome}/backups`
    const backupPath = `${backupDir}/hkcuenv-${deps.timestamp()}.json`
    const payload = {
      exportedAt: deps.isoNow(),
      scope: 'HKCU\\Environment',
      keys: Object.fromEntries(targets.map((key) => [key, userLevel.map[key] ?? null])),
    }
    try {
      deps.ensureDir(backupDir)
      deps.writeText(backupPath, JSON.stringify(payload, null, 2))
    } catch (error) {
      return { ok: false, code: 'export-failed', errors: [String((error && error.message) || error)], backupPath: null }
    }

    const removed = []
    const failed = []
    for (const key of targets) {
      const result = await deps.run(['reg', 'delete', 'HKCU\\Environment', '/v', key, '/f'])
      if (result && result.ok) removed.push(key)
      else failed.push(key)
    }
    return { ok: failed.length === 0, removed, failed, backupPath }
  }

  /**
   * Start / stop / restart the daemon.
   *
   * Four rules worth stating, because each one is a deliberate choice:
   *
   *  - the child runs with a SANITIZED environment (see `sanitizedEnv`): without
   *    that, starting the daemon would write the outer values back over the
   *    profile the panel just saved, which is strictly worse than the manual
   *    command it replaces;
   *  - STOP DOES NOT GO THROUGH THE OFFICIAL CLI. It cannot work on this class of
   *    machine: `hindsight-embed daemon stop` finds its PID by decoding
   *    `netstat` output as UTF-8 while Windows emits the console code page, so it
   *    reports "Could not find PID for port 9077" and refuses to signal anything.
   *    Turning UTF-8 mode off does not help either — the CLI then reads its own
   *    UTF-8 profile with the locale codec and crashes. So the stop uses the PID
   *    the panel already trusts, verifies it (see `identifyHindsightProcess`) and
   *    only then terminates it, which keeps upstream's "never signal a process
   *    you cannot identify" property;
   *  - stopping something already stopped is idempotent SUCCESS, because
   *    "stop then start" has to be usable at any time;
   *  - one action at a time. Two concurrent restarts would race on the port and
   *    leave the user unable to tell what is running.
   */
  let daemonInFlight = false

  async function runDaemonStep(action, layout) {
    const args = daemonArgs({
      embedPackagePath: layout.embedPackagePath,
      daemonProfile: layout.daemonProfile,
      action,
    })
    if (!args) return { action, ok: false, code: 'no-command', exitCode: null, output: '' }
    const started = Date.now()
    const result = await deps.spawn('uv', args, {
      env: sanitizedEnv(deps.env, MANAGED_KEYS),
      timeoutMs: ACTION_TIMEOUT_MS[action] || ACTION_TIMEOUT_MS.start,
      cwd: layout.embedPackagePath,
    })
    return {
      action,
      ok: result.ok === true,
      exitCode: result.code === undefined ? null : result.code,
      timedOut: result.timedOut === true,
      ms: Date.now() - started,
      output: tailForDisplay(`${result.stdout || ''}\n${result.stderr || ''}`),
    }
  }

  /**
   * Terminate the daemon, but only after proving the listener is really ours.
   * See the block comment on `daemonAction` for why this does not shell out to
   * the official stop.
   */
  async function stopDaemon(probe, apiPort) {
    const identity = identifyHindsightProcess({ name: probe.name, commandLine: probe.commandLine, port: apiPort })
    if (!identity.ok) {
      return {
        action: 'stop',
        ok: false,
        code: 'not-identified',
        exitCode: null,
        output: `${identity.reason}（拒绝向无法确认的进程发信号）`,
      }
    }
    const started = Date.now()
    const result = await deps.run([
      'powershell', '-NoProfile', '-NonInteractive', '-Command',
      `Stop-Process -Id ${probe.pid} -Force -ErrorAction Stop`,
    ])
    return {
      action: 'stop',
      ok: Boolean(result && result.ok),
      exitCode: result && result.ok ? 0 : 1,
      ms: Date.now() - started,
      output: tailForDisplay(`${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`),
    }
  }

  /** Between a restart's stop and start, the old process must actually let go. */
  async function waitForPortFree(apiPort) {
    if (!apiPort) return true
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < PORT_FREE_WAIT.attempts; attempt += 1) {
      const probe = await readDaemonProbe(apiPort)
      if (!probe.known) return true
      await sleep(PORT_FREE_WAIT.intervalMs)
    }
    return false
  }

  // --- launcher self-heal + on-demand auto start -----------------------------

  /**
   * Auto-start bookkeeping. Nothing here is persisted except the switch itself
   * (a settings key): everything else is "what happened since this host
   * started", which is exactly what the panel is asked to show.
   */
  const autoState = {
    enabled: null, // resolved from deps.readAutoStart() on first use
    triggers: 0,
    lastTriggerAt: null,
    failures: 0,
    backoffUntil: 0,
    lastResult: null,
    notice: null,
    startedBy: null, // { pid, reason, at } — the ONLY thing that makes a pid "ours"
    heal: null, // latest heal decision
    healed: null, // last time the launcher was actually replaced
    hostEvents: 'unknown', // 'subscription-ok' | 'missing'
    pending: null, // in-flight background start
  }

  function autoEnabled() {
    if (autoState.enabled === null) {
      const read = typeof deps.readAutoStart === 'function' ? deps.readAutoStart() : undefined
      // Unknown (settings service absent) means "enabled": that is the
      // documented default, and a silent disable would be the worse surprise.
      autoState.enabled = read === undefined ? true : read !== false
    }
    return autoState.enabled === true
  }

  /** Persist the switch through the settings namespace, or say why we cannot. */
  async function setAutoStart(enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, code: 'invalid-value', errors: ['enabled must be a boolean'] }
    if (typeof deps.writeAutoStart !== 'function') {
      return { ok: false, code: 'settings-unavailable', errors: ['this host cannot write plugin settings'] }
    }
    const result = await deps.writeAutoStart(enabled)
    if (!result || result.ok !== true) {
      return { ok: false, code: 'settings-write-failed', errors: [(result && result.error) || 'settings write failed'] }
    }
    autoState.enabled = enabled
    return { ok: true, code: 'saved', enabled, state: await collectState() }
  }

  /** The image form of the running daemon — read from the image, name as fallback. */
  function daemonOriginOf(probe) {
    let imageForm = 'unknown'
    if (probe && probe.known && probe.exePath && typeof deps.readBinary === 'function') {
      try {
        imageForm = launcherFormOf(peSubsystemOf(deps.readBinary(probe.exePath)))
      } catch { imageForm = 'unknown' }
    }
    return classifyDaemonOrigin({
      known: Boolean(probe && probe.known),
      pid: probe ? probe.pid : null,
      imageName: probe ? probe.name : null,
      imageForm,
      startedBy: autoState.startedBy,
    })
  }

  /**
   * Make sure the daemon's launcher cannot allocate a console, before starting.
   *
   * The daemon is started through `<venv>\Scripts\pythonw.exe`. In a uv-created
   * venv that file is a CONSOLE-subsystem launcher and upstream only checks that
   * it exists — so Windows hands the daemon a fresh console. Swapping in the
   * same release's console-free venv launcher is the whole fix; the original is
   * backed up OUTSIDE `.venv` so a rebuilt venv cannot take the backup with it.
   * The swap is staged and renamed, so a failure can never leave a half-written
   * launcher behind.
   */
  async function healLauncher(layout) {
    const embed = layout && layout.embedPackagePath
    const cannotRead = typeof deps.readBinary !== 'function' || !embed
    if (cannotRead) {
      return { action: 'heal', ok: true, code: 'skipped', reason: 'cannot-read-binaries', form: 'unknown', occurred: false, blocked: false }
    }
    const venv = `${embed}\\.venv`
    const launcher = `${venv}\\Scripts\\pythonw.exe`
    let form = 'unknown'
    try { form = launcherFormOf(peSubsystemOf(deps.readBinary(launcher))) } catch { form = 'unknown' }

    const source = guiLauncherSourceOf(parsePyvenvHome(deps.readText(`${venv}\\pyvenv.cfg`)))
    let sourceForm = 'unknown'
    if (source) {
      try { sourceForm = launcherFormOf(peSubsystemOf(deps.readBinary(source))) } catch { sourceForm = 'unknown' }
    }
    const plan = planLauncherHeal({ form, guiSourceAvailable: sourceForm === 'gui' })
    if (plan.action !== 'replace') {
      return {
        action: 'heal',
        ok: !plan.blocked,
        code: plan.blocked ? 'blocked' : 'not-needed',
        reason: plan.reason,
        form,
        occurred: false,
        blocked: Boolean(plan.blocked),
      }
    }

    const stamp = deps.timestamp()
    const backupPath = `${embed}\\pythonw.exe.uv-orig-${stamp}`
    const staging = `${venv}\\Scripts\\pythonw.exe.heal-${stamp}`
    try {
      const original = deps.readBinary(launcher)
      const replacement = deps.readBinary(source)
      deps.writeBinary(backupPath, original) // 1. backup outside the venv
      deps.writeBinary(staging, replacement) // 2. stage beside the target
      deps.rename(staging, launcher) // 3. atomic swap
    } catch (error) {
      try { if (typeof deps.removeFile === 'function') deps.removeFile(staging) } catch { /* best effort */ }
      return {
        action: 'heal',
        ok: false,
        code: 'replace-failed',
        reason: String((error && error.message) || error),
        form,
        backupPath,
        occurred: false,
        blocked: true,
        output: 'the launcher was left untouched (staged write + rename)',
      }
    }
    return {
      action: 'heal',
      ok: true,
      code: 'replaced',
      reason: plan.reason,
      form,
      backupPath,
      source,
      occurred: true,
      blocked: false,
      output: `pythonw.exe: console launcher -> console-free launcher (backup: ${backupPath})`,
    }
  }

  /** Clock seam: injectable so the backoff window is testable without waiting. */
  const nowMs = () => (typeof deps.now === 'function' ? deps.now() : Date.now())

  function foldAuto(outcome) {
    const folded = advanceAutoAttempt(autoState, { ...outcome, at: deps.isoNow(), now: nowMs() })
    Object.assign(autoState, folded.state)
    autoState.notice = folded.notice
  }

  /**
   * Everything the panel needs to explain the auto-start policy and its last
   * outcome. `origin` comes from the same probe the four layers use.
   */
  function autoView(origin) {
    const now = nowMs()
    const writable = typeof deps.writeAutoStart === 'function'
    return {
      enabled: autoEnabled(),
      writable,
      reason: writable ? null : 'settings-unavailable',
      triggers: autoState.triggers,
      lastTriggerAt: autoState.lastTriggerAt,
      lastResult: autoState.lastResult,
      failures: autoState.failures,
      retryInMs: autoState.backoffUntil && now < autoState.backoffUntil ? autoState.backoffUntil - now : 0,
      starting: Boolean(autoState.pending),
      notice: autoState.notice,
      heal: autoState.heal,
      healed: autoState.healed,
      hostEvents: autoState.hostEvents,
      origin: origin || null,
    }
  }

  /** The host half reports whether the session hooks could be bound at all. */
  function noteHostEvents(kind) {
    autoState.hostEvents = kind === 'subscription-ok' ? 'subscription-ok' : 'missing'
    return autoState.hostEvents
  }

  /**
   * The on-demand trigger: adopt a healthy daemon, otherwise start one in the
   * background. Returns immediately — `started` is the background promise, and
   * callers that must not block (session hooks) simply ignore it.
   */
  async function ensureDaemon({ reason = 'auto' } = {}) {
    autoState.triggers += 1
    autoState.lastTriggerAt = deps.isoNow()
    if (!autoEnabled()) return { ok: true, code: 'disabled', triggers: autoState.triggers }
    const layout = readLayout()
    if (!layout.ok || !layout.daemonProfile || !layout.embedPackagePath) {
      return { ok: false, code: 'no-command', errors: [layout.reason || 'Hindsight layout is not readable'], triggers: autoState.triggers }
    }

    const before = await readDaemonProbe(layout.apiPort)
    if (before.known) {
      // ADOPT. If the pid is not the one we started, it is not ours any more.
      if (!autoState.startedBy || autoState.startedBy.pid !== before.pid) autoState.startedBy = null
      foldAuto({ ok: true, code: 'adopted' })
      return { ok: true, code: 'adopted', pid: before.pid, triggers: autoState.triggers }
    }

    const now = nowMs()
    if (!autoAttemptDue(autoState, now)) {
      return { ok: true, code: 'backoff', retryInMs: Math.max(0, autoState.backoffUntil - now), triggers: autoState.triggers }
    }
    if (daemonInFlight) return { ok: true, code: 'busy', triggers: autoState.triggers }

    const started = daemonAction('start', { confirm: true, reason })
      .then((result) => {
        const code = (result && result.code) || 'start-failed'
        // `busy` is not a failure: someone else is already starting it.
        foldAuto({ ok: code !== 'busy' && Boolean(result && result.ok), code })
        autoState.pending = null
        return result
      })
      .catch((error) => {
        foldAuto({ ok: false, code: 'start-failed' })
        autoState.pending = null
        return { ok: false, code: 'start-failed', errors: [String((error && error.message) || error)] }
      })
    autoState.pending = started
    return { ok: true, code: 'starting', started, triggers: autoState.triggers }
  }

  /**
   * The one way this plugin starts the daemon: heal the launcher first, then the
   * official CLI with a sanitized environment. The panel's buttons and the
   * on-demand trigger share it, so both get the same guard.
   */
  async function startDaemon(layout, reason, steps, successCode) {
    const heal = await healLauncher(layout)
    autoState.heal = heal
    if (heal.occurred) autoState.healed = { at: deps.isoNow(), backupPath: heal.backupPath, source: heal.source }
    // The receipt only carries a heal step when there is something to report:
    // "checked, nothing to do" belongs in the state, not in the action log.
    if (heal.occurred || heal.blocked) steps.push(heal)
    if (heal.blocked) {
      return {
        ok: false,
        code: 'launcher-blocked',
        steps,
        errors: [`launcher not usable for a window-free start: ${heal.reason}`],
        state: await collectState(),
      }
    }
    const started = await runDaemonStep('start', layout)
    steps.push(started)
    if (started.ok) {
      const after = await readDaemonProbe(layout.apiPort)
      autoState.startedBy = after.known ? { pid: after.pid, reason, at: deps.isoNow() } : null
    }
    return {
      ok: started.ok,
      code: started.ok ? successCode : 'start-failed',
      steps,
      state: await collectState(),
    }
  }

  async function daemonAction(action, { confirm, reason = 'manual' } = {}) {
    if (!DAEMON_ACTIONS.includes(action)) {
      return { ok: false, code: 'bad-action', errors: [`unknown action: ${action}`] }
    }
    if (action !== 'start' && confirm !== true) {
      return { ok: false, code: 'confirm-required', errors: ['stopping or restarting needs confirmation'] }
    }
    if (typeof deps.spawn !== 'function') {
      return { ok: false, code: 'no-spawn', errors: ['this host cannot spawn processes'] }
    }
    const layout = readLayout()
    if (!layout.ok || !layout.daemonProfile || !layout.embedPackagePath) {
      return { ok: false, code: 'no-command', errors: [layout.reason || 'Hindsight layout is not readable'] }
    }
    if (daemonInFlight) {
      return { ok: false, code: 'busy', errors: ['another daemon action is already running'] }
    }

    daemonInFlight = true
    try {
      const before = await readDaemonProbe(layout.apiPort)
      const steps = []

      if (action === 'stop' && !before.known) {
        return { ok: true, code: 'already-stopped', steps, state: await collectState() }
      }
      if (action === 'restart' && !before.known) {
        return await startDaemon(layout, reason, steps, 'started')
      }

      if (action === 'start') {
        return await startDaemon(layout, reason, steps, 'started')
      }

      const stopped = await stopDaemon(before, layout.apiPort)
      steps.push(stopped)
      if (!stopped.ok) {
        return { ok: false, code: stopped.code || 'stop-failed', steps, state: await collectState() }
      }
      autoState.startedBy = null
      if (action === 'stop') {
        return { ok: true, code: 'stopped', steps, state: await collectState() }
      }

      const freed = await waitForPortFree(layout.apiPort)
      if (!freed) {
        return { ok: false, code: 'port-busy', steps, state: await collectState() }
      }
      return await startDaemon(layout, reason, steps, 'restarted')
    } finally {
      daemonInFlight = false
    }
  }

  /** The command the panel displays, per action, straight from the same builder. */
  /**
   * The commands the buttons actually run, for copying and auditing.
   *
   * The two halves differ on purpose: the start really is the official CLI, but
   * the stop is a port-scoped `Stop-Process` because the CLI's own stop cannot
   * find its PID here. The panel states the identity check next to it.
   */
  function daemonCommands() {
    const layout = readLayout()
    const start = daemonCommandLine(daemonArgs({
      embedPackagePath: layout.embedPackagePath,
      daemonProfile: layout.daemonProfile,
      action: 'start',
    }))
    const port = layout.apiPort
    const stop = port
      ? `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`
      : null
    return { start, stop }
  }

  return {
    readLayout,
    readProfileLayer,
    readRuntimeLayer,
    readUserLevelEnv,
    readProcessEnv,
    readDaemonProbe,
    collectState,
    save,
    verify,
    cleanEnv,
    listBackups,
    daemonAction,
    daemonCommands,
    ensureDaemon,
    setAutoStart,
    noteHostEvents,
    healLauncher,
    autoView,
  }
}

/** Test seam: the harness drives everything through this. */
export const _module = {
  parseEnv,
  applyEnvChanges,
  parseStartupLog,
  displayValue,
  computeConflicts,
  isEffectivelyApplied,
  judgeApplied,
  tripleOfFile,
  TRIPLE_KEYS,
  fieldState,
  defaultValueOf,
  buildRestartCommand,
  parseRegQuery,
  parseDaemonProbe,
  identifyHindsightProcess,
  validateChanges,
  isSecretKey,
  createCore,
  DAEMON_ACTIONS,
  ACTION_TIMEOUT_MS,
  PORT_FREE_WAIT,
  sanitizedEnv,
  daemonArgs,
  daemonCommandLine,
  tailForDisplay,
}
