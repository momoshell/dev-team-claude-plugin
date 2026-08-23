// scripts/factory/transcript.mjs — the import-firewalled transcript reducer
// for issue #41 (SF-2, epic #39). THIS IS THE THIRD INSTANCE of the
// import-firewalled-reducer pattern in this repo, established by the
// retired legacy runtime's triage/browser-evidence reducers (conventions.md
// 2026-08-07): this module imports NOTHING from this repo (node builtins
// only) and is imported by NO decision module (crew/drive.mjs,
// crew/crew.mjs in the crew era) — asserted in BOTH
// directions by test/factory-transcript.test.mjs's source-text tests. The
// production caller is crew/seat-io.mjs; the decision plane (crew/drive.mjs,
// crew/crew.mjs) still does not import this reducer.
//
// WHY THIS EXISTS. Panes run `claude` INTERACTIVELY with stdio:'inherit'
// (the retired adapter, see git history) and `--output-format stream-json` is
// print-mode-only — so the worker's own Claude transcript JSONL is the ONLY
// usage surface available in cmux mode. This module reduces that transcript
// to three closed shapes: a resolution result, a token-usage split, and a
// list of back-fillable tool-call tuples. It never returns free prose, never
// forwards an unrecognized shape as if it were safe, and never writes
// anything — it only reads files and returns plain objects.
//
// TRUST FRAMING, HONESTLY STATED (borrowed verbatim in spirit from
// scripts/task-cost-log.mjs:64-67, which states the same posture about
// itself): a same-uid, Bash-capable worker can append fabricated
// assistant-shaped lines to its OWN transcript, whose path it can derive.
// What the exactly-one-match resolution rule below buys is that ambiguity
// degrades to DENIAL (no row), never to a forged row silently replacing a
// real one. This is a cost/usage mirror, never an audit trail.
//
// THE DEDUPE TRAP (issue #56, deliberately reproduced here as the thing NOT
// to do): Claude Code writes one assistant message as several JSONL lines
// (one per content block — thinking/tool_use/text), each repeating the same
// `message.id`, each carrying a `usage` block whose `output_tokens` EVOLVES
// mid-stream (live capture: three consecutive lines, one message id,
// output_tokens 5 -> 5 -> 400 for the one billed call). Summing every line
// over-counts (410 instead of 400) — that is issue #56's bug. This module
// dedupes by `message.id` (LAST occurrence in file order wins) BEFORE
// summing, exactly as scripts/task-cost-log.mjs:139-159 does. Do not
// "improve" the key to `requestId`.
//
// RESOLUTION NEVER DERIVES THE DASH-ENCODING: exactly like
// scripts/task-cost-log.mjs:109-129's findTranscript, resolution is a plain
// filename scan for `<id>.jsonl` across every directory under the projects
// dir — the dash-encoding of a cwd into a project-dir name is undocumented
// and CLI-version-dependent, and is never derived, only ever discovered by
// scanning.
//
// SUBAGENT WALK (why the reducer walks <session-id>/subagents/*.jsonl): Claude
// stores Task-bearing child transcripts beside the parent session, and their
// usage is part of the seat's spend. The drift guard in
// test/factory-transcript.test.mjs now checks the tool census stays honest when
// the crew seat table changes; it no longer claims the reducer would
// under-count subagents.
//
// Zero repo dependencies. ESM, Node 20 floor (this module uses no
// floor-gated builtin, even though scripts/factory/* as a family sits on
// the Node >= 24 floor for other reasons).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// The closed set of tool names this reducer will forward verbatim. Anything
// not an exact member (including an ANSI-escape-laden, newline-laden, or
// 5000-char string) reduces to the literal 'other' — the raw name is never
// forwarded unguarded. Duplicated here rather than imported from
// any runtime tool list on purpose: importing it would
// breach the firewall (this module imports nothing from the repo).
// 'Task' and 'Agent' are included even though DISALLOWED_TOOLS
// forbade a legacy worker from ever calling them; planner/reviewer seats carry
// Task and their child transcripts are folded into the parent session. The
// drift guard keeps this census honest if the seat table changes: subagent calls
// must remain visible in this mirrored data as their own name, not laundered
// into the generic 'other' bucket alongside every other
// unknown tool.
export const KNOWN_TOOL_NAMES = Object.freeze([
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'BashOutput', 'KillShell',
  'Task', 'Agent',
])
const KNOWN_TOOL_NAME_SET = new Set(KNOWN_TOOL_NAMES)

