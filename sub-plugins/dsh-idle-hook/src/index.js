// dsh-idle-hook: HOST half — the part that runs whether or not a page is open.
//
// Responsibilities:
//   · trigger 1 — a turn really ended (session/event 'turn/end', one per turn,
//     carrying the reason). agent/status 'idle' alone cannot tell "waiting for
//     the user" from between-turn maintenance, and it also fires when the
//     driver runs straight into the next queued turn, so turn/end is the signal
//     and the live state is re-checked before anything runs.
//   · trigger 2/3 — a human is being asked (the approval/request and
//     user-questions/request waterfalls). These are OBSERVED ONLY: registered
//     with { prepend: true } (the remotes forwarder claims the chain first for a
//     connected client) and the script is fired without awaiting, while next()'s
//     result is returned unchanged — otherwise the approval chain would end up
//     fail-closed 'unavailable'.
//   · run the rule's script (node:child_process.spawn, argv array, no shell by
//     default) with the context on stdin as UTF-8 JSON plus ASCII-safe env
//     mirrors, a kill timeout, one instance per rule at a time, debounce, and
//     consecutive-failure auto-disable.
//   · /__idle-hook/* HTTP surface for the client half (status, presence
//     heartbeat, history, test-run, reset-rule).
//
// Hard rule: NO @deepseek-ai/* import here (link: bundles cannot resolve host
// packages from this repo — docs/knowledge/2026-09-09-plugin-host-half-no-core-import.md).
// Every service is reached lazily through ctx and degrades silently when absent.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as core from './host-core.js'

const name = 'dsh-idle-hook'
/** No hard host dependencies: every service is reached lazily. */
const inject = []

/** This plugin's own directory (the link: target), for the sample-rule path. */
export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
export const HTTP_PREFIX = core.HTTP_PREFIX
/** A finished turn is re-checked at these delays before it counts as stopped. */
const TURN_END_CHECKS = [250, 1000, 2500]
/** Capture cap per stream before tailing. */
const CAPTURE_CAP = 200000

const STATE = {
  ctx: null,
  readConfig: null,
  settingsInstalled: false,
  settingsReady: false,
  /** Owner context of the current registration (a reload brings a new one). */
  settingsOwner: null,
  settingsError: null,
  presence: null,
  lastFireAt: new Map(),
  inflight: new Map(),
  pendingTurnEnd: new Map(),
  runtime: {},
  history: [],
  stateFile: null,
  lastError: null,
  /** Cheap counters so "it never fired" can be located without guessing. */
  diag: { sessionEvents: 0, turnEndEligible: 0, turnEndConfirmed: 0, dispatched: 0, lastDispatch: null, lastSkip: null },
}

function msg(e) { return (e && e.message) || String(e) }

function serviceOf(key) {
  const ctx = STATE.ctx
  if (!ctx || typeof ctx.get !== 'function') return null
  try { return ctx.get(key) || null } catch { return null }
}

// --- host-owned state file (history + per-rule runtime counters) -------------

function loadState() {
  const file = core.historyPathOf(core.dshHome())
  STATE.stateFile = file
  let raw = null
  try { raw = fs.readFileSync(file, 'utf8') } catch { raw = null }
  if (!raw) return
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const next = core.normalizeState(parsed)
  STATE.runtime = next.runtime
  STATE.history = next.entries
}

function persistState() {
  const file = STATE.stateFile || core.historyPathOf(core.dshHome())
  STATE.stateFile = file
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      runtime: STATE.runtime,
      entries: STATE.history.slice(0, core.HISTORY_LIMIT),
    }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    STATE.lastError = 'state-write: ' + msg(e)
  }
}

function currentConfig() {
  ensureSettings()
  if (!STATE.readConfig) return core.defaultConfig()
  try { return core.normalizeConfig(STATE.readConfig()) } catch (e) {
    STATE.lastError = 'config-read: ' + msg(e)
    return core.defaultConfig()
  }
}

function runtimeOf(ruleId) {
  const r = STATE.runtime[ruleId]
  return core.isPlainObject(r) ? r : {}
}

// --- session facts -----------------------------------------------------------

