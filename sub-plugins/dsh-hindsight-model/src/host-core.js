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
  if (typeof stdout !== 'string') return { pid: null, startTime: null }
  const match = /(\d+)\|([0-9T:.Z+-]+)/.exec(stdout)
  if (!match) return { pid: null, startTime: null }
  // PowerShell's `ToString('o')` emits seven fractional-second digits; V8 parses
  // that fine (verified), but the value carries a LOCAL offset, so every
  // comparison against a filesystem mtime must stay instant-based, never
  // string-based.
  const date = new Date(match[2])
  return {
    pid: Number(match[1]),
    startTime: Number.isNaN(date.getTime()) ? null : date,
  }
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
    if (!apiPort) return { known: false, reason: 'port-unknown', pid: null, startTime: null }
    const script = [
      `$c = Get-NetTCPConnection -LocalPort ${apiPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
      'if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;',
      "  if ($p) { Write-Output (\"$($c.OwningProcess)|$($p.StartTime.ToString('o'))\") } }",
    ].join('; ')
    const result = await deps.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
    if (!result || !result.ok) return { known: false, reason: 'probe-failed', pid: null, startTime: null }
    const parsed = parseDaemonProbe(result.stdout)
    if (parsed.pid === null) return { known: false, reason: 'daemon-not-running', pid: null, startTime: null }
    return { known: true, reason: null, pid: parsed.pid, startTime: parsed.startTime }
  }

  /** Collect the whole four-layer picture plus everything the panel renders. */
  async function collectState({ dsh } = {}) {
    const layout = readLayout()
    const profile = readProfileLayer(layout)
    const runtime = readRuntimeLayer(layout)
    const userLevel = await readUserLevelEnv()
    const processEnv = readProcessEnv()
    const probe = await readDaemonProbe(layout.apiPort)
    const envMtime = profile.path ? deps.mtimeOf(profile.path) : null

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
  validateChanges,
  isSecretKey,
  createCore,
}