function shapeToolName(name) {
  if (typeof name !== 'string') return 'other'
  return KNOWN_TOOL_NAME_SET.has(name) ? name : 'other'
}

function numOr0(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  // Clamp to a non-negative integer — a hostile transcript must never be
  // able to write a negative or fractional token count into the ledger.
  return Math.max(0, Math.trunc(n))
}

const BILLED_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
function hasBilledField(usage) { return BILLED_FIELDS.some((k) => typeof usage[k] === 'number' && Number.isFinite(usage[k])) }

// The exact shape ledger.mjs's isoMs() accepts (its own regex, duplicated
// here on purpose — importing it would breach the firewall). Anything that
// doesn't match degrades to null rather than forwarding a raw,
// worker-controlled string: recordEvent already defaults tool_call
// timestamps to now() when null, which is the safe degradation this module
// hands back.
const ISO_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function shapeTimestamp(value) {
  return typeof value === 'string' && ISO_MS_PATTERN.test(value) ? value : null
}

// dispatch_id's own schema shape (retired dispatch-record schema, git history),
// duplicated here on purpose for the same firewall reason as ISO_MS_PATTERN
// above. An id that doesn't match this shape is never used to build a
// filename or to appear in a log line.
const DISPATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Reads a transcript file into raw text lines. A missing or unreadable file
// reduces to an empty line list — never throws, never guesses at content.
// Module-private and unexported; called from exactly two sites in this file
// (readUsage, readToolCalls) — pinned by a call-site-count test in
// test/factory-transcript.test.mjs rather than assumed.
function readRawLines(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return []
  let raw
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n')
}

/**
 * resolveTranscript({record, projectsDir, stats}) -> {claude_session_id, transcript_path} | null
 * The exactly-one-match resolution rule (mirrors scripts/task-cost-log.mjs's
 * findTranscript, :109-129, with its throw-on-refusal posture converted to
 * null): scans every directory under `projectsDir` for a file literally
 * named `<record.dispatch_id>.jsonl` — NEVER derives the dash-encoding.
 *   - 0 matches -> null, `stats.resolution_missing` incremented (EXPECTED
 *     on early await ticks before the pane's own transcript file exists —
 *     deliberately NOT logged per call).
 *   - >1 matches -> null, `stats.resolution_ambiguous` incremented, plus
 *     exactly ONE stderr log line. Ambiguity degrades to denial, never to a
 *     guess.
 *   - exactly 1 match -> {claude_session_id, transcript_path}.
 * `stats` is an optional caller-owned accumulator object (the two counter
 * names are the be-41-01 sidecar's own field names) that this function
 * mutates in place; it is never written to a file here — persisting it is
 * the sidecar's job, not this reducer's.
 */
