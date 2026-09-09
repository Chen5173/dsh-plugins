// dsh-plugin-manager: HOST-core — pure, side-effect-free logic.
//
// Everything that can be unit-tested lives here (repo scanning, stable-id row
// transforms on the profile patch list, per-plugin state derivation, migration
// planning, YAML-engine factories). src/index.js only wires this core to the
// DSH host (HTTP endpoints, pnpm spawning, file writes) — same split that kept
// esc-rewind's delete logic testable.
//
// ESM module format (cordis bundle rule): only src/index.js needs to be a
// valid plugin body; this file is imported by it and by the node tests.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// --- constants ---------------------------------------------------------------

/** This manager's own directory name (excluded from the managed set). */
export const MANAGER_DIR = 'dsh-plugin-manager'
/** Bundle id / row id / package name of the manager itself. */
export const MANAGER_ID = 'dsh-plugin-manager'
/** Target profile when nothing overrides it. */
export const DEFAULT_PROFILE = 'web'
/** Every local plugin folder in this monorepo starts with this prefix. */
export const PLUGIN_DIR_PREFIX = 'dsh-'
/** Profile devDependency the host needs for patch-file YAML round-trips. */
export const YAML_PKG = 'js-yaml'
export const YAML_PKG_RANGE = '^4.1.0'
/** HTTP endpoints namespace. */
export const HTTP_PREFIX = '/__dsh-plugin-manager'

// --- path helpers ------------------------------------------------------------

/** $DSH_HOME or ~/.dsh (mirrors @deepseek-ai/dsh-home-paths). */
export function dshHome(env = process.env) {
  const v = env && env.DSH_HOME
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  return path.join(os.homedir(), '.dsh')
}

export function profileDirOf(home, name = DEFAULT_PROFILE) {
  return path.join(home, 'profiles', name)
}

export function patchPathOf(home, name = DEFAULT_PROFILE) {
  return path.join(profileDirOf(home, name), 'cordis.patch.yml')
}

export function manifestPathOf(home, name = DEFAULT_PROFILE) {
  return path.join(profileDirOf(home, name), 'package.json')
}

/** <repo>/dsh-plugin-manager/src → <repo> (the scanned sibling root). */
export function repoRootOfPluginSrc(srcDir) {
  return path.resolve(srcDir, '..', '..')
}

/** Stable activation row id for a plugin dir: dir name minus the dsh- prefix. */
export function rowIdOfDir(dir) {
  return dir.startsWith(PLUGIN_DIR_PREFIX) ? dir.slice(PLUGIN_DIR_PREFIX.length) : dir
}

/** Absolute link: spec used in profile package.json (forward slashes). */
export function linkSpecOf(absDir) {
  return `link:${absDir.replace(/\\/g, '/')}`
}

// --- repo scanning -----------------------------------------------------------

/** dsh-* sibling directory names under the repo root (excludes the manager). */
export function listRepoPluginDirs(repoRoot) {
  let entries = []
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(PLUGIN_DIR_PREFIX) && e.name !== MANAGER_DIR)
    .map((e) => e.name)
    .sort()
}

/** Read one plugin's package.json metadata; invalid dirs are flagged, never throw. */
export function readPluginMeta(repoRoot, dir) {
  const dirPath = path.join(repoRoot, dir)
  const pkgPath = path.join(dirPath, 'package.json')
  const base = {
    dir,
    dirPath,
    rowId: rowIdOfDir(dir),
    name: dir,
    description: '',
    hasClient: false,
    hasHost: false,
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : dir
    const description = typeof pkg.description === 'string' ? pkg.description : ''
    const hasClient = Boolean(pkg.dsh && pkg.dsh.client) || Boolean(pkg.exports && pkg.exports['./client'])
    const hasHost = typeof pkg.main === 'string' || Boolean(pkg.exports && pkg.exports['.'])
    return { ...base, valid: true, name, description, hasClient, hasHost }
  } catch {
    return { ...base, valid: false, error: 'no-plugin-package' }
  }
}

// --- profile manifest / patch file IO ----------------------------------------

/** profile package.json → object (missing/unreadable → {}). */
export function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Build a YAML engine wrapper around the real js-yaml (mirrors
 * dsh-mcp-manager: JSON_SCHEMA extended with the `!!js` scalar type that maps
 * to/from `{ __jsExpr }`, whole-file dump with lineWidth 120).
 */
