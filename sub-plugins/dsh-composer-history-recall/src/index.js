// dsh-composer-history-recall: node half.
//
// This plugin has NO host-side behaviour, on purpose. Recalling a session's
// own sent messages is a pure client concern: the message list is already
// assembled client-side (useConversation -> the 'chat' view), and writing text
// back into the composer is the core `inputActions.setDraft` verb. Re-implementing
// either here would mean owning a host endpoint and a message store for zero
// user-visible gain.
//
// The empty apply still has to exist: @deepseek-ai/dsh-client-modules scans the
// ENABLED Loader entries to discover web `dsh.client` packages, so a bundle with
// no node row never reaches the browser. This body is what makes the plugin a
// Loader entry; the real work ships through exports["./client"] discovered via
// the package.json `dsh.client` declaration.
// (Same shape as dsh-open-session-workdir.)
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

const name = 'composer-history-recall'

/** No services are required on the host: this half contributes nothing. */
const inject = []

/** Host plugin body — no host-side behaviour for this surface plugin. */
function apply() {}

export { apply, inject, name }