export function resolveTranscript({ record, projectsDir, stats = {} } = {}) {
  const rawId = record && typeof record.dispatch_id === 'string' ? record.dispatch_id : null
  // Shape-guard to the dispatch_id schema BEFORE it is ever used to build a
  // filename or appear in a log line — an id that doesn't match this shape
  // is treated exactly like a missing id, never scanned for.
  const id = rawId && DISPATCH_ID_PATTERN.test(rawId) ? rawId : null
  if (!id) {
    stats.resolution_missing = (stats.resolution_missing || 0) + 1
    return null
  }

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
    const candidate = join(projectsDir, dir, `${id}.jsonl`)
    // A single throwIfNoEntry:false stat call, not two separate syscalls —
    // this function's whole contract is "never throw, return null/skip on
    // any refusal," and a TOCTOU delete between an existsSync and a
    // statSync would otherwise throw ENOENT out of that contract.
    let st
    try {
      st = statSync(candidate, { throwIfNoEntry: false })
    } catch {
      st = null
    }
    if (st && st.isFile()) matches.push(candidate)
  }

  if (matches.length === 0) {
    stats.resolution_missing = (stats.resolution_missing || 0) + 1
    return null
  }
  if (matches.length > 1) {
    stats.resolution_ambiguous = (stats.resolution_ambiguous || 0) + 1
    // Log a count/fact, never the raw id — the id is worker-derived and
    // must never be interpolated into a log line unguarded.
    process.stderr.write(`transcript: ambiguous transcript resolution — ${matches.length} matches found\n`)
    return null
  }
  return { claude_session_id: id, transcript_path: matches[0] }
}

/**
 * readUsage({transcriptPath}) -> AgentUsage (C2, see interface_contract).
 * Dedupes assistant `message.usage` entries by `message.id` (LAST
 * occurrence in file order wins) BEFORE summing — see module header. A
 * missing file, an empty file, a truncated/non-JSON line, and an assistant
 * line whose message lacks a usable `usage`/`id` all degrade to a
 * well-formed zeroed result (never a throw, never a partial-credit guess);
 * `dropped_lines` counts the lines that could not be read as usage.
 */
export function readUsage({ transcriptPath } = {}) {
  const lines = readRawLines(transcriptPath)
  const messages = new Map()
  let lastId = null
  let droppedLines = 0
  let measured = false

  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      droppedLines += 1
      continue
    }
    if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') continue
    const message = entry.message
    const usage = message && typeof message === 'object' ? message.usage : null
    const id = message && typeof message.id === 'string' ? message.id : null
    if (!usage || typeof usage !== 'object' || !id) {
      droppedLines += 1
      continue
    }
    messages.set(id, usage)
    if (hasBilledField(usage)) measured = true
    lastId = id
  }

  let billedInput = 0
  let billedOutput = 0
  let billedCacheWrite = 0
  let billedCacheRead = 0
  for (const usage of messages.values()) {
    billedInput += numOr0(usage.input_tokens)
    billedOutput += numOr0(usage.output_tokens)
    billedCacheWrite += numOr0(usage.cache_creation_input_tokens)
    billedCacheRead += numOr0(usage.cache_read_input_tokens)
  }

  const lastUsage = lastId !== null ? messages.get(lastId) : null
  const contextTokens = lastUsage
    ? numOr0(lastUsage.input_tokens) + numOr0(lastUsage.cache_read_input_tokens) + numOr0(lastUsage.cache_creation_input_tokens)
    : 0

  return {
    billed_input_tokens: billedInput,
    billed_output_tokens: billedOutput,
    billed_cache_write_tokens: billedCacheWrite,
    billed_cache_read_tokens: billedCacheRead,
    // cache_read_input_tokens is deliberately EXCLUDED from raw_read_tokens
    // (interface_contract C2) — a cache read is not new context consumed.
    raw_read_tokens: billedInput + billedCacheWrite,
    raw_written_tokens: billedOutput,
    context_tokens: contextTokens,
    context_window: null, // U-4: no verified source in #41
    message_count: messages.size,
    dropped_lines: droppedLines,
    measured,
  }
}

function billedTotalsOf(usage) {
  return {
    billed_input_tokens: usage?.billed_input_tokens ?? 0,
    billed_output_tokens: usage?.billed_output_tokens ?? 0,
    billed_cache_write_tokens: usage?.billed_cache_write_tokens ?? 0,
    billed_cache_read_tokens: usage?.billed_cache_read_tokens ?? 0,
  }
}

