// dsh-open-session-workdir: node half.
//
// This plugin has NO host-side behaviour, on purpose. Opening a path on the
// desktop is already a core capability: `session.openWorkspacePath` (declared
// in @deepseek-ai/dsh-api-session-controller) hands the path to `openNativePath`,
// which runs a shell-free `powershell.exe -Command Invoke-Item -LiteralPath …`
// on Windows, `open` on macOS, `wslpath` + `Invoke-Item` under WSL and
// `xdg-open` on a desktop Linux. Re-implementing that here would mean owning a
// new host endpoint, an arbitrary-path allowlist and explorer.exe's
// always-exit-1 quirk for zero user-visible gain.
//
// The empty apply still has to exist: @deepseek-ai/dsh-client-modules scans the
// ENABLED Loader entries to discover web `dsh.client` packages, so a bundle with
// no node row never reaches the browser. This body is what makes the plugin a
// Loader entry; the real work ships through exports["./client"] discovered via
// the package.json `dsh.client` declaration.
// (Same shape as @deepseek-ai/dsh-client-ui-directory-picker-browse.)
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

const name = 'open-session-workdir'

/** No services are required on the host: this half contributes nothing. */
const inject = []

/** Host plugin body — no host-side behaviour for this surface plugin. */
function apply() {}

export { apply, inject, name }
