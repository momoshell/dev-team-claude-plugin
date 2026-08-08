#!/usr/bin/env node
// The cmux dispatcher CLI: wires resolve.mjs (paths/roster), record.mjs
// (dispatch-record lifecycle), cmuxctl.mjs (the cmux boundary), ladder.mjs
// (evidence/outcome) and browser-evidence.mjs (browser-console reduction)
// into the verbs COMMANDS holds (named with no fixed count here, so this
// header can't go stale again — see COMMANDS below for the closed set).
// This is the ONLY file in the repo that spawns processes, touches git, or
// measures wall-clock time.
//
// usage:
//   node dispatch.mjs preflight      --task <slug> [--force]
//   node dispatch.mjs workspace      --task <slug>
//   node dispatch.mjs dispatch       --task <slug> --slice <slice_id> --role <role> --spec <path> [--attempt N] [--settle-ms N]
//   node dispatch.mjs await          --task <slug> --all <dispatch_id...> [--max-block-s N]
//   node dispatch.mjs close          --task <slug> --dispatch <dispatch_id>
//   node dispatch.mjs status         --task <slug>
//   node dispatch.mjs teardown       --task <slug> [--outcome <ok|refused>] [--keep-artifacts]
//   node dispatch.mjs phase          --task <slug> --set <planning|building|gate>
//   node dispatch.mjs browser-verify --task <slug>
//
// Common options: --checkout <primary-checkout-dir> --repo <repo-slug>
//   --root <task-artifacts-root> --config <path-to-json>
//
// Every verb prints one JSON object to stdout (machine-readable) plus human
// lines to stderr. Exit 0 = success, 1 = operational failure, 2 = usage
// error or lock contention.
//
// Zero dependencies: node builtins only.
import { spawnSync, execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync,
  unlinkSync, rmSync, realpathSync, readdirSync, statSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import {
  resolveRoots, taskPaths, stemOf, specPathFor, renderPathFor, sidecarPaths, deriveWorktree, loadRoster,
  snapshotDirFor, parseEnvFile,
} from './resolve.mjs'
import {
  snapshotWorkerPlugin, newDispatchId, isoMs, nextAttempt,
  buildRecord, writeRecord, bindRecord, terminateRecord, withRecordLock,
  listRecords, StaleReturnError, resolveMaxTurnsOrThrow, RecordLockError,
} from './record.mjs'
import {
  PreflightError, isValidPreflightCache,
  preflight, ensureTeamWindow, ensureWorkspace, createPane, sendLine, renameTab,
  closeSurface, closeWorkspace, mountDocTab, findDocTabSurface, reorderDocTabFirst,
  PHASES, setPhase, readEvents, tree,
  TIERS, setWorkspaceColor, setProgress, clearProgress,
  TURN_END_EVENT_NAME, parseTurnEndEvent, readScreen,
  browserOpen, BROWSER_OPEN_SPAWN_TIMEOUT_MS, BROWSER_OPEN_AFTER_TREE_TIMEOUT_MS,
  browserErrorsClear, browserGoto, browserWaitReady, browserErrorsList, browserScreenshot,
} from './cmuxctl.mjs'
import {
  collectFsState, classify, reconcile, evaluatePostcondition, validateReturn, renderReturn,
} from './ladder.mjs'
import { detectSignatures } from './triage.mjs'
import { reduceBrowserErrors } from './browser-evidence.mjs'
import { shouldArchive, slugify, NONCE_PREFIX, PANE_ROLES, WORKER_BLOCKED_STATUSES } from './contract.mjs'
// A2 (#27) — the first `../` import in scripts/cmux/*.
import { lintSpec } from '../spec-lint.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PLUGIN_ROOT = resolvePath(HERE, '..', '..')

// ---------------------------------------------------------------------------
// EXECUTION MODE (A10 config-key half).
// ---------------------------------------------------------------------------

const EXECUTION_MODE_LINE_RE = /^execution_mode:\s*(.*)$/gm

// canonical accepted values (whitelist, not a blacklist) — widening this
// requires a deliberate edit to the EXECUTION_MODES drift-guard test too.
export const EXECUTION_MODES = Object.freeze(['agent-tool', 'cmux'])
// legacy spellings normalized on read; 'subagent' predates the agent-tool
// rename (issue #5) but must keep working.
export const EXECUTION_MODE_ALIASES = Object.freeze({ subagent: 'agent-tool' })
export const DEFAULT_EXECUTION_MODE = 'agent-tool'

// note for assertExecutionModeCmux (below): because 'subagent' normalizes to
// 'agent-tool' here, a config saying `execution_mode: subagent` now produces
// a gate refusal naming "agent-tool" — intended, since the mode IS
// agent-tool and subagent is only a spelling of it.
// trust C2: a config.md with MORE THAN ONE `execution_mode:` line (a fenced
// example quoting the key is the obvious case) is ambiguous — refusing
// beats silently matching whichever line the regex found first.
export function readExecutionMode(configText) {
  const matches = [...(configText || '').matchAll(EXECUTION_MODE_LINE_RE)]
  if (matches.length > 1) {
    throw new Error(`readExecutionMode: config text contains ${matches.length} 'execution_mode:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return DEFAULT_EXECUTION_MODE
  const raw = matches[0][1].trim()
  const value = EXECUTION_MODE_ALIASES[raw] ?? raw
  if (!EXECUTION_MODES.includes(value)) {
    // quote the RAW configured spelling, not the normalized one, so the
    // operator sees what their file actually says.
    throw new Error(`readExecutionMode: unknown execution_mode value: ${JSON.stringify(raw)}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// be-11-05 (ADR-018) — env-file config-key readers, beside readExecutionMode.
// Both follow the identical ambiguity doctrine (trust C2): more than one line
// for the same key in config.md is ambiguous and refuses rather than
// silently matching the first.
//
// QA fix (Must-Fix #1): unlike readExecutionMode — whose own fenced-example
// ambiguity is a DELIBERATE, documented, already-tested behaviour (see
// commands/onboard.md: "never inside a fenced code block... a second one
// makes the config ambiguous", and the pinned 'trust C2' test) — these two
// NEW readers strip fenced ``` code blocks before matching. This repo's own
// config.md documents cmux_env_file/env_file_keys with prose examples, and a
// fenced example at column 0 must never be mistaken for a live value the way
// it deliberately IS for execution_mode. readExecutionMode's behaviour is
// left untouched (changing it would revert an existing, intentional,
// separately-pinned design — flagged to the orchestrator, not changed here).
// ---------------------------------------------------------------------------

// stripFencedCodeBlocks(text) -> text with every ``` ... ``` fenced block's
// CONTENT blanked to spaces (line count preserved, so a 1-based line number
// computed against the ORIGINAL text — e.g. a future caller error message —
// would still line up). A config.md fenced example showing `key: value` at
// column 0 must never be live-parsed as a real value.
function stripFencedCodeBlocks(text) {
  return (text || '').replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
}

const CMUX_ENV_FILE_LINE_RE = /^cmux_env_file:\s*(.*)$/gm
const ENV_FILE_KEYS_LINE_RE = /^env_file_keys:\s*(.*)$/gm
const ENV_FILE_KEY_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// readCmuxEnvFile(configText) -> absolute path string | null. Absent or
// blank reproduces today's behaviour exactly — no env-file injection at all.
export function readCmuxEnvFile(configText) {
  const matches = [...stripFencedCodeBlocks(configText).matchAll(CMUX_ENV_FILE_LINE_RE)]
  if (matches.length > 1) {
    throw new OperationalError(`refused: config text contains ${matches.length} 'cmux_env_file:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return null
  const raw = matches[0][1].trim()
  return raw === '' ? null : raw
}

// readEnvFileKeys(configText) -> string[] (possibly empty). A single-line
// bracketed list, e.g. `env_file_keys: [KEY1, KEY2]` — the explicit, closed
// allowlist that is the PRIMARY control (Layer 1) for env-file injection.
// Every entry is shape-validated against the SAME charset parseEnvFile
// enforces on a real KEY — a malformed entry (e.g. a missing comma
// collapsing two names into one) refuses HERE, at the config line, rather
// than surfacing later as a confusing "undeclared key" at dispatch time.
export function readEnvFileKeys(configText) {
  const matches = [...stripFencedCodeBlocks(configText).matchAll(ENV_FILE_KEYS_LINE_RE)]
  if (matches.length > 1) {
    throw new OperationalError(`refused: config text contains ${matches.length} 'env_file_keys:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return []
  const raw = matches[0][1].trim()
  if (raw === '') return []
  const bracketMatch = /^\[(.*)\]$/.exec(raw)
  if (!bracketMatch) {
    throw new OperationalError(`refused: env_file_keys must be a single-line bracketed list (e.g. [KEY1, KEY2]), got: ${JSON.stringify(raw)}`)
  }
  const inner = bracketMatch[1].trim()
  if (inner === '') return []
  const entries = inner.split(',').map((s) => s.trim()).filter(Boolean)
  for (const entry of entries) {
    if (!ENV_FILE_KEY_ENTRY_RE.test(entry)) {
      throw new OperationalError(`refused: env_file_keys entry ${JSON.stringify(entry)} fails ^[A-Za-z_][A-Za-z0-9_]*$ — fix the entry (a missing comma between two names is the common cause)`)
    }
  }
  return entries
}

// formatEnvFileRefusal(parsed, configuredPath) -> string. Every refusal names
// the concrete remediation and NEVER the offending value or line content —
// env files carry secrets, the same hygiene class as never logging the
// completion nonce.
function formatEnvFileRefusal(parsed, configuredPath) {
  switch (parsed.reason) {
    case 'env_file_unreadable':
      return `refused: env_file_unreadable — cmux_env_file (${configuredPath}) must be an absolute path to a regular, readable file no larger than 64 KiB; fix the path or its permissions in .claude/dev-team/config.md`
    case 'env_file_reserved_key':
      return `refused: cmux_env_file (${configuredPath}) declares reserved key ${parsed.key}, matched by the reserved family ${JSON.stringify(parsed.matched)} — it can never be overridden; remove it from the file`
    case 'env_file_undeclared_key':
      return `refused: cmux_env_file (${configuredPath}) contains key ${parsed.key}, which is not listed in env_file_keys — add it to env_file_keys in .claude/dev-team/config.md, or remove it from the file`
    case 'env_file_parse_error':
      return `refused: cmux_env_file (${configuredPath}) failed to parse at line ${parsed.line} — only blank lines, '#' comments, and KEY=VALUE (no export/quotes/continuation/control characters/duplicate keys) are accepted; fix line ${parsed.line}`
    default:
      return `refused: cmux_env_file (${configuredPath}) was rejected (${parsed.reason})`
  }
}

// ---------------------------------------------------------------------------
// be-12-02 (issue #12/D8, ADR-019) — cmux_preview_url config-key reader,
// beside readCmuxEnvFile above. Same ADR-018 ambiguity doctrine (fenced
// blocks stripped, >1 line refuses), and the same "absent = today's
// behaviour exactly" contract: the whole browser-preview feature is inert
// until this key resolves to a non-null value.
// ---------------------------------------------------------------------------

const PREVIEW_URL_LINE_RE = /^cmux_preview_url:\s*(.*)$/gm
const PREVIEW_URL_MAX_LEN = 2048

// Full-match validator (D8). Host charset is deliberately SEPARATE from the
// path charset, so a hostless form (`https://?`, `https://#`, `https://@`)
// no longer full-matches once at least one host character is required.
// eslint-disable-next-line no-useless-escape
const PREVIEW_URL_FULL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~:\/?#\[\]!$&'()*+,;=%-]*)?$/
// Refuses any '%' NOT immediately followed by two hex digits (predict-never-
// repair, ADR-018) — a legitimate `%20` does not match this refusal regex,
// since the lookahead only fires on a MISSING/malformed escape.
const PREVIEW_URL_BAD_PERCENT_RE = /%(?![0-9A-Fa-f]{2})/

// Two deliberate exclusions from the charset above — do not "fix" either:
//   1. Backslash is accepted NOWHERE in the pattern. WHATWG treats `\` as
//      `/` in special schemes, so admitting it would let the value this
//      validator approved diverge from what a browser actually resolves to
//      — the same ADR-018 parser-divergence class readCmuxEnvFile guards
//      against.
//   2. The `https?` anchor is deliberately CASE-SENSITIVE — `HTTPS://` and
//      `Http://` both refuse. This is intentional, not an oversight.
//
// Every refusal names the REASON and, where useful, the scheme — NEVER the
// configured value itself: a dev preview URL can carry a token query
// param, and echoing it on a reject path is the same leak as printing it in
// full on the accept path (D8's whole "origin-only on every output path"
// rule exists for exactly this class of value).
function validatePreviewUrl(value) {
  if (value.includes('@')) {
    throw new OperationalError("refused: cmux_preview_url must not contain '@' — userinfo is never needed and would let a value like https://user:token@host/ pass a looser shape")
  }
  const match = PREVIEW_URL_FULL_RE.exec(value)
  if (!match) {
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)
    const scheme = schemeMatch ? schemeMatch[1] : '(none)'
    throw new OperationalError(`refused: cmux_preview_url does not match the required http(s) URL shape (scheme ${JSON.stringify(scheme)})`)
  }
  const portToken = match[1]
  if (portToken && Number(portToken.slice(1)) > 65535) {
    throw new OperationalError('refused: cmux_preview_url port exceeds 65535')
  }
  if (PREVIEW_URL_BAD_PERCENT_RE.test(value)) {
    throw new OperationalError("refused: cmux_preview_url contains a '%' not followed by two hex digits")
  }
  if (value.length > PREVIEW_URL_MAX_LEN) {
    throw new OperationalError(`refused: cmux_preview_url exceeds ${PREVIEW_URL_MAX_LEN} characters`)
  }
}

// readCmuxPreviewUrl(configText) -> URL string | null. Absent/blank
// reproduces today's behaviour exactly — the whole preview feature is
// structurally off. >1 line is ambiguous and refuses (a fenced example is
// the obvious case) rather than taking the first line found.
export function readCmuxPreviewUrl(configText) {
  const matches = [...stripFencedCodeBlocks(configText).matchAll(PREVIEW_URL_LINE_RE)]
  if (matches.length > 1) {
    throw new OperationalError(`refused: config text contains ${matches.length} 'cmux_preview_url:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return null
  const raw = matches[0][1].trim()
  if (raw === '') return null
  validatePreviewUrl(raw)
  return raw
}

// originOf(url) -> 'scheme://host[:port]'. Called ONLY after
// validatePreviewUrl has already passed — new URL() is fine post-validation
// (predict-never-repair forbids using it AS the validator, never as a
// post-validation formatter of an already-approved value).
function originOf(url) {
  return new URL(url).origin
}

// ---------------------------------------------------------------------------
// OUTCOME MAPPING — single documented table, evaluated in order.
// ---------------------------------------------------------------------------

// OUTCOME_WORKER_BLOCKED(body status) -> the dedicated terminal outcome (added
// to OUTCOMES + the schema by fix-1c-00) for a worker-side refusal/exhaustion
// (MF1); keyed strictly on the envelope body status, never the .exit sentinel (U-4).
export const OUTCOME_WORKER_BLOCKED = 'blocked'

export const OUTCOME_MAPPING = [
  // bodyStatus is null for every markdown (reviewer/validator) body — a
  // string has no `status` field — so a gate/adapter-composed blocked
  // markdown envelope (writeBlockedReturn's output) is invisible to the
  // worker_blocked row above and must be caught here instead, keyed on
  // ladder.classify()'s bodyBlockedMarkdown flag (never fsState.exitSentinel,
  // per U-4). === true, not truthiness: fail closed if the field is ever
  // absent from an older/partial classification.
  { row: 'worker_blocked', outcome: OUTCOME_WORKER_BLOCKED, when: (c) => c.state === 'completed' && WORKER_BLOCKED_STATUSES.includes(c.bodyStatus) },
  { row: 'worker_blocked_markdown', outcome: OUTCOME_WORKER_BLOCKED, when: (c) => c.state === 'completed' && c.bodyBlockedMarkdown === true },
  { row: 'completed', outcome: 'ok', when: (c) => c.state === 'completed' },
  { row: 'exit_nonzero', outcome: 'exit_nonzero', when: (c, fsState) => fsState && fsState.exitSentinel != null && fsState.exitSentinel !== '0' },
  { row: 'timeout', outcome: 'timeout', when: (c) => c.state === 'timeout' },
  { row: 'invalid_return', outcome: 'invalid_return', when: (c, fsState) => fsState && fsState.returnPathKind === 'file' },
  { row: 'no_return', outcome: 'no_return', when: () => true },
]

// mapOutcome(classification, fsState) -> OUTCOMES member (never 'ok' unless
// classification.state === 'completed'; see OUTCOME_MAPPING row order above).
export function mapOutcome(classification, fsState) {
  for (const row of OUTCOME_MAPPING) {
    if (row.when(classification, fsState)) return row.outcome
  }
  return 'no_return'
}

// applyPostconditionOverride(outcome, postconditionResult) -> outcome.
// A violated 'clean' postcondition overrides ok with refused_postcondition;
// it never demotes an already-non-ok outcome.
export function applyPostconditionOverride(outcome, postconditionResult) {
  if (outcome === 'ok' && postconditionResult && !postconditionResult.ok) {
    return 'refused_postcondition'
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Small I/O helpers.
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export class OperationalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OperationalError'
  }
}

// A2 (#27) — the schema-derived dispatch floor. The refusing class is
// EXACTLY the violations contract.validate() returns via spec-lint's
// checkSchema (scripts/spec-lint.mjs:251-256); every other spec-lint
// diagnostic is environment- or timing-dependent and can never refuse.
export const SPEC_SCHEMA_REFUSAL_CODE = 'spec_schema_invalid'
export const SPEC_SCHEMA_REFUSAL_MESSAGE = 'refused: the Handover Spec violates handover-spec.schema.json — a schema-invalid spec is never dispatched to an executor role; fix the spec and re-dispatch (heuristic spec-lint findings never refuse a dispatch)'

export class SpecSchemaError extends Error {
  constructor(failures) {
    super(SPEC_SCHEMA_REFUSAL_MESSAGE)
    this.name = 'SpecSchemaError'
    this.code = SPEC_SCHEMA_REFUSAL_CODE
    this.failures = failures // [{ check: 'schema', detail: string }, ...]
  }
}

// The one spec-lint check name whose failures refuse. Definition site:
// scripts/spec-lint.mjs:251-256 (the ONLY caller of fail('schema', ...)).
// Whitelist of one — a heuristic check added to spec-lint later is
// non-refusing by construction, with no edit to this file.
const SPEC_LINT_SCHEMA_CHECK = 'schema'

// A2 (#27) fix-round items 1/6 — every SpecSchemaError failure detail is
// sanitized and capped before it reaches stderr or the returned JSON.
// `detail` is spec-lint's `${v.path}: ${v.message}`, which echoes back
// arbitrary JSON key names from the spec file verbatim — including control
// characters and ANSI escape sequences a hostile or malformed spec could
// embed to forge terminal output or fake standalone lines in the
// orchestrator's own Bash-tool context. Stripping every Cc/Cf codepoint
// (control + format characters, which includes ESC and every line-break
// character) neutralizes both. The failure COUNT is capped separately so a
// spec with thousands of violations — or one enormous single detail string —
// cannot balloon the same context window.
const MAX_RENDERED_FAILURES = 20
const MAX_DETAIL_LENGTH = 300
const CONTROL_OR_FORMAT_CHARS_RE = /[\p{Cc}\p{Cf}]/gu

function sanitizeDetail(detail) {
  const stripped = String(detail).replace(CONTROL_OR_FORMAT_CHARS_RE, '')
  if (stripped.length <= MAX_DETAIL_LENGTH) return stripped
  return `${stripped.slice(0, MAX_DETAIL_LENGTH)}...<truncated, ${stripped.length} chars total>`
}

// capFailuresForOutput(failures) -> a new array, every detail sanitized, at
// most MAX_RENDERED_FAILURES entries plus a synthetic "...and N more" tail
// entry when truncated. Never mutates `failures` — callers (e.g. dispatchCmd
// tests) still see the original, uncapped err.failures.
function capFailuresForOutput(failures) {
  const sanitized = failures.map((f) => ({ ...f, detail: sanitizeDetail(f.detail) }))
  if (sanitized.length <= MAX_RENDERED_FAILURES) return sanitized
  const kept = sanitized.slice(0, MAX_RENDERED_FAILURES)
  kept.push({ check: SPEC_LINT_SCHEMA_CHECK, detail: `...and ${sanitized.length - MAX_RENDERED_FAILURES} more` })
  return kept
}

function log(line) {
  process.stderr.write(`${line}\n`)
}

function readJsonOrNull(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

// trust S5-E: await.lock/workspace.json/worktrees.json all live in
// stateDir, which a worker's own Bash subprocess can reach (G13, same uid).
// A malformed one is treated as ABSENT + a loud warning — never a throw,
// never trusted as-is. (events.cursor is a bare integer, not JSON — its own
// reader already fails safe via `Number(text) || 0`.)
function readJsonOrWarn(path, label) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    log(`${label}: malformed JSON at ${path} — treating as absent (${err.message})`)
    return null
  }
}

function writeJsonAtomic(path, obj) {
  writeTextAtomic(path, `${JSON.stringify(obj, null, 2)}\n`)
}

// trust S6: events.cursor is the one state write in this file that used to
// skip the tmp+rename discipline every other write here follows — a crash
// mid-write would leave a partial value (low blast radius, since a garbage
// cursor just fails safe to a full replay via `Number(text) || 0`, but there
// is no reason for it to be the exception).
function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------
// Argv parsing — a minimal, dependency-free `--flag value` / `--flag` /
// `--flag a b c...` (greedy list, terminated by the next --flag) parser.
// ---------------------------------------------------------------------------

const LIST_FLAGS = new Set(['--all'])
const BOOLEAN_FLAGS = new Set(['--force', '--keep-artifacts'])

export function parseArgs(argv) {
  const out = {}
  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      throw new UsageError(`unexpected positional argument: ${token}`)
    }
    const key = token.slice(2)
    if (BOOLEAN_FLAGS.has(token)) {
      out[key] = true
      i += 1
      continue
    }
    if (LIST_FLAGS.has(token)) {
      const values = []
      i += 1
      while (i < argv.length && !argv[i].startsWith('--')) {
        values.push(argv[i])
        i += 1
      }
      out[key] = values
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) {
      throw new UsageError(`flag ${token} requires a value`)
    }
    out[key] = value
    i += 2
  }
  return out
}

// ---------------------------------------------------------------------------
// Context assembly — every path derivation goes through resolve.mjs; nothing
// here computes a path itself.
// ---------------------------------------------------------------------------

// buildContext(args) -> { roots, paths, roster, primaryCheckout, repoSlug,
// taskSlug, pluginRoot, config }. `args` is the already-parsed CLI flags;
// `--config <path>` is an optional JSON sidecar carrying dispatch-level
// overrides (worktree_prep, session roster overrides, per-dispatch
// maxGateBlocks/timeoutS/maxTurns) — none of which this file invents shapes
// for beyond what buildRecord's ctx.config already accepts.
export function buildContext(args) {
  if (!args.task) {
    throw new UsageError('--task <slug> is required')
  }
  const primaryCheckout = args.checkout ? resolvePath(args.checkout) : process.cwd()
  const pluginRoot = args['plugin-root'] ? resolvePath(args['plugin-root']) : DEFAULT_PLUGIN_ROOT
  const repoSlug = args.repo || basename(primaryCheckout)
  // trust M6: the RAW --task value is stored NOWHERE — every downstream use
  // (workspace --name, record.task_id/task_slug, the archive path) reads
  // ctx.taskSlug, so slugifying it once, here, closes every one of those
  // traversal paths at the single source rather than per-callsite.
  const taskSlug = slugify(args.task)
  const taskArtifactsRoot = args.root ? resolvePath(args.root) : undefined
  const fileConfig = args.config ? readJsonOrNull(resolvePath(args.config)) || {} : {}

  const roots = resolveRoots({ taskArtifactsRoot })
  const paths = taskPaths({ roots, repoSlug, taskSlug })

  // lifecycle S12: if the LIVE roster no longer even parses (a schema
  // violation introduced after dispatch), every verb — including read-only
  // `status` — would otherwise be hostage to a file unrelated to any
  // already-dispatched record. Fall back to roster.snapshot.json when it
  // exists; a dispatch that needs a genuinely valid live roster (buildRecord
  // reads ctx.roster) still gets the frozen-at-dispatch-time shape, which is
  // exactly what S12 asks for anyway.
  let roster
  try {
    ({ roster } = loadRoster({
      pluginRoot,
      home: process.env.HOME || process.env.USERPROFILE || '/root',
      primaryCheckout,
      session: fileConfig.session || null,
    }))
  } catch (err) {
    const snapshot = readJsonOrWarn(paths.rosterSnapshotPath, 'roster.snapshot.json')
    if (!snapshot) throw err
    log(`buildContext: the live roster is invalid (${err.message}) — falling back to roster.snapshot.json`)
    roster = snapshot
  }

  return { roots, paths, roster, primaryCheckout, repoSlug, taskSlug, pluginRoot, config: fileConfig }
}

// readTaskRoster(ctx, sliceIds) -> [{ role, cli }] shaped for preflight()'s
// adapter-presence check — one entry per distinct role actually in play.
function rosterForPreflight(roster) {
  const entries = []
  const seen = new Set()
  for (const [role, def] of Object.entries(roster.roles || {})) {
    const agent = def.agent || roster.defaults.agent
    // The adapter CLI is a fixed convention: <agent>-code for every non-claude
    // agent; 'claude' itself is always on PATH inside a Claude Code session.
    const cli = agent === 'claude' ? 'claude' : `${agent}-code`
    if (seen.has(role)) continue
    seen.add(role)
    entries.push({ role, cli })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Git worktree management. Every invocation is execFileSync with an argv
// array (never a shell string) — cmux gotcha (1) applies to git too:
// unpiped, array-form spawns are the only reliable way to get real exit
// codes and never hit a shell-interpolation hazard.
// ---------------------------------------------------------------------------

function gitOutput(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitOk(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return res.status === 0
}

function readWorktreesIndex(path) {
  return readJsonOrWarn(path, 'worktrees.json') || {}
}

function writeWorktreesIndex(path, index) {
  writeJsonAtomic(path, index)
}

function gitBranchExists(branch, cwd) {
  return gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
}

// isDispatcherWorktree(path, primaryCheckout) -> boolean. Destructive removal
// is permitted ONLY on a path proven to be a dispatcher-created worktree: it
// IS a worktree, it SHARES the primary checkout's git-common-dir, and it is
// NOT the primary checkout itself. Anything else refuses (returns false) —
// this is never a --force decision.
// realpath both sides before comparing: a symlinked tmpdir (macOS's /tmp ->
// /private/tmp) would otherwise make an identical git-common-dir compare
// unequal purely because of the invoking cwd's symlink resolution.
function realResolve(base, maybeRelative) {
  return realpathSync(resolvePath(base, maybeRelative))
}

export function isDispatcherWorktree(path, primaryCheckout) {
  try {
    if (realpathSync(path) === realpathSync(primaryCheckout)) return false
    if (!existsSync(path)) return false
    const isWt = gitOutput(['rev-parse', '--is-inside-work-tree'], path) === 'true'
    if (!isWt) return false
    const commonHere = realResolve(path, gitOutput(['rev-parse', '--git-common-dir'], path))
    const commonPrimary = realResolve(primaryCheckout, gitOutput(['rev-parse', '--git-common-dir'], primaryCheckout))
    return commonHere === commonPrimary
  } catch {
    return false
  }
}

// ensureWorktree(paths, roots, repoSlug, taskSlug, sliceId, primaryCheckout,
// dispatchId) -> worktree descriptor { path, branch, created_by_dispatcher,
// source_slice_id }. Keyed by slice_id ONLY (never task_id, never attempt) —
// a second attempt of the same slice reuses the identical worktree (pinned
// U-1: the attempt bumps, the worktree never does). The attempts list at
// <state>/worktrees.json gains the new dispatch_id either way.
//
// lifecycle S5: the whole read-modify-write against worktrees.json runs
// inside withRecordLock (the same exclusive-create-sidecar primitive
// record.mjs uses for a record's own lock) — two concurrent dispatches of
// DIFFERENT slices no longer lose one entry to an interleaved read.
// lifecycle S6: a reused index entry is re-verified isDispatcherWorktree
// before being trusted (a hand-edited or stale index entry must not grant
// removal/reuse just because a path string exists); a fresh derive checks
// for an EXISTING `dt/<task>/<slice>` branch (left behind by a prior
// teardown) and reuses it via `worktree add <path> <branch>` (no `-b`)
// instead of failing on "branch already exists".
export function ensureWorktree({ roots, repoSlug, taskSlug, sliceId, primaryCheckout, dispatchId, worktreesIndexPath }) {
  const derived = deriveWorktree({
    roots, repoSlug, taskSlug, sliceId, isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null,
  })

  // withRecordLock's exclusive-create lock sidecar needs its parent
  // directory to already exist — unlike writeJsonAtomic, `writeFileSync(...,
  // { flag: 'wx' })` never creates missing directories itself.
  mkdirSync(dirname(worktreesIndexPath), { recursive: true })

  return withRecordLock(worktreesIndexPath, () => {
    const index = readWorktreesIndex(worktreesIndexPath)
    const existing = index[sliceId]

    if (existing && existsSync(existing.path)) {
      if (!isDispatcherWorktree(existing.path, primaryCheckout)) {
        throw new OperationalError(`refused: worktrees.json entry for slice ${JSON.stringify(sliceId)} does not point at a dispatcher-owned worktree: ${existing.path}`)
      }
      existing.attempts = [...(existing.attempts || []), dispatchId]
      index[sliceId] = existing
      writeWorktreesIndex(worktreesIndexPath, index)
      return { path: existing.path, branch: existing.branch, created_by_dispatcher: existing.created_by_dispatcher, source_slice_id: existing.source_slice_id }
    }

    mkdirSync(dirname(derived.path), { recursive: true })
    if (gitBranchExists(derived.branch, primaryCheckout)) {
      execFileSync('git', ['worktree', 'add', derived.path, derived.branch], { cwd: primaryCheckout, encoding: 'utf8' })
    } else {
      execFileSync('git', ['worktree', 'add', '-b', derived.branch, derived.path], { cwd: primaryCheckout, encoding: 'utf8' })
    }

    index[sliceId] = {
      path: derived.path,
      branch: derived.branch,
      created_by_dispatcher: true,
      source_slice_id: null,
      attempts: [dispatchId],
    }
    writeWorktreesIndex(worktreesIndexPath, index)
    return derived
  })
}

// isWorktreeCleanAndMerged(path, primaryCheckout, branch) -> boolean.
function isWorktreeCleanAndMerged(path, primaryCheckout, branch) {
  if (!isDispatcherWorktree(path, primaryCheckout)) return false
  const porcelain = gitOutput(['status', '--porcelain'], path)
  if (porcelain.length > 0) return false
  const merged = gitOutput(['branch', '--merged'], primaryCheckout)
    .split('\n')
    .map((l) => l.replace(/^[*+]?\s+/, '').trim())
  return merged.includes(branch)
}

// removeWorktreeIfCleanAndMerged(sliceId, entry, primaryCheckout,
// worktreesIndexPath, roots) -> { removed, reason }. NEVER --force. A dirty
// or unmerged worktree is kept and reported, never deleted. lifecycle S7:
// removal additionally requires entry.created_by_dispatcher === true AND
// the path to live under roots.worktreesRoot — isDispatcherWorktree alone
// (git-common-dir equality) is true for ANY worktree of the same repo,
// including a user-owned one; nothing else in this file is what keeps such
// a worktree safe, since the index is a plain editable JSON file.
export function removeWorktreeIfCleanAndMerged({ sliceId, entry, primaryCheckout, worktreesIndexPath, roots }) {
  if (entry.created_by_dispatcher !== true) {
    return { removed: false, reason: 'not_created_by_dispatcher' }
  }
  if (!isUnderWorktreesRoot(entry.path, roots.worktreesRoot)) {
    return { removed: false, reason: 'outside_worktrees_root' }
  }
  if (!isWorktreeCleanAndMerged(entry.path, primaryCheckout, entry.branch)) {
    return { removed: false, reason: 'dirty_or_unmerged' }
  }
  if (!gitOk(['worktree', 'remove', entry.path], primaryCheckout)) {
    return { removed: false, reason: 'git_worktree_remove_failed' }
  }
  return withRecordLock(worktreesIndexPath, () => {
    const index = readWorktreesIndex(worktreesIndexPath)
    delete index[sliceId]
    writeWorktreesIndex(worktreesIndexPath, index)
    return { removed: true, reason: null }
  })
}

function isUnderWorktreesRoot(path, worktreesRoot) {
  const p = resolvePath(path)
  const root = resolvePath(worktreesRoot)
  return p === root || p.startsWith(`${root}/`)
}

// ---------------------------------------------------------------------------
// Completion nonce — conventions.md "unguessable per-run nonce delivered out
// of band": written 0600 to <state>/<dispatch_id>.nonce, never logged, never
// placed in argv/env/kickoff/task dir (assertNoNonce covers the record; this
// function is the only writer of the file itself). NEVER an env var — macOS
// `ps eww` exposes exec-time environment.
// ---------------------------------------------------------------------------

export function writeCompletionNonce(noncePath) {
  mkdirSync(dirname(noncePath), { recursive: true })
  const value = `${NONCE_PREFIX}${randomBytes(32).toString('hex')}`
  writeFileSync(noncePath, value, { mode: 0o600 })
  chmodSync(noncePath, 0o600)
}

// ---------------------------------------------------------------------------
// Execution-mode gate — every mutating verb refuses when execution_mode is
// not 'cmux'. `configText` is the raw text of .claude/dev-team/config.md
// (or '' if absent) — readExecutionMode owns the parse.
// ---------------------------------------------------------------------------

// browser-verify's membership here is NOT "mutates a record" (it mutates
// nothing — it is a read-only consumer of <stateDir>/browser.json and
// writes only a screenshot PNG); this set's real meaning is "requires
// execution_mode: cmux" (its only consumer is assertExecutionModeCmux
// below), which IS browser-verify's entire execution-mode authorization
// gate (issue #12/D3, ADR-019) — not a lifecycle-record concern at all.
const MUTATING_VERBS = new Set(['workspace', 'dispatch', 'await', 'close', 'teardown', 'phase', 'browser-verify'])

function assertExecutionModeCmux(verb, configText) {
  if (!MUTATING_VERBS.has(verb)) return
  const mode = readExecutionMode(configText)
  if (mode !== 'cmux') {
    throw new OperationalError(
      `refused: execution_mode is ${JSON.stringify(mode)}, not "cmux" — set execution_mode: cmux in .claude/dev-team/config.md to use the cmux dispatcher`,
    )
  }
}

function readConfigText(primaryCheckout) {
  const p = join(primaryCheckout, '.claude', 'dev-team', 'config.md')
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

export function preflightCmd(args, ctx) {
  const { paths, primaryCheckout, roster } = ctx
  const rosterEntries = rosterForPreflight(roster)
  const worktreesIndex = readWorktreesIndex(paths.worktreesIndexPath)
  const worktreeDirs = Object.values(worktreesIndex).map((w) => w.path)

  const preflightJson = preflight({
    roster: rosterEntries,
    paths: { taskDir: paths.taskDir, worktreeDirs },
    primaryCheckout,
    taskArtifactsRoot: paths.stateDir,
    force: Boolean(args.force),
  })

  return { code: 0, json: preflightJson }
}

// lifecycle S14: preflight.json lives in stateDir (worker-reachable, G13) —
// every direct reader in this file (not just cmuxctl.preflight()'s own
// non-force read) must treat a malformed OR shape-invalid cache as absent,
// never as a throw and never as truth. Reuses cmuxctl.mjs's own
// isValidPreflightCache so the shape check has a single definition site.
function readPreflightCache(cachePath) {
  const cached = readJsonOrWarn(cachePath, 'preflight.json')
  if (!cached || !isValidPreflightCache(cached)) {
    if (cached) log(`preflight.json at ${cachePath} fails the frozen cache shape — treating as absent`)
    return null
  }
  return cached
}

function loadPreflightOrRefuse(paths) {
  const cachePath = join(paths.stateDir, 'preflight.json')
  const cached = readPreflightCache(cachePath)
  if (!cached) {
    throw new OperationalError('refused: no cached preflight.json — run `preflight` first')
  }
  return { cached, cachePath }
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

export function workspaceCmd(args, ctx) {
  const { paths, primaryCheckout, taskSlug, repoSlug } = ctx

  // be-11-02: --tier is validated against the imported TIERS enum BEFORE
  // loadPreflightOrRefuse (i.e. before any possibility of a cmux call), so
  // an out-of-enum tier issues zero cmux invocations. No default tier is
  // ever guessed — omitting --tier leaves `tier` null and fires zero
  // workspace-action calls below.
  let tier = null
  if (args.tier !== undefined) {
    const parsed = Number(args.tier)
    if (!TIERS.includes(parsed)) {
      throw new UsageError(`workspace: --tier must be one of ${TIERS.join('|')}, got ${JSON.stringify(args.tier)}`)
    }
    tier = parsed
  }

  // be-11-05 (ADR-018): opt-in env-file injection. Every refusal below is
  // resolved from config.md + the file on disk alone, BEFORE loadPreflightOrRefuse
  // and the team-window tree() read further down — a bad env file issues
  // ZERO cmux invocations. Absent cmux_env_file reproduces today's behaviour
  // exactly: configuredEnvFilePath stays null, no --env-file is ever emitted,
  // and no env_file block is ever added to workspace.json.
  const configText = readConfigText(primaryCheckout)
  const configuredEnvFilePath = readCmuxEnvFile(configText)
  const declaredEnvFileKeys = readEnvFileKeys(configText)
  // QA fix (TOCTOU): parseEnvFile now reads the file exactly once and
  // returns the sha256 of the SAME bytes it validated — this hash (never a
  // second, separate hashEnvFile call against the path) is what gets
  // stamped into workspace.json below, so the record provably describes
  // bytes this module actually parsed.
  let parsedEnvFile = null
  if (configuredEnvFilePath !== null) {
    parsedEnvFile = parseEnvFile(configuredEnvFilePath, { declaredKeys: declaredEnvFileKeys })
    if (!parsedEnvFile.ok) {
      throw new OperationalError(formatEnvFileRefusal(parsedEnvFile, configuredEnvFilePath))
    }
  }
  const currentEnvFileHash = parsedEnvFile ? parsedEnvFile.sha256 : null

  const workspaceStatePath = join(paths.stateDir, 'workspace.json')
  const priorState = readJsonOrWarn(workspaceStatePath, 'workspace.json')
  const priorEnvFile = (priorState && priorState.env_file) || null

  const { cached, cachePath } = loadPreflightOrRefuse(paths)

  const windowId = ensureTeamWindow(cached)
  if (cached.team_window_id !== windowId) {
    writeJsonAtomic(cachePath, { ...cached, team_window_id: windowId })
  }

  const { workspaceId, initialSurfaceId, created } = ensureWorkspace({
    windowId, taskSlug, cwd: primaryCheckout, group: slugify(repoSlug), envFile: configuredEnvFilePath,
  })

  // be-11-05: env_file block — stamped ONLY at creation (this is the
  // FIRST time this workspace object exists, so there is nothing to diverge
  // from yet); on the reuse branch it is carried forward VERBATIM per the
  // reuse-branch discriminator table below, never re-stamped.
  let resolvedEnvFile
  if (created) {
    resolvedEnvFile = configuredEnvFilePath
      ? { path: configuredEnvFilePath, sha256: currentEnvFileHash, recorded_at: new Date().toISOString(), workspace_id: workspaceId }
      : null
    // A DECLARED key absent from the file only warns and proceeds — the
    // undeclared direction (a file key absent from env_file_keys) is the one
    // that refuses, inside parseEnvFile itself. QA fix: gated on `created`
    // only — this is the FIRST dispatch's own warning about its own file;
    // firing it again on every later steady-state reuse call would be
    // ongoing stderr noise on a path the design wants silent (see the
    // "common case" reuse branch below).
    if (parsedEnvFile) {
      for (const key of declaredEnvFileKeys) {
        if (!parsedEnvFile.keys.includes(key)) {
          log(`workspace: env_file_keys declares ${JSON.stringify(key)} but it is absent from ${configuredEnvFilePath} — proceeding`)
        }
      }
    }
  } else {
    // QA fix: `recorded` used to collapse THREE distinct states into one
    // (never had an env file / workspace.json missing-or-malformed
    // (already handled upstream by readJsonOrWarn's own trust S5-E
    // absent-plus-loud-warning treatment) / a recorded block that belongs
    // to a DIFFERENT, now-dead workspace_id after a cmux restart recreated
    // this workspace under a new id) — all three used to produce the SAME
    // "no env_file was ever configured" refusal message, which is simply
    // false for the third case. The workspace_id scoping itself stays
    // correct (never trust a hash recorded against a dead workspace) but
    // the refusal now names which of the two distinguishable cases fired.
    const workspaceIdMismatch = priorEnvFile && priorEnvFile.workspace_id !== workspaceId
    const recorded = priorEnvFile && !workspaceIdMismatch ? priorEnvFile : null
    if (recorded === null && configuredEnvFilePath === null) {
      // null/null — proceed. (Also covers a recreated workspace with no
      // env file configured now: nothing to diverge from either way.)
      resolvedEnvFile = null
    } else if (recorded === null && configuredEnvFilePath !== null && workspaceIdMismatch) {
      throw new OperationalError(`refused: this workspace appears to have been recreated (a prior env_file was recorded for workspace ${priorEnvFile.workspace_id}, but the live workspace is now ${workspaceId}) — cannot verify whether cmux_env_file (${configuredEnvFilePath}) matches the live workspace's actual environment; close the workspace and re-dispatch`)
    } else if (recorded === null && configuredEnvFilePath !== null) {
      throw new OperationalError(`refused: this already-created workspace has no recorded env_file, but cmux_env_file is now configured (${configuredEnvFilePath}) — cannot retroactively add environment injection to a live workspace; close the workspace and re-dispatch`)
    } else if (recorded !== null && configuredEnvFilePath === null) {
      throw new OperationalError(`refused: this workspace was created with env_file ${recorded.path} (sha256 ${recorded.sha256}) but cmux_env_file is no longer configured — cannot retroactively remove environment injection from a live workspace; close the workspace and re-dispatch`)
    } else if (recorded.sha256 !== currentEnvFileHash || recorded.path !== configuredEnvFilePath) {
      throw new OperationalError(`refused: cmux_env_file changed for an already-created workspace (recorded ${recorded.path} sha256 ${recorded.sha256}; current ${configuredEnvFilePath} sha256 ${currentEnvFileHash}) — close the workspace and re-dispatch to apply the new environment`)
    } else {
      // present/present, equal — the common case: proceed silently, carry
      // the prior block forward verbatim (never re-stamped).
      resolvedEnvFile = recorded
    }
  }

  const before = tree({ all: true })
  const win = (before.windows || []).find((w) => w.id === windowId)
  const ws = win?.workspaces?.find((w) => w.id === workspaceId)
  const initialPaneId = ws?.panes?.[0]?.id ?? null
  // be-12-02 (issue #12/D4): this slice deliberately declines to give
  // `initial_pane_id` a reader. The browser-preview singleton's worker-pane
  // exclusion is keyed on `initial_surface_id` alone (located via the
  // surface id, never via this field) — pane reordering cannot misclassify
  // a surface-derived key, but a stored pane id could go stale exactly like
  // any other pane-position assumption. `initial_pane_id` therefore keeps
  // zero readers in scripts/cmux/, unchanged from before this slice.

  // lifecycle M1: ALWAYS rewrite workspace.json from the ensureWorkspace
  // result, never only-if-absent. ensureWorkspace re-finds the workspace by
  // TITLE and returns whatever cmux-assigned id currently exists (correct
  // even across a cmux restart, where the old id is dead but the file on
  // disk would otherwise still hold it forever) — write-once made a cmux
  // restart a permanent wedge (every subsequent `dispatch` reads the stale
  // dead id and throws createPane's "workspace is gone" error).
  //
  // be-11-02: workspace.json is rewritten WHOLESALE, so any field not
  // explicitly carried forward here is silently destroyed on a later
  // `workspace` run. `carried` is the single, obvious merge point for every
  // such field — `tier` here, and be-11-05's `env_file` block below.
  const resolvedTier = tier !== null ? tier : (priorState?.tier ?? null)
  const carried = { tier: resolvedTier }
  const workspaceStateOut = {
    ...carried,
    window_id: windowId, workspace_id: workspaceId,
    initial_pane_id: initialPaneId, initial_surface_id: initialSurfaceId,
  }
  // be-11-05: no env_file key at all when null — this is what makes the
  // absent-cmux_env_file case reproduce today's behaviour exactly (no block
  // is EVER written), rather than an explicit `env_file: null`.
  if (resolvedEnvFile !== null) {
    workspaceStateOut.env_file = resolvedEnvFile
  }
  writeJsonAtomic(workspaceStatePath, workspaceStateOut)

  // be-11-02: the tier colour, when --tier is supplied. Cosmetics never
  // fail a verb — same swallow-and-log shape as setPhase('planning') below.
  if (tier !== null) {
    try {
      setWorkspaceColor(tier, { workspaceId })
    } catch (err) {
      log(`workspace: setWorkspaceColor(${tier}) failed — workspace color not updated: ${err.message}`)
    }
  }

  // S9 phase pill: entering `workspace` is the 'planning' phase.
  // setPhase('planning', { workspaceId }) is provably non-throwing here
  // ('planning' is always valid and workspaceId is always freshly minted
  // above) — wrapped anyway (qa should-fix) so a future change to setPhase
  // itself can never turn a successful `workspace` into a reported failure;
  // any throw is swallowed and logged loudly instead.
  try {
    setPhase('planning', { workspaceId })
  } catch (err) {
    log(`workspace: setPhase('planning') failed — phase pill not updated: ${err.message}`)
  }

  return {
    code: 0,
    json: { window_id: windowId, workspace_id: workspaceId, initial_surface_id: initialSurfaceId, tier: resolvedTier, env_file: resolvedEnvFile },
  }
}

// ---------------------------------------------------------------------------
// Browser preview singleton (be-12-02, issue #12/D4, ADR-019). The whole
// resolve -> decide -> create -> verify -> stamp sequence below runs inside
// withRecordLock(<stateDir>/browser.json, ...) — the LOCK SPANS THE SIDE
// EFFECT (the `browser open` call), never just the sidecar write, because
// two racers both seeing "no record" would both create and cmux would stack
// a second surface into the first's pane (both surfaces then undrivable).
//
// Bounded critical section (errata E1): at most THREE bounded spawns —
//   1. scan tree  tree({ all: true, timeoutMs: 3000 })   — also serves as
//      browserOpen's `treeBefore`
//   2. browser open  browserOpen(url, { workspaceId, treeBefore })  — 5000ms,
//      performs its OWN single bounded tree read (3000ms) and returns it as
//      `treeAfter`
// worst case: 3000 + 5000 + 3000 = 11 000ms, leaving 19 000ms of margin
// under LOCK_STALE_MS (30 000ms — record.mjs:807). Reuse and fail-closed
// paths cost exactly one bounded tree (3000ms). Any future spawn added
// inside this section must be bounded and this budget recomputed.
//
// There is NO adopt outcome (D4) — only reuse / create / fail-closed. The
// abandon close (post-create idempotence/pane-check failure) is decided
// INSIDE the section on `treeAfter` but its best-effort `closeSurface` runs
// AFTER lock release (errata E2) — it is idempotent, targets a surface only
// this process knows about, and keeping it out of the section is what holds
// the budget at two trees.
// ---------------------------------------------------------------------------

const PREVIEW_BROWSER_SIDECAR_NAME = 'browser.json'

// The critical section's stated worst-case spawn budget (errata E1): two
// bounded tree reads (3000ms each — the scan tree and browserOpen's own
// treeAfter read) plus one bounded browserOpen (5000ms) = 11000ms, leaving
// 19000ms of margin under record.mjs's LOCK_STALE_MS (30000ms, record.mjs:807
// — not exported and record.mjs is out of files_in_scope for this slice, so
// the value is duplicated here as a literal rather than imported). Exported
// so a test can assert the sum without re-typing the addends. be-12-02
// fix-round item 3: the browserOpen-owned bounds are no longer re-typed here
// — they are imported from cmuxctl.mjs (the module that actually owns and
// consumes them), so a change to browserOpen's real spawn timeouts moves
// this sum instead of silently desyncing from it. Only the scan tree's own
// bound (dispatch.mjs's own spawn, not browserOpen's) stays local.
export const PREVIEW_LOCK_SCAN_TREE_TIMEOUT_MS = 3000
export const PREVIEW_LOCK_WORST_CASE_MS = PREVIEW_LOCK_SCAN_TREE_TIMEOUT_MS + BROWSER_OPEN_SPAWN_TIMEOUT_MS + BROWSER_OPEN_AFTER_TREE_TIMEOUT_MS

// findWorkspaceInTree(t, workspaceId) -> workspace node | null.
function findWorkspaceInTree(t, workspaceId) {
  for (const w of t.windows || []) {
    const ws = (w.workspaces || []).find((x) => x.id === workspaceId)
    if (ws) return ws
  }
  return null
}

// findPaneById(t, paneId) -> pane node | null. Searches every workspace in
// the tree (not scoped to one workspace) — the same-workspace equality check
// against a dispatch record's own surface.workspace_id already scopes this
// correctly; resolution here only answers "does this pane id exist at all
// right now".
function findPaneById(t, paneId) {
  for (const w of t.windows || []) {
    for (const ws of w.workspaces || []) {
      const p = (ws.panes || []).find((x) => x.id === paneId)
      if (p) return p
    }
  }
  return null
}

// findSurfaceInWorkspace(ws, surfaceId) -> { pane, surface } | null.
function findSurfaceInWorkspace(ws, surfaceId) {
  for (const p of ws.panes || []) {
    const surface = (p.surfaces || []).find((s) => s.id === surfaceId)
    if (surface) return { pane: p, surface }
  }
  return null
}

// computeWorkerPaneIds(t, workspaceId, initialSurfaceId, records) ->
// { paneIds: Set<string>, unresolvablePaneId: string|null }. Both exclusion
// keys are UUID-derived (D4): the initial pane is located via
// initial_surface_id (NEVER initial_pane_id); every OTHER worker pane comes
// from a dispatch record (terminated included) whose surface.workspace_id
// equals the live bound workspace id AND whose surface.pane_id resolves in
// the current tree. A record with surface:null (created, never bound)
// contributes nothing — it cannot hold a browser. The first record whose
// pane id fails to resolve is reported back (drives
// preview_topology_unverifiable's remediation clause).
function computeWorkerPaneIds(t, workspaceId, initialSurfaceId, records) {
  const paneIds = new Set()
  let unresolvablePaneId = null

  const ws = findWorkspaceInTree(t, workspaceId)
  if (ws && initialSurfaceId) {
    const found = findSurfaceInWorkspace(ws, initialSurfaceId)
    if (found) paneIds.add(found.pane.id)
  }

  for (const record of records) {
    const surface = record.surface
    if (!surface || !surface.pane_id) continue
    if (surface.workspace_id !== workspaceId) continue
    const pane = findPaneById(t, surface.pane_id)
    if (pane) {
      paneIds.add(pane.id)
    } else if (unresolvablePaneId === null) {
      unresolvablePaneId = surface.pane_id
    }
  }

  return { paneIds, unresolvablePaneId }
}

// freeBrowserSurfaceIds(t, workspaceId, workerPaneIds, excludeSurfaceId) ->
// string[]. Every browser-typed surface in the bound workspace whose pane is
// NOT in the worker-pane set, in tree order.
function freeBrowserSurfaceIds(t, workspaceId, workerPaneIds, excludeSurfaceId) {
  const ws = findWorkspaceInTree(t, workspaceId)
  if (!ws) return []
  const free = []
  for (const pane of ws.panes || []) {
    if (workerPaneIds.has(pane.id)) continue
    for (const surface of pane.surfaces || []) {
      if (surface.type === 'browser' && surface.id !== excludeSurfaceId) {
        free.push(surface.id)
      }
    }
  }
  return free
}

// isValidSidecarSurface(t, sidecar, workspaceId, workerPaneIds) -> boolean.
// Outcome 1 (D4): the recorded surface must be corroborated against a FRESH
// tree (never trust the sidecar alone — errata E8) AND its workspace_id must
// equal the live binding (errata E8) — a stale sidecar left by a recreated
// workspace must never be trusted just because the file parses. be-12-02
// fix-round item 2: a sidecar surface whose pane is IN the worker-pane set
// (e.g. a stale/planted sidecar naming a rung-2 mountDocTab doc-tab surface)
// must also be rejected — reusing it would reach the exact data-loss outcome
// (a future goto navigating a rendered worker document away) the "no adopt"
// design decision (architecture-package-v2.md §3 D4) exists to prevent,
// through the reuse door instead of the create door.
function isValidSidecarSurface(t, sidecar, workspaceId, workerPaneIds) {
  if (!sidecar || sidecar.workspace_id !== workspaceId) return false
  const ws = findWorkspaceInTree(t, workspaceId)
  if (!ws) return false
  const found = findSurfaceInWorkspace(ws, sidecar.surface_id)
  if (!found || found.surface.type !== 'browser') return false
  if (workerPaneIds.has(found.pane.id)) return false
  return true
}

// formatPreviewFailClosedLine({ strayUuids, unresolvablePaneId }) -> string.
// The frozen E3 shape — this IS the entire recovery mechanism for a
// fail-closed skip (it does not self-heal: every later dispatch re-scans,
// re-sees the same stray surface(s), and re-skips). Exported so tests
// byte-pin the actual log line against THIS function's output, never a
// re-typed literal.
export function formatPreviewFailClosedLine({ strayUuids, unresolvablePaneId }) {
  const leading = unresolvablePaneId
    ? `dispatch record's pane ${unresolvablePaneId} no longer resolves in the live tree; `
    : ''
  // `cmux close-surface <uuid>` never closes a browser surface on 0.64.22
  // (invalid_state: Cannot close the last surface, live-verified in every
  // configuration, see live-pass-findings.md F2); `browser <uuid> tab
  // close` succeeds in every configuration.
  const closeCommands = strayUuids.map((id) => `cmux browser ${id} tab close`).join(' · ')
  // The justification clause is deliberately build-agnostic: "both
  // undrivable" was live-falsified on 0.64.22 build 102 (F3) — the
  // fail-closed rule stands on the stacking itself (a second create lands
  // as a tab in an existing pane; a wrong adopt could navigate a rendered
  // document away, ADR-019).
  return `ensurePreviewBrowser: ${leading}${strayUuids.length} browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (it would stack into an existing pane; fail-closed per ADR-019). Preview is disabled for this task until they are closed: ${closeCommands}`
}

// ensurePreviewBrowser({ paths, workspaceId, initialSurfaceId, url }) ->
// { state: 'reused'|'created'|'skipped', reason? }. Never throws for an
// ordinary singleton outcome — RecordLockError is caught here and mapped to
// preview_lock_contended; any OTHER error (e.g. a bounded tree/browserOpen
// spawn failing inside the section) propagates to the caller, which is
// itself wrapped in a try/catch that logs and continues (dispatchCmd) — a
// preview failure never fails a dispatch. be-12-02 fix-round item 1: there
// is deliberately NO capability pre-check here — `browser` is a multi-method
// family with no single confirmed RPC method literal to gate on (D1,
// architecture-package-v2.md §3; a verb whose RPC method is unconfirmed is
// "unverifiable-by-capabilities, never gated" per architecture-notes.md's
// ratified doctrine). If browser support is genuinely absent on some cmux
// install, `browserOpen` (cmuxctl.mjs) fails its spawn/parse and returns
// null, which is handled below by returning { state: 'skipped' } with no
// reason — that fallback is the ONLY gate.
export function ensurePreviewBrowser({ paths, workspaceId, initialSurfaceId, url }) {
  const sidecarPath = join(paths.stateDir, PREVIEW_BROWSER_SIDECAR_NAME)

  let result
  try {
    result = withRecordLock(sidecarPath, () => {
      // --- bounded critical section: see the invariant comment above. ---
      const scanTree = tree({ all: true, timeoutMs: PREVIEW_LOCK_SCAN_TREE_TIMEOUT_MS })
      const { paneIds: workerPaneIds, unresolvablePaneId } = computeWorkerPaneIds(scanTree, workspaceId, initialSurfaceId, listRecords(paths.dispatchDir))

      const sidecar = readJsonOrWarn(sidecarPath, PREVIEW_BROWSER_SIDECAR_NAME)
      if (isValidSidecarSurface(scanTree, sidecar, workspaceId, workerPaneIds)) {
        return { state: 'reused' }
      }

      const free = freeBrowserSurfaceIds(scanTree, workspaceId, workerPaneIds, null)
      if (free.length > 0) {
        log(formatPreviewFailClosedLine({ strayUuids: free, unresolvablePaneId }))
        return { state: 'skipped', reason: unresolvablePaneId ? 'preview_topology_unverifiable' : 'preview_surface_ambiguous' }
      }

      // Zero free browsers, no valid record — create (D4 outcome 2).
      const opened = browserOpen(url, { workspaceId, treeBefore: scanTree })
      if (!opened) {
        // browserOpen degraded loudly already (code-only stderr line) —
        // nothing to abandon (nothing was created), nothing to stamp.
        return { state: 'skipped' }
      }
      const { surfaceId, paneId, treeAfter } = opened

      // Post-create checks, BOTH decided here on treeAfter; on either
      // verdict the section exits WITHOUT stamping and the abandon close
      // runs after release (errata E2).
      const { paneIds: workerPaneIdsAfter } = computeWorkerPaneIds(treeAfter, workspaceId, initialSurfaceId, listRecords(paths.dispatchDir))
      if (workerPaneIdsAfter.has(paneId)) {
        return { abandon: true, surfaceId, reason: 'preview_landed_in_worker_pane' }
      }
      const paneAfter = findPaneById(treeAfter, paneId)
      const browserSurfacesInPane = (paneAfter?.surfaces || []).filter((s) => s.type === 'browser')
      const stillFreeElsewhere = freeBrowserSurfaceIds(treeAfter, workspaceId, workerPaneIdsAfter, surfaceId)
      if (browserSurfacesInPane.length !== 1 || stillFreeElsewhere.length > 0) {
        return { abandon: true, surfaceId, reason: 'preview_double_create_detected' }
      }

      writeJsonAtomic(sidecarPath, {
        surface_id: surfaceId.toLowerCase(),
        pane_id: paneId.toLowerCase(),
        workspace_id: workspaceId.toLowerCase(),
        origin: originOf(url),
        created_at: new Date().toISOString(),
      })
      return { state: 'created' }
    })
  } catch (err) {
    if (err instanceof RecordLockError) {
      log('ensurePreviewBrowser: browser.json.lock is held by another dispatch — skipping the preview for this dispatch')
      return { state: 'skipped', reason: 'preview_lock_contended' }
    }
    throw err
  }

  if (result.abandon) {
    // The abandonOrphan shape: "close attempted", never "closed" (errata
    // E2) — deliberately outside the critical section. closeSurface itself
    // is unbounded by design (accepted residual A14, architecture-package-
    // v2.md errata E11) — this call is best-effort and never awaited on a
    // bound.
    closeSurface(result.surfaceId)
    const label = result.reason === 'preview_landed_in_worker_pane' ? 'landed inside a worker pane (stacked onto a doc tab)' : 'a racer won despite the lock'
    log(`ensurePreviewBrowser: abandoning newly-created surface ${result.surfaceId} — ${label}; close attempted (${result.reason})`)
    return { state: 'skipped', reason: result.reason }
  }
  return result
}

// ---------------------------------------------------------------------------
// dependency prep — dispatcher-side, before the worker's kickoff, never a
// worker grant (ADR-013 named consequence 1). `prepCommands` is an array of
// argv arrays ([cmd, ...args]) so no shell is ever invoked.
// ---------------------------------------------------------------------------

function runDependencyPrep(worktreePath, prepCommands) {
  const logLines = []
  for (const command of prepCommands) {
    if (!Array.isArray(command) || command.length === 0 || !command.every((t) => typeof t === 'string')) {
      throw new UsageError(`worktree_prep entries must be non-empty argv arrays of strings: ${JSON.stringify(command)}`)
    }
    const res = spawnSync(command[0], command.slice(1), { cwd: worktreePath, encoding: 'utf8' })
    logLines.push(`$ ${command.join(' ')}`)
    if (res.stdout) logLines.push(res.stdout.trimEnd())
    if (res.stderr) logLines.push(res.stderr.trimEnd())
    const status = res.status ?? (res.error ? 1 : 0)
    if (status !== 0) {
      return { ok: false, log: logLines.join('\n') }
    }
  }
  return { ok: true, log: logLines.join('\n') }
}

// ---------------------------------------------------------------------------
// Adapter launch line — what actually gets typed into the pane. This is the
// launch contract be-1c-04's adapter-claude.mjs documents: `<execPath>
// <pluginRoot>/scripts/cmux/adapter-claude.mjs run <recordPath>`. Composed
// here (not inline at the sendLine call site) so it is independently
// unit-testable and so a hostile component is refused with a NAMED cause —
// sendLine's own assertSafeLine (cmuxctl.mjs) would otherwise catch the same
// hazard only as an opaque "interpolated path failed the charset check"
// symptom. process.execPath (never the bare string 'node') is the dispatcher
// process's own node — the pane's shell PATH is not ours to assume.
// ---------------------------------------------------------------------------

const ADAPTER_LAUNCH_CHARSET_RE = /^[A-Za-z0-9._/-]+$/

export function adapterLaunchLine({ execPath, pluginRoot, recordPath }) {
  for (const [name, value] of [['execPath', execPath], ['pluginRoot', pluginRoot], ['recordPath', recordPath]]) {
    if (typeof value !== 'string' || !ADAPTER_LAUNCH_CHARSET_RE.test(value)) {
      throw new Error(`adapterLaunchLine: refused — ${name} contains a character outside ^[A-Za-z0-9._/-]+$: ${JSON.stringify(value)}`)
    }
    if (!value.startsWith('/')) {
      throw new Error(`adapterLaunchLine: refused — ${name} must be an absolute path (leading '/'): ${JSON.stringify(value)}`)
    }
  }
  const adapterPath = join(pluginRoot, 'scripts', 'cmux', 'adapter-claude.mjs')
  return `${execPath} ${adapterPath} run ${recordPath}`
}

// ---------------------------------------------------------------------------
// dispatch — the 11-step sequence (see acceptance criteria).
// ---------------------------------------------------------------------------

export function dispatchCmd(args, ctx) {
  const { roots, paths, roster, primaryCheckout, repoSlug, taskSlug, pluginRoot, config } = ctx
  // issue #12/D8 — read fresh on every dispatch, beside the other config.md
  // readers; the browser-preview trigger's first conjunct needs it.
  const configText = readConfigText(primaryCheckout)

  if (!args.slice || !args.role || !args.spec) {
    throw new UsageError('dispatch requires --slice <slice_id> --role <role> --spec <path>')
  }
  const role = args.role
  const sliceId = args.slice
  const specPath = resolvePath(args.spec)

  // (1) resolve the role and refuse if it is not pane-enabled (Phase-1 gate).
  const resolved = roster.roles[role]
  if (!resolved) {
    throw new OperationalError(`refused: unknown role ${JSON.stringify(role)}`)
  }
  if (!resolved.pane || !PANE_ROLES.includes(role)) {
    throw new OperationalError(`refused: role ${JSON.stringify(role)} is not pane-enabled in this rollout (PANE_ROLES: ${PANE_ROLES.join(', ')})`)
  }

  // trust S4: --spec must resolve to EXACTLY specPathFor(paths, sliceId) —
  // never an arbitrary path. Without this, the audit trail (record.spec_path,
  // always specPathFor-derived) could name a different file than the one
  // whose validation_commands were actually expanded into the worker's Bash
  // grants moments later. #7's entry branch copies specs into specDir before
  // dispatching, so this is never a caller-facing burden beyond that copy.
  const requiredSpecPath = specPathFor(paths, sliceId)
  if (specPath !== requiredSpecPath) {
    throw new OperationalError(`refused: --spec must be exactly ${requiredSpecPath} (got ${specPath})`)
  }
  if (!existsSync(specPath)) {
    throw new UsageError(`--spec path does not exist: ${specPath}`)
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))

  // A2 (#27) — the unskippable schema-derived spec floor, hoisted above the
  // workspace.json read below. This placement is load-bearing, not
  // stylistic: the workspace-liveness check makes a real `tree({all:true})`
  // cmux call, and writeRecord/ensureWorktree/snapshotWorkerPlugin all run
  // further down. Gating here is what makes a schema-invalid dispatch a
  // ZERO-cmux-invocation, no-record-on-disk refusal.
  //
  // Gated on the resolved profile's CAPABILITY, not its name.
  // roster.schema.json leaves `profile` an open string (no enum) — a
  // project/user roster override could rename/redefine whatever profile a
  // role points at while leaving the role pane-enabled, which would let the
  // literal string 'executor' be silently bypassed. buildRecord (record.mjs,
  // ~line 505) resolves the identical roster.profiles[resolved.profile]
  // lookup to read profile.allow; this mirrors that lookup rather than
  // re-deriving it. A role whose resolved profile grants 'worktree_write' —
  // the same allow-list literal record.mjs treats as write-capable — is
  // gated here regardless of what its profile is named; a role without that
  // grant (judgment/validator today) takes a byte-identical path to before
  // this change.
  const profileDef = roster.profiles[resolved.profile]
  const isWriteCapable = Boolean(profileDef && Array.isArray(profileDef.allow) && profileDef.allow.includes('worktree_write'))
  let specWarnings
  if (isWriteCapable) {
    // Before lintSpec: a non-plain-object spec (e.g. a spec file that parses
    // as JSON `null`, a bare array, or a bare number/string — a truncated or
    // corrupted spec file can produce any of these from otherwise-valid
    // JSON) is refused directly here, synthesizing the same SpecSchemaError
    // shape lintSpec's own schema check would produce, instead of calling
    // lintSpec at all. spec-lint.mjs's documented contract is "instance data
    // problems are always returned as diagnostics, never thrown", but its
    // schema check assumes an object-shaped instance and throws a raw
    // TypeError on anything else — this guard restores that contract from
    // the caller side without editing spec-lint.mjs (out of scope).
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new SpecSchemaError([{ check: 'schema', detail: 'spec must be a JSON object' }])
    }
    // A lintSpec THROW past this point is a packaging error (a corrupt
    // shipped schema file or noise-globs.json), the one thing the guard
    // above does not cover — deliberately NOT caught. This IS the gate, so
    // catching it here would fail it open; a different consumer of lintSpec
    // might reasonably choose to downgrade the same throw to an advisory
    // report, but that tradeoff does not apply to a gate whose whole job is
    // to fail closed.
    const lint = lintSpec(spec, primaryCheckout)
    const refusals = lint.failures.filter((f) => f.check === SPEC_LINT_SCHEMA_CHECK)
    if (refusals.length > 0) throw new SpecSchemaError(refusals)
    specWarnings = [
      ...lint.failures.filter((f) => f.check !== SPEC_LINT_SCHEMA_CHECK).map((f) => ({ ...f, severity: 'fail' })),
      ...lint.warnings.map((w) => ({ ...w, severity: 'warn' })),
    ]
  }

  // lifecycle M1/M2-E: the workspace.json read AND a fresh-tree liveness
  // check are hoisted ABOVE any record write. A no-workspace dispatch or a
  // dispatch against a workspace.json left stale by a cmux restart now
  // refuses here — before writeRecord, before ANY cmux invocation beyond
  // the one `tree` call the liveness check itself makes, and crucially
  // before a record ever exists on disk to strand in create state.
  const workspaceStatePath = join(paths.stateDir, 'workspace.json')
  const workspaceState = readJsonOrWarn(workspaceStatePath, 'workspace.json')
  if (!workspaceState) {
    throw new OperationalError('refused: no workspace bound for this task — run `workspace` first')
  }
  const liveTree = tree({ all: true })
  const liveWindow = (liveTree.windows || []).find((w) => w.id === workspaceState.window_id)
  const liveWorkspace = liveWindow?.workspaces?.find((w) => w.id === workspaceState.workspace_id)
  if (!liveWorkspace) {
    throw new OperationalError('refused: stale workspace — re-run workspace')
  }

  // lifecycle: the max_turns refusal is hoisted ABOVE any worktree/snapshot
  // write, mirroring the workspace-liveness hoist above — before
  // ensureWorktree, before snapshotWorkerPlugin, before a worktree/branch/
  // worktrees.json entry/snapshot dir ever exists on disk for this dispatch
  // to strand as leaked state. See ADR-017 in architecture-notes.md.
  resolveMaxTurnsOrThrow({ config, resolved, defaults: roster.defaults })

  // (2) derive the attempt.
  const attempt = args.attempt ? Number(args.attempt) : nextAttempt(paths.dispatchDir, sliceId)

  // (3) create-or-reuse the worktree when isolation is 'worktree'.
  const dispatchId = newDispatchId()
  let worktreeInfo = null
  if (resolved.isolation === 'worktree') {
    worktreeInfo = ensureWorktree({
      roots, repoSlug, taskSlug, sliceId, primaryCheckout, dispatchId,
      worktreesIndexPath: paths.worktreesIndexPath,
    })
  }

  const roles = roster.roles
  const profiles = roster.profiles
  const snapshot = snapshotWorkerPlugin({ pluginRoot, snapshotDir: snapshotDirFor(paths, dispatchId), roles, profiles })

  const recordCtx = {
    roots, paths, roster, resolved, pluginRoot,
    taskId: taskSlug, taskSlug, repoSlug, primaryCheckout, snapshot,
    config: {
      createdByDispatcher: worktreeInfo ? worktreeInfo.created_by_dispatcher : undefined,
      sourceSliceId: worktreeInfo ? worktreeInfo.source_slice_id : undefined,
      maxGateBlocks: config.maxGateBlocks,
      timeoutS: config.timeoutS,
      maxTurns: config.maxTurns,
    },
    now: Date.now(),
    dispatchId,
    attnUpstream: config.attnUpstream || null,
  }

  const record = buildRecord(recordCtx, { role, sliceId, attempt, spec })
  const stem = stemOf(sliceId, attempt)
  const recordPath = join(paths.dispatchDir, `${stem}.json`)

  // lifecycle S12: roster.snapshot.json is written ONCE, at first dispatch
  // (atomic, create-if-absent — a later dispatch in the same task never
  // overwrites it). status/close read role info from this snapshot in
  // preference to the live, mutable roster, so an edit to
  // .claude/dev-team/roster.json between dispatch and close cannot flip
  // doc_tab (or anything else) out from under an already-dispatched record.
  if (!existsSync(paths.rosterSnapshotPath)) {
    writeJsonAtomic(paths.rosterSnapshotPath, roster)
  }

  // (4) buildRecord + writeRecord (state create) + initGateCounter.
  // writeRecord itself throws StaleReturnError (a leftover return at
  // return_path) or a plain Error (an occupied record path, i.e. its own
  // exclusive-create EEXIST loser) — both are the ONLY two cases that get
  // the "bump --attempt" remedy; any other failure (EACCES, ENOSPC, ...)
  // surfaces verbatim rather than sending an operator down the wrong path.
  try {
    writeRecord(record, recordPath)
  } catch (err) {
    const isAttemptCollision = err instanceof StaleReturnError || /a record already exists at/.test(err.message)
    throw new OperationalError(isAttemptCollision ? `refused: ${err.message} (bump --attempt to remedy)` : `refused: ${err.message}`)
  }
  const sidecars = sidecarPaths(paths, dispatchId)

  // (5)-(7): parent-render the placeholder, create the pane, and bind — all
  // inside one try/catch. lifecycle M2-E: any failure in this window (a
  // failed doc-tab placeholder write, `new-pane` failing, a bind race) must
  // never leave the record stranded in an unbound, non-terminable create
  // state — it is terminated 'aborted' (allowUnbound: true, since bind never
  // happened). trust S6: the doc-tab placeholder is written with { flag:
  // 'wx' } — a pre-planted symlink at that path (the worker knows task_dir
  // and the next stem) is refused, never followed.
  const icon = resolved.icon || roster.defaults.icon || 'robot'
  let bound
  let paneId
  let surfaceId
  try {
    // (5) parent-render the placeholder returns/<stem>.md for doc-tab roles only.
    if (resolved.doc_tab) {
      const placeholderPath = renderPathFor(record)
      mkdirSync(dirname(placeholderPath), { recursive: true })
      writeFileSync(placeholderPath, `# ${icon} ${role} — working…\n`, { flag: 'wx' })
    }

    // (6) create the pane. The workspace's own initial surface is reserved
    // for the workspace itself (created by `workspace`, never reused by a
    // dispatch) — every dispatch gets its own dedicated pane via createPane.
    const created = createPane({ workspaceId: workspaceState.workspace_id })
    paneId = created.paneId
    surfaceId = created.surfaceId

    // (7) bindRecord with the pane/surface/workspace ids.
    bound = bindRecord(recordPath, {
      workspace_id: workspaceState.workspace_id, pane_id: paneId, surface_id: surfaceId,
    })
  } catch (err) {
    terminateRecord(recordPath, 'aborted', Date.now(), { allowUnbound: true })
    unlinkIfExists(sidecars.nonce)
    throw new OperationalError(`refused: dispatch aborted before bind (${err.message})`)
  }

  // Dependency prep runs dispatcher-side, in the fresh worktree, before the
  // kickoff — never a worker grant. Absent config = no prep, no error.
  // trust S6: the prep log is written with { flag: 'wx' } too.
  const prepCommands = config.worktree_prep
  if (Array.isArray(prepCommands) && prepCommands.length > 0) {
    if (!worktreeInfo) {
      throw new OperationalError('refused: worktree_prep configured but role isolation is not "worktree"')
    }
    const prep = runDependencyPrep(worktreeInfo.path, prepCommands)
    const logPath = join(paths.logsDir, `${stem}.prep.log`)
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, prep.log, { flag: 'wx' })
    if (!prep.ok) {
      closeSurface(surfaceId)
      terminateRecord(recordPath, 'aborted')
      // trust M3 / D-2: the nonce has not been written yet at this point
      // (it moves to immediately before sendLine, below) — this unlink is
      // therefore a no-op today, but it is kept so this abort path stays
      // correct if the nonce's write site ever moves earlier again.
      unlinkIfExists(sidecars.nonce)
      throw new OperationalError(`refused: worktree_prep failed in ${worktreeInfo.path} — see ${logPath}`)
    }
  }

  // (8) rename-tab to '{icon} {role} · {model}'.
  renameTab(surfaceId, `${icon} ${role} · ${resolved.model}`)

  // trust M3 / D-2 (pinned 2026-08-02): the completion nonce is written as
  // LATE as possible — immediately before the kickoff that actually starts
  // the worker — rather than at record-create time. This minimizes the
  // window in which the nonce sits on disk (still G13-reachable by a
  // sibling dispatch's own Bash subprocess; the ladder re-derivation is the
  // real control, this only shrinks the residual). Never logged, never
  // returned, never placed in argv/env/kickoff/task dir.
  writeCompletionNonce(sidecars.nonce)

  // (9) sendLine the adapter launch line (send THEN send-key enter — cmuxctl
  // owns this) — this is what actually starts an agent in the pane;
  // record.kickoff itself is unchanged and reaches the model via
  // adapter-claude.mjs's buildArgv-derived `--` positional, not the pane
  // shell. trust M3 residual (i): a sendLine refusal (its own charset gate,
  // or adapterLaunchLine's own refusal above it) must not leave the nonce on
  // disk against an unterminated record — the record is already bound at
  // this point, so no allowUnbound is needed. The cleanup itself is wrapped
  // separately: every field the kickoff embeds (task_dir/spec_path/
  // return_path/signals_path via frozen path charsets, attn_parent/
  // attn_upstream via the frozen devteam-<uuid>-attn pattern) is
  // independently charset-constrained upstream, and pluginRoot/recordPath are
  // both resolvePath-derived, so this throw path has no known reachable
  // trigger through the public CLI today — it exists for defense-in-depth
  // against a future kickoff/launch-composition change, and must not itself
  // crash uninformatively if a secondary failure (e.g. the record having
  // become otherwise unreadable) hits terminateRecord.
  try {
    sendLine(surfaceId, adapterLaunchLine({ execPath: process.execPath, pluginRoot, recordPath }))
  } catch (err) {
    unlinkIfExists(sidecars.nonce)
    try {
      terminateRecord(recordPath, 'aborted')
    } catch (terminateErr) {
      log(`dispatch: sendLine failed and the abort-terminate itself failed: ${terminateErr.message}`)
    }
    throw new OperationalError(`refused: sendLine failed after bind (${err.message})`)
  }

  // (10) mount the doc tab for doc_tab roles.
  if (resolved.doc_tab) {
    mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId: surfaceId })
  }

  // (10.5) issue #12/D7 (ADR-019) — the opt-in browser preview singleton.
  // Three conjuncts, ALL required: (1) cmux_preview_url resolves to a URL,
  // (2) spec.domain === 'frontend' EXACTLY, (3) this role's isolation is
  // 'worktree'. be-12-02 fix-round item 1: there is deliberately no fourth
  // capability-gate conjunct — see ensurePreviewBrowser's own header comment.
  // This whole block is inside a try/catch that logs and continues — a
  // preview failure NEVER fails a dispatch. Per errata E6, `preview` stays
  // `undefined` (and is therefore OMITTED from the returned JSON below)
  // unless conjuncts 1-3 all hold — i.e. unless an attempt was actually
  // made. This is what keeps AC1's byte-identity when cmux_preview_url is
  // absent, and keeps a backend-domain or non-worktree-role dispatch's JSON
  // identical too.
  let preview
  try {
    const previewUrl = readCmuxPreviewUrl(configText)
    if (previewUrl && spec?.domain === 'frontend' && resolved.isolation === 'worktree') {
      try {
        preview = ensurePreviewBrowser({
          paths,
          workspaceId: workspaceState.workspace_id,
          initialSurfaceId: workspaceState.initial_surface_id,
          url: previewUrl,
        })
      } catch (err) {
        log(`dispatch: browser preview setup failed — continuing without a preview: ${err.message}`)
        preview = { state: 'skipped' }
      }
    }
  } catch (err) {
    log(`dispatch: cmux_preview_url could not be read — continuing without a preview: ${err.message}`)
  }

  // S9 phase pill: a successful dispatch is the 'building' phase. This
  // runs AFTER sendLine/bindRecord — a worker is already live at this
  // point, so an unguarded throw here (however unlikely today) must never
  // report a failed dispatch for a live worker. Swallowed and logged loudly.
  try {
    setPhase('building', { workspaceId: workspaceState.workspace_id })
  } catch (err) {
    log(`dispatch: setPhase('building') failed — phase pill not updated: ${err.message}`)
  }

  // (11) print result and exit — non-blocking, never waits for the worker.
  return {
    code: 0,
    json: {
      dispatch_id: bound.dispatch_id,
      workspace_id: workspaceState.workspace_id,
      pane_id: paneId,
      surface_id: surfaceId,
      attempt,
      attn_parent: bound.attn_parent,
      timeout_s: bound.timeout_s,
      ...(preview !== undefined ? { preview } : {}),
      ...(specWarnings !== undefined ? { warnings: specWarnings } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// await — poll-first, chunked, single-writer.
// ---------------------------------------------------------------------------

function unlinkIfExists(path) {
  try {
    unlinkSync(path)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function findRecordByDispatchId(dispatchDir, dispatchId) {
  return listRecords(dispatchDir).find((r) => r.dispatch_id === dispatchId) || null
}

function defaultSleep(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

// ---------------------------------------------------------------------------
// be-11-03 — stateless stall triage. No persisted sidecar, no CPU polling: a
// dispatch's turnEndAt is re-derived fresh on every await()/status() call
// from a single bounded events read, attributed to a dispatch by an EXACT
// surface_id match. A doorbell that names the sleeper (agent.hook.Stop DOES
// carry a top-level UUID surface_id) still only triggers a rescan and an
// advisory attention flag — never a completion decision; classify()'s
// completion predicate is untouched.
// ---------------------------------------------------------------------------

// readTurnEndEvents() -> { events, seq } | { unavailable: true }. A single
// bounded, cursor-free full-buffer read filtered server-side (best-effort —
// the fixture ignores --name entirely, and even a real cmux daemon's --name
// filtering only narrows WHICH events count toward --limit, see below) to
// TURN_END_EVENT_NAME. Event ids/seqs are boot-scoped: a PERSISTED --after
// cursor would silently suppress every new event for the rest of the task
// across a cmux restart, so this never persists or reuses one across calls
// — but it DOES pass `--after 0` explicitly every time (QA-fix round 2,
// live-verified against cmux 0.64.22 — see cmuxctl.mjs's readEvents()):
// omitting --after entirely is NOT the same as "replay everything
// retained" — live-verified that a bare `cmux events --limit N` (no
// --after at all) skips retained backlog completely and blocks waiting
// ONLY for brand-new live events (a real capture: a live event that had
// just fired 14.2s earlier was still not returned without --after, while
// `--after 0 --limit N` against the identical backlog returned in 0.02s).
// `--after 0` is boot-safe by construction — 0 is always a valid starting
// point since ids/seqs restart from a low number on every boot, so
// "replay from 0" is simply "replay everything currently retained,"
// never stale, with no persisted-cursor cross-restart hazard at all.
//
// QA-fix (be-11-03 gate, live-verified against cmux 0.64.22 — see
// cmuxctl.mjs's readEvents() for the full capture): `cmux events --limit N`
// is a STREAMING primitive that BLOCKS until N frames are observed — it
// does not return early with a partial snapshot when retained backlog has
// fewer than N. A --name-filtered limit is blocked-by-default in practice
// (agent.hook.Stop is far rarer than the general event stream), which is
// exactly what made the ORIGINAL --limit 2000 / timeoutMs 5000 combination
// here silently non-functional in production: every await() call would
// burn the full 5s timeout twice (10s total) and declare events
// permanently unavailable, because backlog essentially never contains 2000
// matching Stop events. The fix: `--limit` here is now a soft cap only
// (readEvents() treats the caller's own spawnSync timeout — not --limit
// satisfaction — as the real, expected bound, and preserves whatever
// partial output was captured before a timeout-triggered kill). `limit:
// 500` stays for two reasons: it satisfies the fixture's "--after and/or
// --limit required" gate, and it lets a well-satisfied unfiltered read
// (the no---name retry) exit early rather than waiting the full timeout.
// `timeoutMs: 2000` (down from 5000) bounds the worst-case per-attempt
// wait to a value comfortably above every live-verified backlog-satisfied
// read time (well under 1s for thousands of events) without imposing a
// long stall on the genuinely-idle case. A --name-filtered call that comes
// back `unavailable` (a REAL failure, never merely "timed out with
// events") is retried ONCE without --name before events are declared
// unavailable for this call.
function readTurnEndEvents() {
  let evRes = readEvents({ afterSeq: 0, name: TURN_END_EVENT_NAME, limit: 500, timeoutMs: 2000 })
  if (evRes.unavailable) {
    log('events: cmux events --name-filtered read failed — retrying once without --name before declaring events unavailable')
    evRes = readEvents({ afterSeq: 0, limit: 500, timeoutMs: 2000 })
  }
  return evRes
}

// deriveTurnEndAt(records, rawEvents) -> { [dispatch_id]: isoOccurredAt }.
// Attribution is an EXACT surface_id match against NON-TERMINAL records
// (record.outcome === null && record.surface !== null) — never cwd, never a
// workspace-wide "arm everyone" fallback. Two non-terminal records
// constructed to share a surface_id fail CLOSED: NEITHER arms, and one
// `surface_id_collision` line is logged — mirroring findDocTabSurface's own
// ambiguity doctrine. Every matching event (both 'received' and 'completed'
// phase, unfiltered — the phase enum is not verified closed) folds via
// max(occurred_at); double-counting is harmless. The name filter is applied
// PER EVENT via parseTurnEndEvent regardless of whether the server honored
// --name (the fixture does not) — this is the mandatory client-side
// re-filter, and it is what actually keeps a non-Stop event (e.g.
// notification.requested, which also carries an id) from arming anything.
function deriveTurnEndAt(records, rawEvents) {
  const bySurface = new Map()
  // QA fix (#14): count every non-terminal record sharing a surface_id, not
  // just "two" — the fail-closed logic below already generalizes to N>=3,
  // the log line now reports the real count instead of a hardcoded one.
  const countBySurface = new Map()
  for (const record of records) {
    if (record.outcome !== null && record.outcome !== undefined) continue
    if (!record.surface) continue
    const sid = record.surface.surface_id
    countBySurface.set(sid, (countBySurface.get(sid) || 0) + 1)
    if (!bySurface.has(sid)) bySurface.set(sid, record.dispatch_id)
  }
  for (const [sid, count] of countBySurface) {
    if (count > 1) {
      bySurface.delete(sid)
      log(`surface_id_collision: ${count} non-terminal dispatches share surface_id ${sid} — attention armed for none of them`)
    }
  }

  const turnEndAt = {}
  for (const rawEvent of rawEvents || []) {
    const parsed = parseTurnEndEvent(rawEvent)
    if (!parsed) continue
    const dispatchId = bySurface.get(parsed.surfaceId)
    if (!dispatchId) continue
    const prior = turnEndAt[dispatchId]
    if (!prior || Date.parse(parsed.occurredAt) > Date.parse(prior)) {
      turnEndAt[dispatchId] = parsed.occurredAt
    }
  }
  return turnEndAt
}

const AWAIT_TICK_MS_DEFAULT = 4000
const AWAIT_CAP_DEFAULT_S = 120
const AWAIT_CAP_MIN_S = 5
const AWAIT_CAP_MAX_S = 600
const AWAIT_LOCK_STALE_MULTIPLIER = 2

// lifecycle S2: the await lock is acquired via exclusive-create ('wx'), the
// same primitive record.mjs's withRecordLock uses for a record's own lock —
// no check-then-act window. A lock that is missing, unparseable, or older
// than 2x the requested cap is STALE and is broken (logged, unlinked) rather
// than treated as a wedge; an unparseable lock is never a throw. Only the
// FIRST attempt may steal a stale lock — a second EEXIST after that refuses
// cleanly rather than looping.
function tryAcquireAwaitLock(lockPath, holder, capS) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' })
      return { acquired: true }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const existing = readJsonOrWarn(lockPath, 'await.lock')
      const startedMs = existing ? Date.parse(existing.started_at) : NaN
      const isStale = !existing || !Number.isFinite(startedMs) || Date.now() - startedMs > capS * AWAIT_LOCK_STALE_MULTIPLIER * 1000
      if (attempt === 0 && isStale) {
        log(`await: breaking ${existing ? `stale lock held by pid ${existing.pid}` : 'an unparseable/corrupt lock'} at await.lock`)
        unlinkIfExists(lockPath)
        continue
      }
      return { acquired: false, holder: existing }
    }
  }
  return { acquired: false, holder: readJsonOrWarn(lockPath, 'await.lock') }
}

// awaitCmd(args, ctx, deps) -> { code, json }. deps = { now, sleep, tickMs }
// are overridable so tests never sleep real wall-clock time; production
// callers get real Date.now / a real settle via SharedArrayBuffer+Atomics.
export function awaitCmd(args, ctx, deps = {}) {
  const { paths } = ctx
  const now = deps.now || Date.now
  const sleep = deps.sleep || defaultSleep
  const tickMs = deps.tickMs ?? AWAIT_TICK_MS_DEFAULT

  const ids = args.all
  if (!ids || ids.length === 0) {
    throw new UsageError('await requires --all <dispatch_id...>')
  }

  // lifecycle S1: a non-finite --max-block-s (a non-numeric string, NaN)
  // must never reach the elapsed/cap comparisons below — Number('abc') is
  // NaN, `elapsed >= NaN*1000` is never true, and `sleep(Math.max(NaN,0))`
  // coerces to a zero-length wait, i.e. an unbounded busy loop holding the
  // lock. A floor of 5s also keeps `--max-block-s 0` from disabling the
  // single-writer lock outright (age > 0 would break ANY lock).
  let capS = AWAIT_CAP_DEFAULT_S
  if (args['max-block-s'] !== undefined) {
    const requested = Number(args['max-block-s'])
    if (!Number.isFinite(requested)) {
      throw new UsageError(`--max-block-s must be a finite number, got ${JSON.stringify(args['max-block-s'])}`)
    }
    capS = Math.min(Math.max(requested, AWAIT_CAP_MIN_S), AWAIT_CAP_MAX_S)
  }

  const lockPath = paths.lockPath
  const startMs = now()
  const holder = { pid: process.pid, started_at: isoMs(startMs) }
  const acquireResult = tryAcquireAwaitLock(lockPath, holder, capS)
  if (!acquireResult.acquired) {
    return { code: 2, json: { error: 'lock_held', holder: acquireResult.holder } }
  }

  // be-11-02: workspace-scoped progress. `await` is the only place that
  // knows numerator (resolved) and denominator (total ids) — read the
  // workspace id once, the same way phaseCmd does, and skip progress
  // entirely (logged, not thrown) if it is absent. `label` is composed only
  // from these two counts (control-plane-safe: never a return body, never
  // screen text).
  const workspaceStateForProgress = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')
  function reportProgress(resolvedCount, totalCount) {
    if (!workspaceStateForProgress) return
    try {
      const fraction = Math.min(Math.max(resolvedCount / totalCount, 0), 1)
      setProgress(fraction, { workspaceId: workspaceStateForProgress.workspace_id, label: `${resolvedCount}/${totalCount}` })
    } catch (err) {
      log(`await: setProgress failed — progress pill not updated: ${err.message}`)
    }
  }

  try {
    // cursorPath stays written at its existing sites below (never retired)
    // but be-11-03 never passes it as --after — see readTurnEndEvents'
    // header comment. It is read here only to preserve its prior value
    // across a call that never touches events (eventsDisabled).
    let cursor = Number(readTextOrNull(paths.cursorPath)) || 0
    let eventsDisabled = false
    const remaining = new Set(ids)
    // be-11-03: turnEndAt is derived ONCE per await() invocation (below) and
    // reused across every internal tick of THIS call — there is no
    // cross-invocation state, so "once per raise" (the read-screen
    // transition fire, further down) is scoped to a single await() call.
    let turnEndAt = {}
    let previousAttentionIds = new Set()

    let isFirstTick = true
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // be-11-03: the bounded events catch-up now runs ABOVE the
      // per-dispatch loop (it used to sit after it, its result discarded
      // except for cursor advancement) so turnEndAt is available to THIS
      // tick's classify() calls. Still gated to fire once per INVOCATION
      // (on the first tick only, never once per internal polling tick) —
      // the pinned call bound only holds if a chunked join's total cmux
      // calls scale with the number of chunked await() calls, not with the
      // number of ticks inside any one of them. `eventsDisabled` is
      // write-only per call (set at most once) — its name describes "no
      // more attempts this call", not an ongoing per-tick state machine.
      if (isFirstTick && !eventsDisabled) {
        const evRes = readTurnEndEvents()
        if (evRes.unavailable) {
          eventsDisabled = true
          log("await: cmux events catch-up failed on this call's single attempt — the events channel (and attention triage with it) is unavailable for the rest of this call; every other classification is unaffected")
        } else {
          // QA fix (#7): cursorPath is vestigial (never passed as --after,
          // see readTurnEndEvents' header comment) but MUST NOT regress —
          // an empty/--name-filtered-to-empty read otherwise silently
          // writes seq back to afterSeq ?? 0. Math.max keeps it
          // monotonic even though nothing reads it today.
          cursor = Math.max(cursor, evRes.seq)
          // QA fix (#6): scan ALL non-terminal records in the task dir for
          // surface_id-collision purposes (matching statusCmd's own scan),
          // not just the ids in THIS await() call's `remaining` set — the
          // fail-closed "arm neither on collision" guarantee must hold
          // regardless of which verb happens to observe the collision.
          const attributionRecords = listRecords(paths.dispatchDir)
          turnEndAt = deriveTurnEndAt(attributionRecords, evRes.events)
        }
      }
      isFirstTick = false

      // lifecycle S3: each id's record is re-read from disk EVERY tick
      // (never cached across the loop) — a record terminated concurrently
      // by `close` or the prep-abort path must be visible on the very next
      // tick, not invisible for the rest of the cap window.
      const resolvedNow = []
      const currentAttentionIds = new Set()
      for (const id of [...remaining]) {
        const record = findRecordByDispatchId(paths.dispatchDir, id)
        if (!record) {
          remaining.delete(id)
          continue
        }
        const sidecars = sidecarPaths(paths, id)
        const fsState = collectFsState({ record, paths: { exitPath: sidecars.exit, gatePath: sidecars.gate } })
        const classification = classify({ record, fsState, tree: null, now: now(), turnEndAt: turnEndAt[id] ?? null })
        if (classification.state === 'attention') {
          currentAttentionIds.add(id)
          // be-11-03(F): read-screen fires ONLY on the TRANSITION into
          // attention — once per raise, scoped to this invocation (compare
          // against previousAttentionIds, carried across ticks of this same
          // while loop only). The reduced {lines, last_line_sha256,
          // matched[]} tuple is logged; it is never returned in JSON, never
          // persisted, and the raw frame itself never leaves this scope —
          // a screen-read failure (readScreen never throws) is silently
          // skipped, mirroring presentReturn's own posture that a
          // diagnostic failure is never a resolution failure.
          if (!previousAttentionIds.has(id) && record.surface) {
            const frame = readScreen(record.surface.surface_id, { lines: 40 })
            if (frame != null) {
              const sig = detectSignatures(frame)
              log(`await: dispatch ${id} entered attention — screen signature scan lines=${sig.lines} last_line_sha256=${sig.last_line_sha256} matched=${JSON.stringify(sig.matched)}`)
            }
          }
        }
        if (classification.state !== 'running' && classification.state !== 'attention') {
          resolvedNow.push({ id, record, classification, fsState })
        }
      }
      previousAttentionIds = currentAttentionIds

      if (resolvedNow.length > 0) {
        for (const r of resolvedNow) remaining.delete(r.id)
        writeTextAtomic(paths.cursorPath, String(cursor))
        // S8: render + present the doc tab for every dispatch that just
        // resolved 'completed', immediately before this return. Never a
        // resolution failure — presentReturn itself never throws.
        for (const r of resolvedNow) {
          if (r.classification.state === 'completed') {
            presentReturn(r.record, roleDefForRecovery(ctx, r.record.role))
          }
        }
        // NOTE (S4, resolution durability — intentionally deferred): await
        // reports a resolution but does not itself call terminateRecord —
        // `close` (or #7's own protocol) is the one that writes the
        // terminal transition. Between this return and that later `close`,
        // the return file could in principle be replaced; deciding WHO
        // terminates on await's behalf (and whether that is even safe
        // without racing a concurrent close) is #7's protocol call, not a
        // change this file makes unilaterally.
        reportProgress(ids.length - remaining.size, ids.length)
        return {
          code: 0,
          json: {
            resolved: resolvedNow.map((r) => ({ dispatch_id: r.id, state: r.classification.state, warnings: r.classification.warnings })),
            remaining: [...remaining],
            // be-11-03: an attention dispatch stays in `remaining` and NEVER
            // appears in `resolved` — attention never terminates a join and
            // never removes a dispatch from `remaining` (ADR-017: wall-clock
            // timeout_s is the only runaway bound).
            attention: [...currentAttentionIds].map((id) => ({ dispatch_id: id, since: turnEndAt[id], reason: 'quiet_after_turn_end' })),
          },
        }
      }

      const elapsedMs = now() - startMs
      if (elapsedMs >= capS * 1000) {
        writeTextAtomic(paths.cursorPath, String(cursor))
        reportProgress(ids.length - remaining.size, ids.length)
        return {
          code: 0,
          json: {
            status: 'still-running',
            remaining: [...remaining],
            attention: [...currentAttentionIds].map((id) => ({ dispatch_id: id, since: turnEndAt[id], reason: 'quiet_after_turn_end' })),
          },
        }
      }

      sleep(Math.min(tickMs, Math.max(capS * 1000 - elapsedMs, 0)))
    }
  } finally {
    // lifecycle S2: release ONLY if the on-disk lock still carries THIS
    // holder's exact pid + started_at — a superseded holder that wakes up
    // late (suspend/resume) must never delete a successor's lock.
    const current = readJsonOrWarn(lockPath, 'await.lock')
    if (current && current.pid === holder.pid && current.started_at === holder.started_at) {
      unlinkIfExists(lockPath)
    }
  }
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

// gitPorcelain(worktreePath) -> string | null. null (never '') means "could
// not be verified" (missing path, git error) — the caller must treat that
// as UNVERIFIABLE, never as a clean bill, so a gone-or-broken worktree can
// never silently pass a 'clean' postcondition.
function gitPorcelain(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' })
  } catch {
    return null
  }
}

// paneExistsInTree(liveTree, paneId) -> boolean. Mirrors cmuxctl.mjs's own
// locate() shape (tree === { windows: [{ workspaces: [{ panes: [{ id,
// surfaces }] }] }] }) without importing that module-private helper — used
// by statusCmd's re-mount guard to skip a record whose bound pane is
// already gone from the ALREADY-fetched liveTree (fix for the qa should-fix
// on the re-mount loop walking terminal/pane-gone records every poll).
function paneExistsInTree(liveTree, paneId) {
  if (!liveTree) return false
  for (const w of liveTree.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        if (p.id === paneId) return true
      }
    }
  }
  return false
}

// safeTree(dispatchId, purpose) -> tree | null. QA fix round 2 (#3):
// cmuxctl.mjs's tree() THROWS on failure rather than returning null — every
// OTHER topology read in this file's closeCmd/statusCmd already tolerates a
// wedged substrate (statusCmd wraps its own `tree({ all: true })` in a
// try/catch; presentReturn never throws), but the three collapse-on-close
// reads added by be-11-03 did not, and they all run AFTER the record is
// already marked terminal — an unguarded throw there means closeCmd never
// returns its JSON response even though the record was already correctly
// finalized on disk. One loud line, then null; every call site below
// already treats null the same as "can't confirm the doc-tab sibling" and
// falls through to the fail-closed "keep the terminal surface" branch.
function safeTree(dispatchId, purpose) {
  try {
    return tree({ all: true })
  } catch (err) {
    log(`close: dispatch ${dispatchId}: tree() failed while ${purpose} (${err.message}) — degrading to keep the terminal surface; cosmetics/collapse never fail close`)
    return null
  }
}

// findVerifiedDocTabSibling(t, {paneId, terminalSurfaceId}) -> { id, ambiguous }
// QA fix (#11, security-lens warning 3): findDocTabSurface's own "fall back
// to ANY remaining surface if no markdown one exists" behavior is fine
// everywhere else this codebase uses it (mount/reorder decisions — a wrong
// guess there only misdirects a panel, which is harmless) — but a positive
// return HERE authorizes a PERMANENT closeSurface call on the dispatch's
// terminal surface. This wrapper requires the resolved candidate to
// actually be doc-tab-typed (`markdown`, from mountDocTab rungs 1/3, or
// `browser`, from rung 2's file:// fallback) — never the broader "any
// surface" fallback — for this one high-stakes decision only.
function findVerifiedDocTabSibling(t, { paneId, terminalSurfaceId }) {
  const found = findDocTabSurface(t, { paneId, terminalSurfaceId })
  if (!found.id) return found
  const surface = (t.windows || [])
    .flatMap((w) => w.workspaces || [])
    .flatMap((ws) => ws.panes || [])
    .flatMap((p) => p.surfaces || [])
    .find((s) => s.id === found.id)
  if (!surface || (surface.type !== 'markdown' && surface.type !== 'browser')) {
    return { id: null, ambiguous: false }
  }
  return found
}

// surfaceExistsInTree(liveTree, surfaceId) -> boolean. QA fix (#4): the only
// honest way to confirm closeSurface() actually took effect, since it never
// reports success/failure itself — used to gate the .collapsed sidecar
// write on the terminal surface's CONFIRMED absence, never its mere
// attempted closure.
function surfaceExistsInTree(liveTree, surfaceId) {
  if (!liveTree) return false
  for (const w of liveTree.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        for (const s of p.surfaces || []) {
          if (s.id === surfaceId) return true
        }
      }
    }
  }
  return false
}

// lifecycle S12: role info (doc_tab, etc.) is read from roster.snapshot.json
// in PREFERENCE to the live, mutable roster — the snapshot is written once,
// at first dispatch, so an edit to the live roster after that point (or a
// live roster that no longer even parses) cannot change how an
// already-dispatched record is recovered. Falls back to the live roster,
// loudly, only when the snapshot is missing/unreadable/lacks the role.
function roleDefForRecovery(ctx, role) {
  const snapshot = readJsonOrWarn(ctx.paths.rosterSnapshotPath, 'roster.snapshot.json')
  if (snapshot && snapshot.roles && snapshot.roles[role]) {
    return snapshot.roles[role]
  }
  log(`roster.snapshot.json is missing, unreadable, or lacks role ${JSON.stringify(role)} — falling back to the live roster (may have drifted since dispatch)`)
  return (ctx.roster.roles || {})[role] || {}
}

// ---------------------------------------------------------------------------
// presentReturn — S8: render the validated markdown return into the doc tab
// and make that tab the pane's first tab on return. Module-local, never
// exported to workers. NEVER throws, NEVER focuses; a failure logs one line
// and is NOT a resolution failure — it must never fail a dispatch, a
// resolution, or a close. Does NOT call terminateRecord (who-terminates
// after await resolves stays #7's call, dispatch.mjs:1025-1032).
// ---------------------------------------------------------------------------
function presentReturn(record, roleDef) {
  try {
    if (!record.surface) return { rendered: false, presented: false }
    if (!roleDef || !roleDef.doc_tab) return { rendered: false, presented: false }

    // Re-read record.return_path (never trust an already-classified
    // envelope from an earlier tick) and re-validate read-only.
    const returnText = readTextOrNull(record.return_path)
    const validation = validateReturn(record, returnText)
    if (!validation.ok || record.return.kind !== 'markdown') {
      return { rendered: false, presented: false }
    }

    // renderReturn's first call site anywhere (ladder.mjs:434) — only on a
    // fresh, envelope-valid, kind:'markdown' return.
    renderReturn(record, validation.envelope)

    const paneId = record.surface.pane_id
    const terminalSurfaceId = record.surface.surface_id
    const liveTreeSnapshot = tree({ all: true })
    const found = findDocTabSurface(liveTreeSnapshot, { paneId, terminalSurfaceId })
    // Fail CLOSED on ambiguity: an ambiguous pane (>=2 markdown candidates)
    // must never be treated as "not mounted" — that read is exactly what let
    // an ambiguous pane accumulate panels forever. Skip the mount (the
    // divergent direction) and log loudly instead of guessing which surface
    // to reorder.
    let presented
    if (found.ambiguous) {
      log(`presentReturn: dispatch ${record.dispatch_id} pane ${paneId} has an ambiguous doc-tab candidate set — skipping mount/reorder`)
      presented = false
    } else if (found.id) {
      presented = reorderDocTabFirst({ paneId, terminalSurfaceId })
    } else {
      presented = mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId }) != null
    }

    return { rendered: true, presented }
  } catch (err) {
    log(`presentReturn: unexpected failure for dispatch ${record.dispatch_id}: ${err.message} — a doc-tab failure is never a resolution failure`)
    return { rendered: false, presented: false }
  }
}

export function closeCmd(args, ctx) {
  const { paths } = ctx
  if (!args.dispatch) {
    throw new UsageError('close requires --dispatch <dispatch_id>')
  }
  const record = findRecordByDispatchId(paths.dispatchDir, args.dispatch)
  if (!record) {
    throw new OperationalError(`refused: no record found for dispatch_id ${args.dispatch}`)
  }
  const recordPath = join(paths.dispatchDir, `${stemOf(record.slice_id, record.attempt)}.json`)
  const sidecars = sidecarPaths(paths, record.dispatch_id)
  const fsState = collectFsState({ record, paths: { exitPath: sidecars.exit, gatePath: sidecars.gate } })
  const classification = classify({ record, fsState, tree: null, now: Date.now() })

  let outcome
  let postconditionResult = null
  if (record.outcome !== null) {
    outcome = record.outcome
    // trust M4: a terminal record is NEVER re-derived (classify()'s own
    // step 0 short-circuits to `terminal` and this branch trusts
    // record.outcome verbatim) — but ladder.mjs's classify() independently
    // flags a stored outcome:"ok" that the completion evaluation cannot
    // corroborate (no fresh valid return on disk to back it up) with
    // `terminal_outcome_uncorroborated`. This is a read-only refusal to
    // REPORT a forged success clean — it never rewrites the record.
    if (classification.warnings.some((w) => w.includes('terminal_outcome_uncorroborated'))) {
      log(`close: refused — record ${recordPath} claims outcome "ok" but that is not corroborated by the completion evaluation (terminal_outcome_uncorroborated)`)
    }
  } else {
    outcome = mapOutcome(classification, fsState)
    const worktreePath = record.worktree ? record.worktree.path : record.primary_checkout
    const porcelain = gitPorcelain(worktreePath)
    if (porcelain === null) {
      classification.warnings.push(`postcondition_unverifiable: could not read git status for ${worktreePath}`)
    } else {
      postconditionResult = evaluatePostcondition(record.profile, porcelain)
      outcome = applyPostconditionOverride(outcome, postconditionResult)
      if (outcome === 'refused_postcondition') {
        log(`close: dispatch ${record.dispatch_id} violated its 'clean' postcondition — offending: ${JSON.stringify(postconditionResult.offending)}`)
      }
    }
    terminateRecord(recordPath, outcome)
  }
  // trust M3 / D-2: the completion nonce's lifetime ends here, at the
  // terminal transition — it has done its job (or the dispatch never
  // reached it) and must not linger on disk any longer than this.
  // Deliberately outside the if/else (idempotent): the already-terminal
  // short-circuit branch must also unlink, or a worker that forges a
  // terminal record would keep its nonce on disk until teardown.
  unlinkIfExists(sidecars.nonce)

  // Every topology verb re-resolves its id from a fresh tree --json and
  // no-ops loudly if gone (cmuxctl's requireTargetPresent already logs).
  const roleDef = roleDefForRecovery(ctx, record.role)
  if (record.surface) {
    if (roleDef.doc_tab) {
      // be-11-03 STALE TERMINAL SURFACE: a prior close already collapsed
      // this dispatch (terminal surface closed, sidecars.collapsed
      // written). Skip entirely — presentReturn's reorder and any mount
      // attempt would otherwise target a dead terminal surface id on every
      // repeat close, logging spurious errors for nothing.
      if (readTextOrNull(sidecars.collapsed) != null) {
        log(`close: dispatch ${record.dispatch_id} was already collapsed on a prior close — skipping re-present/re-mount against the dead terminal surface`)
      } else {
        // doc-tab roles keep the terminal surface UNLESS a sibling doc-tab
        // surface can be positively verified (spike S19: closing one of
        // several sibling surfaces collapses the pane to its remaining
        // tab(s); the pane itself only closes when its LAST surface
        // closes). S8: render + present the return one more time on close
        // (idempotent — a no-op if presentReturn already ran from
        // awaitCmd) so the doc tab is current even if `close` is invoked
        // without a prior `await` — and, crucially, so a sibling doc-tab
        // surface that presentReturn itself just mounted is visible to the
        // fresh tree read below.
        presentReturn(record, roleDef)
        // QA fix round 2 (#3): all three tree() reads below sit AFTER the
        // record is already marked terminal (on disk). tree() THROWS
        // rather than returning null on failure — on a wedged/unreachable
        // substrate (exactly the scenario an orchestrator is closing a
        // stalled pane in), an unguarded throw here would mean closeCmd
        // never returns its {dispatch_id, outcome, warnings,
        // postcondition} JSON at all, even though the record itself was
        // already correctly finalized. safeTree() degrades every one of
        // these three reads to "couldn't verify" (null) with one loud line
        // instead — every caller below already treats a failed/negative
        // verification as "keep the terminal surface," the same
        // fail-closed posture as an ambiguous pane, so this never changes
        // what a SUCCESSFUL collapse looks like, only what happens when
        // the substrate can't even be asked.
        const verifyTree = safeTree(record.dispatch_id, 'verifying the doc-tab sibling before collapse')
        const found = verifyTree ? findVerifiedDocTabSibling(verifyTree, { paneId: record.surface.pane_id, terminalSurfaceId: record.surface.surface_id }) : { id: null, ambiguous: false }
        if (found.id) {
          // ACCEPTED COST: once the terminal surface is gone the doc tab
          // can never be re-mounted for this dispatch again (mounting
          // anchors on the terminal surface) — the parent-rendered
          // returns/<stem>.md on disk is the recovery path from here.
          // found.ambiguous also falls into the else branch below
          // (findDocTabSurface fails closed on ambiguity — an ambiguous
          // pane never gets its terminal closed either).
          //
          // QA fix (#5, correctness-lens W-3): re-verify the sibling doc
          // tab is STILL present immediately before the close call —
          // closeSurface() itself only re-validates the TERMINAL surface
          // (virtually always still present), never the doc-tab sibling
          // whose presence is the ENTIRE justification for closing it. If
          // the doc tab vanished in the window between the check above and
          // now, refuse to close rather than taking the whole pane down.
          const reverifyTree = safeTree(record.dispatch_id, 're-verifying the doc-tab sibling immediately before close')
          const reverifyFound = reverifyTree ? findVerifiedDocTabSibling(reverifyTree, { paneId: record.surface.pane_id, terminalSurfaceId: record.surface.surface_id }) : { id: null, ambiguous: false }
          if (!reverifyFound.id) {
            log(`close: dispatch ${record.dispatch_id}'s sibling doc-tab surface could not be re-verified present (disappeared, or the substrate is unreachable) — refusing to close the terminal surface (would take the whole pane down); terminal surface ${record.surface.surface_id} kept`)
          } else {
            closeSurface(record.surface.surface_id)
            // QA fix (#4, correctness-lens W-4): closeSurface() never
            // reports whether the underlying close actually succeeded —
            // re-read a FRESH tree and gate the .collapsed sidecar write
            // on the terminal surface's confirmed absence. Writing it
            // unconditionally would permanently disable doc-tab
            // recovery/reorder for a dispatch whose terminal surface was
            // never actually closed (e.g. a transient close-surface
            // failure). A tree() failure here degrades the SAME way — no
            // confirmation, no write, safe to retry the collapse later.
            const postCloseTree = safeTree(record.dispatch_id, 'confirming the terminal surface actually closed')
            if (!postCloseTree) {
              log(`close: dispatch ${record.dispatch_id}'s post-close verification could not run (substrate unreachable) — .collapsed NOT written; will retry the collapse on the next close`)
            } else if (surfaceExistsInTree(postCloseTree, record.surface.surface_id)) {
              log(`close: dispatch ${record.dispatch_id}'s close-surface call for the terminal surface did not take effect (still present on a fresh tree) — .collapsed NOT written; will retry the collapse on the next close`)
            } else {
              writeTextAtomic(sidecars.collapsed, new Date().toISOString())
              log(`close: dispatch ${record.dispatch_id} collapsed to its doc tab — terminal surface ${record.surface.surface_id} closed`)
            }
          }
        } else {
          log(`close: dispatch ${record.dispatch_id} is a doc-tab role but no sibling doc-tab surface was verified — terminal surface ${record.surface.surface_id} kept so the pane survives`)
        }
      }
    } else {
      closeSurface(record.surface.surface_id)
    }
  }

  const uncorroborated = classification.warnings.some((w) => w.includes('terminal_outcome_uncorroborated'))
  return {
    code: outcome === 'ok' && !uncorroborated ? 0 : 1,
    json: {
      dispatch_id: record.dispatch_id,
      outcome,
      warnings: classification.warnings,
      postcondition: postconditionResult,
    },
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function statusCmd(args, ctx) {
  const { paths, taskSlug } = ctx
  // lifecycle M5-E: a single unreadable committed record (filesystem
  // corruption, a hand edit, a schema violation readRecord now refuses) must
  // never wedge `status` — it is reported in the unreadable array below
  // (never as a RECOVERY_ROWS entry: reconcile describes DISPATCHES, and an
  // unparseable file is not one) and skipped, so every OTHER record still
  // reconstructs normally.
  const unreadable = []
  const records = listRecords(paths.dispatchDir, {
    onUnreadable: ({ path, error }) => unreadable.push({ path, error: error.message }),
  })

  // lifecycle S10: git status --porcelain runs per record's own worktree so
  // reconcile's crashed-row "worktree has uncommitted changes" warning is
  // actually reachable from production `status` — collectFsState itself
  // never invokes git; this is the one caller that supplies worktreeDirty.
  const fsStateByDispatch = {}
  for (const record of records) {
    const sidecars = sidecarPaths(paths, record.dispatch_id)
    const worktreePath = record.worktree ? record.worktree.path : null
    const porcelain = worktreePath ? gitPorcelain(worktreePath) : null
    fsStateByDispatch[record.dispatch_id] = collectFsState({
      record,
      paths: { exitPath: sidecars.exit, gatePath: sidecars.gate, worktreeDirty: Boolean(porcelain && porcelain.trim().length > 0) },
    })
  }

  let liveTree = null
  try {
    liveTree = tree({ all: true })
  } catch {
    liveTree = null
  }

  // be-11-03: status runs its OWN independent filtered events read (one
  // extra cmux call in a manual, read-only verb is acceptable — unlike
  // await's pinned per-invocation bound) to thread the same
  // stateless/no-latch attention derivation into reconcile().
  const turnEndAtEvRes = readTurnEndEvents()
  let turnEndAt = {}
  if (turnEndAtEvRes.unavailable) {
    log('status: cmux events read unavailable — attention triage disabled for this call; every other classification is unaffected')
  } else {
    turnEndAt = deriveTurnEndAt(records, turnEndAtEvRes.events)
  }

  const rows = reconcile({ records, fsState: fsStateByDispatch, tree: liveTree, now: Date.now(), turnEndAt })

  // Re-mount doc tabs from files when the panel is gone (S20: markdown
  // panels do not survive a cmux restart). A role only reaches here with a
  // bound surface if it is pane-enabled; doc_tab-without-pane roles never
  // bind a surface, so this loop is a structural no-op for them.
  for (const record of records) {
    const roleDef = roleDefForRecovery(ctx, record.role)
    if (!roleDef.doc_tab || !record.surface) continue
    if (!liveTree) continue
    // be-11-03 STALE TERMINAL SURFACE: a prior close already collapsed this
    // dispatch — the re-mount loop must not attempt to mount against a dead
    // terminal surface id.
    const collapsedSidecar = sidecarPaths(paths, record.dispatch_id).collapsed
    if (readTextOrNull(collapsedSidecar) != null) continue
    const paneId = record.surface.pane_id
    const terminalSurfaceId = record.surface.surface_id
    // Gate on pane liveness ALONE, never on record.outcome. QA fix (#12):
    // this used to say closeCmd "deliberately KEEPS a doc-tab role's
    // terminal surface and pane (never closeSurface for those)" — that
    // stopped being universally true the moment be-11-03 shipped
    // collapse-on-close (immediately above, in the very check this comment
    // sits under): closeCmd now closes the terminal surface whenever a
    // sibling doc-tab surface is positively verified, and ONLY keeps it
    // when no sibling was verified (the mount-chain-failed case). The
    // `.collapsed`-sidecar skip above already handles the collapsed case;
    // what THIS loop still legitimately recovers is a record whose
    // terminal surface was KEPT (never collapsed) and whose doc tab alone
    // went missing after a cmux restart (S20) — "the architecture-package
    // viewer stays open for the whole task" remains the invariant for that
    // surviving-terminal-surface case, not for every doc-tab record
    // unconditionally. The bound pane itself must still be present in the
    // ALREADY-fetched liveTree — a pane gone from the tree (not just its
    // doc-tab surface) is nothing this loop can safely re-mount into, and
    // is exactly the noise case (a torn-down/aborted record) this check
    // suppresses instead.
    if (!paneExistsInTree(liveTree, paneId)) continue
    // S8 double-mount guard: findDocTabSurface against the ALREADY-fetched
    // liveTree (never a fresh re-fetch here) — a doc tab already present
    // skips mountDocTab outright. Without this, every `status` call would
    // mount another panel for every pane+doc_tab role (S4 made six such
    // roles; before that this loop was a structural no-op). An AMBIGUOUS
    // pane (>=2 markdown candidates) is fail-CLOSED: skip the mount and log
    // loudly rather than guess or pile on a third panel — mounting is the
    // divergent direction, skipping self-corrects.
    const found = findDocTabSurface(liveTree, { paneId, terminalSurfaceId })
    if (found.ambiguous) {
      log(`status: dispatch ${record.dispatch_id} pane ${paneId} has an ambiguous doc-tab candidate set — skipping re-mount`)
      continue
    }
    if (!found.id) {
      mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId })
    }
  }

  for (const row of rows) {
    const warnPart = row.warnings.length ? ` warnings=${row.warnings.join(';')}` : ''
    log(`status: ${row.dispatch_id} ${row.row} state=${row.state}${warnPart}`)
  }
  for (const u of unreadable) {
    log(`status: unreadable record at ${u.path}: ${u.error}`)
  }

  const attention = rows
    .filter((row) => row.state === 'attention')
    .map((row) => ({ dispatch_id: row.dispatch_id, since: turnEndAt[row.dispatch_id], reason: 'quiet_after_turn_end' }))

  const statusJson = { task_slug: taskSlug, generated_at: new Date().toISOString(), rows, unreadable, attention }
  writeJsonAtomic(paths.statusPath, statusJson)
  return { code: 0, json: statusJson }
}

// deletePreviewArtifacts(stateDir) -> void. `<stateDir>/browser/` (recursive,
// force — absent is a no-op) plus every `<stateDir>/browser.json*` sibling
// (the sidecar itself and any stranded `browser.json.lock`). See the E7
// call-site comment in teardownCmd for why this glob is load-bearing and why
// the deletion is unconditional. be-12-02 fix-round item 5: every individual
// removal is best-effort — a filesystem error (EACCES/EBUSY, etc.) on any ONE
// of these must never propagate and abort teardown BEFORE archiveOrDelete
// runs; it is logged (code only, cosmetic-zone pattern) and swallowed.
function deletePreviewArtifacts(stateDir) {
  try {
    rmSync(join(stateDir, 'browser'), { recursive: true, force: true })
  } catch (err) {
    log(`teardown: deletePreviewArtifacts: failed to remove browser/ — continuing (${err.code || err.message})`)
  }
  let entries
  try {
    entries = readdirSync(stateDir)
  } catch (err) {
    if (err.code === 'ENOENT') return
    log(`teardown: deletePreviewArtifacts: failed to list ${stateDir} — continuing (${err.code || err.message})`)
    return
  }
  for (const name of entries) {
    if (name.startsWith('browser.json')) {
      try {
        rmSync(join(stateDir, name), { recursive: true, force: true })
      } catch (err) {
        log(`teardown: deletePreviewArtifacts: failed to remove ${name} — continuing (${err.code || err.message})`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

// canonical accepted values (whitelist, not a blacklist) — widening this
// requires a deliberate edit to the TEARDOWN_OUTCOMES drift-guard test too.
export const TEARDOWN_OUTCOMES = Object.freeze(['ok', 'refused'])
export const DEFAULT_TEARDOWN_OUTCOME = 'ok'

export function teardownCmd(args, ctx) {
  const { roots, paths, primaryCheckout, taskSlug } = ctx

  // absent => DEFAULT_TEARDOWN_OUTCOME ('ok'), preserving today's behaviour
  // byte-for-byte. Present-but-out-of-enum REFUSES — never coerced, never
  // defaulted on a typo. Hoisted above the surface-closing block below so a
  // bad flag closes nothing and deletes nothing.
  const outcome = args.outcome ?? DEFAULT_TEARDOWN_OUTCOME
  if (!TEARDOWN_OUTCOMES.includes(outcome)) {
    throw new UsageError(`teardown: --outcome must be one of ${TEARDOWN_OUTCOMES.join('|')}, got ${JSON.stringify(args.outcome)}`)
  }

  const preflightCache = readPreflightCache(join(paths.stateDir, 'preflight.json')) || {}
  const workspaceState = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')

  if (workspaceState) {
    const before = tree({ all: true })
    const win = (before.windows || []).find((w) => w.id === workspaceState.window_id)
    const ws = win?.workspaces?.find((w) => w.id === workspaceState.workspace_id)
    const surfaceIds = (ws?.panes || []).flatMap((p) => p.surfaces || []).map((s) => s.id)
    for (const surfaceId of surfaceIds) {
      closeSurface(surfaceId)
    }
    // preflight.json's `methods` are live RPC-style dotted names
    // (workspace.close, ...), never CLI verb names — close_workspace_available
    // is the boolean preflight() already derived from VERB_METHODS for us.
    if (preflightCache.close_workspace_available) {
      closeWorkspace(workspaceState.workspace_id)
    } else {
      log('teardown: close-workspace is not available per the cached preflight — no-op')
    }
    tree({ all: true }) // verify
  }

  const records = listRecords(paths.dispatchDir)
  const archive = Boolean(args['keep-artifacts']) || shouldArchive({ outcome }, records)

  // The worktree index lives under stateDir — it MUST be read and
  // reconciled before stateDir itself is archived/deleted below.
  const index = readWorktreesIndex(paths.worktreesIndexPath)
  const leftoverWorktrees = []
  for (const [sliceId, entry] of Object.entries(index)) {
    const res = removeWorktreeIfCleanAndMerged({ sliceId, entry, primaryCheckout, worktreesIndexPath: paths.worktreesIndexPath, roots })
    if (!res.removed) {
      leftoverWorktrees.push({ slice_id: sliceId, path: entry.path, reason: res.reason })
      log(`teardown: kept worktree for slice ${sliceId} (${res.reason}): ${entry.path}`)
    }
  }

  // issue #12/D7 (errata E7) — the ONE teardown-specific deletion this
  // slice adds: <stateDir>/browser/ (screenshots — be-12-03) and
  // <stateDir>/browser.json* (the sidecar; the glob is load-bearing —
  // withRecordLock writes a sibling browser.json.lock that a crash mid-
  // section can strand). BEFORE archiveOrDelete, and UNCONDITIONAL —
  // including under --keep-artifacts: exposure of an authenticated dev
  // app's screenshot/hostname outweighs the post-mortem value of these
  // specific artifacts, and the dispatch records that carry the real
  // diagnostic value are unaffected (archiveOrDelete still archives them).
  deletePreviewArtifacts(paths.stateDir)

  const dateStr = new Date().toISOString().slice(0, 10)
  const taskDirAction = archiveOrDelete(paths.taskDir, join(roots.tasksRoot, '.archive', `${taskSlug}-${dateStr}`), archive)
  // lifecycle S8: stateDir (0600 completion nonces, dispatch records,
  // preflight.json, workspace.json, worktrees.json, events.cursor) is swept
  // alongside taskDir — this is what makes M1's workspace.json fix durable
  // (nothing survives teardown to go stale) and closes trust M3/D-2's
  // "nothing ever unlinks this" gap for any nonce that somehow outlived
  // dispatch/close (e.g. an aborted-before-terminate crash).
  const stateDirAction = archiveOrDelete(paths.stateDir, join(roots.stateRoot, '.archive', `${taskSlug}-${dateStr}`), archive)

  return { code: 0, json: { task_dir: taskDirAction, state_dir: stateDirAction, leftover_worktrees: leftoverWorktrees } }
}

// lifecycle S9: the archive directory name is uniquified on collision
// (<slug>-<date>, then -2, -3, ...) — a same-day second teardown of the same
// task must never throw ENOTEMPTY partway through (after surfaces are
// already closed).
function uniquifyDir(baseDir) {
  if (!existsSync(baseDir)) return baseDir
  for (let n = 2; ; n += 1) {
    const candidate = `${baseDir}-${n}`
    if (!existsSync(candidate)) return candidate
  }
}

function archiveOrDelete(dir, archiveBaseDir, archive) {
  if (!existsSync(dir)) {
    return { archived: false, deleted: false }
  }
  if (archive) {
    const archiveDir = uniquifyDir(archiveBaseDir)
    mkdirSync(dirname(archiveDir), { recursive: true })
    renameSync(dir, archiveDir)
    return { archived: true, path: archiveDir }
  }
  rmSync(dir, { recursive: true, force: false })
  return { archived: false, deleted: true }
}

// ---------------------------------------------------------------------------
// phase — S9. `phase --set <planning|building|gate>`. 'gate' is never fired
// from code (only OUTCOME_MAPPING/workspaceCmd/dispatchCmd fire 'planning'/
// 'building') — the orchestrator invokes `phase --set gate` directly.
// ---------------------------------------------------------------------------

export function phaseCmd(args, ctx) {
  const { paths } = ctx
  if (!args.set) {
    throw new UsageError('phase requires --set <planning|building|gate>')
  }
  if (!PHASES.includes(args.set)) {
    throw new UsageError(`phase: --set must be one of ${PHASES.join('|')}, got ${JSON.stringify(args.set)}`)
  }
  const workspaceState = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')
  if (!workspaceState) {
    throw new OperationalError('refused: no workspace bound for this task — run `workspace` first')
  }
  setPhase(args.set, { workspaceId: workspaceState.workspace_id })
  // be-11-02: 'gate' is the review gate — clear any stale progress pill.
  // Cosmetics never fail a verb: swallow-and-log, same shape as
  // workspaceCmd's setWorkspaceColor/setPhase wrapping.
  if (args.set === 'gate') {
    try {
      clearProgress({ workspaceId: workspaceState.workspace_id })
    } catch (err) {
      log(`phase: clearProgress failed — progress pill not cleared: ${err.message}`)
    }
  }
  return { code: 0, json: { phase: args.set } }
}

// ---------------------------------------------------------------------------
// browser-verify — issue #12/D5, ADR-019. Orchestrator-invoked gate-evidence
// verb, exactly like `cmux diff`: not a worker capability, no CMUX_ALLOWS
// entry (conventions.md 2026-08-04, "cmux diff is the orchestrator's human
// patch view"). Runs the FIXED D5 verb sequence against be-12-02's preview
// singleton (read-only consumer of <stateDir>/browser.json — never
// rewritten here) and reports a closed-shape evidence record.
//
// browser-verify NEVER judges: it exits 0 whenever it ran, including a
// dirty console, load_state_confirmed:false, and preview_present:false —
// the gate still branches on the parsed {verdict, findings} enum alone
// (D17); "fixing" this verb into a control-flow branch on browser evidence
// is the predictable regression this comment exists to head off. Exit 1
// only on an operational failure (no workspace bound, cmux unreachable);
// exit 2 on a usage error.
//
// Total wall-clock budget <= 90 000 ms, enumerated: this verb's own bounded
// `tree` call (BROWSER_VERIFY_TREE_TIMEOUT_MS, 3 000) + browserErrorsClear
// (10 000) + browserGoto (20 000) + browserWaitReady (25 000) +
// browserErrorsList (10 000) + browserScreenshot (20 000) = 88 000 ms.
// ---------------------------------------------------------------------------

// Frozen, dispatcher-authored, closed warning vocabulary (D5 deliberate
// divergence): no cmux error detail, no cmux error code, no page bytes ever
// rides in here — the shipped IC-2 wrappers return boolean/null and log the
// code only at the cmuxctl boundary (cmuxctl.mjs's logBrowserError), so the
// code is not even available to this module. Every warning this verb emits
// must be a member of this exact array.
export const BROWSER_VERIFY_WARNINGS = Object.freeze([
  'browser_wait_not_confirmed',
  'browser_screenshot_missing',
  'browser_errors_list_unavailable',
  'browser_configured_origin_differs_from_recorded',
  'browser_goto_failed',
  'browser_errors_clear_failed',
])

// This verb's own only spawn (the corroboration tree read) — never re-typed
// elsewhere; the budget test extracts this literal by name.
const BROWSER_VERIFY_TREE_TIMEOUT_MS = 3000

// Shape-guard for the sidecar's recorded origin, mirroring cmuxctl.mjs's
// logBrowserError precedent (BROWSER_ERROR_CODE_RE, cmuxctl.mjs:959-965):
// browser.json is a file this process reads but the sidecar-writing side
// (be-12-02's ensurePreviewBrowser) is fed a URL that itself passed through
// validatePreviewUrl, so a hostile origin value should never occur in
// practice — but "should never occur" is not a structural guarantee, and
// this value rides into an interpolated stderr line and the JSON output. A
// value not FULLY matching this closed pattern is never interpolated raw;
// it is replaced by a fixed placeholder, exactly like the out-of-shape
// cmux error code case above.
const BROWSER_VERIFY_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const BROWSER_VERIFY_UNPARSED_ORIGIN_PLACEHOLDER = '<unparsed origin>'

// screenshotFileName(date) -> 'verify-<compact ISO, digits only>.png'. Never
// carries any part of the configured URL — only a timestamp.
function screenshotFileName(date) {
  return `verify-${date.toISOString().replace(/[^0-9]/g, '')}.png`
}

export function browserVerifyCmd(args, ctx) {
  const { paths, primaryCheckout } = ctx

  // Workspace binding is SITED, not assumed — the exact shape phaseCmd uses.
  const workspaceState = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')
  if (!workspaceState) {
    throw new OperationalError('refused: no workspace bound for this task — run `workspace` first')
  }

  const configText = readConfigText(primaryCheckout)
  const configuredUrl = readCmuxPreviewUrl(configText)
  if (!configuredUrl) {
    return { code: 0, json: { preview_present: false, reason: 'preview_disabled', warnings: [] } }
  }

  const sidecarPath = join(paths.stateDir, PREVIEW_BROWSER_SIDECAR_NAME)
  const sidecar = readJsonOrWarn(sidecarPath, PREVIEW_BROWSER_SIDECAR_NAME)
  if (!sidecar) {
    return { code: 0, json: { preview_present: false, reason: 'no_preview_recorded', warnings: [] } }
  }

  // Corroborate against a FRESH tree (never trust the sidecar alone) AND
  // workspace_id equality with the live binding — a stale sidecar from a
  // recreated workspace must never be trusted just because it parses. This
  // predicate is DELIBERATELY WEAKER than isValidSidecarSurface (:1064) —
  // it has no worker-pane-exclusion conjunct — and that is intentional, not
  // an oversight: be-12-02's worker-pane rejection exists to stop a *reuse*
  // that would abandon/close a rung-2 mountDocTab surface out from under a
  // running worker (D4), a hazard specific to the create/reuse decision
  // ensurePreviewBrowser makes. browser-verify never reuses or creates
  // anything — a doc-tab surface would also fail the `type !== 'browser'`
  // check above regardless — and this spec scoped any additional
  // worker-pane recomputation out of browser-verify entirely. A future
  // reader should not "fix" this by importing computeWorkerPaneIds here in
  // either direction.
  //
  // No record lock is taken here (deliberate, not an oversight): browser
  // -verify only ever READS <stateDir>/browser.json and never writes it, so
  // there is nothing for withRecordLock to protect against a concurrent
  // writer racing this read — the worst case is a torn read that
  // readJsonOrWarn already degrades to "absent" (-> no_preview_recorded),
  // never a throw.
  if (sidecar.workspace_id !== workspaceState.workspace_id) {
    return { code: 0, json: { preview_present: false, reason: 'preview_surface_gone', warnings: [] } }
  }
  const scanTree = tree({ all: true, timeoutMs: BROWSER_VERIFY_TREE_TIMEOUT_MS })
  const ws = findWorkspaceInTree(scanTree, workspaceState.workspace_id)
  const found = ws ? findSurfaceInWorkspace(ws, sidecar.surface_id) : null
  if (!found || found.surface.type !== 'browser') {
    return { code: 0, json: { preview_present: false, reason: 'preview_surface_gone', warnings: [] } }
  }

  const surfaceId = sidecar.surface_id
  const warnings = []

  // Fixed D5 sequence, no additions, always run in full regardless of any
  // intermediate boolean — this verb reports, it never short-circuits on a
  // degraded step.
  const clearOk = browserErrorsClear(surfaceId)
  if (!clearOk) {
    warnings.push('browser_errors_clear_failed')
  }
  const gotoOk = browserGoto(surfaceId, configuredUrl)
  if (!gotoOk) {
    warnings.push('browser_goto_failed')
  }
  const loadStateConfirmed = browserWaitReady(surfaceId)
  if (!loadStateConfirmed) {
    warnings.push('browser_wait_not_confirmed')
  }
  const rawErrors = browserErrorsList(surfaceId)
  if (rawErrors === null) {
    warnings.push('browser_errors_list_unavailable')
  }
  const consoleErrors = reduceBrowserErrors(rawErrors)

  const screenshotPath = join(paths.stateDir, 'browser', screenshotFileName(new Date()))
  mkdirSync(dirname(screenshotPath), { recursive: true })
  browserScreenshot(surfaceId, screenshotPath)
  // Success is confirmed by an INDEPENDENT statSync(...).size > 0 — cmux's
  // own `OK <path>` stdout line is never trusted as proof of a write (0.64.22
  // prints OK plus a full-size blank PNG even on a surface that never
  // became ready). statSync (not existsSync) also catches a zero-byte write
  // (a file that exists but never received any bytes) — panel-1 S6/panel-2
  // S5 fix-round finding: existsSync alone cannot distinguish "written" from
  // "created empty".
  let screenshotWritten
  try {
    screenshotWritten = statSync(screenshotPath).size > 0
  } catch {
    screenshotWritten = false
  }
  if (!screenshotWritten) {
    warnings.push('browser_screenshot_missing')
  }

  // ORIGIN-ONLY (D8): the full configured URL exists in exactly three places
  // — .claude/dev-team/config.md, browserOpen's argv at dispatch time
  // (ensurePreviewBrowser), and browserGoto's argv array above. Every
  // output path from here on carries scheme://host[:port] only.
  const configuredOrigin = originOf(configuredUrl)
  const recordedOriginRaw = sidecar.origin
  const recordedOrigin = typeof recordedOriginRaw === 'string' && BROWSER_VERIFY_ORIGIN_RE.test(recordedOriginRaw)
    ? recordedOriginRaw
    : BROWSER_VERIFY_UNPARSED_ORIGIN_PLACEHOLDER
  if (configuredOrigin !== recordedOrigin) {
    warnings.push('browser_configured_origin_differs_from_recorded')
    log(`browser-verify: configured origin ${configuredOrigin} differs from the recorded origin ${recordedOrigin} — navigated to the configured origin (browser.json is never rewritten by this verb)`)
  }

  return {
    code: 0,
    json: {
      preview_present: true,
      surface_id: surfaceId,
      origin: configuredOrigin,
      load_state_confirmed: loadStateConfirmed,
      console_errors: consoleErrors,
      screenshot_path: screenshotWritten ? screenshotPath : null,
      warnings,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const COMMANDS = {
  preflight: preflightCmd,
  workspace: workspaceCmd,
  dispatch: dispatchCmd,
  await: awaitCmd,
  close: closeCmd,
  status: statusCmd,
  teardown: teardownCmd,
  phase: phaseCmd,
  'browser-verify': browserVerifyCmd,
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result.json)}\n`)
}

// main(argv) -> exit code. argv excludes 'node' and the script path.
export function main(argv) {
  const [verb, ...rest] = argv
  if (!verb || !COMMANDS[verb]) {
    log(`usage: node dispatch.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
    return 2
  }

  let args
  try {
    args = parseArgs(rest)
  } catch (err) {
    log(`usage error: ${err.message}`)
    return 2
  }

  let ctx
  try {
    ctx = buildContext(args)
  } catch (err) {
    log(`usage error: ${err.message}`)
    return err instanceof UsageError ? 2 : 1
  }

  try {
    assertExecutionModeCmux(verb, readConfigText(ctx.primaryCheckout))
  } catch (err) {
    log(err.message)
    printResult({ code: 1, json: { error: err.message } })
    return 1
  }

  let result
  try {
    result = COMMANDS[verb](args, ctx)
  } catch (err) {
    if (err instanceof UsageError) {
      log(`usage error: ${err.message}`)
      return 2
    }
    if (err instanceof PreflightError) {
      log(err.message)
      printResult({ code: 1, json: { error: err.code, message: err.message } })
      return 1
    }
    if (err instanceof SpecSchemaError) {
      log(err.message)
      const rendered = capFailuresForOutput(err.failures)
      for (const f of rendered) log(`FAIL ${f.check}: ${f.detail}`)
      printResult({ code: 1, json: { error: err.code, failures: rendered } })
      return 1
    }
    log(`error: ${err.message}`)
    printResult({ code: 1, json: { error: err.message } })
    return 1
  }

  printResult(result)
  return result.code
}

// A2 (#27) — realpathSync BOTH sides. The ESM loader realpaths
// import.meta.url while argv[1] stays literal, so a symlinked invocation
// compared false under plain resolvePath and this guard silently no-oped.
// Local copy of the realpathOr shape (scripts/spec-lint.mjs:49-55) — one of
// several sites with this same shape across this repo's scripts/. Promoting
// it to a shared helper is deferred (contract.mjs is contract-frozen with a
// closed export manifest) — see the out_of_scope reasoning in the original
// spec for this change.
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
