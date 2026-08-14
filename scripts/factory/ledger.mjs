#!/usr/bin/env node
// scripts/factory/ledger.mjs — the factory subsystem's run mirror: a
// dual-write recorder pairing an append-only JSONL raw record with a
// queryable SQLite (WAL) projection of the same events.
//
// MIRROR-NEVER-AUTHORITY (the one invariant everything else follows from):
// the JSONL file is the run's true, permanent record. The SQLite database is
// a REBUILDABLE PROJECTION of that record — it may be deleted at any time
// and rebuilt in full via replayJsonl(). A caller must never be able to
// observe a mirror failure: every public writer appends its JSONL line
// FIRST (this append may throw — losing the raw record is fatal to the
// caller), then attempts the database mirror inside a try/catch that never
// rethrows (a mirror failure only increments stats().mirror_errors).
//
// SCOPED FLOOR: this module has its own Node floor (NODE_FLOOR, currently
// '24.0.0') independent of the rest of the plugin, because it depends on
// node:sqlite (a release-candidate builtin, verified working here on node
// v24.15.0, darwin/arm64, with no CLI flag). node:sqlite is NEVER
// statically imported — it does not exist on Node 20 and this module must
// still import cleanly there. It is loaded lazily, via createRequire, only
// inside the first real database access, only after the floor check has
// already passed. Below the floor (or if the lazy require throws for any
// other reason, e.g. a build without sqlite support) the returned handle
// DEGRADES: every writer still appends its JSONL line, every writer/reader
// still exists and is callable, the database mirror silently no-ops,
// readers return empty results, `degraded` is true, and exactly one
// diagnostic line is written to stderr for the handle's whole lifetime.
//
// RETENTION: this mirror never removes rows, never removes tables, and
// never reclaims space — none of the three destructive SQL verbs appears
// anywhere in this file, in code or in comment. Rows only ever accumulate
// or are updated in place (heartbeats, session/phase/process end-state).
//
// LIBRARY vs CLI: everything below `main()` is a pure library — importing
// this file performs no I/O, opens no file, installs no signal handler.
// `main(argv) -> exitCode` never calls process.exit (a piped stdout can be
// truncated by a synchronous teardown); the `invokedDirectly` guard at the
// bottom sets `process.exitCode` instead. Exit codes: 0 ok, 1 unexpected
// internal error, 2 usage / refusal / below floor. A usage/refusal path
// throws the tagged `LedgerUsageError` (mapped to 2); anything else is an
// unexpected internal throw (mapped to 1).
//
// CLI verbs: `sessions` | `phases <adw_id>` | `tail <adw_id> [--after n]
// [--limit n]` | `procs <adw_id>` | `gate-review-gap` |
// `eligible-tasks` — the read-only verbs the npm `ledger:*` recipes invoke
// (spellings are a contract with package.json; see do-40-02) — plus `doctor`
// (capability + state readout) and `kill` (operator-invoked process
// termination, its own refusal-gated helper).
//
// SQL identifiers: all values are bound with `?` placeholders, never
// string-interpolated. The only identifiers ever interpolated into SQL text
// are table/column names read from the frozen `TABLES` constant below —
// SQLite has no way to parameterize an identifier (e.g. `PRAGMA
// table_info(<t>)`), so this is unavoidable; each interpolation site says so
// inline.

import {
  appendFileSync, mkdirSync, chmodSync, existsSync, readFileSync, realpathSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
// NONCE_PREFIX was imported from the legacy runtime's contract
// (scripts/cmux/contract.mjs, retired with that runtime). The ledger's
// sweep guard still honors nonce-prefixed sidecars, so the constant's
// authority now lives here.
const NONCE_PREFIX = 'devteam-done-'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Frozen constants (all exported — the interface contract)
// ---------------------------------------------------------------------------

export const LEDGER_VERSION = 1
export const NODE_FLOOR = '24.0.0'
export const TERM_TO_KILL_MS = 5000

export const EVENT_TYPES = Object.freeze([
  'phase_start', 'phase_end', 'agent_start', 'agent_end', 'tool_call',
  'handoff', 'gate_pass', 'gate_fail', 'decision', 'log', 'error',
])

export const SESSION_STATUSES = Object.freeze(['running', 'ok', 'fail', 'aborted'])
export const PHASE_STATUSES = Object.freeze(['running', 'ok', 'fail', 'skipped'])
export const PROCESS_STATES = Object.freeze(['running', 'exited', 'killed', 'unknown'])
export const GATE_DISCRIMINATION_VERDICTS = Object.freeze(['proven', 'failed', 'unproven'])
export const REVIEW_VERDICTS = Object.freeze(['pass', 'changes-needed'])

// Per-event-type closed payload key allowlist. gate_pass/gate_fail, decision
// and error are ratified (ADR-024); the remaining seven are backend-lead
// interpretations of "one small, closed key set per event type" (spec
// be-40-01 §13 assumption 4).
export const PAYLOAD_KEYS = Object.freeze({
  phase_start: ['name'],
  phase_end: ['name', 'status'],
  agent_start: ['role', 'model', 'dispatch_id'],
  agent_end: ['role', 'outcome', 'dispatch_id'],
  tool_call: ['tool', 'ok'],
  handoff: ['from_role', 'to_role', 'task_id'],
  gate_pass: ['attempt', 'checks', 'violations'],
  gate_fail: ['attempt', 'checks', 'violations'],
  decision: ['decided', 'why', 'alternatives'],
  log: ['level', 'message'],
  error: ['reason', 'source_path', 'source_kind', 'byte_size', 'violation_names'],
})

// The closed set of source-error `reason` values; anything else is coerced
// to 'Error'. RecordInvalidError was the retired record.mjs's exported error
// class name, referenced here BY NAME ONLY — record.mjs itself must never be
// imported (one-way subsystem direction, cmux -> factory).
const SOURCE_ERROR_REASONS = Object.freeze(['RecordInvalidError', 'SyntaxError', 'Error'])

// violation_names shape gate: `<path>:<keyword>`, no whitespace, bounded
// length. Defense in depth against recordSourceError's caller-supplied
// strings (see the header comment on recordSourceError below).
const VIOLATION_NAME_RE = /^[^\s]{1,200}:[^\s]{1,80}$/

// TABLES: { <table>: { columns: [{name, decl}], unique: [[...cols]], indexes: [{name, cols}] } }.
// The CREATE TABLE / CREATE UNIQUE INDEX / CREATE INDEX DDL below is
// GENERATED from this constant — a table declared here but missing from the
// DDL (or vice versa) is impossible by construction.
export const TABLES = Object.freeze({
  sessions: {
    columns: [
      { name: 'adw_id', decl: 'TEXT PRIMARY KEY' },
      { name: 'repo_slug', decl: 'TEXT' },
      { name: 'task_slug', decl: 'TEXT' },
      { name: 'started_at', decl: 'TEXT' },
      { name: 'ended_at', decl: 'TEXT' },
      { name: 'status', decl: 'TEXT' },
      { name: 'billed_input_tokens', decl: 'INTEGER' },
      { name: 'billed_output_tokens', decl: 'INTEGER' },
      { name: 'billed_cache_write_tokens', decl: 'INTEGER' },
      { name: 'billed_cache_read_tokens', decl: 'INTEGER' },
      { name: 'billed_cost_usd', decl: 'REAL' },
      { name: 'ledger_version', decl: 'INTEGER' },
    ],
    unique: [['adw_id']],
    indexes: [],
  },
  phases: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'seq', decl: 'INTEGER' },
      { name: 'name', decl: 'TEXT' },
      { name: 'started_at', decl: 'TEXT' },
      { name: 'ended_at', decl: 'TEXT' },
      { name: 'status', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'seq']],
    indexes: [],
  },
  events: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'seq', decl: 'INTEGER' },
      { name: 'type', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'parent_id', decl: 'INTEGER' },
      { name: 'started_at', decl: 'TEXT' },
      { name: 'ended_at', decl: 'TEXT' },
      { name: 'payload_json', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'seq']],
    indexes: [{ name: 'events_adw_id_idx', cols: ['adw_id', 'id'] }],
  },
  envelopes: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'dispatch_id', decl: 'TEXT' },
      { name: 'slice_id', decl: 'TEXT' },
      { name: 'attempt', decl: 'INTEGER' },
      { name: 'role', decl: 'TEXT' },
      { name: 'produced_at', decl: 'TEXT' },
      { name: 'schema_version', decl: 'INTEGER' },
      { name: 'envelope_path', decl: 'TEXT' },
      { name: 'body_kind', decl: 'TEXT' },
      { name: 'valid', decl: 'INTEGER' },
      { name: 'violation_names', decl: 'TEXT' },
    ],
    unique: [['dispatch_id']],
    indexes: [],
  },
  gate_results: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'gate_name', decl: 'TEXT' },
      { name: 'attempt', decl: 'INTEGER' },
      { name: 'ok', decl: 'INTEGER' },
      { name: 'checks_json', decl: 'TEXT' },
      { name: 'violations_json', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
      { name: 'gate_generation', decl: 'INTEGER' },
      { name: 'pristine', decl: 'INTEGER' },
    ],
    unique: [['adw_id', 'gate_name', 'attempt']],
    indexes: [],
  },
  gate_discriminations: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'gate_generation', decl: 'INTEGER' },
      { name: 'verdict', decl: 'TEXT' },
      { name: 'checks_total', decl: 'INTEGER' },
      { name: 'checks_failed', decl: 'INTEGER' },
      { name: 'checks_errored', decl: 'INTEGER' },
      { name: 'note', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'gate_generation']],
    indexes: [],
  },
  review_outcomes: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'dispatch_id', decl: 'TEXT' },
      { name: 'role', decl: 'TEXT' },
      { name: 'verdict', decl: 'TEXT' },
      { name: 'must_fix', decl: 'INTEGER' },
      { name: 'should_fix', decl: 'INTEGER' },
      { name: 'consider', decl: 'INTEGER' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'dispatch_id']],
    indexes: [],
  },
  processes: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'dispatch_id', decl: 'TEXT' },
      { name: 'pid', decl: 'INTEGER' },
      { name: 'command', decl: 'TEXT' },
      { name: 'started_at', decl: 'TEXT' },
      { name: 'ended_at', decl: 'TEXT' },
      { name: 'exit_code', decl: 'INTEGER' },
      { name: 'exit_signal', decl: 'TEXT' },
      { name: 'last_heartbeat_at', decl: 'TEXT' },
      { name: 'state', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'pid', 'started_at']],
    indexes: [],
  },
  agent_sessions: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'dispatch_id', decl: 'TEXT' },
      { name: 'role', decl: 'TEXT' },
      { name: 'model', decl: 'TEXT' },
      { name: 'claude_session_id', decl: 'TEXT' },
      { name: 'transcript_path', decl: 'TEXT' },
      { name: 'started_at', decl: 'TEXT' },
      { name: 'ended_at', decl: 'TEXT' },
      { name: 'context_tokens', decl: 'INTEGER' },
      { name: 'context_window', decl: 'INTEGER' },
      { name: 'raw_read_tokens', decl: 'INTEGER' },
      { name: 'raw_written_tokens', decl: 'INTEGER' },
      { name: 'billed_input_tokens', decl: 'INTEGER' },
      { name: 'billed_output_tokens', decl: 'INTEGER' },
      { name: 'billed_cache_write_tokens', decl: 'INTEGER' },
      { name: 'billed_cache_read_tokens', decl: 'INTEGER' },
      { name: 'last_heartbeat_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'claude_session_id']],
    indexes: [],
  },
})