export function readSessionUsage({ transcriptPath } = {}) {
  const parent = readUsage({ transcriptPath })
  const parentUsage = billedTotalsOf(parent)
  const subagentUsage = billedTotalsOf()
  let subagentPaths = []
  if (typeof transcriptPath === 'string' && transcriptPath !== '') {
    const subagentsDir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents')
    try {
      subagentPaths = readdirSync(subagentsDir, { withFileTypes: true })
        .filter((entry) => entry && typeof entry.name === 'string' && /^agent-.*\.jsonl$/.test(entry.name) && entry.isFile())
        .map((entry) => entry.name)
        .sort()
        .map((name) => join(subagentsDir, name))
    } catch {
      subagentPaths = []
    }
  }

  let messageCount = Number(parent.message_count) || 0
  let droppedLines = Number(parent.dropped_lines) || 0
  let measured = parent.measured === true
  for (const subagentPath of subagentPaths) {
    const usage = readUsage({ transcriptPath: subagentPath })
    subagentUsage.billed_input_tokens += usage.billed_input_tokens
    subagentUsage.billed_output_tokens += usage.billed_output_tokens
    subagentUsage.billed_cache_write_tokens += usage.billed_cache_write_tokens
    subagentUsage.billed_cache_read_tokens += usage.billed_cache_read_tokens
    messageCount += Number(usage.message_count) || 0
    droppedLines += Number(usage.dropped_lines) || 0
    measured = measured || usage.measured === true
  }

  return {
    billed_input_tokens: parentUsage.billed_input_tokens + subagentUsage.billed_input_tokens,
    billed_output_tokens: parentUsage.billed_output_tokens + subagentUsage.billed_output_tokens,
    billed_cache_write_tokens: parentUsage.billed_cache_write_tokens + subagentUsage.billed_cache_write_tokens,
    billed_cache_read_tokens: parentUsage.billed_cache_read_tokens + subagentUsage.billed_cache_read_tokens,
    raw_read_tokens: parent.raw_read_tokens,
    raw_written_tokens: parent.raw_written_tokens,
    context_tokens: parent.context_tokens,
    context_window: null,
    message_count: messageCount,
    dropped_lines: droppedLines,
    measured,
    subagent_files: subagentPaths.length,
    parent_usage: parentUsage,
    subagent_usage: subagentUsage,
  }
}

/**
 * readToolCalls({transcriptPath}) -> ToolCallTuple[] ({tool, ok, started_at,
 * ended_at}). Pairs each assistant `tool_use` content block with its
 * matching `tool_result` block (by id) to back-fill historical timestamps —
 * so a later recordEvent{tool_call} call can pass real times instead of
 * defaulting to now() (scripts/factory/ledger.mjs:809-810). `tool` is
 * shape-guarded to the closed KNOWN_TOOL_NAMES set (unrecognized -> 'other',
 * raw name never forwarded). `ok` is false for both a denied and a failed
 * call (U-3, deferred out of #41 — this module does not distinguish them).
 * A tool_use with no matching tool_result (e.g. a truncated transcript)
 * fails toward the unsafe reading: ok:false, ended_at: null.
 */
export function readToolCalls({ transcriptPath } = {}) {
  const lines = readRawLines(transcriptPath)
  const pending = new Map()
  const calls = []

  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const message = entry.message
    const content = message && Array.isArray(message.content) ? message.content : null
    if (!content) continue
    const timestamp = shapeTimestamp(entry.timestamp)

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          pending.set(block.id, { tool: shapeToolName(block.name), started_at: timestamp })
        }
      }
    } else if (entry.type === 'user') {
      for (const block of content) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const call = pending.get(block.tool_use_id)
          if (!call) continue
          pending.delete(block.tool_use_id)
          calls.push({
            tool: call.tool,
            ok: block.is_error !== true,
            started_at: call.started_at,
            ended_at: timestamp,
          })
        }
      }
    }
  }

  // Any tool_use left pending never saw a result — fail toward not-ok
  // rather than guessing success.
  for (const call of pending.values()) {
    calls.push({ tool: call.tool, ok: false, started_at: call.started_at, ended_at: null })
  }

  return calls
}