function resolveSession(sessionId) {
  const id = sessionId || null
  let agent = null
  const agents = serviceOf('agents')
  if (agents && typeof agents.get === 'function' && id) {
    try { agent = agents.get(id) || null } catch { agent = null }
  }
  const session = agent && agent.session ? agent.session : null
  const header = session && session.header ? session.header : null
  const cwd = header && typeof header.cwd === 'string' ? header.cwd : null
  return { id: (session && session.id) || id, cwd, title: titleOf(session), agent }
}

function titleOf(session) {
  if (!session) return null
  const titles = serviceOf('sessionTitle')
  if (!titles || typeof titles.get !== 'function') return null
  try {
    const snap = titles.get(session)
    if (snap && typeof snap.title === 'string' && snap.title) return snap.title
  } catch { /* no projection yet */ }
  return null
}

/** The most recently registered live agent, for the test-run button. */
function pickLiveSession() {
  const agents = serviceOf('agents')
  if (!agents || typeof agents.list !== 'function') return null
  let list = []
  try { list = agents.list() || [] } catch { list = [] }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const agent = list[i]
    if (!agent) continue
    const session = agent.session
    const header = session && session.header ? session.header : null
    return {
      id: (session && session.id) || agent.id || null,
      cwd: header && typeof header.cwd === 'string' ? header.cwd : null,
      title: titleOf(session),
    }
  }
  return null
}

/** turn/end also fires when the driver runs straight into the next turn. */
function agentIsStopped(sessionId) {
  if (!sessionId) return true
  const agents = serviceOf('agents')
  if (!agents || typeof agents.get !== 'function') return true
  let agent = null
  try { agent = agents.get(sessionId) || null } catch { agent = null }
  if (!agent) return true
  if (agent.status !== 'idle') return false
  const inbox = agent.inbox
  if (inbox) {
    if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return false
    if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return false
  }
  return true
}

/** Subagent activity is not "DSH stopped" — its parent turn is still running. */
function isRootSession(sessionId) {
  if (!sessionId) return true
  const agents = serviceOf('agents')
  if (!agents || typeof agents.get !== 'function' || typeof agents.roots !== 'function') return true
  let agent = null
  try { agent = agents.get(sessionId) || null } catch { agent = null }
  if (!agent) return true
  try { return agents.roots().some((a) => a && a.id === sessionId) } catch { return true }
}

// --- execution ---------------------------------------------------------------

function spawnOnce(plan, o) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child = null
    try {
      child = spawn(plan.command, plan.args, {
        cwd: o.cwd,
        env: o.env,
        shell: plan.shell === true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ status: 'error', error: 'spawn 失败：' + msg(e), durationMs: Date.now() - startedAt })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, o.timeoutMs)
    const done = (patch) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Object.assign({
        durationMs: Date.now() - startedAt,
        stdout: core.tailText(stdout),
        stderr: core.tailText(stderr),
      }, patch))
    }
    child.on('error', (e) => done({ status: 'error', error: 'spawn 失败：' + msg(e) }))
    if (child.stdout) child.stdout.on('data', (d) => {
      stdout += String(d)
      if (stdout.length > CAPTURE_CAP) stdout = stdout.slice(-CAPTURE_CAP)
    })
    if (child.stderr) child.stderr.on('data', (d) => {
      stderr += String(d)
      if (stderr.length > CAPTURE_CAP) stderr = stderr.slice(-CAPTURE_CAP)
    })
    child.on('close', (code, signal) => done({
      status: timedOut ? 'timeout' : (code === 0 ? 'ok' : 'failed'),
      exitCode: typeof code === 'number' ? code : null,
      signal: signal || null,
    }))
    try {
      if (child.stdin) {
        child.stdin.on('error', () => { /* script ignored stdin */ })
        child.stdin.end(o.stdin)
      }
    } catch { /* stdin already closed */ }
  })
}

function finish(rule, opts, result) {
  const entry = core.makeHistoryEntry({
    ruleId: rule.id,
    ruleName: rule.name,
    trigger: opts.trigger,
    detail: opts.detail || null,
    sessionId: opts.sessionId || null,
    sessionTitle: opts.sessionTitle == null ? null : opts.sessionTitle,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    note: result.note || null,
    stdout: result.stdout,
    stderr: result.stderr,
    test: opts.test === true,
  })
  STATE.history = core.pushHistory(STATE.history, entry)
  if (opts.test !== true) {
    const prev = runtimeOf(rule.id)
    const counted = core.isFailureStatus(entry.status) ? core.registerFailure(prev) : core.registerSuccess(prev)
    STATE.runtime[rule.id] = Object.assign({}, counted, {
      lastRunAt: entry.startedAt,
      lastStatus: entry.status,
      lastExitCode: entry.exitCode,
      lastDurationMs: entry.durationMs,
    })
  }
  persistState()
  return entry
}

