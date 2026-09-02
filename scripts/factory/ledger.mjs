#!/usr/bin/env node
// scripts/factory/ledger.mjs — the factory subsystem's run mirror: a
// dual-write recorder pairing an append-only JSONL raw record with a
// queryable SQLite (WAL) projection of the same events.
//
// MIRROR-NEVER-AUTHORITY (the one invariant everything else follows from):
// the JSONL file is the run's true, permanent record. The SQLite database is
// a REBUILDABLE PROJECTION of that record — it may be deleted at any time
// and rebuilt in full via replayJsonl(). A caller must never be able to
// observe a mirror failure: public writers append their JSONL line (this
// append may throw — losing the raw record is fatal to the caller), then
// attempt the database mirror inside a try/catch that never rethrows (a
// mirror failure only increments stats().mirror_errors). The three writers
// that allocate a sequence settle their mirror row first, then append the
// line, so a unique-key refusal can be re-numbered before authority write.
//
// SCOPED FLOOR: this module owns the repository's Node floor (`NODE_FLOOR`,
// currently `'26.0.0'`). `node:sqlite`, which this module depends on, is
// satisfied from v24 — the floor is higher because `node --permission` only
// DENIES a network bind from v26 on (measured: v24.15.0 binds, v26.5.1 raises
// `ERR_ACCESS_DENIED`), and the planner lab refuses to serve a program on a
// runtime that cannot enforce that boundary. `node:sqlite` is NEVER
// statically imported — it does not exist on Node 20 and this module must
// still import cleanly there. It is loaded lazily, via createRequire, only
// inside the first real database access, only after the floor check has
// already passed. Below the floor (or if the lazy require throws for any
// other reason, e.g. a build without sqlite support) a writable handle
// DEGRADES: every writer still appends its JSONL line, every writer/reader
// still exists and is callable, the database mirror silently no-ops,
// readers return empty results, `degraded` is true, and exactly one
// diagnostic line is written to stderr for the handle's whole lifetime. A read-only handle instead refuses every writer when its read door is absent.
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
// `eligible-tasks` | `run-set --since <iso> [--until <iso>]` |
// `cell-failures [--since <iso>] [--until <iso>]` |
// `cells [--since <iso>] [--until <iso>] [--prices <path>]` |
// `modifier-attempts [--since <iso>] [--until <iso>]` |
// `seat-teardowns [--since <iso>] [--until <iso>]` |
// `escalations --since <iso> [--until <iso>]` |
// `ci-cycles [--since <iso>] [--until <iso>]` |
// `intake-sweeps [--since <iso>] [--until <iso>]` |
// `task <adw_id|task_slug>` — the read-only verbs the npm `ledger:*` recipes invoke
// (spellings are a contract with package.json; see do-40-02) — plus
// `advisor-ab --run-dir <dir> --run-started-at <iso|ms> --adjudications <path> <dispatch-id>…`,
// `doctor` (capability + state readout) and `kill` (operator-invoked process
// termination, its own refusal-gated helper).
//
// SQL identifiers: all values are bound with `?` placeholders, never
// string-interpolated. The only identifiers ever interpolated into SQL text
// are table/column names read from the frozen `TABLES` constant below —
// SQLite has no way to parameterize an identifier (e.g. `PRAGMA
// table_info(<t>)`), so this is unavoidable; each interpolation site says so
// inline.

import {
  appendFileSync, mkdirSync, chmodSync, existsSync, readFileSync, realpathSync, statSync,
} from 'node:fs'
import { dirname, join, resolve, parse, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { modelString as claudeModelString } from '../../crew/adapters/adapter-claude.mjs'
import { modelString as piModelString } from '../../crew/adapters/adapter-pi.mjs'
// NONCE_PREFIX was imported from the legacy runtime's contract
// (scripts/cmux/contract.mjs, retired with that runtime). The ledger's
// sweep guard still honors nonce-prefixed sidecars, so the constant's
// authority now lives here.
const NONCE_PREFIX = 'devteam-done-'

const require = createRequire(import.meta.url)

// fs.mkdirSync with recursive directory creation is NOT bounded: on a filesystem
// that answers ENOENT to mkdir for a path whose parent exists (Linux procfs
// does exactly this), Node walks up to create the parent, sees EEXIST, walks
// back down, gets ENOENT again — forever, spinning a CPU, on the main thread,
// where no timer or --test-timeout can interrupt it. This walks DOWN once,
// one non-recursive mkdir per segment, so it is bounded by the path's own
// depth and always returns or throws.
export function mkdirpBounded(dir, mode = 0o700) {
  const resolved = resolve(dir)
  const { root } = parse(resolved)
  const segments = resolved.slice(root.length).split(sep).filter(Boolean)
  let prefix = root
  for (const [index, segment] of segments.entries()) {
    prefix = join(prefix, segment)
    try {
      mkdirSync(prefix, { mode })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (index === segments.length - 1) {
        let isDirectory = false
        try { isDirectory = statSync(prefix).isDirectory() } catch { /* rethrow EEXIST below */ }
        if (!isDirectory) throw err
      }
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Frozen constants (all exported — the interface contract)
// ---------------------------------------------------------------------------

export const LEDGER_VERSION = 1
export const NODE_FLOOR = '26.0.0'
export const TERM_TO_KILL_MS = 5000

// A refused (changes === 0) mirror insert means another process owns that seq;
// the record is re-numbered and re-offered. TOTAL attempts per record, not
// retries-after-the-first: 1 disables re-numbering entirely.
const SEQ_COLLISION_RETRY_BUDGET = 8

export const EVENT_TYPES = Object.freeze([
  'phase_start', 'phase_end', 'agent_start', 'agent_end', 'tool_call',
  'handoff', 'gate_pass', 'gate_fail', 'decision', 'log', 'error',
])

export const SESSION_STATUSES = Object.freeze(['running', 'ok', 'fail', 'aborted'])
export const SESSION_OUTCOMES = Object.freeze(['success', 'escalated', 'aborted', 'failed'])
// TRD §3.5 (docs/trd-task-configuration-and-run-state.md:222): where a seat's
// EFFECTIVE value came from. Closed because provenance is a fact the crew
// decides, not an open vocabulary a caller may extend: a fifth value would
// record a seat as chosen by a mechanism nothing in the crew implements.
// `policy_state` beside it is deliberately NOT an enum — the boot policy's
// vocabulary is owned by crew/roster.json, and restating it here would create a
// second source of truth (the same reason run_configurations declares none).
export const SEAT_VALUE_SOURCES = Object.freeze(['roster', 'profile_recommendation', 'operator_override', 'reseat'])
export const TERMINAL_ACTORS = Object.freeze(['driver', 'lead', 'operator', 'finalizer'])
export const ESCALATION_CAUSES = Object.freeze([
  'transport', 'budget', 'plan-build-disagreement', 'brief-contradiction',
  'gate-defect', 'review-unresolved', 'infrastructure', 'seat-lost',
  'seat-timeout', 'seat-aborted', 'plan-rounds-exhausted',
  'envelope-unusable', 'envelope-absent', 'build-rounds-exhausted',
])
export const ESCALATION_CAUSE_UNCLASSIFIED = 'unclassified'

// The driver's own wait ceiling (crew/drive.mjs:2541), wrapped by
// crew/drive.mjs:617 fail() into `${stage}: ${msg}` and recorded by the crash
// envelope as `where: <role>`. STRUCTURAL, not prose: the `${where}: ` prefix
// and the generated `within Ns` tail are the driver's own sentence shape, and
// they are what tells a ceiling kill apart from every other row carrying the
// same three words — a budget-refused seat's message among them, which must
// stay `budget` (test/factory-ledger.test.mjs:591).
function isWaitCeiling(where, why) {
  return where !== '' && why.startsWith(`${where}: no valid envelope at `) && /\bwithin \d+s\b/.test(why)
}

export function escalationCause(input = {}) {
  const where = typeof input?.where === 'string' ? input.where : ''
  const why = typeof input?.why === 'string' ? input.why : ''
  // Rule 1: the explicit sendLine marker is transport evidence and precedes all
  // other prose so a transport failure stays driver-owned. The `where ===
  // 'transport'` arm this rule used to carry had NO producer anywhere in the
  // repo and is deleted (#854 (2)); the two locations below are its real
  // producers.
  if (/\bsendLine\b/.test(why)) {
    return Object.freeze({ cause: 'transport', actor: 'driver' })
  }
  // Rule 1b: the pane manager stopped answering (crew/seat-io.mjs:1883, stage
  // 'substrate-gone') or the provider refused the seat (crew/seat-io.mjs:2306,
  // SEAT_REFUSAL_STAGE, which crew/drive.mjs:2115 lets escape to the crash
  // recorder). Both are the host, not the seat — cellFailureKind already calls
  // them transport-error (crew/seat-io.mjs:1234, :1239). The prose arm catches
  // the substrate shape re-wrapped under a variant (crew/drive.mjs:2866).
  if (new Set(['substrate-gone', 'seat-refused']).has(where) || /\bsubstrate gone: /.test(why)) {
    return Object.freeze({ cause: 'transport', actor: 'driver' })
  }
  // Rule 2: scope/anchor/unapplied evidence is a plan-build disagreement. It
  // deliberately precedes the budget rule because b325's anchor prose mentions
  // budget. 'plan-scope-widened' (crew/drive.mjs:3101, #852) is the same fact
  // reached one round earlier: the plan and the dispatched surface disagree.
  if (where === 'scope' || where === 'plan-scope-widened' || /\banchor-(absent|ambiguous|unsafe)\b/.test(why) || /\bunapplied\b/.test(why)) {
    return Object.freeze({ cause: 'plan-build-disagreement', actor: 'driver' })
  }
  // Rule 3: a seat-death location is a NAMED, measured loss — the worker died
  // and no envelope arrived. Deliberately not 'budget': the journal records
  // nothing that separates a wait-ceiling kill from an OOM or an external
  // signal, and inferring one from prose would be a guess. Matched on `where`
  // alone so both seat-death message shapes classify identically — pane
  // (crew/seat-io.mjs:1875) and headless (crew/seat-io.mjs:2213) share only the
  // words 'no envelope arrived', which rule 9's 'no valid envelope' never sees.
  // FOLLOW-UP: the emitting side — a distinct seat-wait-expired signal from the
  // driver, which would let a ceiling kill be told apart from a death — lands
  // once b359-slotdriver frees the crew surface.
  // The prose arm is the SAME death re-wrapped under a scout/repair/directed
  // variant by crew/drive.mjs:2866, where `where` is the variant and no
  // location survives.
  if (where === 'seat-died' || /\bseat died: /.test(why)) {
    return Object.freeze({ cause: 'seat-lost', actor: 'driver' })
  }
  // Rule 4: the driver's own wait ceiling fired — it killed the seat; nothing
  // died under it. `where` is the raised error's stage: `headless-${outcome}`
  // (crew/headless.mjs:553) or the literal 'rpc-timeout' (crew/headless-rpc.mjs:785).
  // The message-shape arm catches the SAME failure re-wrapped under a seat
  // variant (crew/drive.mjs:2866), where `where` becomes the VARIANT and the
  // role survives only in the prose.
  if (where === 'rpc-timeout' || where === 'headless-timeout' || /\b(rpc|headless) timeout:/.test(why)) {
    return Object.freeze({ cause: 'seat-timeout', actor: 'driver' })
  }
  // Rule 5: the worker exited MID-STREAM — an exit file, no envelope and no
  // terminal frame (crew/headless-rpc.mjs:762, and crew/headless.mjs:553 over
  // classifyRun's 'aborted'). Deliberately distinct from seat-lost (a corpse
  // the driver found by probe) and from seat-timeout (a ceiling kill): the three
  // imply different operator actions — retry a transient, investigate a kill,
  // raise a budget (#840 amendment).
  if (where === 'rpc-aborted' || where === 'headless-aborted' || /\b(rpc|headless) aborted:/.test(why)) {
    return Object.freeze({ cause: 'seat-aborted', actor: 'driver' })
  }
  // Rule 5b: the seat settled and wrote NO envelope (crew/headless.mjs:553 over
  // classifyRun's 'no-envelope', crew/headless-rpc.mjs:762, and the lost-seat
  // re-ask at crew/seat-io.mjs:2786/:2796). ONE failure, ONE cause on BOTH
  // transports: the two differ only in the word 'valid', which is why this
  // matches the STAGE and never the prose (#854 (2)).
  if (/^(headless|rpc)-no-envelope$/.test(where)) {
    return Object.freeze({ cause: 'envelope-absent', actor: 'driver' })
  }
  // Rule 5c: the seat produced output the driver cannot read as an envelope —
  // no JSON at all (classifyRun 'malformed') or a parse failure
  // (crew/headless-rpc.mjs:717). Deliberately distinct from envelope-absent:
  // cellFailureKind separates them the same way (crew/seat-io.mjs:1244-1245).
  if (/^(headless|rpc)-(malformed|parse-error)$/.test(where)) {
    return Object.freeze({ cause: 'envelope-unusable', actor: 'driver' })
  }
  // Rule 6: the driver's own wait ceiling on the PANE/driver path
  // (crew/drive.mjs:2541). It must precede the budget rule for the same reason
  // rule 4 does — the ceiling sentence carries 'no valid envelope', and rule 4's
  // own comment already says a ceiling kill is not budget (#854 (1)).
  if (isWaitCeiling(where, why)) {
    return Object.freeze({ cause: 'seat-timeout', actor: 'driver' })
  }
  // Rule 7: the plan loop hit its round cap (crew/drive.mjs:3243) — the lead's
  // loop did not converge. This is the ONE rule anchored on the why rather than
  // the where, because `where` is 'plan' for several unrelated escalations
  // (b329's brief contradiction among them). The sentence is the driver's own
  // generated structure, not free prose, and the ^$ anchors keep it from
  // claiming a row that merely mentions it.
  if (/^no accepted plan within \d+ rounds$/.test(why.trim())) {
    return Object.freeze({ cause: 'plan-rounds-exhausted', actor: 'lead' })
  }
  // Rule 8: the build loop hit its round cap (crew/drive.mjs:4390) — the exact
  // twin of rule 7's plan sentence, and anchored the same way so a row that
  // merely mentions it is never claimed.
  if (where === 'build' && /^no accepted build within \d+ rounds$/.test(why.trim())) {
    return Object.freeze({ cause: 'build-rounds-exhausted', actor: 'lead' })
  }
  // Rule 9: an exceeded budget is a driver budget outcome. It runs AFTER every
  // structural rule above: its 'no valid envelope' arm is prose that four
  // different producers emit, and only the location tells them apart (#854 (3)).
  if (/\bno valid envelope\b/.test(why) || /\bexceeded its \d+s budget\b/.test(why)) {
    return Object.freeze({ cause: 'budget', actor: 'driver' })
  }
  // Rule 10: contradiction in the escalation prose is an operator-owned brief issue.
  if (/\bcontradict/i.test(why)) {
    return Object.freeze({ cause: 'brief-contradiction', actor: 'operator' })
  }
  // Rule 11: a gate location identifies a lead-owned gate defect.
  if (where === 'gate') {
    return Object.freeze({ cause: 'gate-defect', actor: 'lead' })
  }
  // Rule 12: review locations identify an unresolved review. 'review-unresolved'
  // is the driver's own location for a finding the lead could not settle
  // (crew/drive.mjs:4264) and reaches the cause of the same name.
  if (new Set(['review', 'refuted-must-fix', 'review-unresolved']).has(where)) {
    return Object.freeze({ cause: 'review-unresolved', actor: 'lead' })
  }
  // Rule 13: these locations are infrastructure failures owned by the driver.
  if (new Set(['driver', 'cold-suite', 'suite', 'rebase', 'publish', 'converge-pr']).has(where)) {
    return Object.freeze({ cause: 'infrastructure', actor: 'driver' })
  }
  // No rule matched: unclassified is an honest non-answer, with no actor guess.
  return Object.freeze({ cause: ESCALATION_CAUSE_UNCLASSIFIED, actor: null })
}
export const REQUEST_SOURCES = Object.freeze(['dispatch', 'brief-file'])
export const REQUEST_MAX_CHARS = 2000
export const RETIRED_TABLES = Object.freeze({
  envelopes: 'Retired: never wired since the legacy runtime was retired (81dee7c, 0.2.0); its one writer was scripts/cmux/dispatch.mjs closeCmd. crew/seat-io.mjs mirrors envelope facts into events / review_outcomes instead, and the visualizer reads envelopes from returns/ archive files. The table and recordEnvelope stay declared because the schema fence is additive-only and replayJsonl depends on the closed WRITERS set. A zero row count is retired, never nothing happened.',
  processes: 'Retired: never held a row in any production ledger — startProcess has no caller outside scripts/factory/ledger.mjs itself and its own tests (#405), so `ledger procs <adw_id>` returns [] for every run. The table, startProcess and endProcess stay declared because the schema fence is additive-only and replayJsonl depends on the closed WRITERS set. A zero row count is retired, never nothing happened.',
})

// Unique indexes a prior schema declared and this one has WIDENED. migrationsFor
// derives an index name from its columns, so a widened key mints a NEW index and
// leaves the old, narrower one in place on every db already on disk — where it
// goes on collapsing the very rows the widening exists to keep (#716/F2). Named
// here and DROPped before the CREATEs run. Widening only: every retired index's
// columns are a prefix of the key that replaced it, so nothing is unenforced
// that was enforced before.
export const RETIRED_INDEXES = Object.freeze([
  'seat_teardowns_adw_id_role_uq',
  'review_outcomes_adw_id_dispatch_id_uq',
])
export const PHASE_STATUSES = Object.freeze(['running', 'ok', 'fail', 'skipped'])
export const PROCESS_STATES = Object.freeze(['running', 'exited', 'killed', 'unknown'])
export const GATE_DISCRIMINATION_VERDICTS = Object.freeze(['proven', 'failed', 'unproven'])
// One run end, one piped seat. Mirrors GATE_DISCRIMINATION_VERDICTS on
// purpose (a test holds them equal): `proven` requires positive evidence the
// worker is gone; `failed` is a MEASURED live worker after teardown; and
// `unproven` is an honest non-answer — LIVENESS.UNKNOWN — never quietly
// counted as clean.
export const SEAT_TEARDOWN_OUTCOMES = Object.freeze(['proven', 'failed', 'unproven'])
export const REVIEW_VERDICTS = Object.freeze(['pass', 'changes-needed'])
// A floor on SAMPLE SIZE, reported beside every rate and never enforced: a
// share over a handful of reviews is not a policy input, and the readout says
// so rather than leaving the reader to notice the denominator.
export const CELL_RATE_FLOOR = 12
export const CELL_PRICE_UNITS = 'USD per 1,000,000 tokens: input and output at cost_in_per_mtok and cost_out_per_mtok, cache reads at cost_cache_read_per_mtok and cache writes at cost_cache_write_per_mtok, all four ratified per model in the same catalog — a model missing either cache rate leaves the whole row unpriced, never partly priced, and a token class even one member session never measured does the same; billed_cache_write_tokens collapses the 1h and 5m write TTLs into one column, so pricing every write at the ratified 1h rate is an explicit lossy convention (#527)'
export const ADVISOR_AB_VERDICTS = Object.freeze(['overlap', 'no-overlap', 'skipped'])
export const ADVISOR_AB_INCOMPLETE_REASONS = Object.freeze([
  'envelope-missing', 'envelope-unreadable', 'envelope-role-mismatch',
  'dispatch-id-mismatch', 'dispatch-not-attested', 'findings-absent',
  'finding-malformed', 'duplicate-key', 'unadjudicated-finding',
  'skipped-finding', 'note-not-in-journal', 'note-not-injected',
  'adjudication-malformed', 'adjudication-unknown-dispatch',
  'adjudication-unknown-finding', 'duplicate-adjudication',
  'numerator-exceeds-denominator',
])
// A floor on SAMPLE SIZE, not on any one readout: an arm is usually measured
// over several runs, so this is reported and compared by the human (see
// docs/advisor-ab-protocol.md), never silently enforced here.
export const ADVISOR_AB_DISPATCH_FLOOR = 12
export const ACCEPT_DECISION_OUTCOMES = Object.freeze(['accepted', 'escalated'])

// The adjudication of one watched CI check. 'green' is a MEASURED fact, not
// a gap — recording it is what gives "how often does CI catch what the local
// lane missed" a denominator. 'unknown' is an honest non-answer carrying its
// own reason; it is never a green and never a repair.
export const CI_CLASSIFICATIONS = Object.freeze(['green', 'reproduced', 'platform-divergent', 'unknown'])
export const CI_DECISIONS = Object.freeze(['none', 'repair', 'park'])
export const CI_DISPATCH_OUTCOMES = Object.freeze(['done', 'escalation', 'converge', 'refused', 'unreadable'])

// The sweep outcomes are measured answers: picked, no eligible issue, or a
// named park that leaves selection for a later sweep.
export const INTAKE_OUTCOMES = Object.freeze(['picked', 'none', 'parked'])
export const INTAKE_REFUSALS = Object.freeze([
  'stop-switch', 'window-cap', 'rate-limit-floor',
  'priority-unknown', 'intake-block-missing', 'intake-block-malformed',
  'brief-uncompilable', 'protected-path', 'tier-judge', 'not-first-in-order',
  'repeat-escalation',
])
export const INTAKE_BRAKE_TRANSITIONS = Object.freeze(['engaged', 'cleared'])
export const INTAKE_BRAKE_OUTCOMES = Object.freeze(['ok', 'failed'])

// One row per recorded STEP of one dispatch, appended never updated:
// 'claimed' is written after the verified board move and before any boot, so a
// crash between them is visible as a claim with no settled row. 'promoted' is
// the In-review transition, which normally lands on a later sweep.
export const INTAKE_DISPATCH_OUTCOMES = Object.freeze([
  'claimed', 'done', 'escalation', 'converge', 'refused', 'unreadable', 'promoted',
])
// The subset of dispatch outcomes where a crew actually ran and adjudicated.
// claimed/promoted are steps, not verdicts, and refused never reached a crew.
export const INTAKE_DISPATCH_VERDICTS = Object.freeze(['done', 'escalation', 'converge', 'unreadable'])

// A premise result is a MEASUREMENT of the references an issue body names, not
// a decision: 'clean' = at least one reference and all of them resolve;
// 'unresolved' = at least one does not; 'unknown' = the probe could not answer
// (grep failed, unreadable file) and nothing was falsified; 'no-references' =
// the body names nothing checkable. NULL on a row means the check never ran.
export const PREMISE_VERDICTS = Object.freeze([
  'clean', 'unresolved', 'unknown', 'no-references',
])

// The closed set of CELL availability failures — a cell that could not hold a
// seat, died mid-assignment, or returned nothing usable. Deliberately NOT a
// quality axis: review_outcomes (#169) and accept_decisions (#170) already
// record whether a cell's WORK was good; this records whether the cell was
// THERE. #178 settled the quality axis; the two never blend.
export const CELL_FAILURE_KINDS = Object.freeze([
  'boot-refusal',       // assertCapabilities refused the cell (no run exists)
  'seat-not-ready',     // a pane seat never came up (no run exists)
  'seat-died',          // liveness probes declared the pane gone mid-assignment
  'timeout',            // the dispatch wait expired with nothing to read
  'no-envelope',        // the worker settled/exited without writing one
  'unusable-envelope',  // a file arrived and failed the shape/anti-replay check
  'aborted',            // the worker's turn was aborted
  'transport-error',    // spawn/session/reservation/adapter failure
])

// WHOSE failure a cell_failures row is evidence of. Recorded ON THE ROW so no
// reader re-derives it: 'cell' = the cell misbehaved, 'host' = this host could
// not deliver the answer in time (a wait-budget expiry under contention, #472).
// NULL is a THIRD state and never a synonym for either — it means nothing
// measured the difference: every row written before #472, and every writer that
// does not classify. Deliberately a separate axis from CELL_FAILURE_KINDS: the
// kind says WHAT happened, the attribution says whose fact it is.
export const CELL_FAILURE_ATTRIBUTIONS = Object.freeze(['cell', 'host'])

// The four modifiers ratified in #45. A modifier that is not in this set
// refuses at the writer rather than being stored under a typo'd name.
export const MODIFIER_KINDS = Object.freeze([
  'failure-upgrade', 'sensitivity-floor', 'vendor-diversity', 'budget-ceiling',
])

// The run shapes the driver can execute (#251). MUST equal crew/drive.mjs
// VARIANT_NAMES — the driver is the source of truth and this file never imports
// it; test/factory-ledger.test.mjs pins the two lists equal, the same convention
// MODIFIER_KINDS uses above.
export const RUN_VARIANTS = Object.freeze(['full', 'scout', 'repair', 'directed'])
// The stage-label head that identifies each shape: `full` opens with `plan:r1`,
// every other shape with its own name (crew/drive.mjs driveEnvelopeShape).
export const RUN_VARIANT_MARKERS = Object.freeze({ plan: 'full', scout: 'scout', repair: 'repair', directed: 'directed' })
// How many run ids one marker query may bind. `run-set` windows are unbounded and
// queryRows swallows a too-many-host-parameters error into [] (:1500-1512), which
// would make every shape read absent.
export const STAGE_MARKER_CHUNK = 200

// Which shape a run used, from the FIRST log row it recorded. `log` is not a
// stage-only type — attention lines ride it too (crew/seat-io.mjs:270-272) — so
// only the first row is classified: scanning on to the first RECOGNISED row would
// let a later colliding message rewrite the answer. Anything else is null:
// an unmeasured shape is NEVER reported as the default one, or every degraded and
// pre-#251 run would be attributed to `full` and corrupt cost-per-shape.
export function variantFromFirstMessage(message) {
  if (typeof message !== 'string') return null
  const [head, marker] = message.split(':')
  if (!marker) return null
  return Object.prototype.hasOwnProperty.call(RUN_VARIANT_MARKERS, head) ? RUN_VARIANT_MARKERS[head] : null
}

// MUST equal crew/drive.mjs MODIFIER_OUTCOMES (drive.mjs:42) — the driver is
// the producer, this is the register; the ledger never imports crew (the
// subsystem direction is one-way, crew -> factory), so a test holds them equal.
export const MODIFIER_ATTEMPT_OUTCOMES = Object.freeze([
  'applied', 'transport', 'exhausted', 'no-tier', 'agent-change', 'spent',
])

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

// The tables that record which transport actually ran a seat. `sessions` has
// no transport column, so a run's transport is only ever inferred from the
// rows its seats left behind — an empty result is "unrecorded", never "none".
const TRANSPORT_TABLES = Object.freeze([
  'review_outcomes', 'cell_failures', 'modifier_attempts', 'seat_teardowns', 'seat_reclaims',
])

// Why a run or window has no measured usage. A pane seat lands no
// agent_sessions row AT ALL, for a reason that holds today
// (docs/ledger-queries.md, "Context occupancy") — telling such a run it
// "predates per-agent token measurement (#119)" is a false cause (#433). Only
// a run with no transport evidence at all is unattributable, and only it may
// still name #119. Exported so both emission sites draw one wording from one
// place.
export const USAGE_ABSENT_CAUSES = Object.freeze({
  pane: 'every seat recorded for it ran on the pane transport, and no pane runner emits a usage frame into the ledger adapter, so no agent_sessions row is written at all (docs/ledger-queries.md, "Context occupancy") — a structural absence today, not a measured zero',
  measured_transport: 'a non-pane transport is recorded for it, yet no agent_sessions row exists — the usage frame was never folded into the register; unmeasured, not a measured zero',
  transport_unrecorded: 'no transport is recorded for it, so why no agent_sessions row exists is itself unmeasured — a run predating per-agent token measurement (#119) reads this way too, and neither is a measured zero',
  unbilled_rows: 'its agent_sessions rows carry no billed token totals — unmeasured, not a measured zero',
  cache_unpriced: 'the catalog entry has input/output rates but does not carry every cache rate required to price all four billed token classes; this row is UNPRICED, never partly priced and never free',
})

// transports: an iterable of the transport strings recorded for the run(s).
export function usageAbsentCause(transports) {
  const seen = [...new Set([...(transports || [])].filter((t) => t != null))]
  if (seen.length === 0) return USAGE_ABSENT_CAUSES.transport_unrecorded
  return seen.every((t) => t === 'pane')
    ? USAGE_ABSENT_CAUSES.pane
    : USAGE_ABSENT_CAUSES.measured_transport
}

// review_outcomes' seat-cell columns (#404), spelled EXACTLY as cell_failures
// spells its own (:1575-1580) so one query can read a cell out of either
// table. Appended AFTER created_at on purpose: applyMigrations ADD COLUMNs a
// new column onto an existing db and ALTER TABLE appends, so an upgraded db's
// PRAGMA order still equals this declared order (AC-1).
const REVIEW_CELL_COLUMNS = Object.freeze([
  { name: 'agent', decl: 'TEXT' },
  { name: 'provider', decl: 'TEXT' },
  { name: 'model_id', decl: 'TEXT' },
  { name: 'model', decl: 'TEXT' },
  { name: 'effort', decl: 'TEXT' },
  { name: 'transport', decl: 'TEXT' },
])

function cellFieldsFrom(input) {
  return Object.fromEntries(REVIEW_CELL_COLUMNS.map(({ name }) => [name, input[name] ?? null]))
}

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
      // Append-only: upgraded databases receive these via ADD COLUMN, so
      // AC-1 requires new columns at the end; NULL means not measured then,
      // never an empty ask. `request` is the run's compiled ask line (the
      // headline), not the whole request object.
      { name: 'request', decl: 'TEXT' },
      { name: 'request_source', decl: 'TEXT' },
      // #297: the run's last MEASURED liveness observation — written only from
      // a probe that came back alive (crew/seat-io.mjs's wait loop), UPDATEd in
      // place per ADR-024 (a last-known-alive column, never a trace row).
      // Declared LAST so an upgraded db receives it via ADD COLUMN (#290).
      { name: 'last_heartbeat_at', decl: 'TEXT' },
      // #291 step 3: the crew SHAPE this run was booted with (mechanical |
      // build | judge), forwarded from the boot record crew/crew.mjs:831 wrote
      // — never re-derived here. NULL means unmeasured: a run booted with
      // explicit --roles carries no tier at all, and a row that predates this
      // column is never backfilled. Declared LAST so an upgraded db receives it
      // via ADD COLUMN (#290).
      { name: 'tier', decl: 'TEXT' },
      // #291 step 3: recording half: the COMPILER's proposals for this run,
      // forwarded from the brief's fenced ```proposal block by
      // scripts/factory/emit.mjs — never re-derived here and never consumed to
      // change seating (#291 step 4). NULL means unmeasured: a brief with no
      // block, and every row that predates these columns, which are never
      // backfilled. Declared LAST so an upgraded db receives them via ADD
      // COLUMN (#290).
      { name: 'proposed_shape', decl: 'TEXT' },
      { name: 'proposed_strength', decl: 'TEXT' },
      // #779: NULL means a typed run outcome was not measured. Declared LAST
      // so an upgraded db receives these fields via ADD COLUMN (#290); no
      // historical row is backfilled by inference.
      { name: 'outcome', decl: 'TEXT' },
      { name: 'terminal_reason', decl: 'TEXT' },
      { name: 'terminal_actor', decl: 'TEXT' },
    ],
    unique: [['adw_id']],
    indexes: [],
  },
  run_configurations: {
    columns: [
      { name: 'adw_id', decl: 'TEXT PRIMARY KEY' },
      { name: 'schema_version', decl: 'INTEGER' },
      { name: 'task_profile', decl: 'TEXT' },
      { name: 'task_profile_source', decl: 'TEXT' },
      { name: 'requested_execution', decl: 'TEXT' },
      { name: 'effective_execution', decl: 'TEXT' },
      { name: 'execution_source', decl: 'TEXT' },
      { name: 'requested_assurance', decl: 'TEXT' },
      { name: 'effective_assurance', decl: 'TEXT' },
      { name: 'assurance_source', decl: 'TEXT' },
      { name: 'legacy_variant', decl: 'TEXT' },
      { name: 'legacy_tier', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id']],
    indexes: [],
  },
  run_seats: {
    columns: [
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'role', decl: 'TEXT' },
      { name: 'agent', decl: 'TEXT' },
      { name: 'provider', decl: 'TEXT' },
      { name: 'model_id', decl: 'TEXT' },
      { name: 'model', decl: 'TEXT' },
      { name: 'effort', decl: 'TEXT' },
      { name: 'transport', decl: 'TEXT' },
      { name: 'source', decl: 'TEXT' },
      { name: 'policy_state', decl: 'TEXT' },
      { name: 'warnings_json', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'role']],
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
      ...REVIEW_CELL_COLUMNS,
    ],
    unique: [['adw_id', 'dispatch_id', 'created_at']],
    indexes: [],
  },
  accept_decisions: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'where_at', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'findings_total', decl: 'INTEGER' },
      { name: 'residual_count', decl: 'INTEGER' },
      { name: 'refuted_count', decl: 'INTEGER' },
      { name: 'cosmetic_count', decl: 'INTEGER' },
      { name: 'unverified_count', decl: 'INTEGER' },
      { name: 'invalid_reasons', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'where_at', 'created_at']],
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
  cell_failures: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },        // NULL when the failure predates the run
      { name: 'task_slug', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'dispatch_id', decl: 'TEXT' },
      { name: 'role', decl: 'TEXT' },
      { name: 'agent', decl: 'TEXT' },
      { name: 'provider', decl: 'TEXT' },
      { name: 'model_id', decl: 'TEXT' },      // the roster cell's id
      { name: 'model', decl: 'TEXT' },         // the translated CLI model string
      { name: 'effort', decl: 'TEXT' },
      { name: 'transport', decl: 'TEXT' },
      { name: 'kind', decl: 'TEXT' },
      { name: 'stage', decl: 'TEXT' },         // the transport's own err.stage, verbatim
      { name: 'detail', decl: 'TEXT' },
      { name: 'attribution', decl: 'TEXT' },   // NULL = unclassified (#472)
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'dispatch_id', 'kind', 'created_at']],
    indexes: [{ name: 'cell_failures_cell_idx', cols: ['provider', 'model_id', 'created_at'] }],
  },
  modifier_attempts: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'task_slug', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'role', decl: 'TEXT' },
      { name: 'modifier', decl: 'TEXT' },
      { name: 'bounce', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'why', decl: 'TEXT' },
      { name: 'rung', decl: 'TEXT' },
      { name: 'transport', decl: 'TEXT' },
      { name: 'from_provider', decl: 'TEXT' },
      { name: 'from_model_id', decl: 'TEXT' },
      { name: 'from_model', decl: 'TEXT' },
      { name: 'from_agent', decl: 'TEXT' },
      { name: 'from_effort', decl: 'TEXT' },
      { name: 'to_provider', decl: 'TEXT' },
      { name: 'to_model_id', decl: 'TEXT' },
      { name: 'to_model', decl: 'TEXT' },
      { name: 'to_agent', decl: 'TEXT' },
      { name: 'to_effort', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'role', 'modifier', 'bounce', 'created_at']],
    indexes: [{ name: 'modifier_attempts_outcome_idx', cols: ['modifier', 'outcome', 'created_at'] }],
  },
  run_links: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'run_id', decl: 'TEXT' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'crew_dir', decl: 'TEXT' },
      { name: 'linked_at', decl: 'TEXT' },
    ],
    unique: [['run_id', 'adw_id']],
    indexes: [{ name: 'run_links_run_id_idx', cols: ['run_id'] }],
  },
  ci_cycles: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },        // NULL is a FACT: a host watch
      { name: 'task_slug', decl: 'TEXT' },     // may precede any crew run
      { name: 'repo_slug', decl: 'TEXT' },
      { name: 'branch', decl: 'TEXT' },
      { name: 'head_sha', decl: 'TEXT' },
      { name: 'check_name', decl: 'TEXT' },
      { name: 'cycle', decl: 'INTEGER' },
      { name: 'conclusion', decl: 'TEXT' },     // the platform's own word, verbatim
      { name: 'classification', decl: 'TEXT' }, // this module's adjudication
      { name: 'decision', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'excerpt', decl: 'TEXT' },        // VERBATIM — never sliced here
      { name: 'excerpt_source', decl: 'TEXT' },
      { name: 'local_lane', decl: 'TEXT' },
      { name: 'local_exit', decl: 'INTEGER' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['branch', 'head_sha', 'check_name', 'cycle']],
    indexes: [{ name: 'ci_cycles_classification_idx', cols: ['check_name', 'classification', 'created_at'] }],
  },
  ci_dispatches: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'task_slug', decl: 'TEXT' },
      { name: 'repo_slug', decl: 'TEXT' },
      { name: 'branch', decl: 'TEXT' },
      { name: 'head_sha', decl: 'TEXT' },
      { name: 'check_name', decl: 'TEXT' },
      { name: 'cycle', decl: 'INTEGER' },
      { name: 'variant', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'commit', decl: 'TEXT' },
      { name: 'brief_path', decl: 'TEXT' },
      { name: 'scope_source', decl: 'TEXT' },
      { name: 'scope_count', decl: 'INTEGER' },
      { name: 'task_return', decl: 'TEXT' },
      { name: 'park_path', decl: 'TEXT' },
      { name: 'exit_code', decl: 'INTEGER' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['branch', 'head_sha', 'check_name', 'cycle']],
    indexes: [{ name: 'ci_dispatches_outcome_idx', cols: ['variant', 'outcome', 'created_at'] }],
  },
  intake_sweeps: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'board_owner', decl: 'TEXT' },
      { name: 'board_project', decl: 'INTEGER' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'considered', decl: 'INTEGER' },
      { name: 'pages', decl: 'INTEGER' },
      { name: 'picked_issue', decl: 'INTEGER' },
      { name: 'rate_limit_remaining', decl: 'INTEGER' },
      { name: 'rate_limit_reset_at', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['board_owner', 'board_project', 'created_at']],
    indexes: [{ name: 'intake_sweeps_outcome_idx', cols: ['outcome', 'created_at'] }],
  },
  intake_refusals: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'board_owner', decl: 'TEXT' },
      { name: 'board_project', decl: 'INTEGER' },
      { name: 'issue', decl: 'INTEGER' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'detail', decl: 'TEXT' },
      { name: 'priority', decl: 'TEXT' },
      { name: 'issue_created_at', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['board_owner', 'board_project', 'issue', 'created_at']],
    indexes: [{ name: 'intake_refusals_reason_idx', cols: ['reason', 'created_at'] }],
  },
  intake_brakes: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'checkout', decl: 'TEXT' },
      { name: 'path', decl: 'TEXT' },
      { name: 'transition', decl: 'TEXT' },
      // This is a claim supplied by an unauthenticated console client, not a verified identity.
      { name: 'actor', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'detail', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['checkout', 'path', 'transition', 'created_at']],
    indexes: [{ name: 'intake_brakes_transition_idx', cols: ['transition', 'created_at'] }],
  },
  intake_dispatches: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'board_owner', decl: 'TEXT' },
      { name: 'board_project', decl: 'INTEGER' },
      { name: 'issue', decl: 'INTEGER' },
      { name: 'sweep_at', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'tier', decl: 'TEXT' },
      { name: 'task_slug', decl: 'TEXT' },
      { name: 'board_item_id', decl: 'TEXT' },
      { name: 'branch', decl: 'TEXT' },
      { name: 'brief_path', decl: 'TEXT' },
      { name: 'crew_dir', decl: 'TEXT' },
      { name: 'task_return', decl: 'TEXT' },
      { name: 'exit_code', decl: 'INTEGER' },
      { name: 'board_from', decl: 'TEXT' },
      { name: 'board_to', decl: 'TEXT' },
      { name: 'pr_number', decl: 'INTEGER' },
      { name: 'pr_url', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
      { name: 'issue_body_digest', decl: 'TEXT' },
      { name: 'premise_verdict', decl: 'TEXT' },
      { name: 'premise_notes', decl: 'TEXT' },
    ],
    unique: [['board_owner', 'board_project', 'issue', 'outcome', 'created_at']],
    indexes: [{ name: 'intake_dispatches_outcome_idx', cols: ['outcome', 'created_at'] }],
  },
  seat_teardowns: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'role', decl: 'TEXT' },
      { name: 'transport', decl: 'TEXT' },
      { name: 'session_id', decl: 'TEXT' },
      { name: 'pgid', decl: 'INTEGER' },
      { name: 'reservation_id', decl: 'TEXT' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'forced', decl: 'INTEGER' },
      { name: 'evidence_kind', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'role', 'created_at']],
    indexes: [{ name: 'seat_teardowns_outcome_idx', cols: ['outcome', 'created_at'] }],
  },
  seat_reclaims: {
    columns: [
      { name: 'id', decl: 'INTEGER PRIMARY KEY' },
      { name: 'adw_id', decl: 'TEXT NOT NULL' },
      { name: 'phase_id', decl: 'INTEGER' },
      { name: 'transport', decl: 'TEXT NOT NULL' },
      { name: 'seat_id', decl: 'TEXT NOT NULL' },
      { name: 'reservation_id', decl: 'TEXT NOT NULL' },
      { name: 'sweep_id', decl: 'TEXT NOT NULL' },
      { name: 'role', decl: 'TEXT' },
      { name: 'owner_pid', decl: 'INTEGER' },
      { name: 'owner_liveness', decl: 'TEXT' },
      { name: 'root_pid', decl: 'INTEGER' },
      { name: 'root_pgid', decl: 'INTEGER' },
      { name: 'root_start', decl: 'TEXT' },
      { name: 'root_liveness', decl: 'TEXT' },
      { name: 'root_settled', decl: 'TEXT' },
      { name: 'captures', decl: 'INTEGER' },
      { name: 'missed_snapshots', decl: 'INTEGER' },
      { name: 'discovery_failures', decl: 'INTEGER' },
      { name: 'captured', decl: 'INTEGER' },
      { name: 'signalled', decl: 'INTEGER' },
      { name: 'reclaimed', decl: 'INTEGER' },
      { name: 'live', decl: 'INTEGER' },
      { name: 'identity_refused', decl: 'INTEGER' },
      { name: 'probe_unknown', decl: 'INTEGER' },
      { name: 'outcome', decl: 'TEXT' },
      { name: 'reason', decl: 'TEXT' },
      { name: 'coverage_outcome', decl: 'TEXT' },
      { name: 'coverage_reason', decl: 'TEXT' },
      { name: 'created_at', decl: 'TEXT' },
    ],
    unique: [['adw_id', 'transport', 'seat_id', 'reservation_id', 'sweep_id']],
    indexes: [{ name: 'seat_reclaims_outcome_idx', cols: ['outcome', 'created_at'] }],
  },
})