// The closed set of public writer method names — also the closed set of
// JSONL line `kind` values. replayJsonl refuses any `kind` outside this set.
export const WRITERS = Object.freeze([
  'startSession', 'endSession', 'startPhase', 'endPhase', 'recordEvent',
  'recordEnvelope', 'recordGateResult', 'recordGateDiscrimination',
  'recordReviewOutcome', 'startProcess', 'endProcess', 'heartbeat',
  'startAgentSession', 'endAgentSession', 'recordSourceError',
])

// ---------------------------------------------------------------------------
// DDL generation — built from TABLES, never hand-written alongside it.
// ---------------------------------------------------------------------------

function tableColumnNames(table) {
  return TABLES[table].columns.map((c) => c.name)
}

// Fallback ordering key for a table with no declared `unique` set: derived
// from the DECLARED primary key column (parsed from its `decl` text), never
// a hardcoded literal — a hardcoded 'id' silently threw for `sessions`
// (whose primary key is `adw_id`, not `id`) and the bare catch in
// dumpTable() swallowed the throw as an empty result.
function primaryKeyColumn(table) {
  const col = TABLES[table].columns.find((c) => /PRIMARY KEY/i.test(c.decl))
  return col ? col.name : 'rowid'
}

function migrationsFor() {
  const stmts = []
  for (const [table, def] of Object.entries(TABLES)) {
    const colSql = def.columns.map((c) => `${c.name} ${c.decl}`).join(', ')
    stmts.push(`CREATE TABLE IF NOT EXISTS ${table} (${colSql})`)
    for (const cols of def.unique) {
      const idxName = `${table}_${cols.join('_')}_uq`
      stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${idxName} ON ${table} (${cols.join(', ')})`)
    }
    for (const idx of def.indexes) {
      stmts.push(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${table} (${idx.cols.join(', ')})`)
    }
  }
  return stmts
}

// Exported so tests can run a strict prefix of the migration list (AC-4:
// opening a db created by an earlier prefix under the full list).
export const MIGRATIONS = migrationsFor()

// Applies (a prefix of) MIGRATIONS, then an additive ADD COLUMN probe over
// the DECLARED table list from TABLES only (never sqlite_master — that also
// lists sqlite's own internal sqlite_sequence table, which cannot be
// ALTERed and would break a sqlite_master-driven probe). Exported as
// `applyMigrations` so tests can exercise AC-4 (idempotence, earlier-prefix
// upgrade) directly against a raw DatabaseSync connection.
export function applyMigrations(db, migrations = MIGRATIONS) {
  for (const stmt of migrations) {
    db.exec(stmt)
  }
  for (const table of Object.keys(TABLES)) {
    const existingCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
    if (existingCols.size === 0) {
      // The table itself does not exist yet (a genuinely earlier migration
      // prefix that predates this table entirely). Nothing to ADD COLUMN
      // onto — it is created whole, with every current column, the next
      // time the full MIGRATIONS list's CREATE TABLE IF NOT EXISTS runs.
      continue
    }
    for (const col of TABLES[table].columns) {
      if (!existingCols.has(col.name)) {
        // Additive only: a column present in TABLES but absent on disk (an
        // older db file) is added; no column is ever dropped or altered.
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.decl}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// A refusal cause, tagged so main's catch can map it to exit 2 without
// conflating it with an unexpected internal throw (mapped to 1). Thrown for
// CALLER BUGS only (unknown type/table/column, missing natural key, bad CLI
// usage) — never for an operational (db-mirror) failure, which is caught and
// counted instead.
export class LedgerUsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message)
    this.reason = reason
  }
}

function refuse(message, reason = 'usage') {
  throw new LedgerUsageError(`ledger: ${message}`, reason)
}

// isoMs(t) -> millisecond-precision ISO string. Every *_at column and every
// JSONL line's `at` field goes through this. Re-implemented locally (not
// imported) per the one-way cmux -> factory subsystem direction.
export function isoMs(t) {
  // A pass-through case, not in the original cmux idiom: many of this
  // module's writers take back a natural-key timestamp that was already
  // recorded (and therefore already round-tripped through this function) —
  // e.g. endProcess/heartbeat receiving a `started_at` read back from a
  // prior dumpTable() call. Re-deriving it from a string would defeat the
  // whole point of isoMs (throwing on non-epoch input); instead validate
  // that an already-ms-ISO string is exactly that, and return it verbatim.
  // Neither error message below embeds the raw offending value — `t` is
  // frequently caller-controlled data (e.g. a natural-key timestamp lifted
  // straight from an input object) and could carry a redaction marker;
  // the typeof/shape alone is enough to diagnose the refusal.
  if (typeof t === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t)) {
      throw new Error('isoMs: string input must already be a millisecond-ISO timestamp')
    }
    return t
  }
  if (typeof t !== 'number' && !(t instanceof Date)) {
    throw new Error(`isoMs: expected an epoch-ms number, a Date, or an already-ms-ISO string, got ${typeof t}`)
  }
  const iso = new Date(t).toISOString()
  if (!/\.\d{3}Z$/.test(iso)) {
    throw new Error(`isoMs: produced a timestamp without a millisecond group: ${iso}`)
  }
  return iso
}