function recordSkipped(rule, opts) {
  return finish(rule, opts, {
    status: 'skipped',
    startedAt: Date.now(),
    durationMs: 0,
    error: '上一次同规则执行还在进行中，本次跳过',
  })
}

async function runRule(rule, opts = {}) {
  const startedAt = Date.now()
  const built = core.buildTriggerContext({
    rule,
    sessionId: opts.sessionId,
    sessionTitle: opts.sessionTitle,
    cwd: opts.cwd,
    trigger: opts.trigger,
    detail: opts.detail,
    now: startedAt,
  })
  const values = core.placeholderValues(built.payload, rule)
  const plan = core.buildCommand(rule, values, { home: os.homedir() })
  if (!plan.ok) return finish(rule, opts, { status: 'error', error: plan.error, startedAt, durationMs: 0 })
  const cwd = rule.cwd ? core.expandTilde(rule.cwd, os.homedir()) : (opts.cwd || process.cwd())
  // inherited env → global env → this rule's env → the IDLE_HOOK_* trigger contract
  const env = core.mergeEnv(
    process.env,
    opts.globalEnv,
    core.applyEnvPlaceholders(rule.env, values),
    built.env,
  )
  // keys only (never values) go into the history so secrets stay out of it
  const envKeys = Array.from(new Set(
    Object.keys(core.normalizeEnv(opts.globalEnv)).concat(Object.keys(core.normalizeEnv(rule.env))),
  )).sort()
  STATE.lastError = null
  const result = await spawnOnce(plan, { cwd, env, stdin: JSON.stringify(built.payload, null, 2), timeoutMs: rule.timeoutMs })
  result.startedAt = startedAt
  result.envKeys = envKeys
  // 「命令字段里混了解释器」这类被自动纠正的情况要跟着结果走，界面/历史才看得到
  result.note = plan.note || null
  return finish(rule, opts, result)
}

function dispatchTrigger(trigger, info = {}) {
  const cfg = currentConfig()
  STATE.diag.dispatched += 1
  STATE.diag.lastDispatch = { at: Date.now(), trigger, sessionId: info.sessionId || null, rules: cfg.rules.length, enabled: cfg.enabled }
  if (!cfg.enabled) { STATE.diag.lastSkip = '主开关关闭'; return }
  const sessionId = info.sessionId || null
  if (!isRootSession(sessionId)) return
  const presence = core.presenceOf(STATE.presence)
  const session = resolveSession(sessionId)
  const now = Date.now()
  for (const rule of cfg.rules) {
    try {
      if (!rule.enabled) { STATE.diag.lastSkip = rule.name + '：未启用'; continue }
      if (runtimeOf(rule.id).autoDisabled === true) { STATE.diag.lastSkip = rule.name + '：已因连续失败自动停用'; continue }
      if (!core.ruleListensTo(rule, trigger, info.reason)) {
        STATE.diag.lastSkip = rule.name + '：触发条件不匹配（trigger=' + trigger + ' / reason=' + (info.reason ? core.turnEndKind(info.reason) : '(未传)') + '）'
        continue
      }
      if (!core.allowsByPrecondition(rule.precondition, presence)) { STATE.diag.lastSkip = rule.name + '：触发前提不满足（当前 ' + presence.state + '）'; continue }
      const key = rule.id + '::' + (sessionId || '-')
      if (core.isDebounced(STATE.lastFireAt.get(key), now, rule.debounceMs)) { STATE.diag.lastSkip = rule.name + '：去抖窗口内'; continue }
      const opts = {
        trigger,
        detail: info.detail || null,
        sessionId: session.id || sessionId,
        sessionTitle: session.title,
        cwd: session.cwd,
        globalEnv: cfg.env,
        test: false,
      }
      if (STATE.inflight.get(rule.id)) { recordSkipped(rule, opts); continue }
      STATE.lastFireAt.set(key, now)
      STATE.inflight.set(rule.id, true)
      void runRule(rule, opts)
        .catch((e) => { STATE.lastError = 'run: ' + msg(e) })
        .then(() => { STATE.inflight.delete(rule.id) })
    } catch (e) {
      STATE.lastError = 'dispatch: ' + msg(e)
    }
  }
}