// The closed set of public writer method names — also the closed set of
// JSONL line `kind` values. replayJsonl refuses any `kind` outside this set.
export const WRITERS = Object.freeze([
  'startSession', 'endSession', 'startPhase', 'endPhase', 'recordEvent',
  'recordEnvelope', 'recordSessionRequest', 'recordRunConfiguration', 'recordRunSeat', 'recordGateResult', 'recordGateDiscrimination',
  'recordReviewOutcome', 'recordAcceptDecision', 'recordCellFailure', 'recordModifierAttempt', 'recordCiCycle', 'recordCiDispatch', 'recordIntakeSweep', 'recordIntakeRefusal', 'recordIntakeBrake', 'recordIntakeDispatch', 'recordSeatTeardown', 'recordSeatReclaim', 'startProcess', 'endProcess', 'heartbeat',
  'startAgentSession', 'endAgentSession', 'recordSourceError', 'linkRun',
])

// Writer → the table its mirror INSERTs a row into. A writer whose mirror only
// UPDATEs an existing row adds no row and is listed in UPDATE_ONLY_WRITERS
// instead. Together the two sets classify every name in WRITERS exactly once
// (pinned in test/factory-ledger.test.mjs); the unique key of each table is
// never restated here — it is read from TABLES.
export const WRITER_MIRROR_TABLES = Object.freeze({
  startSession: 'sessions',
  recordRunConfiguration: 'run_configurations',
  recordRunSeat: 'run_seats',
  startPhase: 'phases',
  recordEvent: 'events',
  recordSourceError: 'events',
  recordEnvelope: 'envelopes',
  recordGateResult: 'gate_results',
  recordGateDiscrimination: 'gate_discriminations',
  recordReviewOutcome: 'review_outcomes',
  recordAcceptDecision: 'accept_decisions',
  linkRun: 'run_links',
  recordCellFailure: 'cell_failures',
  recordModifierAttempt: 'modifier_attempts',
  recordCiCycle: 'ci_cycles',
  recordCiDispatch: 'ci_dispatches',
  recordIntakeSweep: 'intake_sweeps',
  recordIntakeRefusal: 'intake_refusals',
  recordIntakeBrake: 'intake_brakes',
  recordIntakeDispatch: 'intake_dispatches',
  recordSeatTeardown: 'seat_teardowns',
  recordSeatReclaim: 'seat_reclaims',
  startProcess: 'processes',
  startAgentSession: 'agent_sessions',
})

// Writers whose mirror is an UPDATE of a row another writer created: they add
// no row, so a JSONL line of one of these kinds is never a missing row.
export const UPDATE_ONLY_WRITERS = Object.freeze([
  'recordSessionRequest', 'endSession', 'endPhase', 'endProcess', 'heartbeat', 'endAgentSession',
])

// The doctor readout never repairs: replayJsonl is the deliberate remedy.
export const DRIFT_REMEDY = 'drift is not repaired here — replay the JSONL authority into the mirror with replayJsonl(jsonlPath, ledger)'

// A collapse is NOT drift and replay does not repair it: two JSONL lines share
// one unique key, so the mirror can only ever hold one of them.
export const DRIFT_COLLAPSE_REMEDY = 'a collapsed key is not repaired by replay — two or more JSONL lines carry the same unique key with different content, so the mirror can hold only one of them; the JSONL authority is the only complete record'

// ---------------------------------------------------------------------------
// DDL generation — built from TABLES, never hand-written alongside it.
// ---------------------------------------------------------------------------

function tableColumnNames(table) {
  return TABLES[table].columns.map((c) => c.name)
}

function quoteSqlIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`
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
  for (const name of RETIRED_INDEXES) {
    stmts.push(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(name)}`)
  }
  for (const [table, def] of Object.entries(TABLES)) {
    const colSql = def.columns.map((c) => `${quoteSqlIdentifier(c.name)} ${c.decl}`).join(', ')
    stmts.push(`CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(table)} (${colSql})`)
    for (const cols of def.unique) {
      const idxName = `${table}_${cols.join('_')}_uq`
      stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteSqlIdentifier(idxName)} ON ${quoteSqlIdentifier(table)} (${cols.map(quoteSqlIdentifier).join(', ')})`)
    }
    for (const idx of def.indexes) {
      stmts.push(`CREATE INDEX IF NOT EXISTS ${quoteSqlIdentifier(idx.name)} ON ${quoteSqlIdentifier(table)} (${idx.cols.map(quoteSqlIdentifier).join(', ')})`)
    }
  }
  return stmts
}

// Exported so tests can run a strict prefix of the migration list (AC-4:
// opening a db created by an earlier prefix under the full list).
export const MIGRATIONS = migrationsFor()

// A CREATE UNIQUE INDEX is the ONE migration statement that can fail on data
// rather than on schema: rows already on disk may violate a key declared later.
// applyMigrations runs inside ensureDb on EVERY open and the failing statement
// runs before any writer does, so letting that throw degrades the handle
// forever and puts the documented remedy (replayJsonl, which needs an open
// mirror) permanently out of reach (#716/F6). Skip the index, keep the db
// openable, and NAME what is not enforced -- never silently.
function isUniqueIndexFailure(err, stmt) {
  return /^CREATE UNIQUE INDEX/i.test(String(stmt))
    && /UNIQUE constraint failed|constraint failed/i.test(String(err && err.message))
}
function uniqueIndexNameOf(stmt) {
  const m = /CREATE UNIQUE INDEX IF NOT EXISTS "((?:[^"]|"")+)"/i.exec(String(stmt))
  return m ? m[1].replaceAll('""', '"') : String(stmt)
}

// Applies (a prefix of) MIGRATIONS, then an additive ADD COLUMN probe over
// the DECLARED table list from TABLES only (never sqlite_master — that also
// lists sqlite's own internal sqlite_sequence table, which cannot be
// ALTERed and would break a sqlite_master-driven probe). Exported as
// `applyMigrations` so tests can exercise AC-4 (idempotence, earlier-prefix
// upgrade) directly against a raw DatabaseSync connection.
export function applyMigrations(db, migrations = MIGRATIONS) {
  const unenforced = []
  for (const stmt of migrations) {
    try {
      db.exec(stmt)
    } catch (err) {
      if (!isUniqueIndexFailure(err, stmt)) throw err
      unenforced.push(uniqueIndexNameOf(stmt))
    }
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
        db.exec(`ALTER TABLE ${quoteSqlIdentifier(table)} ADD COLUMN ${quoteSqlIdentifier(col.name)} ${col.decl}`)
      }
    }
  }
  return { unenforced_unique_indexes: unenforced }
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
    this.name = 'LedgerUsageError'
    this.reason = reason
  }
}

function refuse(message, reason = 'usage') {
  throw new LedgerUsageError(`ledger: ${message}`, reason)
}

// The tier VOCABULARY (mechanical | build | judge) lives in crew/roster.json
// and is resolved at boot (crew/crew.mjs resolveTier throws on an unknown
// tier), so this deliberately declares no enum of its own rather than becoming
// a second source of truth for a ratified artifact. An absent tier is a fact
// (null); a non-string, blank or unbounded tier is a CALLER BUG and refuses.
const TIER_MAX_CHARS = 64

function normaliseShortName(value, ctx, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '' || value.length > TIER_MAX_CHARS) {
    refuse(`${ctx}: field '${field}' must be a non-blank string of at most ${TIER_MAX_CHARS} characters when present`)
  }
  return value.trim()
}

// The one truncation shape for durable free text: keep the head, mark the
// cut. normaliseRequestText's bound is this shape at REQUEST_MAX_CHARS; the
// 500/120 field bounds are the same idea inline (#536/F10).
const TRUNCATION_MARKER = '…[truncated]'
function boundText(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}
// Bounds every STRING LEAF under a verbatim structure, leaving keys, array
// length, order and non-string values untouched — ADR-024 forbids
// re-shaping checks/violations, and a bound on free text is not a re-shape.
// Mirrors redact()'s walk deliberately rather than inventing a second one.
function boundFreeText(value, max) {
  if (typeof value === 'string') return boundText(value, max)
  if (Array.isArray(value)) return value.map((item) => boundFreeText(item, max))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, boundFreeText(val, max)]))
  }
  return value
}

function normaliseRequestText(value, ctx) {
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${ctx}: request must be a non-blank string`)
  }
  return boundText(value.trim(), REQUEST_MAX_CHARS)
}