// Parses a semver-ish string into [major, minor, patch], stripping any
// pre-release suffix at the first '-'.
function parseVersion(v) {
  const core = String(v).split('-')[0]
  const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function versionAtLeast(v, floor) {
  const a = parseVersion(v)
  const b = parseVersion(floor)
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

// realpath both sides: the ESM loader realpaths import.meta.url while
// argv[1] stays literal, so under a symlinked path component (macOS TMPDIR
// is /var -> /private/var, used by this module's own tmp-dir tests) a
// literal compare is silently false and the CLI would no-op. Copied
// verbatim from scripts/task-cost-log.mjs:284-296 (4th copy of this idiom;
// not promoted to a shared helper in this task).
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function chmodIfExists(path, mode) {
  try {
    chmodSync(path, mode)
  } catch {
    // Tolerate a missing file (e.g. -wal/-shm siblings before first write).
  }
}

// Recognizes a first-open lock race (see ensureDb's one-retry seam) —
// node:sqlite surfaces this as code SQLITE_BUSY or a "database is locked"
// message depending on where in the open+migrate sequence it fires.
// Exported so this classifier is directly unit-testable.
export function isLockedError(err) {
  const msg = (err && err.message) || ''
  return !!err && (err.code === 'SQLITE_BUSY' || /database is locked/i.test(msg))
}

// ---------------------------------------------------------------------------
// Field hygiene / redaction (AC-9)
// ---------------------------------------------------------------------------

// Redacts args recursively (plain objects and arrays) BEFORE either the
// JSONL line or the db bind sees them: drops any key matching /^DEVTEAM_/i,
// and drops any string value containing a secret marker. The marker set is
// [NONCE_PREFIX] — inlined above (the legacy contract that owned it was
// retired with that runtime; this file is the value's authority now).
function redact(value, stats) {
  if (Array.isArray(value)) {
    // Array elements carry no key context, so the marker-value check runs
    // directly against each element here (not only inside the
    // object-property branch below) — an array of plain strings (e.g.
    // violation_names, checks/violations items) would otherwise never be
    // scanned for the nonce-prefix marker.
    const out = []
    for (const v of value) {
      if (typeof v === 'string' && v.includes(NONCE_PREFIX)) {
        stats.redacted_values += 1
        continue
      }
      out.push(redact(v, stats))
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (/^DEVTEAM_/i.test(key)) {
        stats.redacted_values += 1
        continue
      }
      if (typeof val === 'string' && val.includes(NONCE_PREFIX)) {
        stats.redacted_values += 1
        continue
      }
      out[key] = redact(val, stats)
    }
    return out
  }
  return value
}

// Drops any payload key not in PAYLOAD_KEYS[type]; counts drops.
function applyPayloadAllowlist(type, payload, stats) {
  if (payload == null) return {}
  const allowed = PAYLOAD_KEYS[type] || []
  const out = {}
  for (const [key, val] of Object.entries(payload)) {
    if (allowed.includes(key)) {
      out[key] = val
    } else {
      stats.dropped_payload_keys += 1
    }
  }
  return out
}

// node:sqlite binds only null/number/bigint/string/Uint8Array — a JS
// boolean or `undefined` THROWS at bind time. Every value crossing into a
// bound statement goes through this: booleans become 0/1, undefined
// (and NaN, which SQLite also can't represent faithfully as a bind param
// via this API in every case) becomes null.
function toBindable(v) {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

// ---------------------------------------------------------------------------
// openLedger — synchronous, lazy.
// ---------------------------------------------------------------------------

export function openLedger({
  dbPath,
  jsonlPath = join(dirname(dbPath), 'ledger.jsonl'),
  nodeVersion = process.versions.node,
  now = () => Date.now(),
  stderr = process.stderr,
} = {}) {
  if (!dbPath) {
    refuse('openLedger requires dbPath')
  }

  const dir = dirname(dbPath)
  const stats = {
    mirror_errors: 0,
    mirror_first_code: null,
    dropped_payload_keys: 0,
    redacted_values: 0,
    // Distinguishes WHY a handle is degraded — 'below_floor' (the version
    // check) vs an open-time failure's error code/name (e.g. a build
    // without sqlite support, or a permission/lock failure the one retry
    // below didn't resolve). null while not degraded.
    degraded_reason: null,
  }
  const seqAllocators = new Map() // `${adw_id}:${kind}` -> next seq

  // IN-PROCESS REGISTRY — the finalizer's ONLY source of truth. It must
  // never gate on the mirror (getSession/dumpTable), because the mirror is
  // OPTIONAL: below floor, after an open failure, or after close(), it
  // answers null/[] even though the JSONL raw record — the actual
  // authority — is still being written. Reading the mirror there would
  // silently drop the finalizer's own JSONL lines on exactly the runtimes
  // most likely to need them. Updated by every relevant writer regardless
  // of degraded state; never touches sqlite.
  const sessionStatusByAdwId = new Map() // adw_id -> status
  const runningProcesses = new Map() // JSON.stringify([adw_id,pid,started_at]) -> {adw_id,pid,started_at}
  function processRegistryKey(adwId, pid, startedAt) {
    return JSON.stringify([adwId, pid, startedAt])
  }

  let db = null
  let dbOpenAttempted = false
  let degraded = !versionAtLeast(nodeVersion, NODE_FLOOR)
  let degradedNoticeWritten = false

  function noteDegraded(reason, code) {
    degraded = true
    if (!stats.degraded_reason) {
      stats.degraded_reason = code || 'unknown'
    }
    if (!degradedNoticeWritten) {
      degradedNoticeWritten = true
      stderr.write(`ledger: degraded (${reason}) — mirror disabled, JSONL recording continues\n`)
    }
  }

  function ensureDirAndPerms() {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mode is masked by the process umask, so an explicit chmod is what
    // actually guarantees 0700.
    chmodIfExists(dir, 0o700)
  }

  // Lazily opens the SQLite mirror on first real access. Synchronous by
  // design (createRequire, not await import()) so every writer stays
  // synchronous and "no write transaction spans an await" is structurally
  // impossible to violate.
  // Bounded, immediate (no-sleep) open-lock retry budget — see the
  // CONCURRENCY SEAM comment in the catch block below for why this exists
  // and why it can never sleep. Raised from a single retry (round 3) to a
  // small bounded count: a live two-real-process race on a brand-new db
  // (#41's own SEQ RESERVATION UNDER CONCURRENCY test) showed a single
  // retry insufficient on a loaded CI runner — one side's ensureDb()
  // permanently degraded after losing the race twice, silently dropping
  // every subsequent mirror write for that process's whole lifetime with
  // NO stats signal at all (mirror() never even runs fn() on a null
  // connection, so mirror_errors is never touched either).
  const OPEN_LOCK_RETRY_BUDGET = 5
  let openLockRetries = 0
  function ensureDb() {
    if (db || dbOpenAttempted) return db
    if (degraded) {
      dbOpenAttempted = true
      // Below-floor degradation is decided at openLedger() time, but the
      // one required stderr notice is still emitted lazily, on first real
      // access, consistent with this handle's lazy-open contract.
      noteDegraded(`node ${nodeVersion} is below NODE_FLOOR ${NODE_FLOOR}`, 'below_floor')
      return null
    }
    try {
      ensureDirAndPerms()
      const { DatabaseSync } = require('node:sqlite')
      const conn = new DatabaseSync(dbPath)
      // busy_timeout is set FIRST, before journal_mode/synchronous: those
      // two pragmas (and the migrations that follow) can themselves throw
      // "database is locked" against a freshly-created db another process
      // is concurrently opening, and only a statement that runs AFTER
      // busy_timeout is applied gets SQLite's own internal wait — setting
      // it any later left journal_mode/synchronous themselves exposed to
      // an instant, unprotected lock failure.
      conn.exec('PRAGMA busy_timeout = 5000')
      conn.exec('PRAGMA journal_mode = WAL')
      conn.exec('PRAGMA synchronous = 1')
      applyMigrations(conn)
      chmodIfExists(dbPath, 0o600)
      chmodIfExists(`${dbPath}-wal`, 0o600)
      chmodIfExists(`${dbPath}-shm`, 0o600)
      db = conn
      dbOpenAttempted = true
      return db
    } catch (err) {
      // CONCURRENCY SEAM: two processes racing to open + migrate the SAME
      // fresh db can hit "database is locked" even with busy_timeout set
      // (the timeout covers a statement already inside a transaction, not
      // the initial connect + first-migration race — narrowed, not closed,
      // by setting busy_timeout first above). A bounded run of IMMEDIATE
      // retries (no sleep — busy_timeout=5000 already provides the wait
      // inside SQLite itself for every statement after the first) avoids
      // permanently degrading a handle purely because it lost a benign
      // first-open race; exhausting the budget still degrades as usual.
      // Deliberately does NOT call sleepSync: that helper stays confined to
      // killVerb (an explicit foreground operator command) — every
      // writer/reader, and now the finalizer's registry lookups, route
      // through ensureDb, and none of them may block on a synchronous
      // Atomics.wait.
      if (openLockRetries < OPEN_LOCK_RETRY_BUDGET && isLockedError(err)) {
        openLockRetries += 1
        return ensureDb()
      }
      dbOpenAttempted = true
      noteDegraded(err && err.message ? err.message : String(err), (err && (err.code || err.name)) || 'open_failed')
      return null
    }
  }

  function appendJsonl(kind, args) {
    ensureDirAndPerms()
    const line = { v: LEDGER_VERSION, kind, at: isoMs(now()), args }
    appendFileSync(jsonlPath, `${JSON.stringify(line)}\n`)
    chmodIfExists(jsonlPath, 0o600)
  }

  function mirror(fn) {
    const conn = ensureDb()
    if (!conn) return
    try {
      fn(conn)
    } catch (err) {
      stats.mirror_errors += 1
      if (!stats.mirror_first_code) {
        stats.mirror_first_code = err.code ?? err.name ?? 'UnknownMirrorError'
      }
    }
  }

  function nextSeq(adwId, kind) {
    const key = `${adwId}:${kind}`
    if (!seqAllocators.has(key)) {
      let max = 0
      const conn = ensureDb()
      if (conn) {
        try {
          const table = kind === 'phase' ? 'phases' : 'events'
          const row = conn.prepare(`SELECT MAX(seq) AS m FROM ${table} WHERE adw_id = ?`).get(adwId)
          max = row && row.m != null ? Number(row.m) : 0
        } catch {
          max = 0
        }
      }
      seqAllocators.set(key, max)
    }
    const next = seqAllocators.get(key) + 1
    seqAllocators.set(key, next)
    return next
  }

  // Only `undefined` (key absent or explicitly undefined) counts as
  // missing — `null` is a legitimate explicit value for several required
  // keys (e.g. endProcess's exit_code/exit_signal on a signal-killed
  // process), so it must not be rejected here.
  function requireFields(obj, fields, ctx) {
    for (const f of fields) {
      if (obj[f] === undefined) {
        refuse(`${ctx}: missing required field '${f}'`)
      }
    }
  }

  function requireEnum(value, enumValues, ctx, field) {
    if (!enumValues.includes(value)) {
      // Never embed the raw offending value — it is caller-controlled and
      // may carry a redaction marker or other sensitive bytes that would
      // otherwise reach stderr unredacted. Name the field and the allowed
      // set only.
      refuse(`${ctx}: field '${field}' must be one of ${enumValues.join('|')}`)
    }
  }

  // ---- writers ------------------------------------------------------------

  function startSession(input = {}) {
    requireFields(input, ['adw_id', 'repo_slug', 'task_slug'], 'startSession')
    const args = redact({
      adw_id: input.adw_id,
      repo_slug: input.repo_slug,
      task_slug: input.task_slug,
      started_at: isoMs(input.started_at ?? now()),
      ended_at: null,
      status: 'running',
      billed_input_tokens: null,
      billed_output_tokens: null,
      billed_cache_write_tokens: null,
      billed_cache_read_tokens: null,
      billed_cost_usd: null,
      ledger_version: LEDGER_VERSION,
    }, stats)
    sessionStatusByAdwId.set(args.adw_id, args.status)
    appendJsonl('startSession', args)
    mirror((conn) => {
      conn.prepare(`INSERT OR IGNORE INTO sessions (${tableColumnNames('sessions').join(', ')}) VALUES (${tableColumnNames('sessions').map(() => '?').join(', ')})`)
        .run(...tableColumnNames('sessions').map((c) => toBindable(args[c])))
    })
    return args
  }

  function endSession(input = {}) {
    requireFields(input, ['adw_id', 'status'], 'endSession')
    requireEnum(input.status, SESSION_STATUSES, 'endSession', 'status')
    const args = redact({
      adw_id: input.adw_id,
      ended_at: isoMs(input.ended_at ?? now()),
      status: input.status,
      billed_input_tokens: input.billed_input_tokens ?? null,
      billed_output_tokens: input.billed_output_tokens ?? null,
      billed_cache_write_tokens: input.billed_cache_write_tokens ?? null,
      billed_cache_read_tokens: input.billed_cache_read_tokens ?? null,
      billed_cost_usd: input.billed_cost_usd ?? null,
    }, stats)
    sessionStatusByAdwId.set(args.adw_id, args.status)
    appendJsonl('endSession', args)
    mirror((conn) => {
      // COALESCE(?, column): an omitted billed_* field normalizes to null
      // above, and binding null here leaves the existing column value
      // untouched rather than clobbering it. This is what makes the
      // finalizer's bare `endSession({status:'fail'})` (no spend figures)
      // safe to call without erasing a session's already-recorded spend.
      conn.prepare(`
        UPDATE sessions SET ended_at = ?, status = ?,
          billed_input_tokens = COALESCE(?, billed_input_tokens),
          billed_output_tokens = COALESCE(?, billed_output_tokens),
          billed_cache_write_tokens = COALESCE(?, billed_cache_write_tokens),
          billed_cache_read_tokens = COALESCE(?, billed_cache_read_tokens),
          billed_cost_usd = COALESCE(?, billed_cost_usd)
        WHERE adw_id = ?
      `).run(
        toBindable(args.ended_at), toBindable(args.status),
        toBindable(args.billed_input_tokens), toBindable(args.billed_output_tokens),
        toBindable(args.billed_cache_write_tokens), toBindable(args.billed_cache_read_tokens),
        toBindable(args.billed_cost_usd),
        toBindable(args.adw_id),
      )
    })
    return args
  }

  function startPhase(input = {}) {
    requireFields(input, ['adw_id', 'name'], 'startPhase')
    const seq = input.seq ?? nextSeq(input.adw_id, 'phase')
    const args = redact({
      adw_id: input.adw_id,
      seq,
      name: input.name,
      started_at: isoMs(input.started_at ?? now()),
      ended_at: null,
      status: 'running',
    }, stats)
    appendJsonl('startPhase', args)
    let phaseId = null
    mirror((conn) => {
      const cols = tableColumnNames('phases').filter((c) => c !== 'id')
      const res = conn.prepare(`INSERT OR IGNORE INTO phases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
      // lastInsertRowid is CONNECTION-GLOBAL, not statement-scoped — when
      // the INSERT OR IGNORE is ignored (a natural-key collision), it still
      // reads back the id of whatever row this connection inserted LAST
      // (possibly in a completely different table). Only trust it when
      // `changes === 1` proves THIS statement actually inserted a row;
      // otherwise the row already existed and must be looked up by its
      // natural key.
      if (res.changes === 1) {
        phaseId = Number(res.lastInsertRowid)
      } else {
        const row = conn.prepare('SELECT id FROM phases WHERE adw_id = ? AND seq = ?').get(args.adw_id, args.seq)
        phaseId = row ? Number(row.id) : null
      }
    })
    return phaseId
  }

  function endPhase(input = {}) {
    requireFields(input, ['adw_id', 'seq', 'status'], 'endPhase')
    requireEnum(input.status, PHASE_STATUSES, 'endPhase', 'status')
    const args = redact({
      adw_id: input.adw_id,
      seq: input.seq,
      ended_at: isoMs(input.ended_at ?? now()),
      status: input.status,
    }, stats)
    appendJsonl('endPhase', args)
    mirror((conn) => {
      conn.prepare('UPDATE phases SET ended_at = ?, status = ? WHERE adw_id = ? AND seq = ?')
        .run(toBindable(args.ended_at), toBindable(args.status), toBindable(args.adw_id), toBindable(args.seq))
    })
    return args
  }

  function recordEvent(input = {}) {
    requireFields(input, ['adw_id', 'type'], 'recordEvent')
    if (input.type === 'heartbeat') {
      // Heartbeats are columns, never events (see the module-level
      // `heartbeat` writer) — this refusal is specifically named so a
      // caller cannot accidentally record one as a generic event.
      refuse('recordEvent: heartbeat is not an event type — use the heartbeat() writer', 'heartbeat_is_not_an_event')
    }
    requireEnum(input.type, EVENT_TYPES, 'recordEvent', 'type')
    const seq = input.seq ?? nextSeq(input.adw_id, 'event')
    // Redact BEFORE stringifying: once payload is JSON text, a nested
    // DEVTEAM_*-shaped key is no longer a real object key the key-based
    // scan below can see — only value-substring scanning still applies.
    // args carries `payload` as the resolved OBJECT (matching this
    // method's own public parameter shape, not the events-table row shape)
    // so replayJsonl's `ledger.recordEvent(args)` dispatch round-trips
    // exactly; payload_json is derived from it only at mirror-insert time.
    const payload = redact(applyPayloadAllowlist(input.type, input.payload, stats), stats)
    const args = redact({
      adw_id: input.adw_id,
      seq,
      type: input.type,
      phase_id: input.phase_id ?? null,
      parent_id: input.parent_id ?? null,
      started_at: input.started_at != null ? isoMs(input.started_at) : (input.type === 'tool_call' ? isoMs(now()) : null),
      ended_at: input.ended_at != null ? isoMs(input.ended_at) : (input.type === 'tool_call' ? isoMs(now()) : null),
      payload,
    }, stats)
    appendJsonl('recordEvent', args)
    mirror((conn) => {
      const eventRow = { ...args, payload_json: JSON.stringify(args.payload) }
      const cols = tableColumnNames('events').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(eventRow[c])))
    })
    return args
  }

  function recordEnvelope(input = {}) {
    requireFields(input, ['adw_id', 'dispatch_id', 'slice_id', 'attempt', 'role', 'produced_at', 'schema_version', 'envelope_path', 'body_kind', 'valid'], 'recordEnvelope')
    const args = redact({
      adw_id: input.adw_id,
      dispatch_id: input.dispatch_id,
      slice_id: input.slice_id,
      attempt: input.attempt,
      role: input.role,
      produced_at: isoMs(input.produced_at),
      schema_version: input.schema_version,
      envelope_path: input.envelope_path,
      body_kind: input.body_kind,
      valid: !!input.valid,
      // Kept as an array in args (recordEnvelope's own public parameter
      // shape) — JSON.stringify happens only at mirror-insert time, so
      // replayJsonl's `ledger.recordEnvelope(args)` round-trips exactly.
      violation_names: redact(input.violation_names ?? [], stats),
    }, stats)
    appendJsonl('recordEnvelope', args)
    mirror((conn) => {
      const row = { ...args, violation_names: JSON.stringify(args.violation_names) }
      const cols = tableColumnNames('envelopes').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO envelopes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(row[c])))
    })
    return args
  }

  function recordGateResult(input = {}) {
    requireFields(input, ['adw_id', 'phase_id', 'gate_name', 'attempt', 'ok'], 'recordGateResult')
    const args = redact({
      adw_id: input.adw_id,
      phase_id: input.phase_id,
      gate_name: input.gate_name,
      attempt: input.attempt,
      ok: !!input.ok,
      // checks/violations are #28's gates-CLI vocabulary and are stored
      // VERBATIM (structure never re-shaped) — redaction still runs first,
      // same as every other writer's field-hygiene pass. Kept as arrays in
      // args (this method's own public parameter shape); stringified only
      // at mirror-insert time so replay round-trips exactly.
      checks: redact(input.checks ?? [], stats),
      violations: redact(input.violations ?? [], stats),
      created_at: isoMs(input.created_at ?? now()),
      gate_generation: input.gate_generation ?? null,
      pristine: input.pristine == null ? null : !!input.pristine,
    }, stats)
    appendJsonl('recordGateResult', args)
    mirror((conn) => {
      const row = {
        ...args,
        checks_json: JSON.stringify(args.checks),
        violations_json: JSON.stringify(args.violations),
      }
      const cols = tableColumnNames('gate_results').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO gate_results (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(row[c])))
    })
    return args
  }

  function recordGateDiscrimination(input = {}) {
    requireFields(input, ['adw_id', 'gate_generation', 'verdict'], 'recordGateDiscrimination')
    requireEnum(input.verdict, GATE_DISCRIMINATION_VERDICTS, 'recordGateDiscrimination', 'verdict')
    const args = redact({
      adw_id: input.adw_id,
      phase_id: input.phase_id ?? null,
      gate_generation: input.gate_generation,
      verdict: input.verdict,
      checks_total: input.checks_total ?? null,
      checks_failed: input.checks_failed ?? null,
      checks_errored: input.checks_errored ?? null,
      note: input.note == null ? null : String(input.note),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    // `note` is the one free-text field on these outcome tables: it is
    // redacted above, then bounded so operator detail cannot grow without
    // limit in the durable record.
    if (args.note != null) args.note = args.note.slice(0, 500)
    appendJsonl('recordGateDiscrimination', args)
    mirror((conn) => {
      const cols = tableColumnNames('gate_discriminations').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO gate_discriminations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordReviewOutcome(input = {}) {
    requireFields(input, ['adw_id', 'dispatch_id', 'verdict'], 'recordReviewOutcome')
    requireEnum(input.verdict, REVIEW_VERDICTS, 'recordReviewOutcome', 'verdict')
    const args = redact({
      adw_id: input.adw_id,
      phase_id: input.phase_id ?? null,
      dispatch_id: input.dispatch_id,
      role: input.role ?? null,
      verdict: input.verdict,
      must_fix: input.must_fix ?? null,
      should_fix: input.should_fix ?? null,
      consider: input.consider ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    appendJsonl('recordReviewOutcome', args)
    mirror((conn) => {
      const cols = tableColumnNames('review_outcomes').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO review_outcomes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function startProcess(input = {}) {
    requireFields(input, ['adw_id', 'dispatch_id', 'pid', 'command'], 'startProcess')
    const args = redact({
      adw_id: input.adw_id,
      dispatch_id: input.dispatch_id,
      pid: input.pid,
      command: input.command,
      started_at: isoMs(input.started_at ?? now()),
      ended_at: null,
      exit_code: null,
      exit_signal: null,
      last_heartbeat_at: null,
      state: 'running',
    }, stats)
    runningProcesses.set(processRegistryKey(args.adw_id, args.pid, args.started_at), {
      adw_id: args.adw_id, pid: args.pid, started_at: args.started_at,
    })
    appendJsonl('startProcess', args)
    mirror((conn) => {
      const cols = tableColumnNames('processes').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO processes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function endProcess(input = {}) {
    requireFields(input, ['adw_id', 'pid', 'started_at', 'exit_code', 'exit_signal', 'state'], 'endProcess')
    requireEnum(input.state, PROCESS_STATES, 'endProcess', 'state')
    const args = redact({
      adw_id: input.adw_id,
      pid: input.pid,
      started_at: isoMs(input.started_at),
      ended_at: isoMs(input.ended_at ?? now()),
      exit_code: input.exit_code,
      exit_signal: input.exit_signal,
      state: input.state,
    }, stats)
    runningProcesses.delete(processRegistryKey(args.adw_id, args.pid, args.started_at))
    appendJsonl('endProcess', args)
    mirror((conn) => {
      conn.prepare(`
        UPDATE processes SET ended_at = ?, exit_code = ?, exit_signal = ?, state = ?
        WHERE adw_id = ? AND pid = ? AND started_at = ?
      `).run(
        toBindable(args.ended_at), toBindable(args.exit_code), toBindable(args.exit_signal),
        toBindable(args.state), toBindable(args.adw_id), toBindable(args.pid), toBindable(args.started_at),
      )
    })
    return args
  }

  function heartbeat(input = {}) {
    requireFields(input, ['adw_id', 'target'], 'heartbeat')
    requireEnum(input.target, ['process', 'agent_session'], 'heartbeat', 'target')
    if (input.target === 'process') {
      requireFields(input, ['pid', 'started_at'], 'heartbeat(process)')
    } else {
      requireFields(input, ['claude_session_id'], 'heartbeat(agent_session)')
    }
    const args = redact({
      adw_id: input.adw_id,
      target: input.target,
      at: isoMs(input.at ?? now()),
      pid: input.pid ?? null,
      started_at: input.started_at != null ? isoMs(input.started_at) : null,
      claude_session_id: input.claude_session_id ?? null,
    }, stats)
    appendJsonl('heartbeat', args)
    mirror((conn) => {
      if (args.target === 'process') {
        conn.prepare('UPDATE processes SET last_heartbeat_at = ? WHERE adw_id = ? AND pid = ? AND started_at = ?')
          .run(toBindable(args.at), toBindable(args.adw_id), toBindable(args.pid), toBindable(args.started_at))
      } else {
        conn.prepare('UPDATE agent_sessions SET last_heartbeat_at = ? WHERE adw_id = ? AND claude_session_id = ?')
          .run(toBindable(args.at), toBindable(args.adw_id), toBindable(args.claude_session_id))
      }
    })
    return args
  }

  function startAgentSession(input = {}) {
    requireFields(input, ['adw_id', 'dispatch_id', 'role', 'model', 'claude_session_id', 'transcript_path'], 'startAgentSession')
    const args = redact({
      adw_id: input.adw_id,
      dispatch_id: input.dispatch_id,
      role: input.role,
      model: input.model,
      claude_session_id: input.claude_session_id,
      transcript_path: input.transcript_path,
      started_at: isoMs(input.started_at ?? now()),
      ended_at: null,
      context_tokens: null,
      context_window: null,
      raw_read_tokens: null,
      raw_written_tokens: null,
      billed_input_tokens: null,
      billed_output_tokens: null,
      billed_cache_write_tokens: null,
      billed_cache_read_tokens: null,
      last_heartbeat_at: null,
    }, stats)
    appendJsonl('startAgentSession', args)
    mirror((conn) => {
      const cols = tableColumnNames('agent_sessions').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO agent_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function endAgentSession(input = {}) {
    requireFields(input, [
      'adw_id', 'claude_session_id', 'context_tokens', 'context_window',
      'raw_read_tokens', 'raw_written_tokens', 'billed_input_tokens',
      'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens',
    ], 'endAgentSession')
    const args = redact({
      adw_id: input.adw_id,
      claude_session_id: input.claude_session_id,
      ended_at: isoMs(input.ended_at ?? now()),
      context_tokens: input.context_tokens,
      context_window: input.context_window,
      raw_read_tokens: input.raw_read_tokens,
      raw_written_tokens: input.raw_written_tokens,
      billed_input_tokens: input.billed_input_tokens,
      billed_output_tokens: input.billed_output_tokens,
      billed_cache_write_tokens: input.billed_cache_write_tokens,
      billed_cache_read_tokens: input.billed_cache_read_tokens,
    }, stats)
    appendJsonl('endAgentSession', args)
    mirror((conn) => {
      conn.prepare(`
        UPDATE agent_sessions SET ended_at = ?, context_tokens = ?, context_window = ?,
          raw_read_tokens = ?, raw_written_tokens = ?, billed_input_tokens = ?,
          billed_output_tokens = ?, billed_cache_write_tokens = ?, billed_cache_read_tokens = ?
        WHERE adw_id = ? AND claude_session_id = ?
      `).run(
        toBindable(args.ended_at), toBindable(args.context_tokens), toBindable(args.context_window),
        toBindable(args.raw_read_tokens), toBindable(args.raw_written_tokens),
        toBindable(args.billed_input_tokens), toBindable(args.billed_output_tokens),
        toBindable(args.billed_cache_write_tokens), toBindable(args.billed_cache_read_tokens),
        toBindable(args.adw_id), toBindable(args.claude_session_id),
      )
    })
    return args
  }

  // recordSourceError writes an `error` EVENT row and no mirror row for the
  // offending source itself. Two hard rules for the caller (documented
  // here, at the boundary, because this is the value-leak channel):
  //  - violation_names must be built as `${v.path}:${v.keyword}` — NEVER
  //    `v.message`. The retired contract.mjs built every violation
  //    `message` by embedding the offending value verbatim (e.g. `expected
  //    type X, got ${JSON.stringify(value)}`), so a message string is an
  //    uncontrolled copy of task-controlled bytes. Any element that fails
  //    the closed `path:keyword` shape check is dropped and counted rather
  //    than stored.
  //  - reason is constrained to a closed set (RecordInvalidError,
  //    SyntaxError, Error); anything else is coerced to 'Error'.
  //  - byte_size comes from the caller's own stat — this module never stats
  //    the source file itself.
  function recordSourceError(input = {}) {
    requireFields(input, ['adw_id', 'source_path', 'source_kind', 'byte_size', 'reason'], 'recordSourceError')
    const reason = SOURCE_ERROR_REASONS.includes(input.reason) ? input.reason : 'Error'
    const rawNames = Array.isArray(input.violation_names) ? input.violation_names : []
    let dropped = 0
    const violationNames = rawNames.filter((n) => {
      const ok = typeof n === 'string' && VIOLATION_NAME_RE.test(n)
      if (!ok) dropped += 1
      return ok
    })
    stats.dropped_payload_keys += dropped
    const seq = input.seq ?? nextSeq(input.adw_id, 'event')
    // args is stored to JSONL in recordSourceError's OWN public-parameter
    // shape (not the events-table row shape) — replayJsonl dispatches
    // `ledger[kind](args)`, so args must be exactly what this method itself
    // accepts as input, already-normalized (a re-application on replay is
    // then a deterministic no-op: reason/violation_names are idempotent to
    // re-validate, seq is already resolved).
    const args = redact({
      adw_id: input.adw_id,
      seq,
      source_path: input.source_path,
      source_kind: input.source_kind,
      byte_size: input.byte_size,
      violation_names: violationNames,
      reason,
      phase_id: input.phase_id ?? null,
      parent_id: input.parent_id ?? null,
    }, stats)
    appendJsonl('recordSourceError', args)
    mirror((conn) => {
      const payload = applyPayloadAllowlist('error', {
        reason: args.reason,
        source_path: args.source_path,
        source_kind: args.source_kind,
        byte_size: args.byte_size,
        violation_names: args.violation_names,
      }, stats)
      const eventRow = {
        adw_id: args.adw_id,
        seq: args.seq,
        type: 'error',
        phase_id: args.phase_id,
        parent_id: args.parent_id,
        started_at: null,
        ended_at: null,
        payload_json: JSON.stringify(payload),
      }
      const cols = tableColumnNames('events').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(eventRow[c])))
    })
    return args
  }

  // ---- readers --------------------------------------------------------------

  function listSessions() {
    const conn = ensureDb()
    if (!conn) return []
    try {
      return conn.prepare('SELECT * FROM sessions ORDER BY adw_id').all()
    } catch {
      return []
    }
  }

  function getSession(adwId) {
    const conn = ensureDb()
    if (!conn) return null
    try {
      return conn.prepare('SELECT * FROM sessions WHERE adw_id = ?').get(adwId) ?? null
    } catch {
      return null
    }
  }

  // Polling query serving both live tail and history. `afterRowid` is
  // exclusive; `id` (an alias for events' rowid, since events.id is
  // INTEGER PRIMARY KEY AUTOINCREMENT) is used explicitly in the WHERE/
  // ORDER BY clauses so EXPLAIN QUERY PLAN reliably names events_adw_id_idx
  // (which is declared ON events(adw_id, id)).
  function listEvents({ adw_id: adwId, afterRowid = 0, limit } = {}) {
    const conn = ensureDb()
    if (!conn) return []
    try {
      const lim = limit ?? 50
      return conn.prepare('SELECT * FROM events WHERE adw_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(adwId, afterRowid, lim)
    } catch {
      return []
    }
  }

  function dumpTable(name) {
    if (!Object.prototype.hasOwnProperty.call(TABLES, name)) {
      // Never embed the raw (caller-controlled) table name in the message —
      // list the closed set of valid names instead.
      refuse(`dumpTable: unknown table — must be one of ${Object.keys(TABLES).join('|')}`)
    }
    const conn = ensureDb()
    if (!conn) return []
    const naturalKey = TABLES[name].unique[0] || [primaryKeyColumn(name)]
    try {
      return conn.prepare(`SELECT * FROM ${name} ORDER BY ${naturalKey.join(', ')}`).all()
    } catch (err) {
      // A query failure here is an OPERATIONAL condition, not a silent
      // empty result — count it the same way mirror() does, so a schema
      // mismatch or locked-db read failure is visible in stats() rather
      // than masquerading as "table has zero rows".
      stats.mirror_errors += 1
      if (!stats.mirror_first_code) {
        stats.mirror_first_code = err.code ?? err.name ?? 'UnknownMirrorError'
      }
      return []
    }
  }

  function queryRows(sql) {
    const conn = ensureDb()
    if (!conn) return []
    try {
      return conn.prepare(sql).all()
    } catch (err) {
      stats.mirror_errors += 1
      if (!stats.mirror_first_code) {
        stats.mirror_first_code = err.code ?? err.name ?? 'UnknownMirrorError'
      }
      return []
    }
  }

  function gateReviewGap() {
    return queryRows(`
      SELECT s.adw_id, s.task_slug,
        (SELECT COUNT(*) FROM gate_results g
           WHERE g.adw_id = s.adw_id AND g.ok = 1 AND COALESCE(g.pristine, 0) = 0) AS green_gate_runs,
        (SELECT COUNT(*) FROM review_outcomes r WHERE r.adw_id = s.adw_id) AS reviews,
        (SELECT MAX(r.must_fix) FROM review_outcomes r WHERE r.adw_id = s.adw_id) AS max_must_fix
      FROM sessions s ORDER BY s.adw_id
    `)
  }

  function eligibleTasks() {
    return queryRows(`
      SELECT s.adw_id, s.task_slug,
        (SELECT MAX(g.gate_generation) FROM gate_results g WHERE g.adw_id = s.adw_id) AS active_generation,
        (SELECT COUNT(*) FROM review_outcomes r WHERE r.adw_id = s.adw_id) AS reviews,
        (SELECT COUNT(*) FROM gate_discriminations d
           WHERE d.adw_id = s.adw_id AND d.verdict = 'proven'
             AND d.gate_generation = (SELECT MAX(g2.gate_generation) FROM gate_results g2 WHERE g2.adw_id = s.adw_id)) AS proven_active
      FROM sessions s ORDER BY s.adw_id
    `)
  }

  // ---- lifecycle / meta -----------------------------------------------------

  function statsFn() {
    return { degraded, ...stats }
  }

  function close() {
    if (db) {
      db.close()
    }
  }

  function installFinalizerOn(opts) {
    return installFinalizerImpl(handle, opts)
  }

  // Pragma readback MUST come from the actual live connection: journal_mode
  // is persisted in the db file header, but synchronous and busy_timeout
  // are per-connection runtime settings that reset to SQLite's own
  // defaults on any freshly-opened connection to the same file — reading
  // them back via a second, throwaway DatabaseSync would silently observe
  // the wrong values. Used by AC-3 and the doctor CLI verb.
  function pragmas() {
    const conn = ensureDb()
    if (!conn) return null
    return {
      journal_mode: conn.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: conn.prepare('PRAGMA synchronous').get().synchronous,
      busy_timeout: conn.prepare('PRAGMA busy_timeout').get().timeout,
    }
  }

  const handle = {
    get degraded() { return degraded },
    startSession, endSession, startPhase, endPhase, recordEvent, recordEnvelope,
    recordGateResult, recordGateDiscrimination, recordReviewOutcome,
    startProcess, endProcess, heartbeat, startAgentSession, endAgentSession,
    recordSourceError,
    listSessions, listEvents, getSession, dumpTable, gateReviewGap, eligibleTasks,
    stats: statsFn,
    close,
    installFinalizer: installFinalizerOn,
    // internal, used by the doctor CLI verb and tests only:
    _dbPath: dbPath,
    _jsonlPath: jsonlPath,
    _probeFts5,
    _pragmas: pragmas,
    // internal, used ONLY by installFinalizerImpl (the in-process registry
    // — never the mirror — is the finalizer's source of truth; see its
    // declaration above for why) and by tests that need to inspect it:
    _registry: {
      sessionStatus: (adwId) => sessionStatusByAdwId.get(adwId) ?? null,
      runningProcessesFor: (adwId) => [...runningProcesses.values()].filter((p) => p.adw_id === adwId),
    },
  }

  return handle
}

// CREATE VIRTUAL TABLE ... USING fts5(x) is attempted against a :memory:
// database — a capability readout only (#60 lands real FTS5 later). The
// result is printed by callers, never asserted here.
function _probeFts5() {
  try {
    const { DatabaseSync } = require('node:sqlite')
    const conn = new DatabaseSync(':memory:')
    conn.exec('CREATE VIRTUAL TABLE probe USING fts5(x)')
    conn.close()
    return { available: true }
  } catch (err) {
    return { available: false, error_name: err.name || 'Error' }
  }
}

// ---------------------------------------------------------------------------
// replayJsonl — dispatcher over the public write API, the whole point of
// AC-5: there is no separate replay code path.
// ---------------------------------------------------------------------------

export function replayJsonl(jsonlPath, ledger) {
  let applied = 0
  let skipped = 0
  if (!existsSync(jsonlPath)) {
    return { applied, skipped }
  }
  const content = readFileSync(jsonlPath, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (!parsed || !WRITERS.includes(parsed.kind)) {
      // Never embed the raw `kind` value — a JSONL line is externally
      // controlled data (this is a replay entry point) and could carry a
      // redaction marker. Name the closed WRITERS set instead.
      refuse(`replayJsonl: line has an unknown kind — must be one of ${WRITERS.join('|')}`)
    }
    ledger[parsed.kind](parsed.args)
    applied += 1
  }
  return { applied, skipped }
}

// ---------------------------------------------------------------------------
// installFinalizer — explicit opt-in only, NEVER installed at import.
// ---------------------------------------------------------------------------

const finalizerHandles = new WeakMap()

function installFinalizerImpl(ledger, { adw_id: adwId, signals = ['SIGTERM', 'SIGINT'] } = {}) {
  if (finalizerHandles.has(ledger)) {
    return finalizerHandles.get(ledger)
  }
  const listeners = []
  function onSignal(sig) {
    try {
      // Read first, but from the IN-PROCESS REGISTRY, never the mirror
      // (ledger.getSession would answer null on a degraded handle — below
      // floor, an open failure, or after close() — even though the JSONL
      // raw record, the actual authority, is exactly what still needs this
      // line). Land 'fail' when the registry says running, OR when it has
      // no answer at all (a session this process's registry never saw
      // start — e.g. handed off from elsewhere): endSession for a session
      // that never locally started is one harmless JSONL line plus a
      // no-op mirror UPDATE, which is strictly better than silently
      // dropping the record. Only skip when the registry POSITIVELY knows
      // the session already reached a terminal status — that is the one
      // case an unconditional endSession would clobber real data.
      const status = ledger._registry.sessionStatus(adwId)
      if (status === 'running' || status === null) {
        ledger.endSession({ adw_id: adwId, status: 'fail' })
      }
    } catch {
      // Best-effort: a session that never started has nothing to land.
    }
    try {
      // Same registry-not-mirror rule for processes: dumpTable('processes')
      // would answer [] on a degraded handle.
      const procs = ledger._registry.runningProcessesFor(adwId)
      for (const p of procs) {
        ledger.endProcess({
          adw_id: p.adw_id, pid: p.pid, started_at: p.started_at,
          ended_at: Date.now(), exit_code: null, exit_signal: sig, state: 'killed',
        })
      }
    } catch {
      // Mirror-side best-effort; the JSONL side of endSession above already
      // landed regardless.
    }
    const signum = sig === 'SIGINT' ? 2 : 15
    process.exitCode = 128 + signum
    uninstall()
    // Re-raise so the signal is not swallowed — setting exitCode first
    // means a process kept alive by another listener still exits right.
    process.kill(process.pid, sig)
  }
  function uninstall() {
    for (const { sig, fn } of listeners) {
      process.removeListener(sig, fn)
    }
    finalizerHandles.delete(ledger)
  }
  for (const sig of signals) {
    const fn = () => onSignal(sig)
    process.on(sig, fn)
    listeners.push({ sig, fn })
  }
  const uninstallHandle = { uninstall }
  finalizerHandles.set(ledger, uninstallHandle)
  return uninstallHandle
}

// ---------------------------------------------------------------------------
// defaultDbPath — CLI ONLY. Library callers (issue #41) must pass dbPath
// explicitly; tests never call this — they set DEVTEAM_LEDGER_DB in the
// spawned CLI's own environment so the real ~/.dev-team/factory/ is never
// touched by the suite.
// ---------------------------------------------------------------------------

export function defaultDbPath() {
  if (process.env.DEVTEAM_LEDGER_DB) return process.env.DEVTEAM_LEDGER_DB
  const dir = process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  return join(dir, 'ledger.db')
}

// ---------------------------------------------------------------------------
// kill helper — operator-invoked CLI verb only, never a convenience library
// export. This is a REFUSAL GATE, NOT identity proof: a pid can be recycled
// and a command line can be forged. It exists to stop the obvious mistake,
// not to prove identity.
// ---------------------------------------------------------------------------

function livePsCommand(pid) {
  const res = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (res.status !== 0) return null
  const out = (res.stdout || '').trim()
  return out === '' ? null : out
}

// Blocks the CALLING (foreground CLI) process for up to `ms`, in ~100ms
// slices, using Atomics.wait on a scratch SharedArrayBuffer. Node cannot
// dispatch signal handlers while the main thread is blocked synchronously
// like this — acceptable here because `kill` is a foreground operator
// command, and precisely why the FINALIZER (async-context signal handling)
// must never share this code path.
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// TEST SEAM: DEVTEAM_LEDGER_TERM_TO_KILL_MS lets a test shorten the
// SIGTERM-to-SIGKILL wait deterministically (a real 5s wait per test would
// make the escalation path prohibitively slow to exercise). It can only
// ever SHORTEN the wait — clamped to (0, TERM_TO_KILL_MS] — never lengthen
// it or bypass any refusal gate; an invalid/unparseable value is ignored.
function effectiveTermToKillMs() {
  const raw = process.env.DEVTEAM_LEDGER_TERM_TO_KILL_MS
  if (!raw) return TERM_TO_KILL_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return TERM_TO_KILL_MS
  return Math.min(n, TERM_TO_KILL_MS)
}

function killVerb(ledger, { adwId, pid, yes }, stdout, stderr) {
  if (!adwId || !pid || !yes) {
    stderr.write('ledger kill: requires --adw-id, --pid and --yes\n')
    return 2
  }
  const pidNum = Number(pid)
  if (!Number.isInteger(pidNum) || pidNum <= 1) {
    stderr.write('ledger kill: refused — pid must be an integer > 1\n')
    return 2
  }
  if (pidNum === process.pid || pidNum === process.ppid) {
    stderr.write('ledger kill: refused — pid matches this process or its parent\n')
    return 2
  }
  const rows = ledger.dumpTable('processes').filter((p) => p.adw_id === adwId && p.pid === pidNum)
  if (rows.length === 0) {
    stderr.write('ledger kill: refused — no matching processes row for that (adw_id, pid)\n')
    return 2
  }
  const row = rows[rows.length - 1]
  const liveCommand = livePsCommand(pidNum)
  if (liveCommand === null || liveCommand !== row.command) {
    stderr.write('ledger kill: refused — recorded command does not match the live process (REFUSAL GATE, not identity proof)\n')
    return 2
  }

  process.kill(pidNum, 'SIGTERM')
  const termToKillMs = effectiveTermToKillMs()
  const sliceMs = Math.min(100, termToKillMs)
  let waited = 0
  while (waited < termToKillMs && isAlive(pidNum)) {
    sleepSync(sliceMs)
    waited += sliceMs
  }
  if (!isAlive(pidNum)) {
    stdout.write(`${JSON.stringify({ pid: pidNum, adw_id: adwId, result: 'terminated' })}\n`)
    return 0
  }

  // Re-check pid liveness + command + recorded started_at before SIGKILL —
  // abandon on any mismatch (this is still a refusal gate, not identity
  // proof: it narrows the window, it does not close it). started_at is
  // part of the row's own natural key, so re-reading the CURRENT row for
  // (adw_id, pid) and comparing it against the row we gated on catches a
  // pid recycled/reused by a NEW startProcess call during the wait.
  const recheckCommand = livePsCommand(pidNum)
  const recheckRows = ledger.dumpTable('processes').filter((p) => p.adw_id === adwId && p.pid === pidNum)
  const recheckRow = recheckRows[recheckRows.length - 1]
  if (!isAlive(pidNum) || recheckCommand !== row.command || !recheckRow || recheckRow.started_at !== row.started_at) {
    stderr.write('ledger kill: abandoned before SIGKILL — pid/command/started_at mismatch on re-check\n')
    return 2
  }
  process.kill(pidNum, 'SIGKILL')
  stdout.write(`${JSON.stringify({ pid: pidNum, adw_id: adwId, result: 'killed' })}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// --yes is the one boolean (no-value) flag in this CLI's vocabulary.
const BOOLEAN_FLAGS = new Set(['yes'])

function parseArgs(argv) {
  const [verb, ...rest] = argv
  const positional = []
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
      } else {
        flags[name] = rest[i + 1]
        i += 1
      }
    } else {
      positional.push(a)
    }
  }
  return { verb, positional, flags }
}

// The unaudited fields this ledger records but never verifies against any
// external source — mirrors task-cost-log.mjs's frozen `unverified` array.
const UNVERIFIED_FIELDS = Object.freeze(['task_slug', 'repo_slug'])

export function main(argv) {
  const stdout = process.stdout
  const stderr = process.stderr
  try {
    const { verb, positional, flags } = parseArgs(argv)
    if (!verb) {
      refuse('a verb is required: sessions | phases | tail | procs | gate-review-gap | eligible-tasks | doctor | kill')
    }

    // TEST SEAM: DEVTEAM_LEDGER_FAKE_NODE_VERSION substitutes for
    // process.versions.node in the floor comparison below, so the
    // below-floor CLI path (AC-8a) is exercisable on any real runtime. Its
    // only possible effect is to DEGRADE — forcing a high fake version on
    // a genuinely low runtime just makes the node:sqlite require fail,
    // which degrades anyway (see ensureDb's catch-all below).
    const fakeVersion = process.env.DEVTEAM_LEDGER_FAKE_NODE_VERSION
    const nodeVersion = fakeVersion || process.versions.node
    if (!versionAtLeast(nodeVersion, NODE_FLOOR)) {
      stderr.write(`ledger: below floor — NODE_FLOOR is ${NODE_FLOOR}, running ${nodeVersion}\n`)
      return 2
    }

    const dbPath = defaultDbPath()
    const ledger = openLedger({ dbPath, nodeVersion, stderr })

    if (verb === 'sessions') {
      const sessions = ledger.listSessions()
      const s = ledger.stats()
      const payload = {
        schema: 1,
        ledger_version: LEDGER_VERSION,
        db_path: dbPath,
        degraded: s.degraded,
        degraded_reason: s.degraded_reason,
        mirror_errors: s.mirror_errors,
        mirror_first_code: s.mirror_first_code,
        dropped_payload_keys: s.dropped_payload_keys,
        redacted_values: s.redacted_values,
        unverified: UNVERIFIED_FIELDS,
        sessions,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      stderr.write(`ledger: ${sessions.length} session(s)\n`)
      return 0
    }

    if (verb === 'gate-review-gap') {
      if (positional.length > 0) refuse('gate-review-gap: takes no positional arguments')
      const rows = ledger.gateReviewGap()
      const denominator = rows.filter((row) => row.green_gate_runs > 0 && row.reviews > 0).length
      const numerator = rows.filter((row) => row.green_gate_runs > 0 && row.reviews > 0 && row.max_must_fix > 0).length
      const payload = {
        schema: 1,
        question: 'How often does a non-pristine green gate run precede a review with must-fix findings?',
        definition: 'gate green means a non-pristine gate_results row with ok = 1',
        denominator,
        numerator,
        rate: denominator === 0 ? null : numerator / denominator,
        rows,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      return 0
    }

    if (verb === 'eligible-tasks') {
      if (positional.length > 0) refuse('eligible-tasks: takes no positional arguments')
      const rows = ledger.eligibleTasks()
      const eligible = rows.filter((row) => row.proven_active > 0 && row.reviews > 0).length
      stdout.write(`${JSON.stringify({ schema: 1, horizon: 20, eligible, rows })}\n`)
      return 0
    }

    if (verb === 'phases' || verb === 'tail' || verb === 'procs') {
      const adwId = positional[0]
      if (!adwId) {
        refuse(`${verb}: requires an adw_id argument`)
      }
      if (verb === 'phases') {
        const rows = ledger.dumpTable('phases').filter((r) => r.adw_id === adwId)
        stdout.write(`${JSON.stringify(rows)}\n`)
        stderr.write(`ledger: ${rows.length} phase(s) for ${adwId}\n`)
        return 0
      }
      if (verb === 'tail') {
        const afterRowid = flags.after != null ? Number(flags.after) : 0
        const limit = flags.limit != null ? Number(flags.limit) : 50
        // Refuse non-numeric --after/--limit rather than letting a NaN
        // silently reach the bound query (node:sqlite would either throw
        // or, worse, bind-coerce it into a query that quietly returns []).
        if (!Number.isInteger(afterRowid) || !Number.isInteger(limit) || limit < 0) {
          refuse('tail: --after and --limit must be non-negative integers')
        }
        const rows = ledger.listEvents({ adw_id: adwId, afterRowid, limit })
        stdout.write(`${JSON.stringify(rows)}\n`)
        stderr.write(`ledger: ${rows.length} event(s) for ${adwId}\n`)
        return 0
      }
      const rows = ledger.dumpTable('processes').filter((r) => r.adw_id === adwId)
      stdout.write(`${JSON.stringify(rows)}\n`)
      stderr.write(`ledger: ${rows.length} process(es) for ${adwId}\n`)
      return 0
    }

    if (verb === 'doctor') {
      const s = ledger.stats()
      const rowCounts = {}
      for (const table of Object.keys(TABLES)) {
        rowCounts[table] = ledger.dumpTable(table).length
      }
      const pragmas = ledger._pragmas()
      const fts5 = ledger._probeFts5()
      const payload = {
        schema: 1,
        node_version: process.versions.node,
        node_floor: NODE_FLOOR,
        degraded: s.degraded,
        degraded_reason: s.degraded_reason,
        db_path: dbPath,
        row_counts: rowCounts,
        pragmas,
        fts5,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      stderr.write('ledger: doctor readout printed above\n')
      return 0
    }

    if (verb === 'kill') {
      return killVerb(ledger, { adwId: flags['adw-id'], pid: flags.pid, yes: flags.yes === true }, stdout, stderr)
    }

    refuse(`unknown verb: ${verb}`)
    return 2
  } catch (err) {
    if (err instanceof LedgerUsageError) {
      stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    stderr.write(`${err.stack}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // process.exitCode, not process.exit: a piped stdout (sessions/doctor
  // emit JSON that can exceed 65536 bytes) is truncated by process.exit's
  // synchronous teardown.
  process.exitCode = main(process.argv.slice(2))
}