// --- trigger wiring ----------------------------------------------------------

function onTurnEnd(session, event) {
  // 载荷在 event.data 里（信封是 {type,seq,time,data}），不是挂在事件本身
  const reason = core.turnEndReasonOf(event)
  STATE.diag.lastReason = core.turnEndKind(reason) || null
  if (!core.shouldFireOnTurnEnd(reason)) return
  const sessionId = (session && session.id) || null
  if (!isRootSession(sessionId)) return
  STATE.diag.turnEndEligible += 1
  const detail = core.turnEndKind(reason)
  const key = sessionId || '-'
  const prior = STATE.pendingTurnEnd.get(key)
  if (prior && prior.timer) clearTimeout(prior.timer)
  const pending = { detail, index: 0, timer: null }
  const step = () => {
    const current = STATE.pendingTurnEnd.get(key)
    if (!current || current !== pending) return
    if (agentIsStopped(sessionId)) {
      STATE.pendingTurnEnd.delete(key)
      STATE.diag.turnEndConfirmed += 1
      // reason 必须跟着走：规则级「触发条件」过滤要用它（漏传过一次，导致每条规则都被跳过）
      dispatchTrigger(core.TRIGGER.turnEnd, { sessionId, reason, detail })
      return
    }
    pending.index += 1
    if (pending.index >= TURN_END_CHECKS.length) { STATE.pendingTurnEnd.delete(key); return }
    pending.timer = setTimeout(step, TURN_END_CHECKS[pending.index] - TURN_END_CHECKS[pending.index - 1])
  }
  pending.timer = setTimeout(step, TURN_END_CHECKS[0])
  STATE.pendingTurnEnd.set(key, pending)
}

function installTriggers(ctx) {
  try {
    ctx.on('session/event', (session, event) => {
      try {
        STATE.diag.sessionEvents += 1
        if (event && event.type === 'turn/end') onTurnEnd(session, event)
      } catch (e) { STATE.lastError = 'session/event: ' + msg(e) }
    })
  } catch (e) { STATE.lastError = 'session/event: ' + msg(e) }

  // Observe-only waterfalls. prepend: the host's remotes forwarder claims the
  // chain for a connected client. next()'s result is returned unchanged and the
  // script is never awaited, so the chain can never be delayed or truncated.
  const observe = (trigger) => function observeRequest(request, next) {
    try {
      const agent = request && request.agent
      const sessionId = (agent && agent.id) || (request && request.sessionId) || null
      const detail = (request && request.toolName) || null
      dispatchTrigger(trigger, { sessionId, detail })
    } catch (e) {
      STATE.lastError = trigger + ': ' + msg(e)
    }
    return next()
  }
  try { ctx.on('approval/request', observe(core.TRIGGER.approval), { prepend: true }) } catch (e) {
    STATE.lastError = 'approval/request: ' + msg(e)
  }
  try { ctx.on('user-questions/request', observe(core.TRIGGER.question), { prepend: true }) } catch (e) {
    STATE.lastError = 'user-questions/request: ' + msg(e)
  }
}

// --- settings namespace ------------------------------------------------------

/** Permissive zero-dependency schema: always registers, never blocks a write. */
function fallbackSectionSchema() {
  const schema = (input) => {
    const src = core.isPlainObject(input) ? input : {}
    const out = Object.assign({}, src)
    out.enabled = typeof src.enabled === 'boolean' ? src.enabled : true
    out.seeded = typeof src.seeded === 'boolean' ? src.seeded : false
    out.env = core.isPlainObject(src.env) ? src.env : {}
    out.rules = Array.isArray(src.rules) ? src.rules : []
    return out
  }
  schema.toJSON = () => ({
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true },
      seeded: { type: 'boolean', default: false },
      env: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
      rules: { type: 'array', items: { type: 'object' }, default: [] },
    },
  })
  return schema
}