// The one shape a millisecond-ISO timestamp may have. BOTH paths of isoMs test
// against this single regex: the number path used to check only /\.\d{3}Z$/, so
// any epoch-ms outside years 1000-9999 was writable and un-replayable (#716/F4).
const MS_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ISO_MS_STRING_REFUSAL = 'isoMs: string input must already be a millisecond-ISO timestamp'
const ISO_MS_RANGE_REFUSAL = 'isoMs: epoch input is outside the millisecond-ISO representable range (years 1000-9999)'

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
    if (!MS_ISO_RE.test(t)) {
      refuse(ISO_MS_STRING_REFUSAL)
    }
    return t
  }
  if (typeof t !== 'number' && !(t instanceof Date)) {
    refuse(`isoMs: expected an epoch-ms number, a Date, or an already-ms-ISO string, got ${typeof t}`)
  }
  let iso
  try {
    iso = new Date(t).toISOString()
  } catch (err) {
    if (err instanceof RangeError) refuse(ISO_MS_RANGE_REFUSAL)
    throw err
  }
  if (!MS_ISO_RE.test(iso)) {
    refuse(ISO_MS_RANGE_REFUSAL)
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

// SQLite's post-affinity STORAGE CLASS is half of a stored value's identity:
// the same bytes in two classes are two different rows. Measured here, in an
// INTEGER-affinity column, '1e400' is stored as the REAL Infinity while the
// TEXT value 'Infinity' stays TEXT — a key carrying only the string form
// collapsed those two rows into one and hid a missing row. So the class is
// encoded ALONGSIDE the value, and no value-specific instance of this family
// can exist. The equivalences that are INTENDED survive, because they are real
// conversions: '42' and 42 both land as INTEGER 42 in an INTEGER column.
const DRIFT_NULL_SENTINEL = Object.freeze({ kind: 'null' })
const DRIFT_NUMERIC_LITERAL = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/
function declaredAffinity(decl) {
  const upper = decl.toUpperCase()
  if (upper.includes('INT')) return 'INTEGER'
  if (upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('TEXT')) return 'TEXT'
  if (upper.includes('BLOB') || upper === '') return 'BLOB'
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}
const DRIFT_COLUMN_AFFINITIES = new Map()
for (const table of Object.values(TABLES)) {
  for (const { name, decl } of table.columns) {
    if (!DRIFT_COLUMN_AFFINITIES.has(name)) {
      DRIFT_COLUMN_AFFINITIES.set(name, declaredAffinity(decl))
    }
  }
}
const DRIFT_INTEGER_LITERAL = /^[+-]?\d+$/
const DRIFT_TYPE_PREFIX = '_drift_type_'
const DRIFT_INT64_MIN = -(2n ** 63n)
const DRIFT_INT64_MAX = 2n ** 63n - 1n

function driftEncoded(storageClass, value) {
  return { kind: 'value', class: storageClass, value }
}

function driftHexBytes(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The JSONL side: SQLite has not seen this value, so the class it WOULD be
// stored in is derived from the column's declared affinity. Measured rules —
// under INTEGER/NUMERIC affinity a numeric literal lands as INTEGER when it
// converts to a 64-bit integer losslessly ('1e2' -> integer 100, '0042' ->
// integer 42) and as REAL otherwise ('9223372036854775808', '.5', '1e400');
// a non-numeric string stays TEXT ('Infinity', 'nan', '1e400x'); under REAL
// affinity every numeric literal lands as REAL; under TEXT or BLOB affinity a
// string is stored unchanged.
function driftValue(column, value) {
  const bindable = toBindable(value)
  if (bindable === null || (typeof bindable === 'number' && Number.isNaN(bindable))) return DRIFT_NULL_SENTINEL
  const affinity = DRIFT_COLUMN_AFFINITIES.get(column) ?? 'BLOB'
  if (bindable instanceof Uint8Array) {
    // No affinity ever converts a BLOB.
    return driftEncoded('BLOB', driftHexBytes(bindable))
  }
  if (typeof bindable === 'bigint') {
    return affinity === 'TEXT' ? driftEncoded('TEXT', bindable.toString()) : driftEncoded('INTEGER', bindable.toString())
  }
  if (typeof bindable === 'number') {
    // node:sqlite binds every JS number as a double; an integral double is
    // stored as INTEGER under INTEGER/NUMERIC affinity and as REAL elsewhere.
    if (affinity === 'TEXT') return driftEncoded('TEXT', String(bindable))
    if (affinity === 'INTEGER' || affinity === 'NUMERIC') {
      if (Number.isInteger(bindable)) {
        const exact = BigInt(bindable)
        // SQLite's REAL-to-INTEGER affinity boundary is open at -2^63:
        // that exact double remains REAL, unlike an in-range integer literal.
        if (exact > DRIFT_INT64_MIN && exact <= DRIFT_INT64_MAX) return driftEncoded('INTEGER', exact.toString())
      }
    }
    return driftEncoded('REAL', String(bindable))
  }
  if (affinity === 'TEXT' || affinity === 'BLOB') return driftEncoded('TEXT', bindable)
  const trimmed = bindable.trim()
  if (!DRIFT_NUMERIC_LITERAL.test(trimmed)) return driftEncoded('TEXT', bindable)
  if (affinity === 'INTEGER' || affinity === 'NUMERIC') {
    if (DRIFT_INTEGER_LITERAL.test(trimmed)) {
      // BigInt, not Number: an integer literal above 2^53 must not be decided
      // by a lossy double, and the int64 range is where SQLite itself gives up
      // on INTEGER and stores REAL.
      const exact = BigInt(trimmed.replace(/^\+/, ''))
      if (exact >= DRIFT_INT64_MIN && exact <= DRIFT_INT64_MAX) return driftEncoded('INTEGER', exact.toString())
    } else {
      const numeric = Number(trimmed)
      if (Number.isInteger(numeric) && Number.isSafeInteger(numeric)) return driftEncoded('INTEGER', String(numeric))
    }
  }
  return driftEncoded('REAL', String(Number(trimmed)))
}

// The mirror side never GUESSES its class: it is read from SQLite's own
// typeof() selected beside the column, because node:sqlite hands back a REAL
// 42.0 as the JS number 42, indistinguishable from an INTEGER 42 by JS type.
function driftRowValue(sqliteType, value) {
  if (value === null || sqliteType === 'null') return DRIFT_NULL_SENTINEL
  if (sqliteType === 'blob') return driftEncoded('BLOB', driftHexBytes(value))
  if (sqliteType === 'integer' || sqliteType === 'real' || sqliteType === 'text') {
    return driftEncoded(sqliteType.toUpperCase(), typeof value === 'bigint' ? value.toString() : String(value))
  }
  return driftEncoded('TEXT', String(value))
}

function driftKey(cols, source) {
  const src = source ?? {}
  return JSON.stringify(cols.map((c) => driftValue(c, src[c])))
}

function driftRowKey(cols, row) {
  return JSON.stringify(cols.map((c) => driftRowValue(row[`${DRIFT_TYPE_PREFIX}${c}`], row[c])))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// The honesty rule (docs/ledger-queries.md:31): an authority that cannot be
// read is UNMEASURED, never a measured zero drift.
function unmeasuredDrift(jsonlPath, reason) {
  return {
    measured: false,
    unmeasured_reason: reason,
    jsonl_path: jsonlPath,
    lines: null,
    unparsed_lines: null,
    unknown_kind_lines: null,
    writers: [],
    drift_total: null,
    remedy: null,
    collapsed_lines_total: null,
    collapse_remedy: null,
  }
}

// ---------------------------------------------------------------------------
// openLedger — synchronous, lazy.
// ---------------------------------------------------------------------------

export function openLedger({
  dbPath,
  jsonlPath = join(dirname(dbPath), 'ledger.jsonl'),
  nodeVersion = process.versions.node,
  now = () => Date.now(),
  stderr = process.stderr, readOnly = false,
} = {}) {
  if (!dbPath) {
    refuse('openLedger requires dbPath')
  }
  if (underTest() && resolve(dbPath) === homeDefaultDbPath()) refuseHomeLedgerUnderTest('openLedger')

  const dir = dirname(dbPath)
  const stats = {
    mirror_errors: 0,
    mirror_first_code: null,
    dropped_payload_keys: 0,
    redacted_values: 0,
    // #541: a record whose seq could NOT be re-numbered (a caller-supplied
    // seq) and whose key is already held by DIFFERENT content — the mirror
    // keeps the first and this record exists only in the JSONL authority.
    seq_collisions: 0,
    // Two near-synonyms holding different things: degraded_reason is a CODE
    // ('below_floor' for the version check, else an open failure's error
    // code/name), degraded_message is the full human sentence passed to
    // noteDegraded. Both consumers depend on the split: scripts/factory/emit.mjs
    // compares degraded_reason against 'below_floor' to decide whether a
    // degradation was expected, and visualizer/server/ledger-feed.mjs surfaces
    // degraded_message verbatim as the run-set's absent prose. Both null while
    // not degraded.
    degraded_reason: null, degraded_message: null,
    unenforced_unique_indexes: [],
  }
  const seqAllocators = new Map() // `${adw_id}:${kind}` -> next seq
  const seqFloors = new Map() // `${adw_id}:${kind}` -> JSONL authority floor

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
  let replaying = false

  // A typed absence, not a prose one: the code lands in stats().degraded_reason
  // and the unmeasured drift readout names the same condition, so a reader can
  // tell "the mirror file is gone" from every other unmeasured cause (#536/F9).
  const MIRROR_MISSING_CODE = 'mirror_missing'
  const MIRROR_MISSING_MESSAGE = 'the mirror file is no longer on disk'

  function noteDegraded(reason, code) {
    degraded = true
    if (!stats.degraded_reason) {
      stats.degraded_reason = code || 'unknown'
    }
    if (!stats.degraded_message) stats.degraded_message = reason
    if (!degradedNoticeWritten) {
      degradedNoticeWritten = true
      const consequence = readOnly
        ? 'read-only handle unavailable; writes remain refused'
        : 'mirror disabled, JSONL recording continues'
      stderr.write(`ledger: degraded (${reason}) — ${consequence}\n`)
    }
  }

  function ensureDirAndPerms() {
    mkdirpBounded(dir, 0o700)
    // mode is masked by the process umask, so an explicit chmod is what
    // actually guarantees 0700.
    chmodIfExists(dir, 0o700)
  }

  function assertWritable() {
    if (readOnly) refuse('this ledger handle is read-only — it may not write')
  }

  // Lazily opens the SQLite mirror on first real access; every writer stays synchronous.
  // Bounded, immediate (no-sleep) open-lock retry budget; the catch block
  // below explains why retries never sleep. Raised from a single retry (round 3) to a
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
      // Below-floor degradation emits its notice lazily on first access.
      // A read-only handle's consequence names refused writes.
      dbOpenAttempted = true
      noteDegraded(`node ${nodeVersion} is below NODE_FLOOR ${NODE_FLOOR}`, 'below_floor')
      return null
    }
    try {
      if (!readOnly) ensureDirAndPerms()
      const { DatabaseSync } = require('node:sqlite')
      const conn = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath)
      // busy_timeout is set FIRST, before journal_mode/synchronous: those
      // two pragmas (and the migrations that follow) can themselves throw
      // "database is locked" against a freshly-created db another process
      // is concurrently opening, and only a statement that runs AFTER
      // busy_timeout is applied gets SQLite's own internal wait — setting
      // it any later left journal_mode/synchronous themselves exposed to
      // an instant, unprotected lock failure.
      conn.exec('PRAGMA busy_timeout = 5000')
      if (!readOnly) {
        conn.exec('PRAGMA journal_mode = WAL')
        conn.exec('PRAGMA synchronous = 1')
        const report = applyMigrations(conn)
        stats.unenforced_unique_indexes = [...report.unenforced_unique_indexes]
        if (report.unenforced_unique_indexes.length > 0) {
          stderr.write(`ledger: unique index not enforced on this file (${report.unenforced_unique_indexes.join(', ')}) — rows on disk predate it; the mirror stays open and jsonlDrift keeps measuring, but this key is NOT unique here\n`)
        }
        chmodIfExists(dbPath, 0o600)
        chmodIfExists(`${dbPath}-wal`, 0o600)
        chmodIfExists(`${dbPath}-shm`, 0o600)
      }
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
    assertWritable()
    // A replay reconstructs the MIRROR from the authority; it must never write
    // the authority back into itself. Replaying a ledger's own jsonlPath used to
    // double the file (7 -> 14 -> 28) and re-stamp every line with isoMs(now())
    // (#716/F3). assertWritable stays ABOVE this line: a read-only handle must
    // still refuse a replay rather than silently mirror it.
    if (replaying) return
    ensureDirAndPerms()
    const line = { v: LEDGER_VERSION, kind, at: isoMs(now()), args }
    appendFileSync(jsonlPath, `${JSON.stringify(line)}\n`)
    chmodIfExists(jsonlPath, 0o600)
  }

  // A per-call mirror-error channel. stats().mirror_first_code LATCHES for the
  // life of the handle: it holds the FIRST code this handle ever saw and never
  // updates. A long-lived reader (the visualizer feed keeps one handle for the
  // server's whole life) that detects a failure by a stats().mirror_errors
  // delta and then reads that stat publishes a cause belonging to some earlier,
  // unrelated failure. Callers that must report THIS call's cause wrap the call
  // in captureMirrorErrors instead. #580 RV1-5/6.
  const mirrorErrorSinks = []
  function noteMirrorError(err) {
    const code = err?.code ?? err?.name ?? 'UnknownMirrorError'
    stats.mirror_errors += 1
    if (!stats.mirror_first_code) stats.mirror_first_code = code
    for (const sink of mirrorErrorSinks) {
      sink.count += 1
      if (!sink.first_code) sink.first_code = code
      if (!sink.first_message) sink.first_message = err?.message || String(err)
      sink.last_code = code
      sink.last_message = err?.message || String(err)
    }
    return code
  }

  // Returns { value, errors } where errors is { count, first_code, last_code }
  // over the mirror failures recorded DURING fn() and nothing else. An
  // exception thrown by fn propagates unchanged: a throw is a different
  // condition from a swallowed mirror failure and must not be reported as one.
  function captureMirrorErrors(fn) {
    const sink = { count: 0, first_code: null, last_code: null }
    Object.defineProperties(sink, {
      first_message: { value: null, writable: true },
      last_message: { value: null, writable: true },
    })
    mirrorErrorSinks.push(sink)
    try {
      return { value: fn(), errors: sink }
    } finally {
      mirrorErrorSinks.splice(mirrorErrorSinks.indexOf(sink), 1)
    }
  }

  function mirror(fn) {
    const conn = ensureDb()
    if (!conn) return
    try {
      fn(conn)
    } catch (err) {
      noteMirrorError(err)
    }
  }

  // #541: the mirror is NOT the authority. A handle that was degraded (below
  // NODE_FLOOR, or an open failure) mirrored nothing, so seeding from
  // MAX(seq) alone re-issues sequence numbers the JSONL already spent. The
  // floor is therefore max(this process's high-water, the JSONL authority,
  // the mirror). The mirror side is re-read on EVERY allocation — an indexed
  // MAX over UNIQUE(adw_id, seq) — because a memoised seed cannot see the row
  // another process committed one millisecond ago.
  function mirrorMaxSeq(conn, seqKind, adwId) {
    const table = seqKind === 'phase' ? 'phases' : 'events'
    try {
      const row = conn.prepare(`SELECT MAX(seq) AS m FROM ${table} WHERE adw_id = ?`).get(adwId)
      return row && row.m != null ? Number(row.m) : 0
    } catch {
      return 0
    }
  }

  function jsonlSeqFloor(adwId, seqKind) {
    const key = `${adwId}:${seqKind}`
    if (seqFloors.has(key)) return seqFloors.get(key)
    const table = seqKind === 'phase' ? 'phases' : 'events'
    let max = 0
    try {
      const text = readFileSync(jsonlPath, 'utf8')
      for (const raw of text.split('\n')) {
        if (!raw) continue
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }
        const kind = parsed && parsed.kind
        if (typeof kind !== 'string' || WRITER_MIRROR_TABLES[kind] !== table) continue
        const args = parsed.args
        if (!args || args.adw_id !== adwId) continue
        const rawSeq = args.seq
        if (typeof rawSeq !== 'number' && (typeof rawSeq !== 'string' || rawSeq.trim() === '')) continue
        const seq = Number(rawSeq)
        if (Number.isFinite(seq)) max = Math.max(max, seq)
      }
    } catch {
      max = 0
    }
    seqFloors.set(key, max)
    return max
  }

  function advanceJsonlSeqFloor(adwId, seqKind, seq) {
    if (typeof seq !== 'number' && (typeof seq !== 'string' || seq.trim() === '')) return
    const numericSeq = Number(seq)
    if (!Number.isFinite(numericSeq)) return
    const key = `${adwId}:${seqKind}`
    const currentFloor = seqFloors.has(key) ? seqFloors.get(key) : jsonlSeqFloor(adwId, seqKind)
    seqFloors.set(key, Math.max(currentFloor, numericSeq))
  }

  function nextSeq(adwId, seqKind, conn) {
    const key = `${adwId}:${seqKind}`
    let max = seqAllocators.get(key) ?? 0
    max = Math.max(max, jsonlSeqFloor(adwId, seqKind))
    if (conn) max = Math.max(max, mirrorMaxSeq(conn, seqKind, adwId))
    const next = max + 1
    seqAllocators.set(key, next)
    return next
  }

  function noteSeqCollision() {
    stats.mirror_errors += 1
    stats.seq_collisions += 1
  }

  // #541: allocate-then-CONFIRM for the three writers that ISSUE a seq.
  // `build(seq)` returns { args, row } — args is the writer's public-parameter
  // shape (what goes to the JSONL and what replayJsonl re-applies), row is the
  // table row. `insert(conn, row)` performs the INSERT OR IGNORE and returns
  // its result. The JSONL line is appended exactly once, after the seq is
  // settled, whether or not the mirror is reachable. This ordering deliberately
  // closes the permanent authority loss caused by appending before a refused
  // unique-key insert; a crash after the committed row but before its line is
  // a rebuildable mirror-row gap instead.
  function insertSequenced({ jsonlKind, adwId, seqKind, explicitSeq, build, insert }) {
    assertWritable()
    const conn = ensureDb()
    if (!conn) {
      const seq = explicitSeq ?? nextSeq(adwId, seqKind, null)
      const { args } = build(seq)
      appendJsonl(jsonlKind, args)
      if (explicitSeq !== undefined) advanceJsonlSeqFloor(adwId, seqKind, explicitSeq)
      return { args, res: null }
    }

    const table = seqKind === 'phase' ? 'phases' : 'events'
    const keyCols = TABLES[table].unique[0]
    const compareCols = TABLES[table].columns.filter(({ name }) => name !== 'id').map(({ name }) => name)
    let args = null
    let res = null
    let settled = false
    for (let attempt = 0; attempt < SEQ_COLLISION_RETRY_BUDGET; attempt += 1) {
      const seq = explicitSeq ?? nextSeq(adwId, seqKind, conn)
      const built = build(seq)
      args = built.args
      try {
        res = insert(conn, built.row)
      } catch (err) {
        noteMirrorError(err)
        break
      }
      if (res.changes === 1) {
        settled = true
        break
      }
      if (res.changes === 0 && explicitSeq === undefined) continue
      if (res.changes === 0 && explicitSeq !== undefined) {
        let identical = false
        try {
          const selection = compareCols.flatMap((c) => [
            quoteSqlIdentifier(c),
            `typeof(${quoteSqlIdentifier(c)}) AS ${quoteSqlIdentifier(`${DRIFT_TYPE_PREFIX}${c}`)}`,
          ]).join(', ')
          const where = keyCols.map((c) => `${quoteSqlIdentifier(c)} = ?`).join(' AND ')
          const existing = conn.prepare(`SELECT ${selection} FROM ${quoteSqlIdentifier(table)} WHERE ${where}`)
            .get(...keyCols.map((c) => toBindable(built.row[c])))
          identical = existing != null && driftKey(compareCols, built.row) === driftRowKey(compareCols, existing)
        } catch {
          // A refused insert with an unreadable incumbent is not provably
          // idempotent; preserve the collision signal rather than guessing.
        }
        if (!identical) {
          noteSeqCollision()
        }
        break
      }
      break
    }
    if (!settled && explicitSeq === undefined && res?.changes === 0) noteSeqCollision()
    appendJsonl(jsonlKind, args)
    if (explicitSeq !== undefined) advanceJsonlSeqFloor(adwId, seqKind, explicitSeq)
    return { args, res }
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
      // #536/F11: `null` stays legitimate for required keys that carry an explicit
      // absence (endProcess's exit_code/exit_signal), but never for `adw_id` — SQLite
      // permits NULL in a TEXT PRIMARY KEY and treats NULLs as distinct under UNIQUE,
      // so such a row can never be addressed, joined or cleaned up. This is per-writer,
      // not global: the writers for which adw_id is genuinely optional
      // (recordCellFailure's boot refusal, recordModifierAttempt) never list it here.
      if (f === 'adw_id' && (typeof obj[f] !== 'string' || obj[f].trim() === '')) {
        refuse(`${ctx}: field 'adw_id' must be a non-blank string`)
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
      // emit.mjs:936 mints this sessions row inside the crew run, before the
      // dispatcher can reach it; the request arrives later via
      // recordSessionRequest. Keep explicit nulls rather than omitting facts.
      request: null,
      request_source: null,
      last_heartbeat_at: null,
      // Forwarded from the caller's boot record (scripts/factory/emit.mjs),
      // never derived here. Explicit null when the boot recorded no tier.
      tier: normaliseShortName(input.tier, 'startSession', 'tier'),
      // Forwarded from the brief's compiler block by scripts/factory/emit.mjs;
      // explicit null when the brief carried no proposal.
      proposed_shape: normaliseShortName(input.proposed_shape, 'startSession', 'proposed_shape'),
      proposed_strength: normaliseShortName(input.proposed_strength, 'startSession', 'proposed_strength'),
    }, stats)
    sessionStatusByAdwId.set(args.adw_id, args.status)
    appendJsonl('startSession', args)
    mirror((conn) => {
      conn.prepare(`INSERT OR IGNORE INTO sessions (${tableColumnNames('sessions').join(', ')}) VALUES (${tableColumnNames('sessions').map(() => '?').join(', ')})`)
        .run(...tableColumnNames('sessions').map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordSessionRequest(input = {}) {
    // A request value redacted before JSONL append must remain replayable:
    // encode it as an explicit no-op, never as a malformed writer line or a
    // source-without-request fact. This shape is produced only after field
    // hygiene and is accepted again when replayJsonl dispatches it.
    const redactedNoop = input.redacted === true
    let args
    if (redactedNoop) {
      if (input.request !== null || input.source !== null) {
        refuse('recordSessionRequest: redacted replay must carry null request and source')
      }
      args = redact({
        adw_id: input.adw_id ?? null, request: null, source: null, redacted: true,
      }, stats)
      // redact() drops a marker-bearing adw_id; retain the fixed no-op shape
      // without restoring those caller-controlled bytes.
      if (args.adw_id === undefined) args.adw_id = null
    } else {
      requireFields(input, ['adw_id', 'request', 'source'], 'recordSessionRequest')
      requireEnum(input.source, REQUEST_SOURCES, 'recordSessionRequest', 'source')
      args = redact({
        adw_id: input.adw_id,
        request: normaliseRequestText(input.request, 'recordSessionRequest'),
        source: input.source,
      }, stats)
      if (args.adw_id === undefined || args.request === undefined || args.source === undefined) {
        args = { adw_id: args.adw_id ?? null, request: null, source: null, redacted: true }
      }
    }
    appendJsonl('recordSessionRequest', args)
    if (args.redacted) return args
    mirror((conn) => {
      // First write wins: a re-dispatch or JSONL replay must not rewrite the
      // request measured for this run. UPDATE never invents a sessions row.
      conn.prepare(`
        UPDATE sessions
           SET request = COALESCE(request, ?), request_source = COALESCE(request_source, ?)
         WHERE adw_id = ?
      `).run(
        toBindable(args.request), toBindable(args.source), toBindable(args.adw_id),
      )
    })
    return args
  }

  function endSession(input = {}) {
    requireFields(input, ['adw_id', 'status'], 'endSession')
    requireEnum(input.status, SESSION_STATUSES, 'endSession', 'status')
    if (input.outcome != null) requireEnum(input.outcome, SESSION_OUTCOMES, 'endSession', 'outcome')
    if (input.terminal_actor != null) requireEnum(input.terminal_actor, TERMINAL_ACTORS, 'endSession', 'terminal_actor')
    const args = redact({
      adw_id: input.adw_id,
      ended_at: isoMs(input.ended_at ?? now()),
      status: input.status,
      outcome: input.outcome ?? null,
      terminal_reason: normaliseShortName(input.terminal_reason, 'endSession', 'terminal_reason'),
      terminal_actor: input.terminal_actor ?? null,
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
          outcome = ?, terminal_reason = ?, terminal_actor = ?,
          billed_input_tokens = COALESCE(?, billed_input_tokens),
          billed_output_tokens = COALESCE(?, billed_output_tokens),
          billed_cache_write_tokens = COALESCE(?, billed_cache_write_tokens),
          billed_cache_read_tokens = COALESCE(?, billed_cache_read_tokens),
          billed_cost_usd = COALESCE(?, billed_cost_usd)
        WHERE adw_id = ?
      `).run(
        toBindable(args.ended_at), toBindable(args.status),
        toBindable(args.outcome), toBindable(args.terminal_reason), toBindable(args.terminal_actor),
        toBindable(args.billed_input_tokens), toBindable(args.billed_output_tokens),
        toBindable(args.billed_cache_write_tokens), toBindable(args.billed_cache_read_tokens),
        toBindable(args.billed_cost_usd),
        toBindable(args.adw_id),
      )
    })
    return args
  }

  function recordRunConfiguration(input = {}) {
    const required = [
      'adw_id', 'schema_version', 'task_profile', 'task_profile_source',
      'requested_execution', 'effective_execution', 'execution_source',
      'requested_assurance', 'effective_assurance', 'assurance_source',
      'legacy_variant', 'legacy_tier',
    ]
    requireFields(input, required, 'recordRunConfiguration')
    if (!Number.isInteger(input.schema_version) || input.schema_version < 1) {
      refuse('recordRunConfiguration: schema_version must be a positive integer')
    }
    const short = (field) => normaliseShortName(input[field], 'recordRunConfiguration', field)
    const args = redact({
      adw_id: input.adw_id,
      schema_version: input.schema_version,
      task_profile: short('task_profile'),
      task_profile_source: short('task_profile_source'),
      requested_execution: short('requested_execution'),
      effective_execution: short('effective_execution'),
      execution_source: short('execution_source'),
      requested_assurance: short('requested_assurance'),
      effective_assurance: short('effective_assurance'),
      assurance_source: short('assurance_source'),
      legacy_variant: short('legacy_variant'),
      legacy_tier: short('legacy_tier'),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    appendJsonl('recordRunConfiguration', args)
    mirror((conn) => {
      const cols = tableColumnNames('run_configurations')
      conn.prepare(`INSERT OR IGNORE INTO run_configurations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((column) => toBindable(args[column])))
    })
    return args
  }

  function recordRunSeat(input = {}) {
    const required = [
      'adw_id', 'role', 'agent', 'provider', 'model_id', 'model',
      'effort', 'transport', 'source', 'policy_state',
    ]
    requireFields(input, required, 'recordRunSeat')
    requireEnum(input.source, SEAT_VALUE_SOURCES, 'recordRunSeat', 'source')
    const short = (field) => normaliseShortName(input[field], 'recordRunSeat', field)
    // Replay feeds this writer its own `args` back (ledger.mjs:3911), which carries
    // warnings_json rather than warnings — accept both so a replayed row equals
    // its source row exactly.
    const storedWarnings = typeof input.warnings_json === 'string' ? input.warnings_json : null
    // Warnings arrive as an array and are stored as JSON text: the column is one
    // seat's applicable warnings (TRD §3.5), and an absent list is `[]` because the
    // writer is only ever called for a seat that WAS resolved — absence lives at
    // the row level (no row) and is never smuggled into a field. Redact the array
    // elements before serializing: otherwise a protected warning makes redact()
    // drop the entire JSON string, losing safe siblings and replay equivalence.
    const warnings = Array.isArray(input.warnings) ? input.warnings : []
    const storedWarningValues = redact(
      warnings.filter((w) => typeof w === 'string').map((w) => normaliseShortName(w, 'recordRunSeat', 'warnings')),
      stats,
    )
    const args = redact({
      adw_id: input.adw_id,
      role: short('role'),
      agent: short('agent'),
      provider: short('provider'),
      model_id: short('model_id'),
      model: short('model'),
      effort: short('effort'),
      transport: short('transport'),
      source: input.source,
      policy_state: short('policy_state'),
      warnings_json: storedWarnings ?? JSON.stringify(storedWarningValues),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    appendJsonl('recordRunSeat', args)
    mirror((conn) => {
      const cols = tableColumnNames('run_seats')
      conn.prepare(`INSERT OR IGNORE INTO run_seats (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((column) => toBindable(args[column])))
    })
    return args
  }

  function startPhase(input = {}) {
    requireFields(input, ['adw_id', 'name'], 'startPhase')
    const explicitSeq = input.seq ?? undefined
    const startedAt = isoMs(input.started_at ?? now())
    const inserted = insertSequenced({
      jsonlKind: 'startPhase',
      adwId: input.adw_id,
      seqKind: 'phase',
      explicitSeq,
      build: (seq) => {
        const args = redact({
          adw_id: input.adw_id,
          seq,
          name: input.name,
          started_at: startedAt,
          ended_at: null,
          status: 'running',
        }, stats)
        return { args, row: args }
      },
      insert: (conn, row) => {
        const cols = tableColumnNames('phases').filter((c) => c !== 'id')
        return conn.prepare(`INSERT OR IGNORE INTO phases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => toBindable(row[c])))
      },
    })
    const { args, res } = inserted
    let phaseId = null
    if (res) {
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
        const conn = ensureDb()
        if (conn) {
          try {
            const row = conn.prepare('SELECT id FROM phases WHERE adw_id = ? AND seq = ?').get(args.adw_id, args.seq)
            phaseId = row ? Number(row.id) : null
          } catch {
            phaseId = null
          }
        }
      }
    }
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
    // Redact BEFORE stringifying: once payload is JSON text, a nested
    // DEVTEAM_*-shaped key is no longer a real object key the key-based
    // scan below can see — only value-substring scanning still applies.
    // args carries `payload` as the resolved OBJECT (matching this
    // method's own public parameter shape, not the events-table row shape)
    // so replayJsonl's `ledger.recordEvent(args)` dispatch round-trips
    // exactly; payload_json is derived from it only at mirror-insert time.
    const payload = redact(applyPayloadAllowlist(input.type, input.payload, stats), stats)
    // #536/F10: `message` is the one free-text payload key with no bound; a 5 MB
    // log line otherwise lands verbatim in BOTH the JSONL authority and the
    // events mirror. Bounded before either is written.
    if (input.type === 'log' && payload.message != null) {
      payload.message = typeof payload.message === 'string'
        ? boundText(payload.message, REQUEST_MAX_CHARS)
        : boundFreeText(payload.message, REQUEST_MAX_CHARS)
    }
    const startedAt = input.started_at != null ? isoMs(input.started_at) : (input.type === 'tool_call' ? isoMs(now()) : null)
    const endedAt = input.ended_at != null ? isoMs(input.ended_at) : (input.type === 'tool_call' ? isoMs(now()) : null)
    const inserted = insertSequenced({
      jsonlKind: 'recordEvent',
      adwId: input.adw_id,
      seqKind: 'event',
      explicitSeq: input.seq ?? undefined,
      build: (seq) => {
        const args = redact({
          adw_id: input.adw_id,
          seq,
          type: input.type,
          phase_id: input.phase_id ?? null,
          parent_id: input.parent_id ?? null,
          started_at: startedAt,
          ended_at: endedAt,
          payload,
        }, stats)
        return { args, row: { ...args, payload_json: JSON.stringify(args.payload) } }
      },
      insert: (conn, row) => {
        const cols = tableColumnNames('events').filter((c) => c !== 'id')
        return conn.prepare(`INSERT OR IGNORE INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => toBindable(row[c])))
      },
    })
    return inserted.args
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
      // same as every other writer's field-hygiene pass. Only string leaves
      // are bounded; keys, array length, order and non-string values remain
      // verbatim. Kept as arrays in args (this method's own public parameter
      // shape); stringified only at mirror-insert time so replay round-trips
      // exactly.
      checks: boundFreeText(redact(input.checks ?? [], stats), REQUEST_MAX_CHARS),
      violations: boundFreeText(redact(input.violations ?? [], stats), REQUEST_MAX_CHARS),
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
      // The cell the seat BOOTED with, handed in by the caller (#404): never
      // re-derived here from crew/roster.json, which a raw --model-<role>
      // override makes wrong for exactly the runs #376 measures. Absence is
      // NULL, never a guess.
      ...cellFieldsFrom(input),
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

  function recordAcceptDecision(input = {}) {
    requireFields(input, ['adw_id', 'outcome'], 'recordAcceptDecision')
    requireEnum(input.outcome, ACCEPT_DECISION_OUTCOMES, 'recordAcceptDecision', 'outcome')
    const args = redact({
      adw_id: input.adw_id,
      phase_id: input.phase_id ?? null,
      where_at: input.where_at ?? input.where ?? null,
      outcome: input.outcome,
      findings_total: input.findings_total ?? null,
      residual_count: input.residual_count ?? null,
      refuted_count: input.refuted_count ?? null,
      cosmetic_count: input.cosmetic_count ?? null,
      unverified_count: input.unverified_count ?? null,
      invalid_reasons: input.invalid_reasons == null ? null : String(input.invalid_reasons),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.invalid_reasons != null) args.invalid_reasons = args.invalid_reasons.slice(0, 500)
    appendJsonl('recordAcceptDecision', args)
    mirror((conn) => {
      const cols = tableColumnNames('accept_decisions').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO accept_decisions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function linkRun(input = {}) {
    requireFields(input, ['run_id', 'adw_id'], 'linkRun')
    const args = redact({
      run_id: input.run_id,
      adw_id: input.adw_id,
      crew_dir: input.crew_dir ?? null,
      linked_at: isoMs(input.linked_at ?? now()),
    }, stats)
    appendJsonl('linkRun', args)
    mirror((conn) => {
      const cols = tableColumnNames('run_links').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO run_links (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordCellFailure(input = {}) {
    requireFields(input, ['role', 'kind'], 'recordCellFailure')
    requireEnum(input.kind, CELL_FAILURE_KINDS, 'recordCellFailure', 'kind')
    if (input.attribution != null) {
      requireEnum(input.attribution, CELL_FAILURE_ATTRIBUTIONS, 'recordCellFailure', 'attribution')
    }
    const args = redact({
      adw_id: input.adw_id ?? null,          // NULL is a FACT here, not a gap:
      task_slug: input.task_slug ?? null,    // bootCmd opens no run (crew.mjs:449)
      phase_id: input.phase_id ?? null,
      dispatch_id: input.dispatch_id ?? null,
      role: input.role,
      agent: input.agent ?? null,
      provider: input.provider ?? null,
      model_id: input.model_id ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      transport: input.transport ?? null,
      kind: input.kind,
      stage: input.stage == null ? null : String(input.stage),
      detail: input.detail == null ? null : String(input.detail),
      attribution: input.attribution ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.stage != null) args.stage = args.stage.slice(0, 120)
    if (args.detail != null) args.detail = args.detail.slice(0, 500)
    appendJsonl('recordCellFailure', args)
    mirror((conn) => {
      const cols = tableColumnNames('cell_failures').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO cell_failures (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordCiCycle(input = {}) {
    requireFields(input, ['branch', 'head_sha', 'check_name', 'cycle', 'conclusion', 'classification', 'decision'], 'recordCiCycle')
    requireEnum(input.classification, CI_CLASSIFICATIONS, 'recordCiCycle', 'classification')
    requireEnum(input.decision, CI_DECISIONS, 'recordCiCycle', 'decision')
    if (input.decision === 'repair' && input.classification !== 'reproduced') {
      refuse("recordCiCycle: decision 'repair' requires classification 'reproduced'")
    }
    if (input.classification === 'unknown' && !input.reason) {
      refuse("recordCiCycle: classification 'unknown' requires a reason")
    }
    const args = redact({
      adw_id: input.adw_id ?? null,
      task_slug: input.task_slug ?? null,
      repo_slug: input.repo_slug ?? null,
      branch: input.branch ?? null,
      head_sha: input.head_sha ?? null,
      check_name: input.check_name ?? null,
      cycle: input.cycle ?? null,
      conclusion: input.conclusion ?? null,
      classification: input.classification,
      decision: input.decision,
      reason: input.reason == null ? null : String(input.reason),
      excerpt: input.excerpt ?? null,
      excerpt_source: input.excerpt_source ?? null,
      local_lane: input.local_lane == null ? null : String(input.local_lane),
      local_exit: input.local_exit ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    // A nonce-bearing reason is dropped by redact(), but an unknown row still
    // needs a non-empty reason so its JSONL remains replayable. Keep the
    // hygiene boundary honest with a safe sentinel rather than restoring the
    // caller's secret-bearing bytes.
    if (input.classification === 'unknown' && input.reason != null && args.reason === undefined) {
      args.reason = 'redacted'
    }
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    if (args.conclusion != null) args.conclusion = String(args.conclusion).slice(0, 120)
    if (args.check_name != null) args.check_name = String(args.check_name).slice(0, 200)
    if (args.local_lane != null) args.local_lane = args.local_lane.slice(0, 500)
    // Truncating a failure is the thing this column exists to prevent: excerpt is
    // declared VERBATIM at its column (:634) and, unlike reason/conclusion/
    // check_name/local_lane above, is never sliced here. The BOUNDARY is the
    // capturing caller's, and excerpt_source names it so a reader can tell which
    // boundary produced these bytes; this writer either passes them through whole
    // or drops them whole and records excerpt_source 'redacted'.
    if (input.excerpt != null && args.excerpt === undefined) {
      args.excerpt = null
      args.excerpt_source = 'redacted'
    }
    appendJsonl('recordCiCycle', args)
    mirror((conn) => {
      const cols = tableColumnNames('ci_cycles').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO ci_cycles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordCiDispatch(input = {}) {
    requireFields(input, ['branch', 'head_sha', 'check_name', 'cycle', 'variant', 'outcome'], 'recordCiDispatch')
    requireEnum(input.variant, RUN_VARIANTS, 'recordCiDispatch', 'variant')
    requireEnum(input.outcome, CI_DISPATCH_OUTCOMES, 'recordCiDispatch', 'outcome')
    if (input.outcome === 'refused' && !input.reason) {
      refuse("recordCiDispatch: outcome 'refused' requires a reason")
    }
    const args = redact({
      adw_id: input.adw_id ?? null,
      task_slug: input.task_slug ?? null,
      repo_slug: input.repo_slug ?? null,
      branch: input.branch ?? null,
      head_sha: input.head_sha ?? null,
      check_name: input.check_name ?? null,
      cycle: input.cycle ?? null,
      variant: input.variant,
      outcome: input.outcome,
      reason: input.reason == null ? null : String(input.reason),
      commit: input.commit == null ? null : String(input.commit),
      brief_path: input.brief_path == null ? null : String(input.brief_path),
      scope_source: input.scope_source == null ? null : String(input.scope_source),
      scope_count: input.scope_count ?? null,
      task_return: input.task_return == null ? null : String(input.task_return),
      park_path: input.park_path == null ? null : String(input.park_path),
      exit_code: input.exit_code ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (input.outcome === 'refused' && input.reason != null && args.reason === undefined) {
      args.reason = 'redacted'
    }
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    if (args.commit != null) args.commit = args.commit.slice(0, 500)
    if (args.brief_path != null) args.brief_path = args.brief_path.slice(0, 1000)
    if (args.scope_source != null) args.scope_source = args.scope_source.slice(0, 120)
    if (args.task_return != null) args.task_return = args.task_return.slice(0, 1000)
    if (args.park_path != null) args.park_path = args.park_path.slice(0, 1000)
    if (args.check_name != null) args.check_name = String(args.check_name).slice(0, 200)
    appendJsonl('recordCiDispatch', args)
    mirror((conn) => {
      const cols = tableColumnNames('ci_dispatches').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO ci_dispatches (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordIntakeSweep(input = {}) {
    requireFields(input, ['board_owner', 'board_project', 'outcome', 'considered', 'pages'], 'recordIntakeSweep')
    requireEnum(input.outcome, INTAKE_OUTCOMES, 'recordIntakeSweep', 'outcome')
    if (input.outcome === 'parked' && !input.reason) {
      refuse("recordIntakeSweep: outcome 'parked' requires a reason")
    }
    if (input.outcome === 'picked' && input.picked_issue == null) {
      refuse("recordIntakeSweep: outcome 'picked' requires picked_issue")
    }
    if (input.reason != null) requireEnum(input.reason, INTAKE_REFUSALS, 'recordIntakeSweep', 'reason')
    const args = redact({
      board_owner: input.board_owner == null ? null : String(input.board_owner),
      board_project: input.board_project,
      outcome: input.outcome,
      reason: input.reason == null ? null : String(input.reason),
      considered: input.considered,
      pages: input.pages,
      picked_issue: input.picked_issue ?? null,
      rate_limit_remaining: input.rate_limit_remaining ?? null,
      rate_limit_reset_at: input.rate_limit_reset_at ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (input.outcome === 'parked' && input.reason != null && args.reason === undefined) {
      args.reason = 'redacted'
    }
    if (args.board_owner != null) args.board_owner = args.board_owner.slice(0, 120)
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    appendJsonl('recordIntakeSweep', args)
    mirror((conn) => {
      const cols = tableColumnNames('intake_sweeps').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO intake_sweeps (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordIntakeRefusal(input = {}) {
    requireFields(input, ['board_owner', 'board_project', 'issue', 'reason'], 'recordIntakeRefusal')
    requireEnum(input.reason, INTAKE_REFUSALS, 'recordIntakeRefusal', 'reason')
    const args = redact({
      board_owner: input.board_owner == null ? null : String(input.board_owner),
      board_project: input.board_project,
      issue: input.issue,
      reason: input.reason,
      detail: input.detail == null ? null : String(input.detail),
      priority: input.priority == null ? null : String(input.priority),
      issue_created_at: input.issue_created_at ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.board_owner != null) args.board_owner = args.board_owner.slice(0, 120)
    if (args.detail != null) args.detail = args.detail.slice(0, 500)
    if (args.priority != null) args.priority = args.priority.slice(0, 40)
    appendJsonl('recordIntakeRefusal', args)
    mirror((conn) => {
      const cols = tableColumnNames('intake_refusals').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO intake_refusals (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  // actor is a claim supplied by an unauthenticated console client, not a verified identity.
  function recordIntakeBrake(input = {}) {
    requireFields(input, ['checkout', 'path', 'transition', 'actor', 'outcome'], 'recordIntakeBrake')
    requireEnum(input.transition, INTAKE_BRAKE_TRANSITIONS, 'recordIntakeBrake', 'transition')
    requireEnum(input.outcome, INTAKE_BRAKE_OUTCOMES, 'recordIntakeBrake', 'outcome')
    const args = redact({
      checkout: input.checkout == null ? null : String(input.checkout),
      path: input.path == null ? null : String(input.path),
      transition: input.transition,
      // This actor is a caller-supplied claim, never an authenticated identity.
      actor: input.actor == null ? null : String(input.actor),
      outcome: input.outcome,
      detail: input.detail == null ? null : String(input.detail),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.checkout === undefined) args.checkout = 'redacted'
    if (args.path === undefined) args.path = 'redacted'
    if (args.checkout != null) args.checkout = args.checkout.slice(0, 1000)
    if (args.path != null) args.path = args.path.slice(0, 1000)
    if (args.actor === undefined) args.actor = 'redacted'
    if (args.actor != null) args.actor = args.actor.slice(0, 120)
    if (args.detail != null) args.detail = args.detail.slice(0, 500)
    appendJsonl('recordIntakeBrake', args)
    mirror((conn) => {
      const cols = tableColumnNames('intake_brakes').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO intake_brakes (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordIntakeDispatch(input = {}) {
    requireFields(input, ['board_owner', 'board_project', 'issue', 'outcome'], 'recordIntakeDispatch')
    requireEnum(input.outcome, INTAKE_DISPATCH_OUTCOMES, 'recordIntakeDispatch', 'outcome')
    if (input.premise_verdict != null) requireEnum(input.premise_verdict, PREMISE_VERDICTS, 'recordIntakeDispatch', 'premise_verdict')
    if (input.outcome === 'promoted' && input.pr_number == null) {
      refuse("recordIntakeDispatch: outcome 'promoted' requires pr_number")
    }
    const args = redact({
      board_owner: input.board_owner == null ? null : String(input.board_owner),
      board_project: input.board_project,
      issue: input.issue,
      sweep_at: input.sweep_at ?? null,
      outcome: input.outcome,
      reason: input.reason == null ? null : String(input.reason),
      tier: input.tier == null ? null : String(input.tier),
      task_slug: input.task_slug == null ? null : String(input.task_slug),
      board_item_id: input.board_item_id == null ? null : String(input.board_item_id),
      branch: input.branch == null ? null : String(input.branch),
      brief_path: input.brief_path == null ? null : String(input.brief_path),
      crew_dir: input.crew_dir == null ? null : String(input.crew_dir),
      task_return: input.task_return == null ? null : String(input.task_return),
      exit_code: input.exit_code ?? null,
      board_from: input.board_from == null ? null : String(input.board_from),
      board_to: input.board_to == null ? null : String(input.board_to),
      pr_number: input.pr_number ?? null,
      pr_url: input.pr_url == null ? null : String(input.pr_url),
      created_at: isoMs(input.created_at ?? now()),
      issue_body_digest: input.issue_body_digest == null ? null : String(input.issue_body_digest),
      premise_verdict: input.premise_verdict == null ? null : String(input.premise_verdict),
      premise_notes: input.premise_notes == null ? null : String(input.premise_notes),
    }, stats)
    if (args.board_owner != null) args.board_owner = args.board_owner.slice(0, 120)
    if (args.sweep_at != null) args.sweep_at = String(args.sweep_at).slice(0, 40)
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    if (args.tier != null) args.tier = args.tier.slice(0, 40)
    if (args.task_slug != null) args.task_slug = args.task_slug.slice(0, 200)
    if (args.board_item_id != null) args.board_item_id = args.board_item_id.slice(0, 200)
    if (args.branch != null) args.branch = args.branch.slice(0, 500)
    if (args.brief_path != null) args.brief_path = args.brief_path.slice(0, 1000)
    if (args.crew_dir != null) args.crew_dir = args.crew_dir.slice(0, 1000)
    if (args.task_return != null) args.task_return = args.task_return.slice(0, 1000)
    if (args.board_from != null) args.board_from = args.board_from.slice(0, 120)
    if (args.board_to != null) args.board_to = args.board_to.slice(0, 120)
    if (args.pr_url != null) args.pr_url = args.pr_url.slice(0, 1000)
    if (args.issue_body_digest != null) args.issue_body_digest = args.issue_body_digest.slice(0, 64)
    if (args.premise_verdict != null) args.premise_verdict = args.premise_verdict.slice(0, 40)
    if (args.premise_notes != null) args.premise_notes = args.premise_notes.slice(0, 500)
    appendJsonl('recordIntakeDispatch', args)
    mirror((conn) => {
      const cols = tableColumnNames('intake_dispatches').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO intake_dispatches (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordSeatTeardown(input = {}) {
    requireFields(input, ['adw_id', 'outcome'], 'recordSeatTeardown')
    requireEnum(input.outcome, SEAT_TEARDOWN_OUTCOMES, 'recordSeatTeardown', 'outcome')
    const args = redact({
      adw_id: input.adw_id,
      phase_id: input.phase_id ?? null,
      role: input.role ?? null,
      transport: input.transport ?? null,
      session_id: input.session_id ?? null,
      pgid: input.pgid ?? null,
      reservation_id: input.reservation_id ?? null,
      outcome: input.outcome,
      reason: (input.reason ?? input.why) == null ? null : String(input.reason ?? input.why),
      forced: input.forced ? 1 : 0,
      evidence_kind: input.evidence_kind ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    appendJsonl('recordSeatTeardown', args)
    mirror((conn) => {
      const cols = tableColumnNames('seat_teardowns').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO seat_teardowns (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordSeatReclaim(input = {}) {
    requireFields(input, ['adw_id', 'transport', 'seat_id', 'reservation_id', 'sweep_id', 'outcome', 'coverage_outcome'], 'recordSeatReclaim')
    requireEnum(input.outcome, SEAT_TEARDOWN_OUTCOMES, 'recordSeatReclaim', 'outcome')
    requireEnum(input.coverage_outcome, SEAT_TEARDOWN_OUTCOMES, 'recordSeatReclaim', 'coverage_outcome')
    if (input.coverage_outcome !== 'unproven') refuse("recordSeatReclaim: coverage_outcome must be 'unproven'")
    const args = redact({
      adw_id: input.adw_id,
      phase_id: Number(input.phase_id) || 0,
      transport: input.transport,
      seat_id: input.seat_id,
      reservation_id: input.reservation_id,
      sweep_id: input.sweep_id,
      role: input.role ?? null,
      owner_pid: Number(input.owner_pid) || 0,
      owner_liveness: input.owner_liveness ?? null,
      root_pid: Number(input.root_pid) || 0,
      root_pgid: Number(input.root_pgid) || 0,
      root_start: input.root_start ?? null,
      root_liveness: input.root_liveness ?? null,
      root_settled: input.root_settled ?? null,
      captures: Number(input.captures) || 0,
      missed_snapshots: Number(input.missed_snapshots) || 0,
      discovery_failures: Number(input.discovery_failures) || 0,
      captured: Number(input.captured) || 0,
      signalled: Number(input.signalled) || 0,
      reclaimed: Number(input.reclaimed) || 0,
      live: Number(input.live) || 0,
      identity_refused: Number(input.identity_refused) || 0,
      probe_unknown: Number(input.probe_unknown) || 0,
      outcome: input.outcome,
      reason: input.reason == null ? null : String(input.reason),
      coverage_outcome: input.coverage_outcome,
      coverage_reason: input.coverage_reason == null ? null : String(input.coverage_reason),
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    for (const key of ['adw_id', 'transport', 'seat_id', 'reservation_id', 'sweep_id']) {
      if (typeof args[key] !== 'string' || args[key].trim() === '') refuse(`recordSeatReclaim: invalid identity field '${key}'`)
    }
    if (args.reason != null) args.reason = args.reason.slice(0, 500)
    if (args.coverage_reason != null) args.coverage_reason = args.coverage_reason.slice(0, 500)
    appendJsonl('recordSeatReclaim', args)
    mirror((conn) => {
      const cols = tableColumnNames('seat_reclaims').filter((c) => c !== 'id')
      const sqlCols = cols.map(quoteSqlIdentifier)
      conn.prepare(`INSERT OR IGNORE INTO seat_reclaims (${sqlCols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => toBindable(args[c])))
    })
    return args
  }

  function recordModifierAttempt(input = {}) {
    requireFields(input, ['role', 'modifier', 'outcome'], 'recordModifierAttempt')
    requireEnum(input.modifier, MODIFIER_KINDS, 'recordModifierAttempt', 'modifier')
    requireEnum(input.outcome, MODIFIER_ATTEMPT_OUTCOMES, 'recordModifierAttempt', 'outcome')
    const args = redact({
      adw_id: input.adw_id ?? null,
      task_slug: input.task_slug ?? null,
      phase_id: input.phase_id ?? null,
      role: input.role,
      modifier: input.modifier,
      bounce: input.bounce == null ? null : String(input.bounce),
      outcome: input.outcome,
      why: input.why == null ? null : String(input.why),
      rung: input.rung == null ? null : String(input.rung),
      transport: input.transport ?? null,
      from_provider: input.from_provider ?? null,
      from_model_id: input.from_model_id ?? null,
      from_model: input.from_model ?? null,
      from_agent: input.from_agent ?? null,
      from_effort: input.from_effort ?? null,
      to_provider: input.to_provider ?? null,
      to_model_id: input.to_model_id ?? null,
      to_model: input.to_model ?? null,
      to_agent: input.to_agent ?? null,
      to_effort: input.to_effort ?? null,
      created_at: isoMs(input.created_at ?? now()),
    }, stats)
    if (args.why != null) args.why = args.why.slice(0, 500)
    if (args.bounce != null) args.bounce = args.bounce.slice(0, 120)
    if (args.rung != null) args.rung = args.rung.slice(0, 120)
    appendJsonl('recordModifierAttempt', args)
    mirror((conn) => {
      const cols = tableColumnNames('modifier_attempts').filter((c) => c !== 'id')
      conn.prepare(`INSERT OR IGNORE INTO modifier_attempts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
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
    requireEnum(input.target, ['process', 'agent_session', 'session'], 'heartbeat', 'target')
    if (input.target === 'process') {
      requireFields(input, ['pid', 'started_at'], 'heartbeat(process)')
    } else if (input.target === 'agent_session') {
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
      } else if (args.target === 'agent_session') {
        conn.prepare('UPDATE agent_sessions SET last_heartbeat_at = ? WHERE adw_id = ? AND claude_session_id = ?')
          .run(toBindable(args.at), toBindable(args.adw_id), toBindable(args.claude_session_id))
      } else {
        // The run row is the pane seat's only identity home: a pane seat has
        // no pid and no claude_session_id, and inventing one would fabricate
        // the very thing this column is supposed to measure.
        // ...and a finished run has no liveness left to observe: a beat racing
        // endSession would otherwise date a run's last heartbeat after its own
        // ended_at, which `ledger task <id>` prints as the run's liveness (#536/F12).
        conn.prepare('UPDATE sessions SET last_heartbeat_at = ? WHERE adw_id = ? AND ended_at IS NULL')
          .run(toBindable(args.at), toBindable(args.adw_id))
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
    // args is stored to JSONL in recordSourceError's OWN public-parameter
    // shape (not the events-table row shape) — replayJsonl dispatches
    // `ledger[kind](args)`, so args must be exactly what this method itself
    // accepts as input, already-normalized (a re-application on replay is
    // then a deterministic no-op: reason/violation_names are idempotent to
    // re-validate, seq is already resolved).
    const inserted = insertSequenced({
      jsonlKind: 'recordSourceError',
      adwId: input.adw_id,
      seqKind: 'event',
      explicitSeq: input.seq ?? undefined,
      build: (seq) => {
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
        return { args, row: eventRow }
      },
      insert: (conn, row) => {
        const cols = tableColumnNames('events').filter((c) => c !== 'id')
        return conn.prepare(`INSERT OR IGNORE INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => toBindable(row[c])))
      },
    })
    return inserted.args
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

  // adw_id -> the shape derived from that run's FIRST log row (or null).
  function variantsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    const out = new Map()
    for (let i = 0; i < ids.length; i += STAGE_MARKER_CHUNK) {
      const slice = ids.slice(i, i + STAGE_MARKER_CHUNK)
      const holes = slice.map(() => '?').join(',')
      const rows = queryRows(`
        SELECT e.adw_id, e.payload_json FROM events e
        JOIN (SELECT adw_id, MIN(id) AS first_id FROM events
              WHERE type = 'log' AND adw_id IN (${holes}) GROUP BY adw_id) f
          ON f.adw_id = e.adw_id AND e.id = f.first_id
      `, slice)
      for (const row of rows) {
        let message = null
        try { message = JSON.parse(row.payload_json)?.message ?? null } catch { /* an unparseable payload is no evidence */ }
        out.set(row.adw_id, variantFromFirstMessage(message))
      }
    }
    return out
  }

  // Which transports ran a run's seats, unioned across every table that
  // records one (TRANSPORT_TABLES). Shaped after variantsFor: dedupe, chunk,
  // return a Map. An absent entry means "no transport recorded", never "none
  // ran". The chunk is divided by the table count so the parameter count per
  // statement stays inside the same bound variantsFor respects.
  function transportsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    const chunk = Math.max(1, Math.floor(STAGE_MARKER_CHUNK / TRANSPORT_TABLES.length))
    const out = new Map()
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk)
      const holes = slice.map(() => '?').join(',')
      const sql = TRANSPORT_TABLES
        .map((table) => `SELECT adw_id, transport FROM ${table} WHERE transport IS NOT NULL AND adw_id IN (${holes})`)
        .join(' UNION ')
      const rows = queryRows(sql, TRANSPORT_TABLES.flatMap(() => slice))
      for (const row of rows) {
        if (!out.has(row.adw_id)) out.set(row.adw_id, new Set())
        out.get(row.adw_id).add(row.transport)
      }
    }
    return out
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
      noteMirrorError(err)
      return []
    }
  }

  function queryRows(sql, params = []) {
    const conn = ensureDb()
    if (!conn) return []
    try {
      return conn.prepare(sql).all(...params)
    } catch (err) {
      noteMirrorError(err)
      return []
    }
  }

  function tableNames() {
    return queryRows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)
  }

  function columnNames(table) {
    if (!Object.prototype.hasOwnProperty.call(TABLES, table)) {
      // Never embed the raw (caller-controlled) table name in the message —
      // list the closed set of valid names instead.
      refuse(`columnNames: unknown table — must be one of ${Object.keys(TABLES).join('|')}`)
    }
    return queryRows(`PRAGMA table_info(${table})`).map((row) => row.name)
  }

  function sessionsFiltered({ status, since, until } = {}) {
    const where = [], args = []
    if (status) { where.push('status = ?'); args.push(status) }
    if (since) { where.push('started_at >= ?'); args.push(since) }
    if (until) { where.push('started_at < ?'); args.push(until) }
    return queryRows(`SELECT * FROM sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC`, args)
  }

  function runsStartedWithin({ since, until = null } = {}) {
    return queryRows(`
      SELECT adw_id, task_slug, repo_slug, status, started_at, ended_at
      FROM sessions
      WHERE started_at >= ? AND (? IS NULL OR started_at < ?)
      ORDER BY started_at DESC, adw_id
    `, [since, until, until])
  }

  function phasesFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT * FROM phases WHERE adw_id IN (${marks}) ORDER BY adw_id, seq`, ids)
  }

  function runConfigurationsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT * FROM run_configurations WHERE adw_id IN (${marks})`, ids)
  }

  function runSeatsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT * FROM run_seats WHERE adw_id IN (${marks}) ORDER BY adw_id, role`, ids)
  }

  function agentEventsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT id, adw_id, type, phase_id, payload_json, started_at, ended_at FROM events WHERE adw_id IN (${marks}) AND type IN ('agent_start','agent_end') ORDER BY id`, ids)
  }

  function agentSessionsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT adw_id, dispatch_id, role, model, billed_input_tokens, billed_output_tokens, billed_cache_write_tokens, billed_cache_read_tokens FROM agent_sessions WHERE adw_id IN (${marks})`, ids)
  }

  function gateDiscriminationsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT adw_id, gate_generation, verdict, checks_total, checks_failed, checks_errored, note, created_at FROM gate_discriminations WHERE adw_id IN (${marks}) ORDER BY adw_id, gate_generation`, ids)
  }

  function gateResultsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT adw_id, phase_id, gate_name, attempt, ok, checks_json, gate_generation, pristine, created_at FROM gate_results WHERE adw_id IN (${marks}) ORDER BY adw_id, gate_generation, attempt`, ids)
  }

  function reviewOutcomesFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT adw_id, dispatch_id, role, verdict, must_fix, should_fix, consider, created_at FROM review_outcomes WHERE adw_id IN (${marks}) ORDER BY adw_id, created_at, id`, ids)
  }

  function acceptDecisionsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`SELECT adw_id, phase_id, where_at, outcome, findings_total, residual_count, refuted_count, cosmetic_count, unverified_count, invalid_reasons, created_at FROM accept_decisions WHERE adw_id IN (${marks}) ORDER BY adw_id, created_at, id`, ids)
  }

  function supportsJson1() {
    return queryRows(`SELECT json_extract('{"a":1}','$.a') AS value`).length > 0
  }

  function eventsPage({ adw_id, after = 0, limit = 200, type, phase_id, role } = {}) {
    const where = ['adw_id = ?', 'id > ?'], args = [adw_id, after]
    if (type != null) { where.push('type = ?'); args.push(type) }
    if (phase_id != null) { where.push('phase_id = ?'); args.push(phase_id) }
    if (role != null) { where.push("json_extract(payload_json,'$.role') = ?"); args.push(role) }
    return queryRows(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, [...args, limit])
  }

  function maxEventId(adwId) {
    const row = queryRows('SELECT max(id) AS max_id FROM events WHERE adw_id = ?', [adwId])[0] ?? null
    return row?.max_id == null ? null : Number(row.max_id)
  }

  // Rows are keyed by run, not by created_at: a seat's failure belongs to the
  // run that dispatched it however late the row landed. Same reasoning as
  // seatTeardownRowsFor.
  function cellFailureRowsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`
      SELECT adw_id, phase_id, dispatch_id, role, agent, provider, model_id, effort, transport, kind, stage, detail, created_at
      FROM cell_failures
      WHERE adw_id IN (${marks})
      ORDER BY adw_id, created_at, id
    `, ids)
  }

  // A row with no run, and a row naming a run this ledger does not register,
  // are both unattributable FACTS — never dropped, never reassigned.
  function unattributableCellFailures({ since, until = null } = {}) {
    return queryRows(`
      SELECT adw_id, phase_id, dispatch_id, role, agent, provider, model_id, effort, transport, kind, stage, detail, created_at
      FROM cell_failures
      WHERE created_at >= ? AND (? IS NULL OR created_at < ?)
        AND (adw_id IS NULL OR adw_id NOT IN (SELECT adw_id FROM sessions))
      ORDER BY created_at, id
    `, [since, until, until])
  }

  // Seat rows are deliberately not filtered by created_at: a teardown for
  // a run started in the window can land after until, and dropping it would
  // fabricate a not-measured run. The window note carries this semantics.
  function seatTeardownRowsFor(adwIds) {
    const ids = [...new Set((adwIds || []).filter(Boolean))]
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    return queryRows(`
      SELECT adw_id, phase_id, role, transport, outcome, reason, forced, evidence_kind, created_at
      FROM seat_teardowns
      WHERE adw_id IN (${marks})
      ORDER BY adw_id, role
    `, ids)
  }

  function intakePicks({ since, until = null } = {}) {
    return queryRows(`
      SELECT picked_issue, board_owner, board_project, created_at
      FROM intake_sweeps
      WHERE outcome = 'picked'
        AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC
      LIMIT 20
    `, [since, since, until, until])
  }

  function intakeSweepTotals() {
    return queryRows(`
      SELECT COUNT(*) AS sweeps, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM intake_sweeps
    `)[0] ?? null
  }

  // Latest recorded refusal per issue. SQLite's bare-column-with-MAX()
  // rule keeps the non-aggregated columns on the MAX(created_at) row.
  function intakeCandidateRefusals({ since, until = null } = {}) {
    return queryRows(`
      SELECT board_owner, board_project, issue, reason, detail, priority,
             issue_created_at, MAX(created_at) AS created_at, COUNT(*) AS refusals
      FROM intake_refusals
      WHERE issue IS NOT NULL
        AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY board_owner, board_project, issue
      ORDER BY issue
    `, [since, since, until, until])
  }

  function intakeCandidatePicks({ since, until = null } = {}) {
    return queryRows(`
      SELECT picked_issue AS issue, board_owner, board_project,
             MAX(created_at) AS created_at, COUNT(*) AS picks
      FROM intake_sweeps
      WHERE outcome = 'picked' AND picked_issue IS NOT NULL
        AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY picked_issue, board_owner, board_project
      ORDER BY picked_issue
    `, [since, since, until, until])
  }

  // Keep this in lockstep with crew/daemon.mjs:311-321: the daemon's
  // rolling burn query sums all four running token totals per session.
  function agentSessionTokenTotals({ since, until = null } = {}) {
    const untilClause = until == null ? '' : ' AND started_at < ?'
    const params = until == null ? [since] : [since, until]
    return queryRows(`
      SELECT COUNT(*) AS sessions,
             COALESCE(SUM(billed_input_tokens),0)       AS input,
             COALESCE(SUM(billed_output_tokens),0)      AS output,
             COALESCE(SUM(billed_cache_write_tokens),0) AS cache_write,
             COALESCE(SUM(billed_cache_read_tokens),0)  AS cache_read
      FROM agent_sessions WHERE started_at >= ?${untilClause}
    `, params)[0] ?? null
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

  function cellFailures({ since = null, until = null } = {}) {
    // Never joins `sessions`: a boot refusal has no run to join to, and joining
    // would silently drop exactly the rows this table exists to hold.
    return queryRows(`
      SELECT provider, model_id, agent, effort, role, kind,
        COUNT(*) AS failures, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
        SUM(CASE WHEN adw_id IS NULL THEN 1 ELSE 0 END) AS run_less,
        SUM(CASE WHEN attribution = 'host' AND adw_id IS NOT NULL THEN 1 ELSE 0 END) AS host_attributed
      FROM cell_failures
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY provider, model_id, agent, effort, role, kind
      ORDER BY provider, model_id, agent, effort, role, kind
    `, [since, since, until, until])
  }

  function cellReviews({ since = null, until = null } = {}) {
    // run_first_at is deliberately computed over the whole table rather than
    // the requested window: clipping earlier reviews must not promote a later
    // review to the run's first round.
    return queryRows(`
      WITH scoped AS (
        SELECT ro.*, (SELECT MIN(m.created_at) FROM review_outcomes m WHERE m.adw_id = ro.adw_id) AS run_first_at
        FROM review_outcomes ro
        WHERE (? IS NULL OR ro.created_at >= ?) AND (? IS NULL OR ro.created_at < ?)
      )
      SELECT scoped.provider, scoped.model_id,
        -- Guard this CASE: a roster-keyed cell must never split by model spelling,
        -- because crew/crew.mjs:933 sums over provider/model_id.
        CASE WHEN scoped.provider IS NULL AND scoped.model_id IS NULL THEN scoped.model ELSE NULL END AS model_key,
        scoped.agent, scoped.effort, scoped.role,
        s.tier AS task_class,
        COUNT(*) AS reviews,
        SUM(CASE WHEN scoped.created_at = scoped.run_first_at THEN 1 ELSE 0 END) AS first_round_reviews,
        SUM(CASE WHEN scoped.created_at = scoped.run_first_at AND scoped.verdict = 'pass' THEN 1 ELSE 0 END) AS first_round_passes,
        MIN(scoped.created_at) AS first_at, MAX(scoped.created_at) AS last_at,
        GROUP_CONCAT(DISTINCT scoped.transport) AS transports
      FROM scoped LEFT JOIN sessions s ON s.adw_id = scoped.adw_id
      GROUP BY scoped.provider, scoped.model_id, model_key, scoped.agent, scoped.effort, scoped.role, s.tier
      ORDER BY scoped.provider, scoped.model_id, model_key, scoped.agent, scoped.effort, scoped.role, s.tier
    `, [since, since, until, until])
  }

  function cellUsage({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT r.provider, r.model_id,
        CASE WHEN r.provider IS NULL AND r.model_id IS NULL THEN r.model ELSE NULL END AS model_key,
        r.agent, r.effort, r.role, sx.tier AS task_class,
        COUNT(*) AS usage_sessions,
        SUM(CASE WHEN a.billed_input_tokens IS NULL THEN 1 ELSE 0 END) AS unbilled_sessions,
        CASE WHEN COUNT(a.billed_input_tokens) = COUNT(*) THEN SUM(a.billed_input_tokens) ELSE NULL END AS billed_input_tokens,
        CASE WHEN COUNT(a.billed_output_tokens) = COUNT(*) THEN SUM(a.billed_output_tokens) ELSE NULL END AS billed_output_tokens,
        CASE WHEN COUNT(a.billed_cache_write_tokens) = COUNT(*) THEN SUM(a.billed_cache_write_tokens) ELSE NULL END AS billed_cache_write_tokens,
        CASE WHEN COUNT(a.billed_cache_read_tokens) = COUNT(*) THEN SUM(a.billed_cache_read_tokens) ELSE NULL END AS billed_cache_read_tokens
      FROM review_outcomes r
        JOIN agent_sessions a ON a.adw_id = r.adw_id AND a.dispatch_id = r.dispatch_id
        LEFT JOIN sessions sx ON sx.adw_id = r.adw_id
      WHERE (? IS NULL OR r.created_at >= ?) AND (? IS NULL OR r.created_at < ?)
      GROUP BY r.provider, r.model_id, model_key, r.agent, r.effort, r.role, sx.tier
    `, [since, since, until, until])
  }

  function modifierAttempts({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT modifier, outcome, role, transport,
        from_provider, from_model_id, from_agent, from_effort,
        COUNT(*) AS attempts,
        SUM(CASE WHEN outcome = 'applied' THEN 1 ELSE 0 END) AS applied,
        MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM modifier_attempts
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY modifier, outcome, role, transport,
        from_provider, from_model_id, from_agent, from_effort
      ORDER BY modifier, outcome, role, transport,
        from_provider, from_model_id, from_agent, from_effort
    `, [since, since, until, until])
  }

  function ciCycles({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT check_name, classification, cycle,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM ci_cycles
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY check_name, classification, cycle
      ORDER BY check_name, classification, cycle
    `, [since, since, until, until])
  }

  function ciDispatches({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT variant, outcome, cycle,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM ci_dispatches
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY variant, outcome, cycle
      ORDER BY variant, outcome, cycle
    `, [since, since, until, until])
  }

  function intakeSweeps({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT outcome, reason,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM intake_sweeps
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY outcome, reason
      ORDER BY outcome, reason
    `, [since, since, until, until])
  }

  function intakeRefusals({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT reason,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM intake_refusals
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY reason
      ORDER BY reason
    `, [since, since, until, until])
  }

  function intakeBrakes({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT transition, outcome,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM intake_brakes
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY transition, outcome
      ORDER BY transition, outcome
    `, [since, since, until, until])
  }

  function intakeDispatches({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT outcome, reason,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM intake_dispatches
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY outcome, reason
      ORDER BY outcome, reason
    `, [since, since, until, until])
  }

  // The most recent ADJUDICATED dispatches for one issue, newest first — the
  // breaker's evidence. Steps (claimed/promoted) and crew-less refusals are
  // excluded by INTAKE_DISPATCH_VERDICTS.
  function issueDispatchVerdicts({ board_owner, board_project, issue, limit = 2 } = {}) {
    const marks = INTAKE_DISPATCH_VERDICTS.map(() => '?').join(', ')
    return queryRows(`
      SELECT outcome, reason, task_slug, issue_body_digest, created_at
      FROM intake_dispatches
      WHERE board_owner = ? AND board_project = ? AND issue = ?
        AND outcome IN (${marks})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, [board_owner, board_project, issue, ...INTAKE_DISPATCH_VERDICTS, limit])
  }

  function seatTeardowns({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT outcome, reason,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM seat_teardowns
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY outcome, reason
      ORDER BY outcome, reason
    `, [since, since, until, until])
  }

  function escalations({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT terminal_reason AS cause, terminal_actor AS actor,
        COUNT(*) AS count, MIN(ended_at) AS first_at, MAX(ended_at) AS last_at
      FROM sessions
      WHERE outcome = 'escalated'
        AND (? IS NULL OR ended_at >= ?) AND (? IS NULL OR ended_at < ?)
      GROUP BY terminal_reason, terminal_actor
      ORDER BY terminal_reason, terminal_actor
    `, [since, since, until, until])
  }

  // The DENOMINATOR the escalations verb divides by: every session that ENDED in
  // the window, whatever its outcome. A window in which no run ended was never
  // measured; a window that ended runs and lost none of them is a measured zero
  // (#854). Same half-open [since, until) bound and same ended_at column as
  // escalations() above. The CLI calls escalationWindow() below so its numerator
  // and denominator share one SQLite statement/snapshot.
  function endedRuns({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT outcome, COUNT(*) AS count, MIN(ended_at) AS first_at, MAX(ended_at) AS last_at
      FROM sessions
      WHERE ended_at IS NOT NULL
        AND (? IS NULL OR ended_at >= ?) AND (? IS NULL OR ended_at < ?)
      GROUP BY outcome
      ORDER BY outcome
    `, [since, since, until, until])
  }

  // A session can end between two independent reads. Keep the detailed
  // escalation numerator and the all-ended denominator in ONE statement, so
  // this readout describes one SQLite snapshot rather than an interleaving.
  function escalationWindow({ since = null, until = null } = {}) {
    const snapshotRows = queryRows(`
      WITH window_sessions AS (
        SELECT outcome, terminal_reason, terminal_actor, ended_at
        FROM sessions
        WHERE ended_at IS NOT NULL
          AND (? IS NULL OR ended_at >= ?) AND (? IS NULL OR ended_at < ?)
      ),
      grouped_escalations AS (
        SELECT terminal_reason AS cause, terminal_actor AS actor,
          COUNT(*) AS count, MIN(ended_at) AS first_at, MAX(ended_at) AS last_at
        FROM window_sessions
        WHERE outcome = 'escalated'
        GROUP BY terminal_reason, terminal_actor
      ),
      grouped_ended_runs AS (
        SELECT outcome, COUNT(*) AS count, MIN(ended_at) AS first_at, MAX(ended_at) AS last_at
        FROM window_sessions
        GROUP BY outcome
      )
      SELECT 'escalation' AS row_kind, cause, actor, count, first_at, last_at, NULL AS outcome
      FROM grouped_escalations
      UNION ALL
      SELECT 'ended' AS row_kind, NULL AS cause, NULL AS actor, count, first_at, last_at, outcome
      FROM grouped_ended_runs
      ORDER BY row_kind DESC, cause, actor, outcome
    `, [since, since, until, until])
    const rows = []
    const endedRows = []
    for (const row of snapshotRows) {
      if (row.row_kind === 'escalation') {
        rows.push({ cause: row.cause, actor: row.actor, count: row.count, first_at: row.first_at, last_at: row.last_at })
      } else {
        endedRows.push({ outcome: row.outcome, count: row.count, first_at: row.first_at, last_at: row.last_at })
      }
    }
    return { rows, endedRows }
  }

  function seatReclaims({ since = null, until = null } = {}) {
    return queryRows(`
      SELECT outcome, reason, coverage_outcome, coverage_reason,
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM seat_reclaims
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY outcome, reason, coverage_outcome, coverage_reason
      ORDER BY outcome, reason, coverage_outcome, coverage_reason
    `, [since, since, until, until])
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

  // A run-set is a VIEW, never a stored batch: the ledger has no group column,
  // so the set is delimited by the window [since, until) over sessions.started_at
  function runSet({ since, until = null } = {}) {
    const agentSessionsPresent = () => queryRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ['agent_sessions']).length > 0
    const untilClause = until == null ? '' : ' AND s.started_at < ?'
    const params = until == null ? [since] : [since, until]
    const usageSelect = agentSessionsPresent()
      ? `(SELECT COUNT(*) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS agent_sessions,
         (SELECT SUM(a.billed_input_tokens) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_input_tokens,
         (SELECT SUM(a.billed_output_tokens) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_output_tokens,
         (SELECT SUM(a.billed_cache_write_tokens) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_cache_write_tokens,
         (SELECT SUM(a.billed_cache_read_tokens) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_cache_read_tokens`
      : `0 AS agent_sessions,
         NULL AS billed_input_tokens,
         NULL AS billed_output_tokens,
         NULL AS billed_cache_write_tokens,
         NULL AS billed_cache_read_tokens`
    const rows = queryRows(`
      SELECT s.adw_id, s.task_slug, s.repo_slug, s.status, s.started_at, s.ended_at, ${usageSelect}
      FROM sessions s
      WHERE s.started_at >= ?${untilClause}
      ORDER BY s.started_at, s.adw_id
    `, params)
    const variants = variantsFor(rows.map((row) => row.adw_id))
    return rows.map((row) => ({ ...row, variant: variants.get(row.adw_id) ?? null }))
  }

  function taskReadout(selector) {
    // Resolve an adw_id before a linked run_id, and a linked run_id before
    // trying task_slug; a slug match is only usable when it names exactly one
    // run, so an ambiguity can be refused upstream.
    const byId = queryRows('SELECT adw_id FROM sessions WHERE adw_id = ?', [selector])
    const runLinks = byId.length === 1
      ? []
      : queryRows(`
        SELECT DISTINCT adw_id FROM run_links
        WHERE run_id = ? AND adw_id IN (SELECT adw_id FROM sessions)
        ORDER BY adw_id
      `, [selector]).map((row) => row.adw_id)
    const slugMatches = byId.length === 1 || runLinks.length > 0
      ? []
      : queryRows('SELECT adw_id FROM sessions WHERE task_slug = ? ORDER BY adw_id', [selector])
        .map((row) => row.adw_id)
    const ambiguousCandidates = runLinks.length > 1
      ? runLinks
      : (slugMatches.length > 1 ? slugMatches : [])
    const unresolved = (candidates = []) => ({
      degraded,
      adw_id: null,
      resolved_by: null,
      candidates,
      session: null,
      phases: [],
      gate_generations: [],
      review_outcomes: [],
      accept_decisions: [],
      usage: null,
      variant: null,
      run_ids: [],
      absent: {},
    })

    if (byId.length !== 1 && runLinks.length !== 1 && slugMatches.length !== 1) {
      return unresolved(ambiguousCandidates)
    }

    const adwId = byId.length === 1 ? byId[0].adw_id : (runLinks.length === 1 ? runLinks[0] : slugMatches[0])
    const resolvedBy = byId.length === 1 ? 'adw_id' : (runLinks.length === 1 ? 'run_id' : 'task_slug')
    const runIds = queryRows('SELECT DISTINCT run_id FROM run_links WHERE adw_id = ? ORDER BY run_id', [adwId])
      .map((row) => row.run_id)
    const session = queryRows('SELECT * FROM sessions WHERE adw_id = ?', [adwId])[0] ?? null
    const phases = queryRows('SELECT * FROM phases WHERE adw_id = ? ORDER BY seq', [adwId])
    const variant = variantsFor([adwId]).get(adwId) ?? null
    const gateRows = queryRows(`
      SELECT g.gate_generation,
        COUNT(*) AS attempts,
        SUM(g.ok = 1 AND COALESCE(g.pristine, 0) = 0) AS green,
        SUM(COALESCE(g.pristine, 0) = 1) AS pristine_runs,
        MAX(g.created_at) AS last_created_at,
        d.id AS discrimination_id,
        d.verdict AS discrimination_verdict,
        d.checks_total AS discrimination_checks_total,
        d.checks_failed AS discrimination_checks_failed,
        d.checks_errored AS discrimination_checks_errored
      FROM gate_results g
      LEFT JOIN gate_discriminations d
        ON d.adw_id = g.adw_id AND d.gate_generation = g.gate_generation
      WHERE g.adw_id = ?
      GROUP BY g.gate_generation
      ORDER BY g.gate_generation
    `, [adwId])
    const gateGenerations = gateRows.map((row) => ({
      gate_generation: row.gate_generation,
      attempts: row.attempts,
      green: row.green,
      pristine_runs: row.pristine_runs,
      last_created_at: row.last_created_at,
      discrimination: row.discrimination_id == null ? null : {
        verdict: row.discrimination_verdict,
        checks_total: row.discrimination_checks_total,
        checks_failed: row.discrimination_checks_failed,
        checks_errored: row.discrimination_checks_errored,
      },
    }))
    const reviewOutcomes = queryRows(`
      SELECT dispatch_id, role, verdict, must_fix, should_fix, consider, created_at
      FROM review_outcomes WHERE adw_id = ? ORDER BY created_at, id
    `, [adwId])
    const acceptDecisions = queryRows(`
      SELECT where_at, outcome, findings_total, residual_count, refuted_count,
        cosmetic_count, unverified_count, invalid_reasons, created_at
      FROM accept_decisions WHERE adw_id = ? ORDER BY created_at, id
    `, [adwId])
    // Each row holds a running total, not a delta (`endAgentSession` overwrites, :1129) — a MAX or a last-row read silently misreports.
    const usageRow = queryRows(`
      SELECT COUNT(*) AS agent_sessions,
        SUM(context_tokens IS NOT NULL) AS measured_context_tokens,
        SUM(billed_input_tokens) AS billed_input_tokens,
        SUM(billed_output_tokens) AS billed_output_tokens,
        SUM(billed_cache_write_tokens) AS billed_cache_write_tokens,
        SUM(billed_cache_read_tokens) AS billed_cache_read_tokens
      FROM agent_sessions WHERE adw_id = ?
    `, [adwId])[0] ?? null
    const agentSessions = usageRow == null ? 0 : Number(usageRow.agent_sessions)
    const billedKeys = [
      'billed_input_tokens', 'billed_output_tokens',
      'billed_cache_write_tokens', 'billed_cache_read_tokens',
    ]
    const everyBilledSumNull = usageRow == null || billedKeys.every((key) => usageRow[key] == null)
    const measuredContextOccupancy = usageRow != null && Number(usageRow.measured_context_tokens ?? 0) > 0
    const usage = agentSessions === 0 ? null : {
      agent_sessions: agentSessions,
      billed_input_tokens: usageRow.billed_input_tokens,
      billed_output_tokens: usageRow.billed_output_tokens,
      billed_cache_write_tokens: usageRow.billed_cache_write_tokens,
      billed_cache_read_tokens: usageRow.billed_cache_read_tokens,
    }
    const discriminationCount = queryRows(
      'SELECT COUNT(*) AS count FROM gate_discriminations WHERE adw_id = ?', [adwId],
    )[0]?.count ?? 0
    const reviewCount = queryRows(
      'SELECT COUNT(*) AS count FROM review_outcomes WHERE adw_id = ?', [adwId],
    )[0]?.count ?? 0
    const acceptDecisionCount = queryRows(
      'SELECT COUNT(*) AS count FROM accept_decisions WHERE adw_id = ?', [adwId],
    )[0]?.count ?? 0
    const absent = {}
    if (session?.request == null) {
      absent.request = 'this run predates request recording (#b19) / was not dispatched by the intake loop; the request was never measured, and NULL is never an empty ask'
    }
    if (session != null && session.outcome == null) {
      absent.outcome = 'this run predates typed run outcomes (#779) — sessions.status carries the legacy verdict alone; NULL is never a measured outcome, and no historical row is backfilled by inference'
    }
    if (!measuredContextOccupancy) {
      absent.context_occupancy = 'no live transport records occupancy — pane seats land no agent_sessions row at all; headless-json/headless-rpc land rows with both columns NULL; context_window has no verified source (U-4); see docs/ledger-queries.md'
    }
    if (agentSessions === 0 || everyBilledSumNull) {
      const taskTransports = transportsFor([adwId]).get(adwId) ?? []
      absent.usage = agentSessions === 0
        ? `this run has no agent_sessions rows: ${usageAbsentCause(taskTransports)}`
        : `this run's usage is absent: ${USAGE_ABSENT_CAUSES.unbilled_rows}`
    }
    if (Number(discriminationCount) === 0) {
      absent.gate_discrimination = 'predates gate discrimination (#168)'
    }
    if (Number(reviewCount) === 0) {
      absent.review_outcomes = 'predates structured review outcomes (#169/#170)'
    }
    if (Number(acceptDecisionCount) === 0) {
      absent.accept_decisions = 'predates typed accept decisions (#170)'
    }
    if (gateGenerations.length === 0) {
      absent.gate_results = 'predates gate verdict recording (#130)'
    }
    if (phases.length === 0) {
      absent.phases = 'no phase rows recorded for this run'
    }
    if (variant === null) {
      absent.variant = "this run's first recorded event is not a shape marker — the run shape is unmeasured (#251), never a measured \"full\""
    }
    if (resolvedBy === 'run_id' && runIds.length > 1) {
      absent.run_scope = 'this ledger session is shared by more than one daemon run (an adopted sidecar) — its usage is the session total, not this run alone'
    }

    return {
      degraded,
      adw_id: adwId,
      resolved_by: resolvedBy,
      candidates: [],
      session,
      run_ids: runIds,
      phases,
      gate_generations: gateGenerations,
      review_outcomes: reviewOutcomes,
      accept_decisions: acceptDecisions,
      usage,
      variant,
      absent,
    }
  }

  // Read-only drift check. The JSONL is the authority and the table is a
  // best-effort mirror (see mirror() above), so for each writer we count the
  // DISTINCT unique keys its JSONL lines carry and ask how many of those keys
  // are present as rows. A repeat key is an UPSERT, not drift — the mirror
  // inserts OR IGNORE on exactly that key — so counting raw lines would report
  // every legitimate update as a lost row. Repairs nothing: replayJsonl is the
  // deliberate remedy.
  function jsonlDrift() {
    const conn = ensureDb()
    if (!conn) {
      return unmeasuredDrift(jsonlPath, `the mirror could not be opened: ${stats.degraded_reason ?? 'degraded'}`)
    }
    // POSIX lets a handle keep reading an unlinked inode. This handle can no
    // longer measure the mirror an operator would rebuild, and a reader that
    // cannot know must not report clean (#536/F9).
    if (!existsSync(dbPath)) {
      noteDegraded(MIRROR_MISSING_MESSAGE, MIRROR_MISSING_CODE)
      return unmeasuredDrift(jsonlPath, MIRROR_MISSING_MESSAGE)
    }
    let text
    try {
      text = readFileSync(jsonlPath, 'utf8')
    } catch (err) {
      // An old file with an unenforced key is still an answerable mirror even
      // before its first authority line is written; there are no authority
      // keys to compare yet, so report a measured zero rather than masking the
      // migration condition as a failed open (#716/F6).
      if (stats.unenforced_unique_indexes.length > 0 && err?.code === 'ENOENT') {
        text = ''
      } else {
        return unmeasuredDrift(jsonlPath, `the JSONL authority could not be read: ${(err && (err.code || err.name)) || 'ReadError'}`)
      }
    }
    let lines = 0
    let unparsed = 0
    let unknownKind = 0
    const perWriter = new Map()
    const groups = new Map()
    for (const raw of text.split('\n')) {
      if (!raw) continue
      lines += 1
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        unparsed += 1
        continue
      }
      const kind = parsed && parsed.kind
      const table = typeof kind === 'string' && Object.hasOwn(WRITER_MIRROR_TABLES, kind) ? WRITER_MIRROR_TABLES[kind] : null
      if (!table) {
        // An update-only writer adds no row; anything else is a line this
        // check could not attribute at all.
        if (!UPDATE_ONLY_WRITERS.includes(kind)) unknownKind += 1
        continue
      }
      const cols = TABLES[table].unique[0]
      if (!perWriter.has(kind)) perWriter.set(kind, { table, cols, keys: new Set(), lines: 0, groups: new Set() })
      const info = perWriter.get(kind)
      const key = driftKey(cols, parsed.args)
      info.keys.add(key)
      info.lines += 1
      const groupKey = `${table}\u0000${key}`
      if (!groups.has(groupKey)) groups.set(groupKey, { contents: new Set(), writers: new Set() })
      const group = groups.get(groupKey)
      group.contents.add(`${kind}\u0000${stableJson(parsed.args)}`)
      group.writers.add(kind)
      info.groups.add(groupKey)
    }
    let collapsedLines = 0
    for (const group of groups.values()) {
      const { contents } = group
      if (contents.size < 2) continue
      collapsedLines += contents.size - 1
    }
    const collapsedKeysFor = (info) => {
      let count = 0
      for (const groupKey of info.groups) {
        if (groups.get(groupKey)?.contents.size > 1) count += 1
      }
      return count
    }
    const rowKeysByTable = new Map()
    const writers = []
    for (const kind of WRITERS) {
      const info = perWriter.get(kind)
      if (!info) continue
      const collapsedKeys = collapsedKeysFor(info)
      if (!rowKeysByTable.has(info.table)) {
        let rowKeys = null
        try {
          const selection = info.cols.flatMap((c) => [
            quoteSqlIdentifier(c),
            `typeof(${quoteSqlIdentifier(c)}) AS ${quoteSqlIdentifier(`${DRIFT_TYPE_PREFIX}${c}`)}`,
          ]).join(', ')
          const rows = conn.prepare(`SELECT ${selection} FROM ${quoteSqlIdentifier(info.table)}`).all()
          rowKeys = new Set(rows.map((row) => driftRowKey(info.cols, row)))
        } catch {
          // An unreadable table is unmeasured, never zero drift.
          rowKeys = null
        }
        rowKeysByTable.set(info.table, rowKeys)
      }
      const rowSet = rowKeysByTable.get(info.table)
      if (!rowSet) {
        writers.push({ writer: kind, table: info.table, unique_key: [...info.cols], lines: info.lines, distinct_keys: info.keys.size, rows_present: null, drift: null, collapsed_keys: collapsedKeys })
        continue
      }
      let present = 0
      for (const key of info.keys) {
        if (rowSet.has(key)) present += 1
      }
      writers.push({ writer: kind, table: info.table, unique_key: [...info.cols], lines: info.lines, distinct_keys: info.keys.size, rows_present: present, drift: info.keys.size - present, collapsed_keys: collapsedKeys })
    }
    const unreadableTables = writers.filter((w) => w.drift === null).map((w) => w.table)
    const measured = unparsed === 0 && unknownKind === 0 && unreadableTables.length === 0
    const causes = []
    if (unparsed > 0) causes.push(`${unparsed} unparsable JSONL line(s)`)
    if (unknownKind > 0) causes.push(`${unknownKind} JSONL line(s) whose kind is outside WRITERS`)
    if (unreadableTables.length > 0) causes.push(`unreadable table(s): ${[...new Set(unreadableTables)].join(', ')}`)
    const driftTotal = measured ? writers.reduce((n, w) => n + w.drift, 0) : null
    return {
      measured,
      unmeasured_reason: measured ? null : causes.join('; '),
      jsonl_path: jsonlPath,
      lines,
      unparsed_lines: unparsed,
      unknown_kind_lines: unknownKind,
      writers,
      drift_total: driftTotal,
      remedy: driftTotal > 0 ? DRIFT_REMEDY : null,
      collapsed_lines_total: measured ? collapsedLines : null,
      collapse_remedy: collapsedLines > 0 ? DRIFT_COLLAPSE_REMEDY : null,
    }
  }

  // ---- lifecycle / meta -----------------------------------------------------

  function statsFn() {
    const snapshot = { degraded, ...stats }
    // Keep the opener lazy for existing stats consumers, but make the new
    // migration-health field authoritative when it is read: a caller asking
    // for the field must observe a UNIQUE index skipped during open, even if
    // no prior query forced ensureDb() yet (#716/F6).
    Object.defineProperty(snapshot, 'unenforced_unique_indexes', {
      enumerable: true,
      get() {
        ensureDb()
        snapshot.degraded = degraded
        snapshot.degraded_reason = stats.degraded_reason
        snapshot.degraded_message = stats.degraded_message
        return [...stats.unenforced_unique_indexes]
      },
    })
    return snapshot
  }

  function readConnection() {
    if (!readOnly) refuse('readConnection is available only on a read-only handle')
    return ensureDb()
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
    startSession, endSession, recordSessionRequest, recordRunConfiguration, recordRunSeat, startPhase, endPhase, recordEvent, recordEnvelope,
    recordGateResult, recordGateDiscrimination, recordReviewOutcome, recordAcceptDecision, recordCellFailure, recordModifierAttempt, recordCiCycle, recordCiDispatch, recordIntakeSweep, recordIntakeRefusal, recordIntakeBrake, recordIntakeDispatch, recordSeatTeardown, recordSeatReclaim,
    startProcess, endProcess, heartbeat, startAgentSession, endAgentSession,
    recordSourceError, linkRun,
    listSessions, listEvents, getSession, dumpTable, tableNames, columnNames, sessionsFiltered, runsStartedWithin, phasesFor, runConfigurationsFor, runSeatsFor, agentEventsFor, agentSessionsFor, gateDiscriminationsFor, gateResultsFor, reviewOutcomesFor, acceptDecisionsFor, supportsJson1, eventsPage, maxEventId, cellFailureRowsFor, unattributableCellFailures, seatTeardownRowsFor, intakePicks, intakeSweepTotals, intakeCandidateRefusals, intakeCandidatePicks, agentSessionTokenTotals, gateReviewGap, cellFailures, cellReviews, cellUsage, modifierAttempts, ciCycles, ciDispatches, intakeSweeps, intakeRefusals, intakeBrakes, intakeDispatches, issueDispatchVerdicts, seatTeardowns, escalations, endedRuns, escalationWindow, seatReclaims, eligibleTasks, runSet, transportsFor, taskReadout, jsonlDrift,
    stats: statsFn,
    captureMirrorErrors,
    readConnection,
    close,
    installFinalizer: installFinalizerOn,
    // internal, used by the doctor CLI verb and tests only:
    _dbPath: dbPath,
    _jsonlPath: jsonlPath,
    _setReplaying(value) { const was = replaying; replaying = !!value; return was },
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
  let failed = 0
  let firstFailure = null
  if (!existsSync(jsonlPath)) {
    return { applied, skipped, failed, complete: failed === 0 && skipped === 0, first_failure: firstFailure }
  }
  const content = readFileSync(jsonlPath, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  let lineNo = 0
  function noteReplayFailure(lineNo, err) {
    failed += 1
    if (firstFailure === null) {
      firstFailure = {
        line: lineNo,
        reason: err instanceof LedgerUsageError ? err.message : (err?.name || 'Error'),
      }
    }
  }
  const restore = typeof ledger._setReplaying === 'function'
    ? ledger._setReplaying(true)
    : null
  try {
    for (const line of lines) {
      lineNo += 1
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
        noteReplayFailure(lineNo, new LedgerUsageError(`ledger: replayJsonl: line has an unknown kind — must be one of ${WRITERS.join('|')}`))
        continue
      }
      try {
        ledger[parsed.kind](parsed.args)
        applied += 1
      } catch (err) {
        noteReplayFailure(lineNo, err)
      }
    }
  } finally {
    if (restore !== null) ledger._setReplaying(restore)
  }
  return { applied, skipped, failed, complete: failed === 0 && skipped === 0, first_failure: firstFailure }
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
        ledger.endSession({ adw_id: adwId, status: 'fail', outcome: 'failed', terminal_reason: sig, terminal_actor: 'finalizer' })
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
// The RUNTIME half of the ledger sandbox (#821). test/factory-env.test.mjs is
// the static half and stays exactly as it is — it is the second line, and it
// cannot read a CLI a test SPAWNS, which is how b346 landed 21 fixture runs in
// the operator's ledger while shipping green. NODE_TEST_CONTEXT is set by
// `node --test` and INHERITS into every child, so the refusal reaches the
// child the scan never sees. It is a THROW, never a silent redirect to a temp
// dir: a test that means to write a ledger must say where.
// ---------------------------------------------------------------------------

export function homeDefaultDbPath() {
  return join(homedir(), '.dev-team', 'factory', 'ledger.db')
}

function underTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT)
}

