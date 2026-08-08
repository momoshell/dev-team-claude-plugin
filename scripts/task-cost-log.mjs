#!/usr/bin/env node
// scripts/task-cost-log.mjs — per-TASK cost ledger: orchestrator window +
// every subagent sidecar transcript, appended as one JSON line per task to
// a global, cross-repo log at ~/.claude/dev-team/task-cost/log.jsonl.
//
// WHY THIS DIFFERS FROM scripts/task-cost.mjs's STATUSLINE FIGURE (do not
// conflate the two — see README § Per-task cost):
//   - the statusline mirrors Claude Code's own built-in `$` figure: main
//     window only, no subagent cost, no de-duplication across the multiple
//     JSONL lines a single streamed message is written as (a pre-existing,
//     user-visible, and already-flagged divergence — see task-cost.mjs's
//     costSince header comment and GitHub issue #56). It reads a live
//     statusLine JSON payload from stdin.
//   - this ledger sums the orchestrator's own transcript AND every
//     subagent's sidecar transcript, de-duplicating by message id (see THE
//     CORRECTNESS TRAP below) before pricing. It is invoked explicitly as
//     a step in commands/ship.md — never wired to any statusLine.
//
// PLATFORM FACTS — undocumented, CLI-version-dependent, verified against
// the installed Claude Code CLI (v2.1.220-2.1.224) by direct file
// inspection (be-13-c1 discovery_context). Treat as given, not re-derived:
//   - CLAUDE_CODE_SESSION_ID is a first-class env var, readable at any time.
//   - the orchestrator's own transcript lives at
//       ~/.claude/projects/<dash-encoded-cwd>/<session-id>.jsonl
//     Subagent turns are NOT inline in it — they live as sidecar files at
//       ~/.claude/projects/<dash-encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl
//     (+ a companion agent-<id>.meta.json this module never reads). The
//     dash-encoding of cwd is undocumented and is NOT re-derived here — the
//     transcript is located by SCANNING every dir under ~/.claude/projects
//     for a `<session-id>.jsonl`. Session ids are UUIDs: exactly one match
//     is the expected/only accepted case; zero or more than one is a
//     refusal (exit 2), never an mtime-sorted guess.
//   - sidecar entries carry the SAME {type:'assistant', message:{id, model,
//     usage}} shape as main-transcript entries, except `isSidechain` is
//     true. task-cost.mjs's costSince filters on `isSidechain !== false` —
//     that filter is NOT reused here (see collectEntries): applying it to
//     the sidecar walk would silently drop every subagent message.
//
// THE CORRECTNESS TRAP — ONE MESSAGE, MULTIPLE JSONL LINES: a single
// assistant message is written as one JSONL line per content block
// (thinking / tool_use / text), each line repeating the same `message.id`
// and `requestId`, with `usage.output_tokens` EVOLVING across the lines as
// the stream progresses (confirmed real capture: output_tokens 5, 5, then
// 400 across three lines sharing one message id and requestId). The same
// requestId is one billed API call, so summing every line over-counts.
// This module de-duplicates by `message.id` across the orchestrator
// transcript AND every sidecar in a single pass — LAST occurrence in file
// order wins (the final, complete usage) — and attributes each surviving
// message to the file its last occurrence came from; that attribution is
// what splits orchestrator_usd from subagent_usd. Entries lacking a
// `message.id` key on `${file}#${lineIndex}` so they never collide with a
// real id or with each other.
//
// FAIL-SOFT vs REFUSE, DELIBERATELY ASYMMETRIC: the orchestrator transcript
// is a documented, resolvable fact (a session id maps to exactly one file)
// — locating it is not optional, so a miss REFUSES (exit 2) rather than
// guessing (per conventions.md: "on ambiguity abort rather than guess").
// The subagents/ sidecar directory is an undocumented, CLI-version-
// dependent implementation detail — a missing/unreadable sidecar dir
// degrades to orchestrator-only cost (`subagent_cost_unavailable: true`,
// exit 0) rather than crashing `/dev-team:ship`. A sidecar dir that EXISTS
// but holds no *.jsonl is a genuine zero, not "unavailable".
//
// tier, gate_depth and task are ORCHESTRATOR-SELF-REPORTED and UNAUDITED —
// nothing in this module verifies them against any external source. See
// the frozen `unverified` array in every record: this is a cost ledger,
// never an audit trail.
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PRICING, priceFor, readStateSince, costOfUsage } from './task-cost.mjs'

export { PRICING, priceFor }

// A refusal cause, tagged so main's catch can map it to exit 2 with a named
// `reason` without conflating it with an unexpected internal throw.
class UsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message)
    this.reason = reason
  }
}

function refuse(message, reason = 'usage') {
  throw new UsageError(`task-cost-log: ${message}`, reason)
}

function parseArgs(argv) {
  let sessionId = null
  let cwd = process.cwd()
  let tier = null
  let gateDepth = null
  let task = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session-id') sessionId = argv[++i]
    else if (a === '--cwd') cwd = argv[++i]
    else if (a === '--tier') tier = argv[++i]
    else if (a === '--gate-depth') gateDepth = argv[++i]
    else if (a === '--task') task = argv[++i]
    else refuse(`unexpected argument: ${a}`)
  }
  return { sessionId, cwd, tier, gateDepth, task }
}

// Scan every project dir for a `<session-id>.jsonl` — never derive the
// dash-encoding (see module header). Exactly one match is the answer.
function findTranscript(projectsDir, sessionId) {
  let projectDirs
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    projectDirs = []
  }
  const matches = []
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate) && statSync(candidate).isFile()) matches.push(candidate)
  }
  if (matches.length === 0) {
    refuse(`no transcript found for session ${sessionId} under ${projectsDir}`, 'transcript_not_found')
  }
  if (matches.length > 1) {
    refuse(`ambiguous transcript for session ${sessionId} — found at: ${matches.join(', ')}`, 'ambiguous_session_transcript')
  }
  return matches[0]
}