function ruleSchema(z) {
  const triggers = () => z.object({
    turnEnd: z.boolean().default(true),
    approval: z.boolean().default(true),
    question: z.boolean().default(true),
  })
  return z.object({
    enabled: z.boolean().default(true),
    seeded: z.boolean().default(false),
    env: z.dict(z.string()).default({}),
    rules: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      enabled: z.boolean().default(false),
      command: z.string(),
      args: z.array(z.string()).default([]),
      interpreter: z.string(),
      cwd: z.string(),
      triggers: triggers(),
      precondition: z.string(),
      debounceMs: z.number(),
      timeoutMs: z.number(),
      shell: z.boolean().default(false),
      env: z.dict(z.string()).default({}),
    })).default([]),
  })
}

/**
 * Install the settings section once a provider is available.
 *
 * The provider can mount AFTER this plugin loads (the profile patch row order
 * decides), so a single ctx.get() is not enough — the repo convention for
 * optional services is: try ctx.get(name), then ctx.inject([name], cb) for the
 * late mount. Skipping the second half leaves the namespace unregistered, and
 * the settings UI then fails with "namespace is not registered".
 */
function installSettingsWith(owner, settings) {
  if (STATE.settingsInstalled) return
  if (!settings || typeof settings.installSection !== 'function') {
    STATE.settingsError = '设置服务不可用：规则无法读取，插件保持静默'
    return
  }
  STATE.settingsInstalled = true
  const register = (Schema) => {
    if (STATE.settingsReady) return
    try {
      settings.installSection(owner, core.SETTINGS_NS, Schema, core.defaultConfig(), {
        setSource(source) {
          try { STATE.readConfig = typeof source === 'function' ? source : null } catch { STATE.readConfig = null }
        },
        onChange() { /* the source getter already reflects the new value */ },
      })
      STATE.settingsReady = true
      STATE.settingsError = null
    } catch (e) {
      STATE.settingsError = 'installSection 失败：' + msg(e)
    }
  }
  const fallback = () => register(fallbackSectionSchema())
  try {
    Promise.resolve()
      .then(() => import('@deepseek-ai/schemastery'))
      .then((mod) => {
        const z = mod && (mod.default || mod)
        let schema = null
        try { schema = z && typeof z.object === 'function' ? ruleSchema(z) : null } catch { schema = null }
        register(schema || fallbackSectionSchema())
      })
      .catch(() => fallback())
  } catch {
    fallback()
  }
}

function installSettings(ctx) {
  const now = serviceOf('settings')
  if (now) {
    installSettingsWith(ctx, now)
    return
  }
  // Late mount: the provider may appear after this row has loaded.
  try {
    ctx.inject(['settings'], (sub) => installSettingsWith(ctx, sub && sub.settings ? sub.settings : sub))
  } catch (e) {
    STATE.settingsError = '设置服务不可用：规则无法读取，插件保持静默（' + msg(e) + '）'
    return
  }
  STATE.settingsError = '设置服务不可用：等待设置服务挂载'
}

/** Retry hook for callers that arrive later (status probe, trigger dispatch). */
function ensureSettings() {
  if (STATE.settingsInstalled) return
  const now = serviceOf('settings')
  if (now) installSettingsWith(STATE.ctx, now)
}