function refuseHomeLedgerUnderTest(where) {
  refuse(`${where}: refusing the home ledger at ${homeDefaultDbPath()} from a process under node --test — set DEVTEAM_LEDGER_DB to a temporary path in this process's own environment, or pass an explicit stateDir/dbPath; scripts/factory/ledger.mjs owns this refusal`, 'home_ledger_under_test')
}

export function defaultDbPath() {
  if (process.env.DEVTEAM_LEDGER_DB) return process.env.DEVTEAM_LEDGER_DB
  const dir = process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  const path = join(dir, 'ledger.db')
  if (underTest() && path === homeDefaultDbPath()) refuseHomeLedgerUnderTest('defaultDbPath')
  return path
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

// Every flag each verb accepts. A flag absent from its verb's set is REFUSED
// (exit 2) rather than ignored: measured on 2026-08-21, `run-set --since X
// --untill Y` answered `until: null, runs: 1978` at exit 0 while the same
// window spelled `--until` answered 0 — a one-letter typo silently unbounded
// the window (#443). Every verb main dispatches is listed here; an absent
// entry is only reachable for an unknown VERB, which :3770 already refuses.
const VERB_FLAGS = Object.freeze({
  sessions: new Set([]),
  phases: new Set([]),
  procs: new Set([]),
  tail: new Set(['after', 'limit']),
  'gate-review-gap': new Set([]),
  'eligible-tasks': new Set([]),
  'run-set': new Set(['since', 'until']),
  'cell-failures': new Set(['since', 'until']),
  cells: new Set(['since', 'until', 'prices']),
  'modifier-attempts': new Set(['since', 'until']),
  'seat-teardowns': new Set(['since', 'until']),
  escalations: new Set(['since', 'until']),
  'ci-cycles': new Set(['since', 'until']),
  'intake-sweeps': new Set(['since', 'until']),
  task: new Set([]),
  request: new Set(['from-brief']),
  'advisor-ab': new Set(['run-dir', 'run-started-at', 'adjudications']),
  doctor: new Set([]),
  kill: new Set(['adw-id', 'pid', 'yes']),
})

// parseArgs collects every `--name` it sees; this is the one place that decides
// whether the verb knows it. A misspelled flag is a usage refusal (exit 2), not
// a default.
function refuseUnknownFlags(verb, flags) {
  const accepted = VERB_FLAGS[verb]
  if (!accepted) return
  for (const name of Object.keys(flags)) {
    if (accepted.has(name)) continue
    const vocabulary = accepted.size === 0
      ? 'it accepts no flags'
      : `it accepts ${[...accepted].map((f) => `--${f}`).join(', ')}`
    refuse(`${verb}: unknown flag --${name} — ${vocabulary}`)
  }
}

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

// isoMs() only accepts an already-ms-ISO string (:394); a human types
// `--since 2026-08-15T00:00:00Z`. Parse first, then normalise, so a bad
// timestamp is a refusal (exit 2) and not an internal stack trace (exit 1).
function windowBound(value, flagName, verb = 'run-set') {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    refuse(`${verb}: --${flagName} must be an ISO-8601 timestamp, e.g. 2026-08-15T00:00:00Z`)
  }
  return isoMs(ms)
}

