// The diagnostic-only screen-signature detector for automated stall triage
// (be-11-03). This module MUST NOT import ladder.mjs and ladder.mjs MUST NOT
// import this module — the separation is structural, not a comment,
// enforcing conventions.md's "control plane and data plane are separate
// channels: read-screen output is never a decision input". A raw terminal
// frame is more disclosive than a dispatch record (it can carry another
// role's transcript or any secret a pane printed) — this module reduces a
// frame to a closed-enum, non-substring summary and NEVER returns, logs, or
// persists the raw text itself.
//
// Zero dependencies beyond node:crypto. ESM, Node 20 floor.
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// SIGNATURES — the closed, source-visible enum. Each entry's `pattern` is
// tested against the WHOLE frame (never captured, never substring-extracted
// into the result) and each carries an `evidence` field naming the live
// capture that backs it. None of these three has been live-verified against
// a real cmux pane in this slice's own QA gate — they are explicitly marked
// UNVERIFIED rather than fabricating a false live-capture claim ("ship only
// patterns you can live-verify; omit or explicitly mark the rest"). A future
// slice with a real capture should replace the `evidence` string for the
// signature it verifies, not add a new signature id.
// ---------------------------------------------------------------------------
export const SIGNATURES = Object.freeze([
  {
    id: 'permission_prompt',
    pattern: /do you want to (proceed|allow)|permission to (use|run)/i,
    evidence: 'NOT LIVE-VERIFIED — heuristic pending a live capture of a claude permission prompt inside a cmux pane',
  },
  {
    id: 'kickoff_never_submitted',
    pattern: /^\s*>\s*$/m,
    evidence: 'NOT LIVE-VERIFIED — heuristic (an empty claude prompt line) pending a live capture of a stalled, never-submitted kickoff',
  },
  {
    id: 'trust_dialog',
    pattern: /do you trust the (files|folder) in this (folder|directory)/i,
    evidence: 'NOT LIVE-VERIFIED — heuristic pending a live capture of claude\'s first-run trust dialog inside a cmux pane',
  },
])

/**
 * detectSignatures(frameText) -> { lines: number, last_line_sha256: string, matched: string[] }
 * The ONLY export a caller needs for triage. Reduces frameText to:
 *   - lines: the line count (frameText.split('\n').length)
 *   - last_line_sha256: sha256 hex of the last line, never the line itself
 *   - matched: signature ids (from the closed SIGNATURES enum above) whose
 *     pattern tested true against the WHOLE frame
 * Never returns a captured group, a substring, or the frame itself in any
 * form — the caller (dispatch.mjs) must never place this return value's
 * fields anywhere but a log line; it is diagnostic-only and can never reach
 * classify(). NEVER throws: a non-string input reduces to an empty-frame
 * result with lines: 0.
 */
export function detectSignatures(frameText) {
  const text = typeof frameText === 'string' ? frameText : ''
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const lastLine = text.length === 0 ? '' : text.split('\n').slice(-1)[0]
  const lastLineSha256 = createHash('sha256').update(lastLine, 'utf8').digest('hex')
  const matched = SIGNATURES.filter((sig) => sig.pattern.test(text)).map((sig) => sig.id)
  return { lines, last_line_sha256: lastLineSha256, matched }
}

// QA-fix round 2 cleanup: a SIGNATURE_IDS export existed here but was never
// imported anywhere (every consumer, including the vacuity-guard test,
// reads `.id` off SIGNATURES directly) — dropped rather than kept as dead
// surface area. `SIGNATURES.map((s) => s.id)` is the one-line equivalent
// for any future caller that wants just the ids.