// --- HTTP surface ------------------------------------------------------------

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
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (d) => {
      data += String(d)
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      if (!data) { resolve({}); return }
      try { resolve(JSON.parse(data)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function statusPayload() {
  ensureSettings()
  const cfg = currentConfig()
  return {
    plugin: core.PLUGIN_ID,
    pluginDir: PLUGIN_DIR,
    platform: process.platform,
    settings: { ready: STATE.settingsReady, error: STATE.settingsError, namespace: core.SETTINGS_NS },
    config: { enabled: cfg.enabled, seeded: cfg.seeded, env: cfg.env, rules: cfg.rules, count: cfg.rules.length },
    sampleRule: core.sampleRule(PLUGIN_DIR, process.platform),
    presence: core.presenceOf(STATE.presence),
    presenceIntervalMs: core.PRESENCE_INTERVAL_MS,
    runtime: STATE.runtime,
    history: { count: STATE.history.length, limit: core.HISTORY_LIMIT, file: STATE.stateFile },
    defaults: {
      debounceMs: core.DEFAULT_DEBOUNCE_MS,
      timeoutMs: core.DEFAULT_TIMEOUT_MS,
      failureLimit: core.FAILURE_LIMIT,
    },
    lastError: STATE.lastError,
    // 快照而不是把内部对象交出去：调用方改到它就会改到插件状态
    diag: Object.assign({}, STATE.diag, { lastDispatch: STATE.diag.lastDispatch ? Object.assign({}, STATE.diag.lastDispatch) : null }),
  }
}

function registerHttp(ctx, host) {
  if (!host || typeof host.register !== 'function') return
  const handler = async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase()
      const url = (req.url || '').split('?')[0]
      if (url === HTTP_PREFIX + '/status' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: statusPayload() })
        return
      }
      if (url === HTTP_PREFIX + '/presence' && method === 'POST') {
        const body = await readBody(req)
        STATE.presence = {
          at: Date.now(),
          visible: body && body.visible === true,
          focused: body && body.focused === true,
        }
        sendJson(res, 200, { ok: true, data: core.presenceOf(STATE.presence) })
        return
      }
      if (url === HTTP_PREFIX + '/history' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          data: { entries: STATE.history.slice(0, core.HISTORY_LIMIT), runtime: STATE.runtime, limit: core.HISTORY_LIMIT, file: STATE.stateFile },
        })
        return
      }
      if (url === HTTP_PREFIX + '/clear-history' && method === 'POST') {
        STATE.history = []
        persistState()
        sendJson(res, 200, { ok: true, data: { entries: [], runtime: STATE.runtime } })
        return
      }
      if (url === HTTP_PREFIX + '/reset-rule' && method === 'POST') {
        const body = await readBody(req)
        const ruleId = body && typeof body.ruleId === 'string' ? body.ruleId : ''
        if (ruleId && STATE.runtime[ruleId]) {
          delete STATE.runtime[ruleId]
          persistState()
        }
        sendJson(res, 200, { ok: true, data: { runtime: STATE.runtime } })
        return
      }
      if (url === HTTP_PREFIX + '/test-run' && method === 'POST') {
        const body = await readBody(req)
        const rule = core.normalizeRule((body && body.rule) || {})
        // the client sends its unsaved global env too, so test-run matches the form
        const globalEnv = core.normalizeEnv(body && body.env)
        const live = pickLiveSession()
        const sample = !live
        const target = live || {
          id: 'sample-session-0000',
          cwd: PLUGIN_DIR,
          title: '示例会话（试跑用，非真实会话）',
        }
        const entry = await runRule(rule, {
          trigger: core.TRIGGER.turnEnd,
          detail: 'completed',
          sessionId: target.id,
          sessionTitle: target.title,
          cwd: target.cwd,
          globalEnv,
          test: true,
        })
        sendJson(res, 200, {
          ok: true,
          data: {
            entry,
            context: { sample, sessionId: target.id, sessionTitle: target.title, cwd: target.cwd },
          },
        })
        return
      }
      sendJson(res, 404, { ok: false, error: '未知端点：' + method + ' ' + url })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: msg(e) })
    }
  }
  ctx.effect(() => host.register({ kind: 'prefix', path: HTTP_PREFIX, handler }))
}

// --- plugin ------------------------------------------------------------------

function apply(ctx) {
  if (STATE.settingsOwner !== ctx) {
    // 插件行被重新加载（禁用→启用 / 重启宿主）时，模块常常是被 ESM 缓存复用的，
    // 模块级状态会活下来 —— 必须按「新的 ctx」重置注册状态，否则新 context 永远
    // 不会去注册设置命名空间（表现：规则读不到、界面报 namespace is not registered）。
    STATE.settingsOwner = ctx
    STATE.settingsInstalled = false
    STATE.settingsReady = false
    STATE.settingsError = null
    STATE.readConfig = null
  }
  STATE.ctx = ctx
  loadState()
  installSettings(ctx)
  installTriggers(ctx)
  const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (ws !== undefined) {
    registerHttp(ctx, ws)
  } else {
    try {
      ctx.inject(['webServer'], (sub) => {
        registerHttp(ctx, sub && sub.webServer ? sub.webServer : sub)
      })
    } catch {
      // terminal-only profile: triggers keep working, the settings UI cannot.
    }
  }
}

export { apply, inject, name, registerHttp, dispatchTrigger, onTurnEnd, spawnOnce, fallbackSectionSchema, statusPayload }
