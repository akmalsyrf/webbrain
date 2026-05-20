/**
 * Credential-field detection — pure ESM, no DOM.
 *
 * After set_field fills a field, agent.js asks this module whether the field
 * was a credential/secret input. If yes, agent.js appends CREDENTIAL_NOTE to
 * the tool result so the model is reminded — at the moment of relevance —
 * not to quote the value back in any subsequent assistant text, tool args,
 * or `done` summaries.
 *
 * The content-script side (chrome/firefox content.js) collects the field's
 * attributes into a plain object and ships them along with the tool result.
 * Detection runs background-side so the regex lives in exactly ONE place
 * and the test runner can exercise it without a DOM.
 *
 * Triggers (any one matches → sensitive):
 *   1. <input type="password">
 *   2. autocomplete: current-password | new-password | one-time-code
 *   3. name / id / aria-label / placeholder / associated <label> text
 *      matches SENSITIVE_NAME_RE
 *
 * The regex deliberately stays narrow. "auth", "auto", "key" alone are too
 * common (author, autocomplete, keyboard). We require credential-specific
 * vocab — password / secret / token / api-key / otp / etc.
 *
 * Cost asymmetry: a false positive appends one harmless sentence to a tool
 * result. A false negative ends up in a `done` summary the user pastes
 * somewhere. We tune for recall over precision.
 */

// Separator class: hyphen, underscore, or whitespace. Field names in
// attributes use - or _; aria-label / placeholder / <label> text often use
// human spaces ("API key", "One-time password"). All three must hit.
export const SENSITIVE_NAME_RE = /pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code/i;

export const SENSITIVE_AUTOCOMPLETE_RE = /^(current-password|new-password|one-time-code)$/i;

export const CREDENTIAL_NOTE = "You just filled a sensitive field (password / API key / token / OTP / similar). Do NOT quote this value in any subsequent assistant text, tool-call arguments, or `done` summaries — including when summarizing what you did. Refer to it generically: 'the password', 'the provided API key', 'the OTP', 'the credential the user gave'. This applies even though the user may have typed the value directly into the chat.";

/**
 * @param {{tag?:string, type?:string, name?:string, id?:string,
 *          autocomplete?:string, ariaLabel?:string, placeholder?:string,
 *          labelText?:string}} meta
 * @returns {{sensitive: boolean, reason: string|null}}
 */
export function isCredentialField(meta) {
  if (!meta || typeof meta !== 'object') return { sensitive: false, reason: null };

  const type = String(meta.type || '').toLowerCase();
  if (type === 'password') return { sensitive: true, reason: 'input type=password' };

  const ac = String(meta.autocomplete || '').trim();
  if (ac && SENSITIVE_AUTOCOMPLETE_RE.test(ac)) {
    return { sensitive: true, reason: `autocomplete=${ac}` };
  }

  for (const key of ['name', 'id', 'ariaLabel', 'placeholder', 'labelText']) {
    const v = meta[key];
    if (v && SENSITIVE_NAME_RE.test(String(v))) {
      return { sensitive: true, reason: `${key} matches credential pattern: ${JSON.stringify(String(v).slice(0, 60))}` };
    }
  }

  return { sensitive: false, reason: null };
}