// Reads one transcript file (main or sidecar) into the shared `messages`
// map, keyed by message.id (last occurrence in file order wins) or by
// `${source}#${lineIndex}` for id-less entries. Deliberately does NOT
// filter on `isSidechain` — see module header (THE CORRECTNESS TRAP /
// PLATFORM FACTS): sidecar entries are all isSidechain:true and must still
// be counted. Missing/unparsable files and lines are skipped, never fatal —
// consistent with task-cost.mjs's costSince tolerance for malformed input.
function collectEntries(filePath, sinceISO, messages, source) {
  if (!existsSync(filePath)) return
  const lines = readFileSync(filePath, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!line) return
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (entry.type !== 'assistant') return
    if (sinceISO && (typeof entry.timestamp !== 'string' || entry.timestamp < sinceISO)) return
    const usage = entry.message?.usage
    const model = entry.message?.model
    if (!usage || !model) return
    const id = entry.message?.id
    const key = typeof id === 'string' && id ? id : `${source}#${i}`
    messages.set(key, { model, usage, timestamp: entry.timestamp || '', source })
  })
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

// taskCostRecord(opts) -> record. Pure with respect to process state (no
// stdout/stderr, no process.exit) — I/O is limited to reading the resolved
// transcript files. Throws UsageError for the two refusal causes
// (session_id_unavailable, transcript_not_found, ambiguous_session_transcript);
// never throws for a missing/unreadable subagents dir (fails soft instead).
export function taskCostRecord({
  sessionId = null,
  cwd = process.cwd(),
  home = homedir(),
  now = new Date(),
  tier = null,
  gateDepth = null,
  task = null,
} = {}) {
  const resolvedSessionId = sessionId || process.env.CLAUDE_CODE_SESSION_ID || null
  if (!resolvedSessionId) {
    refuse('no session id — pass --session-id or set CLAUDE_CODE_SESSION_ID', 'session_id_unavailable')
  }

  const projectsDir = join(home, '.claude', 'projects')
  const transcriptPath = findTranscript(projectsDir, resolvedSessionId)
  const since = readStateSince(resolvedSessionId, home)

  const messages = new Map()
  collectEntries(transcriptPath, since, messages, 'orchestrator')

  const subagentsDir = join(dirname(transcriptPath), resolvedSessionId, 'subagents')
  let subagentCostUnavailable = false
  let subagentFiles = []
  try {
    subagentFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    subagentCostUnavailable = true
  }
  for (const f of subagentFiles) {
    collectEntries(join(subagentsDir, f), since, messages, f)
  }

  let orchestratorUsd = 0
  let subagentUsd = 0
  let unpricedMessages = 0
  const pricedSubagentFiles = new Set()
  for (const entry of messages.values()) {
    const price = priceFor(entry.model, entry.timestamp)
    if (!price) {
      unpricedMessages += 1
      continue
    }
    const cost = costOfUsage(entry.usage, price) / 1_000_000
    if (entry.source === 'orchestrator') {
      orchestratorUsd += cost
    } else {
      subagentUsd += cost
      pricedSubagentFiles.add(entry.source)
    }
  }

  const orchestratorRounded = round4(orchestratorUsd)
  const subagentRounded = round4(subagentUsd)

  return {
    schema: 1,
    ts: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    session_id: resolvedSessionId,
    cwd,
    task,
    tier,
    gate_depth: gateDepth,
    since,
    orchestrator_usd: orchestratorRounded,
    subagent_usd: subagentRounded,
    total_usd: round4(orchestratorRounded + subagentRounded),
    subagent_count: pricedSubagentFiles.size,
    subagent_cost_unavailable: subagentCostUnavailable,
    unpriced_messages: unpricedMessages,
    unverified: ['task', 'tier', 'gate_depth'],
  }
}

// appendTaskCost(record) -> logPath. Append-only: mkdir -p then a single
// appendFileSync of one line + '\n'. No tmp+rename here — that idiom
// protects exclusive-create/UI-backing files elsewhere in this repo; a
// rename would clobber this log's prior lines. One write per run, no
// read-modify-write, so there is no TOCTOU window to guard.
export function appendTaskCost(record, { home = homedir() } = {}) {
  const dir = join(home, '.claude', 'dev-team', 'task-cost')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'log.jsonl')
  appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  return logPath
}

// main(argv) -> exit code (0 appended, 2 refusal). argv excludes 'node' and
// the script path. Never calls process.exit itself — safe to call
// in-process as well as from the invokedDirectly block below.
export function main(argv) {
  try {
    const { sessionId, cwd, tier, gateDepth, task } = parseArgs(argv)
    const record = taskCostRecord({ sessionId, cwd, tier, gateDepth, task })
    const logPath = appendTaskCost(record)
    const unavailableSuffix = record.subagent_cost_unavailable ? ' [subagent cost unavailable]' : ''
    process.stdout.write(
      `task-cost: $${record.total_usd.toFixed(2)} total ($${record.orchestrator_usd.toFixed(2)} orchestrator + $${record.subagent_usd.toFixed(2)} across ${record.subagent_count} subagents) -> ${logPath}${unavailableSuffix}\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
    } else {
      process.stderr.write(`${err.stack}\n`)
    }
    return 2
  }
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
  // process.exitCode, not process.exit: consistent with this repo's other
  // libraryized CLIs (scripts/spec-lint.mjs, scripts/task-cost.mjs).
  process.exitCode = main(process.argv.slice(2))
}
