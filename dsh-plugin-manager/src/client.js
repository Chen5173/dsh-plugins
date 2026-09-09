// dsh-plugin-manager: CLIENT half — Settings > 本地插件 panel.
//
// Registers a top-level settings.section ('local-plugins', order 16, between
// the built-in 插件(15) and the mcp-manager(18) sections) and renders every
// dsh-* sibling found under the repo root with its live profile state. All
// data/actions go to the host half's /__dsh-plugin-manager/* HTTP endpoints.
//
// Activation semantics surfaced here:
//   · 主开关 on  → activate (auto pnpm installs the devDependency link if the
//     package is not resolvable yet, then writes the canonical row)
//   · 主开关 off → disable (keeps the row, sets disabled, live-stops the host)
//   · 移除       → delete row + drop devDependency
//   · 一键接管/迁移 → migrate the legacy per-plugin layout to manager-owned
//   · host rows go live immediately via DSH patch HMR; client-side UI of the
//     toggled plugin enters/leaves __DSH_BOOT__ only after a page reload, so
//     the panel shows a 「刷新页面使界面生效」 hint + button (never auto-reloads).
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives the
// module-table `require` (react is a seeded word) and returns { apply, inject }.
// No JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- copy ---------------------------------------------------------------
    const NS = 'dshPluginManager'
    const zhDict = {
      nav: '本地插件',
      intro: '管理本仓库根目录下的 dsh-* 子插件在 profile 中的激活状态。',
      repoRoot: '仓库目录',
      profile: '目标 profile',
      refresh: '刷新',
      reload: '刷新页面使界面生效',
      reloadHint: '客户端界面需要在刷新页面后出现/消失。',
      migrate: '一键接管/迁移',
      migrateNeed: '检测到子插件仍以旧布局安装，请先迁移。',
      migrateConfirm: '将本地子插件收敛为管理器统一管理（devDependencies + 管理器维护的激活行），并备份 profile 文件。继续？',
      migrateBusy: '迁移中…',
      remove: '移除',
      removeConfirm: '将删除激活行并从 devDependencies 摘除该插件（可随时重新启用）。继续？',
      busy: '处理中…',
      stateActive: '已激活',
      stateDisabled: '已停用',
      stateLegacy: '旧布局',
      stateUninstalled: '未激活',
      stateInactive: '未激活(仅依赖)',
      stateInvalid: '非插件目录',
      noPlugins: '仓库根没有发现 dsh-* 子插件。',
      error: '出错',
      hasClientTag: '带界面',
    }
    const enDict = {
      nav: 'Local plugins',
      intro: 'Manage the dsh-* plugins under this repo root in the current profile.',
      repoRoot: 'Repo root',
      profile: 'Profile',
      refresh: 'Refresh',
      reload: 'Reload page to apply UI changes',
      reloadHint: 'Client UI appears/disappears after a page reload.',
      migrate: 'Take over / migrate',
      migrateNeed: 'Plugins are still installed the legacy way — migrate first.',
      migrateConfirm: 'Adopt all local plugins into the manager model (devDependencies + manager-owned rows) with profile backups. Continue?',
      migrateBusy: 'Migrating…',
      remove: 'Remove',
      removeConfirm: 'This deletes the activation row and drops the devDependency (can be re-enabled anytime). Continue?',
      busy: 'Working…',
      stateActive: 'Active',
      stateDisabled: 'Disabled',
      stateLegacy: 'Legacy',
      stateUninstalled: 'Inactive',
      stateInactive: 'Inactive (dep only)',
      stateInvalid: 'Not a plugin',
      noPlugins: 'No dsh-* plugins found under the repo root.',
      error: 'Error',
      hasClientTag: 'UI',
    }
    const t = (key) => {
      const lang = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages && navigator.languages[0]) || 'zh')
      const dict = String(lang).toLowerCase().startsWith('en') ? enDict : zhDict
      return dict[key] || key
    }

    // --- styling helpers ----------------------------------------------------
    const S = {
      page: { maxWidth: 780, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 12 },
      heading: { margin: 0, fontSize: 18, fontWeight: 600 },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 },
      metaRow: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, fontFamily: 'var(--ds-font-family-code, monospace)' },
      banner: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 12, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
      bannerWarn: { borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary,#b45309) 45%, transparent)' },
      bannerOk: { borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)' },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      card: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' },
      cardInvalid: { opacity: .55 },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
      dotActive: { background: 'var(--dsw-alias-state-success-primary)' },
      dotDisabled: { background: 'var(--dsw-alias-label-tertiary)' },
      dotLegacy: { background: 'var(--dsw-alias-state-warning-primary,#b45309)' },
      dotUninstalled: { background: 'var(--dsw-alias-label-dimmed)' },
      body: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 14, fontWeight: 600 },
      badge: { color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11 },
      desc: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      state: { fontSize: 12, whiteSpace: 'nowrap' },
      stateColor: (st) => st === 'active' ? 'var(--dsw-alias-state-success-primary)'
        : st === 'legacy' ? 'var(--dsw-alias-state-warning-primary,#b45309)'
          : st === 'invalid' ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-tertiary)',
      actions: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
      button: { font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '4px 12px', fontSize: 12 },
      buttonPrimary: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', border: 'none' },
      buttonDanger: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)' },
      buttonDisabled: { opacity: .4, cursor: 'default' },
      switch: { boxSizing: 'border-box', width: 36, height: 20, borderRadius: 10, padding: 2, background: 'var(--dsw-alias-border-l3)', cursor: 'pointer', border: 'none', flex: 'none', position: 'relative' },
      switchOn: { background: 'var(--dsw-alias-brand-primary)' },
      thumb: { boxSizing: 'border-box', width: 16, height: 16, borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground)', display: 'block', transition: 'transform .12s' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 },
      notice: { margin: 0, fontSize: 13 },
      empty: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 13 },
    }
    const Row = ({ children, style }) => React.createElement('div', { style }, children)

    // --- pure helpers (exposed for the harness) -----------------------------
    const stateText = (st) => ({
      active: t('stateActive'),
      disabled: t('stateDisabled'),
      legacy: t('stateLegacy'),
      uninstalled: t('stateUninstalled'),
      inactive: t('stateInactive'),
      invalid: t('stateInvalid'),
    }[st] || st)

    const API = '/__dsh-plugin-manager'

    // --- panel component ----------------------------------------------------
    function LocalPluginsSection() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(null) // 'migrate' | dir name
      const [notice, setNotice] = useState(null) // {type:'ok'|'err'|'warn', text}
      const [needReload, setNeedReload] = useState(false)
      const seq = useRef(0)

      const load = useCallback(async () => {
        const id = ++seq.current
        try {
          const res = await fetch(`${API}/list`)
          const json = await res.json()
          if (id !== seq.current) return
          if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
          setData(json.data)
          setErr(null)
        } catch (e) {
          if (id !== seq.current) return
          setErr((e && e.message) || String(e))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const run = useCallback(async (path, body, what) => {
        setBusy(what)
        setNotice(null)
        try {
          const res = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || json.ok === false) {
            throw new Error(json.error || `HTTP ${res.status}`)
          }
          setData(json.data || null)
          return json
        } catch (e) {
          setNotice({ type: 'err', text: `${t('error')}: ${(e && e.message) || String(e)}` })
          return null
        } finally {
          setBusy(null)
        }
      }, [])

      const toggle = (plugin) => {
        const target = !plugin.active
        const what = `${plugin.dir}:${target ? 'on' : 'off'}`
        run(`${API}/set-enabled`, { dir: plugin.dir, enabled: target }, what).then((json) => {
          if (!json) return
          if (plugin.hasClient) {
            setNeedReload(true)
            setNotice({ type: 'ok', text: `${t('reload')}（${plugin.name}）` })
          } else {
            setNotice({ type: 'ok', text: `${plugin.name} ${target ? t('stateActive') : t('stateDisabled')}` })
          }
        })
      }

      const remove = (plugin) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`${plugin.name}：${t('removeConfirm')}`)) return
        run(`${API}/remove`, { dir: plugin.dir }, plugin.dir).then((json) => {
          if (!json) return
          if (plugin.hasClient) setNeedReload(true)
          setNotice({ type: 'ok', text: `${plugin.name} ${t('stateUninstalled')}` })
        })
      }

      const migrate = () => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('migrateConfirm'))) return
        run(`${API}/migrate`, {}, 'migrate').then((json) => {
          if (!json) return
          setNeedReload(true)
          setNotice({ type: 'ok', text: `${t('migrate')} ✓ · ${t('reloadHint')}` })
        })
      }

      const plugins = (data && data.plugins) || []
      const legacyDetected = data ? data.legacyDetected : false

      const isBusy = (p) => busy === p.dir || busy === 'migrate'

      return React.createElement('div', { style: S.page },
        React.createElement('h3', { style: S.heading }, t('nav')),
        React.createElement('p', { style: S.intro }, t('intro')),
        React.createElement('div', { style: S.metaRow },
          data && React.createElement('span', null, `${t('repoRoot')}: ${data.repoRoot}`),
          data && React.createElement('span', null, `${t('profile')}: ${data.profileName}`),
        ),
        err && React.createElement('p', { style: S.err }, `${t('error')}: ${err}`),
        data && data.yamlError && React.createElement('p', { style: { ...S.err, marginTop: 0 } }, `YAML: ${data.yamlError}`),
        notice && React.createElement('div', { style: { ...S.banner, ...(notice.type === 'err' ? S.bannerWarn : S.bannerOk) } },
          React.createElement('p', { style: S.notice }, notice.text),
          needReload && React.createElement('button', { style: S.button, onClick: () => { if (typeof window !== 'undefined') window.location.reload() } }, t('refresh')),
        ),
        data && legacyDetected && React.createElement('div', { style: { ...S.banner, ...S.bannerWarn } },
          React.createElement('span', { style: { flex: 1, fontSize: 13 } }, t('migrateNeed')),
          React.createElement('button', {
            style: { ...S.button, ...S.buttonPrimary },
            disabled: busy === 'migrate',
            onClick: migrate,
          }, busy === 'migrate' ? t('migrateBusy') : t('migrate')),
        ),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          React.createElement('button', { style: S.button, onClick: load, disabled: Boolean(busy) }, t('refresh')),
        ),
        plugins.length === 0
          ? React.createElement('p', { style: S.empty }, t('noPlugins'))
          : React.createElement('ul', { style: S.list }, plugins.map((p) => {
              const legacy = p.legacyBundle === true || p.state === 'legacy'
              const stateLabel = legacy ? t('stateLegacy') : stateText(p.state)
              return React.createElement('li', { key: p.dir, style: { ...S.card, ...(p.state === 'invalid' ? S.cardInvalid : {}) } },
                React.createElement('span', {
                  style: { ...S.dot, ...(legacy ? S.dotLegacy : ({ active: S.dotActive, disabled: S.dotDisabled, uninstalled: S.dotUninstalled, inactive: S.dotUninstalled, invalid: S.dotDisabled }[p.state] || S.dotDisabled)) },
                  title: stateLabel,
                }),
                React.createElement('div', { style: S.body },
                  React.createElement('div', { style: S.titleRow },
                    React.createElement('p', { style: S.title }, p.name || p.dir),
                    React.createElement('span', { style: S.badge }, p.dir),
                    p.hasClient && React.createElement('span', { style: S.badge }, t('hasClientTag')),
                  ),
                  p.description ? React.createElement('p', { style: S.desc }, p.description) : null,
                ),
                React.createElement('span', { style: { ...S.state, color: legacy ? S.stateColor('legacy') : S.stateColor(p.state) } }, stateLabel),
                React.createElement('div', { style: S.actions },
                  p.state === 'invalid'
                    ? null
                    : legacy
                      ? React.createElement('button', { style: { ...S.button, ...S.buttonDisabled }, disabled: true }, t('stateLegacy'))
                      : React.createElement('button', {
                          'aria-checked': p.active,
                          role: 'switch',
                          disabled: isBusy(p),
                          title: p.active ? t('stateDisabled') : t('stateActive'),
                          style: { ...S.switch, ...(p.active ? S.switchOn : {}) },
                          onClick: () => toggle(p),
                        }, React.createElement('span', { style: { ...S.thumb, transform: p.active ? 'translateX(16px)' : 'none' } })),
                  (!legacy && (p.state === 'active' || p.state === 'disabled' || p.state === 'inactive'))
                    ? React.createElement('button', {
                        style: { ...S.button, ...S.buttonDanger },
                        disabled: isBusy(p),
                        onClick: () => remove(p),
                      }, t('remove'))
                    : null,
                ),
              )
            }),
          ),
      )
    }

    // --- registration --------------------------------------------------------
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'local-plugins',
        order: 16,
        label: () => t('nav'),
      }, LocalPluginsSection))
    }

    // Test-only hooks (window.__DSH_TEST__ is set by test/bundle.test.mjs only).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshPluginManagerTest = { stateText, API, NS }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-plugin-manager/src/client.js