// The two shipped adapters' roster-cell translations, keyed by the seat's own
// `agent` — the same map crew/seat-io.mjs:848 keys, imported rather than
// mirrored so the openai→openai-codex namespace lives on ONE surface
// (crew/adapters/adapter-pi.mjs:91).
const CELL_MODEL_TRANSLATORS = Object.freeze({ claude: claudeModelString, pi: piModelString })

// Map a recorded `model` string back to a provider/id price-catalog key, the
// way crew/crew.mjs:776 (bandForRaw) resolves a raw override: translate every
// catalog key FORWARD through the adapter the review says ran it, and accept
// only a UNIQUE match. It ASSUMES the recorded `agent` is the adapter that
// produced the string. A prefix is never stripped and a provider is never
// guessed: an unmatched or ambiguous string is unmapped, and an unmapped cell
// is unpriced — never another model's price.
export function priceKeyForModel(catalog, model, agent) {
  const translate = CELL_MODEL_TRANSLATORS[agent]
  if (typeof translate !== 'function' || model == null || !catalog?.models) return null
  const matches = []
  for (const key of Object.keys(catalog.models)) {
    const slash = key.indexOf('/')
    if (slash < 0) continue
    let candidate
    try { candidate = translate({ provider: key.slice(0, slash), id: key.slice(slash + 1) }) } catch { continue }
    if (candidate === model) matches.push(key)
  }
  return matches.length === 1 ? matches[0] : null
}

