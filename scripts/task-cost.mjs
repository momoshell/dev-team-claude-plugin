#!/usr/bin/env node
// Per-task cost readout for a custom Claude Code statusLine.
//
// Claude Code's own $ figure (cost.total_cost_usd, and the bottom-bar $
// shown by default) is scoped to the whole terminal session — it does not
// reset on /clear, only on relaunch (see README § Per-task cost). This
// script computes cost since the *last* /clear instead, by summing the main
// transcript's own token usage (not subagents — same scope as the built-in
// figure) from the timestamp a companion SessionStart(matcher:"clear") hook
// records, to now.
//
// Wire-up: this is not auto-installed — add it to your own `statusLine`
// command in settings.json. See README § Per-task cost for the hook entry
// and an example statusLine script.
//
// usage: node task-cost.mjs   (reads the statusline JSON payload on stdin,
//                              per https://code.claude.com/docs/en/statusline)
// Prints a bare "$X.XX" to stdout. Prints nothing and exits 0 on any
// missing/unreadable input — a broken cost readout should never blank a
// user's statusline.
//
// Library surface (consumed by scripts/task-cost-log.mjs, which needs the
// SAME pricing table and per-entry arithmetic for a separate, wider-scope
// ledger — see that file's header for why the two figures deliberately
// differ): PRICING, priceFor, readStateSince, costOfUsage, costSince are all
// pure exports; importing this module performs no I/O and never reads
// stdin. main() is the CLI body, run only when this file is invoked
// directly (see the invokedDirectly guard at the bottom) — statusline
// behaviour is byte-identical to before this file was libraryized.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// $/MTok. Multipliers for cache write (5m = 1.25x, 1h = 2x) and cache read
// (0.1x) are applied to the base input price, per shared/prompt-caching.md.
export const PRICING = {
  'claude-opus-4-8': { in: 5.00, out: 25.00 },
  'claude-opus-4-7': { in: 5.00, out: 25.00 },
  'claude-opus-4-6': { in: 5.00, out: 25.00 },
  'claude-sonnet-5': { in: 3.00, out: 15.00, introUntil: '2026-09-01T00:00:00Z', introIn: 2.00, introOut: 10.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
  'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00 },
  'claude-fable-5': { in: 10.00, out: 50.00 },
  'claude-mythos-5': { in: 10.00, out: 50.00 },
}

export function priceFor(model, atISO) {
  const p = PRICING[model]
  if (!p) return null
  if (p.introUntil && atISO < p.introUntil) return { in: p.introIn, out: p.introOut }
  return { in: p.in, out: p.out }
}

// home defaults to the real homedir (which honours $HOME on POSIX) but is
// overridable so a caller with an already-resolved home (e.g.
// task-cost-log.mjs's taskCostRecord) doesn't have to fight process.env.
export function readStateSince(sessionId, home = homedir()) {
  const stateFile = join(home, '.claude', 'dev-team', 'task-cost', `${sessionId}.json`)
  if (!existsSync(stateFile)) return null
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    return typeof state.since === 'string' ? state.since : null
  } catch {
    return null
  }
}

// The per-entry arithmetic, extracted so task-cost-log.mjs's subagent-
// inclusive walk can share it rather than re-deriving the cache-tier
// multipliers (5m write = 1.25x, 1h write = 2x, cache read = 0.1x input) in
// a second copy that could drift. Returns raw dollars (not yet /1_000_000
// token-scaled) exactly as the original inline computation did.
export function costOfUsage(usage, price) {
  const cacheCreation = usage.cache_creation || {}
  const write5m = cacheCreation.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0
  const write1h = cacheCreation.ephemeral_1h_input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  return (
    (usage.input_tokens ?? 0) * price.in +
    (usage.output_tokens ?? 0) * price.out +
    write5m * price.in * 1.25 +
    write1h * price.in * 2 +
    read * price.in * 0.1
  )
}

// costSince intentionally does NOT de-duplicate by message.id, even though
// a single assistant message is written as multiple JSONL lines (one per
// content block, each with an evolving `usage.output_tokens`) — see
// scripts/task-cost-log.mjs's header for the confirmed shape. That means
// this statusline figure over-counts relative to the true billed cost.
// This is a pre-existing, user-visible, and already-flagged divergence
// (see GitHub issue #56) — NOT something to silently "fix" here; doing so
// would change a user-visible number outside this task's scope. The
// `entry.isSidechain !== false` filter below is similarly left exactly as
// shipped: it scopes this readout to Claude Code's own built-in `$` figure
// (main window only) and is a no-op in practice today, since nothing in a
// main transcript is ever isSidechain:true.
export function costSince(transcriptPath, sinceISO) {
  if (!existsSync(transcriptPath)) return null
  let total = 0
  const lines = readFileSync(transcriptPath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain !== false) continue
    if (sinceISO && (typeof entry.timestamp !== 'string' || entry.timestamp < sinceISO)) continue
    const usage = entry.message?.usage
    const model = entry.message?.model
    if (!usage || !model) continue
    const price = priceFor(model, entry.timestamp || '')
    if (!price) continue
    total += costOfUsage(usage, price) / 1_000_000
  }
  return total
}

// main() -> exit code. Reads the statusline JSON payload from stdin (fd 0)
// and writes a bare "$X.XX" to stdout on success. Never throws for a
// missing/unreadable input — a broken cost readout should never blank a
// user's statusline. Only called from the invokedDirectly guard below, so
// a bare `import` of this module never touches stdin.
export function main() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return 0
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return 0
  }

  const sessionId = payload.session_id
  const transcriptPath = payload.transcript_path
  if (!sessionId || !transcriptPath) return 0

  const since = readStateSince(sessionId)
  const total = costSince(transcriptPath, since)
  if (total === null) return 0

  process.stdout.write(`$${total.toFixed(2)}`)
  return 0
}

// realpath both sides: the ESM loader realpaths import.meta.url while
// argv[1] stays literal, so under a symlinked path component (macOS TMPDIR
// is /var -> /private/var) a literal compare is silently false and the CLI
// would no-op. Mirrors scripts/spec-lint.mjs's realpathOr.
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // process.exitCode, not process.exit: consistent with the rest of this
  // repo's libraryized CLIs (see scripts/spec-lint.mjs) even though this
  // script's own I/O is synchronous and exits cleanly either way.
  process.exitCode = main()
}
