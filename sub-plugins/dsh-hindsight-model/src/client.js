// dsh-hindsight-model: CLIENT half — the settings-page panel.
//
// One top-level settings.section (order 17, between 'local-plugins' 16 and
// 'mcp' 18) that answers two questions the user cannot answer today:
//
//   "which model is Hindsight actually running?"  — shown as FOUR layers:
//     ① the authoritative profile .env on disk,
//     ② what the running daemon actually read (its startup block),
//     ③ the outer sources that get written BACK over ① on every daemon start
//        (OS user-level env, and this host process's own env — reported
//        separately, because only the first is cleanable from here),
//     ④ whether the process started after the file was last written.
//
//   "did my change take effect?"  — the Save button writes; the restart command
//     is handed to the user (the plugin never starts or stops the daemon); the
//     Verify button then answers with ④ + the startup block + recent real calls.
//
// SECRETS: the API-key field is write-only. The host sends existence, length and
// source only, and `useDshKey` lets DSH's key be applied WITHOUT its plaintext
// ever reaching the browser.
//
// Bundle format (client-modules protocol): a classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory gets
// `require` and returns { apply, inject }. No JSX.
//
// Verified: 2026-09-13, change 2026-09-13-add-hindsight-model-panel.

window.__ModuleLoader__.load({
  id: 'dsh-hindsight-model',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React

    const SECTION_ID = 'hindsight-model'
    const API = {
      state: '/__hindsight-model/state',
      save: '/__hindsight-model/save',
      dshModel: '/__hindsight-model/dsh-model',
      verify: '/__hindsight-model/verify',
      cleanEnv: '/__hindsight-model/clean-env',
      daemon: '/__hindsight-model/daemon',
      auto: '/__hindsight-model/auto',
    }

    /** Keys rendered as write-only fields. */
    const SECRET_KEYS = ['HINDSIGHT_API_LLM_API_KEY']
    const isSecretKey = (key) => SECRET_KEYS.indexOf(key) !== -1 || /(_API_KEY|_SECRET|_TOKEN)$/.test(String(key))

    const KEY_LABELS = {
      HINDSIGHT_API_LLM_PROVIDER: 'provider',
      HINDSIGHT_API_LLM_MODEL: 'model',
      HINDSIGHT_API_LLM_BASE_URL: 'base_url',
      HINDSIGHT_API_LLM_API_KEY: 'api_key',
      HINDSIGHT_API_RETAIN_LLM_MODEL: 'retain 模型',
      HINDSIGHT_API_REFLECT_LLM_MODEL: 'reflect 模型',
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'embeddings provider',
      HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: 'embeddings 本地模型',
      HINDSIGHT_API_RERANKER_PROVIDER: 'reranker provider',
      HINDSIGHT_API_RERANKER_LOCAL_MODEL: 'reranker 本地模型',
      HINDSIGHT_API_PORT: 'API 端口',
      HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT: 'daemon idle 超时',
      HF_ENDPOINT: 'HF 镜像源',
    }

    const GROUP_LABELS = {
      llm: '推理模型',
      perOp: '分操作覆盖',
      vectors: '向量与重排',
      misc: '杂项',
    }

    const T = {
      title: 'Hindsight 模型',
      subtitle: 'Hindsight 是独立守护进程，改配置必须重启才生效；本面板把「落盘值 / 实际生效值 / 会覆盖它的外层值 / 是否已重启」四层摊开。',
      unavailable: '面板不可用',
      reload: '重新读取',
      layer1: '① 权威落盘（profile .env）',
      layer2: '② 运行中实际生效',
      layer3: '③ 冲突源（会在下次启动时覆盖 ①）',
      layer4: '④ 生效判据（进程启动时间 vs 文件修改时间）',
      userLevel: '用户级环境变量（本插件可清理）',
      processLevel: '宿主进程环境变量（本插件清不掉）',
      processLevelNote: '它来自启动 dsh web 的外层环境，只能由你在那里清理；本插件给出的重启命令会临时清掉它。',
      noConflict: '无冲突',
      applied: '已生效',
      stale: '尚未生效：现在跑的是重启前的配置',
      mismatch: '未生效：文件与进程取值不一致',
      basisValues: '依据：权威文件的三件套与运行中进程读到的一致（这是主判据）',
      basisTiming: '依据：进程启动时间 vs 文件修改时间（取不到进程实际取值时的回退判据）',
      rewritten: '注：文件在进程启动后被重写过（上游启动路径会回写该文件，可能只是把同值写回了一遍）',
      unknownDaemon: '未知：守护进程未在运行',
      unknownEnv: '未知：读不到权威文件',
      startTime: '进程启动',
      envMtime: '文件修改',
      pid: 'PID',
      save: '保存',
      saving: '保存中…',
      verify: '验证',
      verifying: '验证中…',
      readDsh: '从 DSH 读取',
      reading: '读取中…',
      copy: '复制',
      copied: '已复制',
      restartTitle: '重启命令（手动执行时的等价命令，自带环境净化）',
      restartUnavailable: '读不到本机 Hindsight 配置，命令不可用',
      daemonTitle: '守护进程',
      daemonRunning: '运行中',
      daemonStopped: '已停止',
      daemonStart: '启动',
      daemonStop: '停止',
      daemonRestart: '重启',
      daemonConfirmStop: '确认停止',
      daemonConfirmRestart: '确认重启',
      daemonWorking: '执行中…',
      daemonWarn: '停止 / 重启会中断进行中的记忆操作；启动时会自动清除会覆盖 profile 的外层环境变量。',
      daemonDisabled: '本机配置不可读，启停不可用',
      daemonCmdTitle: '面板实际执行的命令',
      daemonEnvNote: '启动 = 官方 CLI，且子进程环境已净化（外层同名变量不会被写回 profile）；停止 = 取监听端口的 PID、校验它确实是 hindsight（命令行含 hindsight_api.main 且端口匹配）后才终止 —— 上游 CLI 的 stop 在 Windows 上因 netstat 解码 bug 找不到 PID，所以这一半由面板自己做，但仍保留「不向无法确认的进程发信号」这条安全性质。',
      autoToggle: '自动启动',
      autoOn: '已开启',
      autoOff: '已关闭',
      autoTurnOn: '开启自动启动',
      autoTurnOff: '关闭自动启动',
      autoHint: '开启后：会话开始时先探一次 /health —— 已经在跑就采纳（不重启、不改任何文件），没在跑才后台冷启动；失败会退避。',
      autoUnavailable: '开关不可写（settings 服务不可用），已禁用',
      autoStarting: '正在后台冷启动（约 44–73s，会话不会被阻塞）',
      autoNever: '本宿主尚未触发过自动启动',
      autoNoEvents: '宿主未提供会话事件，自动启动不生效（仅手动启停）',
      autoDisabledNote: '自动启动已关闭，仅保留手动启停',
      autoLastOk: '上次自动启动：已采纳现成的守护进程',
      autoLastStarted: '上次自动启动：已启动',
      autoLastFailed: '上次自动启动失败',
      autoBackoff: '已退避',
      autoRetryAfter: '后重试',
      autoFailCount: '连续失败',
      autoTimes: '次',
      healReplaced: '本次启动前替换了解释器启动器（原件已备份）',
      healNotNeeded: '启动器无需替换',
      healBlocked: '启动器不可用于无窗口启动，已拒绝启动',
      originTitle: '启动来源',
      originAuto: '自动（本插件）',
      originManual: '手动（面板）',
      originExternal: '外部（本插件之外）',
      originUnknown: '未知',
      originRisk: '有控制台窗口风险（镜像会分配控制台）',
      healthDown: '健康：—',
      healthUnreachable: '健康：不可达',
      cleanTitle: '清理用户级冲突键',
      clean: '清理…',
      cleanConfirm: '确认删除这些用户级环境变量？（会先导出备份）',
      cleanConfirmYes: '确认清理',
      cancel: '取消',
      dshTitle: '从 DSH 默认模型预填',
      dshMissing: '缺少宿主能力：',
      useDshKey: '保存时使用 DSH 的密钥（明文不出宿主进程）',
      dshKey: 'DSH 密钥',
      dshKeyAbsent: '（未解析到）',
      editSecret: '修改',
      secretSet: '已设置',
      secretUnset: '未设置（留空即不修改）',
      useDshKeyNote: '保存时写入 DSH 的密钥，明文不出宿主进程',
      stateSet: '已设置',
      stateUnset: '未设置',
      fallback: '未设 → 回落默认',
      overridden: '被外层覆盖',
      emptyMeansDelete: '留空表示删除该键（回落到默认）',
      saved: '已保存。备份：',
      backupTitle: '最近备份',
      noBackups: '（无备份）',
      verifyApplied: '已生效',
      verifyStale: '未生效',
      requests: '最近的 LLM 调用',
      noRequests: '（取不到调用记录）',
      connected: '连通性',
      connectedYes: '已验证连接',
      connectedNo: '连接失败',
      connectedUnknown: '未知',
      runtimeMissing: '日志里没有配置读取行，无法确认进程实际读到的值',
      error: '出错：',
      field: '字段',
      onDisk: '落盘值',
      request: '读取',
    }

    const S = {
      wrap: { display: 'block', fontFamily: 'inherit' },
      h: { margin: '0 0 4px', fontSize: 15, fontWeight: 600 },
      sub: { margin: '0 0 12px', fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
      card: { border: '1px solid var(--border, rgba(128,128,128,.25))', borderRadius: 8, padding: '10px 12px', marginBottom: 10 },
      cardH: { margin: '0 0 6px', fontSize: 13, fontWeight: 600 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '3px 6px', fontWeight: 600, opacity: 0.75, borderBottom: '1px solid var(--border, rgba(128,128,128,.25))' },
      td: { padding: '3px 6px', verticalAlign: 'top', borderBottom: '1px solid var(--border, rgba(128,128,128,.12))' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
      btn: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btnPrimary: { borderColor: 'var(--accent, #4c8dff)', fontWeight: 600 },
      btnDanger: { borderColor: '#d9534f', color: '#d9534f' },
      badgeOk: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid #2e9e5b', color: '#2e9e5b', whiteSpace: 'nowrap' },
      badgeWarn: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid #d98b00', color: '#d98b00', whiteSpace: 'nowrap' },
      badgeMuted: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid rgba(128,128,128,.5)', opacity: 0.8, whiteSpace: 'nowrap' },
      // Field rows own their width instead of fighting over table columns.
      field: { padding: '8px 0', borderTop: '1px solid var(--border, rgba(128,128,128,.12))' },
      fieldHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 },
      fieldLabel: { fontSize: 12, fontWeight: 600 },
      fieldKey: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      fieldBody: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      fieldInput: { flex: '1 1 240px', minWidth: 0, padding: '4px 7px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
      fieldNote: { marginTop: 4, fontSize: 11, opacity: 0.68, lineHeight: 1.6, wordBreak: 'break-word' },
      groupH: { margin: '14px 0 2px', fontSize: 12, fontWeight: 600, letterSpacing: '.02em' },
      input: { width: '100%', padding: '3px 6px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
      pre: { ...{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }, margin: '6px 0 0', padding: 8, borderRadius: 6, background: 'rgba(128,128,128,.12)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      msg: { marginTop: 8, fontSize: 12, lineHeight: 1.5 },
      err: { marginTop: 8, fontSize: 12, color: '#d9534f', lineHeight: 1.5 },
      muted: { opacity: 0.65 },
    }

    // --- pure helpers (asserted by the harness) -----------------------------

    /** Render one side of a value the host sent: secrets collapse to a mask. */
    function maskSecret(length) {
      if (length === null || length === undefined) return '—'
      return `${'•'.repeat(Math.min(10, Math.max(6, length)))}(${length})`
    }

    /** A host value → display string. */
    function renderValue(side) {
      if (!side) return '—'
      if (side.secret) return maskSecret(side.length)
      return side.value === undefined || side.value === null ? '—' : String(side.value)
    }

    /** Three states stay visually distinct, never collapsed into "empty". */
    function stateBadge(state) {
      if (state === 'overridden') return { text: T.overridden, style: S.badgeWarn }
      if (state === 'set') return { text: T.stateSet, style: S.badgeMuted }
      return { text: T.stateUnset, style: S.badgeMuted }
    }

    function fieldMapOf(state) {
      const map = {}
      for (const field of (state && state.fields) || []) map[field.key] = field
      return map
    }

    /** Seed the editable draft from what is on disk (secrets intentionally blank). */
    function draftFromState(state) {
      const draft = {}
      for (const field of (state && state.fields) || []) {
        if (isSecretKey(field.key)) {
          draft[field.key] = ''
          continue
        }
        draft[field.key] = field.onDisk && !field.onDisk.secret && field.onDisk.value !== null
          ? String(field.onDisk.value)
          : ''
      }
      return draft
    }

    /**
     * Build the save request.
     *
     * Only changed non-secret keys are sent; clearing a field means "delete this
     * key" (null). A secret is sent only when the user actually typed one, and
     * `useDshKey` deliberately sends NO key at all — the host resolves it.
     */
    function buildSaveBody({ draft, baseline, secretDraft, useDshKey }) {
      const changes = {}
      for (const key of Object.keys(draft || {})) {
        if (isSecretKey(key)) continue
        const before = baseline && baseline[key] !== undefined ? baseline[key] : ''
        const after = draft[key] === undefined ? '' : String(draft[key])
        if (after === before) continue
        changes[key] = after === '' ? null : after
      }
      if (!useDshKey && typeof secretDraft === 'string' && secretDraft !== '') {
        changes.HINDSIGHT_API_LLM_API_KEY = secretDraft
      }
      return { changes, useDshKey: useDshKey === true }
    }

    /** Is there anything to save? Drives the Save button's disabled state. */
    function hasPendingChanges(options) {
      const body = buildSaveBody(options)
      return Object.keys(body.changes).length > 0
    }

    async function callApi(path, { method = 'GET', body } = {}) {
      const init = { method, headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const detail = payload && (payload.error || (payload.errors || []).join('; '))
        throw new Error(detail || `HTTP ${response.status}`)
      }
      return payload
    }

    // --- panel --------------------------------------------------------------

    function Badge({ spec }) {
      return React.createElement('span', { style: spec.style }, spec.text)
    }

    function LayerProfile({ state }) {
      const layer = (state && state.layers && state.layers.profile) || {}
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardH }, T.layer1),
        React.createElement('div', { style: { ...S.mono, ...S.muted } }, layer.path || '—'),
        !layer.known
          ? React.createElement('div', { style: { ...S.muted, marginTop: 4 } }, `未知（${layer.reason || '?'}）`)
          : React.createElement('table', { style: S.table },
              React.createElement('tbody', null,
                (layer.entries || []).map((entry) => React.createElement('tr', { key: entry.key },
                  React.createElement('td', { style: { ...S.td, ...S.mono } }, entry.key),
                  React.createElement('td', { style: { ...S.td, ...S.mono } }, renderValue(entry.value)),
                )),
              ),
            ),
      )
    }

    /** The verdict badge, shared by layers ② and ④ so they can never disagree. */
    function verdictBadge(layerKnown, applied) {
      if (!layerKnown) {
        return {
          text: applied.reason === 'daemon-not-running' ? T.unknownDaemon : `${T.connectedUnknown}（${applied.reason || '?'}）`,
          style: S.badgeMuted,
        }
      }
      if (applied.applied) return { text: T.applied, style: S.badgeOk }
      if (applied.reason === 'mismatch') return { text: T.mismatch, style: S.badgeWarn }
      return { text: T.stale, style: S.badgeWarn }
    }

    function LayerRuntime({ state }) {
      const layer = (state && state.layers && state.layers.runtime) || {}
      const applied = (state && state.layers && state.layers.applied) || {}
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardH }, T.layer2, ' ', React.createElement(Badge, { spec: verdictBadge(layer.known, applied) })),
        layer.known
          ? React.createElement('div', { style: S.mono },
              `provider=${layer.provider ?? '—'}  model=${layer.model ?? '—'}  base_url=${layer.baseUrl ?? '—'}`)
          : React.createElement('div', { style: S.muted }, T.runtimeMissing),
        React.createElement('div', { style: { ...S.muted, marginTop: 4 } }, `${T.connected}：${layer.connected === true ? T.connectedYes : layer.connected === false ? T.connectedNo : T.connectedUnknown}`),
      )
    }

    function LayerConflicts({ state, onClean, busy, confirming, setConfirming }) {
      const conflicts = (state && state.layers && state.layers.conflicts) || {}
      const userLevel = conflicts.userLevel || []
      const processLevel = conflicts.processLevel || []
      const rowOf = (item) => React.createElement('tr', { key: `${item.key}` },
        React.createElement('td', { style: { ...S.td, ...S.mono } }, item.key),
        React.createElement('td', { style: { ...S.td, ...S.mono } }, renderValue(item.outer)),
        React.createElement('td', { style: { ...S.td, ...S.mono, ...S.muted } }, renderValue(item.onDisk)),
      )
      const table = (rows) => React.createElement('table', { style: S.table },
        React.createElement('thead', null, React.createElement('tr', null,
          React.createElement('th', { style: S.th }, T.field),
          React.createElement('th', { style: S.th }, '外层值'),
          React.createElement('th', { style: S.th }, T.onDisk),
        )),
        React.createElement('tbody', null, rows),
      )
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardH }, T.layer3, ' ',
          userLevel.length + processLevel.length === 0
            ? React.createElement(Badge, { spec: { text: T.noConflict, style: S.badgeOk } })
            : React.createElement(Badge, { spec: { text: `${userLevel.length + processLevel.length}`, style: S.badgeWarn } })),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 4 } }, T.userLevel),
        userLevel.length === 0
          ? React.createElement('div', { style: S.muted }, T.noConflict)
          : table(userLevel.map(rowOf)),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 8 } }, T.processLevel),
        processLevel.length === 0
          ? React.createElement('div', { style: S.muted }, T.noConflict)
          : table(processLevel.map(rowOf)),
        React.createElement('div', { style: { ...S.muted, marginTop: 4, fontSize: 11 } }, T.processLevelNote),
        userLevel.length > 0
          ? React.createElement('div', { style: S.row },
              !confirming
                ? React.createElement('button', { style: { ...S.btn, ...S.btnDanger }, disabled: busy, onClick: () => setConfirming(true) }, T.clean)
                : React.createElement(React.Fragment, null,
                    React.createElement('span', { style: { fontSize: 12, color: '#d9534f' } }, T.cleanConfirm),
                    React.createElement('button', { style: { ...S.btn, ...S.btnDanger }, disabled: busy, onClick: onClean }, T.cleanConfirmYes),
                    React.createElement('button', { style: S.btn, disabled: busy, onClick: () => setConfirming(false) }, T.cancel),
                  ),
            )
          : null,
      )
    }

    function LayerApplied({ state }) {
      const applied = (state && state.layers && state.layers.applied) || {}
      const mismatched = applied.mismatched || []
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardH }, T.layer4, ' ', React.createElement(Badge, { spec: verdictBadge(applied.known, applied) })),
        React.createElement('div', { style: { ...S.mono, ...S.muted } },
          `${T.pid}=${applied.pid ?? '—'}  ${T.startTime}=${applied.startTime ?? '—'}  ${T.envMtime}=${applied.envMtime ?? '—'}`),
        React.createElement('div', { style: { ...S.muted, marginTop: 4 } },
          applied.basis === 'values' ? T.basisValues : T.basisTiming),
        mismatched.length > 0
          ? React.createElement('div', { style: { ...S.mono, marginTop: 4, color: '#d98b00' } },
              mismatched.map((field) => `${field}: 文件=${applied.file ? applied.file[field] ?? '—' : '—'} / 进程=${applied.runtime ? applied.runtime[field] ?? '—' : '—'}`).join('\n'))
          : null,
        applied.rewrittenAfterStart === true
          ? React.createElement('div', { style: { ...S.muted, marginTop: 4 } }, T.rewritten)
          : null,
      )
    }

    /**
     * Which outer source beats this key, and with what value.
     * The panel must show the value that actually wins, not just that it loses.
     */
    function conflictsOf(state) {
      const out = {}
      const groups = [
        ['user', (state && state.layers && state.layers.conflicts && state.layers.conflicts.userLevel) || []],
        ['process', (state && state.layers && state.layers.conflicts && state.layers.conflicts.processLevel) || []],
      ]
      for (const [scope, rows] of groups) {
        for (const row of rows) {
          out[row.key] = (out[row.key] || []).concat([{ scope, value: renderValue(row.outer) }])
        }
      }
      return out
    }

    /**
     * The daemon block: live status, the four lifecycle actions, and the exact
     * commands those buttons run.
     *
     * The panel spawns the daemon itself — and because it does, it also owns the
     * environment sanitization that used to be the user's job (their command
     * text carried a `Remove-Item Env:` line). That is why the displayed
     * command has no cleanup in it: the cleanup happens in the child's
     * environment, which a shell line could not express reliably.
     */
    function LayerDaemon({ state, onAction, onAuto, busy, confirm, setConfirm }) {
      const daemon = (state && state.daemon) || {}
      const applied = (state && state.layers && state.layers.applied) || {}
      const layout = (state && state.layout) || {}
      const health = daemon.health || {}
      const commands = daemon.commands || {}
      const auto = (state && state.auto) || {}
      const origin = (state && state.origin) || {}
      const running = daemon.running === true
      const can = daemon.canControl === true
      const busyAny = busy !== null
      const busyDaemon = typeof busy === 'string' && busy.startsWith('daemon:')
      const busyAuto = busy === 'auto'

      // --- on-demand auto start: the switch, its policy, and what happened ----
      const autoWritable = auto.writable === true
      const autoOn = auto.enabled === true
      const autoLine = (key, text, style) => React.createElement('div', {
        key,
        style: { ...(style || S.muted), marginTop: 4, fontSize: 12 },
      }, text)

      const autoLines = []
      if (autoOn && auto.starting) autoLines.push(autoLine('starting', T.autoStarting))
      if (!autoOn) autoLines.push(autoLine('off', T.autoDisabledNote))
      if (auto.hostEvents === 'missing') autoLines.push(autoLine('no-events', T.autoNoEvents, S.warn))
      if (autoOn && auto.hostEvents !== 'missing' && auto.triggers === 0) autoLines.push(autoLine('never', T.autoNever))
      if (auto.lastResult) {
        const label = auto.lastResult.ok
          ? (auto.lastResult.code === 'adopted' ? T.autoLastOk : T.autoLastStarted)
          : T.autoLastFailed
        const extras = []
        if (!auto.lastResult.ok && auto.lastResult.code) extras.push(auto.lastResult.code)
        if (!auto.lastResult.ok && auto.failures > 0) extras.push(`${T.autoFailCount} ${auto.failures} ${T.autoTimes}`)
        if (auto.retryInMs > 0) extras.push(`${T.autoBackoff} ${Math.ceil(auto.retryInMs / 1000)}s ${T.autoRetryAfter}`)
        autoLines.push(autoLine('last', `${label}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
          auto.lastResult.ok ? S.muted : S.warn))
      }
      if (auto.healed) {
        autoLines.push(autoLine('healed', `${T.healReplaced}：${auto.healed.backupPath || '—'}`))
      } else if (auto.heal && auto.heal.blocked) {
        autoLines.push(autoLine('heal-blocked', `${T.healBlocked}（${auto.heal.reason || '?'}）`, S.warn))
      }
      if (origin.origin) {
        const label = { auto: T.originAuto, manual: T.originManual, external: T.originExternal }[origin.origin] || T.originUnknown
        autoLines.push(autoLine('origin', `${T.originTitle}：${label}${origin.consoleRisk ? ` · ${T.originRisk}` : ''}`,
          origin.consoleRisk ? S.warn : S.muted))
      }

      const autoBlock = React.createElement('div', { key: 'auto', style: { marginTop: 8 } },
        React.createElement('div', { style: { ...S.row, gap: 8 } },
          React.createElement(Badge, { spec: autoOn
            ? { text: `${T.autoToggle} ${T.autoOn}`, style: S.badgeOk }
            : { text: `${T.autoToggle} ${T.autoOff}`, style: S.badgeMuted } }),
          React.createElement('button', {
            style: S.btn,
            disabled: busyAny || !autoWritable,
            onClick: () => onAuto(!autoOn),
          }, busyAuto ? T.daemonWorking : (autoOn ? T.autoTurnOff : T.autoTurnOn)),
        ),
        !autoWritable ? autoLine('unwritable', T.autoUnavailable, S.warn) : null,
        autoLine('hint', T.autoHint),
        ...autoLines,
      )

      const healthBadge = !running
        ? { text: T.healthDown, style: S.badgeMuted }
        : (health.reachable
            ? { text: `${health.status || 'healthy'}${health.database ? ` · ${health.database}` : ''}`, style: S.badgeOk }
            : { text: T.healthUnreachable, style: S.badgeWarn })

      const actionButton = (action, label, needsConfirm) => {
        if (needsConfirm && confirm === action) {
          return React.createElement('span', { key: `${action}-confirm`, style: S.row },
            React.createElement('button', {
              style: { ...S.btn, ...S.btnDanger },
              disabled: busyAny,
              onClick: () => onAction(action),
            }, action === 'stop' ? T.daemonConfirmStop : T.daemonConfirmRestart),
            React.createElement('button', { style: S.btn, disabled: busyAny, onClick: () => setConfirm(null) }, T.cancel),
          )
        }
        return React.createElement('button', {
          key: action,
          style: S.btn,
          disabled: busyAny || !can,
          onClick: () => (needsConfirm ? setConfirm(action) : onAction(action)),
        }, label)
      }

      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardH }, T.daemonTitle, ' ',
          React.createElement(Badge, { spec: running
            ? { text: `${T.daemonRunning}${daemon.pid ? ` · PID ${daemon.pid}` : ''}`, style: S.badgeOk }
            : { text: T.daemonStopped, style: S.badgeMuted } }),
          ' ',
          React.createElement(Badge, { spec: healthBadge })),
        React.createElement('div', { style: { ...S.mono, ...S.muted } },
          `port=${layout.apiPort ?? '—'}  startTime=${applied.startTime ?? '—'}`),
        React.createElement('div', { style: S.row },
          actionButton('start', T.daemonStart, false),
          actionButton('stop', T.daemonStop, true),
          actionButton('restart', T.daemonRestart, true),
          busyDaemon ? React.createElement('span', { style: { ...S.muted, ...S.mono } }, T.daemonWorking) : null,
        ),
        autoBlock,
        React.createElement('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } }, T.daemonWarn),
        !can
          ? React.createElement('div', { style: { ...S.muted, marginTop: 6, fontSize: 12 } },
              `${T.daemonDisabled}${daemon.reason ? `：${daemon.reason}` : ''}`)
          : null,
        can && commands.start
          ? React.createElement('div', { style: { marginTop: 8 } },
              React.createElement('div', { style: { ...S.cardH, fontSize: 12 } }, T.daemonCmdTitle),
              React.createElement('pre', { style: S.pre }, `${commands.start}\n${commands.stop}`),
              React.createElement('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, T.daemonEnvNote),
              React.createElement('div', { style: S.row },
                React.createElement('button', {
                  style: S.btn,
                  onClick: async () => {
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(`${commands.start}\n${commands.stop}`)
                      }
                    } catch { /* clipboard unavailable: the text is selectable anyway */ }
                  },
                }, T.copy),
              ),
            )
          : null,
      )
    }

    /**
     * One field, as a block rather than a table row.
     *
     * A four-column table could not hold the status chip in a narrow settings
     * column: `被外层覆盖` wrapped and collided with the value cell, and the
     * "on disk" column just repeated whatever the input already showed. Here the
     * chip never wraps, the input owns the full width, and the history
     * ("原值 …" / fallback / the winning outer value) appears as a note ONLY when
     * it says something the input does not already say.
     */
    function FieldRow({ field, conflict, draft, secretDraft, setDraft, setSecretDraft, secretEditable, setSecretEditable, useDshKey }) {
      const secret = isSecretKey(field.key)
      const disabled = secret && (useDshKey || !secretEditable)
      const value = secret ? secretDraft : (draft[field.key] === undefined ? '' : draft[field.key])
      const onDisk = field.onDisk ? renderValue(field.onDisk) : null

      const notes = []
      if (field.state === 'overridden' && conflict) {
        for (const hit of conflict) {
          notes.push(`${hit.scope === 'user' ? '实为用户级' : '实为宿主进程'}：${hit.value}`)
        }
      }
      if (field.state === 'unset' && field.fallback) notes.push(`${T.fallback}：${field.fallback}`)
      if (!secret && onDisk !== null && String(value) !== onDisk) notes.push(`原值 ${onDisk}`)
      if (secret) {
        if (useDshKey) notes.push(T.useDshKeyNote)
        else if (field.onDisk && field.onDisk.secret) notes.push(`${T.secretSet}：${maskSecret(field.onDisk.length)}`)
        else notes.push(T.secretUnset)
      }

      return React.createElement('div', { style: S.field },
        React.createElement('div', { style: S.fieldHead },
          React.createElement('span', { style: S.fieldLabel }, KEY_LABELS[field.key] || field.key),
          React.createElement(Badge, { spec: stateBadge(field.state) }),
          React.createElement('code', { style: S.fieldKey, title: field.key }, field.key),
        ),
        React.createElement('div', { style: S.fieldBody },
          React.createElement('input', {
            style: S.fieldInput,
            type: secret ? 'password' : 'text',
            value,
            disabled,
            'aria-label': field.key,
            placeholder: secret && field.onDisk && field.onDisk.secret ? maskSecret(field.onDisk.length) : '',
            onChange: (event) => {
              if (secret) setSecretDraft(event.target.value)
              else setDraft(field.key, event.target.value)
            },
          }),
          secret
            ? React.createElement('button', {
                style: S.btn,
                disabled: useDshKey,
                onClick: () => setSecretEditable(!secretEditable),
              }, T.editSecret)
            : null,
        ),
        notes.length > 0
          ? React.createElement('div', { style: S.fieldNote }, notes.join(' · '))
          : null,
      )
    }

    function Section() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState({})
      const [secretDraft, setSecretDraft] = useState('')
      const [secretEditable, setSecretEditable] = useState(false)
      const [useDshKey, setUseDshKey] = useState(false)
      const [dsh, setDsh] = useState(null)
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState(null)
      const [error, setError] = useState(null)
      const [verification, setVerification] = useState(null)
      const [confirming, setConfirming] = useState(false)
      const [daemonConfirm, setDaemonConfirm] = useState(null)
      const [copied, setCopied] = useState(false)

      const load = useCallback(async () => {
        setError(null)
        try {
          const next = await callApi(API.state)
          setState(next)
          setDraft(draftFromState(next))
          setSecretDraft('')
          setSecretEditable(false)
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const baseline = useMemo(() => draftFromState(state), [state])
      const pending = state
        ? hasPendingChanges({ draft, baseline, secretDraft, useDshKey })
        : false
      const dshUsable = state && state.dsh && state.dsh.available
      const restart = (state && state.restart) || {}

      const wrap = (name, fn) => async () => {
        setBusy(name)
        setError(null)
        setMessage(null)
        try {
          await fn()
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(null)
        }
      }

      const onSave = wrap('save', async () => {
        const body = buildSaveBody({ draft, baseline, secretDraft, useDshKey })
        const result = await callApi(API.save, { method: 'POST', body })
        setMessage(`${T.saved}${result.backupPath || '—'}`)
        setSecretDraft('')
        setSecretEditable(false)
        await load()
      })

      const onVerify = wrap('verify', async () => {
        setVerification(await callApi(API.verify, { method: 'POST', body: {} }))
      })

      const onReadDsh = wrap('dsh', async () => {
        const payload = await callApi(API.dshModel)
        setDsh(payload.dsh)
        const selection = payload.dsh && payload.dsh.selection
        const route = payload.dsh && payload.dsh.route
        if (selection) {
          setDraft((current) => {
            const next = { ...current }
            if (selection.provider) next.HINDSIGHT_API_LLM_PROVIDER = selection.provider
            if (selection.model) next.HINDSIGHT_API_LLM_MODEL = selection.model
            if (route && route.baseURL) next.HINDSIGHT_API_LLM_BASE_URL = route.baseURL
            return next
          })
        }
        if (payload.dsh && payload.dsh.key && payload.dsh.key.hasValue) setUseDshKey(true)
      })

      const onClean = wrap('clean', async () => {
        const result = await callApi(API.cleanEnv, { method: 'POST', body: { confirm: true } })
        setMessage(`removed: ${(result.removed || []).join(', ') || '—'} · backup: ${result.backupPath || '—'}`)
        setConfirming(false)
        await load()
      })

      // `start` is harmless; `stop` and `restart` interrupt in-flight memory
      // work, so they only fire after the inline confirm — and that confirm is
      // what sets the `confirm` flag the host insists on.
      // The switch is one settings key on the host; flipping it is a plain POST.
      const onAuto = (enabled) => wrap('auto', async () => {
        const result = await callApi(API.auto, { method: 'POST', body: { enabled } })
        setMessage([
          `${T.autoToggle} → ${enabled ? T.autoOn : T.autoOff}`,
          result && result.code ? result.code : null,
        ].filter(Boolean).join(' · '))
        if (result && result.state) setState(result.state)
      })()

      const onDaemon = (action) => wrap(`daemon:${action}`, async () => {
        const body = action === 'start' ? { action } : { action, confirm: true }
        const result = await callApi(API.daemon, { method: 'POST', body })
        setDaemonConfirm(null)
        const last = (result.steps || []).slice(-1)[0]
        setMessage([
          `${action} → ${result.code}`,
          last && last.exitCode !== null && last.exitCode !== undefined ? `exit=${last.exitCode}` : null,
          last && last.output ? last.output : null,
        ].filter(Boolean).join(' · '))
        if (result.state) setState(result.state)
      })()

      if (!state && error) {
        return React.createElement('div', { style: S.wrap },
          React.createElement('h3', { style: S.h }, T.title),
          React.createElement('div', { style: S.err }, `${T.error}${error}`),
          React.createElement('div', { style: S.row },
            React.createElement('button', { style: S.btn, onClick: load }, T.reload)),
        )
      }
      if (!state) {
        return React.createElement('div', { style: S.wrap }, React.createElement('h3', { style: S.h }, T.title),
          React.createElement('div', { style: S.muted }, '…'))
      }

      const fieldMap = fieldMapOf(state)
      const conflicts = conflictsOf(state)
      const groups = state.groups || []

      return React.createElement('div', { style: S.wrap },
        React.createElement('h3', { style: S.h }, T.title),
        React.createElement('p', { style: S.sub }, T.subtitle),

        React.createElement(LayerProfile, { state }),
        React.createElement(LayerRuntime, { state }),
        React.createElement(LayerConflicts, { state, onClean, busy, confirming, setConfirming }),
        React.createElement(LayerApplied, { state }),

        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.cardH }, '配置'),
          React.createElement('div', { style: { ...S.muted, fontSize: 11 } }, T.emptyMeansDelete),
          groups.flatMap((group) => [
            React.createElement('div', { key: `g-${group.id}`, style: S.groupH }, GROUP_LABELS[group.id] || group.id),
            ...group.keys.filter((key) => fieldMap[key]).map((key) => React.createElement(FieldRow, {
              key,
              field: fieldMap[key],
              conflict: conflicts[key],
              draft,
              secretDraft,
              setDraft: (k, v) => setDraft((current) => ({ ...current, [k]: v })),
              setSecretDraft,
              secretEditable,
              setSecretEditable,
              useDshKey,
            })),
          ]),
          React.createElement('label', { style: { ...S.row, fontSize: 12 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: useDshKey,
              disabled: !dshUsable,
              onChange: (event) => setUseDshKey(event.target.checked),
            }),
            T.useDshKey,
            dsh && dsh.key && dsh.key.source
              ? React.createElement('span', { style: { ...S.muted, ...S.mono } },
                  `${T.dshKey}：${dsh.key.source}（${dsh.key.hasValue ? maskSecret(dsh.key.length) : T.dshKeyAbsent}）`)
              : null,
          ),
          React.createElement('div', { style: S.row },
            React.createElement('button', {
              style: S.btn,
              disabled: busy !== null || !dshUsable,
              title: dshUsable ? '' : `${T.dshMissing}${((state.dsh && state.dsh.missing) || []).join(', ')}`,
              onClick: onReadDsh,
            }, busy === 'dsh' ? T.reading : T.readDsh),
            React.createElement('button', {
              style: { ...S.btn, ...S.btnPrimary },
              disabled: busy !== null || !pending,
              onClick: onSave,
            }, busy === 'save' ? T.saving : T.save),
            React.createElement('button', {
              style: S.btn,
              disabled: busy !== null,
              onClick: onVerify,
            }, busy === 'verify' ? T.verifying : T.verify),
            React.createElement('button', { style: S.btn, disabled: busy !== null, onClick: load }, T.reload),
          ),
          !dshUsable
            ? React.createElement('div', { style: { ...S.muted, marginTop: 6, fontSize: 12 } },
                `${T.dshMissing}${((state.dsh && state.dsh.missing) || []).join(', ') || '—'}`)
            : null,
        ),

        React.createElement(LayerDaemon, {
          state,
          onAction: onDaemon,
          onAuto,
          busy,
          confirm: daemonConfirm,
          setConfirm: setDaemonConfirm,
        }),

        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.cardH }, T.restartTitle),
          restart.command
            ? React.createElement('pre', { style: S.pre }, restart.command)
            : React.createElement('div', { style: S.muted }, T.restartUnavailable),
          restart.command
            ? React.createElement('div', { style: S.row },
                React.createElement('button', {
                  style: S.btn,
                  onClick: async () => {
                    try {
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(restart.command)
                      }
                      setCopied(true)
                    } catch { /* clipboard unavailable: the text is selectable anyway */ }
                  },
                }, copied ? T.copied : T.copy),
              )
            : null,
        ),

        verification
          ? React.createElement('div', { style: S.card },
              React.createElement('div', { style: S.cardH },
                verification.applied
                  ? React.createElement(Badge, { spec: { text: T.verifyApplied, style: S.badgeOk } })
                  : React.createElement(Badge, {
                      spec: {
                        text: `${verification.reason === 'mismatch' ? T.mismatch : T.verifyStale}（${verification.reason}）`,
                        style: S.badgeWarn,
                      },
                    })),
              React.createElement('div', { style: { ...S.muted, marginTop: 4 } },
                verification.basis === 'values' ? T.basisValues : T.basisTiming),
              verification.runtime
                ? React.createElement('div', { style: S.mono },
                    `provider=${verification.runtime.provider ?? '—'}  model=${verification.runtime.model ?? '—'}  base_url=${verification.runtime.baseUrl ?? '—'}`)
                : null,
              (verification.mismatched || []).length > 0
                ? React.createElement('div', { style: { ...S.mono, marginTop: 4, color: '#d98b00' } },
                    verification.mismatched.map((field) => `${field}: 文件=${verification.file ? verification.file[field] ?? '—' : '—'} / 进程=${verification.runtime ? verification.runtime[field] ?? '—' : '—'}`).join('\n'))
                : null,
              verification.rewrittenAfterStart === true
                ? React.createElement('div', { style: { ...S.muted, marginTop: 4 } }, T.rewritten)
                : null,
              React.createElement('div', { style: { ...S.cardH, marginTop: 8 } }, T.requests),
              (verification.requests && verification.requests.length > 0)
                ? React.createElement('table', { style: S.table },
                    React.createElement('tbody', null, verification.requests.map((row, index) => React.createElement('tr', { key: index },
                      React.createElement('td', { style: { ...S.td, ...S.mono } }, `${row.provider ?? '—'}/${row.model ?? '—'}`),
                      React.createElement('td', { style: { ...S.td, ...S.mono } }, row.operation || '—'),
                      React.createElement('td', { style: { ...S.td, ...S.mono } }, row.status || '—'),
                    ))))
                : React.createElement('div', { style: S.muted }, T.noRequests),
            )
          : null,

        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.cardH }, T.backupTitle),
          (state.backups && state.backups.length > 0)
            ? React.createElement('div', { style: S.mono }, state.backups.join('\n'))
            : React.createElement('div', { style: S.muted }, T.noBackups),
        ),

        message ? React.createElement('div', { style: S.msg }, message) : null,
        error ? React.createElement('div', { style: S.err }, `${T.error}${error}`) : null,
      )
    }

    // --- registration --------------------------------------------------------

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 17,
        label: () => T.title,
      }, Section))
    }

    // Test-only hooks (window.__DSH_TEST__ is set by test/bundle.test.mjs only).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshHindsightModelTest = {
        API,
        SECTION_ID,
        KEY_LABELS,
        Section,
        maskSecret,
        renderValue,
        stateBadge,
        draftFromState,
        buildSaveBody,
        hasPendingChanges,
        fieldMapOf,
        conflictsOf,
        isSecretKey,
      }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-hindsight-model/src/client.js