function catalogPrice(catalog, key) {
  if (!catalog) return null
  const entry = catalog.models && Object.prototype.hasOwnProperty.call(catalog.models, key) ? catalog.models[key] : null
  return entry ?? null
}

function loadPriceCatalog(path) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)
    || !catalog.models || typeof catalog.models !== 'object' || Array.isArray(catalog.models)
    || Object.getPrototypeOf(catalog.models) !== Object.prototype) {
    throw new Error('price catalog models must be a plain object')
  }
  return catalog
}

function requestFromBrief(path) {
  if (typeof path !== 'string' || !path.trim()) {
    refuse('request: --from-brief <path> is required')
  }
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    refuse('request: --from-brief brief file is missing or unreadable')
  }
  const lines = String(source).split(/\r?\n/)
  const heading = lines.findIndex((line) => line.trim() === '## The ask')
  if (heading < 0) {
    refuse('request: brief has no ## The ask section')
  }
  const paragraph = []
  let started = false
  for (const line of lines.slice(heading + 1)) {
    const trimmed = line.trim()
    if (/^#{1,6}\s/.test(trimmed)) break
    if (!trimmed) {
      if (started) break
      continue
    }
    started = true
    paragraph.push(trimmed)
  }
  if (paragraph.length === 0) {
    refuse('request: ## The ask section is blank')
  }
  return paragraph.join('\n').trim()
}

const DISPATCH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const FINDING_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const NOTE_REF_RE = /^n[1-9][0-9]{0,3}$/

// Epoch ms from either an integer-ish value or an ISO-8601 string; null when
// the value is not a time at all. Mirrors advisor.ts's epochMilliseconds
// deliberately rather than importing it: crew/pi/extensions/ is another
// module's surface and a factory script never depends on it.
function advisorAbEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

// `|` is the key separator, so both id shapes above exclude it.
const advisorAbKey = (epoch, dispatchId, findingId) => `${epoch}|${dispatchId}|${findingId}`

// An incomplete entry for a malformed adjudication has to name the FINDING it
// concerns and not just its dispatch: two malformed adjudications for different
// findings inside ONE dispatch are otherwise the same string, and the operator
// cannot tell which one to go repair (#391). An id is echoed only when it is a
// usable finding id; anything else — absent, non-string, or outside
// FINDING_ID_RE — renders as `<none>`, which no usable id can ever be, since
// FINDING_ID_RE excludes `<` and `>`.
const advisorAbFindingLabel = (findingId) =>
  typeof findingId === 'string' && FINDING_ID_RE.test(findingId) ? findingId : '<none>'

export function advisorAbNotes(journalText, epoch) {
  const refs = new Map()
  const attested = new Set()
  const summary = {
    total: 0,
    injected: 0,
    by_tier: { tier0: 0, tier1: 0, other: 0 },
    injected_by_tier: { tier0: 0, tier1: 0, other: 0 },
    tier0_share: null,
    tier1_share: null,
  }
  let noteOrdinal = 0
  const lines = typeof journalText === 'string' ? journalText.split(/\r?\n/) : []
  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue

    const attestedAt = advisorAbEpoch(entry.at)
    if (epoch !== null && typeof entry.envelope === 'string' && entry.role === 'reviewer' && attestedAt !== null && attestedAt >= epoch) {
      attested.add(entry.envelope)
    }

    const payload = entry.advisor_note
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    if (advisorAbEpoch(payload.run_started_at) !== epoch) continue
    const row = payload
    const ref = `n${++noteOrdinal}`
    refs.set(ref, payload)
    summary.total += 1
    const tier = row.tier === 0 ? 'tier0' : row.tier === 1 ? 'tier1' : 'other'
    summary.by_tier[tier] += 1
    if (row.outcome === 'injected') {
      summary.injected += 1
      summary.injected_by_tier[tier] += 1
    }
  }
  if (summary.injected > 0) {
    summary.tier0_share = summary.injected_by_tier.tier0 / summary.injected
    summary.tier1_share = summary.injected_by_tier.tier1 / summary.injected
  }
  return { refs, attested, summary }
}