export function makeYamlEngine(jsyaml) {
  const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value
  const JsExprType = new jsyaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: isJsExpr,
    represent: (data) => data.__jsExpr,
  })
  const ENTRY_LIST_SCHEMA = jsyaml.JSON_SCHEMA.extend(JsExprType)
  return {
    loadText(text) {
      const parsed = jsyaml.load(text, { schema: ENTRY_LIST_SCHEMA })
      if (parsed === undefined || parsed === null) return []
      if (!Array.isArray(parsed)) throw new Error('patch file must be a top-level array')
      return parsed
    },
    dumpText(rows) {
      return rows.length > 0 ? jsyaml.dump(rows, { schema: ENTRY_LIST_SCHEMA, lineWidth: 120 }) : '[]\n'
    },
  }
}

/** Load profile cordis.patch.yml rows (missing file = []). Throws on bad YAML. */
export function readPatchRows(yaml, file) {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const trimmed = (text || '').trim()
  if (trimmed === '') return []
  return yaml.loadText(trimmed)
}

/** Persist rows back to the profile cordis.patch.yml (whole-file rewrite). */
export function writePatchRows(yaml, file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml.dumpText(rows), 'utf8')
}

// --- pure row transforms (rows = parsed patch list) --------------------------

/** Locate a row by id: plain override row (`row.id`) or insert item (`insert[].id`). */
export function findRow(rows, id) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.id === id) return { kind: 'row', row }
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((e) => e && e.id === id)
      if (item) return { kind: 'item', row, item }
    }
  }
  return null
}

function withDisabled(item, disabled) {
  const next = { ...item }
  if (disabled) next.disabled = true
  else delete next.disabled
  return next
}

/**
 * Ensure a managed plugin exists as an insert item with the given enabled
 * state. Canonical storage is one `- insert:` row per plugin with item fields
 * {id, name, disabled?}. A pre-existing plain override row for the id is
 * converted (it can no longer target a bundle row once children move to
 * devDependencies). Returns a NEW rows array; never mutates input.
 */
export function upsertManaged(rows, id, name, enabled) {
  const found = findRow(rows, id)
  if (!found) {
    const item = { id, name }
    if (!enabled) item.disabled = true
    return [...rows, { insert: [item] }]
  }
  if (found.kind === 'item') {
    const item = withDisabled({ ...found.item, name }, !enabled)
    return rows.map((row) =>
      row === found.row
        ? { ...row, insert: row.insert.map((e) => (e === found.item ? item : e)) }
        : row,
    )
  }
  // plain override row → replace with a canonical insert item
  const rest = rows.filter((row) => row !== found.row)
  const item = { id, name }
  if (!enabled) item.disabled = true
  return [...rest, { insert: [item] }]
}

/** Remove every occurrence of a managed id (insert items + plain override rows). */
export function removeManaged(rows, id) {
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      out.push(row)
      continue
    }
    if (row.id === id) continue
    if (Array.isArray(row.insert)) {
      const filtered = row.insert.filter((e) => !(e && e.id === id))
      if (filtered.length === 0) continue
      out.push({ ...row, insert: filtered })
      continue
    }
    out.push(row)
  }
  return out
}

/** Drop plain override rows (non-insert) whose id is in the given set. */
export function stripOverrideRows(rows, ids) {
  const set = new Set(ids)
  return rows.filter((row) => !(row && typeof row === 'object' && !Array.isArray(row.insert) && set.has(row.id)))
}

// --- state derivation --------------------------------------------------------

/**
 * Derive the per-plugin panel state from repo metadata + profile manifest +
 * current patch rows.
 *
 * Returns for each repo plugin: {dir,rowId,name,description,hasClient,valid,
 * error?, installed, installWhere:'dependencies'|'devDependencies'|null,
 * legacyBundle:boolean, hasRow, disabled, active, state}
 * state ∈ active | disabled | legacy | uninstalled | invalid
 */
export function deriveStates({ repoPlugins, manifest, rows }) {
  const deps = new Set(Object.keys(manifest.dependencies || {}))
  const devDeps = new Set(Object.keys(manifest.devDependencies || {}))
  const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const bundleSet = new Set(bundles)

  return repoPlugins.map((p) => {
    if (!p.valid) {
      return { ...p, installed: false, installWhere: null, legacyBundle: false, hasRow: false, disabled: false, active: false, state: 'invalid' }
    }
    const found = findRow(rows, p.rowId)
    const hasRow = Boolean(found)
    const disabled = hasRow
      ? found.kind === 'row'
        ? found.row.disabled === true
        : found.item.disabled === true
      : false
    const inDeps = deps.has(p.name)
    const inDevDeps = devDeps.has(p.name)
    const installed = inDeps || inDevDeps
    const legacyBundle = bundleSet.has(p.name)

    let state
    if (legacyBundle) state = installed ? 'legacy' : 'uninstalled'
    else if (hasRow && !disabled) state = installed ? 'active' : 'uninstalled'
    else if (hasRow && disabled) state = installed ? 'disabled' : 'uninstalled'
    else state = installed ? 'inactive' : 'uninstalled'

    return {
      ...p,
      installed,
      installWhere: inDeps ? 'dependencies' : inDevDeps ? 'devDependencies' : null,
      legacyBundle,
      hasRow,
      disabled,
      active: state === 'active' || (state === 'legacy' && !disabled),
      state,
    }
  })
}

