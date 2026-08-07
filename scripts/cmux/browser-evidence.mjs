// The diagnostic-only browser-console-error reducer for browser-verify
// (be-12-03, issue #12/D5, ADR-019). This module MUST NOT import anything
// from this repo, and no decision module (ladder.mjs, triage.mjs,
// contract.mjs) may import this module — the separation is structural, not
// a comment, enforcing conventions.md's "every family of task-controlled
// bytes gets its own import-firewalled reducer module". Raw browser-console
// output is task-controlled, page-authored text — it can carry another
// role's transcript fragment, a secret a previewed dev app printed, or a
// prompt-injection payload aimed at an orchestrator's transcript — this
// module reduces it to a closed-enum, non-substring summary and NEVER
// returns, logs, or persists the raw text itself.
//
// Zero dependencies, zero imports. ESM, Node 20 floor.

// The one frozen live capture (cmux 0.64.22) `browser errors list` prints on
// a clean console. Trimmed EQUALITY against this literal is the only path to
// shape:'clean' — never `includes()` (a page-authored line that merely
// CONTAINS this literal as a substring is not equal to it and must be
// unrecognized, never clean).
export const BROWSER_ERRORS_CLEAN_LINE = 'No browser errors'

// Matches ONE console-error line, tested per-line (multiline mode) so the
// count is the number of matching LINES, never `split('\n').length` (which
// would count every line, blank ones included, and is a killed degenerate).
const ERROR_LINE_RE = /^\[error\]/m

/**
 * reduceBrowserErrors(raw) -> { clean: boolean, count: number|null, shape: 'clean'|'errors'|'unrecognized' }
 * The ONLY export a caller needs. `raw` is `browserErrorsList`'s return
 * (string|null) — the sole legal producer of this function's input.
 * Reduces it to exactly three closed shapes:
 *   - trimmed raw === BROWSER_ERRORS_CLEAN_LINE -> {clean:true, count:0, shape:'clean'}
 *   - >=1 line matching /^\[error\]/ -> {clean:false, count:<matching lines>, shape:'errors'}
 *     NOTE (deliberate residual): `count` is page-influenced — the previewed
 *     app's own console output decides how many lines match — but only as a
 *     MAGNITUDE (a number), never as text; no character of the page's error
 *     content ever survives into this or any other returned field.
 *   - anything else (including '', whitespace-only, null, non-string, and a
 *     raw `Error: js_error: ...` payload) -> {clean:false, count:null,
 *     shape:'unrecognized'} — FAILS TOWARD NOT CLEAN, never toward clean.
 * NEVER returns, logs, or persists the raw text itself, in any form —
 * every field returned is a boolean, a number, or a member of the closed
 * `shape` enum. NEVER throws: any input type reduces to one of the three
 * shapes above.
 */
export function reduceBrowserErrors(raw) {
  if (typeof raw !== 'string') {
    return { clean: false, count: null, shape: 'unrecognized' }
  }
  const trimmed = raw.trim()
  if (trimmed === BROWSER_ERRORS_CLEAN_LINE) {
    return { clean: true, count: 0, shape: 'clean' }
  }
  const matches = raw.match(new RegExp(ERROR_LINE_RE, 'gm'))
  if (matches && matches.length > 0) {
    return { clean: false, count: matches.length, shape: 'errors' }
  }
  return { clean: false, count: null, shape: 'unrecognized' }
}