export function advisorAbReadout({ epoch, dispatchIds, journalText, envelopeSources, adjudications } = {}) {
  const ids = Array.isArray(dispatchIds) ? [...dispatchIds] : []
  const sources = envelopeSources && typeof envelopeSources === 'object' ? envelopeSources : Object.create(null)
  const notes = advisorAbNotes(journalText, epoch)
  const incomplete = []
  const malformed = []
  const duplicateKeys = []
  const findings = []
  const findingsByKey = new Map()
  const selected = new Set(ids)
  const adjudicated = new Map()
  const overlapKeys = new Set()
  const unadjudicated = []
  let skipped = 0

  const addIncomplete = (reason, detail) => {
    incomplete.push({ reason, detail })
  }

  for (const dispatchId of ids) {
    const source = Object.prototype.hasOwnProperty.call(sources, dispatchId) ? sources[dispatchId] : undefined
    if (!source || source.status === 'missing') {
      addIncomplete('envelope-missing', `dispatch ${dispatchId}`)
      continue
    }
    if (source.status === 'unreadable' || source.status !== 'ok') {
      addIncomplete('envelope-unreadable', `dispatch ${dispatchId}`)
      continue
    }
    const envelope = source.envelope
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      addIncomplete('envelope-unreadable', `dispatch ${dispatchId}`)
      continue
    }
    let barred = false
    if (envelope.role !== undefined && envelope.role !== 'reviewer') {
      addIncomplete('envelope-role-mismatch', `dispatch ${dispatchId}`)
      barred = true
    }
    if (envelope.assignment_id !== undefined && envelope.assignment_id !== dispatchId) {
      addIncomplete('dispatch-id-mismatch', `dispatch ${dispatchId}`)
      barred = true
    }
    if (!notes.attested.has(dispatchId)) {
      addIncomplete('dispatch-not-attested', `dispatch ${dispatchId}`)
      barred = true
    }
    if (barred) continue
    const rawFindings = envelope.details && typeof envelope.details === 'object' && !Array.isArray(envelope.details)
      ? envelope.details.findings
      : undefined
    if (!Array.isArray(rawFindings)) {
      addIncomplete('findings-absent', `dispatch ${dispatchId}`)
      continue
    }
    for (const [index, finding] of rawFindings.entries()) {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding) || typeof finding.id !== 'string' || !FINDING_ID_RE.test(finding.id) || !['must-fix', 'should-fix', 'consider'].includes(finding.severity)) {
        malformed.push({ dispatch_id: dispatchId, index })
        continue
      }
      const key = advisorAbKey(epoch, dispatchId, finding.id)
      if (findingsByKey.has(key)) {
        duplicateKeys.push(key)
        continue
      }
      const row = {
        key,
        dispatch_id: dispatchId,
        finding_id: finding.id,
        severity: finding.severity,
        verdict: null,
        note_refs: [],
        note_tiers: [],
      }
      findingsByKey.set(key, row)
      findings.push(row)
    }
  }

  const adjudicationRows = Array.isArray(adjudications) ? adjudications : []
  if (adjudications !== undefined && !Array.isArray(adjudications)) addIncomplete('adjudication-malformed', 'adjudications')
  for (const entry of adjudicationRows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      addIncomplete('adjudication-malformed', 'adjudication entry')
      continue
    }
    if (!selected.has(entry.dispatch_id)) {
      addIncomplete('adjudication-unknown-dispatch', `dispatch ${String(entry.dispatch_id)}`)
      continue
    }
    if (!ADVISOR_AB_VERDICTS.includes(entry.verdict) || !Array.isArray(entry.note_refs) || !entry.note_refs.every((ref) => typeof ref === 'string' && NOTE_REF_RE.test(ref))) {
      addIncomplete('adjudication-malformed', `dispatch ${entry.dispatch_id} finding ${advisorAbFindingLabel(entry.finding_id)}`)
      continue
    }
    const key = advisorAbKey(epoch, entry.dispatch_id, entry.finding_id)
    const finding = findingsByKey.get(key)
    if (!finding) {
      addIncomplete('adjudication-unknown-finding', `${entry.dispatch_id}/${String(entry.finding_id)}`)
      continue
    }
    if (adjudicated.has(key)) {
      addIncomplete('duplicate-adjudication', key)
      continue
    }
    adjudicated.set(key, entry)
    finding.verdict = entry.verdict
    finding.note_refs = [...entry.note_refs]
    if (entry.verdict === 'skipped') {
      skipped += 1
      addIncomplete('skipped-finding', key)
      continue
    }
    if (entry.verdict !== 'overlap') continue
    for (const ref of entry.note_refs) {
      const resolved = notes.refs.get(ref)
      if (!resolved) {
        addIncomplete('note-not-in-journal', `${key}/${ref}`)
        continue
      }
      finding.note_tiers.push(resolved.tier ?? null)
      if (resolved.outcome !== 'injected') {
        addIncomplete('note-not-injected', `${key}/${ref}`)
        continue
      }
      overlapKeys.add(key)
    }
  }

  for (const finding of findings) {
    if (!adjudicated.has(finding.key)) unadjudicated.push(finding.key)
  }
  if (unadjudicated.length > 0) {
    for (const key of unadjudicated) addIncomplete('unadjudicated-finding', key)
  }
  if (duplicateKeys.length > 0) {
    for (const key of duplicateKeys) addIncomplete('duplicate-key', key)
  }
  if (malformed.length > 0) {
    for (const entry of malformed) addIncomplete('finding-malformed', `dispatch ${entry.dispatch_id} finding ${entry.index + 1}`)
  }

  const findingsTotal = findings.length
  const overlapFindings = overlapKeys.size
  if (overlapFindings > findingsTotal) addIncomplete('numerator-exceeds-denominator', `${overlapFindings} > ${findingsTotal}`)
  const ratifiable = incomplete.length === 0
  return {
    run_started_at: epoch,
    dispatch_ids: ids,
    dispatch_count: ids.length,
    dispatch_floor: ADVISOR_AB_DISPATCH_FLOOR,
    at_floor: ids.length >= ADVISOR_AB_DISPATCH_FLOOR,
    ratifiable,
    incomplete,
    findings_total: findingsTotal,
    overlap_findings: overlapFindings,
    overlap_rate: findingsTotal === 0 ? null : overlapFindings / findingsTotal,
    skipped,
    unadjudicated: unadjudicated.length,
    duplicate_keys: duplicateKeys,
    malformed,
    notes: notes.summary,
    findings,
  }
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
      refuse('a verb is required: sessions | phases | tail | procs | gate-review-gap | eligible-tasks | run-set --since <iso> [--until <iso>] | cell-failures [--since <iso>] [--until <iso>] | cells [--since <iso>] [--until <iso>] [--prices <path>] | modifier-attempts [--since <iso>] [--until <iso>] | seat-teardowns [--since <iso>] [--until <iso>] | escalations --since <iso> [--until <iso>] | ci-cycles [--since <iso>] [--until <iso>] | intake-sweeps [--since <iso>] [--until <iso>] | task | request <adw_id> --from-brief <path> | advisor-ab --run-dir <dir> --run-started-at <iso|ms> --adjudications <path> <dispatch-id>… | doctor | kill')
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

    refuseUnknownFlags(verb, flags) // #443: a misspelled flag is a refusal, never a default

    if (verb === 'advisor-ab') {
      // Never globs: the returns directory is opened by NAME, once per supplied
      // dispatch id. Pane sequence ids restart every process, so an unselected
      // envelope in that directory may belong to any earlier run.
      const runDir = flags['run-dir']
      if (typeof runDir !== 'string' || !runDir.trim()) refuse('advisor-ab: --run-dir <dir> is required')
      const startedAtInput = flags['run-started-at']
      const epoch = advisorAbEpoch(startedAtInput)
      if (epoch === null || !Number.isInteger(epoch)) {
        refuse('advisor-ab: --run-started-at must be an epoch-ms integer or an ISO-8601 timestamp')
      }
      const adjudicationsPath = flags.adjudications
      if (typeof adjudicationsPath !== 'string' || !adjudicationsPath.trim()) {
        refuse('advisor-ab: --adjudications <path> is required')
      }
      let adjudicationsInput
      try {
        adjudicationsInput = JSON.parse(readFileSync(adjudicationsPath, 'utf8'))
      } catch {
        refuse('advisor-ab: --adjudications must be a JSON file with schema 1 and an adjudications array')
      }
      if (!adjudicationsInput || typeof adjudicationsInput !== 'object' || Array.isArray(adjudicationsInput) || adjudicationsInput.schema !== 1 || !Array.isArray(adjudicationsInput.adjudications)) {
        refuse('advisor-ab: --adjudications must be a JSON file with schema 1 and an adjudications array')
      }
      if (Object.prototype.hasOwnProperty.call(adjudicationsInput, 'run_started_at') && advisorAbEpoch(adjudicationsInput.run_started_at) !== epoch) {
        refuse('advisor-ab: --adjudications run_started_at disagrees with --run-started-at')
      }

      if (positional.length === 0) {
        refuse('advisor-ab: requires at least one review-dispatch id positional argument — this readout never globs the returns directory')
      }
      const dispatchIds = []
      const seenDispatchIds = new Set()
      for (const dispatchId of positional) {
        if (!DISPATCH_ID_RE.test(dispatchId) || seenDispatchIds.has(dispatchId)) {
          refuse('advisor-ab: each review-dispatch id must match [A-Za-z0-9._-]{1,64} and appear only once')
        }
        seenDispatchIds.add(dispatchId)
        dispatchIds.push(dispatchId)
      }

      let journalText
      try {
        journalText = readFileSync(join(runDir, 'journal.jsonl'), 'utf8')
      } catch {
        refuse('advisor-ab: journal.jsonl is missing or unreadable under --run-dir')
      }
      const envelopeSources = Object.create(null)
      for (const dispatchId of dispatchIds) {
        const envelopePath = join(runDir, 'returns', `${dispatchId}.reviewer.json`)
        let present = false
        try { present = existsSync(envelopePath) } catch { present = false }
        if (!present) {
          envelopeSources[dispatchId] = { status: 'missing' }
          continue
        }
        try {
          const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'))
          if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
            envelopeSources[dispatchId] = { status: 'unreadable' }
          } else {
            envelopeSources[dispatchId] = { status: 'ok', envelope }
          }
        } catch {
          envelopeSources[dispatchId] = { status: 'unreadable' }
        }
      }
      const readout = advisorAbReadout({
        epoch, dispatchIds, journalText, envelopeSources,
        adjudications: adjudicationsInput.adjudications,
      })
      const payload = {
        schema: 1,
        question: 'Does the advisor change what a review finds — and is this readout complete enough to ratify on?',
        definition: {
          finding_key: '(run_started_at, dispatch_id, finding_id)',
          numerator: 'overlap_findings counts distinct findings with at least one resolved injected note',
          note_refs: 'n<k> is a 1-based ordinal over this epoch\'s advisor_note rows in journal.jsonl',
          ratifiable: 'false means the readout is incomplete, never that the advisor failed',
        },
        verdicts: ADVISOR_AB_VERDICTS,
        incomplete_reasons: ADVISOR_AB_INCOMPLETE_REASONS,
        run_dir: runDir,
        ...readout,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      return 0
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

    if (verb === 'run-set') {
      if (positional.length > 0) refuse('run-set: takes no positional arguments — use --since and --until')
      if (flags.since == null) refuse('run-set: --since <iso> is required — a run-set is a window over the ledger, and an implicit window makes its numbers unattributable')
      const since = windowBound(flags.since, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const until = hasUntil ? windowBound(flags.until, 'until') : null
      if (until != null && until <= since) refuse('run-set: --until must be later than --since')
      // A degraded mirror must never print "0 runs": the window is unanswerable,
      // not empty. Mirrors the `task` verb's degraded refusal (:1839).
      const rows = ledger.runSet({ since, until })
      if (ledger.stats().degraded) refuse('run-set: the ledger mirror is degraded — this window is unanswerable, not empty')
      const settled = { running: 0, ok: 0, fail: 0, aborted: 0 }
      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(settled, row.status)) settled[row.status] += 1
      }
      const billedKeys = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
      const agentSessions = rows.reduce((n, row) => n + Number(row.agent_sessions ?? 0), 0)
      const usage = agentSessions === 0 ? null : {
        agent_sessions: agentSessions,
        ...Object.fromEntries(billedKeys.map((key) => {
          const measured = rows.filter((row) => row[key] != null)
          return [key, measured.length === 0 ? null : measured.reduce((n, row) => n + Number(row[key]), 0)]
        })),
      }
      const absent = {
        parked: 'not measured here — a park is a per-crew-dir file in the reclaim store (crew/reclaim.mjs), which the ledger has no key to enumerate; this view reads the ledger only, so parks are unmeasured, never zero',
      }
      const hasUnmeasuredUsage = rows.some((row) => billedKeys.some((key) => row[key] == null))
      if (rows.length > 0 && (agentSessions === 0 || hasUnmeasuredUsage)) {
        const windowTransports = [...ledger.transportsFor(rows.map((row) => row.adw_id)).values()]
          .flatMap((set) => [...set])
        absent.usage = agentSessions === 0
          ? `no run in this window has an agent_sessions row: ${usageAbsentCause(windowTransports)}`
          : `one or more runs in this window: ${USAGE_ABSENT_CAUSES.unbilled_rows}`
      }
      if (rows.some((row) => row.variant === null)) {
        absent.variant = 'one or more runs in this window recorded no shape marker — unmeasured (#251), never a measured "full"'
      }
      const payload = {
        schema: 1,
        question: 'For one run-set: what ran, how did each run settle, and what did it cost?',
        definition: {
          run_set: 'the runs whose sessions.started_at falls in [since, until) — a view over the ledger, never a stored batch id; the ledger has no group column',
          settled: "sessions.status, the ledger's closed enum (running|ok|fail|aborted); crew/crew.mjs maps outcome done -> ok/success and escalation -> aborted/escalated (crew/crew.mjs:2024), while crew/child.mjs still maps every non-done outcome -> aborted with NULL outcome (crew/child.mjs:196), and fail is reserved for the ledger finalizer's claim that a run died",
          usage: "usage sums billed_* across each run's agent_sessions rows — each row holds a running total, not a delta; tokens only, no cost calculation (#119)",
          variant: 'the run shape derived from the first recorded stage marker; null with absent.variant means unmeasured, never an inferred full',
          absent: 'null with an `absent` marker means the fact was never measured — never a measured zero',
        },
        since,
        until,
        runs: rows.length,
        settled,
        usage,
        rows,
        absent,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      stderr.write(`ledger: ${rows.length} run(s) in [${since}, ${until ?? 'now'})\n`)
      return 0
    }

    if (verb === 'cell-failures') {
      if (positional.length > 0) refuse('cell-failures: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'cell-failures') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'cell-failures') : null
      if (until != null && since != null && until <= since) refuse('cell-failures: --until must be later than --since')
      const rows = ledger.cellFailures({ since, until })
      if (ledger.stats().degraded) refuse('cell-failures: the ledger mirror is degraded — this window is unanswerable, not empty')
      stdout.write(`${JSON.stringify({ schema: 1, question: "Which cells are failing, how often, and in what way?", since, until, kinds: CELL_FAILURE_KINDS, attributions: CELL_FAILURE_ATTRIBUTIONS, rows })}\n`)
      return 0
    }

    if (verb === 'cells') {
      if (positional.length > 0) refuse('cells: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'cells') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'cells') : null
      if (until != null && since != null && until <= since) refuse('cells: --until must be later than --since')

      const defaultPriceSourcePath = fileURLToPath(new URL('../../crew/roster.json', import.meta.url))
      const hasPrices = Object.prototype.hasOwnProperty.call(flags, 'prices')
      const priceSourcePath = hasPrices ? flags.prices : defaultPriceSourcePath
      let catalog = null
      let pricesAbsent = null
      if (hasPrices) {
        try {
          catalog = loadPriceCatalog(priceSourcePath)
        } catch {
          refuse('cells: --prices must be a readable JSON price catalog with a models object')
        }
      } else {
        try {
          catalog = loadPriceCatalog(priceSourcePath)
        } catch (err) {
          const reason = err?.code ?? err?.name ?? 'unknown error'
          pricesAbsent = `price catalog ${priceSourcePath} is unavailable (${reason}) — prices are UNMEASURED, never free`
        }
      }

      const rows = ledger.cellReviews({ since, until })
      const usage = ledger.cellUsage({ since, until })
      if (ledger.stats().degraded) refuse('cells: the ledger mirror is degraded — this window is unanswerable, not empty')
      const usageByCell = new Map()
      for (const usageRow of usage) {
        const key = [usageRow.provider, usageRow.model_id, usageRow.model_key, usageRow.agent, usageRow.effort, usageRow.role, usageRow.task_class].join('\0')
        usageByCell.set(key, usageRow)
      }
      const transportsOf = (row) => row.transports == null ? [] : String(row.transports).split(',')
      const payloadAbsent = {}
      if (pricesAbsent !== null) payloadAbsent.prices = pricesAbsent
      const emittedRows = rows.map((row) => {
        const key = [row.provider, row.model_id, row.model_key, row.agent, row.effort, row.role, row.task_class].join('\0')
        const usageRow = usageByCell.get(key) ?? null
        const usageSessions = usageRow === null ? 0 : Number(usageRow.usage_sessions)
        const unbilledSessions = usageRow === null ? 0 : Number(usageRow.unbilled_sessions)
        const billed = (name) => usageSessions === 0 || usageRow[name] == null ? null : Number(usageRow[name])
        const billedInputTokens = billed('billed_input_tokens')
        const billedOutputTokens = billed('billed_output_tokens')
        const billedCacheWriteTokens = billed('billed_cache_write_tokens')
        const billedCacheReadTokens = billed('billed_cache_read_tokens')
        const priceKey = row.provider != null && row.model_id != null
          ? `${row.provider}/${row.model_id}`
          : priceKeyForModel(catalog, row.model_key, row.agent)
        const price = priceKey === null ? null : catalogPrice(catalog, priceKey)
        const hasRates = price !== null
          && typeof price.cost_in_per_mtok === 'number'
          && Number.isFinite(price.cost_in_per_mtok)
          && typeof price.cost_out_per_mtok === 'number'
          && Number.isFinite(price.cost_out_per_mtok)
        const absent = {}
        const firstRoundPassRate = row.first_round_reviews === 0 ? null : row.first_round_passes / row.first_round_reviews
        if (row.first_round_reviews === 0) absent.first_round_pass_rate = 'no review by this cell was its run\'s first round — UNMEASURED, never a zero rate'
        if (row.task_class === null) absent.task_class = 'this run recorded no tier (booted with explicit --roles, or predates sessions.tier) — the class is UNMEASURED, never a class'
        if (row.provider === null && row.model_id === null && row.model_key === null) absent.cell = 'these reviews recorded no cell (#404 landed 2026-08-20; older rows carry nothing) — unattributed, never a cell'
        if (row.model_key !== null) absent.roster_cell = `these reviews were booted with a dispatch-time --model-<role> override, which nulls the roster cell it replaced so it is never mislabelled (crew/crew.mjs:591) — the roster provider/model_id is UNRECORDED, and this cell is identified by its model string, never unattributed`
        if (usageSessions === 0) {
          absent.usage = usageAbsentCause(transportsOf(row))
        } else if (unbilledSessions > 0) {
          absent.usage = USAGE_ABSENT_CAUSES.unbilled_rows
        }
        const cacheRate = (field) => (price !== null && typeof price[field] === 'number' && Number.isFinite(price[field]))
          ? price[field]
          : null
        const cacheReadRate = cacheRate('cost_cache_read_per_mtok')
        const cacheWriteRate = cacheRate('cost_cache_write_per_mtok')
        const missingCacheRates = []
        if (cacheReadRate === null) missingCacheRates.push('cost_cache_read_per_mtok')
        if (cacheWriteRate === null) missingCacheRates.push('cost_cache_write_per_mtok')
        const missingVolume = []
        if (billedInputTokens === null) missingVolume.push('billed_input_tokens')
        if (billedOutputTokens === null) missingVolume.push('billed_output_tokens')
        if (billedCacheReadTokens === null) missingVolume.push('billed_cache_read_tokens')
        if (billedCacheWriteTokens === null) missingVolume.push('billed_cache_write_tokens')
        let costUsd = null
        if (hasRates && missingVolume.length === 0 && missingCacheRates.length === 0) {
          costUsd = (billedInputTokens / 1e6) * price.cost_in_per_mtok
            + (billedOutputTokens / 1e6) * price.cost_out_per_mtok
            + (billedCacheReadTokens / 1e6) * cacheReadRate
            + (billedCacheWriteTokens / 1e6) * cacheWriteRate
        }
        if (row.model_key !== null && priceKey === null) absent.price_key = `the model string ${row.model_key} is translated to no single ${row.agent === null ? 'adapter' : row.agent}-catalog key, and a prefix is never stripped to guess one — unmapped, so this cell is unpriced, never free`
        if (!hasRates) {
          absent.cost_usd = `no price for ` + `${priceKey} in ${priceSourcePath} — unpriced, never free`
        } else if (missingVolume.length > 0) {
          absent.cost_usd = `no measured ${missingVolume.join(', ')} for this cell — unpriced here means unmeasured, never free`
        } else if (missingCacheRates.length > 0) {
          absent.cost_usd = `${USAGE_ABSENT_CAUSES.cache_unpriced} (${priceKey} in ${priceSourcePath} carries no ${missingCacheRates.join(' and ')})`
        }
        return {
          provider: row.provider,
          model_id: row.model_id,
          model: row.model_key,
          agent: row.agent,
          effort: row.effort,
          role: row.role,
          task_class: row.task_class,
          reviews: Number(row.reviews),
          first_round_reviews: Number(row.first_round_reviews),
          first_round_passes: Number(row.first_round_passes),
          first_round_pass_rate: firstRoundPassRate,
          thin: row.first_round_reviews > 0 && row.first_round_reviews < CELL_RATE_FLOOR,
          first_at: row.first_at,
          last_at: row.last_at,
          usage_sessions: usageSessions,
          billed_input_tokens: billedInputTokens,
          billed_output_tokens: billedOutputTokens,
          billed_cache_write_tokens: billedCacheWriteTokens,
          billed_cache_read_tokens: billedCacheReadTokens,
          price_key: priceKey,
          cost_usd: costUsd,
          absent,
        }
      })
      const priceSource = catalog === null ? null : {
        path: priceSourcePath,
        updated_at: catalog.updated_at ?? null,
        units: CELL_PRICE_UNITS,
        models: Object.keys(catalog.models).length,
      }
      const payload = {
        schema: 1,
        question: 'What has each provider/model/agent/effort cell actually done — how many reviews, what share passed first round, and what did a run through it cost?',
        definition: {
          cell: 'provider/model_id/agent/effort/role are copied from each review outcome; null cell keys stay null; when a review recorded no provider/model_id but DID record a model (a dispatch-time --model-<role> override) the cell is keyed on that model string instead, and a review that recorded none of the three stays unattributed in a row of its own — the two are never merged',
          model: 'the raw override model string this cell is keyed by, or null for a roster-keyed cell; a roster-keyed cell is never split by the model spelling its reviews recorded',
          price_key: 'provider/model_id for a roster-keyed cell; for a model-keyed one, the single catalog key whose translation under the review\'s own agent adapter equals the model string — never a stripped prefix, and an unmatched or ambiguous string is unmapped and therefore unpriced, never free',
          task_class: 'task_class is the sessions.tier value forwarded at boot; null means the class was not measured',
          first_round: 'a run\'s first round is every review whose created_at equals MIN(created_at) over that run\'s whole review history; ties count',
          first_round_pass_rate: 'first_round_passes divided by first_round_reviews; a null rate with its absent marker is unmeasured',
          thin: `true iff 0 < first_round_reviews < ${CELL_RATE_FLOOR}; it is a sample-size warning, never an enforcement rule`,
          usage: 'usage joins each review dispatch to its own agent_sessions row; pane reviews have no usage row, and absent usage is never zero',
          cost_usd: CELL_PRICE_UNITS,
          absent: 'a null with an absent marker is UNMEASURED, never a measured zero; a cell with no rows at all is absent from rows, never a zero',
        },
        since,
        until,
        verdicts: REVIEW_VERDICTS,
        rate_floor: CELL_RATE_FLOOR,
        price_source: priceSource,
        rows: emittedRows,
        absent: payloadAbsent,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      return 0
    }

    if (verb === 'modifier-attempts') {
      if (positional.length > 0) refuse('modifier-attempts: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'modifier-attempts') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'modifier-attempts') : null
      if (until != null && since != null && until <= since) refuse('modifier-attempts: --until must be later than --since')
      const rows = ledger.modifierAttempts({ since, until })
      if (ledger.stats().degraded) refuse('modifier-attempts: the ledger mirror is degraded — this window is unanswerable, not empty')
      stdout.write(`${JSON.stringify({ schema: 1, question: "How often does a modifier fire, and how often does firing change anything?", since, until, modifiers: MODIFIER_KINDS, outcomes: MODIFIER_ATTEMPT_OUTCOMES, rows })}\n`)
      return 0
    }

    if (verb === 'seat-teardowns') {
      if (positional.length > 0) refuse('seat-teardowns: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'seat-teardowns') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'seat-teardowns') : null
      if (until != null && since != null && until <= since) refuse('seat-teardowns: --until must be later than --since')
      const rows = ledger.seatTeardowns({ since, until })
      if (ledger.stats().degraded) refuse('seat-teardowns: the ledger mirror is degraded — this window is unanswerable, not empty')
      const measured = rows.length > 0
      const tally = (name) => measured ? rows.reduce((n, r) => n + (r.outcome === name ? Number(r.count ?? 0) : 0), 0) : null
      stdout.write(`${JSON.stringify({
        schema: 1, question: 'Are we leaking workers?',
        definition: {
          unit: 'one piped seat at one run end',
          proven: 'positive evidence the worker is gone — the wrapper exit marker, ESRCH, or probeEvidence === LIVENESS.DEAD; a delivered signal is never evidence',
          failed: 'a MEASURED live worker after teardown; an unreaped child of the run reads this way too, so this over-reports a leak rather than under-reporting one',
          unproven: 'LIVENESS.UNKNOWN or an unusable reservation — an honest non-answer carrying its reason, never counted as clean',
          absent: 'null with an `absent` marker means the window was never measured — never a measured zero',
        },
        since, until, outcomes: SEAT_TEARDOWN_OUTCOMES, measured,
        torn_down: measured ? rows.reduce((n, r) => n + Number(r.count ?? 0), 0) : null,
        proven: tally('proven'), leaked: tally('failed'), unproven: tally('unproven'),
        rows,
        absent: measured ? null : { seat_teardowns: 'no rows in this window — not measured, never a measured zero' },
      })}\n`)
      return 0
    }

    if (verb === 'escalations') {
      if (positional.length > 0) refuse('escalations: takes no positional arguments')
      if (flags.since == null) refuse('escalations: --since <iso> is required — an implicit window makes its numbers unattributable')
      const since = windowBound(flags.since, 'since', 'escalations')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const until = hasUntil ? windowBound(flags.until, 'until', 'escalations') : null
      if (until != null && until <= since) refuse('escalations: --until must be later than --since')
      const { rows, endedRows } = ledger.escalationWindow({ since, until })
      if (ledger.stats().degraded) refuse('escalations: the ledger mirror is degraded — this window is unanswerable, not empty')
      // A window in which NO run ended was not measured — the honesty rule
      // ci-cycles already follows with watchedWindow (:5136). A window that ended
      // runs and lost NONE of them still reports a real measured zero (#854).
      const settledWindow = endedRows.length > 0
      const runsEnded = settledWindow ? endedRows.reduce((n, row) => n + Number(row.count ?? 0), 0) : null
      stdout.write(`${JSON.stringify({
        schema: 1,
        question: 'How many lanes did the factory lose to itself, and to what?',
        definition: {
          unit: 'one run whose outcome is escalated',
          window: 'counted at sessions.ended_at — an escalation is a terminal fact',
          cause: `the closed vocabulary (${ESCALATION_CAUSES.join(', ')}), plus ${ESCALATION_CAUSE_UNCLASSIFIED} for a pair no rule classifies — never a guess`,
          denominator: 'runs_ended counts every session whose ended_at falls in the window, whatever its outcome — the total this loss is a share OF; null with an `absent` marker means no run ended here, never a measured zero',
          absent: 'null with an `absent` marker means the window was never measured — never a measured zero',
          coverage: 'crew/crew.mjs records typed escalation causes; child-driven runs still carry NULL typed outcome fields until their endRun writer is widened, so they remain unmeasured here',
        },
        since,
        until,
        causes: [...ESCALATION_CAUSES, ESCALATION_CAUSE_UNCLASSIFIED],
        actors: TERMINAL_ACTORS,
        measured: settledWindow,
        escalated: settledWindow ? rows.reduce((n, row) => n + Number(row.count ?? 0), 0) : null,
        runs_ended: runsEnded,
        rows,
        absent: settledWindow ? null : { escalations: 'no run ended in this window — not measured, never a measured zero' },
      })}\n`)
      return 0
    }

    if (verb === 'ci-cycles') {
      if (positional.length > 0) refuse('ci-cycles: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'ci-cycles') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'ci-cycles') : null
      if (until != null && since != null && until <= since) refuse('ci-cycles: --until must be later than --since')
      const rows = ledger.ciCycles({ since, until })
      const dispatches = ledger.ciDispatches({ since, until })
      if (ledger.stats().degraded) refuse('ci-cycles: the ledger mirror is degraded — this window is unanswerable, not empty')
      // A window with no `ci_cycles` rows was NOT WATCHED — the honesty rule
      // seat-teardowns already follows (docs/ledger-queries.md). A window that
      // WAS watched and reproduced nothing still reports a real measured zero.
      const watchedWindow = rows.length > 0
      const watched = watchedWindow ? rows.reduce((n, row) => n + Number(row.count ?? 0), 0) : null
      const caught = watchedWindow ? rows.reduce((n, row) => n + (row.classification === 'reproduced' ? Number(row.count ?? 0) : 0), 0) : null
      stdout.write(`${JSON.stringify({
        schema: 1,
        question: "How often does CI catch what the local lane missed, and does one repair cycle fix it?",
        since, until,
        classifications: CI_CLASSIFICATIONS,
        decisions: CI_DECISIONS,
        dispatch_outcomes: CI_DISPATCH_OUTCOMES,
        definition: {
          unit: 'one watched cycle: one check, on one head, on one cycle number',
          absent: 'null with an `absent` marker means the window was never watched — never watched-and-green',
        },
        measured: watchedWindow,
        watched,
        caught,
        rows,
        dispatches,
        absent: watchedWindow ? null : { ci_cycles: 'no ci_cycles rows in this window — not watched, never watched-and-green; any ci_dispatches rows are listed unaggregated beside this marker' },
      })}\n`)
      return 0
    }

    if (verb === 'intake-sweeps') {
      if (positional.length > 0) refuse('intake-sweeps: takes no positional arguments')
      const hasSince = Object.prototype.hasOwnProperty.call(flags, 'since')
      const hasUntil = Object.prototype.hasOwnProperty.call(flags, 'until')
      const since = hasSince ? windowBound(flags.since, 'since', 'intake-sweeps') : null
      const until = hasUntil ? windowBound(flags.until, 'until', 'intake-sweeps') : null
      if (until != null && since != null && until <= since) refuse('intake-sweeps: --until must be later than --since')
      const rows = ledger.intakeSweeps({ since, until })
      const refusalRows = ledger.intakeRefusals({ since, until })
      const dispatches = ledger.intakeDispatches({ since, until })
      if (ledger.stats().degraded) refuse('intake-sweeps: the ledger mirror is degraded — this window is unanswerable, not empty')
      // A window with no sweep rows was NOT SWEPT (docs/ledger-queries.md); a
      // window that WAS swept and picked nothing still reports a measured zero.
      const sweptWindow = rows.length > 0
      const swept = sweptWindow ? rows.reduce((n, row) => n + Number(row.count ?? 0), 0) : null
      const picked = sweptWindow ? rows.reduce((n, row) => n + (row.outcome === 'picked' ? Number(row.count ?? 0) : 0), 0) : null
      const parked = sweptWindow ? rows.reduce((n, row) => n + (row.outcome === 'parked' ? Number(row.count ?? 0) : 0), 0) : null
      stdout.write(`${JSON.stringify({
        schema: 1,
        question: 'Why is the queue not moving — and what did the loop actually do?',
        since,
        until,
        outcomes: INTAKE_OUTCOMES,
        refusals: INTAKE_REFUSALS,
        dispatch_outcomes: INTAKE_DISPATCH_OUTCOMES,
        definition: {
          unit: 'one sweep; refusal rows are candidates',
          absent: 'null with an `absent` marker means the window was never swept — never swept-and-empty',
        },
        measured: sweptWindow,
        swept,
        picked,
        parked,
        rows,
        refusal_rows: refusalRows,
        dispatches,
        absent: sweptWindow ? null : { intake_sweeps: 'no intake_sweeps rows in this window — not swept, never swept-and-empty; any refusal or dispatch rows are listed unaggregated beside this marker' },
      })}\n`)
      return 0
    }

    if (verb === 'request') {
      const adwId = positional[0]
      if (!adwId) refuse('request: requires an adw_id argument')
      if (positional.length > 1) refuse('request: takes exactly one positional argument')
      const request = requestFromBrief(flags['from-brief'])
      const args = ledger.recordSessionRequest({ adw_id: adwId, request, source: 'brief-file' })
      stdout.write(`${JSON.stringify({ schema: 1, ...args })}\n`)
      return 0
    }

    if (verb === 'task') {
      const selector = positional[0]
      if (!selector) refuse('task: requires an adw_id or task_slug argument')
      if (positional.length > 1) refuse('task: takes exactly one positional argument')
      const readout = ledger.taskReadout(selector)
      if (readout.degraded) refuse('task: the ledger mirror is degraded — this run is unanswerable, not absent')
      if (!readout.adw_id) {
        if (readout.candidates.length > 1) {
          refuse(`task: that task_slug matches ${readout.candidates.length} runs — pass one adw_id: ${readout.candidates.join(', ')}`)
        }
        refuse('task: no run matches that adw_id or task_slug')
      }
      const payload = {
        schema: 1,
        question: 'For one run: what ran, what passed, what did the gate say, and what did it cost?',
        definition: {
          usage: "usage sums billed_* across the run's agent_sessions rows — each row holds a running total, not a delta",
          gate_generation: 'one gate generation is one authored gate; attempts within it are re-runs',
          variant: 'the run shape derived from the first recorded stage marker; null with absent.variant means unmeasured, never an inferred full',
          absent: 'null with an `absent` marker means the fact was never measured for this run — never a measured zero',
        },
        adw_id: readout.adw_id,
        resolved_by: readout.resolved_by,
        session: readout.session,
        phases: readout.phases,
        gate_generations: readout.gate_generations,
        review_outcomes: readout.review_outcomes,
        accept_decisions: readout.accept_decisions,
        usage: readout.usage,
        variant: readout.variant,
        absent: readout.absent,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
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
      const drift = ledger.jsonlDrift()
      const payload = {
        schema: 1,
        node_version: process.versions.node,
        node_floor: NODE_FLOOR,
        degraded: s.degraded,
        degraded_reason: s.degraded_reason,
        db_path: dbPath,
        row_counts: rowCounts,
        retired_tables: RETIRED_TABLES,
        pragmas,
        fts5,
        jsonl_drift: drift,
      }
      stdout.write(`${JSON.stringify(payload)}\n`)
      if (!drift.measured) {
        stderr.write(`ledger: JSONL/mirror drift UNMEASURED — ${drift.unmeasured_reason}\n`)
      } else if (drift.drift_total > 0) {
        stderr.write(`ledger: JSONL/mirror drift — ${drift.drift_total} key(s) in the JSONL authority with no mirrored row; remedy: replayJsonl\n`)
      }
      if (drift.measured && drift.collapsed_lines_total > 0) {
        stderr.write(`ledger: JSONL/mirror key collapse — ${drift.collapsed_lines_total} JSONL line(s) share a unique key with different content and are NOT in the mirror; replay does not repair this\n`)
      }
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