// --- migration planning ------------------------------------------------------

/**
 * Plan the one-click takeover of the legacy layout. Pure: returns the complete
 * new documents + a change summary; nothing is written here.
 *
 * Legacy layout = local children present in profile `dependencies` and/or
 * `dsh.profile.bundles`. Target layout = children in `devDependencies` only,
 * bundles keep only the manager, and every previously-active child is
 * represented by a canonical (non-disabled) managed row.
 */
export function planMigration({ repoPlugins, manifest, rows, repoRoot, managerId = MANAGER_ID }) {
  const deps = { ...(manifest.dependencies || {}) }
  const devDeps = { ...(manifest.devDependencies || {}) }
  const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? [...manifest.dsh.profile.bundles]
    : []

  const moved = []
  const addedDev = []
  const removedBundles = []
  const originalRowsJson = JSON.stringify(rows)

  const valid = repoPlugins.filter((p) => p.valid)

  // For each valid repo plugin, migrate any legacy presence.
  for (const p of valid) {
    const found = findRow(rows, p.rowId)
    const rowDisabled = found
      ? found.kind === 'row'
        ? found.row.disabled === true
        : found.item.disabled === true
      : false
    const inBundles = bundles.includes(p.name)
    const inDeps = Object.prototype.hasOwnProperty.call(deps, p.name)
    const inDevDeps = Object.prototype.hasOwnProperty.call(devDeps, p.name)

    // Never installed (no bundle, no dependency, no row) → leave alone.
    if (!inBundles && !inDeps && !found) continue

    if (inDeps) {
      delete deps[p.name]
      moved.push(p.name)
      if (!inDevDeps) {
        devDeps[p.name] = linkSpecOf(path.join(repoRoot, p.dir))
        addedDev.push(p.name)
      }
    } else if (inBundles && !inDevDeps) {
      // bundle-only legacy presence without a dependency: link it as a devDep.
      devDeps[p.name] = linkSpecOf(path.join(repoRoot, p.dir))
      addedDev.push(p.name)
    }
    if (inBundles) {
      bundles.splice(bundles.indexOf(p.name), 1)
      removedBundles.push(p.name)
    }
    // Canonical row reflecting the previously-intended state (disabled stays
    // disabled; everything else becomes an enabled insert item).
    rows = upsertManaged(rows, p.rowId, p.name, !rowDisabled)
  }

  // Remove any stale plain-override rows targeting migrated children.
  rows = stripOverrideRows(rows, valid.map((p) => p.rowId))

  // Retire the old umbrella bundle if a profile still carries it.
  if (bundles.includes('dsh-local-plugins')) {
    bundles.splice(bundles.indexOf('dsh-local-plugins'), 1)
    removedBundles.push('dsh-local-plugins')
  }
  if (Object.prototype.hasOwnProperty.call(deps, 'dsh-local-plugins')) {
    delete deps['dsh-local-plugins']
    moved.push('dsh-local-plugins')
  }
  if (Object.prototype.hasOwnProperty.call(devDeps, 'dsh-local-plugins')) {
    delete devDeps['dsh-local-plugins']
  }

  // Ensure the manager itself is the only local bundle entry.
  if (!bundles.includes(managerId)) {
    bundles.push(managerId)
  }

  const newManifest = {
    ...manifest,
    dependencies: deps,
    devDependencies: devDeps,
    dsh: {
      ...(manifest.dsh || {}),
      profile: {
        ...((manifest.dsh && manifest.dsh.profile) || {}),
        bundles,
      },
    },
  }

  const manifestChanged = JSON.stringify(newManifest) !== JSON.stringify(manifest)
  const rowsChanged = JSON.stringify(rows) !== originalRowsJson
  const needsMigration = manifestChanged || rowsChanged
  return {
    needsMigration,
    newManifest,
    finalRows: rows,
    summary: { moved, addedDev, removedBundles, bundlesAfter: bundles },
  }
}
