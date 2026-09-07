// dsh-session-time-bucket: node half.
//
// This plugin has NO host-side behaviour, on purpose. Grouping the sidebar's
// sessions by time bucket is a pure client concern: every fact (session list
// with updatedAt/blank/origin, workspace membership and the archive set) is
// already assembled in the core `sessions` and `workspaces` client services,
// opening a session is the core `sessions.open` verb, and creating one is
// `sessions.create`. Re-implementing any of it on the host would mean owning
// a session/workspace store for zero user-visible gain.
//
// The empty apply still has to exist: @deepseek-ai/dsh-client-modules scans the
// ENABLED Loader entries to discover web `dsh.client` packages, so a bundle with
// no node row never reaches the browser. This body is what makes the plugin a
// Loader entry; the real work ships through exports["./client"] discovered via
// the package.json `dsh.client` declaration.
// (Same shape as dsh-composer-history-recall.)
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

const name = 'session-time-bucket'

/** No services are required on the host: this half contributes nothing. */
const inject = []

/** Host plugin body — no host-side behaviour for this surface plugin. */
function apply() {}

export { apply, inject, name }
