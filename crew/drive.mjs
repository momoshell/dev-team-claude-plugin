import { draftPrBody, draftPrTitle, followUpIssueBody, followUpIssueTitle, gateSummaryLine, residualList } from './converge.mjs'
import { adjudicatePanel, fuseFindings } from './escalation-policy.mjs'
import { VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT } from './variants.mjs'
import { protectedHitsIn, resolveProtectedPaths } from './protected-paths.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SUITE_SLOT_KIND, SLOT_WAIT_INTERVAL_MS, SLOT_WAIT_CEILING_MS, slotPolicy } from './host-load.mjs'
import { slotStore } from './reclaim.mjs'

// crew/drive.mjs — the deterministic task-loop driver (crew v3).
//
// "Code disposes, the lead decides." The mechanical loop lives HERE, as
// tested code: assignment order, envelope waits, the git scope gate, the
// validation lane, the full suite, commit-on-green, every bounce and every
// bound. An agent never drives this loop. The LEAD pane is consulted only at
// genuine judgment points — a member returning insufficient, a bounce limit
// exhausting, a verdict that code cannot arbitrate — and answers with a
// DECISION envelope carrying a closed enum that this driver branches on.
// Escalation ladder: code -> lead -> orchestrator/human, each hop only when
// the enum says so.
//
// Dependency injection: every side effect goes through the `io` object so
// the whole state machine is unit-testable without cmux or live panes.
// seatIo() (in crew.mjs) wires it to driver.mjs + child_process.

export const LIMITS = Object.freeze({
  plan_rounds: 2, // planner attempts (initial + bounces)
  build_rounds: 3, // builder attempts across lane/scope/review bounces
  review_rounds: 2, // reviewer verdicts
  extra_rounds: 1, // lead-granted rounds PER exhaustion point (EXTRA_ROUND_POINTS); total bound = extra_rounds x EXTRA_ROUND_POINTS.length
  lead_consults: 4, // total decision consults per task
  gate_fails_to_triage: 2, // gate failures before build-vs-gate-defect triage
  gate_repairs: 1, // the gate's author may repair it at most once per task
})

// A shared counter let b209-journalchannel's measured plan-check grant starve review;
// keep each exhaustion point on its own bound.
const EXTRA_ROUND_POINTS = Object.freeze(['plan-check', 'review'])

// --- the per-role seat wait budget ---------------------------------------------
// The measured bases for these numbers, kept as the answer to "why these values"
// (#445). b106's complete envelope landed 92 SECONDS after its deadline and the
// run escalated anyway. On 2026-08-22 a judge-tier planner used 1459s of its
// 1800s planner budget, clearing by 341s — 19% headroom on the tier whose
// planning share is ~94% of a run. --plan-rounds buys more ROUNDS, never more
// time per round, so it cannot help a planner that needs one long round; and an
// expiry writes a cell_failures row the breaker counts against the
// provider/model cell (#472), so a budget too small for a legitimately slow
// round is otherwise recorded as a fact about the model.
// Measured seconds: 1459 / 1800.
export const WAITS_S = Object.freeze({
  planner: 1800, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
})

// The dispatch flag that makes the table above reachable per run, in the style
// of crew/limits.mjs's round budgets: validate at the boundary, refuse rather
// than silently default, and record the EFFECTIVE value on every run. Hosted
// HERE rather than in crew/limits.mjs so the role set is DERIVED from WAITS_S —
// a role added to the table gets its flag, its refusal reason and its record
// slot with no second list to keep in sync.
export const WAIT_ROLES = Object.freeze(Object.keys(WAITS_S))
export const WAIT_FLAGS = Object.freeze(WAIT_ROLES.map((role) => `wait-${role}`))
export const WAIT_REFUSALS = Object.freeze(WAIT_ROLES.map((role) => `invalid-wait-${role}`))
// A floor and a ceiling, not policy: they turn a typo (`--wait-planner 0`,
// `--wait-planner 999999`) into a refusal instead of a run that ends instantly
// or one that cannot end. Raising a DEFAULT is not what this flag is for.
export const WAIT_SECONDS_MIN = 1
export const WAIT_SECONDS_MAX = 21600

export function refuseWait(reason, message) {
  if (!WAIT_REFUSALS.includes(reason)) throw new Error(`unknown wait refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// Absent (no flag) -> null, which is what keeps an unflagged run identical to
// today. A blank string reads as absent, exactly as the round budgets do
// (crew/limits.mjs:31). Anything else present must be a whole number of seconds
// in [WAIT_SECONDS_MIN, WAIT_SECONDS_MAX]; anything else REFUSES with a
// closed-set reason rather than silently defaulting.
function resolveWait(raw, role) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const badWait = () => refuseWait(
    `invalid-wait-${role}`,
    `--wait-${role} must be a whole number of seconds between ${WAIT_SECONDS_MIN} and ${WAIT_SECONDS_MAX}, got ${JSON.stringify(raw)}`,
  )
  if (typeof raw !== 'number' && typeof raw !== 'string') throw badWait()
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (!/^[0-9]+$/.test(text)) throw badWait()
  const value = Number(text)
  if (!Number.isInteger(value) || value < WAIT_SECONDS_MIN || value > WAIT_SECONDS_MAX) throw badWait()
  return value
}

// raw: { <role>: <seconds> } — already read from argv. Validation order is
// WAIT_ROLES order, so two bad flags always refuse on the same one. A raw that
// is not an object at all is itself a malformed budget.
export function resolveWaits(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refuseWait(WAIT_REFUSALS[0], `wait budgets must be an object of role -> seconds, got ${JSON.stringify(raw)}`)
  }
  const out = {}
  for (const role of WAIT_ROLES) out[role] = resolveWait(raw[role], role)
  return out
}

// The ctx overlay: only the roles actually flagged, or null when none were — an
// unflagged run must leave ctx without a `waits` key at all.
export function waitsCtx(resolved) {
  const out = {}
  for (const role of WAIT_ROLES) if (resolved[role] !== null) out[role] = resolved[role]
  return Object.keys(out).length === 0 ? null : out
}

// The journal record. The EFFECTIVE per-role budget is recorded on every run,
// flagged or not: an expiry at 1800s means one thing against a default and
// another against a budget the operator chose, and a reader cannot tell the two
// apart from an absent line. `defaults` is WAITS_S, passed in so the record
// helper stays a pure function of what it is handed.
export function waitsRecord(resolved, defaults) {
  const record = { source: {} }
  for (const role of WAIT_ROLES) {
    record[role] = resolved[role] === null ? defaults[role] : resolved[role]
    record.source[role] = resolved[role] === null ? 'default' : 'flag'
  }
  return record
}

// --- the per-role turn ceiling (#870) --------------------------------------
// EXPLICIT-ONLY. There is no default table and no tier derivation: #870's
// "absent flag -> no ceiling and byte-identical behaviour" is the binding half
// of its ask, and any default would make an UNFLAGGED run non-identical. The
// role set is DERIVED from WAIT_ROLES for the reason WAIT_FLAGS is derived from
// WAITS_S (:56-59) — a role added to the seat table gets its ceiling flag, its
// refusal reason and its record slot with no second list to keep in sync.
export const NO_TURN_CEILING = null
export const TURN_CEILING_ROLES = WAIT_ROLES
export const TURN_CEILING_FLAGS = Object.freeze(TURN_CEILING_ROLES.map((role) => `max-turns-${role}`))
export const TURN_CEILING_REFUSALS = Object.freeze(TURN_CEILING_ROLES.map((role) => `invalid-max-turns-${role}`))
export const TURN_CEILING_MIN = 1
export const TURN_CEILING_MAX = 1000

export function refuseTurnCeiling(reason, message) {
  if (!TURN_CEILING_REFUSALS.includes(reason)) throw new Error(`unknown turn ceiling refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

function resolveTurnCeiling(raw, role) {
  const badCeiling = () => refuseTurnCeiling(
    `invalid-max-turns-${role}`,
    `--max-turns-${role} must be a whole number of turns between ${TURN_CEILING_MIN} and ${TURN_CEILING_MAX}, got ${JSON.stringify(raw)}`,
  )
  if (raw === undefined || raw === null) return NO_TURN_CEILING
  if (typeof raw === 'string' && raw.trim() === '') return NO_TURN_CEILING
  if (typeof raw !== 'number' && typeof raw !== 'string') throw badCeiling()
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (!/^[0-9]+$/.test(text)) throw badCeiling()
  const value = Number(text)
  if (!Number.isInteger(value) || value < TURN_CEILING_MIN || value > TURN_CEILING_MAX) throw badCeiling()
  return value
}

export function resolveTurnCeilings(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refuseTurnCeiling(TURN_CEILING_REFUSALS[0], `turn ceilings must be an object of role -> turns, got ${JSON.stringify(raw)}`)
  }
  const out = {}
  for (const role of TURN_CEILING_ROLES) out[role] = resolveTurnCeiling(raw[role], role)
  return out
}

export function turnCeilingArgs(args = {}) {
  const out = {}
  for (const role of TURN_CEILING_ROLES) out[role] = args[`max-turns-${role}`]
  return out
}

export function turnCeilingsRecord(resolved) {
  if (TURN_CEILING_ROLES.every((role) => resolved[role] === NO_TURN_CEILING)) return null
  const record = { source: {} }
  for (const role of TURN_CEILING_ROLES) {
    record[role] = resolved[role]
    record.source[role] = resolved[role] === NO_TURN_CEILING ? 'absent' : 'flag'
  }
  return record
}

export function turnCeilingsJournalPatch(record) {
  return record ? { turn_ceilings: record } : {}
}

// --- adopted plans and the plan-round cap (#802) ----------------------------
export const ADOPTED_PLAN_HEADING = '## Adopted plan'
export const PLAN_CHECK_APPROVE_MARKER = 'VERDICT: approve'
export const PLAN_CHECK_REVISE_MARKER = 'VERDICT: revise'
export const PLAN_CHECK_ABSENT = 'plan-check-absent'
export const PLAN_CHECK_INVALID = 'plan-check-invalid'
export const NOT_ADOPTED = 'not-adopted'

// POSITIVE evidence on both halves, because "the predecessor passed" is a claim
// and the absence of one failure token is not evidence for it. A brief that
// merely QUOTES the heading mid-sentence is not an adopted brief, so the heading
// must be a COMPLETE line; and a plan-check that is empty, truncated, or says
// VERDICT: banana is UNKNOWN, never passed. The contract already puts the
// verdict on the first line, so only the first line is read.
export function adoptionSignal({ briefText = null, planCheckText = null } = {}) {
  const adopted = typeof briefText === 'string'
    && briefText.split('\n').some((line) => line.trim() === ADOPTED_PLAN_HEADING)
  if (!adopted) return { adopted: false, predecessor_checked: null, reason: NOT_ADOPTED }
  if (typeof planCheckText !== 'string') return { adopted, predecessor_checked: null, reason: PLAN_CHECK_ABSENT }
  const verdict = planCheckText.split('\n')[0].trim()
  if (verdict === PLAN_CHECK_APPROVE_MARKER) return { adopted, predecessor_checked: true, reason: null }
  if (verdict === PLAN_CHECK_REVISE_MARKER) return { adopted, predecessor_checked: false, reason: null }
  return { adopted, predecessor_checked: null, reason: PLAN_CHECK_INVALID }
}

export function planRoundCap({ limits, adopted = false, predecessorChecked = null, extraPlanRounds = 0 }) {
  if (adopted && predecessorChecked === null) return limits.plan_rounds + extraPlanRounds
  const base = adopted && predecessorChecked === true ? 1 : limits.plan_rounds
  return base + extraPlanRounds
}

export const PREDECESSOR_FINDINGS_CLOSED = 'predecessor-findings-closed'
export const PLAN_CLOSED_MARKER = 'CLOSED:'

export function predecessorFindingsClosed(planCheckText, planText) {
  const findings = planCheckFindingsFromText(planCheckText)
  if (findings.length === 0) return false
  const closed = new Set(String(planText ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(PLAN_CLOSED_MARKER))
    .map((line) => line.slice(PLAN_CLOSED_MARKER.length).trim().split(/\s/)[0]))
  return findings.every((f) => closed.has(f.id))
}

// --- the enforcement preamble (#870 (a) and (c)) ----------------------------
export function enforcementPreamble(env) {
  const ceiling = env?.details?.turn_ceiling
  if (!ceiling || !Number.isFinite(ceiling.budget)) return { kind: null, lines: [] }
  // MEASURED and over: the count leads the brief, because #870 asks for the
  // count at the HEAD of the next assignment.
  if (Number.isFinite(ceiling.turns)) {
    return {
      kind: 'turn-ceiling',
      lines: [
        `Your previous dispatch returned after ${ceiling.turns} turns against a role budget of ${ceiling.budget}; its envelope was REJECTED.`,
        'Batch your reads and leave the mechanical proof to the driver; the same assignment is asked again.',
      ],
    }
  }
  // UNMEASURED: the count is unknown, so the brief says so and names the closed
  // reason. It never reports a number nobody measured — not a zero, not the
  // budget. The census is best-effort at both producers, and a ceiling that
  // cannot be measured is a measurement failure, not a pass.
  return {
    kind: 'turn-ceiling-unmeasured',
    lines: [
      `Your previous dispatch's turn census is UNAVAILABLE (${ceiling.absent_reason}), so your role budget of ${ceiling.budget} could not be measured; its envelope was REJECTED rather than passed on an unmeasured count.`,
      'Batch your reads and leave the mechanical proof to the driver; the same assignment is asked again.',
    ],
  }
}

// --- the per-role turn ceiling, POST-RETURN (#870 ASK 1) -----------------------
// The driver adjudicates a dispatch that has RETURNED. It does not pre-empt a
// turn and does not replace an outcome another process already wrote: both live
// in crew/headless.mjs and crew/seat-io.mjs, and both are #908 on #904's fence.
export const SEAT_TURN_CEILING_EVENT = 'seat-turn-ceiling'
export const CENSUS_ROW_ABSENT = 'census-row-absent'
export const CENSUS_TURNS_ABSENT = 'census-turns-absent'
export const CENSUS_UNREADABLE = 'census-unreadable'
// CLOSED, and closed at the DRIVER's boundary. The producers' own absent causes
// are prose sentences (CENSUS_ABSENT_CAUSES, crew/headless.mjs:325-331), so
// copying one through would publish an OPEN vocabulary under a key this driver
// promises is closed. Every non-finite count normalises to CENSUS_TURNS_ABSENT.
export const CENSUS_ABSENT_REASONS = Object.freeze([CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE])
// A census is a measurement of the returned envelope only when the producer's
// own outcome for that dispatch says the turn SUCCEEDED.
export const CENSUS_ELIGIBLE_OUTCOMES = Object.freeze(['ok', 'ok-degraded'])
export const RPC_NO_ENVELOPE_OUTCOME = 'no-envelope'
const CENSUS_RPC_TRANSPORT = 'headless-rpc'

// The OUTCOME-QUALIFIED observation of ONE dispatch, correlated on the COMPOSITE
// logical key (dispatch_id, role) — never either field alone.
//
// Why the composite is load-bearing: `dispatch_id` is NOT globally unique. The
// two transports mint ids from independent allocators — headless-json scans only
// its own task/headless/d<n> root (crew/headless.mjs:682-695) while RPC has its
// own allocator over its own root plus the shared returns dir
// (crew/headless-rpc.mjs:516-529) — and seatIo creates one instance per
// transport and returns that transport's id directly
// (crew/seat-io.mjs:2244-2254,2947-2953), minting no cross-transport sequence.
// MEASURED in this lane's own journal: tech-lead/headless-rpc `dispatch_id: d2`
// with 30 turns, and planner/headless-json `dispatch_id: d2` with 34 turns, in
// one run. Keyed on the id alone, a lost planner append would charge the planner
// with the tech-lead's count — a plausible number from the wrong seat, which is
// the best-effort disappearance path with a disguise on.
//
// Why the OUTCOME qualification is load-bearing: both transports PRESERVE the
// outer dispatch id across a re-ask (`const id = reask?.id || runId` —
// crew/headless.mjs:758, crew/headless-rpc.mjs:730) and record the FAILED
// attempt's census before invoking the re-ask (crew/headless.mjs:889-912). One
// (id, role) pair therefore carries several census rows, and a scan that took
// the last matching one would read an earlier attempt's count as this envelope's
// measurement the moment the final best-effort append failed.
//
// Eligibility follows the rows the producers already write:
// - headless-json publishes the outcome and the census on ONE row
//   (crew/headless.mjs:711), so the census is eligible only when that row's
//   headless_outcome is in CENSUS_ELIGIBLE_OUTCOMES.
// - headless-rpc publishes `rpc_outcome` (keyed `id` and `role`) and then the
//   census on the NEXT row (crew/headless-rpc.mjs:922-929), so a census is
//   eligible only while the latest outcome FOR THIS (id, role) was eligible.
//   Every later outcome for this pair RESETS the candidate, so a success whose
//   census never landed is census-row-absent — and a row for ANOTHER role
//   sharing the id neither sets nor resets anything.
// - an explicit latest rpc_outcome 'no-envelope' is NOT ADJUDICATED: that
//   dispatch returned emptyTurnEnvelope (crew/headless-rpc.mjs:376-382,939-948)
//   and the driver's existing no-envelope handling owns it.
// Unknown or failure outcomes, and naked census rows carrying no outcome, are
// never measurements of the returned envelope.
export function observeTurnCensus(rows, dispatchId, role) {
  if (rows === null) return { turns: null, absent: CENSUS_UNREADABLE, adjudicate: true }
  // ONE predicate, used by BOTH arms, so the two arms cannot drift into subtly
  // different correlation rules and one mutation can bind the whole key.
  const mine = (id, who) => id === dispatchId && who === role
  let rpcOutcome = null
  let found = null
  for (const row of rows) {
    if (typeof row?.rpc_outcome === 'string') {
      if (mine(row.id, row.role)) { rpcOutcome = row.rpc_outcome; found = null }
      continue
    }
    const census = row?.seat_turn_census
    if (!census || !mine(census.dispatch_id, census.role)) continue
    const outcome = census.transport === CENSUS_RPC_TRANSPORT ? rpcOutcome : row?.headless_outcome
    found = CENSUS_ELIGIBLE_OUTCOMES.includes(outcome) ? census : null
    if (found !== null) rpcOutcome = null
  }
  if (rpcOutcome === RPC_NO_ENVELOPE_OUTCOME) return { turns: null, absent: null, adjudicate: false }
  if (found === null) return { turns: null, absent: CENSUS_ROW_ABSENT, adjudicate: true }
  if (!Number.isFinite(found.turns)) return { turns: null, absent: CENSUS_TURNS_ABSENT, adjudicate: true }
  return { turns: found.turns, absent: null, adjudicate: true }
}

// A breach is turns STRICTLY OVER budget: a seat that spent exactly its budget
// spent what it was given. A NULL count is never a breach and never a zero —
// that coercion is the false-measured-zero b414 and b420 both died on.
export function turnCeilingBreached(turns, budget) {
  if (!Number.isFinite(turns) || !Number.isFinite(budget)) return false
  return turns > budget
}

// The decision enum the lead may return. The driver offers a SUBSET as
// options in each consult; any answer outside the offered set is treated as
// escalate (fail toward the human, never toward silent progress).
export const DECISIONS = Object.freeze(['bounce', 'bounce-builder', 'bounce-reviewer', 'accept', 'escalate'])

// #45 Tier B slice 1. The failure upgrade is spent ONCE PER TASK, across all
// roles and all bounce kinds — the ratified budget is per task, not per role.
export const FAILURE_UPGRADE = 'failure-upgrade'
export const SENSITIVITY_FLOOR = 'sensitivity-floor'
export const JUDGE_TIER = 'judge'
// Ratified for this repo on issue #250 (orchestrator, 2026-08-16). The
// import-free leaf owns the floor; per-repo additions are unioned with it and
// can never replace or shrink it. crew/roles/ is deliberately absent because
// charters are pinned by tests already.
export { PROTECTED_PATHS, resolveProtectedPaths } from './protected-paths.mjs'

// #251 — blueprint variants: a CLOSED enum of run shapes over this one driver.
// A variant is DATA this code consults at fixed sites — never a composition
// engine, never a user-authored chain, and nothing here ever loops over a stage
// list or executes a stage name. `escalate:*` and `done` are universal
// terminals, so they are not a shape's own declared stages.
export const EXECUTIONS = Object.freeze(['reviewed', 'envelope'])
export const WRITE_SURFACES = Object.freeze(['planned', 'none'])
export const ENVELOPE_FIELD_KINDS = Object.freeze(['text', 'records'])
// #915 — the planner's validation_lane is RESOLVED where it is ACCEPTED, not where it is
// run. b428 burned all three build rounds on a lane naming three fixtures node's loader
// cannot open: the lane is fixed at plan acceptance (:3781) and no seat may amend it, so
// the builder got the byte-identical failure three times. A refusal here is a BOUNCE back
// to the planner inside its own round budget, and never a filter — a filtered lane hides a
// planner that cannot tell a test from a fixture, and that is a planning defect worth seeing.
export const VALIDATION_LANE_UNLOADABLE = 'validation-lane-unloadable'
export const VALIDATION_LANE_EVENT = 'validation-lane-resolved'
// What `node --test` can load, consulted ONLY after the tree has said the path is a regular
// file. The order is load-bearing: a DIRECTORY named test/fixtures.jsonl is loadable and an
// extensionless REGULAR FILE is not, so type is measured first and extension second.
export const LOADABLE_LANE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs', '.ts'])
// What the tree probe can report, one line per input. An input the probe did NOT report is
// `unreadable` and is refused: no unmeasured input is ever accepted.
export const LANE_PROBE_KINDS = Object.freeze(['dir', 'file', 'other', 'absent'])
// Closed, per input. Everything except `loadable` is refused.
export const LANE_INPUT_VERDICTS = Object.freeze([
  'loadable', 'missing', 'unreadable', 'unsupported-type', 'unsupported-extension', 'glob-unresolved',
])
// The command shapes this driver recognises. `node-test` is the one it parses and the one
// #915's contract binds. `opaque` is a lane making no node --test claim — every existing
// driveTask test passes 'lane-cmd' — and the driver claims nothing about it rather than
// pretending to have read it. `unparsable` is a lane whose shell quoting never closes.
export const LANE_COMMAND_SHAPES = Object.freeze(['node-test', 'opaque', 'unparsable'])
// node options taking a SPACE-SEPARATED SCALAR value — a timeout, a pattern, a reporter
// name. Their value is consumed and never probed: without this table `--test-timeout 30000`
// resolves 30000 as an input and refuses a working lane.
export const LANE_VALUE_OPTIONS = Object.freeze([
  '--test-timeout', '--test-name-pattern', '--test-skip-pattern', '--test-reporter',
  '--test-reporter-destination', '--test-concurrency', '--test-shard', '--test-isolation',
  '--env-file', '--conditions',
])
// #915/VL-4 — node options whose value is a FILE NODE LOADS. The contract is EVERY file the
// lane would make node load, so these values are INPUTS judged exactly like a positional —
// never scalars to skip past. `node --test --import <a .jsonl> a.test.mjs` is the b428
// failure with one flag in front of it: the test file probes clean and the .jsonl is what
// kills the run. Both spellings are honoured, `--import x` and `--import=x`.
export const LANE_PATH_OPTIONS = Object.freeze(['--import', '--require', '-r', '--loader', '--experimental-loader'])
// The CLOSED set of reasons an envelope refusal can name (#427). A refusal is a
// {reason, why} pair whose reason is one of these; prose stays in `why`.
export const ENVELOPE_REFUSAL_REASONS = Object.freeze([
  'no-envelope', 'summary', 'artifacts', 'details', 'field-missing', 'field-kind', 'field-item', 'verdict-findings', 'finding-id', 'carried-silent', VALIDATION_LANE_UNLOADABLE,
])
export const UNIVERSAL_STAGE_HEADS = Object.freeze(['escalate', 'done'])
// #251 follow-on — a PARTIAL reviewed shape declares where it gets what a plan
// round would have produced. Closed per key, and only values this driver
// implements: an unimplemented value would pass validation and then be run as
// something else, which is the drift the enum exists to stop.
export const SHAPE_SOURCES = Object.freeze({
  scope: Object.freeze(['plan', 'inherited', 'brief']),
  lane: Object.freeze(['plan', 'ctx']),
  gate: Object.freeze(['plan', 'none', 'brief']),        // ⚓ A2
})
// The stages the reviewed executor emits unconditionally after the plan loop —
// they ARE the reviewed loop, and no declaration may skip them (:1930-2167).
export const REVIEWED_CORE_STAGES = Object.freeze(['build', 'scope-gate', 'lane', 'review', 'commit', 'rebase', 'suite', 'publish'])
// The ONE partial reviewed topology this driver implements: a bounded triage
// round in place of the plan round, no gate, nothing else changed. A shape that
// omits a `full` stage is honoured only if it is EXACTLY this — same sources,
// same stages, and registered under exactly this enum key, because a run opens
// with its KEY as the stage head (:1309 and the triage round below). Declaring
// sources is what a shape may SAY, never proof the executor can run it. Get
// this wrong and the run does not fail at the declaration, it crashes later in
// stage() on the first undeclared head it reaches (:953-957).
export const TRIAGE_STAGE_HEAD = 'repair'
export const TRIAGE_SOURCES = Object.freeze({ scope: 'inherited', lane: 'ctx', gate: 'none' })
export const TRIAGE_STAGES = Object.freeze([TRIAGE_STAGE_HEAD, ...REVIEWED_CORE_STAGES])

// The SECOND partial reviewed topology: the orchestrator's brief IS the plan.
// It opens with its own key as the stage head — the factory ledger reads a run's
// shape from that first row (scripts/factory/ledger.mjs:213-224) — and declares
// no gate-repair/gate-reverify because its gate's author is outside the crew.
export const DIRECTED_STAGE_HEAD = 'directed'
export const DIRECTED_SOURCES = Object.freeze({ scope: 'brief', lane: 'ctx', gate: 'brief' })
export const DIRECTED_SEATS = Object.freeze(['builder', 'reviewer'])
export const DIRECTED_STAGES = Object.freeze([DIRECTED_STAGE_HEAD, 'build', 'scope-gate',
  'lane', 'gate', 'gate-baseline', 'gate-proof', 'review', 'commit', 'rebase', 'suite', 'publish', 'converge'])
// The CLOSED table of partial reviewed topologies this executor implements. Data
// consulted at fixed sites, never a composition engine: each key has its own
// executor branch below, and a name absent from this table is refused before it
// can reach a stage it does not declare.
export const PARTIAL_REVIEWED = Object.freeze({
  [TRIAGE_STAGE_HEAD]: Object.freeze({ sources: TRIAGE_SOURCES, stages: TRIAGE_STAGES, required_seats: 'tier' }),
  [DIRECTED_STAGE_HEAD]: Object.freeze({ sources: DIRECTED_SOURCES, stages: DIRECTED_STAGES, required_seats: DIRECTED_SEATS }),
})

// Why a declaration's sources cannot be honoured, or null. The supplied key set
// must EQUAL the schema's: a key nothing reads is not a harmless extra, it is a
// declaration claiming behaviour this driver does not implement.
export function sourcesDefect(sources) {
  if (!sources || typeof sources !== 'object') return 'no sources declared'
  const keys = Object.keys(SHAPE_SOURCES)
  const extra = Object.keys(sources).filter((key) => !keys.includes(key))
  if (extra.length) {
    return `sources declares ${extra.join(', ')}, which nothing reads — the source keys are exactly ${keys.join(', ')}`
  }
  for (const key of keys) {
    if (!SHAPE_SOURCES[key].includes(sources[key])) {
      return `sources.${key} must be one of ${SHAPE_SOURCES[key].join(', ')}`
    }
  }
  return null
}
// The closed set lives in the import-free leaf so the daemon can validate
// without importing this module. It is re-exported because every consumer
// already reaches for it by this name; a second list is the drift the leaf prevents.
export { VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT } from './variants.mjs'

// Does this shape run that stage? The one question the declaration answers.
// A fixed `if (runs('x'))` site consults it; nothing iterates the list.
export function stageEnabled(shape, head) {
  return Array.isArray(shape?.stages) && shape.stages.includes(head)
}

// The declaration BOUNDS execution: a run may not emit a stage its shape did not
// declare. Enforced in `stage()` (the one recording point), so a shape cannot
// silently widen at runtime. Returns null, or the reason it is a violation.
export function undeclaredStage(shape, label) {
  const head = String(label ?? '').split(':')[0]
  if (UNIVERSAL_STAGE_HEADS.includes(head)) return null
  if (stageEnabled(shape, head)) return null
  return `stage ${JSON.stringify(label)} is not declared by this shape (declared: ${(shape?.stages || []).join(', ')})`
}

// Can this driver honour the declaration at all? A shape it cannot execute is
// REFUSED with a reason — never silently run as something else. This is what
// stops a future `quality`/`document` entry from falling through the whole
// reviewed loop: the executor implements `full`'s stage set, except for the
// one declared bounded-triage topology whose sources and identity are checked
// below. Any other reviewed subset is refused before it can reach stage().
export function shapeDefect(shape, variantName) {
  if (!shape || typeof shape !== 'object') return 'no declaration'
  if (!EXECUTIONS.includes(shape.execution)) return `execution must be one of ${EXECUTIONS.join(', ')}`
  if (!WRITE_SURFACES.includes(shape.writes)) return `writes must be one of ${WRITE_SURFACES.join(', ')}`
  if (typeof shape.accepted_by !== 'string' || !shape.accepted_by.trim()) return 'accepted_by must say what accepts this shape'
  if (!Array.isArray(shape.stages) || shape.stages.length === 0) return 'stages must declare the heads this shape emits'
  for (const field of shape.envelope_fields || []) {
    if (!ENVELOPE_FIELD_KINDS.includes(field?.kind)) return `envelope field ${JSON.stringify(field?.name)} must declare a kind in ${ENVELOPE_FIELD_KINDS.join(', ')}`
  }
  if (shape.execution === 'reviewed') {
    const missing = VARIANTS.full.stages.filter((head) => !shape.stages.includes(head))
    const topology = missing.length ? PARTIAL_REVIEWED[variantName] ?? null : null
    const seats = topology ? topology.required_seats : 'tier'
    if (Array.isArray(seats)) {
      if (!Array.isArray(shape.required_seats) || shape.required_seats.length !== seats.length
        || seats.some((role, i) => shape.required_seats[i] !== role)) {
        return `the ${variantName} shape runs exactly ${seats.join(', ')}; required_seats must be that list`
      }
    } else if (shape.required_seats !== 'tier') {
      return 'a reviewed shape is seated by the tier; required_seats must be "tier"'
    }
    if (!missing.length) return null
    const undeclared = sourcesDefect(shape.sources)
    if (undeclared) {
      return `the reviewed executor implements exactly the full stage set; this declaration omits ${missing.join(', ')}, and a partial reviewed shape needs declared sources for scope, lane and gate before it can be run: ${undeclared}`
    }
    if (!topology) {
      return `the partial reviewed shapes this driver implements are ${Object.keys(PARTIAL_REVIEWED).join(' and ')}; a declaration registered as ${JSON.stringify(variantName ?? null)} would open ${JSON.stringify(`${variantName}:r1`)}, a stage it does not declare`
    }
    const sourced = Object.keys(SHAPE_SOURCES).map((key) => `${key}=${shape.sources[key]}`).join(', ')
    if (Object.keys(SHAPE_SOURCES).some((key) => shape.sources[key] !== topology.sources[key])) {
      return `the ${variantName} shape sources ${Object.entries(topology.sources).map(([k, v]) => `${k}=${v}`).join(', ')}; this declaration sources ${sourced}`
    }
    if (shape.stages.length !== topology.stages.length || topology.stages.some((head, i) => shape.stages[i] !== head)) {
      return `a ${variantName} shape runs exactly ${topology.stages.join(', ')}; this declaration runs ${shape.stages.join(', ')}`
    }
    return null
  }
  const seats = shape.required_seats
  if (!Array.isArray(seats) || seats.length !== 1 || typeof seats[0] !== 'string' || !seats[0]) {
    return 'an envelope shape runs exactly one declared seat; required_seats must be a one-role array'
  }
  if (!stageEnabled(shape, 'envelope-accept')) return 'an envelope shape must declare its envelope-accept stage'
  if (shape.writes !== 'none') return 'an envelope shape has no plan to source a write surface from; writes must be "none"'
  if (!stageEnabled(shape, 'scope-gate')) {
    return 'a shape that claims to write nothing must declare the scope-gate stage that proves it'
  }
  return null
}

export const MODIFIER_OUTCOMES = Object.freeze(['applied', 'transport', 'exhausted', 'no-tier', 'agent-change', 'spent'])

// The compounding valve: on the FIRST round of a consult the lead may answer
// decision='second-opinion' with details.from=<a seated judgment member>.
// CODE then gathers that member's perspective — same question and context,
// deliberately WITHOUT the lead's leaning (unseeded, so it is genuinely
// independent) — and re-asks the lead once, with the perspective attached
// and the valve removed. One hop, then the judge must judge. The whole
// exchange counts as ONE consult against the limit.
// The planner is not a perspective target: it would advise a decision about
// the plan it wrote. It is not a panel partner: it would be the second
// INDEPENDENT reviewer of code built to its own plan. The consult path guards
// that with `exclude`, but the panel has no equivalent, so the seat is removed
// rather than guarded. Without a tech-lead there is no panel partner; the
// existing panel-skipped path runs the single-reviewer round.
export const SECOND_OPINION = 'second-opinion'
export const PERSPECTIVE_TARGETS = Object.freeze(['reviewer', 'tech-lead'])
export const PANEL_PARTNERS = Object.freeze(['tech-lead'])
// The planner's domain ends at plan acceptance. Post-acceptance, the gate is
// the crew's acceptance criteria (judgment work), not the planner's draft;
// code still re-proves every repaired gate, so a bad repair cannot bless itself.
export const GATE_CUSTODIAN = 'lead'
export const PANEL_ADJUDICATORS = Object.freeze(['lead', 'tech-lead'])

export function panelSeats(seated) {
  if (!Array.isArray(seated)) return null
  const partner = PANEL_PARTNERS.find((role) => role !== 'reviewer' && seated.includes(role))
  if (!partner) return null
  const adjudicator = PANEL_ADJUDICATORS.find((role) => (
    role !== 'reviewer' && role !== partner && seated.includes(role)
  ))
  return adjudicator ? { partner, adjudicator } : null
}

// The gate's machine-readable summary line (#153). A gate must print it, and
// the driver reads it to tell "every check RAN and failed" from "the command
// exited non-zero" — which a wholly broken gate also does. `errored` counts
// checks that threw before they could adjudicate anything.
export const GATE_SUMMARY_PREFIX = 'GATE-SUMMARY'

export const GATE_REAP_OUTCOMES = Object.freeze(['already-dead', 'proven', 'failed', 'unproven'])
export const GATE_REAP_CMD_EOF = '__CREW_GATE_CMD_EOF__'
export const GATE_REAP_LAUNCH_EOF = '__CREW_GATE_LAUNCH_EOF__'
export const GATE_REAP_SWEEP_MARKER = '__crew_gate_reap_sweep'
// Job control is the only way a POSIX shell can put a command in a process group
// of its own, and `set -m` REFUSES without a controlling tty under dash
// (measured: "/bin/dash: set: can't access tty; job control turned off"), which
// is /bin/sh on the CI runner. There is no setsid binary on darwin. So the
// backgrounding — and only the backgrounding — is delegated to bash, present on
// both supported platforms. If it is not executable the gate still runs, through
// the same /bin/sh -c contract, and the reap reports `unproven` rather than
// inventing a group to signal.
export const GATE_REAP_SHELL = '/bin/bash'

const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// Fixed text: every variable part arrives as a positional argument, so no gate
// command is ever interpolated into it. The group-leader shim publishes the pgid
// ps MEASURED for it — not `$$`, because if job control did not run the measured
// value is the driver's own group and the guard below refuses it — and then EXECs
// `/bin/sh -c "$command"` with no operands. The authored command therefore sees
// the production contract exactly: $0=/bin/sh, $#=0, $1 unset, and a top-level
// `return` still an error. It is NEVER sourced: sourcing gives $0=crew-gate-reap,
// $#=2 and makes `return 0` succeed (measured).
const GATE_REAP_LAUNCHER = [
  'set -m',
  `/bin/sh -c 'p=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " "); printf %s "$p" > "$1"; c=$(cat "$2"); exec /bin/sh -c "$c"' crew-gate-reap "$1" "$2" &`,
  '__crew_job=$!',
  'set +m', // suppresses bash's "[1]+ Done ..." notice, so the gate's output is untouched
  'wait "$__crew_job"',
  'exit $?',
].join('\n')

// `sleepCmd`, `killCmd` and `psCmd` exist so the settle ladder and the signal
// accounting can be pinned by injection instead of by racing real processes;
// production uses the defaults.
export function gateReapCommand({ cmd, cmdFile, launchFile, pgidFile, report, shell = GATE_REAP_SHELL, sleepCmd = 'sleep', killCmd = 'kill', psCmd = 'ps' }) {
  const text = String(cmd ?? '')
  // A command carrying the delimiter on a line of its own would close the heredoc
  // early. Refuse to wrap rather than corrupt it: no reap, and runGate's
  // truncation makes the absent report read `unproven`.
  if (text.split('\n').some((line) => line === GATE_REAP_CMD_EOF)) return text
  return [
    `__crew_cmd_file=${shQuote(cmdFile)}`,
    `__crew_launch_file=${shQuote(launchFile)}`,
    `__crew_pgid_file=${shQuote(pgidFile)}`,
    `__crew_report=${shQuote(report)}`,
    `__crew_shell=${shQuote(shell)}`,
    `__crew_sleep=${shQuote(sleepCmd)}`,
    `__crew_kill=${shQuote(killCmd)}`,
    `__crew_ps=${shQuote(psCmd)}`,
    `cat > "$__crew_cmd_file" <<'${GATE_REAP_CMD_EOF}'`,
    text,
    GATE_REAP_CMD_EOF,
    `cat > "$__crew_launch_file" <<'${GATE_REAP_LAUNCH_EOF}'`,
    GATE_REAP_LAUNCHER,
    GATE_REAP_LAUNCH_EOF,
    `__crew_self=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')`,
    `: > "$__crew_pgid_file"`,
    // Liveness from the ps TABLE, never from kill(-pgid, 0): an unreaped member
    // keeps signal zero positive forever (crew/seat-io.mjs:480-491). 0 = alive,
    // 1 = dead, 2 = unknown. A table we could not read is unknown, never a death.
    `__crew_live() {`,
    `  __crew_rows=$($__crew_ps -A -o pgid=,pid=,stat= 2>/dev/null) || return 2`,
    `  [ -n "$__crew_rows" ] || return 2`,
    `  __crew_members=$(printf '%s\\n' "$__crew_rows" | awk -v g="$1" '$1==g && $3 !~ /Z/ {print $2}' | tr '\\n' ' ')`,
    `  [ -n "$__crew_members" ] || return 1`,
    `  return 0`,
    `}`,
    // Mirrors pollGroupPeersUntilGone (crew/seat-io.mjs:493-501): probe once, then
    // up to four rounds of sleep-THEN-reprobe, so a death inside the last 250ms is
    // still observed and never escalated past.
    `__crew_settle() {`,
    `  __crew_live "$1"; __crew_probe=$?`,
    `  __crew_i=0`,
    `  while [ "$__crew_probe" -eq 0 ] && [ "$__crew_i" -lt 4 ]; do`,
    `    $__crew_sleep 0.25`,
    `    __crew_i=$((__crew_i + 1))`,
    `    __crew_live "$1"; __crew_probe=$?`,
    `  done`,
    `  return "$__crew_probe"`,
    `}`,
    `if [ -x "$__crew_shell" ]; then`,
    `  "$__crew_shell" "$__crew_launch_file" "$__crew_pgid_file" "$__crew_cmd_file"`,
    `else`,
    `  __crew_fallback=$(cat "$__crew_cmd_file"); /bin/sh -c "$__crew_fallback"`,
    `fi`,
    `__crew_status=$?`,
    `__crew_pgid=$(cat "$__crew_pgid_file" 2>/dev/null | tr -d ' ')`,
    `__crew_signals=0`,
    `__crew_members=`,
    `case "$__crew_pgid" in`,
    `  '' | *[!0-9]* ) __crew_outcome=unproven; __crew_reason=probe-unknown ;;`,
    `  0 | 1 ) __crew_outcome=unproven; __crew_reason=invalid-pgid ;;`,
    `  "$__crew_self" ) __crew_outcome=unproven; __crew_reason=root-unidentified ;;`,
    `  * )`,
    `    __crew_live "$__crew_pgid"; __crew_probe=$?`,
    `    if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=already-dead; __crew_reason=probe-dead`,
    `    elif [ "$__crew_probe" -eq 2 ]; then __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `    else`,
    // Nothing is proven yet: `failed` is reserved for a group that was
    // successfully SIGNALLED and is still measured alive, exactly as
    // settleZombieRootPeers reserves it.
    `      __crew_survivors="$__crew_members"`,
    `      __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `      for __crew_sig in TERM KILL; do`,
    `        if $__crew_kill -"$__crew_sig" -"$__crew_pgid" 2>/dev/null; then`,
    `          __crew_signals=$((__crew_signals + 1))`,
    // A refused or unaddressable kill DELIVERED NOTHING, so it is not counted —
    // and any outcome an EARLIER round left behind (a `failed` set after a
    // delivered TERM) is no longer supported by anything measured. Reset FIRST,
    // then reprobe, and override only a measured death. Without the reset a
    // refused KILL after a delivered TERM inherits `failed`, which is what
    // revision 2 got wrong (measured).
    `        else`,
    `          __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `          __crew_settle "$__crew_pgid"; __crew_probe=$?`,
    `          if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=proven; __crew_reason=probe-dead; fi`,
    `          break`,
    `        fi`,
    `        __crew_settle "$__crew_pgid"; __crew_probe=$?`,
    `        if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=proven; __crew_reason=probe-dead; break; fi`,
    `        if [ "$__crew_probe" -eq 2 ]; then __crew_outcome=unproven; __crew_reason=probe-unknown; break; fi`,
    `        __crew_outcome=failed; __crew_reason=probe-alive`,
    `      done`,
    `      __crew_members="$__crew_survivors"`,
    `    fi`,
    `    ;;`,
    `esac`,
    `printf '{"pgid":"%s","outcome":"%s","reason":"%s","signals":%s,"survivors":"%s"}\\n' "$__crew_pgid" "$__crew_outcome" "$__crew_reason" "$__crew_signals" "$__crew_members" > "$__crew_report"`,
    `exit "$__crew_status"`,
  ].join('\n')
}

export function gateReapSweepCommand({ pgidFile, report, sleepCmd = 'sleep', killCmd = 'kill', psCmd = 'ps' }) {
  return [
    `: ${GATE_REAP_SWEEP_MARKER}`,
    `__crew_pgid_file=${shQuote(pgidFile)}`,
    `__crew_report=${shQuote(report)}`,
    `__crew_sleep=${shQuote(sleepCmd)}`,
    `__crew_kill=${shQuote(killCmd)}`,
    `__crew_ps=${shQuote(psCmd)}`,
    // A wrapper that finished its own reap already wrote the report; runGate
    // truncates it before the run, so a NON-EMPTY report means the wrapper got
    // there and this sweep must not overwrite its verdict.
    `[ -s "$__crew_report" ] && exit 0`,
    `__crew_self=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')`,
    // Liveness from the ps TABLE, never from kill(-pgid, 0): an unreaped member
    // keeps signal zero positive forever (crew/seat-io.mjs:480-491). 0 = alive,
    // 1 = dead, 2 = unknown. A table we could not read is unknown, never a death.
    `__crew_live() {`,
    `  __crew_rows=$($__crew_ps -A -o pgid=,pid=,stat= 2>/dev/null) || return 2`,
    `  [ -n "$__crew_rows" ] || return 2`,
    `  __crew_members=$(printf '%s\\n' "$__crew_rows" | awk -v g="$1" '$1==g && $3 !~ /Z/ {print $2}' | tr '\\n' ' ')`,
    `  [ -n "$__crew_members" ] || return 1`,
    `  return 0`,
    `}`,
    // Mirrors pollGroupPeersUntilGone (crew/seat-io.mjs:493-501): probe once, then
    // up to four rounds of sleep-THEN-reprobe, so a death inside the last 250ms is
    // still observed and never escalated past.
    `__crew_settle() {`,
    `  __crew_live "$1"; __crew_probe=$?`,
    `  __crew_i=0`,
    `  while [ "$__crew_probe" -eq 0 ] && [ "$__crew_i" -lt 4 ]; do`,
    `    $__crew_sleep 0.25`,
    `    __crew_i=$((__crew_i + 1))`,
    `    __crew_live "$1"; __crew_probe=$?`,
    `  done`,
    `  return "$__crew_probe"`,
    `}`,
    `__crew_pgid=$(cat "$__crew_pgid_file" 2>/dev/null | tr -d ' ')`,
    `__crew_signals=0`,
    `__crew_members=`,
    `case "$__crew_pgid" in`,
    `  '' | *[!0-9]* ) __crew_outcome=unproven; __crew_reason=probe-unknown ;;`,
    `  0 | 1 ) __crew_outcome=unproven; __crew_reason=invalid-pgid ;;`,
    `  "$__crew_self" ) __crew_outcome=unproven; __crew_reason=root-unidentified ;;`,
    `  * )`,
    `    __crew_live "$__crew_pgid"; __crew_probe=$?`,
    `    if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=already-dead; __crew_reason=probe-dead`,
    `    elif [ "$__crew_probe" -eq 2 ]; then __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `    else`,
    // Nothing is proven yet: `failed` is reserved for a group that was
    // successfully SIGNALLED and is still measured alive, exactly as
    // settleZombieRootPeers reserves it.
    `      __crew_survivors="$__crew_members"`,
    `      __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `      for __crew_sig in TERM KILL; do`,
    `        if $__crew_kill -"$__crew_sig" -"$__crew_pgid" 2>/dev/null; then`,
    `          __crew_signals=$((__crew_signals + 1))`,
    // A refused or unaddressable kill DELIVERED NOTHING, so it is not counted —
    // and any outcome an EARLIER round left behind (a `failed` set after a
    // delivered TERM) is no longer supported by anything measured. Reset FIRST,
    // then reprobe, and override only a measured death. Without the reset a
    // refused KILL after a delivered TERM inherits `failed`, which is what
    // revision 2 got wrong (measured).
    `        else`,
    `          __crew_outcome=unproven; __crew_reason=probe-unknown`,
    `          __crew_settle "$__crew_pgid"; __crew_probe=$?`,
    `          if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=proven; __crew_reason=probe-dead; fi`,
    `          break`,
    `        fi`,
    `        __crew_settle "$__crew_pgid"; __crew_probe=$?`,
    `        if [ "$__crew_probe" -eq 1 ]; then __crew_outcome=proven; __crew_reason=probe-dead; break; fi`,
    `        if [ "$__crew_probe" -eq 2 ]; then __crew_outcome=unproven; __crew_reason=probe-unknown; break; fi`,
    `        __crew_outcome=failed; __crew_reason=probe-alive`,
    `      done`,
    `      __crew_members="$__crew_survivors"`,
    `    fi`,
    `    ;;`,
    `esac`,
    `printf '{"pgid":"%s","outcome":"%s","reason":"%s","signals":%s,"survivors":"%s"}\\n' "$__crew_pgid" "$__crew_outcome" "$__crew_reason" "$__crew_signals" "$__crew_members" > "$__crew_report"`,
    `exit 0`,
  ].join('\n')
}

// The wrapper carries the gate command verbatim inside a quoted heredoc, so the
// original is recoverable. drive.test.mjs's fake runner keys on this, which is how
// 91 existing gate call sites keep scripting the command they always did.
export function gateReapOriginal(wrapped) {
  const text = String(wrapped ?? '')
  const open = `<<'${GATE_REAP_CMD_EOF}'\n`
  const i = text.indexOf(open)
  if (i < 0) return wrapped
  const j = text.indexOf(`\n${GATE_REAP_CMD_EOF}\n`, i + open.length)
  if (j < 0) return wrapped
  return text.slice(i + open.length, j)
}

// A report we could not CLEAR cannot be attributed to this invocation: whatever is
// readable at that path belongs to an earlier run. Fail closed — read nothing
// rather than inherit a stale death claim.
export function gateReapFresh(cleared, text) { return cleared ? text : null }

// A report we could not read or parse measured NOTHING, and an unmeasured group is
// `unproven` — never a death claim. Never throws.
export function gateReapVerdict(text) {
  const unproven = { outcome: 'unproven', reason: 'no-report', pgid: null, signals: 0, survivors: [] }
  if (typeof text !== 'string' || !text.trim()) return unproven
  let parsed = null
  try { parsed = JSON.parse(text.trim().split('\n').filter(Boolean).at(-1)) } catch { return unproven }
  if (!parsed || typeof parsed !== 'object') return unproven
  if (!GATE_REAP_OUTCOMES.includes(parsed.outcome)) return unproven
  const pgid = /^\d+$/.test(String(parsed.pgid ?? '')) ? Number(parsed.pgid) : null
  const signals = Number.isSafeInteger(parsed.signals) && parsed.signals >= 0 ? parsed.signals : 0
  return {
    outcome: parsed.outcome,
    reason: typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'probe-unknown',
    pgid,
    signals,
    survivors: String(parsed.survivors ?? '').split(/\s+/).filter(Boolean),
  }
}

// Parse the LAST summary line in the gate's output, or null if there is none.
// Last wins: a gate that re-runs a suite internally may legitimately print
// more than one, and the final line is the one describing the whole run.
// Anything malformed reads as ABSENT, never as a zero-errored pass — a
// summary we cannot parse is not evidence that the gate ran.
export function parseGateSummary(output) {
  let found = null
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith(GATE_SUMMARY_PREFIX)) continue
    let obj
    try { obj = JSON.parse(line.slice(GATE_SUMMARY_PREFIX.length).trim()) } catch { continue }
    if (!obj || typeof obj !== 'object') continue
    const { total, failed, errored } = obj
    if (![total, failed, errored].every((n) => Number.isSafeInteger(n) && n >= 0)) continue
    found = { total, failed, errored }
  }
  return found
}

// Why a baseline is not acceptable as red. null = it is acceptable.
// A gate that did not RUN cannot have failed for the right reason, and at
// baseline every check is red anyway, so a broken check hides in the crowd —
// which is exactly how #153's ReferenceError survived to build round 3.
export function baselineGateDefect(output) {
  const summary = parseGateSummary(output)
  if (!summary) return `the gate printed no ${GATE_SUMMARY_PREFIX} line, so the driver cannot tell a red gate from a broken one`
  if (summary.errored > 0) return `${summary.errored} of ${summary.total} checks THREW instead of adjudicating — a gate that cannot run cannot be red for the right reason`
  if (summary.failed === 0) return `the summary reports 0 failed checks, which contradicts the non-zero exit`
  return null
}

function fail(stage, msg) {
  const err = new Error(`${stage}: ${msg}`)
  err.stage = stage
  return err
}

// --- envelope shape checks (never trust a member's file blindly) -------------
// The assignment_id check is anti-replay: a stale file from an earlier run
// (crash, escalation) must never satisfy a fresh assignment. Missing is
// tolerated (the shape contract is prompt-borne); a MISMATCH never is.
function validEnvelope(env, role, id) {
  return env && typeof env === 'object'
    && typeof env.status === 'string'
    && (env.role === undefined || env.role === role)
    && (env.assignment_id === undefined || env.assignment_id === id)
}

// What accepts an envelope-shape run: the SHAPE of what came back. Deliberately
// stricter than validEnvelope (:124), which only guards against a stale or
// mis-addressed file. The required fields and their kinds come from the shape's
// declaration, so a later member names its own without new code here.
export function envelopeDefect(env, shape, { taskDir } = {}) {
  const refuse = (reason, why) => ({ reason, why })
  if (!env || typeof env !== 'object') return refuse('no-envelope', 'no envelope')
  if (typeof env.summary !== 'string' || !env.summary.trim()) return refuse('summary', 'summary must be a non-empty string')
  if (!Array.isArray(env.artifacts)) return refuse('artifacts', 'artifacts must be an array')
  for (const artifact of env.artifacts) {
    if (typeof artifact !== 'string' || !artifact) return refuse('artifacts', `artifacts must be paths, found ${JSON.stringify(artifact)}`)
    if (taskDir && !artifact.startsWith(`${taskDir}/`)) return refuse('artifacts', `artifact ${JSON.stringify(artifact)} is outside the task dir`)
    if (artifact.split('/').some((segment) => segment === '.' || segment === '..')) return refuse('artifacts', `artifact ${JSON.stringify(artifact)} must not contain . or .. segments`)
  }
  if (!env.details || typeof env.details !== 'object' || Array.isArray(env.details)) return refuse('details', 'details must be an object')
  const text = (v) => typeof v === 'string' && v.trim().length > 0
  for (const field of shape?.envelope_fields || []) {
    // The declaration says the field is REQUIRED; only the envelope can say it is
    // there. Presence is read off env.details, never off the declaration (#427).
    // MUTATION A2: report an omitted field as 'field-kind' and the refusal stops
    // distinguishing a field nobody returned from one returned mis-shapen.
    if (!hasField(env.details, field.name)) return refuse('field-missing', `details.${field.name} is declared by this shape and the envelope omits it`)
    const value = env.details[field.name]
    if (field.kind === 'text') {
      if (!text(value)) return refuse('field-kind', `details.${field.name} must be a non-empty string`)
      continue
    }
    // 'records'
    // MUTATION A3: refuse a non-array records field as 'field-item' and a wrong-KIND
    // refusal becomes indistinguishable from a bad record inside a good array.
    if (!Array.isArray(value) || value.length === 0) return refuse('field-kind', `details.${field.name} must be a non-empty array`)
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return refuse('field-item', `every details.${field.name} entry must be an object`)
      // MUTATION A4: append an undeclared 'id' to the required item fields and a
      // well-formed envelope is over-refused.
      for (const key of field.item_fields || []) {
        if (!text(item[key])) return refuse('field-item', `every details.${field.name} entry needs a non-empty ${key}`)
      }
    }
  }
  return reviewShapeDefect(env.details)
}

// One presence test, shared by the refusal and the report, so what is REFUSED as
// absent and what is REPORTED as observed can never disagree (#427).
function hasField(details, name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(details, name) && details[name] !== undefined
}

// What the ENVELOPE carried, not what the shape declared: the declared fields this
// envelope actually holds, in declaration order. The accept path reports this —
// mapping shape.envelope_fields to names reported a field as checked for an envelope
// nobody read (#427).
// MUTATION A5: drop hasField from the filter and the helper reports the DECLARATION's
// names again, which is the defect itself.
export function envelopeFieldsPresent(env, shape) {
  const details = env && typeof env === 'object' && env.details && typeof env.details === 'object' && !Array.isArray(env.details)
    ? env.details
    : {}
  return (shape?.envelope_fields || []).map((field) => field?.name).filter((name) => hasField(details, name))
}

function verdictOf(env) {
  const v = env?.details?.verdict
  return v === 'pass' || v === 'approve' ? 'pass'
    : v === 'changes-needed' || v === 'revise' ? 'revise'
    : null
}

// The closed severity set — the same three the charter has always used for
// review.md findings (crew/roles/reviewer.md:19-21). Phase 1 makes it
// machine-readable; it does not add a fourth.
export const FINDING_SEVERITIES = Object.freeze(['must-fix', 'should-fix', 'consider'])
export const RESIDUAL_TYPES = Object.freeze(['cosmetic', 'correctness-unverified'])
export const PLAN_CHECK_SEVERITIES = Object.freeze(['blocker', 'major', 'minor'])
export const PLAN_CONVERGENCE_REASONS = Object.freeze([
  'prior-findings-closed', 'verdict-not-revise', 'findings-absent', 'round-1', 'blocker-present', 'findings-rejected', 'prior-findings-open',
])

export function planCheckFindings(details) {
  if (!Array.isArray(details?.findings)) return null
  const findings = []
  const rejected = []
  const seen = new Set()
  details.findings.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !FINDING_ID_SHAPE.test(entry.id)) {
      rejected.push({ index, why: 'id outside the closed shape' })
      return
    }
    if (!PLAN_CHECK_SEVERITIES.includes(entry.severity)) {
      rejected.push({ index, why: 'severity outside the closed set' })
      return
    }
    if (seen.has(entry.id)) {
      rejected.push({ index, why: 'duplicate id' })
      return
    }
    if (typeof entry.correction !== 'string' || entry.correction.trim() === '') {
      rejected.push({ index, why: 'correction must be non-empty' })
      return
    }
    seen.add(entry.id)
    findings.push({ id: entry.id, severity: entry.severity, correction: entry.correction })
  })
  return { findings, rejected }
}

export function planCheckFindingsFromText(text) {
  const findings = []
  const pattern = /^\s*[-*]\s+([A-Za-z0-9_-]{1,64})\s*\((blocker|major|minor)\)\s*:\s*(\S.*)$/
  for (const line of String(text ?? '').split('\n')) {
    const match = pattern.exec(line)
    if (match) findings.push({ id: match[1], severity: match[2], correction: match[3] })
  }
  return findings
}

export function planConvergence({ verdict, round, findings, priorClosed } = {}) {
  if (verdict !== 'revise') return { converged: false, reason: 'verdict-not-revise', blocker: false, carried: [] }
  if (!findings) return { converged: false, reason: 'findings-absent', blocker: false, carried: [] }
  const rejected = findings.rejected.length > 0
  const blocker = rejected || findings.findings.some((f) => f.severity === 'blocker')
  if (round < 2) return { converged: false, reason: 'round-1', blocker, carried: [] }
  if (blocker) return { converged: false, reason: rejected ? 'findings-rejected' : 'blocker-present', blocker: true, carried: [] }
  if (priorClosed !== true) return { converged: false, reason: 'prior-findings-open', blocker: false, carried: [] }
  if (findings.findings.length === 0) return { converged: false, reason: 'findings-absent', blocker: false, carried: [] }
  return {
    converged: true,
    reason: 'prior-findings-closed',
    blocker: false,
    carried: findings.findings.map((f) => ({ id: f.id, severity: f.severity, correction: f.correction, round })),
  }
}

export function carriedPreambleLines(carried) {
  const rows = Array.isArray(carried) ? carried : []
  if (rows.length === 0) return []
  return [
    '## Carried plan-check findings', '',
    ...rows.map((f) => `- ${f.id} (${f.severity}): ${f.correction}`), '',
  ]
}

export function carriedResolution(details, carried) {
  const ids = new Set((Array.isArray(carried) ? carried : []).map((f) => f?.id).filter((id) => typeof id === 'string'))
  const restated = new Set((reviewFindings(details)?.findings ?? []).map((f) => f.id).filter((id) => ids.has(id)))
  const declared = Array.isArray(details?.carried_cleared) ? details.carried_cleared : []
  const cleared = declared.filter((id) => typeof id === 'string' && ids.has(id) && !restated.has(id))
  const silent = [...ids].filter((id) => !restated.has(id) && !cleared.includes(id))
  return { cleared, restated: [...restated], silent }
}

export function carriedSilenceDefect(details, carried) {
  const silent = carriedResolution(details, carried).silent
  if (silent.length === 0) return null
  return { reason: 'carried-silent', why: `the review is silent on carried plan-check finding(s) ${silent.join(', ')} — a carried finding must be closed or restated against the diff` }
}

export const CARVE_VERDICTS = Object.freeze(['proceed', 'carve'])

// ADR-030 §5. Validate a planner's plan-revision carve choice without ever
// treating silence as permission to proceed. Invalid later slices are dropped;
// the first slice is special because it must be buildable on its own.
export function validateCarve(details) {
  const verdict = details?.carve_verdict
  if (!CARVE_VERDICTS.includes(verdict)) {
    return {
      verdict: null,
      slices: [],
      defect: null,
      why: `carve_verdict must be exactly "proceed" or "carve" on a plan revision (ADR-030 §5); got ${JSON.stringify(verdict)}`,
    }
  }
  if (verdict === 'proceed') return { verdict: 'proceed', slices: [], defect: null, why: null }

  const rawSlices = details?.carve_slices
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) {
    return { verdict: 'carve', slices: [], defect: 'carve_slices must be a non-empty array', why: null }
  }

  const usable = []
  let firstDefect = null
  rawSlices.forEach((slice, index) => {
    let defect = null
    if (!slice || typeof slice !== 'object' || Array.isArray(slice)) {
      defect = 'slice must be an object'
    } else if (typeof slice.summary !== 'string' || slice.summary.trim() === '') {
      defect = 'summary must be a non-empty string'
    } else if (!Array.isArray(slice.files_in_scope) || slice.files_in_scope.length === 0) {
      defect = 'files_in_scope must be a non-empty array'
    } else {
      const scopeErrors = validateScopeEntries(slice.files_in_scope)
      if (scopeErrors.length > 0) {
        defect = `files_in_scope is invalid: ${scopeErrors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}`
      }
    }
    if (defect) {
      if (index === 0) firstDefect = defect
      return
    }
    usable.push({ summary: slice.summary.trim(), files_in_scope: [...slice.files_in_scope] })
  })

  return {
    verdict: 'carve',
    slices: usable,
    defect: firstDefect,
    why: null,
  }
}

export const GROWTH_DIVERGENCE_FACTOR = 2 // ADR-030 §4 as amended at §9.3

const integerOrNull = (value) => (Number.isInteger(value) ? value : null)

export function growthRecord(prev, first, { round, plan_bytes, gate_bytes, files_in_scope_count } = {}, lineage = null) {
  const plan = integerOrNull(plan_bytes)
  const gate = integerOrNull(gate_bytes)
  const lineageBaseline = lineage && Number.isInteger(lineage.baseline_bytes) && lineage.baseline_bytes > 0 ? lineage.baseline_bytes : null
  const previous = prev && typeof prev === 'object' ? prev : null
  const plan_delta = previous && plan !== null && Number.isInteger(previous.plan_bytes)
    ? plan - previous.plan_bytes : null
  const gate_delta = previous && gate !== null && Number.isInteger(previous.gate_bytes)
    ? gate - previous.gate_bytes : null
  const measured = [plan, gate].filter((value) => value !== null)
  const combined_bytes = measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null
  const round1_combined_bytes = lineage ? lineageBaseline : (first?.combined_bytes ?? null)
  const ratio = combined_bytes !== null && round1_combined_bytes !== null && round1_combined_bytes !== 0
    ? Math.round((combined_bytes / round1_combined_bytes) * 100) / 100 : null
  const divergent = (lineage ? true : round >= 2) && combined_bytes !== null && round1_combined_bytes > 0
    && combined_bytes >= GROWTH_DIVERGENCE_FACTOR * round1_combined_bytes
  return {
    round,
    plan_bytes: plan,
    gate_bytes: gate,
    plan_delta,
    gate_delta,
    combined_bytes,
    round1_combined_bytes,
    files_in_scope_count: integerOrNull(files_in_scope_count),
    ratio,
    divergent,
    ...(lineage ? { baseline_source: lineage.source ?? null, baseline_reason: lineage.reason ?? null } : {}),
  }
}

export function lineageFromJournal(text) {
  let adopted = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event === 'plan-adopted') adopted = row
  }
  if (!adopted) return null
  const archive = adopted.archive ?? null
  const combined_bytes = Number.isInteger(adopted.combined_bytes) ? adopted.combined_bytes : null
  const baseline_bytes = Number.isInteger(adopted.lineage_baseline_bytes) && adopted.lineage_baseline_bytes > 0
    ? adopted.lineage_baseline_bytes : null
  const source = adopted.lineage_baseline_source ?? null
  const reason = adopted.lineage_reason ?? null
  const ratio = combined_bytes !== null && baseline_bytes !== null
    ? Math.round((combined_bytes / baseline_bytes) * 100) / 100 : null
  const divergent = Number.isInteger(baseline_bytes) && baseline_bytes > 0 && Number.isInteger(combined_bytes) && combined_bytes >= GROWTH_DIVERGENCE_FACTOR * baseline_bytes
  return { archive, combined_bytes, baseline_bytes, source, reason, ratio, divergent }
}

export function growthLines(record) {
  return [
    '## Plan growth (evidence, never a verdict — no measurement here can fail a run)',
    `round=${record.round} plan_bytes=${record.plan_bytes} plan_delta=${record.plan_delta} gate_bytes=${record.gate_bytes} gate_delta=${record.gate_delta} combined_bytes=${record.combined_bytes} round1_combined_bytes=${record.round1_combined_bytes} files_in_scope=${record.files_in_scope_count} ratio=${record.ratio} divergent=${record.divergent}`,
  ]
}

// The signal was measured, journalled and printed since the record existed, but
// nothing read it back; this consumer supplies evidence only — code never decides here.
export function divergenceConsultLines(record, { decisions = null } = {}) {
  if (!record || record.divergent !== true) return []
  return [
    '',
    '## DIVERGENCE (ADR-030 §4 as amended at §9.3)',
    `Plan round ${record.round} measures combined plan+gate ${record.combined_bytes} bytes against round 1's ${record.round1_combined_bytes} — ratio ${record.ratio}, at or past the ratified factor of ${GROWTH_DIVERGENCE_FACTOR}.`,
    `A diverging plan is growing rather than converging, and the measured history is that the next round produces another wrong shape rather than a smaller one. This is EVIDENCE, not a verdict: ${decisions ?? 'bounce, accept and escalate'} all remain open and the choice is yours.`,
  ]
}

// Parse details.findings. Returns null when there is NO findings array at all
// (an older seat or a degraded reply) — absence is not an error, and the
// caller then behaves exactly as it did before #170. Malformed ENTRIES are
// dropped and reported; they never throw and never change a verdict.
export function reviewFindings(details) {
  if (!Array.isArray(details?.findings)) return null
  const findings = []
  const rejected = []
  const seen = new Set()
  const trimmedOrNull = (value) => (typeof value === 'string' ? value.trim() : null)

  details.findings.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') {
      rejected.push({ index, why: 'missing id' })
      return
    }
    if (!FINDING_SEVERITIES.includes(entry.severity)) {
      rejected.push({ index, why: 'severity outside the closed set' })
      return
    }
    if (seen.has(entry.id)) {
      rejected.push({ index, why: 'duplicate id' })
      return
    }
    seen.add(entry.id); const mark = hardeningOf(entry)
    findings.push({
      id: entry.id,
      severity: entry.severity,
      location: trimmedOrNull(entry.location),
      summary: trimmedOrNull(entry.summary), disposition: dispositionOf(entry), ...(mark ? { hardening: mark, hardening_why: entry.hardening_why.trim() } : {}),
    })
  })
  return { findings, rejected }
}

export const MAX_QUESTIONS = 10

// A refutation's evidence is lead PROSE on its way into a durable record, so
// it is bounded like every other prose field this system persists: 500 chars,
// the ledger's own bound for note/detail/reason (scripts/factory/ledger.mjs:1266).
export const REFUTATION_EVIDENCE_MAX = 500

const isArray = (value) => {
  try { return Array.isArray(value) } catch { return false }
}

const isPlainObject = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const textOf = (value, fallback = '') => {
  try { return value == null ? fallback : String(value) } catch { return fallback }
}

const safeArrayLength = (value) => {
  try {
    const length = Number(value.length)
    return Number.isSafeInteger(length) && length >= 0 ? length : 0
  } catch {
    return 0
  }
}

// Parse details.questions. Returns null when there is no questions array so
// older member envelopes keep the byte-for-byte legacy path. Malformed
// entries are dropped and reported; only the closed id/question shape survives.
export function parseQuestions(details) {
  let raw
  try { raw = details?.questions } catch { return null }
  if (!isArray(raw)) return null

  const questions = []
  const rejected = []
  const seen = new Set()
  const length = safeArrayLength(raw)
  for (let index = 0; index < length; index += 1) {
    let entry
    try { entry = raw[index] } catch {
      rejected.push({ index, why: 'not a plain object' })
      continue
    }
    if (!isPlainObject(entry)) {
      rejected.push({ index, why: 'not a plain object' })
      continue
    }

    let id
    let question
    try {
      id = typeof entry.id === 'string' ? entry.id.trim() : ''
      question = typeof entry.question === 'string' ? entry.question.trim() : ''
    } catch {
      rejected.push({ index, why: 'missing id' })
      continue
    }
    if (!id) {
      rejected.push({ index, why: 'missing id' })
      continue
    }
    if (!question) {
      rejected.push({ index, why: 'missing question' })
      continue
    }
    if (questions.length >= MAX_QUESTIONS) {
      rejected.push({ index, why: `over the ${MAX_QUESTIONS}-question cap` })
      continue
    }
    if (seen.has(id)) {
      rejected.push({ index, why: 'duplicate id' })
      continue
    }
    seen.add(id)
    questions.push({ id, question })
  }
  return { questions, rejected }
}

// Match a lead's keyed answers against the normalized question ids. Silence
// is explicit in `unanswered`; it is never treated as assent or omission of
// the question itself.
export function matchAnswers(questions, answers) {
  const askedIds = []
  const asked = new Set()
  if (isArray(questions)) {
    const length = safeArrayLength(questions)
    for (let index = 0; index < length; index += 1) {
      let question
      try { question = questions[index] } catch { continue }
      try {
        const id = question && typeof question.id === 'string' ? question.id.trim() : ''
        if (id && !asked.has(id)) {
          asked.add(id)
          askedIds.push(id)
        }
      } catch { /* malformed question input is ignored */ }
    }
  }

  const answered = []
  const rejected = []
  const seen = new Set()
  if (!isArray(answers)) {
    rejected.push({ id: null, why: 'answers must be an array' })
  } else {
    const length = safeArrayLength(answers)
    for (let index = 0; index < length; index += 1) {
      let entry
      try { entry = answers[index] } catch {
        rejected.push({ id: null, why: 'missing id' })
        continue
      }
      if (!isPlainObject(entry)) {
        rejected.push({ id: null, why: 'missing id' })
        continue
      }

      let id
      let answer
      try {
        id = typeof entry.id === 'string' ? entry.id.trim() : ''
        answer = typeof entry.answer === 'string' ? entry.answer.trim() : ''
      } catch {
        rejected.push({ id: null, why: 'missing id' })
        continue
      }
      if (!id) {
        rejected.push({ id: null, why: 'missing id' })
        continue
      }
      if (!asked.has(id)) {
        rejected.push({ id, why: 'unknown id' })
        continue
      }
      if (seen.has(id)) {
        rejected.push({ id, why: 'duplicate id' })
        continue
      }
      if (!answer) {
        rejected.push({ id, why: 'empty answer' })
        continue
      }
      seen.add(id)
      answered.push({ id, answer })
    }
  }

  const answeredIds = new Set(answered.map(({ id }) => id))
  return {
    answered,
    unanswered: askedIds.filter((id) => !answeredIds.has(id)),
    rejected,
  }
}

export function questionConsultLines(role, questions) {
  if (!isArray(questions)) return []
  const length = safeArrayLength(questions)
  if (length === 0) return []
  const questionLines = []
  for (let index = 0; index < length; index += 1) {
    let entry
    try { entry = questions[index] } catch { entry = null }
    let id = ''
    let question = ''
    try {
      id = textOf(entry?.id)
      question = textOf(entry?.question)
    } catch { /* malformed entries still render without throwing */ }
    questionLines.push(`- ${id}: ${question}`)
  }
  return [
    '',
    `## The ${textOf(role)} returned ${length} numbered question(s) — answer ALL of them`,
    ...questionLines,
    '',
    'details.answers: [{"id": "<question id>", "answer": "..."}]',
    'An id you leave out is carried to the member as UNANSWERED; it is never read as "no answer needed".',
  ]
}

export function answerBounceLines(questions, matched) {
  if (!isArray(questions)) return []
  const length = safeArrayLength(questions)
  if (length === 0) return []
  const answerById = new Map()
  let rawAnswered
  try { rawAnswered = matched?.answered } catch { rawAnswered = null }
  if (isArray(rawAnswered)) {
    const answeredLength = safeArrayLength(rawAnswered)
    for (let index = 0; index < answeredLength; index += 1) {
      let entry
      try { entry = rawAnswered[index] } catch { continue }
      let id
      let answer
      try { id = entry?.id; answer = entry?.answer } catch { continue }
      if (typeof id !== 'string' || typeof answer !== 'string') continue
      if (!answerById.has(id)) answerById.set(id, answer)
    }
  }
  const lines = [
    '',
    `## Answers to your ${length} question(s) (keyed by your ids)`,
  ]
  for (let index = 0; index < length; index += 1) {
    let entry
    try { entry = questions[index] } catch { entry = null }
    let id = ''
    let question = ''
    try {
      id = textOf(entry?.id)
      question = textOf(entry?.question)
    } catch { /* malformed entries still render without throwing */ }
    lines.push(`- ${id}: ${question}`)
    if (answerById.has(id)) {
      lines.push(`  ANSWER: ${answerById.get(id)}`)
    } else {
      lines.push('  UNANSWERED — no answer came back for this id. Do NOT read the silence as "no answer needed": proceed on the parts that do not depend on it, and if it blocks you, return insufficient again naming ONLY this id.')
    }
  }
  let rawRejected
  try { rawRejected = matched?.rejected } catch { rawRejected = null }
  if (isArray(rawRejected)) {
    const rejectedLength = safeArrayLength(rawRejected)
    const dropped = []
    for (let index = 0; index < rejectedLength; index += 1) {
      let entry
      try { entry = rawRejected[index] } catch { entry = null }
      let id
      let why
      try { id = entry?.id; why = entry?.why } catch { id = null; why = null }
      dropped.push(`${id == null ? '(missing id)' : textOf(id)} (${why ? textOf(why) : 'malformed entry'})`)
    }
    if (dropped.length > 0) lines.push(`Dropped answer entries (reported): ${dropped.join('; ')}`)
  }
  return lines
}

// A bounce is an APPLY instruction, not a re-derive instruction. Measured over
// 164 archived lanes: a revision turn runs 7-15 minutes and re-derivation is
// where fresh defects enter — b37-percheck-proof's round-3 delimiter hole
// appeared during a revision, not in the original plan, while the check had
// already prescribed the exact grammar. So every bounce brief that carries a
// checker's verdict says this, in one place.
export function applyPrescriptionLines(source) {
  return [
    '',
    '## Apply, do not re-derive',
    `Apply the corrections ${source} PRESCRIBED, verbatim — do not re-derive them.`,
    'Where it names an exact edit, wording, grammar, or test, use those exact words.',
    'Re-derive only what it did not prescribe, and say which parts those were.',
  ]
}

export function reviewOutcome(role, env) {
  if (role !== 'reviewer') return null
  const v = verdictOf(env)
  if (!v) return null
  const count = (n) => (Number.isInteger(n) && n >= 0 ? n : null)
  const d = env.details || {}
  const base = {
    verdict: v === 'pass' ? 'pass' : 'changes-needed',
    must_fix: count(d.must_fix), should_fix: count(d.should_fix), consider: count(d.consider),
  }
  const parsed = reviewFindings(d)
  if (!parsed) return base
  const n = (severity) => parsed.findings.filter((finding) => finding.severity === severity).length
  const tally = { must_fix: n('must-fix'), should_fix: n('should-fix'), consider: n('consider') }
  const count_mismatch = ['must_fix', 'should_fix', 'consider']
    .filter((key) => base[key] !== null && base[key] !== tally[key])
  return {
    ...base,
    findings: parsed.findings,
    findings_report: {
      total: parsed.findings.length, tally, rejected: parsed.rejected, count_mismatch,
    },
  }
}

// One clamp for the free text a residual or a refutation carries into the
// journal, shared by both residual validators so the bound cannot drift.
const boundedText = (text) => (text.length > REFUTATION_EVIDENCE_MAX ? `${text.slice(0, REFUTATION_EVIDENCE_MAX - 1)}…` : text)

// Validate an exhaustion-time accept against the canonical finding set.
// `findings` is the normalized array from the LAST reviewer envelope that
// carried one. Returns sanitized claims and every validation failure; the
// caller decides whether correctness-unverified residuals require escalation.
// This helper is deliberately total: malformed lead details never throw.
export function validateAcceptDecision(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const { findings, residuals, refuted } = source
  const errors = []
  const error = (id, why) => errors.push({ id: id ?? null, why })
  const rawResiduals = residuals == null ? [] : residuals
  const rawRefuted = refuted == null ? [] : refuted
  const residualEntries = Array.isArray(rawResiduals) ? rawResiduals : []
  const refutedEntries = Array.isArray(rawRefuted) ? rawRefuted : []
  if (!Array.isArray(rawResiduals)) error(null, 'residuals must be an array')
  if (!Array.isArray(rawRefuted)) error(null, 'refuted must be an array')

  const canonical = Array.isArray(findings) ? findings : []
  const findingById = new Map()
  for (const finding of canonical) {
    if (finding && typeof finding.id === 'string' && finding.id.length > 0 && !findingById.has(finding.id)) {
      findingById.set(finding.id, finding)
    }
  }

  const residualClaims = residualEntries.map((entry) => {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    const id = isObject && typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : null
    const type = isObject ? entry.type : undefined
    if (id === null) error(null, 'missing id')
    if (!RESIDUAL_TYPES.includes(type)) error(id, 'invalid type')
    return { id, type }
  })
  const refutedClaims = refutedEntries.map((entry) => {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    const id = isObject && typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : null
    const evidence = isObject ? entry.evidence : undefined
    const text = typeof evidence === 'string' ? evidence.trim() : ''
    const evidenceValid = text.length > 0
    if (id === null) error(null, 'missing id')
    if (!evidenceValid) error(id, 'empty refutation evidence')
    return { id, evidenceValid, evidence: text }
  })

  const claims = [...residualClaims, ...refutedClaims]
  const claimedIds = new Set()
  for (const { id } of claims) {
    if (id !== null && !findingById.has(id)) error(id, 'unknown id')
  }
  for (const { id } of claims) {
    if (id === null) continue
    if (claimedIds.has(id)) error(id, 'duplicate id')
    claimedIds.add(id)
  }
  for (const { id, type } of residualClaims) {
    const finding = id === null ? null : findingById.get(id)
    if (finding && type === 'cosmetic' && finding.severity === 'must-fix') {
      error(id, 'must-fix may not be typed cosmetic')
    }
  }
  for (const id of findingById.keys()) {
    if (!claimedIds.has(id)) error(id, 'omitted id')
  }

  const residualsOut = residualClaims
    .filter(({ id, type }) => id !== null && findingById.has(id) && RESIDUAL_TYPES.includes(type))
    .map(({ id, type }) => ({ id, type, severity: findingById.get(id).severity, summary: findingById.get(id).summary || '' }))
  const refutedOut = refutedClaims
    .filter(({ id, evidenceValid }) => id !== null && findingById.has(id) && evidenceValid)
    .map(({ id, evidence }) => ({ id, severity: findingById.get(id).severity, evidence: boundedText(evidence) }))
  const unverified = residualsOut
    .filter((residual) => residual.type === 'correctness-unverified')
    .map((residual) => residual.id)
  // Code can check that evidence EXISTS; it can never check that the claim is
  // TRUE. An unverifiable claim about a must-fix is the class this project
  // already fails closed on (capability_unknown, breaker-unmeasurable,
  // bound-unverifiable, an unratified profile field, #52 intake eligibility),
  // so this is surfaced as a FACT, not an error: the decision is well-formed,
  // and it is the caller that declines to honour it (see settleAccept).
  const refuted_must_fix = refutedOut.filter((entry) => entry.severity === 'must-fix').map((entry) => entry.id)
  const result = {
    ok: errors.length === 0,
    residuals: residualsOut,
    refuted: refutedOut,
    unverified,
    refuted_must_fix,
  }
  if (errors.length > 0) result.errors = errors
  return result
}

// Render the exhaustion-time accept contract without changing the legacy
// question when no reviewer envelope carried findings.
export function acceptContractLines(findings) {
  if (findings === null) return []
  const entries = Array.isArray(findings) ? findings : []
  const lines = entries.map((finding) => (
    `- ${finding.id} (${finding.severity}) ${finding.location || '(location unspecified)'} — ${finding.summary || '(no summary)'}`
  ))
  lines.push(
    'For an accept, name every listed finding exactly once across details.residuals: [{id, type}] (type must be "cosmetic" or "correctness-unverified") or details.refuted: [{id, evidence}] with non-empty evidence.',
    'A must-fix finding may not be typed cosmetic. A correctness-unverified residual is legitimate but asks a human and is refused by code into escalation.',
    'Refuting a must-fix is recorded WITH your evidence and then escalates to a human every time: code can check that evidence exists, never that it is true. It is not an accept route — refute a must-fix only when you want a person to read the argument. A refuted should-fix still accepts.',
  )
  return lines
}

// The SAME residual field and the SAME type vocabulary, validated where there
// is no canonical finding set to key it to. A plan-check consult has none — the
// tech-lead envelope carries a verdict and a path, never ids (crew/drive.mjs:2380)
// — so the keyed checks in validateAcceptDecision (unknown/omitted/duplicate id
// against the reviewer's set) are the only part that does not travel, and a
// per-residual summary supplies the text and identity context that a canonical
// finding supplies on the keyed path. The ESCALATING KIND
// does not move: a correctness-unverified residual is still refused into
// escalation by the caller, exactly as on the review path (crew/drive.mjs:1141).
// b209-journalchannel escalated because this stage offered an accept that
// recorded nothing; the fix is the record, never a new vocabulary.
// Total by construction: malformed lead details never throw.
export function validatePlanResiduals(residuals, refuted) {
  const errors = []
  const error = (id, why) => errors.push({ id: id ?? null, why })
  // refuted is a KEYED claim — it names a reviewer finding id, and this stage has
  // none. Unsupported here therefore FAILS CLOSED: dropping it in silence would
  // accept a run as "named none" while the lead had named a gap, which is the
  // exact honesty defect this lane exists to remove. Absent or empty is fine.
  if (refuted != null) {
    if (!Array.isArray(refuted)) error(null, 'refuted must be an array')
    else if (refuted.length > 0) error(null, 'refuted is not supported at a plan-check accept: there are no finding ids to refute — record the gap in residuals instead')
  }
  const raw = residuals == null ? [] : residuals
  const entries = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) error(null, 'residuals must be an array')
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    const id = isObject && typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : null
    const type = isObject ? entry.type : undefined
    const summary = isObject && typeof entry.summary === 'string' ? entry.summary.trim() : ''
    if (id === null) error(null, 'missing id')
    if (!RESIDUAL_TYPES.includes(type)) error(id, 'unknown residual type')
    if (summary === '') error(id, 'empty residual summary')
    if (id !== null && seen.has(id)) error(id, 'duplicate id')
    if (id !== null) seen.add(id)
    if (id === null || !RESIDUAL_TYPES.includes(type) || summary === '') continue
    out.push({ id, type, summary: boundedText(summary) })
  }
  const unverified = out.filter(({ type }) => type === 'correctness-unverified').map(({ id }) => id)
  const result = { ok: errors.length === 0, residuals: out, refuted: [], unverified, refuted_must_fix: [] }
  if (errors.length > 0) result.errors = errors
  return result
}

// The vocabulary b209's lead could not find. An accept at plan-check is offered
// with the residual field NAMED, so a lead holding a known gap records it instead
// of spending the run's escalation to say it in prose.
export function planAcceptContractLines() {
  return [
    '',
    'An accept RECORDS what you already know: details.residuals: [{id, type, summary}] — id is a short label you choose,',
    `type is one of ${RESIDUAL_TYPES.join(' or ')}, and summary states the gap in one sentence.`,
    'A residual typed correctness-unverified is legitimate but asks a human, so code refuses it into escalation — the same rule as at review exhaustion. That is a fact about the FIELD, not about which stage you are standing in.',
    'An accept naming no residual is still an accept, and is recorded as one that named none. Never invent a residual to fill the field.',
  ]
}

// A refusal has two KINDS and they are not the same event. `malformed` is a FORM
// error: the lead put its answer in a field this stage does not support, or left a
// required key out. Nothing it decided has been rejected on the merits and code can
// say exactly what to change, so it is a RETRY. `judgment` is well-formed and code
// declines to honour it (a correctness-unverified residual, a refuted must-fix) —
// that is a decision for a human and no re-ask can move it. #715: folding the two
// into one terminal `escalated` cost lane b287-resume its whole run over a field
// name, while an under-answering PLANNER has had another turn since
// answerBounceLines (crew/drive.mjs:1040). The record carries the KIND as a field
// because the only thing that used to separate them was one word of prose
// (crew/drive.mjs:2176), and an operator should not have to parse prose to tell
// a typo from a judgement. It is NOT the ledger's `outcome`: that column is a closed
// binary (ACCEPT_DECISION_OUTCOMES, scripts/factory/ledger.mjs:181).
export const ACCEPT_REFUSALS = Object.freeze(['malformed', 'judgment'])

// ONE correction, never two: the bound is a constant so the loop that honours it
// can be read at a glance.
export const ACCEPT_REASKS = 1

// Hand the lead back its own refused accept, exactly as answerBounceLines
// (crew/drive.mjs:1040) hands a planner back its own inadequate answer: the
// validator's refusal in its own words, plus the contract THIS STAGE offers.
// b287's lead used a shape it had never been shown; showing it is the whole repair.
// Total by construction: malformed error entries still render without throwing.
export function acceptBounceLines(errors, contractLines) {
  const entries = Array.isArray(errors) ? errors : []
  const lines = ['', '## Your accept was refused on FORM, not on the merits']
  for (const entry of entries) {
    let id = null
    let why = ''
    try { id = entry?.id; why = textOf(entry?.why) } catch { /* malformed entries still render */ }
    lines.push(`- ${typeof id === 'string' && id !== '' ? id : 'decision'}: ${why}`)
  }
  lines.push(
    '',
    'Nothing you decided has been rejected. Restate the SAME decision in the shape below, or answer escalate if you want a human to read it instead.',
    `This is your ONE correction (ACCEPT_REASKS = ${ACCEPT_REASKS}): a second refused answer escalates the run.`,
    ...(Array.isArray(contractLines) ? contractLines : []),
  )
  return lines
}

// accepted_via DESCRIBES THE RECORD. A label that contradicts the record is
// worse than no label: the old hardcoded accepted-via sentence announced
// residuals for a decision that carried none, and nearly got this defect filed
// as "residuals were not recorded".
export function acceptedViaLabel(record) {
  const source = record && typeof record === 'object' ? record : {}
  const n = Array.isArray(source.residuals) ? source.residuals.length : 0
  const m = Array.isArray(source.refuted) ? source.refuted.length : 0
  const phase = source.where === 'review-exhausted' ? 'review rounds exhausted'
    : source.where === 'build-exhausted' ? 'build rounds exhausted'
      : source.where
  return `lead accepted with ${n} residual${n === 1 ? '' : 's'} and ${m} refutation${m === 1 ? '' : 's'} (${phase})`
}

// An entry ending in '/' is a DIRECTORY PREFIX; anything else is a literal
// path matched exactly. Nothing else is supported — and unsupported shapes
// are rejected loudly (validateScopeEntries), never silently ignored.
export const SCOPE_DIR_MIN_SEGMENTS = 2
export function validateScopeEntries(entries) {
  const errors = []
  for (const entry of entries) {
    let why = null
    if (typeof entry !== 'string' || entry.length === 0) {
      why = 'empty or non-string entry'
    } else if (/[*?\[\]{}]/.test(entry)) {
      why = 'glob patterns are not supported — list literal paths or a trailing-slash directory'
    } else if (entry.startsWith('/')) {
      why = 'absolute path — paths must be repo-relative, as git status prints them'
    } else if (entry.split('/').some((segment) => segment === '.' || segment === '..')) {
      why = 'must be a plain repo-relative path (no . or .. segments)'
    } else if (entry.endsWith('/') && entry.split('/').filter(Boolean).length < SCOPE_DIR_MIN_SEGMENTS) {
      why = 'directory prefix is too broad — a top-level directory would authorize most of the tree; name a subdirectory (at least two segments) or list files'
    }
    if (why) errors.push({ entry, why })
  }
  return errors
}

// The directed shape's PLAN IS THE TASK BRIEF. The orchestrator authors exactly
// one fenced ```directed block carrying the acceptance gate command and the write
// surface. Closed key set, same posture as sourcesDefect (:88): a key nothing
// reads is a claim this driver does not honour, not a harmless extra.
export const DIRECTED_BLOCK = 'directed'
export const DIRECTED_KEYS = Object.freeze(['gate_cmd', 'files_in_scope'])
export function parseDirectedBrief(text) {
  if (typeof text !== 'string' || !text.trim()) return { defect: 'the brief is empty or unreadable' }
  const lines = text.split('\n')
  const fence = '```' + DIRECTED_BLOCK
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== fence) continue
    const end = lines.findIndex((line, j) => j > i && line.trim() === '```')
    if (end < 0) return { defect: `the ${fence} block is never closed` }
    blocks.push(lines.slice(i + 1, end).join('\n'))
    i = end
  }
  if (blocks.length === 0) return { defect: `the brief carries no ${fence} block declaring ${DIRECTED_KEYS.join(' and ')}` }
  if (blocks.length > 1) return { defect: `the brief carries ${blocks.length} ${fence} blocks — exactly one of them is the plan` }
  let parsed
  try { parsed = JSON.parse(blocks[0]) } catch (err) { return { defect: `the ${DIRECTED_BLOCK} block is not JSON this driver can read: ${err.message}` } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { defect: `the ${DIRECTED_BLOCK} block must be a JSON object` }
  const extra = Object.keys(parsed).filter((key) => !DIRECTED_KEYS.includes(key))
  if (extra.length) return { defect: `the ${DIRECTED_BLOCK} block declares ${extra.join(', ')}, which nothing reads — the keys are exactly ${DIRECTED_KEYS.join(', ')}` }
  if (typeof parsed.gate_cmd !== 'string' || !parsed.gate_cmd.trim()) return { defect: 'gate_cmd must be the non-empty command the driver runs as the acceptance gate' }
  if (!Array.isArray(parsed.files_in_scope) || parsed.files_in_scope.length === 0) return { defect: 'files_in_scope must be a non-empty list of repo-relative entries' }
  const errors = validateScopeEntries(parsed.files_in_scope)
  if (errors.length) return { defect: `files_in_scope carries entries the scope gate cannot honor: ${errors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}` }
  return { defect: null, gate_cmd: parsed.gate_cmd.trim(), files_in_scope: [...parsed.files_in_scope] }
}

// A plan may declare, per acceptance-gate check, ONE mutation of the built tree
// that the check must catch. 32 is a bound, not a target: each entry costs one
// gate run on the built tree (b31b's voluntary proof declared 19).
export const MUTATIONS_MAX = 32
export const MUTATION_OUTCOMES = Object.freeze(['killed', 'survived', 'unapplied', 'exempt', 'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe'])
// The outcomes that are NOT a gate defect: the declaration never reached the built
// tree or its anchor could not be safely applied, so the plan predicted source the
// builder did not write. `survived` stays the ONLY member of MUTATION_OUTCOMES that indicts the gate itself (#733); `anchor-unsafe` is a binding failure, never a gate defect (#742).
export const MUTATION_BINDING_FAILURES = Object.freeze(['unapplied', 'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe'])
const BINDING_OUTCOME = Object.freeze({ absent: 'anchor-absent', ambiguous: 'anchor-ambiguous', unsafe: 'anchor-unsafe' })
// #874 — the bind check's closed status set, reported for EVERY declaration BEFORE any mutation
// is applied. Three values, not five: `exact` and `normalized` are the two ways an anchor reaches
// the built tree, and every way of failing to reach it is one fact — `absent`. The precise mode
// survives in the row's `why`, which is where a reader needs it.
export const MUTATION_BIND_STATUSES = Object.freeze(['exact', 'normalized', 'absent'])
// MUTATION A2: collapse `normalized` onto `exact` here and the report can no longer tell a
// re-wrapped anchor from a byte-identical one.
const BIND_STATUS = Object.freeze({ exact: 'exact', normalized: 'normalized', absent: 'absent', ambiguous: 'absent', unsafe: 'absent' })   // ANCHOR A2
// #874 — the TERMINAL state of a check's correction. Three values, and `pending` is deliberately
// not one of them: a statically admissible correction is a CANDIDATE, and the third acceptance
// condition — the check still FAILS under it — can only be answered by an adjudicated proof row.
// `pending` is an internal word inside finalizeCorrections and reaches no journal and no envelope.
export const MUTATION_CORRECTION_OUTCOMES = Object.freeze(['none', 'refused', 'accepted'])
// ONE terminal refusal vocabulary, static and proof-time reasons together, because they describe
// the same terminal fact: the offered correction was refused. Splitting them would make a consumer
// join two enums to answer one question. The validator produces the static reasons; proof
// finalization produces `correction-green` (the corrected mutation left its check green) and
// `correction-unproven` (the candidate never produced an adjudicated row at all).
export const MUTATION_CORRECTION_REFUSALS = Object.freeze([
  'not-an-array', 'unknown-check', 'duplicate-check', 'correction-not-absent',
  'correction-shape', 'correction-absent', 'correction-ambiguous',
  'correction-green', 'correction-unproven',
])
// The driver dictates ONE output convention for a gate that declares per-check
// mutations, exactly as it already dictates GATE_SUMMARY_PREFIX (:204): a failing
// check prints a line beginning `FAIL <check>`. A label SUBSTRING is not proof —
// a gate that names every check on both outcomes prints the intended check's name
// on its PASS line while some OTHER check supplies the red exit, which is the
// whole-gate false positive this mechanism exists to remove (#330).
export const CHECK_FAIL_PREFIX = 'FAIL'
// A stable, delimiter-free identifier: no space and no colon can appear in a
// declared label, so the only way one label can prefix another is a grammar
// character, and the matcher below refuses that too.
const CHECK_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export function checkFailureLine(output, check) {
  const want = `${CHECK_FAIL_PREFIX} ${check}`
  return String(output || '').split('\n').some((raw) => {
    const line = raw.trim()
    if (line === want) return true                  // the bare line
    if (!line.startsWith(`${want}:`)) return false  // otherwise the ONE delimiter is a colon
    const rest = line.slice(want.length + 1)
    // …and what follows the colon may not EXTEND the label: `FAIL cache:v2: why`
    // is check `cache:v2` failing, not check `cache`.
    return rest.length === 0 || /^\s/.test(rest)
  })
}

// The DIAGNOSIS of a rejected FAIL line, never the RULE (#387). checkFailureLine's
// semantics above do not move: widening the delimiter would let `FAIL cache` match
// a `FAIL cache-v2` line and reintroduce the whole-gate false positive #330 exists to
// remove. What was missing is the distinction the READER needs -- three lanes read
// "printed no FAIL C1 line" off an output that carried `FAIL C1 — why`, went looking
// for a print that was never absent, and repaired the wrong thing. True only when a
// line carries the label and what follows cannot be reading a LONGER label: a label
// character or a colon EXTENDS it (`FAIL cache:v2:` is check `cache:v2`), and an
// empty rest is what checkFailureLine already accepts.
function checkLabelMisdelimited(output, check) {
  const want = `${CHECK_FAIL_PREFIX} ${check}`
  return String(output || '').split('\n').some((raw) => {
    const line = raw.trim()
    if (!line.startsWith(want)) return false
    const rest = line.slice(want.length)
    return rest.length > 0 && !/^[A-Za-z0-9._:-]/.test(rest)
  })
}
// Why a declared mutation cannot be honoured, per entry — the validateScopeEntries
// shape: [{ entry, why }], empty when the declaration is usable.
export function validateMutations(entries, inScope = () => true) {
  if (!Array.isArray(entries)) return [{ entry: entries, why: 'mutations must be an array of declared checks' }]
  if (entries.length > MUTATIONS_MAX) return [{ entry: entries, why: `declares ${entries.length} mutations, over the bound of ${MUTATIONS_MAX}` }]
  const errors = []
  const seen = new Set()
  for (const entry of entries) {
    let why = null
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      why = 'entry must be an object'
    } else if (typeof entry.check !== 'string' || entry.check.length === 0) {
      why = 'every entry must carry a non-empty check label the gate prints on a FAIL line when that check fails'
    } else if (!CHECK_LABEL.test(entry.check)) {
      why = 'a check label must be a stable token: letters, digits, dot, underscore or hyphen, starting with a letter or digit'
    } else if (seen.has(entry.check)) {
      why = 'duplicate check label'
    } else {
      seen.add(entry.check)
      const exempt = Object.prototype.hasOwnProperty.call(entry, 'exempt')
      if (exempt && ['file', 'find', 'replace'].some((key) => Object.prototype.hasOwnProperty.call(entry, key))) {
        why = 'an exemption declares no mutation'
      } else if (exempt && (typeof entry.exempt !== 'string' || entry.exempt.trim() === '')) {
        why = 'an exemption must carry its reason'
      } else if (!exempt && (typeof entry.file !== 'string' || entry.file.trim() === '')) {
        why = 'a mutation must name the file it edits'
      } else if (!exempt && (validateScopeEntries([entry.file]).length > 0 || entry.file.endsWith('/') || !inScope(entry.file))) {
        why = 'file must be a repo-relative file inside files_in_scope'
      } else if (!exempt && (typeof entry.find !== 'string' || entry.find.length === 0 || typeof entry.replace !== 'string')) {
        why = 'a mutation must carry a non-empty literal find and a replace string'
      } else if (!exempt && entry.find === entry.replace) {
        why = 'find and replace are identical — that mutates nothing'
      // The anchor binds by TOKEN SEQUENCE, so a pair differing only in whitespace
      // binds and rewrites the same tokens: the gate stays green and the row indicts
      // it with `survived` for a declaration that changed nothing (#742). ONE
      // normalization — normalizeAnchor, the binder's own — never a second collapse
      // rule, or validation and binding drift on the characters they disagree about.
      } else if (!exempt && !mutationChangesTokens(entry.find, entry.replace)) {
        why = 'find and replace differ only in whitespace — that mutates no token'
      }
    }
    if (why) errors.push({ entry, why })
  }
  return errors
}

export function scopeMatcher(entries) {
  return (repoRelativePath) => entries.some((entry) => entry.endsWith('/')
    ? repoRelativePath.startsWith(entry)
    : repoRelativePath === entry)
}

// The scope gate's arithmetic, in ONE place: what the tree changed, minus what
// the shape's write surface allows. The reviewed loop and every envelope shape
// call it — one implementation, one meaning of "out of scope".
export function outOfScopeFiles(changed, inScope) {
  return (Array.isArray(changed) ? changed : []).filter((f) => !inScope(f))
}

export const CURSOR_STAGES = Object.freeze({
  plan_round: /^plan:r(\d+)$/,
  build_round: /^build:r(\d+)$/,
  review_round: /^review:r(\d+)$/,
})
export function roundCursor(stages) {
  const cursor = { plan_round: null, build_round: null, review_round: null }
  if (!Array.isArray(stages)) return cursor
  for (const label of stages) {
    if (typeof label !== 'string') continue
    for (const [key, pattern] of Object.entries(CURSOR_STAGES)) {
      const match = pattern.exec(label)
      if (match) cursor[key] = Number(match[1])
    }
  }
  return cursor
}
// `extra` adds to the authored floor and can never replace it.
export function protectedHits(entries, extra) {
  return protectedHitsIn(entries, resolveProtectedPaths(extra))
}

// A lane fence is a DENY-list and never an allow-list: a path no lane claims is
// always allowed. The matching rule is protectedHitsIn's, per lane — one matcher,
// one meaning of "this path is inside that surface".
export function laneFenceHits(entries, laneFence) {
  const hits = []
  for (const record of Array.isArray(laneFence) ? laneFence : []) {
    if (!record || typeof record.lane !== 'string' || !Array.isArray(record.files)) continue
    for (const entry of protectedHitsIn(entries, record.files)) {
      if (!hits.some((hit) => hit.entry === entry && hit.lane === record.lane)) {
        hits.push({ entry, lane: record.lane })
      }
    }
  }
  return hits
}

const fenceBreachList = (hits) => hits.map(({ entry, lane }) => `${entry} is owned by lane ${lane}`).join('; ')

export function composeCommitMessage({ task, planEnv, builderEnv }) {
  const firstNonEmptyLine = (value) => String(value || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
  const subjectLine = firstNonEmptyLine(planEnv?.details?.commit_subject)
  const planLine = firstNonEmptyLine(planEnv?.summary)
  const subject = subjectLine || `crew(${task}): ${planLine || 'task change'}`
  const body = String(builderEnv?.details?.commit_message || builderEnv?.summary || '').trim()
  const bodyPart = body && body.split('\n')[0] === subject ? '' : body
  const normalizeIssues = (values) => {
    const out = []
    for (const issue of Array.isArray(values) ? values : []) {
      const digits = String(issue).trim().replace(/^#/, '')
      if (/^\d+$/.test(digits) && !out.includes(`#${digits}`)) out.push(`#${digits}`)
    }
    return out
  }
  // #806 — GitHub auto-closes from `Closes`, never from `Refs`, and six shipped
  // issues stayed open because the trailer said the wrong word. The plan DECLARES
  // which issues the lane closes; everything else stays a reference, and a lane
  // that declares nothing emits exactly today's trailer.
  const closes = normalizeIssues(planEnv?.details?.closes)
  const issues = normalizeIssues(planEnv?.details?.issues).filter((ref) => !closes.includes(ref))
  const closesTrailer = closes.length ? `Closes: ${closes.join(', ')}` : ''
  const refs = issues.length ? `Refs: ${issues.join(', ')}` : ''
  return [subject, bodyPart, closesTrailer, refs].filter(Boolean).join('\n\n')
}

// The run-start anchor MOVES here from crew/crew.mjs:2046: the driver reads the
// journal's own boundary when it composes a PR body, and drive.mjs may not import
// crew.mjs. crew.mjs imports and re-exports it, so `run-start` stays one string.
export const RUN_START_EVENT = 'run-start'

// #679 — the driver publishes. The base is fixed by the ratified design.
export const PUBLISH_BASE = 'main'
// #806 (TRD docs/trd-local-models.md §2 U6, §4 L4) — the reserved `local_providers`
// key that turns narration on. crew/capabilities.schema.json:50-71 declares every
// provider entry `additionalProperties: false`, so a narrator carries no extra keys:
// the KEY is the switch, `base_url` is the endpoint, and the served model is RESOLVED
// from `<root>/models` — `pi_provider` is pi's namespace, never a served model name.
export const NARRATOR_PROVIDER = 'narrator'
export const NARRATION_HEADING = '## Narrative (local model)'
export const NARRATION_MAX_CHARS = 1200
export const NARRATION_REFUSALS = Object.freeze({
  unconfigured: 'narrator-unconfigured',
  endpointUnsafe: 'narrator-endpoint-unsafe',
  unreachable: 'narrator-unreachable',
  unreadable: 'narrator-unreadable',
  empty: 'narration-empty',
  tooLong: 'narration-too-long',
  unknownFact: 'narration-unknown-fact',
  // #806 plan-check r1 — the model is RESOLVED from the endpoint, never guessed from
  // the register: `pi_provider` is pi's namespace (`<pi_provider>/<roster id>`,
  // crew/adapters/adapter-pi.mjs:100-103), not a served model name.
  modelsUnreadable: 'narrator-models-unreadable',
  modelAbsent: 'narrator-model-absent',
  modelAmbiguous: 'narrator-model-ambiguous',
  rawJson: 'narration-raw-json',
})
export const NARRATION_REFUSAL_NAMES = Object.freeze(Object.values(NARRATION_REFUSALS))
export const PUBLISH_REFUSALS = Object.freeze({
  branchUnresolved: 'branch-unresolved',
  branchMain: 'branch-main',
  ghMissing: 'gh-missing',
  ghAuth: 'gh-auth',
  prExists: 'pr-exists',
  prCheck: 'pr-check',
  pushRejected: 'push-rejected',
  prCreate: 'pr-create',
})
export const PUBLISH_REFUSAL_NAMES = Object.freeze(Object.values(PUBLISH_REFUSALS))

// The close/quoted-apostrophe/reopen form: a template literal would eat the
// backslash in `'\''` and emit three apostrophes, reopening shell parsing.
export function shellArg(value) {
  return `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`
}

export function journalRowsSinceRunStart(text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event === RUN_START_EVENT) { rows.length = 0; continue }
    rows.push(row)
  }
  return rows
}

// A lead bounce decision is EITHER `bounce-<seat>` or the bare `bounce` a consult
// offering ['bounce','escalate'] records (askLead writes `decision: decided`). The row
// carried `${decision}: ${reason}` and composePrBody prefixed the kind again, so #791's
// body read `- bounce: bounce: The reviewer never reviewed...`. Only the seat is worth
// keeping, and a bare decision names NO seat — returning 'bounce' here just moved the
// doubled prefix one layer down (#806).
export function bounceSeatOf(decision) {
  const text = String(decision ?? '')
  const hyphen = text.indexOf('-')
  return hyphen >= 0 ? text.slice(hyphen + 1) : ''
}

// The seat is optional, so the separator is too: a bare row must read
// `- bounce: try again`, never `- bounce:  — try again`.
export function bounceDetail(decision, reason) {
  return [bounceSeatOf(decision), String(reason ?? '').trim()].filter(Boolean).join(' — ')
}

// Adjacent identical stages collapse with a count, so an honest `review:r1 | review:r1`
// reads as `review:r1 ×2` rather than as a typo (#806).
export function collapseStages(stages) {
  const out = []
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (typeof stage !== 'string' || stage === '') continue
    const last = out[out.length - 1]
    if (last && last.token === stage) { last.count += 1; continue }
    out.push({ token: stage, count: 1 })
  }
  return out
}

// The SHAPE of a run: major phases only, each carrying its DISTINCT round count. The
// full stage list stays in the journal (#806 defect 4); nothing is lost, only folded.
//
// An ALLOW-LIST, not a deny-list: the full variant declares sixteen stage heads
// (crew/variants.mjs, pinned by crew/drive.test.mjs:4421) and a judge run journals
// `check`, `gate-baseline`, `gate-repair`, `gate-reverify` and `gate-proof` too, so
// a three-item deny-list still published the instrumentation. `review:pass` is a
// verdict, not a round, and `suite:cold` folds into `suite` because its head does.
export const SHAPE_MAJOR_PHASES = Object.freeze(['plan', 'build', 'review', 'commit', 'rebase', 'suite', 'publish'])
export const SHAPE_ROUNDED_STAGES = Object.freeze(['plan', 'build', 'review'])
export function stageShape(stages) {
  const order = []
  const rounds = new Map()
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (typeof stage !== 'string' || stage === '') continue
    const [head, suffix] = stage.split(':')
    if (!SHAPE_MAJOR_PHASES.includes(head)) continue
    if (!rounds.has(head)) { order.push(head); rounds.set(head, new Set()) }
    // A numbered round is counted once however many times it is journaled; the
    // adjacent repetition itself is the Repeated: line's business, not the shape's.
    if (SHAPE_ROUNDED_STAGES.includes(head) && /^r\d+$/.test(String(suffix ?? ''))) rounds.get(head).add(suffix)
  }
  return order.map((head) => {
    const count = rounds.get(head).size
    return count > 1 ? `${head} ×${count}` : head
  }).join(' → ')
}

// A published body may carry no operator-local path (#806 defect 4). The two known
// roots render as `task/...` and repo-relative; anything absolute that survives them
// keeps only its last segment — a floor, not a guess.
export function relativizeCommand(text, { checkout = '', taskDir = '' } = {}) {
  let out = String(text ?? '')
  const taskLeaf = String(taskDir).split('/').filter(Boolean).pop() || ''
  if (taskDir && taskLeaf) out = out.split(taskDir).join(taskLeaf)
  if (checkout) out = out.split(`${checkout}/`).join('')
  return out.replace(/(^|[\s(`'"=,[])\/(?:[A-Za-z0-9._@~+-]+\/)*([A-Za-z0-9._@~+-]+)/g, '$1$2')
}

// The commit message body — the why — verbatim, with the subject line and the FINAL
// contiguous trailer block removed. Verbatim is the whole point (#806), so a
// trailer-shaped line INSIDE the body ("Refs: are explained below") survives
// byte-for-byte: the walk starts at the end and stops at the first line that is
// neither a trailer nor a blank separator between two trailers.
// ONLY the trailers the driver itself composes: a keyword, a colon, then one or more
// `#<digits>` references and NOTHING else on the line. "Refs: are explained below" is
// prose, and "verbatim" covers the body's LAST line as much as an internal one (#806).
export const COMMIT_TRAILER = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:\s*#\d+(?:\s*,\s*#\d+)*\s*$/i
export function commitIntent(message) {
  const body = String(message ?? '').split('\n').slice(1)
  let i = body.length - 1
  while (i >= 0 && body[i].trim() === '') i -= 1   // trailing blanks belong to nobody
  let cut = i + 1
  let inBlock = false
  while (i >= 0) {
    if (COMMIT_TRAILER.test(body[i])) { inBlock = true; cut = i; i -= 1; continue }
    if (inBlock && body[i].trim() === '') {
      let j = i
      while (j >= 0 && body[j].trim() === '') j -= 1
      if (j >= 0 && COMMIT_TRAILER.test(body[j])) { i = j; continue }
    }
    break
  }
  return body.slice(0, cut).join('\n').trim()
}

export function prAnomalies(rows) {
  if (!Array.isArray(rows)) return []
  const list = (v) => (Array.isArray(v) ? v.join(' ') : '')
  const anomalies = []
  for (const row of rows) {
    if (row?.event === 'wait-extended') {
      anomalies.push({ kind: 'wait-extended', detail: `${row.role ?? 'seat'} ${row.id ?? ''} idle ${row.idle_s ?? '?'}s, extended ${row.extension_s ?? '?'}s` })
    }
    if (typeof row?.stage === 'string' && row.stage.startsWith('gate-repair:')) {
      anomalies.push({ kind: 'gate-repair', detail: row.stage })
    }
    if (typeof row?.decision === 'string' && row.decision.startsWith('bounce')) {
      anomalies.push({ kind: 'bounce', detail: bounceDetail(row.decision, row.reason) })
    }
    // #806 defect 1 — a code-driven review bounce is journaled as a `review_outcome`
    // row (crew/drive.mjs:2158), never as a lead `decision`, so a collector reading
    // only decisions left the most interesting fact about a two-round run out of the
    // body entirely.
    if (row?.review_outcome?.verdict === 'changes-needed') {
      const outcome = row.review_outcome
      const findings = Array.isArray(outcome.findings) ? outcome.findings : []
      const mustFix = findings.filter((finding) => finding?.severity === 'must-fix').map((finding) => finding?.summary).filter(Boolean)
      const why = mustFix.length ? mustFix.join('; ') : `${outcome.must_fix ?? '?'} must-fix, ${outcome.should_fix ?? '?'} should-fix`
      anomalies.push({ kind: 'review-bounce', detail: `${outcome.dispatch ?? 'reviewer'} returned changes-needed: ${why}` })
    }
    if (row?.event === 'tree-witness') {
      anomalies.push({ kind: 'tree-witness', detail: `${row.outcome ?? 'unknown'} — modified ${list(row.modified)} removed ${list(row.removed)} added ${list(row.added)}` })
    }
  }
  return anomalies
}

export function parseSuiteCounts(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '')
  const measured = { pass: null, fail: null, skipped: null }
  for (const line of text.split('\n')) {
    const match = /^(?:#|ℹ)\s*(pass|fail|skipped) (\d+)$/.exec(line)
    if (!match) continue
    measured[match[1]] = Number(match[2])
  }
  if (measured.pass === null || measured.fail === null) return null
  return { pass: measured.pass, fail: measured.fail, skipped: measured.skipped === null ? 0 : measured.skipped }
}

export function refsFromCommitMessage(message) {
  let trailer = null
  for (const line of String(message || '').split('\n')) {
    const match = /^Refs:\s*(.*)$/.exec(line)
    if (match) trailer = match[1]
  }
  if (trailer === null) return []
  const refs = []
  for (const match of trailer.matchAll(/#(\d+)/g)) {
    const ref = `#${match[1]}`
    if (!refs.includes(ref)) refs.push(ref)
  }
  return refs
}

// #806 — the commit message stays the single source of the issue distinction, parsed
// once: a closing keyword (GitHub's own set) names an issue the merge closes, the
// `Refs:` trailer names one the lane only touches, and a closed issue is never also
// listed as a reference.
export function issueTrailers(message) {
  const text = String(message ?? '')
  const closes = []
  const add = (ref) => { if (!closes.includes(ref)) closes.push(ref) }
  for (const line of text.split('\n')) {
    if (!/^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:/i.test(line)) continue
    for (const match of line.matchAll(/#(\d+)/g)) add(`#${match[1]}`)
  }
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) add(`#${match[1]}`)
  const refs = refsFromCommitMessage(text).filter((ref) => !closes.includes(ref))
  return { closes, refs }
}

export function carriedPrLines(carried) {
  const rows = Array.isArray(carried) ? carried : []
  if (rows.length === 0) return []
  return ['## Carried plan-check findings (unresolved)',
    ...rows.map((row) => `- ${row?.id ?? ''} (${row?.severity ?? ''}) carried-to-review: ${row?.correction ?? ''}`), '']
}

export function composePrBody(record) {
  // Narration is labeled and additive; terminal empties delimit blocks without changing un-narrated facts (#806 U6).
  const narrative = String(record?.narrative ?? '').trim()
  const narrativeLines = narrative ? [NARRATION_HEADING, narrative, ''] : []
  const intent = String(record?.intent || '').trim()
  const intentLines = intent ? [intent, ''] : []
  const closes = Array.isArray(record?.closes) ? record.closes : []
  const issues = Array.isArray(record?.issues) ? record.issues : []
  const closesLines = closes.length ? [`Closes ${closes.join(', ')}`] : []
  const refsLines = issues.length ? [`Refs ${issues.join(', ')}`] : []
  const trailerLines = closes.length || issues.length ? [...closesLines, ...refsLines, ''] : []
  const gate = record?.gate || null
  const summary = gate?.summary || null
  const gateLines = (() => {
    if (!gate) return ['No acceptance gate ran.'].concat('')
    const where = gate.cmd ? ` (${gate.cmd})` : ''
    if (!summary) return [`The acceptance gate${where} ran; its summary could not be measured.`].concat('')
    const repairs = Number.isFinite(gate.repairs) ? gate.repairs : 0
    const repaired = repairs > 0 ? `, repaired ${repairs} time${repairs === 1 ? '' : 's'}` : ''
    return [`**${summary.total} gate checks, ${summary.failed} failed, ${summary.errored} errored, discrimination ${gate.discrimination || 'unproven'}**${where}${repaired}.`].concat('')
  })()
  // Unknown is never a zero: an unmeasured count says so rather than reading as green.
  const suite = record?.suite || {}
  const countText = (label, value) => (value && typeof value === 'object'
    ? `${label} ${value.pass} pass / ${value.fail} fail / ${value.skipped} skip`
    : null)
  const measured = [countText('warm', suite.warm), countText('cold', suite.cold)].filter(Boolean)
  const suiteLines = measured.length
    ? [`Suite ${measured.join('; ')}${suite.cold_verified ? ', cold-verified from a fresh checkout' : '; cold verification not recorded'}.`].concat('')
    : ['Suite counts: not measured.'].concat('')
  const review = record?.review || {}
  const residuals = Array.isArray(review.residuals) ? review.residuals : []
  const reviewLines = [
    `Review: ${review.verdict || 'not recorded'}, ${residuals.length ? `${residuals.length} residual${residuals.length === 1 ? '' : 's'}:` : 'no residuals'}`,
    ...residuals.map((row) => `- ${row?.id ?? ''} (${row?.type ?? ''}): ${row?.summary ?? ''}`),
    ...carriedPrLines(review.carried),
    '',
  ]
  const files = Array.isArray(record?.files) ? record.files : []
  const changedLines = files.length ? [`Changed: ${files.join(', ')}`] : []
  const stages = Array.isArray(record?.stages) ? record.stages : []
  const shapeLines = stages.length ? [`Shape: ${stageShape(stages)}`, ''] : []
  const repeats = collapseStages(stages).filter(({ count }) => count > 1).map(({ token, count }) => `${token} ×${count}`)
  const repeatLines = repeats.length ? [`Repeated: ${repeats.join(', ')}`] : []
  const anomalies = Array.isArray(record?.anomalies) ? record.anomalies : []
  const anomalyLines = anomalies.length ? [...anomalies.map((row) => `- ${row?.kind ?? 'anomaly'}: ${row?.detail ?? ''}`), ''] : []
  for (const lines of [changedLines, repeatLines]) if (lines.length) lines.push('')
  const blocks = [[]]
  for (const line of [
    ...narrativeLines, ...intentLines, ...trailerLines,
    ...gateLines, ...suiteLines, ...reviewLines,
    ...changedLines, ...shapeLines, ...repeatLines, ...anomalyLines,
  ]) {
    if (line === '') blocks.push([])
    else blocks.at(-1).push(line)
  }
  return blocks.filter((lines) => lines.length).map((lines) => lines.join('\n')).join('\n\n')
}

// --- record-only narration (#806 U6) -------------------------------------------
// The honesty half of programmatic-over-model-tokens still binds: the prompt is the
// record and nothing else, and a narration naming a path, stage or number the record
// does not carry is REFUSED. A dead endpoint, an unreadable reply or a failed
// validation publishes the code-composed body unchanged.
// ONE OpenAI API root, whichever way the operator spelled base_url. The repo's own
// fixture is `http://127.0.0.1:11434/v1` (crew/crew.test.mjs:5315-5317), so blindly
// appending `/v1` produced `/v1/v1`: preserve a trailing `/v1`, otherwise add it once.
export function narratorApiRoot(baseUrl) {
  const trimmed = String(baseUrl ?? '').replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

export function narratorConfig(registerText) {
  let register = null
  try { register = JSON.parse(String(registerText ?? '')) } catch { return { refused: NARRATION_REFUSALS.unconfigured } }
  const entry = register?.local_providers?.[NARRATOR_PROVIDER]
  if (!entry || typeof entry !== 'object') return { refused: NARRATION_REFUSALS.unconfigured }
  const raw = String(entry.base_url ?? '')
  let parsed
  try { parsed = new URL(raw) } catch { return { refused: NARRATION_REFUSALS.endpointUnsafe } }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { refused: NARRATION_REFUSALS.endpointUnsafe }
  if (parsed.username || parsed.password) return { refused: NARRATION_REFUSALS.endpointUnsafe }
  // `pi_provider` is NOT a model name — it is pi's namespace. The served model is
  // resolved from the endpoint below, so nothing here guesses one.
  return { root: narratorApiRoot(raw) }
}

export function narratorModelsCommand(root) {
  return `curl -sS --max-time 15 ${shellArg(`${root}/models`)} -H ${shellArg('accept: application/json')}`
}

// Exactly ONE non-empty id, or a NAMED refusal. Zero ids and several ids are
// different operator mistakes and they get different names; a narrator that picked
// the first of several would be narrating from a model nobody chose.
export function narratorModelId(output) {
  let parsed
  try { parsed = JSON.parse(String(output ?? '')) } catch { return { refused: NARRATION_REFUSALS.modelsUnreadable } }
  const data = parsed?.data
  if (!Array.isArray(data)) return { refused: NARRATION_REFUSALS.modelsUnreadable }
  const ids = []
  for (const row of data) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) return { refused: NARRATION_REFUSALS.modelAbsent }
  if (ids.length > 1) return { refused: NARRATION_REFUSALS.modelAmbiguous, why: ids.join(', ') }
  return { id: ids[0] }
}

export function narrationPrompt(record) {
  return [
    'You are writing the narrative paragraph of a pull-request body for an automated code lane.',
    'The JSON object below is the ENTIRE record of the run; you have not seen the diff or the checkout.',
    'Write at most four sentences saying what the lane set out to do and how it went.',
    'Use no file path, no stage name and no number that does not appear in this JSON.',
    'Return prose only: no headings, no JSON, no speculation.',
    '',
    JSON.stringify(record),
  ].join('\n')
}

export function narratorCommand({ root, model, prompt }) {
  const payload = JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] })
  return `curl -sS --max-time 30 -X POST ${shellArg(`${root}/chat/completions`)} -H ${shellArg('content-type: application/json')} --data-binary ${shellArg(payload)}`
}

export function narrationFromResponse(output) {
  let parsed
  try { parsed = JSON.parse(String(output ?? '')) } catch { return null }
  const content = parsed?.choices?.[0]?.message?.content
  return typeof content === 'string' && content.trim() ? content.trim() : null
}

// A path token at the end of a sentence carries the full stop; `.` is legal INSIDE a
// path, so the trailing run is trimmed rather than excluded from the class.
export function trimPathToken(token) {
  return String(token ?? '').replace(/[.,;:)\]]+$/, '')
}

export function recordFacts(record) {
  const numbers = new Set()
  const paths = new Set()
  const stages = new Set()
  const scan = (value) => {
    if (typeof value === 'number') { numbers.add(String(value)); return }
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\d+/g)) numbers.add(match[0])
      for (const match of value.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) {
        const token = trimPathToken(match[0])
        paths.add(token); paths.add(token.split('/').pop())
      }
      for (const match of value.matchAll(/\b[A-Za-z0-9_-]+\.(?:mjs|js|ts|json|md|ya?ml)\b/g)) paths.add(match[0])
      for (const match of value.matchAll(/\b[a-z][a-z-]*:(?:r\d+|pass|\d+)\b/g)) stages.add(match[0])
      return
    }
    if (Array.isArray(value)) { for (const item of value) scan(item); return }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) scan(item) }
  }
  scan(record)
  return { numbers, paths, stages }
}

// Raw JSON is refused BEFORE the fact guards run, and for its own named reason: a
// reply like {"total":11} carries only numbers the record does have, so the fact
// guards would pass it and the body would carry the machine dump #806 removed.
export function narrationIsRawJson(text) {
  const narration = String(text ?? '').trim()
  return /\{\s*"/.test(narration) || /"[\w-]+"\s*:/.test(narration) || /^[[{]/.test(narration)
}

// The closed narration-stage vocabulary: every stage head this driver implements —
// the variant declarations plus the universal terminals. A narration may name a stage
// only if the RECORD ran it, and a plain head bypassed the colon-shaped scan entirely:
// "The lane ran converge." passed against a record whose stages were plan:r1 and
// build:r1 (#806 plan-check r2).
export const NARRATION_STAGE_VOCABULARY = Object.freeze([...new Set([
  ...UNIVERSAL_STAGE_HEADS,
  ...Object.values(VARIANTS).flatMap((variant) => (Array.isArray(variant?.stages) ? variant.stages : [])),
])].sort())
export const NARRATION_STAGE_TOKEN = /\b[a-z][a-z-]*:(?:r\d+|pass|\d+)\b/g

// ONE predicate for the whole stage-name guard: an unknown colon-shaped token, or a
// vocabulary head named plainly that the record never ran.
export function narrationStageDefect(narration, record) {
  const text = String(narration ?? '')
  const stages = (Array.isArray(record?.stages) ? record.stages : []).filter((s) => typeof s === 'string')
  const ran = new Set(stages)
  const heads = new Set(stages.map((stage) => stage.split(':')[0]))
  for (const match of text.matchAll(NARRATION_STAGE_TOKEN)) {
    if (!ran.has(match[0])) return NARRATION_REFUSALS.unknownFact
  }
  for (const head of NARRATION_STAGE_VOCABULARY) {
    if (heads.has(head)) continue
    if (new RegExp(`(?<![A-Za-z0-9:-])${head}(?![A-Za-z0-9:-])`).test(text)) return NARRATION_REFUSALS.unknownFact
  }
  return null
}

export function narrationDefect(text, record) {
  const narration = String(text ?? '').trim()
  if (!narration) return NARRATION_REFUSALS.empty
  if (narration.length > NARRATION_MAX_CHARS) return NARRATION_REFUSALS.tooLong
  if (narrationIsRawJson(narration)) return NARRATION_REFUSALS.rawJson
  const facts = recordFacts(record)
  const knownPath = (token) => facts.paths.has(token) || [...facts.paths].some((known) => known.endsWith(`/${token}`))
  // Stages before numbers: `audit:r9` must be refused as an invented STAGE, not
  // silently reduced to the digit inside it.
  const stageDefect = narrationStageDefect(narration, record)
  if (stageDefect) return stageDefect
  for (const match of narration.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) {
    if (!knownPath(trimPathToken(match[0]))) return NARRATION_REFUSALS.unknownFact
  }
  for (const match of narration.matchAll(/\b[A-Za-z0-9_-]+\.(?:mjs|js|ts|json|md|ya?ml)\b/g)) {
    if (!knownPath(trimPathToken(match[0]))) return NARRATION_REFUSALS.unknownFact
  }
  for (const match of narration.matchAll(/\d+/g)) {
    if (!facts.numbers.has(match[0])) return NARRATION_REFUSALS.unknownFact
  }
  return null
}

export function narrateRecord({ record, registerText, io } = {}) {
  const config = narratorConfig(registerText)
  if (config.refused) return { refused: config.refused }
  const ask = (command) => {
    try { return io?.run?.(command) } catch (err) { return { ok: false, threw: String(err?.message || err) } }
  }
  const listed = ask(narratorModelsCommand(config.root))
  if (!listed?.ok) return { refused: NARRATION_REFUSALS.unreachable, why: listed?.threw }
  const model = narratorModelId(listed.output)
  if (model.refused) return { refused: model.refused, why: model.why }
  const chat = ask(narratorCommand({ root: config.root, model: model.id, prompt: narrationPrompt(record) }))
  if (!chat?.ok) return { refused: NARRATION_REFUSALS.unreachable, why: chat?.threw }
  const text = narrationFromResponse(chat.output)
  if (!text) return { refused: NARRATION_REFUSALS.unreadable }
  const defect = narrationDefect(text, record)
  if (defect) return { refused: defect }
  return { text, model: model.id }
}

// The publish wiring, as a pure function so it can be gated: ONLY accepted narration
// reaches the record. A refusal leaves the record — and therefore the published body
// — byte-identical to a run with no narrator at all.
export function applyNarration(record, narrated) {
  const text = typeof narrated?.text === 'string' ? narrated.text.trim() : ''
  if (!text) return record
  return { ...record, narrative: text }
}

// --- the driver ----------------------------------------------------------------
// ctx: { task, briefFile, taskDir, checkout, roles: [..seated roles..],
//        lane: <fallback validation command|null>, suite: <full-suite command>,
//        protectedPaths: <resolved per-checkout paths>,
//        laneFence?: [{lane, files:[..]}] — OTHER lanes' write surfaces; absent = unfenced,
//        protectedPathsBasis: <why those paths are in force>,
//        journal: <real journal.jsonl path (lives in the CREW dir)>,
//        env?: <environment for the suite-slot admission; defaults to process.env>,
//        limits?, waits?: {<role>: <seconds>} — the per-role seat wait budget overlay (resolveWaits/waitsCtx above) }
// io:  { assign({role, briefFile, note}) -> {id, returnPath},
//        wait(returnPath, timeoutS) -> envelope|null,
//        writeFile(path, content) -> void, readFile(path) -> string|null,
//        run(cmd) -> {ok, output},            // shell, cwd=checkout
//        runClean(cmd) -> {ok, output},      // OPTIONAL: run cmd against the
//                                            // checkout with the uncommitted
//                                            // changes temporarily set aside
//        runCold(cmd, names) -> {ok, output, path, kept},
//                                            // OPTIONAL: run cmd in a FRESH checkout
//                                            // cut at a NEUTRAL path; THROWS rather
//                                            // than report a verdict it could not take
//        reseat(role, {reason}) -> closed result // OPTIONAL, never load-bearing
//        changedFiles() -> [repo-relative..], // git status --porcelain paths
//        commit(files, message) -> hash,
//        log(obj) -> void,                    // journal line (code-owned)
//        slots({dir, kind, capacity}) -> {acquire, release}  // OPTIONAL: the suite-slot pool; absent => crew/reclaim.mjs slotStore
//        sleep(ms) -> void  // OPTIONAL: the slot poll delay; absent => a synchronous nap
//        emit(event) -> void,                 // OPTIONAL: mirror a drive event to the factory ledger; instrumentation is NEVER load-bearing
//        createDraftPr({title, body}) -> {number, url},  // OPTIONAL: factory-mode
//        createIssue({title, body})   -> {number, url},  // gh seam. Both present
//                                                     // => the converge terminal is armed;
//                                                     // absent (every shipped io today)
//                                                     // => behavior is exactly as before.
//        now() -> ms }
// #583 — the CLOSED set of throws that must still ESCAPE driveTask rather than
// become this run's escalation envelope. A seat refusal is a permanent provider
// rejection: a TRANSPORT classification the child maps to its own outcome, and
// crew/crew.test.mjs:3888 pins that the identical error object escapes with its
// provider text intact. Module-private: nothing outside this file branches on it.
const CRASH_ESCAPE_STAGES = Object.freeze(['seat-refused'])

// ONE `details` shape for both of this driver's exits. A deliberate escalation and
// a CRASH are both outcomes of the same run, and the crash is the one an operator
// most needs to resume: b254-retryvis crashed at `builder: no valid envelope
// within 2700s` holding a gate-green build, and its envelope recorded no head, no
// gate and no cursor because the throw left driveTask (thrown at
// crew/drive.mjs:1936, boundary at crew/drive.mjs:3484) and was mapped to a
// four-key envelope by crew/crew.mjs:1848 (and crew/child.mjs:166) — neither of
// which can see this closure. Catching HERE is the only place the stage list, the
// gate block, the cursor and the seat high-water marks still exist.
export function driveTask(ctx, io) {
  const crash = { envelope: null }
  try {
    return runTask(ctx, io, crash)
  } catch (err) {
    if (err && CRASH_ESCAPE_STAGES.includes(err.stage)) throw err
    // A throw before the recorder is armed is a CALLER contract violation — an
    // unknown variant, an unexecutable shape — with no run behind it: no stages,
    // no journal rows, nothing to resume. It keeps throwing exactly as today.
    if (!crash.envelope) throw err
    // A recorder that cannot record must not replace the crash it was recording.
    try { return crash.envelope(err) } catch { throw err }
  }
}

function runTask(ctx, io, crash) {
  const variant = ctx.variant ?? DEFAULT_VARIANT
  if (!VARIANT_NAMES.includes(variant)) {
    throw fail('variant', `unknown variant ${JSON.stringify(variant)} — the closed set is: ${VARIANT_NAMES.join(', ')}`)
  }
  const shape = VARIANTS[variant]
  const declarationDefect = shapeDefect(shape, variant)
  if (declarationDefect) {
    throw fail('variant', `the ${variant} shape's declaration cannot be honoured: ${declarationDefect}`)
  }
  const limits = { ...LIMITS, ...(ctx.limits || {}) }
  const waits = { ...WAITS_S, ...(ctx.waits || {}) }
  const S = { consults: 0, stages: [], commit: null, dissents: [], grants: [], growth: [], modifiers: [], enforcements: [], acceptFindings: null, seqHighWater: 0, planAccept: null, carried: [], carriedCleared: new Set() }
  const art = (name) => `${ctx.taskDir}/${name}`
  const pendingEnforcement = new Map()
  let enforcementSeq = 0
  // The journal lives in the CREW dir, not the task dir — take its real path
  // from ctx so decision briefs and escalation artifacts never cite a 404.
  const journal = ctx.journal || art('journal.jsonl')
  let gateBlock = () => null
  // One shape for every terminal, under the details key this driver already uses
  // for a typed accept (crew/drive.mjs:3246,3255,3322,3331): a plan-check accept
  // that recorded something is in the run's record wherever the run ends, and a
  // run that never reached one adds no key at all, so the loop every lane runs
  // stays byte-identical without it. It is spread BEFORE ...extraDetails in
  // escalate(), so a LATER terminal's own accept_decision still wins the envelope
  // and the superseded plan-check row stays in the journal.
  const acceptDecisionBlock = () => (S.planAccept ? { accept_decision: S.planAccept } : {})
  const carriedOpen = () => S.carried.filter((f) => !S.carriedCleared.has(f.id))
  const carriedBlock = () => {
    const open = carriedOpen().map((f) => ({ id: f.id, severity: f.severity, correction: f.correction, round: f.round }))
    return open.length > 0 ? { carried: open } : {}
  }

  // Instrumentation is never load-bearing (ADR-024/026 clause 1): the
  // emitter itself never throws, and this try/catch means an io that does
  // still cannot change a run's outcome, exit code, or timing.
  const emit = (event) => { try { io.emit?.(event) } catch { /* never load-bearing */ } }

  // Ask for one rung on a bounce. Nothing here may change a run's outcome
  // (ADR-024/026 clause 1): an absent, throwing, or refusing reseat leaves the
  // loop behaving exactly as it does without this modifier. Every ATTEMPT is
  // recorded — the record is the deliverable, the upgrade is a bonus.
  // The budget is spent by an APPLIED upgrade, not by an attempt. A refusal is
  // per-seat and per-transport: in the shape factory mode actually boots
  // (`--headless-all --tier build`), builder and reviewer are headless-rpc seats
  // that refuse in this slice while planner and lead are headless-json seats
  // that can re-seat — so spending on the first refused builder bounce would
  // mean the modifier could never fire on the seats that support it. The one
  // exception is an io with no `reseat` method at all: that is a static property
  // of the io, it cannot change mid-run, and re-asking would record the same
  // fact once per bounce.
  let upgradeSpent = false
  const failureUpgrade = (kind, role) => {
    let entry
    try {
      if (upgradeSpent) {
        entry = { outcome: 'spent', why: 'the task failure-upgrade budget was already spent' }
      } else if (typeof io.reseat !== 'function') {
        upgradeSpent = true
        entry = { outcome: 'transport', why: 'this io provides no reseat' }
      } else {
        const result = io.reseat(role, { reason: `${kind}-bounce` })
        if (result?.applied === true) {
          upgradeSpent = true
          entry = { outcome: 'applied', from: result.from, to: result.to, rung: result.rung }
        } else {
          entry = {
            outcome: MODIFIER_OUTCOMES.includes(result?.reason) ? result.reason : 'transport',
            why: result?.why ?? null,
            from: result?.from ?? null,
          }
        }
      }
    } catch (err) {
      entry = { outcome: 'transport', why: `io.reseat threw: ${err?.message ?? err}` }
    }
    const record = { modifier: FAILURE_UPGRADE, kind, role, ...entry }
    try { S.modifiers.push(record); io.log(recordRow({ at: io.now(), modifier: record })) } catch { /* never load-bearing */ }
    emit({
      kind: 'modifier', modifier: record.modifier, bounce: kind, role,
      outcome: record.outcome, why: record.why ?? null,
      from: record.from ?? null, to: record.to ?? null, rung: record.rung ?? null,
    })
  }

  // The sensitivity floor: a plan whose declared scope touches a protected path
  // gets the JUDGE tier's reviewer cell or the run stops. Refuse-not-reroute
  // (ADR-032 family): the escalation is load-bearing by design, the RECORD is
  // not — every firing, honoured or inert, is a modifier_attempts row.
  const sensitivityFloor = (hits) => {
    let entry
    try {
      if (typeof io.reseat !== 'function') {
        entry = { outcome: 'transport', why: 'this io provides no reseat, so the judge reviewer cell cannot be seated' }
      } else {
        const result = io.reseat('reviewer', { reason: SENSITIVITY_FLOOR, tier: JUDGE_TIER })
        if (result?.applied === true) {
          entry = { outcome: 'applied', from: result.from ?? null, to: result.to ?? null, rung: result.rung ?? null,
            why: result.already === true ? 'the reviewer cell is already the judge tier cell' : null }
        } else {
          entry = { outcome: MODIFIER_OUTCOMES.includes(result?.reason) ? result.reason : 'transport',
            why: result?.why ?? null, from: result?.from ?? null }
        }
      }
    } catch (err) {
      entry = { outcome: 'transport', why: `io.reseat threw: ${err?.message ?? err}` }
    }
    const why = [`protected paths: ${hits.join(', ')}`, entry.why].filter(Boolean).join(' — ')
    const record = { modifier: SENSITIVITY_FLOOR, kind: 'plan-accept', role: 'reviewer', paths: hits, ...entry, why }
    try { S.modifiers.push(record); io.log(recordRow({ at: io.now(), modifier: record })) } catch { /* never load-bearing */ }
    emit({ kind: 'modifier', modifier: record.modifier, bounce: 'plan-accept', role: 'reviewer',
      outcome: record.outcome, why: record.why, from: record.from ?? null, to: record.to ?? null, rung: record.rung ?? null })
    return record
  }

  const openStages = []
  const stageComplete = () => {
    const label = openStages.pop()
    if (label === undefined) return
    io.log(recordRow({ at: io.now(), stage_done: label }))
  }
  const stage = (label) => {
    const violation = undeclaredStage(shape, label)
    if (violation) throw fail('variant', `the ${variant} shape ${violation}`)
    openStages.push(label)
    S.stages.push(label); io.log(recordRow({ at: io.now(), stage: label })); io.status?.(label); emit({ kind: 'stage', label })
  }

  // LAZY on purpose. slotPolicy THROWS on a malformed CREW_SUITE_SLOTS
  // (crew/reclaim.mjs:1151-1157), and crash.envelope is not armed until
  // crew/drive.mjs:2275. Resolving on first CPU phase — long after that line — makes a
  // malformed capacity the driver's own crash escalation instead of a throw that
  // escapes driveTask. There is NO catch anywhere below: a pool that cannot be built,
  // like an acquire that cannot answer, is not admission.
  let slotAdmit                       // undefined until the first CPU-bound phase
  let slotPool = null
  const slotPoolFor = () => {
    if (slotAdmit === undefined) slotAdmit = slotAdmission(ctx.env ?? process.env)
    if (!slotAdmit) return null
    if (slotPool === null) {
      const build = typeof io.slots === 'function' ? io.slots : slotStore
      slotPool = build({ dir: slotAdmit.root, kind: SUITE_SLOT_KIND, capacity: slotAdmit.capacity })
    }
    return slotPool
  }
  // Every io call is a METHOD call: `seatIo.runClean` reads `this`, and a detached
  // reference crashed a live driver once (crew/drive.mjs:2295-2303). The journal
  // forward uses this file's own remedy for that, `.call(io, …)` (crew/drive.mjs:2333),
  // for a second reason too: the source inventory's sink regex reads RAW source, so a
  // forwarder that spelled the plain call here would register as a journal site of its
  // own — one with no row wrapper, which is the shape the inventory refuses outright.
  const phaseSlot = (phase, run) => withPhaseSlot({
    pool: slotPoolFor(), phase, owner: `${ctx.task}:${phase}`,
    now: () => io.now(), log: (row) => io.log.call(io, row), emit,
    ...(typeof io.sleep === 'function' ? { sleep: (ms) => io.sleep(ms) } : {}),
  }, run)

  // Per-run gate invocation counter. The ledger's gate_results is UNIQUE on
  // (adw_id, gate_name, attempt) with INSERT OR IGNORE, so a repeated attempt
  // number silently DROPS a verdict — this counter is monotonic per run so
  // every invocation lands its own row. It is driver-owned on purpose: the
  // emitter's bumpGateAttempt answers 0 when degraded, which would collide.
  let gateAttempt = 0
  // The crash recorder is armed HERE, the first line at which escalationResult()
  // can run: it reads S, gateBlock and gateAttempt, all initialised above. Every
  // value crew/crew.mjs:1848 wrote is preserved — the summary keeps its `the driver
  // crashed (...)` wrapper, `where` stays `err.stage || 'driver'`, and `why` stays
  // the RAW message — so no downstream reader changes; only `details` grows.
  // `terminal: false` records no stage row: the journal is out of #583's scope.
  crash.envelope = (err) => {
    // ONE derivation, with a NULLISH fallback. `||` would substitute 'Error' for a
    // deliberately empty message, where crew/crew.mjs:1848 records '' and its
    // summary records `()`; crew/drive.mjs:1866 already uses `??` for the same job.
    const crashWhy = err?.message ?? String(err)
    return escalationResult({
      where: err?.stage || 'driver',
      why: crashWhy,
      summary: `Task ${ctx.task} needs a human: the driver crashed (${crashWhy})`,
      commit: S.commit ?? null,
      // A crash adds NO key of its own. The two exits' key sets are compared as
      // SETS, and a resume reader must never have to branch on which exit wrote
      // the record — so this stays empty rather than becoming a place to grow one.
      extraDetails: {},
      terminal: false,
    })
  }
  let lastGateOutput = null
  const finalReview = { verdict: null, residuals: [] }
  const gateReapTally = { invocations: 0, 'already-dead': 0, proven: 0, failed: 0, unproven: 0 }
  // `runner` is an io METHOD, so it must be invoked as one: `seatIo.runClean`
  // calls `this.run(cmd)` (crew/seat-io.mjs:241,245), and passing it detached
  // (`runGate(..., io.runClean)` below) made `this` undefined under ESM strict
  // mode — a live driver crash at `gate-reverify`. The fake io in
  // drive.test.mjs defines runClean as an arrow that never reads `this`, so
  // the contract's own specification could not express the requirement the
  // shipped implementation had. Bind here rather than forbid `this` in io
  // implementations: every other io call site in this file is a method call,
  // and this keeps that true for runners too.
  const runGate = (name, cmd, runner = io.run, pristine = false) => {
    gateAttempt += 1
    // The task dir, never the checkout: runClean stashes --include-untracked
    // around this call (crew/seat-io.mjs:1741-1753) and an untracked file in
    // the checkout would collide with the pop.
    const reapPaths = {
      cmdFile: art(`gate-reap.${gateAttempt}.cmd.sh`),
      launchFile: art(`gate-reap.${gateAttempt}.launch.sh`),
      pgidFile: art(`gate-reap.${gateAttempt}.pgid`),
      report: art(`gate-reap.${gateAttempt}.json`),
    }
    // Truncate FIRST. io.readFile returns any existing file verbatim
    // (crew/seat-io.mjs:1725-1726), and the attempt number resets with the
    // driver, so without this a prior run's `proven` could be read as this one's.
    // The flag is the whole point: a truncation that THREW leaves whatever is at
    // that path attributable to an earlier run, so the path is not read at all.
    let reportCleared = false
    try { io.writeFile(reapPaths.report, ''); reportCleared = true } catch { /* stays false: fail closed */ }
    const wrapped = gateReapCommand({ cmd, ...reapPaths })
    // The production seat io has runClean, and the drive fake advertises calls;
    // both can execute the composed wrapper. A ledger-only adapter used by the
    // integration seam exposes neither and keys its runner on the authored
    // command, so preserve that adapter's old contract rather than passing it a
    // shell program it cannot execute. Production never takes this branch.
    // Same predicate as the wrapper: an adapter that cannot execute the composed
    // program must not be handed the sweep either.
    const wrappable = io.calls || typeof io.runClean === 'function'
    let res
    try {
      res = phaseSlot(SUITE_SLOT_PHASES.gate, () => runner.call(io, wrappable ? wrapped : cmd))
    } finally {
      // Always io.run, never `runner`: runClean would stash a second time. This
      // is the only reap that survives a runner timeout, which kills the wrapper
      // before its own reap can run.
      if (wrappable) {
        try { io.run(gateReapSweepCommand(reapPaths)) } catch { /* an unswept group reads unproven */ }
      }
    }
    let reap
    try { reap = gateReapVerdict(gateReapFresh(reportCleared, io.readFile(reapPaths.report))) }
    catch { reap = gateReapVerdict(null) } // a read that threw measured nothing
    gateReapTally.invocations += 1
    gateReapTally[reap.outcome] += 1
    // `already-dead` is the nothing-happened case; the journal records the
    // invocations that signalled something or could not prove a death.
    if (reap.outcome !== 'already-dead') {
      io.log(operationalRow({ at: io.now(), gate_reap: { name, attempt: gateAttempt, ...reap } }))
    }
    emit({ kind: 'gate', name, attempt: gateAttempt, ok: !!res.ok, cmd, summary: parseGateSummary(res.output), generation: gateGeneration, pristine, reap })
    return res
  }
  // Attention fires ONLY where the gate loop stops being self-correcting:
  // exhaustion, or escalation of the build-vs-gate question to triage. A
  // red-then-green cycle is the loop working and raises nothing.
  // park_id is explicitly null: #125 mints park ids and has not landed.
  const gateAttention = (why, artifacts = []) =>
    emit({ kind: 'attention', moment: 'gate', park_id: null, task: ctx.task, why, artifacts })
  const gateEscalate = (why, extra = []) => { gateAttention(why, [journal, ...extra]); return escalate('gate', why, extra) }
  // The forked runner strips `lead` from ctx.roles for every tier while
  // ctx.seatedRoles keeps the real seating (`crew/child.mjs:96`). ctx.roles
  // answers whether this child may CONSULT a judge; gate custody is an
  // ASSIGNMENT, so use the same seat list the panel asks for below. Only a
  // genuinely lead-less mechanical crew (roster lead is null) escalates under
  // the existing 'gate' path and the same no_lead_escalation journal key; the
  // planner is not a fallback because its domain ended at acceptance.
  const seatList = Array.isArray(ctx.seatedRoles) ? ctx.seatedRoles : ctx.roles
  // A gate the CREW did not author has no custodian INSIDE it. The directed
  // shape's gate comes from the orchestrator's brief (ADR-030: the acceptance
  // criteria belong to whoever wrote them), so a defect LEAVES the crew instead
  // of being repaired by a seat that never wrote it. #334 moved custody to the
  // lead for reviewed shapes; this shape deliberately does not inherit that.
  const gateAuthoredOutside = shape.sources?.gate === 'brief'
  const noGateCustodian = () => gateAuthoredOutside || !seatList.includes(GATE_CUSTODIAN)   // ⚓ B3/B4/B5
  const gateCustodyEscalate = (diagnosis) => {
    const why = gateAuthoredOutside
      ? `the ${variant} gate is authored outside the crew by the orchestrator, so no seat may repair it — ${diagnosis}. Gate: ${gateCmd}`
      : `no lead seated (mechanical tier): the acceptance gate needs a repair this crew cannot make — ${diagnosis}. Gate: ${gateCmd}`
    io.log(recordRow({ at: io.now(), no_lead_escalation: why }))
    return gateEscalate(why)
  }

  // Factory-only terminal: an injected GH seam is the mode switch for this
  // slice. Without both methods every precondition returns before any extra
  // stage, run, log, or event, preserving the interactive path byte-for-byte.
  const convergeSettle = ({ why, where, gateOutput, gateRed = true }) => {
    if (typeof io.createDraftPr !== 'function' || typeof io.createIssue !== 'function') return null
    if (!builderEnv) return null
    if (!gateRed && gateOutput == null) return null
    if (gateRed && baselineGateDefect(gateOutput) !== null) return null

    const parsedGate = parseGateSummary(gateOutput)
    const gateSummary = {
      line: gateSummaryLine(gateOutput),
      output: String(gateOutput || ''),
      ...(parsedGate || {}),
    }

    stage('converge:suite')
    const suiteRes = phaseSlot(SUITE_SLOT_PHASES.warm, () => io.run(ctx.suite))
    if (!suiteRes.ok) {
      io.log(recordRow({ at: io.now(), converge_declined: 'suite red' }))
      emit({ kind: 'converge', action: 'declined', where: 'suite', why: 'suite red' })
      stageComplete()
      return null
    }

    stageComplete()
    stage('converge:issues')
    const residuals = residualList({ findings: S.lastReview?.findings ?? null, gateSummary, gateRed })
    if (residuals.length === 0) {
      io.log(recordRow({ at: io.now(), converge_declined: 'no residuals' }))
      emit({ kind: 'converge', action: 'declined', where: 'residuals', why: 'no residuals to record' })
      stageComplete()
      return null
    }
    const issues = []
    for (const residual of residuals) {
      if (residual.severity !== 'must-fix') continue
      let filed
      try {
        filed = io.createIssue({
          title: followUpIssueTitle({ task: ctx.task, residual }),
          body: followUpIssueBody({ task: ctx.task, residual, gateSummary, escalation: { where, why } }),
        })
      } catch (err) {
        const detail = err?.message ?? String(err)
        io.log(recordRow({ at: io.now(), converge_declined: 'issue filing failed', residual: residual.id, why: detail }))
        emit({ kind: 'converge', action: 'declined', where: 'issues', residual: residual.id, why: detail })
        stageComplete()
        return null
      }
      if (!filed || !Number.isInteger(filed.number)) {
        const detail = `malformed issue result for ${residual.id}`
        io.log(recordRow({ at: io.now(), converge_declined: 'issue filing failed', residual: residual.id, why: detail }))
        emit({ kind: 'converge', action: 'declined', where: 'issues', residual: residual.id, why: detail })
        stageComplete()
        return null
      }
      residual.issue = { number: filed.number, url: filed.url }
      issues.push({ number: filed.number, url: filed.url })
      emit({ kind: 'converge', action: 'issue-filed', residual: residual.id, number: filed.number })
    }

    stageComplete()
    stage('converge:commit')
    const message = composeCommitMessage({ task: ctx.task, planEnv, builderEnv })
    const hasCommitSubject = String(planEnv.details?.commit_subject || '').split('\n').some((line) => line.trim())
    if (!hasCommitSubject) io.log(recordRow({ at: io.now(), commit_subject: 'fallback-from-plan-summary' }))
    const committing = io.changedFiles().filter(inScope)
    S.commit = io.commit(committing, message)
    emit({ kind: 'converge', action: 'committed', commit: S.commit, files: committing.length })

    stageComplete()
    stage('converge:pr')
    let pr
    try {
      const carriedLines = carriedPrLines(carriedBlock().carried ?? [])
      pr = io.createDraftPr({
        title: draftPrTitle({ task: ctx.task }),
        body: draftPrBody({
          gateSummary,
          findings: residuals,
          escalation: { where, why },
          roundHistory: [...S.stages],
          gateRed,
        }) + (carriedLines.length > 0 ? `\n${carriedLines.join('\n')}\n` : ''),
      })
    } catch (err) {
      const detail = err?.message ?? String(err)
      stageComplete()
      return escalate(
        'converge-pr',
        `the work is committed at ${S.commit} but the draft PR could not be opened: ${detail}`,
        [],
        { commit: S.commit, converge: { pr: null, issues } },
      )
    }
    if (!pr || !Number.isInteger(pr.number) || typeof pr.url !== 'string' || pr.url.length === 0) {
      const detail = 'malformed draft PR result'
      stageComplete()
      return escalate(
        'converge-pr',
        `the work is committed at ${S.commit} but the draft PR could not be opened: ${detail}`,
        [],
        { commit: S.commit, converge: { pr: null, issues } },
      )
    }

    stageComplete()
    stage('converge')
    emit({ kind: 'converge', action: 'settled', commit: S.commit, pr: pr.number, issues: issues.length })
    const result = {
      status: 'converge',
      summary: `Task ${ctx.task} converged with residuals: committed ${S.commit} (${committing.length} files), suite green, ${gateRed ? 'gate red' : 'gate green with unresolved review findings'} — DRAFT PR #${pr.number}, ${issues.length} follow-up issue(s) filed. Merge authority stays human.`,
      artifacts: [planPath, journal],
      details: {
        commit: S.commit, stages: S.stages, files_committed: committing, consults: S.consults,
        dissents: S.dissents, accepted_via: null, escalation: { where, why },
        extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, enforcements: S.enforcements,
        gate: gateBlock(),
        ...acceptDecisionBlock(),
        ...carriedBlock(),
        converge: {
          pr: { number: pr.number, url: pr.url }, draft: true, issues, residuals,
          gate_summary: { line: gateSummary.line, total: gateSummary.total, failed: gateSummary.failed, errored: gateSummary.errored },
        },
      },
    }
    stageComplete()
    return result
  }

  // POST-RETURN adjudication of the per-role turn ceiling (#870 ASK 1). INERT
  // unless the operator configured a ceiling for THIS role: no ceiling -> no
  // journal read, no row, no envelope rewrite, which is what makes an unflagged
  // run byte-identical (criterion (b)).
  //
  // The census is BEST-EFFORT at both producers (crew/headless.mjs:705-707,
  // crew/headless-rpc.mjs:455-462, the latter inside neverLoadBearing), so it is
  // not load-bearing on its own: an observation the driver could not make is a
  // MEASUREMENT FAILURE carrying a closed reason, never a zero and never a
  // breach.
  function censusWindow() {
    try { return journalRowsSinceRunStart(readCensusText()) } catch { return null }
  }
  function readCensusText() {
    const text = io.readFile(journal)
    if (typeof text !== 'string') throw new Error('the turn census journal could not be read')
    return text
  }
  function enforceTurnCeiling(role, id, env) {
    const budget = ctx.turnCeilings?.[role]
    if (!Number.isFinite(budget)) return env
    // The EXISTING anti-replay and shape guard runs FIRST, before any journal
    // read or rewrite. A stale or mis-addressed envelope must reach the
    // unusable-envelope failure this driver already has
    // (crew/drive.mjs:2595-2603); manufacturing this dispatch's assignment_id
    // around it would launder exactly the replay validEnvelope exists to refuse.
    if (!validEnvelope(env, role, id)) return env
    const observed = observeTurnCensus(censusWindow(), id, role)
    // An explicit RPC no-envelope settlement is not a returned envelope at all:
    // emptyTurnEnvelope PASSES validEnvelope, so only the producer's own outcome
    // can tell the two apart. Return it untouched and journal nothing.
    if (observed.adjudicate === false) return env
    const breached = turnCeilingBreached(observed.turns, budget)
    const measured = observed.turns !== null
    io.log(recordRow({ at: io.now(), seat_turn_ceiling: { role, dispatch: id, turns: observed.turns, budget, measured, enforced: breached, absent_reason: observed.absent } }))
    if (!breached && measured) return env
    return {
      assignment_id: id, role, status: 'insufficient',
      summary: measured
        ? `${SEAT_TURN_CEILING_EVENT}: ${role} returned after ${observed.turns} turns against a role budget of ${budget}; the envelope was rejected`
        : `${SEAT_TURN_CEILING_EVENT}: ${role}'s turn census is unavailable (${observed.absent}), so its budget of ${budget} could not be measured; the envelope was rejected`,
      artifacts: Array.isArray(env.artifacts) ? env.artifacts : [],
      details: { turn_ceiling: { turns: observed.turns, budget, absent_reason: observed.absent }, rejected_status: env?.status ?? null },
    }
  }

  function assignAndWait(role, briefFile, note) {
    let brief = briefFile
    const pending = pendingEnforcement.get(role)
    if (pending) {
      pendingEnforcement.delete(role)
      enforcementSeq += 1
      brief = art(`enforcement-${role}-r${enforcementSeq}.md`)
      io.writeFile(brief, [
        `# Enforcement (${pending.kind})`, '',
        ...pending.lines, '',
        `Original brief: ${briefFile}`, '',
      ].join('\n'))
      io.log(recordRow({ at: io.now(), seat_enforcement: { role, kind: pending.kind, brief, applied: true } }))
    }
    const { id, returnPath } = io.assign({ role, briefFile: brief, note })
    const seq = /^d(\d+)$/.exec(id)?.[1]
    if (seq) S.seqHighWater = Math.max(S.seqHighWater, Number(seq))
    io.log(recordRow({ at: io.now(), assign: id, role, brief }))
    emit({ kind: 'assign', id, role, brief })
    const env = enforceTurnCeiling(role, id, io.wait(returnPath, waits[role] || 1200))
    const enforcement = enforcementPreamble(env)
    if (enforcement.lines.length > 0) {
      pendingEnforcement.set(role, enforcement)
      S.enforcements.push({ role, id, kind: enforcement.kind, lines: enforcement.lines })
      io.log(recordRow({ at: io.now(), seat_enforcement: { role, kind: enforcement.kind, dispatch: id, applied: false } }))
    }
    const review = reviewOutcome(role, env)
    emit({ kind: 'envelope', id, role, status: env?.status || 'no-envelope', ...(review ? { review } : {}) })
    if (review) io.log(recordRow({ at: io.now(), review_outcome: { dispatch: id, ...review } }))
    // The canonical set follows the rule lastReview already follows: a reviewer
    // envelope that CARRIES a findings array replaces it; one that carries no
    // findings key at all leaves it intact (#542). An EMPTY array is truthy and
    // therefore replaces — that is a reviewer saying "I looked and found
    // nothing", which IS a report. An ABSENT key is a seat that did not report,
    // and absence is not zero (#442). Clobbering here erased the whole accept
    // contract and committed on a record claiming zero residuals.
    const canonical = review?.findings && !reviewShapeDefect(env?.details) ? review.findings : null   // #800 R8
    if (canonical) { S.acceptFindings = canonical; S.lastReview = review }
    if (review?.findings_report && (review.findings_report.count_mismatch.length || review.findings_report.rejected.length)) {
      io.log(recordRow({ at: io.now(), review_findings_note: { dispatch: id, ...review.findings_report } }))
    }
    if (!validEnvelope(env, role, id)) {
      // env == null was already recorded by io.wait as a 'timeout'; this branch
      // is the seat that DID answer, with something the driver cannot use.
      if (env != null) emit({ kind: 'cell-failure', role, id, failure: 'unusable-envelope', stage: null, detail: `envelope at ${returnPath} failed the shape or anti-replay check` })
      const diagnosis = env == null ? io.waitDiagnosis?.(returnPath) : null       // verbatim: mutation A9
      throw fail(role, `no valid envelope at ${returnPath} within ${waits[role]}s${diagnosis?.text ? ` — ${diagnosis.text}` : ''}`)
    }
    io.log(recordRow({ at: io.now(), envelope: id, role, status: env.status }))
    return env
  }

  // Consult the lead: offer a closed option set, get a decision back.
  // Anything invalid, out-of-set, or timed out escalates. A first-round
  // 'second-opinion' answer triggers the code-mediated compounding hop.
  function consultLead(question, options, contextPaths, { exclude } = {}) {
    // Lead-optional (mechanical tier): with no judge seated there is nobody
    // to consult, so the consult short-circuits UP the ladder (code ->
    // orchestrator) without an assign — the ratified ladder, minus a rung
    // that does not exist. A seated lead reaches none of this: behavior
    // below is unchanged.
    if (!ctx.roles.includes('lead')) {
      const reason = `no lead seated (mechanical tier): ${question}`
      io.log(recordRow({ at: io.now(), no_lead_escalation: reason }))
      return { decision: 'escalate', reason }
    }
    S.consults += 1
    if (S.consults > limits.lead_consults) {
      return { decision: 'escalate', reason: `lead consult limit (${limits.lead_consults}) exhausted` }
    }
    // exclude: a seat whose own output is the thing under judgment cannot be
    // offered as the independent advisor on it.
    const targets = PERSPECTIVE_TARGETS.filter((r) => ctx.roles.includes(r) && r !== exclude)
    const first = askLead(question, options, contextPaths, { round: 1, targets })
    if (first.decision !== SECOND_OPINION) return first

    // Compounding hop (code-executed, one only). Invalid target -> escalate.
    const from = first.from
    if (!targets.includes(from)) {
      return { decision: 'escalate', reason: `second-opinion target ${JSON.stringify(from)} is not a seated judgment member` }
    }
    const pBrief = art(`perspective-${S.consults}.md`)
    io.writeFile(pBrief, [
      `# Perspective requested (consult ${S.consults})`, '',
      `You are advising a decision, not re-doing your role's work. The lead's`,
      `own view is deliberately not shared with you — answer independently`,
      `from your seat's knowledge; be direct about confidence.`, '',
      `## Question`, question, '',
      `## Possible outcomes (recommend exactly one)`,
      ...options.map((o) => `- ${o}`), '',
      `## Context files (read before answering)`,
      ...contextPaths.map((x) => `- ${x}`), '',
      `Reply with a ReturnEnvelope whose details are {"perspective": "<3-8 sentences>", "recommendation": "<one outcome>", "confidence": "high|medium|low"}.`,
    ].join('\n'))
    const pEnv = assignAndWait(from, pBrief, 'perspective')
    const advised = bounceTargetOf(pEnv.details?.recommendation, options)      // #751
    const recommendation = pEnv.status === 'done' && options.includes(advised) ? advised : null
    const perspective = pEnv.status === 'done'
      ? `${pEnv.details?.perspective || pEnv.summary || '(empty perspective)'} [recommends: ${recommendation || 'unstated'}; confidence: ${pEnv.details?.confidence || 'unstated'}]`
      : `(${from} returned ${pEnv.status}: ${pEnv.summary || 'no detail'})`
    io.log(recordRow({ at: io.now(), perspective_from: from, recommendation, consult: S.consults }))

    const second = askLead(
      `${question}\n\n## Independent perspective from ${from} (gathered unseeded)\n${perspective}`,
      options, contextPaths, { round: 2, targets: [] },
    )
    if (second.decision === SECOND_OPINION) {
      return { decision: 'escalate', reason: 'lead requested a second second-opinion — one hop is the bound' }
    }
    // Compounding policy (code-owned): synthesis by the lead, but divergence
    // is never silent, and it binds in exactly one direction —
    //   lead=accept vs advisor=escalate  -> ESCALATE (one judge asking for a
    //     human is enough on the lenient path; compounding may only ever
    //     strengthen an outcome toward safety, never weaken it);
    //   any other split -> lead prevails, dissent recorded for the human.
    if (recommendation && recommendation !== second.decision) {
      const dissent = { from, recommendation, lead_decision: second.decision, consult: S.consults }
      S.dissents.push(dissent)
      io.log(recordRow({ at: io.now(), dissent }))
      emit({ kind: 'dissent', ...dissent })
      if (second.decision === 'accept' && recommendation === 'escalate') {
        return { decision: 'escalate', reason: `lead accepted but ${from} independently recommended escalate — on the lenient path a single judge asking for a human is binding` }
      }
    }
    return second
  }

  function askLead(question, options, contextPaths, { round, targets, label = '' }) {
    const briefPath = art(`decision-${S.consults}${round === 2 ? 'b' : ''}${label ? `-${label}` : ''}.md`)
    const valve = round === 1 && targets.length > 0
      ? [`- ${SECOND_OPINION} (set details.from to one of: ${targets.join(', ')} — code will gather their independent view and re-ask you once)`]
      : []
    io.writeFile(briefPath, [
      `# Decision needed (consult ${S.consults}${round === 2 ? ', final round' : ''})`, '',
      `## Question`, question, '',
      `## Your options (answer with exactly one in details.decision)`,
      ...options.map((o) => `- ${o}`),
      ...valve, '',
      `## Context files (read before deciding)`,
      ...contextPaths.map((x) => `- ${x}`), '',
      `Reply with a ReturnEnvelope whose details are {"decision": <option>, "reason": "...", "guidance": "..."${round === 1 ? ', "from": "<role>" when requesting a second opinion' : ''}}.`,
      `guidance is REQUIRED when decision is bounce — it becomes the bounce brief's steer.`,
    ].join('\n'))
    const env = assignAndWait('lead', briefPath, label ? `decision-${label}` : round === 2 ? 'decision-final' : 'decision')
    const d = env.details || {}
    // Round 2: a repeat second-opinion passes through raw so consultLead can
    // name the one-hop bound precisely in its escalation reason.
    if (round === 2 && env.status === 'done' && d.decision === SECOND_OPINION) return { decision: SECOND_OPINION }
    const decided = bounceTargetOf(d.decision, options)      // #751
    const allowed = round === 1 && targets.length > 0 ? [...options, SECOND_OPINION] : options
    if (env.status !== 'done' || !allowed.includes(decided)) {
      return { decision: 'escalate', reason: `lead returned ${env.status}/${d.decision ?? 'no decision'} — treating as escalate` }
    }
    if (decided !== d.decision) io.log(recordRow({ at: io.now(), bounce_target_mapped: { answered: d.decision, treated_as: decided, consult: S.consults, round } }))
    io.log(recordRow({ at: io.now(), decision: decided, consult: S.consults, round, reason: d.reason }))
    emit({ kind: 'decision', decided, why: d.reason || '', consult: S.consults, round })
    return {
      decision: decided, reason: d.reason || '', guidance: d.guidance || '', from: d.from,
      residuals: d.residuals, refuted: d.refuted, answers: d.answers,
    }
  }

  // A lead-granted extra round at an exhaustion point that could not grant
  // before. `limits.extra_rounds` is the bound PER POINT, and it is enforced by
  // NOT OFFERING 'bounce' once spent — an out-of-set answer already escalates
  // (askLead), so a lead that asks anyway fails toward the human.
  const canGrant = (where) => {
    if (!EXTRA_ROUND_POINTS.includes(where)) throw new Error(`unknown extra-round point ${JSON.stringify(where)}`)
    return S.grants.filter((g) => g.where === where).length < limits.extra_rounds
  }
  const grant = (where, round) => {
    if (!EXTRA_ROUND_POINTS.includes(where)) throw new Error(`unknown extra-round point ${JSON.stringify(where)}`)
    S.grants.push({ where, round })
    io.log(recordRow({ at: io.now(), extra_round_granted: { where, round, consult: S.consults } }))
  }

  // The ONE composer for an escalation's 14-key `details`. The two exits differ
  // only in their explicit inputs. `terminal` decides whether a DELIBERATE
  // terminal stage is recorded: escalate() records `escalate:<where>` and completes
  // it exactly as it always has; the crash exit records nothing. `commit` is an
  // input because ORDINARY deliberate escalations are all pre-commit (io.commit is
  // crew/drive.mjs:3465, the last ordinary deliberate escalation is :3457) while a
  // CRASH can land after it — and a hard-coded `commit: null` beside a real commit
  // is a fabricated absence that reads as measured (#297). The post-commit
  // `converge-pr` escalations (crew/drive.mjs:1868,1878) keep overriding it through
  // extraDetails, which is why that spread stays LAST (crew/drive.test.mjs:5200).
  function escalationResult({ where, why, summary, commit, artifacts = [], extraDetails = {}, terminal }) {
    if (terminal) stage(`escalate:${where}`)
    const details = {
      stages: S.stages, escalation: { where, why }, commit, dissents: S.dissents,
      extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, enforcements: S.enforcements,
      gate: gateBlock(),
      ...acceptDecisionBlock(),
      ...carriedBlock(),
      seq_high_water: S.seqHighWater,
      gate_attempt_high_water: gateAttempt,
      cursor: roundCursor(S.stages),
      consults_spent: S.consults,
      accept_findings: S.acceptFindings,
      head: ctx.head ?? null,
      ...extraDetails,
    }
    const result = { status: 'escalation', summary, artifacts: [journal, ...artifacts], details }
    if (terminal) stageComplete()
    return result
  }

  function escalate(where, why, extraArtifacts = [], extraDetails = {}) {
    return escalationResult({
      where, why, summary: `Task ${ctx.task} needs a human: ${why}`,
      commit: null, artifacts: extraArtifacts, extraDetails, terminal: true,
    })
  }

  // Adjudicate ONE lead accept. PURE: no journal row, no emit, no S.planAccept.
  // settleAccept records exactly once, after the re-ask has had its turn, so a
  // corrected answer never leaves a false `escalated` row behind it — the ledger's
  // outcome column is a closed binary (scripts/factory/ledger.mjs:181) and the row
  // is written for the decision that STOOD.
  function adjudicateAccept(c, where) {
    const findings = S.acceptFindings
    const check = where === 'plan-check'
      ? validatePlanResiduals(c.residuals, c.refuted)
      : findings === null
        ? { ok: true, residuals: [], refuted: [], unverified: [], refuted_must_fix: [] }
        : validateAcceptDecision({ findings, residuals: c.residuals, refuted: c.refuted })
    const errors = check.errors || []
    const refusedMustFix = check.refuted_must_fix || []
    const outcome = check.ok && check.unverified.length === 0 && refusedMustFix.length === 0 ? 'accepted' : 'escalated'
    // The typed distinction (#715): a form error is a RETRY; unverified and
    // refuted_must_fix are well-formed and are a decision for a human.
    const refusal = outcome === 'accepted' ? null : errors.length > 0 ? 'malformed' : 'judgment'
    const errorWhy = errors.map(({ id, why }) => `${id ?? 'decision'} ${why}`)
    const unverifiedWhy = check.unverified.map((id) => `${id} is correctness-unverified`)
    const evidenceOf = (id) => check.refuted.find((entry) => entry.id === id)?.evidence ?? ''
    const refutedWhy = refusedMustFix.map((id) => `${id} is a must-fix the lead refuted, claiming: "${evidenceOf(id)}"`)
    const whyParts = [...errorWhy, ...unverifiedWhy, ...refutedWhy]
    const why = outcome === 'accepted' ? null
      : `${errors.length > 0 ? 'accept-with-residuals rejected' : 'accept-with-residuals escalated'}: ${whyParts.join('; ')}`
    const record = {
      where,
      outcome,
      refusal,
      findings_total: Array.isArray(findings) ? findings.length : 0,
      residuals: check.residuals,
      refuted: check.refuted,
      unverified: check.unverified,
      refuted_must_fix: refusedMustFix,
      errors,
    }
    return { ok: outcome === 'accepted', why, record, refusal, refusedMustFix: refusedMustFix.length > 0 }
  }

  const acceptContractFor = (where) => (where === 'plan-check' ? planAcceptContractLines() : acceptContractLines(S.acceptFindings))

  // The lead's answerBounceLines. NOT charged as a consult: this corrects the FORM
  // of an answer the lead has already given — it is not a second opinion — and
  // charging it would let a run whose consult budget is exactly spent lose the lane
  // to a field name all over again (consultLead returns escalate without asking
  // anyone once the budget is out, crew/drive.mjs:2010), which is the very defect
  // #715 exists to remove. The bound is structural instead: ACCEPT_REASKS per
  // settle, and a run settles an accept at most once per exhaustion point.
  function askAcceptCorrection(where, refused, contextPaths, reask) {
    io.log(recordRow({ at: io.now(), accept_reask: { where, reask, errors: refused.record.errors } }))
    emit({ kind: 'accept-reask', where, reask, errors: refused.record.errors })
    return askLead(
      [`Your accept at ${where} was refused because it is NOT WELL-FORMED. This is a form error, not a judgement on your decision.`,
        ...acceptBounceLines(refused.record.errors, acceptContractFor(where))].join('\n'),
      ['accept', 'escalate'], contextPaths, { round: 1, targets: [], label: `reask${reask}` },
    )
  }

  // Settle a lead accept at either exhaustion point. A missing findings array
  // is the older reviewer contract and remains a legacy accept; an explicit
  // array is always checked against the latest canonical set and recorded.
  // A MALFORMED answer is re-asked once before it can end the run (#715); a
  // `judgment` refusal is for a human and is never re-asked.
  function settleAccept(c, where, contextPaths = []) {
    let settled = adjudicateAccept(c, where)
    let reasked = 0
    for (let reask = 1; settled.refusal === 'malformed' && reask <= ACCEPT_REASKS; reask += 1) {
      const refused = settled
      const again = askAcceptCorrection(where, refused, contextPaths, reask)
      reasked = reask
      if (again.decision !== 'accept') {
        settled = { ...refused, why: `${refused.why} — re-asked once; the lead answered ${again.decision}: ${again.reason || 'no reason given'}` }
        break
      }
      settled = adjudicateAccept(again, where)
      if (!settled.ok) settled = { ...settled, why: `${settled.why} (re-asked once after: ${refused.why})` }
    }
    const record = { ...settled.record, reasked }
    // Conditional-LATEST state, not plan-only state: once a plan-check accept has
    // opened the slot, every later typed decision supersedes it, so the terminals
    // that pass no extraDetails (done at crew/drive.mjs:3388, converge at :1828)
    // return the decision that actually completed or converged the run rather than
    // a stale one. A run with no plan-check accept never opens the slot, which is
    // what keeps review and build exhaustion byte-identical.
    if (where === 'plan-check' || S.planAccept !== null) S.planAccept = record
    io.log(recordRow({ at: io.now(), accept_decision: record }))
    emit({ kind: 'accept-decision', ...record })
    return { ok: settled.ok, why: settled.why, record, refusedMustFix: settled.refusedMustFix }
  }

  const acceptQuestion = (question) => {
    const lines = acceptContractLines(S.acceptFindings)
    return lines.length > 0 ? `${question}\n\n${lines.join('\n')}` : question
  }

  // Fired at most once per run: the plan viewer is a singleton. Today plan
  // acceptance happens exactly once, so this is defensive — a future re-entry
  // into acceptance must never mount a second pane.
  let docShown = false

  // ---- 0b. ENVELOPE SHAPES (#251) --------------------------------------------
  // A shape whose execution is `envelope`: one declared seat, one written brief,
  // then the SAME mechanical scope check the reviewed loop uses, with the
  // in-scope set its declared write surface implies. No build seat, no acceptance
  // gate, no reviewer, no commit — what accepts it is the SHAPE OF ITS ENVELOPE,
  // which is deliberately not the reviewed shapes' vocabulary. Nothing here
  // branches on the shape's name: that is what makes the issue's other
  // envelope-only shape (`prompt`) a VARIANTS entry rather than new code.
  const driveEnvelopeShape = () => {
    const runs = (head) => stageEnabled(shape, head)
    const seat = shape.required_seats[0]
    const briefPath = art(`${variant}-brief.md`)
    stage(`${variant}:r1`)
    // The brief is a FILE, not a note: the pane transport discards `note`
    // (crew/seat-io.mjs:417) and the seat's charter would otherwise apply.
    io.writeFile(briefPath, [
      `# ${variant} assignment`, '',
      shape.assignment, '',
      "This assignment SUPERSEDES your charter's usual deliverable for this run.",
      `Task brief: ${ctx.briefFile}`,
      `Checkout: ${ctx.checkout}`,
      `Task dir: ${ctx.taskDir}`,
      ...(shape.writes === 'none' ? ['',
        'You may not create, edit or delete anything in the checkout. The driver checks',
        'mechanically that this run changed zero files, and stops the run if it did not.'] : []),
      '',
      'What accepts this assignment is the SHAPE OF YOUR ENVELOPE — there is no',
      'acceptance gate, no verdict and no commit. Return:',
      '  status: "done"',
      '  summary: a non-empty sentence',
      `  artifacts: absolute paths you wrote, every one inside ${ctx.taskDir}`,
      ...shape.envelope_fields.map((f) => (f.kind === 'records'
        ? `  details.${f.name}: a non-empty array of records, each with a non-empty ${f.item_fields.join(' and a non-empty ')}`
        : `  details.${f.name}: a non-empty string`)),
    ].join('\n'))
    let env = null
    let seatFailure = null
    try {
      env = assignAndWait(seat, briefPath, variant)
    } catch (err) {
      // assignAndWait THROWS on a timeout or an unusable envelope. The zero-write
      // proof is this shape's whole product, so it is taken BEFORE the failure is
      // reported: a seat that wrote and then died must never be recorded as a
      // mere seat failure.
      seatFailure = err
    }
    stageComplete()
    if (runs('scope-gate')) {
      stage('scope-gate:r1')
      const outOfScope = outOfScopeFiles(io.changedFiles(), scopeMatcher([]))
      if (outOfScope.length > 0) {
        stageComplete()
        return escalate('scope',
          `a ${variant} run writes nothing, but the tree carries ${outOfScope.length} changed file(s): ${outOfScope.join(', ')}`,
          env?.artifacts || [])
      }
    }
    stageComplete()
    if (seatFailure) return escalate(variant, `the ${seat} seat failed: ${seatFailure.message}`)
    if (env.status !== 'done') {
      return escalate(variant, `the ${seat} seat returned status=${env.status}: ${env.summary || ''}`, env.artifacts || [])
    }
    const defect = envelopeDefect(env, shape, { taskDir: ctx.taskDir })
    if (defect) {
      return escalate('envelope', `the ${variant} envelope is not the shape that accepts it [${defect.reason}]: ${defect.why}`, Array.isArray(env.artifacts) ? env.artifacts : [])
    }
    stage('envelope-accept')
    const observedFields = envelopeFieldsPresent(env, shape)
    io.log(recordRow({ at: io.now(), envelope_accepted: { variant, seat, files_changed: 0, fields: observedFields } }))
    stageComplete()
    stage('done')
    const result = {
      status: 'done',
      summary: `${variant} ${ctx.task} complete: envelope accepted on shape, 0 files changed. Stages: ${S.stages.join(' | ')}`,
      artifacts: [journal, ...env.artifacts],
      details: {
        variant, commit: null, stages: S.stages, files_committed: [], consults: S.consults,
        dissents: S.dissents, accepted_via: shape.accepted_by, escalation: null,
        extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, enforcements: S.enforcements, gate: null,
        envelope: { seat, fields: observedFields, files_changed: 0 },
      },
    }
    stageComplete()
    return result
  }
  if (shape.execution === 'envelope') return driveEnvelopeShape()
  const driveTriageRound = () => {
    const inherited = shape.sources.scope === 'inherited' ? ctx.files_in_scope : null
    if (!Array.isArray(inherited) || inherited.length === 0) {
      return { stop: escalate('triage', `a ${variant} run inherits the failing run's files_in_scope and ctx carries none — the scope gate is never relaxed to let a repair run without a declared scope`) }
    }
    const inheritedErrors = validateScopeEntries(inherited)
    if (inheritedErrors.length > 0) {
      return { stop: escalate('triage', `files_in_scope carries entries the scope gate cannot honor — fix the inherited scope, not the repair: ${inheritedErrors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}`) }
    }
    const laneCmd = shape.sources.lane === 'ctx' ? ctx.lane : null
    if (!laneCmd) {
      return { stop: escalate('triage', `a ${variant} run takes its validation lane from the failing run (--lane) and ctx carries none`) }
    }
    stage(`${variant}:r1`)
    const briefPath = art(`${variant}-brief.md`)
    io.writeFile(briefPath, [
      `# ${variant} triage assignment`, '',
      shape.assignment, '',
      "This assignment SUPERSEDES the seat's usual deliverable for this run.",
      `Failure brief (verbatim): ${ctx.briefFile}`,
      `Checkout: ${ctx.checkout}`,
      `Task dir: ${ctx.taskDir}`,
      '',
      'Inherited files_in_scope (the failing run accepted this list):',
      ...inherited.map((entry) => `- ${entry}`),
      'You may NARROW this list, never widen it — a wider surface is an escalation, not a re-plan.',
      '',
      `Validation lane (fixed): ${laneCmd}`,
      'This shape runs NO acceptance gate — do not author one.',
      '',
      'Return contract:',
      '  status: "done"',
      '  summary: a non-empty sentence',
      `  artifacts: absolute paths you wrote, every one inside ${ctx.taskDir}`,
      '  details.plan_path: one of those artifacts, containing the triage note the builder will be briefed from',
      '  details.files_in_scope: optional narrowed scope, never wider than the inherited list',
      '  details.commit_subject / details.issues: optional',
    ].join('\n'))
    const env = assignAndWait('planner', briefPath, 'triage')
    if (env.status !== 'done') {
      stageComplete()
      return { stop: escalate('triage', `the triage seat returned status=${env.status}: ${env.summary || ''} — a ${variant} run's triage is bounded to one round, so there is no revision to bounce it to`, env.artifacts || []) }
    }
    const defect = envelopeDefect(env, shape, { taskDir: ctx.taskDir })
    if (defect) {
      stageComplete()
      return { stop: escalate('triage', `the triage envelope is not one the driver can build from: ${defect.why}`, Array.isArray(env.artifacts) ? env.artifacts : []) }
    }
    const planPath = env.details.plan_path
    if (typeof planPath !== 'string' || !env.artifacts.includes(planPath)) {
      stageComplete()
      return { stop: escalate('triage', `details.plan_path must name one of the artifacts the triage round wrote (it becomes the builder's first brief); found ${JSON.stringify(planPath ?? null)} against ${JSON.stringify(env.artifacts)}`, env.artifacts) }
    }
    let note = null
    try { note = io.readFile(planPath) } catch { note = null }
    if (typeof note !== 'string' || !note.trim()) {
      stageComplete()
      return { stop: escalate('triage', `the triage note at ${planPath} is empty or unreadable — the builder is briefed from that file and would be sent to a 404`, env.artifacts) }
    }
    if (shape.sources.gate === 'none' && env.details.gate_cmd) {
      stageComplete()
      return { stop: escalate('triage', 'the triage round returned a gate_cmd — this shape declares gate source "none", and a gate the crew authors for its own repair has no proof (ADR-030)', env.artifacts) }
    }
    const asked = env.details.files_in_scope
    let scope = inherited
    if (asked !== undefined) {
      if (!Array.isArray(asked) || asked.length === 0) {
        stageComplete()
        return { stop: escalate('triage-scope', 'the triage round returned an empty or non-array files_in_scope; it may narrow the inherited scope, but may not remove the declared scope') }
      }
      const askedErrors = validateScopeEntries(asked)
      if (askedErrors.length > 0) {
        stageComplete()
        return { stop: escalate('triage-scope', `files_in_scope carries entries the scope gate cannot honor — fix the triage, not the build: ${askedErrors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}`, env.artifacts) }
      }
      const extra = outOfScopeFiles(asked, scopeMatcher(inherited))
      if (extra.length > 0) {
        stageComplete()
        return { stop: escalate('triage-scope', `the triage round asked to widen the inherited scope with ${extra.join(', ')} — a triage that needs a wider surface is an escalation, not a re-plan`, env.artifacts) }
      }
      scope = asked
    }
    io.log(recordRow({ at: io.now(), triage: {
      variant, seat: 'planner', scope_source: shape.sources.scope, lane_source: shape.sources.lane,
      gate_source: shape.sources.gate, inherited: inherited.length, scope: scope.length,
    } }))
    stageComplete()
    return { plan: {
      status: 'done', role: 'planner', summary: env.summary,
      artifacts: env.artifacts,
      details: {
        plan_path: planPath,
        files_in_scope: scope,
        validation_lane: laneCmd,
        commit_subject: env.details.commit_subject,
        issues: env.details.issues,
      },
    } }
  }
  const driveDirectedRound = () => {
    stage(`${variant}:r1`)
    let text = null
    try { text = io.readFile(ctx.briefFile) } catch { text = null }
    const directed = parseDirectedBrief(text)
    if (directed.defect) {                                                     // ⚓ B2
      stageComplete()
      return { stop: escalate(variant, `the ${variant} brief at ${ctx.briefFile} is not a plan this driver can build from: ${directed.defect} — its gate and write surface are the orchestrator's to author, so there is no seat to bounce this to`) }
    }
    const laneCmd = shape.sources.lane === 'ctx' ? ctx.lane : null
    if (!laneCmd) {
      stageComplete()
      return { stop: escalate(variant, `a ${variant} run takes its validation lane from the dispatch (--validation-lane) and ctx carries none`) }
    }
    io.log(recordRow({ at: io.now(), directed: {
      variant, seat: null, scope_source: shape.sources.scope, lane_source: shape.sources.lane,
      gate_source: shape.sources.gate, scope: directed.files_in_scope.length,
    } }))
    stageComplete()
    return { plan: {
      status: 'done', role: null, summary: `directed by the task brief at ${ctx.briefFile}`,
      artifacts: [ctx.briefFile],
      details: {
        plan_path: ctx.briefFile,
        files_in_scope: directed.files_in_scope,
        validation_lane: laneCmd,
        gate_cmd: directed.gate_cmd,
      },
    } }
  }
  const plans = stageEnabled(shape, 'plan') // does this shape plan, or inherit?
  let planEnv = null
  let planBrief = ctx.briefFile
  // A bounce that has its own machine-readable reason sets this; it is CONSUMED once, so
  // the plan-check bounces keep the 'plan-revision' note they have always carried (#843).
  let planNote = null
  let extraPlanRounds = 0
  let divergenceConsulted = false
  const readOrNull = (path) => { try { const text = io.readFile(path); return typeof text === 'string' ? text : null } catch { return null } }
  // Read ONCE, before the first check round: the driver overwrites plan-check.md
  // on every round (:3091), so a later read returns this run's own output.
  const adoptedCheckText = readOrNull(art('plan-check.md'))
  const adoption = adoptionSignal({ briefText: readOrNull(ctx.briefFile), planCheckText: adoptedCheckText })
  let predecessorChecked = adoption.predecessor_checked
  const planRounds = () => planRoundCap({ limits, adopted: adoption.adopted, predecessorChecked, extraPlanRounds })
  io.log(recordRow({ at: io.now(), plan_round_cap: {
    adopted: adoption.adopted, predecessor_checked: predecessorChecked,
    reason: adoption.reason, cap: planRounds(),
  } }))
  const lineage = adoption.adopted ? lineageFromJournal(readOrNull(journal)) : null
  if (lineage) io.log(recordRow({ at: io.now(), plan_lineage: lineage }))
  if (lineage && lineage.divergent) {
    const c = consultLead([
      `This lane ADOPTED a plan from ${lineage.archive}: the adopted plan+gate measure ${lineage.combined_bytes} bytes against the LINEAGE's baseline of ${lineage.baseline_bytes} — the growth is the lineage's, not this lane's, and no plan round has run yet.`,
      ...divergenceConsultLines({ round: 1, combined_bytes: lineage.combined_bytes, round1_combined_bytes: lineage.baseline_bytes, ratio: lineage.ratio, divergent: true }, { decisions: 'proceed and escalate' }),
    ].join('\n'), ['proceed', 'escalate'], [ctx.briefFile, art('plan.md')])
    if (c.decision === 'escalate') return escalate('plan', c.reason)
  }
  const planRevisionBrief = (round, check) => {
    const checkPath = check.details?.check_path || art('plan-check.md')
    return [
      `# Plan revision (round ${round})`, '',
      `Revise plan.md per the check at ${checkPath}. Close every must-fix. Original brief: ${ctx.briefFile}`,
      ...applyPrescriptionLines('the plan check'),
      '',
      ...growthLines(S.growth.at(-1)),
    ].join('\n')
  }
  for (let round = 1; plans && round <= planRounds(); round += 1) {
    stage(`plan:r${round}`)
    const env = assignAndWait('planner', planBrief, planNote ?? (round === 1 ? 'plan' : 'plan-revision'))
    planNote = null
    if (env.status !== 'done') {
      const asked = parseQuestions(env.details)
      const questions = asked?.questions ?? []
      if (asked) io.log(recordRow({ at: io.now(), member_questions: { role: 'planner', round, total: questions.length, ids: questions.map((q) => q.id), rejected: asked.rejected } }))
      const c = consultLead(
        [`The planner returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce it with guidance, or escalate?`,
          ...questionConsultLines('planner', questions)].join('\n'),
        ['bounce', 'escalate'], [planBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') {
        stageComplete()
        return escalate('plan', c.reason, env.artifacts || [])
      }
      const matched = matchAnswers(questions, c.answers)
      if (questions.length > 0) io.log(recordRow({ at: io.now(), question_answers: { role: 'planner', round, answered: matched.answered.map((a) => a.id), unanswered: matched.unanswered, rejected: matched.rejected } }))
      const b = art(`plan-bounce-r${round}.md`)
      failureUpgrade('plan', 'planner')
      io.writeFile(b, [
        `# Plan bounce (round ${round})`, '', c.guidance, '',
        `Original brief: ${ctx.briefFile}`,
        `Planner said: ${env.summary || env.status}`,
        ...answerBounceLines(questions, matched),
      ].join('\n'))
      planBrief = b
      stageComplete()
      continue
    }
    // #843 — the dispatched write surface is a CEILING: a replan may NARROW it, never
    // WIDEN it. The triage/repair shape has held this rule since crew/drive.mjs:2972.
    // Checked on EVERY round, not only the accepted one, because a bounce is reachable
    // only from inside this loop and the lead's "accept the latest plan anyway" path
    // would otherwise let a widened envelope through. Measured against
    // ctx.files_in_scope every round and never against the previous plan: otherwise one
    // bounce launders the swap it was raised to correct. Placed before the carve check
    // because the surface promise is a precondition of considering the plan at all, and
    // a bounce is cheaper than a plan-carve escalation; slices obey the same rule anyway.
    // The DISPATCHED side is validated by every dispatch path before driveTask sees it;
    // the PLANNED side is not validated until crew/drive.mjs:3201-3210, AFTER this loop.
    // scopeMatcher calls entry.endsWith('/') and repoRelativePath.startsWith(entry)
    // unconditionally, so a planner envelope carrying files_in_scope: [null] would THROW
    // here and never reach the typed escalate('plan', …) refusal that already exists for
    // it. So this comparison runs only on a planned scope the scope gate could honor;
    // anything else bypasses the block untouched and is refused, in one place, below.
    // Malformed planner output is NOT classified as narrowed, widened or undispatched —
    // it was never compared, and inventing a verdict for it would be the fabricated
    // reading the null in `dispatched` exists to avoid.
    const plannedScope = env.details?.files_in_scope
    const plannedComparable = Array.isArray(plannedScope) && plannedScope.length > 0
      && validateScopeEntries(plannedScope).length === 0
    if (plannedComparable) {
      const planScope = planScopeVerdict(ctx.files_in_scope, plannedScope)
      io.log(recordRow({ at: io.now(), plan_scope: { round, ...planScope } }))
      if (planScope.verdict === PLAN_SCOPE.widened) {
        const scopeFinal = round >= planRounds()
        if (scopeFinal) {
          stageComplete()
          return escalate(PLAN_SCOPE.widened, planScopeWhy(planScope, true), env.artifacts || [])
        }
        const b = art(`plan-bounce-r${round}.md`)
        failureUpgrade('plan', 'planner') // the kind the other three plan bounces already use
        io.writeFile(b, planScopeBounceLines(round, planScope, ctx.briefFile, ctx.files_in_scope).join('\n'))
        planBrief = b
        planNote = PLAN_SCOPE.widened
        planEnv = null
        stageComplete()
        continue
      }
    }
    // #915 — resolve the PLANNER's lane against the tree before accepting the plan. The
    // operator's ctx.lane is deliberately NOT read here: --lane is already the operator's
    // responsibility, and this seam exists only for the lane no seat may amend once it is
    // fixed at :3781. The probe goes through io.run because that is the only authoritative
    // type seam the driver has, and it already runs with cwd: checkout
    // (crew/seat-io.mjs:3100), so a relative input resolves the way the lane itself will.
    // A refusal is a BOUNCE while a plan round remains and an escalation only when none
    // does — the shape the widened-scope refusal above already uses. Reusing the `plan`
    // head is deliberate; it classifies `unclassified` in the ledger, like several other
    // `plan` escalations, and fixing that belongs to a ledger lane, not this fence.
    const laneAsked = env.details?.validation_lane
    if (typeof laneAsked === 'string' && laneAsked.trim()) {
      const laneResolved = resolveValidationLane(laneAsked, (inputs) => {
        let res = null
        try { res = io.run(laneProbeCommand(inputs)) } catch { return new Map() }
        return res && res.ok === true ? laneProbeKinds(res.output) : new Map()
      })
      io.log(recordRow({ at: io.now(), event: VALIDATION_LANE_EVENT, validation_lane_resolved: { round, shape: laneResolved.shape.shape, ...laneResolved.counts, refused: laneResolved.refused.map((row) => row.input) } }))
      if (laneResolved.refused.length > 0) {
        if (round >= planRounds()) {
          stageComplete()
          return escalate('plan', validationLaneWhy(laneResolved, true), env.artifacts || [])
        }
        const b = art(`plan-bounce-r${round}.md`)
        failureUpgrade('plan', 'planner')
        io.writeFile(b, validationLaneBounceLines(round, laneAsked, laneResolved, ctx.briefFile).join('\n'))
        planBrief = b
        planNote = VALIDATION_LANE_UNLOADABLE
        planEnv = null
        stageComplete()
        continue
      }
    }
    planEnv = env
    try {
      const bytesOf = (p) => {
        if (typeof p !== 'string' || !p) return null
        try {
          const content = io.readFile(p)
          return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : null
        } catch { return null }
      }
      const gatePathOf = (details) => {
        const value = details?.gate_path ?? null
        if (typeof value === 'string'
          && value.startsWith(`${ctx.taskDir}/`)
          && !value.split('/').some((segment) => segment === '.' || segment === '..')) return value
        try { io.log(recordRow({ at: io.now(), gate_path_rejected: value })) } catch { /* evidence only */ }
        return null
      }
      const record = growthRecord(S.growth.at(-1), S.growth[0], {
        round,
        plan_bytes: bytesOf(env.details?.plan_path || art('plan.md')),
        gate_bytes: bytesOf(gatePathOf(env.details)),
        files_in_scope_count: Array.isArray(env.details?.files_in_scope) ? env.details.files_in_scope.length : null,
      }, lineage)
      S.growth.push(record)
      io.log(recordRow({ at: io.now(), plan_growth: record }))
    } catch { /* measurement is never load-bearing */ }
    if (round === 1 && adoption.adopted && predecessorChecked === false && predecessorFindingsClosed(adoptedCheckText, readOrNull(env.details?.plan_path || art('plan.md')))) {
      predecessorChecked = true
      io.log(recordRow({ at: io.now(), plan_round_cap: { adopted: true, predecessor_checked: true, reason: PREDECESSOR_FINDINGS_CLOSED, cap: planRounds() } }))
    }
    if (round >= 2) {
      const carve = validateCarve(env.details)
      io.log(recordRow({ at: io.now(), carve_verdict: { round, verdict: carve.verdict, defect: carve.defect } }))
      if (!carve.verdict) {
        stageComplete()
        return escalate('plan-carve', carve.why, env.artifacts || [],
          { carve: { verdict: null, slices: [], defect: null } })
      }
      if (carve.verdict === 'carve') {
        stageComplete()
        return escalate('plan-carve',
          `the planner returned carve_verdict=carve on plan round ${round} — the plan is too large to build whole; the slices below are the human's starting point${carve.defect ? ` (slice list defect: ${carve.defect})` : ''}`,
          env.artifacts || [], { carve: { verdict: 'carve', slices: carve.slices, defect: carve.defect } })
      }
    }
    if (!ctx.roles.includes('tech-lead')) {
      stageComplete()
      break
    }
    stage(`check:r${round}`)
    const planPath = env.details?.plan_path || art('plan.md')
    const checkBrief = art(`check-brief-r${round}.md`)
    io.writeFile(checkBrief, [
      `# Plan check (round ${round})`, '',
      `Read the task brief at ${ctx.briefFile} and the plan at ${planPath}.`,
      `Falsify the plan's ground truth against the repo at ${ctx.checkout}.`,
      `Planner consult questions: ${JSON.stringify(env.details?.consult_questions || [])}`,
      `Write plan-check.md in the task dir. details.verdict must be approve or revise.`,
      '',
      ...growthLines(S.growth.at(-1)),
    ].join('\n'))
    const check = assignAndWait('tech-lead', checkBrief, 'plan-check')
    const v = verdictOf(check)
    if (v === 'pass') {
      stageComplete()
      stageComplete()
      break
    }
    const convergence = planConvergence({
      verdict: v,
      round,
      findings: planCheckFindings(check.details),
      priorClosed: check.details?.prior_findings_closed === true,
    })
    if (convergence.converged) {
      io.log(recordRow({ at: io.now(), plan_converged: { round, ids: convergence.carried.map((f) => f.id), severities: convergence.carried.map((f) => f.severity), reasons: [convergence.reason, 'blocker-absent'] } }))
      S.carried = convergence.carried
      stageComplete()
      stageComplete()
      break
    }
    // The point of decision. Exhaustion reaches it as it always did; a round
    // MEASURED divergent reaches it one round early, so the plan that is
    // growing is ended by a decision instead of discovered at exhaustion. The
    // early arrival costs no grant: rounds still remain, and the bounce is
    // funded by them. It is ADDITIONAL to a later exhaustion consult, never a
    // replacement for one — S.consults counts both.
    const growth = S.growth.at(-1)
    const diverging = growth?.round === round && growth.divergent === true
    const divergenceReady = diverging && !divergenceConsulted
    const exhausted = round >= planRounds()
    if (exhausted || divergenceReady) {
      if (divergenceReady) divergenceConsulted = true
      const fundable = !exhausted || canGrant('plan-check')
      const bounceOnly = convergence.blocker || round < 2
      if (bounceOnly && !fundable) {
        stageComplete()
        stageComplete()
        return escalate('plan-check', `the plan check returned a BLOCKER, or a finding malformed enough to be one, or is still at round 1, on round ${round}, and no plan round remains to bounce it — neither is ever accepted`)
      }
      const options = fundable ? (bounceOnly ? ['bounce', 'escalate'] : ['bounce', 'accept', 'escalate']) : ['accept', 'escalate']
      const c = consultLead(
        [
          exhausted
            ? `The plan check still says revise after ${round} round(s). Grant one more plan round, accept the latest plan anyway, or escalate?`
            : `The plan check says revise after ${round} round(s) and the plan is measured DIVERGING. Bounce it for another round, accept the latest plan anyway, or escalate?`,
          ...planAcceptContractLines(),
          ...divergenceConsultLines(diverging ? growth : null),
        ].join('\n'),
        options, [planPath, check.details?.check_path || art('plan-check.md')],
      )
      if (c.decision === 'escalate') {
        stageComplete()
        stageComplete()
        return escalate('plan-check', c.reason)
      }
      if (c.decision === 'bounce') {
        if (exhausted) { grant('plan-check', round); extraPlanRounds += 1 }
        const b = art(`plan-bounce-r${round}.md`)
        failureUpgrade('plan', 'planner')
        io.writeFile(b, planRevisionBrief(round, check))
        planBrief = b
        planEnv = null
        stageComplete()
        stageComplete()
        continue
      }
      // Accept RECORDS. b209-journalchannel escalated at this exact break because
      // it "records nothing": the lead knew the residual gap exactly and had
      // nowhere to put it, so it spent the run's escalation to say so in prose.
      const settledPlan = settleAccept(c, 'plan-check', [planPath, check.details?.check_path || art('plan-check.md')])
      if (!settledPlan.ok) {
        stageComplete()
        stageComplete()
        return escalate('plan-check', settledPlan.why)
      }
      finalReview.residuals = settledPlan.record.residuals || []
      stageComplete()
      stageComplete()
      break // accept: proceed on the latest plan, with the residual recorded
    }
    const b = art(`plan-bounce-r${round}.md`)
    failureUpgrade('plan', 'planner')
    io.writeFile(b, planRevisionBrief(round, check))
    planBrief = b
    planEnv = null
    stageComplete()
    stageComplete()
  }
  if (!plans) {
    const sourced = variant === DIRECTED_STAGE_HEAD ? driveDirectedRound() : driveTriageRound()   // ⚓ B1
    if (sourced.stop) return sourced.stop
    planEnv = sourced.plan
  }
  if (!planEnv) return escalate('plan', `no accepted plan within ${planRounds()} rounds`)
  const planPath = planEnv.details?.plan_path || art('plan.md')
  if (!docShown) { docShown = true; io.showDoc?.(planPath) }
  const scopeFiles = planEnv.details?.files_in_scope
  if (!Array.isArray(scopeFiles) || scopeFiles.length === 0) {
    return escalate('plan', 'planner envelope carries no files_in_scope — the scope gate cannot run without it', planEnv.artifacts || [])
  }
  const scopeErrors = validateScopeEntries(scopeFiles)
  if (scopeErrors.length > 0) {
    return escalate('plan',
      `files_in_scope carries entries the scope gate cannot honor — fix the plan, not the build: ${scopeErrors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}`,
      planEnv.artifacts || [])
  }
  const planFenceHits = laneFenceHits(scopeFiles, ctx.laneFence)
  if (planFenceHits.length > 0) {
    return escalate('scope',
      `the plan's files_in_scope crosses another live lane's fence: ${fenceBreachList(planFenceHits)} — this lane never edits another lane's write surface`,
      planEnv.artifacts || [])
  }
  const inScope = scopeMatcher(scopeFiles)
  const lane = planEnv.details?.validation_lane || ctx.lane
  if (!lane) return escalate('plan', 'no validation lane (neither planner envelope nor --lane provided)')
  const floorHits = protectedHits(scopeFiles, ctx.protectedPaths)
  if (floorHits.length > 0) {
    const floor = sensitivityFloor(floorHits)
    if (floor.outcome !== 'applied') {
      return escalate('sensitivity-floor',
        `the plan's files_in_scope touches protected paths (${floorHits.join(', ')}) and the sensitivity floor could not seat the judge tier's reviewer cell (${floor.outcome}${floor.why ? `: ${floor.why}` : ''}) — a protected change is never reviewed under an under-graded reviewer`,
        planEnv.artifacts || [])
    }
  }
  let gateCmd = planEnv.details?.gate_cmd || null
  const declared = planEnv.details?.mutations
  const mutations = declared == null ? [] : declared
  if (declared != null) {
    const mutationErrors = validateMutations(mutations, inScope)
    if (mutationErrors.length > 0) {
      return escalate('plan',
        `details.mutations carries entries the per-check proof cannot honor — fix the plan, not the build: ${mutationErrors.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join('; ')}`,
        planEnv.artifacts || [])
    }
    if (!gateCmd && mutations.length > 0) {
      return escalate('plan',
        'details.mutations declares per-check proofs but the plan authored no gate_cmd — there is nothing for a mutation to redden',
        planEnv.artifacts || [])
    }
  }
  let gateRepairs = 0
  let gateReverified = null // set only when a MID-RUN repair is accepted:
  const gateHistory = [] // every replaced gate_cmd, for the human's audit trail
  let gateGeneration = 1
  let gateProvenGeneration = null // the generation whose proof is already recorded
  let gateDiscrimination = null   // 'proven' | 'failed' | 'unproven'
  let gateProofNote = null        // operator-facing detail, set only on a contained throw
  let gateProofOutput = null
  let checkProofs = null       // rows for the CURRENT generation, non-null once its pass completed
  let checkProofOutput = null  // the mutated run of the first check that was not killed
  let checkProofNote = null    // a CONTAINED io failure during the pass (never loses a build)
  let checkProofVerdict = null // 'proven' | 'failed' | 'unbound' | 'unproven' | null — the PER-CHECK
  let checkProofPending = null // the generation that OWES a per-check pass, awaiting an observed green
  let checkProofBinds = []     // #874 — the bind report's rows, one per declared ANCHOR, terminal
  let checkProofUnbound = []   // the unresolved disagreements, taken from that report
  let checkProofBindMeasured = false   // the ALL-OR-NOTHING measurement sentinel: true only after
                                       // bindMutationDeclarations returned every row
  let gateProofFatal = null    // the built tree still carries a mutation: the run must stop
  gateBlock = () => (gateCmd ? { cmd: gateCmd, repairs: gateRepairs, generation: gateGeneration, discrimination: gateDiscrimination ?? 'unproven', reap: { ...gateReapTally }, ...(gateProofNote ? { discrimination_note: gateProofNote } : {}), ...(gateHistory.length ? { replaced: gateHistory } : {}), ...(gateReverified !== null ? { reverified: gateReverified } : {}), ...(checkProofs ? { check_discrimination: checkProofVerdict, check_discriminations: checkProofs } : {}), ...(checkProofNote ? { check_proof_note: checkProofNote } : {}), ...(checkProofBindMeasured && checkProofBinds.some((row) => row.status === 'absent') ? { mutation_bind: bindReport(), mutation_binds: checkProofBinds } : {}) } : null)
  const resetCheckProof = () => {
    checkProofs = null; checkProofOutput = null; checkProofNote = null
    checkProofVerdict = null; checkProofPending = null
    checkProofBinds = []; checkProofUnbound = []; checkProofBindMeasured = false   // ANCHOR A3
  }
  // #874 — the driver's io stays the only file authority; the exported binder takes repo-relative
  // paths and this resolves them, exactly as the mutation loop already does.
  const readBuilt = (file) => io.readFile(`${ctx.checkout}/${file}`)
  // #874 (1)(3) — the bind report. `checks` is the per-check closed status set the acceptance
  // wording asks to be JOURNALED — an aggregate cannot say WHICH declaration was absent — and the
  // counts beside it are what the ledger ingests. `absent: 0` on an all-bind lane is a MEASURED
  // zero: a pass that found nothing is not a pass that did not run.
  // MUTATION G1: count every row as absent and an all-bind lane's report claims a drift that did
  // not happen — the rate loses its meaning in the direction that manufactures alarm.
  const bindReport = () => ({
    generation: gateGeneration,
    declared: checkProofBinds.length,
    exact: checkProofBinds.filter((row) => row.status === 'exact').length,
    normalized: checkProofBinds.filter((row) => row.status === 'normalized').length,
    absent: checkProofBinds.filter((row) => row.status === 'absent').length,                         // ANCHOR G1
    corrected: checkProofBinds.filter((row) => row.correction === 'accepted').length,
    checks: checkProofBinds.map((row) => ({ check: row.check, file: row.file, status: row.status })),
  })
  // #874 (1) — a plan/build disagreement. NOT `checkProofVerdict === 'failed'`: the driver's own
  // vocabulary says only `survived` indicts the gate (crew/drive.mjs:1432), and gate custody cannot
  // repair this one at all.
  const checkProofDisagreement = () => checkProofUnbound.length > 0
  const recordGateProof = (label) => {
    resetCheckProof()                     // FIRST, before every early return: a
    gateProvenGeneration = gateGeneration  // generation never inherits the previous
    const settleProof = (summary) => {
      io.log(recordRow({ at: io.now(), gate_discrimination: gateDiscrimination, gate_generation: gateGeneration, gate_summary: summary, gate_proof_note: gateProofNote }))
      emit({ kind: 'discrimination', generation: gateGeneration, verdict: gateDiscrimination, summary, note: gateProofNote })
    }
    if (typeof io.runClean !== 'function') {
      gateDiscrimination = 'unproven'
      settleProof(null)
      return null
    }
    stage(label)
    let pristine
    try {
      pristine = runGate(label, gateCmd, io.runClean, true)
    } catch (err) {
      gateDiscrimination = 'unproven'
      gateProofNote = err.message
      io.log(recordRow({ at: io.now(), gate_proof_unproven: err.message, gate_generation: gateGeneration }))
      settleProof(null)
      stageComplete()
      return null
    }
    gateProofOutput = pristine.output
    const defect = pristine.ok
      ? "the gate is STILL green at baseline (pristine tree, the builder's changes set aside), so its verdict does not depend on the work"
      : baselineGateDefect(pristine.output)
    gateDiscrimination = defect ? 'failed' : 'proven'
    gateProofNote = defect // null when proven; the throw path sets it above
    if (gateDiscrimination === 'proven' && mutations.length > 0) checkProofPending = gateGeneration
    settleProof(parseGateSummary(pristine.output))
    stageComplete()
    return pristine
  }
  // Two CLASSES, two sentences, distinguishable by machine and not only by a reader
  // (#733). A binding failure is a PLAN/BUILD disagreement — the plan predicted source
  // the builder did not write; `survived` keeps today's wording, because it is the one
  // outcome that indicts the gate.
  const percheckNote = (row) => (MUTATION_BINDING_FAILURES.includes(row?.outcome)
    ? `the per-check mutation for ${JSON.stringify(row?.check)} did not BIND to the built tree: ${row?.why} — the plan predicted source the builder did not write`
    : `the per-check proof did not kill ${JSON.stringify(row?.check)}: ${row?.why}`)
  const proofNote = () => (checkProofVerdict === 'failed'
    ? percheckNote((checkProofs || []).find((row) => row.outcome !== 'killed' && row.outcome !== 'exempt'))
    : gateProofNote)
  const completeCheckProof = (label) => {
    checkProofPending = null
    stage(label)
    const rows = []
    let survivor = null
    let active = null            // the ONE mutation in flight: {abs, original, writeAttempted}
    let corrections = { entries: [], refusals: [] }
    try {
      // #874 (1) — the bind check runs FIRST, for EVERY declaration, before a single mutation is
      // written, and its report is assigned IMMEDIATELY: from here it is the authority on which
      // anchors reached the built tree, so a pass interrupted later still knows. It is inside the
      // try because io.readFile may throw and an interrupted pass must settle `unproven` rather
      // than lose the build.
      // MUTATION A1: hand this the empty list and no declaration is ever bind-checked — the
      // b381-journalfacts and b384-suiteslot blind spot, restored.
      const binds = bindMutationDeclarations(mutations, readBuilt)                                   // ANCHOR A1
      checkProofBinds = binds.map((row) => ({ ...row, correction: 'none' }))
      // #874 — set ONLY here, and only after every declaration was read: bindMutationDeclarations
      // either returns all rows or throws, so reaching this line is exactly the condition
      // "a completed bind check measured this window". Nothing downstream may publish a count
      // without it. MUTATION A3 flips the reset above, not this line, because a mutant that never
      // measures anything is silent while one that always claims to have measured is the defect.
      checkProofBindMeasured = true
      corrections = validateMutationCorrections(builderEnv?.details, binds, mutations, readBuilt)
      // MUTATION C1: drop the accepted candidates here and the builder's one authoring moment is
      // discarded — a corrected anchor never reaches the proof and b384's lane escalates as it did.
      const effective = correctedMutations(mutations, binds, corrections.entries)                    // ANCHOR C1
      for (const [index, mutation] of effective.entries()) {
        if (mutation.exempt) {
          rows.push({ check: mutation.check, outcome: 'exempt', why: mutation.exempt, file: null, summary: null })
          continue
        }
        const abs = `${ctx.checkout}/${mutation.file}`
        active = { abs, original: null, writeAttempted: false }
        const original = io.readFile(abs)          // may throw: nothing written yet
        active.original = original
        if (original === null) {
          rows.push({ check: mutation.check, outcome: 'unapplied', file: mutation.file, summary: null,
            why: `${mutation.file} does not exist in the built tree` })
          active = null
          continue
        }
        const bound = applyMutationAnchor(original, mutation.find, mutation.replace)
        if (bound.text === null) {
          rows.push({ check: mutation.check, outcome: BINDING_OUTCOME[bound.mode], file: mutation.file, summary: null,
            why: bindingWhy(bound.mode, mutation.file) })
          active = null
          continue
        }
        let res = null
        try {
          active.writeAttempted = true
          io.writeFile(abs, bound.text)
          res = runGate(mutationLabel(label, index), gateCmd)
        } finally { io.writeFile(abs, original) }
        active = null                              // restored: nothing in flight
        const summary = parseGateSummary(res.output)
        const wantedLine = JSON.stringify(`${CHECK_FAIL_PREFIX} ${mutation.check}`)
        const why = res.ok
          ? 'the gate stayed GREEN under the mutation'
          : baselineGateDefect(res.output)
            || (checkFailureLine(res.output, mutation.check)
              ? null
              // The label IS on a line and only its DELIMITER is wrong: say so, and
              // name what is accepted, so nobody hunts a print that never went missing.
              : checkLabelMisdelimited(res.output, mutation.check)
                ? `the gate went red and DID print ${wantedLine}, but with a delimiter the driver does not read: the label must END THE LINE or be followed by a colon (${wantedLine} or ${JSON.stringify(`${CHECK_FAIL_PREFIX} ${mutation.check}: why`)}) — the print is not missing, its delimiter is wrong`
                : `the gate went red but printed no ${wantedLine} line, so the check that failed is not the one under proof`)
        rows.push({ check: mutation.check, outcome: why ? 'survived' : 'killed', file: mutation.file, summary, why })
        // #874 — a corrected anchor that leaves its check green is the BUILDER's refusal, not a
        // gate defect. An UNcorrected survivor is untouched and still indicts the gate.
        if (why) { if (!mutation.corrected) survivor ??= rows[rows.length - 1]; checkProofOutput ??= res.output }
      }
    } catch (err) {
      checkProofNote = err?.message || String(err)
      io.log(recordRow({ at: io.now(), gate_check_proof_unproven: checkProofNote, gate_generation: gateGeneration }))
      gateProofFatal = dirtyAfterFailure(active, err)
    }
    // #874 — finalize BEFORE anything reads: bindReport(), settleCheckProof() and
    // anchorAbsentWhy() all see terminal states only.
    const finalized = finalizeCorrections(checkProofBinds, corrections, rows)
    checkProofBinds = finalized.binds
    checkProofUnbound = finalized.unresolved
    rows.splice(0, rows.length, ...finalized.rows)
    checkProofs = rows
    // #733/#874 — three precedences, and each matters. A KNOWN survivor is a gate defect even if
    // the pass was later interrupted. An interrupted pass with no survivor proved nothing and may
    // never claim `proven`. `unbound` sits between them: it is neither a gate defect nor an absence
    // of evidence but a MEASURED plan/build disagreement — the only one of the three that gate
    // custody cannot repair. A survivor still WINS the verdict, so a real gate defect is never
    // hidden by a disagreement recorded beside it; the ROUTE is decided separately, below.
    // MUTATION B2: report an unresolved anchor as `failed` and the record indicts a gate that
    // proved everything it was given; `survived` stops being the only gate defect.
    checkProofVerdict = survivor ? 'failed' : checkProofDisagreement() ? 'unbound' : checkProofNote ? 'unproven' : 'proven'   // ANCHOR B2
    settleCheckProof()
    stageComplete()
    return survivor
  }

  const mutationLabel = (label, index) => `${label}:m${index + 1}`

  // BYTE IDENTITY, not inference. `includes(replace) && !includes(find)` is not a
  // comparison: it misses a failed restore whose replacement CONTAINS the find
  // text, and it misfires when either text occurs elsewhere. One read, one whole-
  // string compare, and only when this driver actually wrote.
  const dirtyAfterFailure = (active, err) => {
    if (!active || !active.writeAttempted) return null   // nothing of ours is in the tree
    let current
    try { current = io.readFile(active.abs) }
    catch (readErr) { return `${active.abs} could not be re-read after a failed per-check mutation (${readErr?.message ?? String(readErr)}; original failure: ${err?.message ?? String(err)})` }
    if (current === active.original) return null
    return `${active.abs} does not match the built content after a per-check mutation (${current === null ? 'the file is gone' : 'byte comparison failed'}): ${err?.message ?? String(err)}`
  }

  // Every path that can produce a REPLACEMENT gate says this, because the
  // declaration is fixed for the task: the two PRE-BUILD fixes
  // (crew/drive.mjs:1871 vacuous-green, :1892 defective-baseline) and the mid-run
  // repair. A rename in any of them manufactures a survivor and burns the sole
  // gate-repair budget restoring declaration/gate agreement.
  const stableIdentifierNote = () => [
    '',
    'KEEP YOUR CHECK IDENTIFIERS STABLE. This plan declared per-check mutations and that',
    `declaration is FIXED for the task: ${mutations.map((m) => m.check).join(', ')}.`,
    `A failing check must print \`${CHECK_FAIL_PREFIX} <check>\` or \`${CHECK_FAIL_PREFIX} <check>: <reason>\` on its own`,
    'line, with the identifier matching /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (no spaces, no colons).',
    'A renamed check cannot be re-declared and reads as a mutation that killed nothing.',
  ].join('\n')

  // The ADDITIVE record: its own journal line and its own event kind, beside the
  // untouched whole-gate `discrimination` record. Today's ledger adapter ignores
  // an unknown kind (crew/seat-io.mjs:226-232) and scripts/factory/ledger.mjs is
  // fenced to lane b36, so persistence beside gate_discriminations is a follow-up
  // lane, by decision, not by omission.
  const settleCheckProof = () => {
    // #874 (1)(3) — the bind report and its absences go FIRST, before the discrimination row they
    // are ABOUT: a reader replaying the journal must know which declarations reached the built tree
    // before it reads the verdict computed from them. This row is written on EVERY bind-check pass,
    // which is what gives the drift rate a denominator rather than a bare count.
    // ...but ONLY when a completed bind check measured them. An interrupted preflight journals
    // NEITHER key: the ledger window stays unmeasured rather than recording a zero denominator,
    // and journalFactFamily's own absent reason is then the honest answer for that window.
    if (checkProofBindMeasured) io.log(recordRow({ at: io.now(), mutation_anchor_bind: bindReport() }))
    for (const bind of (checkProofBindMeasured ? checkProofBinds : []).filter((row) => row.status === 'absent')) {
      // #874 (3) — one row per disagreement, EITHER WAY: the check, the file and the TERMINAL
      // correction state, so a human amending a fixed envelope has every fact the amendment needs.
      io.log(recordRow({ at: io.now(), mutation_anchor_absent: { generation: gateGeneration, check: bind.check, file: bind.file, correction: bind.correction, refusal: bind.correction_refusal ?? null, why: bind.why } }))
    }
    io.log(recordRow({ at: io.now(), gate_check_discrimination: checkProofVerdict, gate_generation: gateGeneration,
      gate_check_discriminations: checkProofs, ...(checkProofNote ? { gate_check_proof_note: checkProofNote } : {}) }))
    emit({ kind: 'check-discrimination', generation: gateGeneration, verdict: checkProofVerdict,
      checks: checkProofs, note: checkProofNote ?? null })
  }

  // Accept a lead-returned replacement gate: a NEW generation (identity is
  // the driver's, not the command string) that must prove itself on the
  // pristine tree before it is trusted against the already-built tree.
  const acceptRepairedGate = (cmd, label) => {
    gateHistory.push(gateCmd)
    gateCmd = cmd
    gateGeneration += 1
    recordGateProof(label)
    gateReverified = gateDiscrimination === 'proven'
  }

  // ADR-030 §3: a failed proof is a GATE defect. The lead repairs it once,
  // against the SAME single gate_repairs budget the reviewer-triage path uses,
  // and the builder is NEVER bounced for evidence about the gate (#153 burned
  // nine stages on exactly that misroute). The repair consumes no builder
  // round. `unproven` is not `failed` and never reaches here: absence of
  // evidence may not become a new way to lose a build.
  //
  // The loop runs at most twice: each pass spends budget, so the second failed
  // proof falls into the escalation above it. That is what bounds a task at
  // `1 + gate_repairs` pristine runs — reaching a third is a bug, not a budget
  // question.
  // Returns { escalation } | { repaired: bool }.
  const settleFailedProof = () => {
    let repaired = false
    while (true) {
      if (gateProofFatal) {
        return { escalation: gateEscalate(`the per-check proof could not restore the built tree: ${gateProofFatal} — the run stops rather than commit the driver's own mutation. Gate: ${gateCmd}`) }
      }
      // `unproven` is NOT `failed` and never reaches a repair: absence of evidence
      // may not become a new way to lose a build (ADR-030 ratification amendment).
      if (gateDiscrimination !== 'failed' && checkProofVerdict !== 'failed') break
      if (gateRepairs >= limits.gate_repairs) {
        return { escalation: gateEscalate(`the acceptance gate did not prove it discriminates and the single gate repair is spent — ${proofNote()}. Gate: ${gateCmd}`) }
      }
      if (noGateCustodian()) return { escalation: gateCustodyEscalate(proofNote()) }
      gateRepairs += 1
      stage(`gate-repair:${gateRepairs}`)
      const b = art('gate-discrimination-bounce.md')
      io.writeFile(b, [
        '# Gate repair: the acceptance gate does not DISCRIMINATE (one repair allowed per task)',
        '',
        'You hold gate custody: after the plan is accepted the gate is the crew\'s',
        'acceptance criteria, not the planner\'s draft. Read the plan, then the gate.',
        '',
        'The build is GREEN against the acceptance gate — but the driver ran the SAME',
        "gate on the PRISTINE (pre-build) tree, with the builder's changes stashed away,",
        `and the result is not proof that the gate measures the work: ${proofNote()}.`,
        '',
        'A gate whose verdict does not depend on the work cannot accept it.',
        '',
        'Pristine run (verbatim, last 2000 chars):',
        String(gateProofOutput || '').slice(-2000),
        ...(checkProofs ? [[
          '',
          'Per-check rows:',
          ...checkProofs.map((row) => `- ${row.check}: ${row.outcome} — ${row.why}`),
          '',
          'Mutated run output (verbatim, last 2000 chars):',
          String(checkProofOutput || gateProofOutput || '').slice(-2000),
        ].join('\n')] : []),
        ...(mutations.length > 0 ? [stableIdentifierNote()] : []),
        '',
        'Preserve the old gate under a .r1 suffix, then fix it so it checks exactly what',
        'the brief asked — you may NOT weaken or delete a legitimate check, and it must',
        'print a final GATE-SUMMARY {"total":<n>,"failed":<n>,"errored":0} line.',
        'Return the (possibly identical) gate_cmd in details.',
        '',
        `Gate: ${gateCmd}`,
        `Plan: ${planPath}`,
        `Brief: ${ctx.briefFile}`,
      ].join('\n'))
      const rep = assignAndWait(GATE_CUSTODIAN, b, 'gate-repair')
      if (!(rep.status === 'done' && rep.details?.gate_cmd)) {
        stageComplete()
        return { escalation: gateEscalate(`the gate could not be repaired after a failed discrimination proof (${GATE_CUSTODIAN} returned ${rep.status}: ${rep.summary || 'no detail'}) — ${proofNote()}. Gate: ${gateCmd}`) }
      }
      acceptRepairedGate(rep.details.gate_cmd, `gate-reverify:${gateRepairs}`)
      repaired = true
      stageComplete()
    }
    return { repaired }
  }

  if (gateCmd) {
    stage('gate-baseline')
    const baseline = runGate('gate-baseline', gateCmd)
    if (baseline.ok) {
      if (noGateCustodian()) {
        stageComplete()
        return gateCustodyEscalate('the gate ran GREEN at baseline, so it is vacuous or the work already exists')
      }
      stageComplete()
      stage('gate-baseline:green-bounce')
      const b = art('gate-vacuous-bounce.md')
      io.writeFile(b, `# Gate bounce: baseline ran GREEN\n\nYou hold gate custody after plan acceptance: read the plan, then repair the gate.\n\nThe plan's acceptance gate passed BEFORE any work was built. Either the gate does not actually check the requested change, or the work already exists. Fix the gate (or report the work as already done via status insufficient):\n\n    ${gateCmd}\n\nOutput:\n${baseline.output.slice(-2000)}\n\nOriginal brief: ${ctx.briefFile}${mutations.length > 0 ? stableIdentifierNote() : ''}`)
      const env2 = assignAndWait(GATE_CUSTODIAN, b, 'gate-fix')
      if (env2.status !== 'done' || !env2.details?.gate_cmd) {
        stageComplete()
        return gateEscalate(`baseline-green gate could not be repaired (${GATE_CUSTODIAN} returned ${env2.status}: ${env2.summary || 'no detail'})`)
      }
      gateHistory.push(gateCmd)
      gateCmd = env2.details.gate_cmd
      const re = runGate('gate-baseline:recheck', gateCmd)
      if (re.ok) {
        stageComplete()
        return gateEscalate('repaired gate STILL green at baseline — vacuous acceptance cannot be built against')
      }
      // Red — but red HOW? (#153, #440). The repaired gate exits non-zero exactly
      // as a gate whose every check THREW does, so without the same recheck the
      // defective-red branch applies below, a repair may trade a vacuous green
      // for a broken gate and the driver would build against it. Like the bounce
      // above this is pre-build hygiene: it consumes no gateRepairs.
      const greenRepairDefect = baselineGateDefect(re.output)
      if (greenRepairDefect) return gateEscalate(`the gate repaired after a GREEN baseline did not RUN at baseline: ${greenRepairDefect}`)
    } else {
      // Red — but red HOW? (#153) Non-zero exit is also what a gate whose
      // every check throws produces, and at baseline everything is red, so a
      // broken check is invisible until the implementation makes it
      // reachable — nine stages later, with the one gate repair already spent.
      // This bounce is pre-build hygiene and deliberately does NOT consume
      // gateRepairs, exactly like the vacuous-green bounce above.
      let defect = baselineGateDefect(baseline.output)
      if (defect) {
        if (noGateCustodian()) {
          stageComplete()
          return gateCustodyEscalate(`the gate did not RUN at baseline: ${defect}`)
        }
        stageComplete()
        stage('gate-baseline:defect-bounce')
        const b = art('gate-defect-bounce.md')
        io.writeFile(b, `# Gate bounce: the gate did not RUN\n\nYou hold gate custody after plan acceptance: read the plan, then repair the gate.\n\nThe plan's gate exited non-zero, but that is not proof it is red for the right reason: ${defect}.\n\nA baseline is only acceptable when every check RAN and failed. Repair the gate so it executes end to end, and print a final summary line the driver can read:\n\n    ${GATE_SUMMARY_PREFIX} {"total":<n>,"failed":<n>,"errored":0}\n\nDo not weaken or remove a check to make this pass — a check that cannot run must be FIXED, not deleted. Preserve the old gate under a suffixed copy.\n\nGate: ${gateCmd}\n\nOutput:\n${baseline.output.slice(-2000)}\n\nOriginal brief: ${ctx.briefFile}${mutations.length > 0 ? stableIdentifierNote() : ''}`)
        const env3 = assignAndWait(GATE_CUSTODIAN, b, 'gate-fix')
        if (env3.status !== 'done' || !env3.details?.gate_cmd) {
          stageComplete()
          return gateEscalate(`defective gate could not be repaired (${GATE_CUSTODIAN} returned ${env3.status}: ${env3.summary || 'no detail'})`)
        }
        gateHistory.push(gateCmd)
        gateCmd = env3.details.gate_cmd
        const re = runGate('gate-baseline:recheck', gateCmd)
        if (re.ok) {
          stageComplete()
          return gateEscalate('repaired gate is GREEN at baseline — vacuous acceptance cannot be built against')
        }
        defect = baselineGateDefect(re.output)
        if (defect) {
          stageComplete()
          return gateEscalate(`repaired gate STILL does not run at baseline: ${defect}`)
        }
      }
    }
    stageComplete()
  }

  // ---- 2. BUILD + mechanical gates + REVIEW ------------------------------------
  let buildBrief = planPath
  let buildNote = 'build'
  let builderEnv = null
  let reviews = 0
  // The finish block runs ONLY when `accepted` is set — at review:pass or at
  // an explicit lead accept. No bounce, however granted, can fall out of the
  // loop into a commit: a final-round consult that grants "bounce once more"
  // EXTENDS the bound by one real round instead (bounded in turn by the
  // consult limit, so a looping judge still cannot loop the driver).
  let accepted = null
  let extraRounds = 0
  let extraReviews = 0
  let hardenOwed = { owed: [], exempt: [] }
  let hardenWitness = null              // Map<repo-relative path, {state, bytes}>, or null
  const witnessTree = (files) => {
    const witness = new Map()
    for (const file of Array.isArray(files) ? files : []) {
      let cell
      try { const bytes = io.readFile(`${ctx.checkout}/${file}`); cell = bytes === null ? { state: 'absent', bytes: null } : { state: 'read', bytes } }
      catch (err) { cell = { state: 'unreadable', bytes: null, why: err?.message || String(err) } }
      witness.set(file, cell)
    }
    return witness
  }
  // MUTATION B5b: drop the check name here and the ledger can no longer link a hardened
  // defect class to the guard that closed it.
  const logHardened = (round, row) => io.log(recordRow({ at: io.now(), finding_hardened: { round, finding: row.finding, test: row.test, check: row.name, outcome: row.outcome, why: row.why } }))   // ANCHOR B5b
  let lastReviewPath = art('review.md')
  let staleVerdict = null
  let panelBriefText = ''
  let panelBounceFindings = ''
  const panelStandingQuestion = 'state the invariant the prior rounds\' instances share; does this diff close it?'
  const panelLog = (entry) => {
    try { io.log(recordRow({ at: io.now(), ...entry })) } catch { /* panel evidence is never load-bearing */ }
  }
  const panelDegraded = (role) => panelLog({ panel_degraded: role })
  const panelReview = (n, panel) => {
    panelBounceFindings = ''
    stage(`review:panel-r${n}`)
    const panelInstructions = [
      '',
      'You are one of two independent reviewers on a regranted continuation round.',
      'Report typed findings in details.findings (id, severity from the closed set must-fix|should-fix|consider, location as path:line or path:start-end, summary).',
      'Return the identical details.verdict shape: verdict must be pass or changes-needed, with must_fix, should_fix, and consider counts.',
      'A must-fix whose defect class cannot become a mechanical guard may carry "hardening": "ungateable" with a non-empty "hardening_why"; only the reviewer may set it.',
    ].join('\n')
    const base = panelBriefText
    const aBrief = art(`panel-a-brief-${n}.md`)
    io.writeFile(aBrief, `${base}${panelInstructions}`)
    let aEnv = assignAndWait('reviewer', aBrief, 'panel-a')
    const reviewerAVerdict = verdictOf(aEnv)
    const reviewerAHasFindings = (reviewFindings(aEnv?.details)?.findings?.length || 0) > 0
    if (!aEnv || aEnv.status !== 'done' || !reviewerAVerdict) {
      panelDegraded('reviewer')
      stageComplete()
      return aEnv
    }
    // #800 R8 — a `pass` carrying a must-fix, or a finding id outside the closed shape,
    // is refused by SHAPE before the panel can adjudicate it away. No partner, no
    // adjudicator: reviewer A's envelope goes back to the outer loop unchanged, where
    // the ordinary refusal consult re-asks that reviewer. `assignAndWait` has already
    // declined to make it canonical (§1e). The row names the refusal the panel ACTUALLY
    // saw — a durable record saying `verdict-findings` for a `finding-id` defect is a
    // record of something that did not happen.
    const panelRefusal = reviewShapeDefect(aEnv.details)
    if (panelRefusal) {
      panelLog({ panel_skipped: panelRefusal.reason })
      stageComplete()
      return aEnv
    }

    const bBrief = art(`panel-b-brief-${n}.md`)
    const partnerInstructions = [
      panelInstructions,
      '',
      `For this assignment you are reviewing the diff, not re-doing your seat's work (partner role: ${panel.partner}).`,
      'Use the identical details.findings (id, severity, location, summary) and details.verdict shape.',
    ].join('\n')
    let bEnv
    try {
      io.writeFile(bBrief, `${base}${partnerInstructions}`)
      bEnv = assignAndWait(panel.partner, bBrief, 'panel-b')
    } catch {
      panelDegraded(panel.partner)
      stageComplete()
      return aEnv
    }
    if (!bEnv || bEnv.status !== 'done' || !verdictOf(bEnv)) {
      panelDegraded(panel.partner)
      stageComplete()
      return aEnv
    }

    const findingsOf = (env) => reviewFindings(env?.details)?.findings ?? []
    const fused = fuseFindings(findingsOf(aEnv), findingsOf(bEnv), {
      sourceA: 'reviewer', sourceB: panel.partner,
    })
    // #800 revision 2 — PANEL-LOCAL ID ALLOCATION. reviewFindings keeps the FIRST valid
    // entry for an id and drops every later duplicate (crew/drive.mjs:834-838), and the
    // panel's own array is fed straight back through it by dispositionPlan. The panel
    // mints the FIXED id `panel-class-${n}`, so a reviewer-origin finding already carrying
    // that id ERASES the adjudicator's class must-fix — the one finding that says the class
    // is NOT closed. needsSeat then comes back empty and the run takes the seat-free
    // re-review shortcut on a class the adjudicator explicitly refused to close. The same
    // collapse happens when reviewer A and the partner independently mint one id for two
    // divergent findings; adjudicatePanel keys its decisions on id alone
    // (crew/escalation-policy.mjs:141).
    // Allocate in ONE pass, in this order — consensus, divergent, then the synthetic class
    // finding — keeping the first occurrence UNCHANGED. THE ORDER IS WHAT MAKES REVIEWER A'S
    // ROUTING SAFE, and it is the whole reason no private id-shadow key is needed: A's
    // normalized ids are already unique (crew/drive.mjs:834-838); consensus carries A's id
    // (crew/escalation-policy.mjs:107-114); and `fuseFindings` orders divergences as ALL
    // unmatched A entries BEFORE all unmatched partner entries (:117-124). So every
    // reviewer-A id is allocated before any id that could collide with it and is never
    // reminted. Only a partner id or the synthetic class id can be reminted, and neither
    // authorizes A's patch. `accepted.get(finding.id)` below is therefore exact.
    const panelIds = new Set()
    let panelIdSeq = 0
    const allocId = (id, source) => {
      if (!panelIds.has(id)) { panelIds.add(id); return id }
      let minted = `panel-remint-${++panelIdSeq}`
      while (panelIds.has(minted)) minted = `panel-remint-${++panelIdSeq}`
      panelIds.add(minted)
      panelLog({ panel_id_reminted: { source, from: id, to: minted } })
      return minted
    }
    const allocatedConsensus = fused.consensus.map((finding) => ({ ...finding, id: allocId(finding.id, 'reviewer') }))
    const allocatedDivergent = fused.divergent.map((finding) => ({ ...finding, id: allocId(finding.id, finding.source) }))
    const structuredDivergences = allocatedDivergent.map(({ id, source, severity, location, summary }) => ({
      id, source, severity, location, summary,
    }))
    const divergenceLines = structuredDivergences.length > 0
      ? structuredDivergences.map((entry) => `- ${JSON.stringify(entry)}`)
      : ['- (none)']
    const adjBrief = art(`panel-adjudication-${n}.md`)
    const adjText = [
      `# Panel adjudication (round ${n})`,
      '',
      '## Structured divergences',
      ...divergenceLines,
      '',
      `## Plan of record: ${planPath}`,
      '',
      '## Standing class question',
      panelStandingQuestion,
      '',
      '## Required envelope details shape',
      '{"adjudications":[{"id":"<divergence id>","disposition":"uphold"|"dismiss","reason":"..."}],"class_invariant":"...","closes_class":true|false}',
    ].join('\n')
    let adjEnv
    try {
      io.writeFile(adjBrief, adjText)
      adjEnv = assignAndWait(panel.adjudicator, adjBrief, 'panel-adjudication')
    } catch {
      panelDegraded(panel.adjudicator)
      stageComplete()
      return aEnv
    }
    if (!adjEnv || adjEnv.status !== 'done') {
      panelDegraded(panel.adjudicator)
      stageComplete()
      return aEnv
    }

    const adjudicated = adjudicatePanel(allocatedDivergent, adjEnv.details)
    // #800 R4 — the panel rebuilds findings from the normalized shape, which carries no
    // patch. A reviewer-origin finding's routing must survive fusion or the panel
    // silently disables auto-fix and ask-user on exactly the rounds a continuation
    // needs them. DISMISSED findings are never re-attached: a dismissed finding must
    // not execute. The map is acceptedRawById, so a rejected entry can no more
    // authorize a patch here than it can on the ordinary path.
    const accepted = acceptedRawById(aEnv.details)
    // #839 — the panel must be able to REFUSE a partner's or an adjudicator's mark,
    // which means it must first be able to SEE one: a rule that cannot see the thing it
    // forbids cannot be proven to forbid it. Both sides' raw entries are indexed WITH
    // their origin; only a reviewer-origin mark is ever reattached. Reviewer A's ids are
    // never reminted (crew/drive.mjs:3711-3718), so the consensus lookup is exact.
    const markById = new Map()
    for (const [origin, env] of [['reviewer', aEnv], [panel.partner, bEnv]]) {
      for (const [id, raw] of acceptedRawById(env?.details)) {
        const mark = hardeningOf(raw)
        if (mark && !markById.has(id)) markById.set(id, { origin, fields: { hardening: mark, hardening_why: raw.hardening_why.trim() } })
      }
    }
    // MUTATION B7c: stop checking the mark's ORIGIN and a partner's or an adjudicator's
    // ungateable exempts a finding the reviewer never excused.
    const markOf = (id, origin) => { const m = markById.get(id); return m && m.origin === 'reviewer' && origin === 'reviewer' ? m.fields : {} }   // ANCHOR B7c
    const withRouting = (finding, origin) => {
      const raw = origin === 'reviewer' ? accepted.get(finding.id) : null
      if (!raw) return finding
      const disposition = dispositionOf(raw)
      return {
        ...finding,
        ...(disposition ? { disposition } : {}),
        ...(typeof raw.patch === 'string' && raw.patch.trim() !== '' ? { patch: raw.patch } : {}),
      }
    }
    const findings = [
      ...allocatedConsensus.map(({ id, severity, location, summary }) => ({ ...withRouting({ id, severity, location, summary, reviewer: 'both' }, 'reviewer'), ...markOf(id, 'reviewer') })),
      ...adjudicated.upheld.map(({ id, severity, location, summary, source }) => ({ ...withRouting({ id, severity, location, summary, reviewer: source }, source), ...markOf(id, source) })),
    ]
    if (adjudicated.closesClass !== true && !findings.some((finding) => finding.severity === 'must-fix')) {
      findings.push({
        id: allocId(`panel-class-${n}`, 'adjudicator'),
        severity: 'must-fix',
        location: null,
        summary: adjudicated.classInvariant || panelStandingQuestion,
        reviewer: 'adjudicator',
      })
    }
    panelBounceFindings = findings.map(({ id, severity, location, summary }) => (
      `- ${id} (${severity}) ${location || '(location unspecified)'} — ${summary || '(no summary)'}`
    )).join('\n')
    for (const dismissed of adjudicated.dismissed) {
      const dissent = {
        kind: 'panel-divergence',
        from: dismissed.source,
        finding_id: dismissed.id,
        severity: dismissed.severity,
        location: dismissed.location,
        summary: dismissed.summary,
        disposition: 'dismissed',
        reason: dismissed.reason,
        round: n,
      }
      S.dissents.push(dissent)
      panelLog({ dissent })
      emit({ kind: 'dissent', ...dissent })
    }

    // An older/valid reviewer envelope may carry a changes-needed verdict
    // without a surviving typed finding. An empty fusion must not turn that
    // single-review bounce into a pass merely because the partner was quiet.
    const verdict = findings.some((finding) => finding.severity === 'must-fix')
      || (reviewerAVerdict === 'revise' && !reviewerAHasFindings)
      ? 'changes-needed' : 'pass'
    const count = (severity) => findings.filter((finding) => finding.severity === severity).length
    const rawCount = (key) => Number.isInteger(aEnv.details?.[key]) && aEnv.details[key] >= 0 ? aEnv.details[key] : 0
    const preserveReviewerCounts = reviewerAVerdict === 'revise' && !reviewerAHasFindings
    const mustFix = Math.max(count('must-fix'), preserveReviewerCounts ? rawCount('must_fix') : 0)
    const shouldFix = Math.max(count('should-fix'), preserveReviewerCounts ? rawCount('should_fix') : 0)
    const consider = Math.max(count('consider'), preserveReviewerCounts ? rawCount('consider') : 0)
    const reviewPath = typeof aEnv.details?.review_path === 'string'
      ? aEnv.details.review_path : art('review.md')
    const carriedCleared = carriedResolution(aEnv.details, carriedOpen()).cleared
    const review = {
      status: 'done',
      role: 'reviewer',
      summary: aEnv.summary || 'panel review complete',
      artifacts: [
        ...(Array.isArray(aEnv.artifacts) ? aEnv.artifacts : []),
        aBrief, bBrief, adjBrief,
      ],
      details: {
        verdict,
        review_path: reviewPath,
        must_fix: mustFix,
        should_fix: shouldFix,
        consider,
        findings,
        ...(carriedCleared.length > 0 ? { carried_cleared: carriedCleared } : {}),
        panel: {
          partner: panel.partner,
          adjudicator: panel.adjudicator,
          consensus: fused.consensus,
          divergent: fused.divergent,
          upheld: adjudicated.upheld,
          dismissed: adjudicated.dismissed,
          class_invariant: adjudicated.classInvariant,
          closes_class: adjudicated.closesClass,
        },
      },
    }
    // A patch never reaches the canonical accept set or the journal: it lands in every
    // escalation envelope (crew/drive.mjs:2327). `review.details.findings` — the array
    // the outer loop routes from — keeps it.
    const canonicalFindings = findings.map(({ patch, ...rest }) => rest)
    const outcome = {
      dispatch: `panel-r${n}`,
      panel: true,
      verdict,
      must_fix: review.details.must_fix,
      should_fix: review.details.should_fix,
      consider: review.details.consider,
      findings: canonicalFindings,
      sources: ['reviewer', panel.partner],
      adjudicator: panel.adjudicator,
      class_invariant: adjudicated.classInvariant,
      closes_class: adjudicated.closesClass,
    }
    panelLog({ review_outcome: outcome })
    S.acceptFindings = canonicalFindings
    S.lastReview = {
      verdict,
      must_fix: review.details.must_fix,
      should_fix: review.details.should_fix,
      consider: review.details.consider,
      findings: canonicalFindings,
      panel: review.details.panel,
    }
    stageComplete()
    return review
  }
  const reviewBounceBrief = (round, reviewPath) => {
    const panelNote = panelBounceFindings
      ? `\n\nPanel fused findings (close every one):\n${panelBounceFindings}` : ''
    return [
      `# Review bounce (round ${round})`, '',
      `Close every must-fix in the review at ${reviewPath}. Plan: ${planPath}${panelNote}`,
      ...applyPrescriptionLines('the review'),
      ...hardeningBriefLines(hardenOwed.owed, hardenOwed.exempt),
    ].join('\n')
  }
  // #800 — a finding the reviewer marked `auto-fix` and shipped a patch for is applied
  // by CODE (programmatic-over-model-tokens). The patch is REFUSED unless its whole
  // write surface is readable AND inside files_in_scope: the scope gate is the one
  // write surface this run has, and a reviewer's patch is not exempt from it. Every
  // attempt is journalled — an applied patch nobody can see is not a fix, it is drift.
  // The id is safe as a path component by CONSTRUCTION: findingIdDefect refused the
  // whole envelope upstream if it was not (FINDING_ID_SHAPE). Nothing is sanitized
  // here — a silent rewrite is what turns two distinct ids into one artifact path.
  const applyAutoFixes = (entries, roundNo) => {
    const applied = []
    const refused = []
    for (const entry of entries) {
      const { targets, refusal } = patchTargets(entry.patch)
      if (refusal) { refused.push({ id: entry.id, why: `the patch was refused unread: ${refusal}` }); continue }
      const outside = outOfScopeFiles(targets, inScope)
      if (outside.length > 0) {
        refused.push({ id: entry.id, why: `the patch writes ${outside.join(', ')}, outside files_in_scope` })
        continue
      }
      const patchPath = art(`auto-fix-r${roundNo}-${entry.id}.patch`)
      const wrote = guardedWrite(io, patchPath, entry.patch.endsWith('\n') ? entry.patch : `${entry.patch}\n`)
      if (wrote) { refused.push({ id: entry.id, why: `the patch artifact could not be written: ${wrote}` }); continue }
      const res = io.run(`git apply --whitespace=nowarn ${shellArg(patchPath)}`)
      if (res?.ok) applied.push(entry.id)
      else refused.push({ id: entry.id, why: `git apply refused the patch: ${String(res?.output || '').slice(-500)}` })
    }
    if (entries.length > 0) io.log(recordRow({ at: io.now(), auto_fix: { round: roundNo, total: entries.length, applied, refused } }))
    return { applied, refused }
  }

  // #800 — code applied a patch, so code re-runs the code-owned checks that already
  // passed on the tree BEFORE it: scope, the validation lane, and the configured
  // acceptance gate. Returns {ok:true} or {ok:false, kind, brief}; `kind` is the
  // failed check's own name and becomes the escalation `where`, because "the lane is red"
  // and "no accepted build" are different facts and only one of them is true.
  // The brief carries the failure VERBATIM — a paraphrased failure is a second
  // interpretation of evidence the builder can read directly.
  const revalidateAfterAutoFix = (roundNo, applied) => {
    const record = (outcome, why) => io.log(recordRow({ at: io.now(), auto_fix_revalidation: { round: roundNo, applied, outcome, why } }))
    const failed = (kind, what, detail) => {
      record(kind, what)
      return { ok: false, kind, brief: [
        `# Auto-fix revalidation bounce (round ${roundNo})`, '',
        `The driver applied the reviewer's auto-fix patch(es) — ${applied.join(', ')} — and re-ran the code-owned checks. ${what}`,
        '', detail,
        ...hardeningBriefLines(hardenOwed.owed, hardenOwed.exempt),
        '', `Plan: ${planPath}`,
      ].join('\n') }
    }
    const outside = outOfScopeFiles(io.changedFiles(), inScope)
    if (outside.length > 0) return failed('scope', 'The tree now carries files OUTSIDE the plan scope:', outside.map((f) => `- ${f}`).join('\n'))
    const laneAfter = io.run(lane)
    if (!laneAfter.ok) return failed('lane', `The validation lane is RED. Make it green:\n\n    ${lane}`, `Failures:\n${String(laneAfter.output || '').slice(-4000)}`)
    if (gateCmd) {
      const gateAfter = runGate(`gate:autofix-r${roundNo}`, gateCmd)
      lastGateOutput = gateAfter.output
      if (!gateAfter.ok) return failed('gate', `The ACCEPTANCE GATE is red after the patch. The gate is immutable to you:\n\n    ${gateCmd}`, `Failures (verbatim):\n${String(gateAfter.output || '').slice(-4000)}`)
    }
    record('green', null)
    return { ok: true }
  }

  // #751 A REVIEWER bounce. The lead ruled the standing verdict STALE against a
  // tree the scope gate, the lane and every configured acceptance gate have already
  // proved, so the reviewer is re-assigned against THAT tree and nothing is rebuilt.
  // It consumes the SAME one review grant a builder bounce consumes — the target
  // chooses the recipient, never a second budget.
  const reviewerBounce = (round, where) => {
    grant('review', round); extraReviews += 1
    failureUpgrade('review', 'reviewer')
    staleVerdict = { path: lastReviewPath, where }
    stageComplete()
  }
  const panel = ctx.continuation === true ? panelSeats(seatList) : null
  if (ctx.continuation === true && !panel) panelLog({ panel_skipped: 'seats' })
  let gateTriaged = false
  // Gate A (mechanical): scope by git, never by self-report. #846 — it runs on EVERY
  // build round, bounced ones included. On b363-seatreask the non-done bounce path
  // `continue`d before this gate, so two envelope-shaped files the builder wrote into a
  // `returns/` directory at the CHECKOUT ROOT during build:r2 were invisible until
  // build:r3 succeeded; the lane paid for three rounds and then escalated on debris
  // that had existed for three minutes across a round boundary.
  const scopeGate = (round, finalRound) => {
    stage(`scope-gate:r${round}`)
    const changed = io.changedFiles()
    const gateFenceHits = laneFenceHits(changed, ctx.laneFence)
    if (gateFenceHits.length > 0) {
      stageComplete()
      return { escalation: escalate('scope',
        `the build crossed another live lane's fence: ${fenceBreachList(gateFenceHits)} — a file a sibling crew owns is never a bounce, it is a human's call`) }
    }
    // #846 — protocol debris is classified BEFORE scope subtraction. `outOfScopeFiles`
    // mechanically removes every in-scope path (crew/drive.mjs:1519-1529, and
    // `scopeMatcher` at :1519-1522), so a plan that names `returns/d1.builder.json` in
    // files_in_scope could write exactly that checkout debris and be told the tree is
    // clean. The ask makes the envelope refusal a property of a `returns/*.json` being
    // INSIDE the CHECKOUT, never a property of what the planner happened to fence.
    const debris = changed.filter((f) => ENVELOPE_DEBRIS.test(f))
    const refusal = scopeRefusal([...new Set([...outOfScopeFiles(changed, inScope), ...debris])])
    // MUTATION A4: invert this early return and a round whose tree is entirely in scope
    // starts paying for a gate it does not need.
    if (refusal.reason === null) { stageComplete(); return { ok: true } }              // ANCHOR A4
    io.log(recordRow({ at: io.now(), scope_gate: { round, reason: refusal.reason, envelopes: refusal.envelopes, edits: refusal.edits } }))
    if (!plans || finalRound()) {
      stageComplete()
      return { escalation: escalate('scope', refusal.why) }
    }
    const b = art(`build-bounce-r${round}.md`)
    failureUpgrade('scope', 'builder')
    io.writeFile(b, scopeBounceBrief(round, refusal, scopeFiles, planPath))
    stageComplete()
    return { bounce: b }
  }
  // MUTATION B8: route the proof through runGate and each of its invocations becomes
  // a gate_results row, moving the gate-review-gap numerator (#839 (i).
  const hardenRun = (cmd) => io.run(cmd)                                             // ANCHOR B8
  const proveHardening = (entries) => {
    const rows = []
    let fatal = null
    const proveEntry = (entry) => {
      let active = null
      const row = (outcome, why) => ({ finding: entry.finding, test: entry.test, name: entry.name, outcome, why })
      try {
        const W = hardenWitness?.get(entry.test)
        const S = hardenWitness?.get(entry.file)
        if (!W || !S) return row('witness-missing', `the review-time witness has no cell for ${!W ? entry.test : entry.file}`)
        if (W.state === 'unreadable' || S.state === 'unreadable') {
          const unreadable = W.state === 'unreadable' ? entry.test : entry.file
          return row('witness-unreadable', `the review-time witness could not read ${unreadable}: ${W.state === 'unreadable' ? W.why : S.why}`)
        }
        if (S.state !== 'read') return row('witness-absent', `the declared implementation ${entry.file} did not exist on the review-time tree`)
        const testAbs = `${ctx.checkout}/${entry.test}`
        const fileAbs = `${ctx.checkout}/${entry.file}`
        const cmd = hardenCommand(entry.test, entry.name)
        const witnessCmd = hardenWitnessCommand(entry.test)   // UNFILTERED: see hardenWitnessCommand
        const repairedTest = io.readFile(testAbs)
        if (repairedTest === null) return row('unapplied', `${entry.test} does not exist in the built tree`)
        let witnessRun = null
        let witnessCounts = null
        if (W.state === 'read') {
          active = { abs: testAbs, original: repairedTest, writeAttempted: false }
          let witnessResult
          try {
            active.writeAttempted = true
            io.writeFile(testAbs, W.bytes)
            witnessResult = hardenRun(witnessCmd)
          } finally { io.writeFile(testAbs, repairedTest) }
          active = null
          const out = witnessResult?.output
          witnessRun = nameVerdict(out, entry.name)
          witnessCounts = parseSuiteCounts(out)          // aggregate, and ONLY to ask "green and parseable?"
          // MUTATION B5c: drop this branch and a runtime name that ALREADY EXISTED on the
          // witnessed tree — interpolated, nested, or carrying a `# SKIP`/`# TODO`
          // directive, so no contiguous bytes of the witnessed source show it and no
          // aggregate red marks it — passes as gate growth. The gate never grew.
          // EVERY non-absent verdict is an existing name: `passed`, `failed`, `skipped`
          // and `ambiguous` alike.
          if (witnessRun !== 'absent') return row('name-not-new', `the declared name ${entry.name} already exists in the witnessed ${entry.test}: ${witnessRun}`)   // ANCHOR B5c
          // Only an exact ABSENT on an otherwise green, parseable run proves the witnessed
          // source carried no such runtime check. A red or unparseable witnessed-test run
          // measured nothing and is never read as `new`.
          if (witnessCounts === null || witnessCounts.fail > 0) return row('unproven', `the witnessed ${entry.test} run was not green and parseable, so the absence of ${entry.name} proves nothing: counts ${JSON.stringify(witnessCounts)}`)
        }
        const control = nameVerdict(hardenRun(cmd)?.output, entry.name)
        if (control === 'absent') return row('name-absent', `the repaired control reported no exact test named ${entry.name}`)
        if (control === 'ambiguous') return row('name-ambiguous', `the repaired control reported more than one exact test named ${entry.name}`)
        if (control === 'failed') return row('control-red', `the repaired control left ${entry.name} failing`)
        if (control === 'skipped') return row('control-skipped', `the repaired control skipped ${entry.name}`)
        const repairedFile = io.readFile(fileAbs)
        if (repairedFile === null) return row('unapplied', `${entry.file} does not exist in the built tree`)
        let pre = null
        active = { abs: fileAbs, original: repairedFile, writeAttempted: false }
        let preResult
        try {
          active.writeAttempted = true
          io.writeFile(fileAbs, S.bytes)
          preResult = hardenRun(cmd)
        } finally { io.writeFile(fileAbs, repairedFile) }
        active = null
        pre = nameVerdict(preResult?.output, entry.name)
        // MUTATION B5d: drop the witnessed pre-repair conjunct and a guard that was
        // already green on the review-time tree is certified as having caught the defect.
        if (pre !== 'failed') return row('pre-repair-green', `the declared check ${entry.name} does not fail on the witnessed pre-repair ${entry.file}: ${pre}`)   // ANCHOR B5d
        const bound = applyMutationAnchor(repairedFile, entry.find, entry.replace)
        if (bound.text === null) return row(BINDING_OUTCOME[bound.mode], bindingWhy(bound.mode, entry.file))
        let mut = null
        active = { abs: fileAbs, original: repairedFile, writeAttempted: false }
        let mutResult
        try {
          active.writeAttempted = true
          io.writeFile(fileAbs, bound.text)
          mutResult = hardenRun(cmd)
        } finally { io.writeFile(fileAbs, repairedFile) }
        active = null
        mut = nameVerdict(mutResult?.output, entry.name)
        // MUTATION B9: drop the exact-name mutant conjunct and ANY red — a syntax error,
        // an unrelated failing subtest, a file-level failure — certifies a guard that
        // never ran. This is the aggregate rule the round-1 draft proposed, restored.
        if (mut !== 'failed') return row('survived', `the declared mutation left ${entry.name} ${mut}`)   // ANCHOR B9
        return row('killed', null)
      } catch (err) {
        const why = err?.message || String(err)
        fatal = dirtyAfterFailure(active, err)
        return row('unproven', `the hardening proof was interrupted: ${why}`)
      }
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      rows.push(proveEntry(entry))
      if (fatal) break
    }
    return { rows, fatal }
  }
  build:
  for (let round = 1; round <= limits.build_rounds + extraRounds; round += 1) {
    const finalRound = () => round >= limits.build_rounds + extraRounds
    stage(`build:r${round}`)
    const env = assignAndWait('builder', buildBrief, buildNote)
    if (env.status !== 'done') {
      // #846 — mechanical before judgment, and the round is closed first so the journal
      // still replays as a balanced stack (crew/drive.test.mjs:7375).
      // MUTATION A1: neutralise this call and a bounced round again reaches no scope
      // gate — the b363-seatreask defect, restored.
      stageComplete()
      const bounced = scopeGate(round, finalRound)                                    // ANCHOR A1
      if (bounced.escalation) return bounced.escalation
      if (bounced.bounce) { buildBrief = bounced.bounce; buildNote = 'scope-fix'; continue }
      const asked = parseQuestions(env.details)
      const questions = asked?.questions ?? []
      if (asked) io.log(recordRow({ at: io.now(), member_questions: { role: 'builder', round, total: questions.length, ids: questions.map((q) => q.id), rejected: asked.rejected } }))
      const c = consultLead(
        [`The builder returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce with guidance, or escalate?`,
          ...questionConsultLines('builder', questions)].join('\n'),
        ['bounce', 'escalate'], [buildBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') {
        return escalate('build', c.reason, env.artifacts || [])
      }
      if (finalRound()) extraRounds += 1 // the granted bounce needs a round to land in
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('build', 'builder')
      const matched = matchAnswers(questions, c.answers)
      if (questions.length > 0) io.log(recordRow({ at: io.now(), question_answers: { role: 'builder', round, answered: matched.answered.map((a) => a.id), unanswered: matched.unanswered, rejected: matched.rejected } }))
      io.writeFile(b, [
        `# Build bounce (round ${round})`, '', c.guidance, '',
        `Plan: ${planPath}`,
        ...answerBounceLines(questions, matched),
      ].join('\n'))
      buildBrief = b; buildNote = 'build-fix'
      continue
    }
    builderEnv = env
    stageComplete()

    const scoped = scopeGate(round, finalRound)
    if (scoped.escalation) return scoped.escalation
    if (scoped.bounce) { buildBrief = scoped.bounce; buildNote = 'scope-fix'; continue }

    // Gate B (mechanical): the validation lane, run by code.
    stage(`lane:r${round}`)
    const laneRes = io.run(lane)
    if (!laneRes.ok) {
      if (finalRound()) {
        const c = consultLead(
          `The validation lane is still red after ${round} rounds. Bounce once more with guidance, or escalate?`,
          ['bounce', 'escalate'], [planPath, journal],
        )
        if (c.decision !== 'bounce') {
          stageComplete()
          return escalate('lane', c.reason)
        }
        extraRounds += 1
      }
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('lane', 'builder')
      io.writeFile(b, `# Lane bounce (round ${round})\n\nThe validation lane is RED. Make it green:\n\n    ${lane}\n\nFailures:\n${laneRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'lane-fix'
      stageComplete()
      continue
    }
    stageComplete()

    // Gate B2 (mechanical): the acceptance gate, when the plan authored one.
    // Failures feed back VERBATIM; repeated failures trigger ONE build-vs-gate
    // defect triage by the reviewer (closed enum); a gate defect lets the
    // lead repair the gate ONCE (old gate preserved in gateHistory), and the
    // repaired gate re-runs immediately WITHOUT consuming a builder round.
    // The repair contract forbids weakening any legitimate check. When
    // the io supports it, the repaired gate is re-proved red on the pristine
    // (pre-build) tree before it is trusted against the already-built tree.
    if (gateCmd) {
      stage(`gate:r${round}`)
      let gateRes = runGate(`gate:r${round}`, gateCmd)
      if (!gateRes.ok && round >= limits.gate_fails_to_triage && !gateTriaged && gateRepairs < limits.gate_repairs) {
        gateTriaged = true
        gateAttention(`the acceptance gate failed ${round} rounds — escalated to reviewer triage (build defect vs gate defect)`, [planPath])
        const tBrief = art(`gate-triage-r${round}.md`)
        io.writeFile(tBrief, `# Gate triage (round ${round})\n\nThe acceptance gate keeps failing. Decide which is defective — read the plan at ${planPath} then the gate command and its output, then the diff in ${ctx.checkout}.\n\nGate: ${gateCmd}\nOutput:\n${gateRes.output.slice(-3000)}\n\nReply with details {"defect": "build" | "gate", "reason": "..."}.`)
        const triage = assignAndWait('reviewer', tBrief, 'gate-triage')
        if (triage.status === 'done' && triage.details?.defect === 'gate') {
          if (noGateCustodian()) {
            stageComplete()
            return gateCustodyEscalate(`the reviewer triaged the repeated gate failures as a GATE defect: ${triage.details?.reason || 'no reason given'}`)
          }
          gateRepairs += 1
          stage(`gate-repair:${gateRepairs}`)
          const rBrief = art('gate-repair-bounce.md')
          io.writeFile(rBrief, `# Gate repair (one allowed per task)\n\nYou hold gate custody after plan acceptance: read the plan, then repair the gate.\n\nThe reviewer diagnosed a GATE DEFECT: ${triage.details?.reason || ''}\n\nPreserve the old gate under a .r1 suffix, then fix the gate so it checks exactly what the brief asked — you may NOT weaken any legitimate check. Return the (possibly identical) gate_cmd in details.\n\nGate: ${gateCmd}\nPlan: ${planPath}\nBrief: ${ctx.briefFile}`)
          const rep = assignAndWait(GATE_CUSTODIAN, rBrief, 'gate-repair')
          if (rep.status === 'done' && rep.details?.gate_cmd) {
            acceptRepairedGate(rep.details.gate_cmd, `gate-reverify:${gateRepairs}`)
            // The re-proof no longer trusts bare `pristine.ok`: a repaired gate
            // that crashes or prints no summary on the pristine tree is not red
            // for the right reason either (#153, ADR-030 §3). The budget is
            // already spent here, so a failed re-proof escalates — with the
            // diagnosis that actually applies.
            const settled = settleFailedProof()
            if (settled.escalation) {
              stageComplete()
              return settled.escalation
            }
            gateRes = runGate(`gate-repair:${gateRepairs}`, gateCmd) // re-run immediately; no builder round consumed
          }
        }
      }
      // First green of this generation: measure, once. A generation repaired
      // above was already proven by its re-proof, so this is a no-op there —
      // which is what keeps the whole run within ADR-030's `1 + gate_repairs`
      // bound on pristine runs.
      if (gateRes.ok && gateProvenGeneration !== gateGeneration) {
        recordGateProof(`gate-proof:${gateGeneration}`)
        const settled = settleFailedProof()
        if (settled.escalation) {
          stageComplete()
          return settled.escalation
        }
        if (settled.repaired) gateRes = runGate(`gate-repair:${gateRepairs}`, gateCmd)
      }
      // Per-CHECK proof, post-green BY CONSTRUCTION. An observed green built-tree
      // run for THIS generation is the control a mutation is measured against; a
      // repaired generation is proven pristine BEFORE its first built-tree run and
      // may be red there (:2218, crew/drive.test.mjs:2373-2399). The loop repeats
      // only because a repair mints a new generation that owes its own pass, and
      // the single gate_repairs budget bounds that to once.
      while (gateRes.ok && checkProofPending === gateGeneration) {
        completeCheckProof(`gate-proof:${gateGeneration}:checks`)
        // #874 — the DIRTY TREE outranks every diagnosis. settleFailedProof's first branch
        // (crew/drive.mjs:3526-3528) refuses to continue while `gateProofFatal` is set, because the
        // built tree still carries the driver's OWN mutation; nothing about the plan matters until
        // it is restored, and bouncing anyone onto that tree asks them to repair code the driver
        // broke. Settled here so a dirty restore is never reported merely as drift.
        if (gateProofFatal) {
          const fatal = settleFailedProof()
          if (fatal.escalation) {
            stageComplete()
            return fatal.escalation
          }
        }
        // #874 (1) — a plan/build disagreement is NOT gate custody's to repair: the lead may not
        // edit the planner's envelope and the planner is never assigned again. It escalates here,
        // carrying the whole bind report, rather than spending the single gate repair on a gate
        // that proved everything it was given. A survivor recorded beside it keeps
        // checkProofVerdict at `failed`, so the real gate defect stays measured; it just does not
        // buy a repair round on a lane that is terminal until the fixed contract is amended.
        // MUTATION B1: replace this return with `checkProofVerdict = 'failed'` and control falls
        // through to settleFailedProof on the next loop step — the b384-suiteslot GATE-CUSTODY
        // misroute, genuinely restored.
        if (checkProofDisagreement()) {
          stageComplete()
          return escalate('anchor-absent', anchorAbsentWhy(checkProofUnbound))                       // ANCHOR B1
        }
        if (!gateProofFatal && checkProofVerdict !== 'failed') break
        const settled = settleFailedProof()
        if (settled.escalation) {
          stageComplete()
          return settled.escalation
        }
        if (settled.repaired) gateRes = runGate(`gate-repair:${gateRepairs}`, gateCmd)
      }
      if (!gateRes.ok) {
        if (finalRound()) {
          const c = consultLead(
            `The acceptance gate is still red after ${round} build rounds. Bounce once more with guidance, or escalate?`,
            ['bounce', 'escalate'], [planPath, journal],
          )
          if (c.decision !== 'bounce') {
            const settled = convergeSettle({ why: c.reason, where: 'gate', gateOutput: gateRes.output })
            if (settled) {
              stageComplete()
              return settled
            }
            stageComplete()
            return gateEscalate(c.reason)
          }
          extraRounds += 1
        }
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('gate', 'builder')
        io.writeFile(b, `# Gate bounce (round ${round})\n\nThe ACCEPTANCE GATE is red — the build does not yet do what was asked. The gate is immutable to you; make the build satisfy it:\n\n    ${gateCmd}\n\nFailures (verbatim):\n${gateRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
        buildBrief = b; buildNote = 'gate-fix'
        stageComplete()
        continue
      }
      lastGateOutput = gateRes.output
      stageComplete()
    }

    // Gate B3 (mechanical): #839 — a must-fix repair must also land the permanent guard
    // that would have caught it. The gate-review gap was 37% — 14 of 38 runs
    // (`npm run ledger:gate-review-gap`), b314-vizhonesty at max_must_fix 4 across four
    // green gate runs — and each bounce spent a build round while the knowledge the
    // reviewer produced evaporated with it. A guard is vacuous unless proven by
    // mutation, so the declared kill-mutation is APPLIED here, never argued about.
    // ADR-038: proof on the changed surface beats argument about it.
    if (hardenOwed.owed.length > 0) {
      stage(`lane:harden:r${round}`)
      const { entries, refusals } = validateHardened(builderEnv.details, hardenOwed.owed, inScope)
      const { rows, fatal } = proveHardening(entries)
      for (const row of rows) logHardened(round, row)
      // #839 — a failed RESTORE is not a repair bounce. `settleFailedProof`
      // (crew/drive.mjs:3490-3492) already refuses to continue when `gateProofFatal` is
      // set, because the built tree still carries the driver's OWN mutation; bouncing
      // the builder onto that tree would ask it to repair code the driver broke. Same rule,
      // same place in the sequence: after the rows are journalled, before anything is
      // accepted or bounced.
      // MUTATION B11: turn the terminal into an ordinary bounce and a failed restore
      // sends the builder back onto a tree still carrying the driver's own mutation.
      if (fatal) {                                                                     // ANCHOR B11
        stageComplete()
        return escalate('harden', `the hardening proof could not restore the built tree: ${fatal} — the run stops rather than continue with the driver's own mutation`)
      }
      // MUTATION B5a: narrow this predicate to an outcome nothing produces and no
      // repair, however well proven, is ever accepted.
      if (refusals.length === 0 && rows.every((row) => row.outcome === 'killed' || row.outcome === 'ungateable')) {   // ANCHOR B5a
        hardenOwed = { owed: [], exempt: [] }
        hardenWitness = null
        stageComplete()
      } else if (!plans || finalRound()) {
        stageComplete()
        return escalate('harden', hardeningBounceLines(round, refusals, rows).join(' '))
      } else {
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('harden', 'builder')
        io.writeFile(b, hardeningBounceLines(round, refusals, rows).join('\n'))
        buildBrief = b; buildNote = 'harden-fix'
        stageComplete()
        continue
      }
    }

    // Gate C (judgment, but enum-consumed): the reviewer. An unreadable
    // verdict re-asks the REVIEWER in place — the builder is never re-run
    // for a reviewer's malformed envelope.
    while (true) {
      if (reviews >= limits.review_rounds + extraReviews) {
        const options = canGrant('review') ? ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate'] : ['accept', 'escalate']
        const c = consultLead(
          acceptQuestion(`Review rounds are exhausted (${reviews}) and the last verdict was revise. Grant one more review/build round, accept with residuals, or escalate?`),
          options, [planPath, lastReviewPath],
        )
        if (c.decision === 'escalate') {
          const settled = convergeSettle({ why: c.reason, where: 'review', gateOutput: lastGateOutput, gateRed: false })
          if (settled) {
            stageComplete()
            return settled
          }
          stageComplete()
          return escalate('review', c.reason)
        }
        if (c.decision === 'bounce-reviewer') {
          reviewerBounce(round, 'review-exhausted')
          continue
        }
        if (c.decision === 'bounce-builder') {
          grant('review', round)
          extraReviews += 1
          if (finalRound()) extraRounds += 1
          const b = art(`build-bounce-r${round}.md`)
          failureUpgrade('review', 'builder')
          io.writeFile(b, reviewBounceBrief(round, lastReviewPath))
          buildBrief = b; buildNote = 'review-fix'
          stageComplete()
          continue build
        }
        const settledAccept = settleAccept(c, 'review-exhausted', [planPath, lastReviewPath])
        // A refuted must-fix is NOT a residual: convergeSettle would file it as one,
        // commit the build and open a PR — the viz-intake outcome under another name.
        // It fails closed to the human, and a distinct `where` keeps it out of the
        // regrant path (crew/escalation-policy.mjs:174-181) without editing it.
        if (settledAccept.refusedMustFix) {
          stageComplete()
          return escalate('refuted-must-fix', settledAccept.why, [], { accept_decision: settledAccept.record })
        }
        if (!settledAccept.ok) {
          const settled = convergeSettle({ why: settledAccept.why, where: 'review', gateOutput: lastGateOutput, gateRed: false })
          if (settled) {
            stageComplete()
            return settled
          }
          stageComplete()
          return escalate('review', settledAccept.why, [], { accept_decision: settledAccept.record })
        }
        finalReview.residuals = settledAccept.record.residuals || []
        accepted = acceptedViaLabel(settledAccept.record)
        stageComplete()
        break build
      }
      const roundNo = reviews + 1
      stage(`review:r${roundNo}`)
      const revBrief = art(`review-brief-${roundNo}.md`)
      const openCarried = carriedOpen()
      const carriedHead = carriedPreambleLines(openCarried)
      panelBriefText = [
        ...carriedHead,
        `# Review (round ${roundNo})`, '',
        `Plan of record: ${planPath}. Changes are uncommitted in ${ctx.checkout} — read the diff with git.`,
        `Re-run the validation lane yourself: ${lane}`,
        `Write review.md in the task dir. details.verdict must be pass or changes-needed.`,
        ...staleVerdictLines(staleVerdict),
      ].join('\n')
      io.writeFile(revBrief, panelBriefText)
      const review = panel ? panelReview(roundNo, panel) : assignAndWait('reviewer', revBrief, 'review')
      lastReviewPath = review.details?.review_path || art('review.md')
      const shapeRefusal = reviewShapeDefect(review.details) || carriedSilenceDefect(review.details, openCarried)
      const v = shapeRefusal ? null : verdictOf(review)
      if (v) finalReview.verdict = v
      if (v) staleVerdict = null
      if (v) for (const id of carriedResolution(review.details, openCarried).cleared) S.carriedCleared.add(id)
      // A VERIFICATION COSTS NOTHING. Only a round that DEMANDS change spends a
      // review_rounds slot. Measured over 164 archived lanes: of 86 re-reviews,
      // 52 (60%) found nothing — they existed only to confirm the must-fixes
      // were closed — and every one of them spent a slot, so the ordinary
      // successful trajectory (r1 changes-needed -> fix -> r2 pass) spent the
      // whole budget on success. A round that surfaces NEW must-fixes is
      // changes-needed and is charged like any other: this changes what a
      // verification COSTS, never whether it happens. An unreadable verdict is
      // charged nothing either — the re-ask replaces the round in place, which
      // is exactly what the old `reviews -= 1` refund below did.
      const counted = v === 'revise'
      if (counted) reviews += 1
      io.log(recordRow({ at: io.now(), review_round: { n: roundNo, verdict: review.details?.verdict ?? null, accounting: counted ? 'counted' : 'free', charged: reviews, ...(shapeRefusal ? { refused: shapeRefusal.reason } : {}) } }))
      // #800 R4 — dispositions are settled BEFORE either verdict branch, but ONLY for a
      // verdict the driver could read. A shape-refused or unreadable envelope is
      // refused, never partially executed. An `ask-user` finding is a decision code may
      // not take, on pass and on changes-needed alike; the lead's answer is CLOSED here
      // — bounce-builder carries the lead's own steer straight to the builder and never
      // falls through to a second consult.
      const disposed = dispositionPlan(review.details)
      // #839 — the debt is armed by the review that carries a must-fix and cleared only
      // by a proven guard, so a round that goes red on the lane in between does not drop
      // it. The WITNESS is the pre-repair tree: nothing later can reconstruct it, and a
      // proof that cannot compare against it can only assert that some test failed, not
      // that THIS check caught THAT defect.
      if (v) {
        const debt = hardeningDebt(review.details)
        if (debt.owed.length > 0 || debt.exempt.length > 0) {
          hardenOwed = debt
          hardenWitness = witnessTree(scopeFiles)
          for (const { id, why } of debt.exempt) {
            logHardened(roundNo, { finding: id, test: null, name: null, outcome: 'ungateable', why })
          }
        }
      }
      // #800 revision 2 — journalled HERE, not in the pass branch below, because the
      // ask-user branch `continue`s the build loop and the pass branch is therefore
      // unreachable for a pass carrying BOTH dispositions. The patch was correctly not
      // applied either way; without this move, that one case is the only pass whose
      // skipped auto-fix leaves no refusal row, and a record that exists for every case
      // but one is worse than none.
      if (v === 'pass' && disposed.autoFix.length > 0) {
        io.log(recordRow({ at: io.now(), auto_fix: { round: roundNo, total: disposed.autoFix.length, applied: [], refused: disposed.autoFix.map(({ id }) => ({ id, why: 'a pass verdict is not a fix path — the driver applies a patch only on changes-needed' })) } }))
      }
      if (v && disposed.askUser.length > 0) {
        const lastAsk = finalRound()
        const askOptions = !lastAsk || canGrant('review') ? ['bounce-builder', 'escalate'] : ['escalate']
        const c = consultLead(askUserLines(disposed.askUser).join('\n'), askOptions, [planPath, lastReviewPath], { exclude: 'reviewer' })
        if (c.decision !== 'bounce-builder') {
          stageComplete()
          return escalate('review-unresolved', c.reason, [], { ask_user: disposed.askUser.map(({ id }) => id) })
        }
        if (lastAsk) { grant('review', round); extraRounds += 1; extraReviews += 1 }
        // A review carrying BOTH dispositions still gets its auto-fix applied: the
        // ask-user finding is what needs the seat, the auto-fix never did. The builder
        // round that follows supplies the code-owned validation, so no in-place
        // revalidation is done here. If the lead escalates, nothing is applied.
        if (v === 'revise') applyAutoFixes(disposed.autoFix, roundNo)
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('review', 'builder')
        io.writeFile(b, [`# Ask-user bounce (round ${round})`, '', c.guidance, '',
          ...askUserLines(disposed.askUser),
          ...hardeningBriefLines(hardenOwed.owed, hardenOwed.exempt),
          '', `Review: ${lastReviewPath}`, `Plan: ${planPath}`].join('\n'))
        buildBrief = b; buildNote = 'review-fix'
        stageComplete()
        continue build
      }
      if (v === 'pass') { stageComplete(); stage('review:pass'); accepted = 'review pass'; stageComplete(); break build }
      if (v === 'revise') {
        const fixes = applyAutoFixes(disposed.autoFix, roundNo)
        // #839 — CODE closed every finding that demanded a change, but the guard that
        // would catch the class next time does not exist yet and only a builder can
        // write it. With debt open the in-place re-review is not available.
        if (fixes.applied.length > 0 && disposed.needsSeat.length === 0 && fixes.refused.length === 0 && hardenOwed.owed.length === 0) {
          // Every finding that demanded a change is closed, and CODE closed it. Re-prove
          // the tree code changed, then re-review it in place rather than spending a
          // builder round on work that is already done; the review budget still bounds
          // the loop.
          const revalidated = revalidateAfterAutoFix(roundNo, fixes.applied)
          if (revalidated.ok) {
            stageComplete()
            continue
          }
          const lastFix = finalRound()
          if (lastFix) {
            const fixOptions = canGrant('review') ? ['bounce-builder', 'escalate'] : ['escalate']
            const c = consultLead(
              `The driver applied the reviewer's auto-fix patch(es) and the ${revalidated.kind} check went red on the patched tree. Grant one more build round, or escalate?`,
              fixOptions, [planPath, lastReviewPath],
            )
            if (c.decision !== 'bounce-builder') {
              stageComplete()
              return escalate(revalidated.kind, c.reason)
            }
            grant('review', round); extraRounds += 1; extraReviews += 1
          }
          const b = art(`build-bounce-r${round}.md`)
          failureUpgrade('review', 'builder')
          io.writeFile(b, revalidated.brief)
          buildBrief = b; buildNote = 'review-fix'
          stageComplete()
          continue build
        }
        if (finalRound()) {
          const options = canGrant('review') ? ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate'] : ['accept', 'escalate']
          const c = consultLead(
            acceptQuestion(`Build rounds are exhausted but the review says changes-needed. Grant one more review/build round, accept with residuals, or escalate?`),
            options, [planPath, lastReviewPath],
          )
          if (c.decision === 'escalate') {
            const settled = convergeSettle({ why: c.reason, where: 'review', gateOutput: lastGateOutput, gateRed: false })
            if (settled) {
              stageComplete()
              return settled
            }
            stageComplete()
            return escalate('review', c.reason)
          }
          if (c.decision === 'bounce-reviewer') {
            reviewerBounce(round, 'build-exhausted')
            continue
          }
          if (c.decision === 'bounce-builder') {
            grant('review', round)
            extraRounds += 1
            extraReviews += 1
            const b = art(`build-bounce-r${round}.md`)
            failureUpgrade('review', 'builder')
            io.writeFile(b, reviewBounceBrief(round, lastReviewPath))
            buildBrief = b; buildNote = 'review-fix'
            stageComplete()
            continue build
          }
          const settledAccept = settleAccept(c, 'build-exhausted', [planPath, lastReviewPath])
          // A refuted must-fix is NOT a residual: convergeSettle would file it as one,
          // commit the build and open a PR — the viz-intake outcome under another name.
          // It fails closed to the human, and a distinct `where` keeps it out of the
          // regrant path (crew/escalation-policy.mjs:174-181) without editing it.
          if (settledAccept.refusedMustFix) {
            stageComplete()
            return escalate('refuted-must-fix', settledAccept.why, [], { accept_decision: settledAccept.record })
          }
          if (!settledAccept.ok) {
            const settled = convergeSettle({ why: settledAccept.why, where: 'review', gateOutput: lastGateOutput, gateRed: false })
            if (settled) {
              stageComplete()
              return settled
            }
            stageComplete()
            return escalate('review', settledAccept.why, [], { accept_decision: settledAccept.record })
          }
          finalReview.residuals = settledAccept.record.residuals || []
          accepted = acceptedViaLabel(settledAccept.record)
          stageComplete()
          break build
        }
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('review', 'builder')
        io.writeFile(b, reviewBounceBrief(round, review.details?.review_path || art('review.md')))
        buildBrief = b; buildNote = 'review-fix'
        stageComplete()
        continue build
      }
      const c = consultLead(
        shapeRefusal
          ? `The reviewer envelope is refused by shape [${shapeRefusal.reason}]: ${shapeRefusal.why}. This verdict is never accepted. Bounce the reviewer to decide again, or escalate?`
          : `The reviewer returned an unreadable verdict (status=${review.status}, verdict=${review.details?.verdict}). Bounce the reviewer, or escalate?`,
        ['bounce', 'escalate'], [revBrief, ...(review.artifacts || [])],
        { exclude: 'reviewer' },
      )
      if (c.decision === 'escalate') {
        stageComplete()
        return escalate('review', c.reason)
      }
      // nothing to refund: an unreadable verdict was never charged (`counted` above),
      // and the loop re-asks the reviewer in place under the same round number.
      stageComplete()
    }
  }
  if (!builderEnv || !accepted) {
    return escalate('build', `no accepted build within ${limits.build_rounds + extraRounds} rounds`)
  }

  // ---- 3. FINISH: commit, optional rebase, then full suite (code) -------------
  const publishing = ctx.publish && typeof ctx.publish === 'object' ? ctx.publish : null
  let baseSha = null
  let rebased = false
  let rebaseMs = 0
  let coldSuite
  let published = null
  stage('commit')
  const message = composeCommitMessage({ task: ctx.task, planEnv, builderEnv })
  const subject = String(message).split('\n')[0]
  const hasCommitSubject = String(planEnv.details?.commit_subject || '').split('\n').some((line) => line.trim())
  if (!hasCommitSubject) io.log(recordRow({ at: io.now(), commit_subject: 'fallback-from-plan-summary' }))
  const committing = io.changedFiles().filter(inScope)
  const preRebaseCommit = S.commit = io.commit(committing, message)
  stageComplete()

  if (publishing) {
    stage('rebase')
    const rebaseStartedAt = io.now()
    const base = `origin/${PUBLISH_BASE}`
    let fetched
    try { fetched = io.run(`git fetch origin ${PUBLISH_BASE}`) }
    catch (err) { fetched = { ok: false, output: err?.message ?? String(err) } }
    if (!fetched?.ok) {
      stageComplete()
      return escalate('rebase', `the fetch of ${base} failed${fetched?.output ? `: ${String(fetched.output).slice(-2000)}` : ''}`, [], { commit: S.commit })
    }
    const probe = (command) => {
      let result
      try { result = io.run(command) } catch { return null }
      const output = String(result?.output || '').trim()
      return result?.ok && output ? output : null
    }
    baseSha = probe(`git rev-parse ${base}`)
    if (!baseSha) {
      stageComplete()
      return escalate('rebase', `the rebase probe git rev-parse ${base} failed or returned blank output`, [], { commit: S.commit })
    }
    const mergeBase = probe(`git merge-base HEAD ${base}`)
    if (!mergeBase) {
      stageComplete()
      return escalate('rebase', `the rebase probe git merge-base HEAD ${base} failed or returned blank output`, [], { commit: S.commit })
    }
    rebased = baseSha !== mergeBase
    if (rebased) {
      let rebaseResult
      try { rebaseResult = io.run(`git rebase ${base}`) }
      catch (err) { rebaseResult = { ok: false, output: err?.message ?? String(err) } }
      if (!rebaseResult?.ok) {
        let conflicted = []
        try {
          conflicted = String(io.run('git diff --name-only --diff-filter=U')?.output || '')
            .split('\n').map((line) => line.trim()).filter(Boolean)
        } catch { conflicted = [] }
        let aborted
        try { aborted = io.run('git rebase --abort') }
        catch { aborted = { ok: false, output: '' } }
        const restoredHead = probe('git rev-parse HEAD')
        const conflictDetail = conflicted.length ? ` with conflicts in ${conflicted.join(', ')}` : ''
        if (!aborted?.ok || !restoredHead || restoredHead !== preRebaseCommit) {
          const found = restoredHead || '(unavailable)'
          stageComplete()
          return escalate('rebase', `the rebase onto ${base} failed${conflictDetail}; restoration is UNPROVEN — HEAD found after abort: ${found}`, [], { commit: S.commit })
        }
        stageComplete()
        return escalate('rebase', conflicted.length
          ? `the rebase onto ${base} failed with conflicts in ${conflicted.join(', ')}; restoration proven at HEAD ${restoredHead}`
          : `the rebase onto ${base} failed`, [], { commit: S.commit })
      }
      const postRebaseHead = probe('git rev-parse HEAD')
      if (!postRebaseHead) {
        stageComplete()
        return escalate('rebase', 'the rebase succeeded but git rev-parse HEAD failed or returned blank output', [], { commit: S.commit })
      }
      S.commit = postRebaseHead
    }
    rebaseMs = io.now() - rebaseStartedAt
    stageComplete()
  }

  stage('suite')
  const suiteRes = phaseSlot(SUITE_SLOT_PHASES.warm, () => io.run(ctx.suite))
  const warmCounts = parseSuiteCounts(suiteRes?.output)
  if (!suiteRes?.ok) {
    stageComplete()
    return escalate('suite', `full suite red after acceptance — this needs eyes:\n${String(suiteRes?.output || '').slice(-2000)}`, [], { commit: S.commit })
  }
  if (publishing && warmCounts === null) {
    stageComplete()
    return escalate('suite', 'full suite was green, but its pass/fail summary could not be measured for publication', [], { commit: S.commit })
  }
  stageComplete()

  // ---- 3b. COLD VERIFICATION ---------------------------------------------------
  // The same suite, in a checkout this lane never wrote into. Until now a lane ran
  // its suite in the worktree it had been writing into for the whole run, so every
  // lane self-certified in the one environment guaranteed to be warm, and CI — which
  // reports AFTER the operator has been told the lane is green — was the only
  // cold-start check there was.
  //
  // POLICY: EVERY LANE, EVERY RUN, unconditionally. The cost is one extra full suite
  // run per lane, measured at 126s on this repo on 2026-08-28, and it is paid
  // because neither cheaper policy buys the thing. Running only lanes touching test
  // files is the tempting one and it is wrong: the leak is a path-sensitive
  // ASSERTION meeting a path-sensitive VALUE, and a lane can introduce either half
  // in a source file while touching no test at all. Running once per batch at
  // closeout reports after the operator has already been told each lane is green,
  // which is precisely the defect CI already has and this exists to remove. Two
  // minutes against a lane costing tens of minutes of model time is the honest price
  // of not handing an operator a green that only holds in one directory.
  //
  // It runs AFTER the commit because a worktree can only be cut at a commit: before
  // io.commit, HEAD does not carry the build and a cold run would certify the
  // previous commit. It FAILS CLOSED, with NO exception: `done` is reachable only
  // from a cold run that actually happened and was green. A red run, a runner that
  // threw, and an io carrying no cold runner at all are the same answer to the only
  // question that matters — this lane has not been verified anywhere but in the
  // directory it built in — so all three escalate rather than report a verdict
  // nobody took.
  //
  // The guarded names are the LANE name first and the task name second. They are
  // separate fields and separate contracts — crew/crew.mjs sets `task` at :1831 and
  // `laneName` at :1834, crew/child.mjs at :152 and :320 — and it is the LANE name
  // that b281-spawnbudget's worktree carried into /budget/i. `laneName` is present
  // only on a fenced dispatch, so the task name stays in the list as the always-present
  // second guard; the list is de-duplicated because in a single-slice batch the two
  // are routinely equal, and a duplicate guard would only slow the generator.
  stage('suite:cold')
  if (typeof io.runCold !== 'function') {
    coldSuite = { verdict: 'unavailable', why: 'this io provides no runCold, so no cold checkout could be cut' }
  } else {
    try {
      const coldGuards = [...new Set([ctx.laneName, ctx.task].filter((name) => typeof name === 'string' && name.trim()))]
      const cold = phaseSlot(SUITE_SLOT_PHASES.cold, () => io.runCold(ctx.suite, coldGuards))
      coldSuite = cold.ok
        ? { verdict: 'green', path: cold.path, counts: parseSuiteCounts(cold.output) }
        : { verdict: 'red', path: cold.path, kept: cold.kept, output: String(cold.output || '').slice(-2000) }
    } catch (err) {
      coldSuite = { verdict: 'unproven', why: err.message }
    }
  }
  io.log(recordRow({ at: io.now(), cold_suite: coldSuite }))
  stageComplete()
  if (coldSuite.verdict !== 'green') {
    const why = coldSuite.verdict === 'red'
      ? `the full suite is GREEN in this lane's checkout (${ctx.checkout}) and RED from ${coldSuite.path} — byte-identical files at the identical commit ${S.commit}, the only variable being which directory the suite ran in. This is NOT an ordinary suite failure: something under test is reading its own absolute path, its cwd, or the NAME of the directory it is running in. The cold checkout was kept at ${coldSuite.kept} so the failure can be reproduced there directly; remove it with \`git worktree remove --force ${coldSuite.kept}\` once you are done.\n${coldSuite.output}`
      : `the cold verification produced no verdict (${coldSuite.verdict}): ${coldSuite.why}. The suite is green only in the checkout this lane built in (${ctx.checkout}), which is the one piece of evidence a lane may not report done on. The commit ${S.commit} is local and unpushed.`
    return escalate('cold-suite', why, [], { commit: S.commit, cold_suite: coldSuite })
  }
  if (publishing && coldSuite.counts === null) {
    stageComplete()
    return escalate('cold-suite', 'the cold suite was green, but its pass/fail summary could not be measured for publication', [], { commit: S.commit, cold_suite: coldSuite })
  }

  if (publishing) {
    stage('publish')
    const branch = String(publishing.branch || '').trim()
    const refusePublish = (reason, detail) => {
      stageComplete()
      return escalate('publish', `publish refused (${reason}): ${detail}`, [], { commit: S.commit, publish: { refused: reason } })
    }
    if (!branch) return refusePublish(PUBLISH_REFUSALS.branchUnresolved, 'the checkout branch is unresolved (detached HEAD)')
    if (branch === PUBLISH_BASE) return refusePublish(PUBLISH_REFUSALS.branchMain, `the checkout branch is ${PUBLISH_BASE}`)

    let ghMissing
    try { ghMissing = io.run('command -v gh') } catch (err) { ghMissing = { ok: false, output: err?.message ?? String(err) } }
    if (!ghMissing?.ok) return refusePublish(PUBLISH_REFUSALS.ghMissing, 'the gh executable is not available')
    let ghAuth
    try { ghAuth = io.run('gh auth status') } catch (err) { ghAuth = { ok: false, output: err?.message ?? String(err) } }
    if (!ghAuth?.ok) return refusePublish(PUBLISH_REFUSALS.ghAuth, 'gh authentication is unavailable')

    let prProbe
    try { prProbe = io.run(`gh pr view ${shellArg(branch)} --json number,url`) }
    catch (err) { prProbe = { ok: false, output: err?.message ?? String(err) } }
    if (prProbe?.ok) return refusePublish(PUBLISH_REFUSALS.prExists, 'an existing pull request was found for this branch')
    const prOutput = String(prProbe?.output || '')
    if (!/no pull requests found/i.test(prOutput)) {
      return refusePublish(PUBLISH_REFUSALS.prCheck, `the existing pull request probe was indeterminate: ${prOutput.slice(-2000)}`)
    }

    const pushStartedAt = io.now()
    let pushed
    try { pushed = io.run(`git push -u origin ${shellArg(branch)}`) }
    catch (err) { pushed = { ok: false, output: err?.message ?? String(err) } }
    const pushMs = io.now() - pushStartedAt
    if (!pushed?.ok) return refusePublish(PUBLISH_REFUSALS.pushRejected, `the branch push was rejected${pushed?.output ? `: ${String(pushed.output).slice(-2000)}` : ''}`)

    const bodyPath = art('pr-body.md')
    let journalText = ''
    try { journalText = String(io.readFile(journal) || '') } catch { /* anomalies are never load-bearing */ }
    const trailers = issueTrailers(message)
    const gateNow = gateBlock()
    // The record IS the narrator's prompt. Driver-composed fields are path-clean: the
    // cold checkout stays in the journal and the gate command renders checkout-relative.
    // `intent` is the builder's commit body verbatim, so an absolute path it carries reaches the body.
    const record = {
      intent: commitIntent(message),
      closes: trailers.closes,
      issues: trailers.refs,
      stages: [...S.stages],
      cursor: roundCursor(S.stages),
      files: [...committing],
      gate: gateNow ? {
        cmd: relativizeCommand(gateNow.cmd, { checkout: ctx.checkout, taskDir: ctx.taskDir }),
        summary: parseGateSummary(lastGateOutput),
        discrimination: gateNow.discrimination ?? '',
        repairs: gateNow.repairs ?? 0,
      } : null,
      review: { verdict: finalReview.verdict === 'pass' ? 'pass' : 'changes-needed', residuals: finalReview.residuals, ...carriedBlock() },
      suite: { warm: warmCounts, cold: coldSuite.counts, cold_verified: coldSuite.counts !== null },
      anomalies: prAnomalies(journalRowsSinceRunStart(journalText)),
    }
    let registerText = ''
    try { registerText = String(io.readFile(`${ctx.checkout}/crew/capabilities.json`) || '') } catch { /* narration is never load-bearing */ }
    const narrated = narrateRecord({ record, registerText, io })
    const bodyRecord = applyNarration(record, narrated)
    try {
      io.log(recordRow({ at: io.now(), narration: bodyRecord.narrative
        ? { outcome: 'accepted', chars: bodyRecord.narrative.length, model: narrated.model ?? null }
        : { outcome: 'refused', reason: narrated.refused ?? null } }))
    } catch { /* instrumentation is never load-bearing */ }
    const prCreateStartedAt = io.now()
    let created
    try {
      io.writeFile(bodyPath, composePrBody(bodyRecord))
      created = io.run(`gh pr create --base ${shellArg(PUBLISH_BASE)} --head ${shellArg(branch)} --title ${shellArg(subject)} --body-file ${shellArg(bodyPath)}`)
    } catch (err) {
      created = { ok: false, output: err?.message ?? String(err) }
    }
    const prCreateMs = io.now() - prCreateStartedAt
    const urlMatch = String(created?.output || '').match(/https:\/\/[^\s]+\/pull\/(\d+)/)
    if (!created?.ok || !urlMatch) return refusePublish(PUBLISH_REFUSALS.prCreate, `gh pr create did not return a pull request URL${created?.output ? `: ${String(created.output).slice(-2000)}` : ''}`)
    const url = urlMatch[0]
    const number = Number(urlMatch[1])
    const publishedRow = { url, number, branch, base: PUBLISH_BASE, base_sha: baseSha, rebased, durations_ms: { rebase: rebaseMs, push: pushMs, pr_create: prCreateMs } }
    io.log(recordRow({ at: io.now(), published: publishedRow }))
    published = { url, number, head: branch, base_sha: baseSha }
    stageComplete()
  }

  stage('done')

  const result = {
    status: 'done',
    summary: `Task ${ctx.task} complete: committed ${S.commit} (${committing.length} files), suite green, cold-verified from ${coldSuite.path}, ${accepted}. Stages: ${S.stages.join(' | ')}`,
    artifacts: [planPath, art('review.md'), journal],
    details: {
      ...(variant === DIRECTED_STAGE_HEAD ? { variant } : {}),
      commit: S.commit, stages: S.stages, files_committed: committing, consults: S.consults,
      dissents: S.dissents, accepted_via: accepted, escalation: null,
      ...(published ? { pr: published } : {}),
      cold_suite: coldSuite,   // the COLD verdict, never folded into the lane's own suite result
      extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, enforcements: S.enforcements,
      gate: gateBlock(),
      ...acceptDecisionBlock(),
      ...carriedBlock(),
    },
  }
  stageComplete()
  return result
}

// A declared anchor binds by TOKEN SEQUENCE, not by the bytes a planner typed before
// the builder wrote the code: b301-daemonid stranded a complete, green lane on one
// line break (#733). Normalization is WHITESPACE-ONLY — runs of [ \t\r\n] collapse to
// one space and NOTHING else changes — so it can never widen what a mutation matches
// beyond the same tokens, and a gate still cannot weaken itself to pass.
const ANCHOR_WHITESPACE = /[ \t\r\n]/
// Collapse whitespace runs, keeping per normalized character the ORIGINAL byte span
// that produced it, so a normalized hit resolves back to exact original bytes.
function normalizeAnchor(text) {
  let out = ''
  const starts = []
  const ends = []
  let i = 0
  while (i < text.length) {
    if (ANCHOR_WHITESPACE.test(text[i])) {
      let j = i
      while (j < text.length && ANCHOR_WHITESPACE.test(text[j])) j += 1
      out += ' '; starts.push(i); ends.push(j); i = j
    } else {
      out += text[i]; starts.push(i); ends.push(i + 1); i += 1
    }
  }
  return { text: out, starts, ends }
}

// A `//` comment runs to the end of its line, so a `replace` spliced VERBATIM into a
// span that crosses a line ending inside one lands INSIDE the comment: the gate then
// reddens for a reason the declaration never named and the row can record `killed`
// (#742). The rule: for every line terminator INSIDE the resolved span, the span's own
// text on the line ending there may not carry `//`. EVERY terminator normalizeAnchor
// collapses counts — `ANCHOR_WHITESPACE` is `/[ \t\r\n]/`, so a normalized match can
// cross a standalone CR as readily as LF or CRLF. A span with no interior line
// terminator is never affected, so b301-daemonid's `if … {` / `try {` case still binds.
const UNSAFE_COMMENT = '//'
function spanCommentUnsafe(original, start, end) {
  const span = original.slice(start, end)
  const lines = span.split(/\r\n|\r|\n/)
  // Every line but the LAST ends at a terminator inside the span; the last one does
  // not, so a `//` there cannot swallow what replaces the span.
  for (const spanLine of lines.slice(0, -1)) {
    if (spanLine.includes(UNSAFE_COMMENT)) return true
  }
  return false
}

// Two ORDERED attempts. EXACT first, written with `indexOf` because the settled
// contract makes the primitive load-bearing (gate check A16 reads this line) —
// byte-for-byte the behaviour that exists today.
// Only on an exact miss, whitespace-normalized, and only when the normalized hit is
// UNIQUE: an anchor that cannot say WHICH span to mutate is not an anchor.
export function bindMutationAnchor(original, find) {
  if (typeof original !== 'string' || typeof find !== 'string' || find.length === 0) return { mode: 'absent', spans: [] }
  if (original.indexOf(find) !== -1) return { mode: 'exact', spans: [] }
  const src = normalizeAnchor(original)
  const needle = normalizeAnchor(find).text
  const spans = []
  for (let at = src.text.indexOf(needle); at !== -1; at = src.text.indexOf(needle, at + 1)) {
    spans.push({ start: src.starts[at], end: src.ends[at + needle.length - 1] })
  }
  if (spans.length === 0) return { mode: 'absent', spans: [] }
  if (spans.length > 1) return { mode: 'ambiguous', spans }
  const [only] = spans
  if (spanCommentUnsafe(original, only.start, only.end)) return { mode: 'unsafe', spans }
  return { mode: 'normalized', spans }
}

// `text: null` is the ONE signal that the anchor did not bind. `replace` is inserted
// VERBATIM into the resolved span — never normalized, never reformatted.
export function applyMutationAnchor(original, find, replace) {
  const bound = bindMutationAnchor(original, find)
  if (bound.mode === 'exact') return { mode: 'exact', text: original.replaceAll(find, replace) }
  if (bound.mode === 'normalized') {
    const { start, end } = bound.spans[0]
    return { mode: 'normalized', text: `${original.slice(0, start)}${replace}${original.slice(end)}` }
  }
  return { mode: bound.mode, text: null }
}

// Why an anchor did not bind, per mode — the reader-facing half of the split.
const bindingWhy = (mode, file) => (mode === 'ambiguous'
  ? `the declared find text matches more than one whitespace-normalized span of the built ${file}, so the anchor cannot say which to mutate`
  : mode === 'unsafe'
    ? `the declared find's normalized match crosses a line that carries a // comment inside the span, so a verbatim replacement would land in the comment; declare a find that starts after the comment`
    : `the declared find text is nowhere in the built ${file}, exactly or whitespace-normalized`)

// #874 — THE BIND CHECK. Every declaration measured against the built tree before a single
// mutation is written. b384-suiteslot lost a lane because check B2's declared `find` joined
// crew/drive.mjs:5178 and :5187 with one newline while the built tree carried nine comment lines
// between them — the block the ACCEPTED plan prescribed in its own §2. Nothing compared the
// declaration with the built source until the anchor was applied, and by then the only actor who
// could correct it was gone. An exemption declares no anchor, so it produces no row: `declared`
// counts anchors, which is the denominator a drift rate needs.
export function bindMutationDeclarations(entries, readFile) {
  const rows = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.exempt) continue
    const original = readFile(entry.file)
    if (original === null) {
      rows.push({ check: entry.check, file: entry.file, status: 'absent', why: `${entry.file} does not exist in the built tree` })
      continue
    }
    const bound = bindMutationAnchor(original, entry.find)
    const status = BIND_STATUS[bound.mode]
    rows.push({ check: entry.check, file: entry.file, status, why: status === 'absent' ? bindingWhy(bound.mode, entry.file) : null })
  }
  return rows
}

// #874 — a CORRECTION must bind EXACTLY ONCE. bindMutationAnchor's normalized arm already refuses
// a second span, but its exact arm is bare `indexOf` and applyMutationAnchor rewrites with
// `replaceAll`, so a PLAN declaration may legitimately hit several spans. A builder's correction
// may not: the check whose anchor it replaces has to be the one span the gate reddens on, so a
// second exact occurrence is `ambiguous` here and refused.
// The second search resumes at `first + 1`, NOT at `first + find.length`, because OVERLAPPING
// candidate start offsets are still MULTIPLE textual binds: `'aa'` occurs at offsets 0 AND 1 of
// `'aaa'`, and skipping the overlap would call an anchor unique that is not. (It is NOT that
// `replaceAll` would rewrite both: measured, `'aaa'.replaceAll('aa','X')` is `'Xa'`, one rewrite.
// The rule is a uniqueness rule, not a rewrite-count one.) One character is also exactly how the
// normalized arm counts its spans (crew/drive.mjs:4965), so exact-correction uniqueness and the
// existing normalized uniqueness contract agree rather than disagreeing by one character.
// MUTATION D2b: resume at `first + find.length` and an overlapping second occurrence is skipped —
// the correction is admitted as unique when a second textual bind exists.
export function bindMutationCorrection(original, find) {
  const bound = bindMutationAnchor(original, find)
  if (bound.mode !== 'exact') return bound
  const first = original.indexOf(find)
  return original.indexOf(find, first + 1) === -1 ? bound : { mode: 'ambiguous', spans: [] }   // ANCHOR D2b
}

// #874 (2) — the BUILDER's one authoring moment, validated the way validateHardened validates the
// reviewer's owed guards: [{ entries, refusals }], closed reason tokens, never free prose.
// `entries` are CANDIDATES, not acceptances: only finalizeCorrections can accept one, and only on
// an adjudicated `killed` row. `file` is NOT the builder's to name — it comes from the declaration,
// so a correction can re-aim the anchor inside the file the plan chose and never at another file.
// Labels are PRE-COUNTED so a duplicate is atomic: a duplicated label yields no candidate at all
// and exactly one refusal, rather than pushing the first entry before noticing the second.
export function validateMutationCorrections(details, binds, declarations, readFile) {
  const refusals = []
  const entries = []
  const refuse = (check, reason, why) => { refusals.push({ check: check ?? null, reason, why }) }
  const declared = details?.mutation_corrections
  if (declared === undefined) return { entries, refusals }
  if (!Array.isArray(declared)) {
    refuse(null, 'not-an-array', 'details.mutation_corrections must be an array of corrections')
    return { entries, refusals }
  }
  const byCheck = new Map((Array.isArray(declarations) ? declarations : []).map((entry) => [entry?.check, entry]))
  const bindByCheck = new Map((Array.isArray(binds) ? binds : []).map((row) => [row?.check, row]))
  const labelOf = (entry) => (entry && typeof entry === 'object' && typeof entry.check === 'string' ? entry.check : null)
  const labelCounts = new Map()
  for (const entry of declared) { const label = labelOf(entry); if (label != null) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1) }
  const duplicated = new Set()
  for (const entry of declared) {
    const check = labelOf(entry)
    const declaration = byCheck.get(check)
    if (!check || declaration === undefined) {
      refuse(check, 'unknown-check', `the correction names ${check ?? '(no check)'} but the plan declared no mutation with that label`)
      continue
    }
    // MUTATION E2: raise this pre-counted threshold out of reach and the FIRST of two corrections
    // for one label becomes a candidate before the second is seen — the label is then both a
    // candidate and refused, and the candidate is still applied.
    if (labelCounts.get(check) > 1) {                                                                // ANCHOR E2
      if (!duplicated.has(check)) { duplicated.add(check); refuse(check, 'duplicate-check', `more than one correction names check ${check}`) }
      continue
    }
    const bind = bindByCheck.get(check)
    // MUTATION E1: widen this to any status but `exact` and the builder may re-aim a mutation whose
    // declared anchor bound perfectly — the plan's proof, replaced at build time by the very seat
    // the proof exists to measure.
    if (bind?.status !== 'absent') {                                                                 // ANCHOR E1
      refuse(check, 'correction-not-absent', `check ${check} bound ${bind?.status ?? 'nothing'} against the built tree, so there is no anchor to correct`)
      continue
    }
    if (typeof entry.find !== 'string' || entry.find.length === 0 || typeof entry.replace !== 'string' || entry.replace === entry.find || !mutationChangesTokens(entry.find, entry.replace) || ['file', 'exempt'].some((key) => Object.prototype.hasOwnProperty.call(entry, key))) {
      refuse(check, 'correction-shape', 'a correction carries exactly check, find and replace, with a non-empty literal find and a replace that changes a token')
      continue
    }
    const original = readFile(declaration.file)
    const fit = original === null ? { mode: 'absent' } : bindMutationCorrection(original, entry.find)
    // MUTATION D1: rename the mode this branch reads and a correction that reaches nothing falls
    // into the ambiguity branch instead — the operator is sent hunting a second span that never
    // existed, and the two failures stop being distinguishable.
    if (fit.mode === 'absent') {                                                                     // ANCHOR D1
      refuse(check, 'correction-absent', `the corrected find for ${check} is nowhere in the built ${declaration.file}, exactly or whitespace-normalized`)
      continue
    }
    // MUTATION D2: make this predicate unsatisfiable and a correction matching more than one span
    // becomes a candidate — the gate then reddens on a span nobody chose.
    if (fit.mode !== 'exact' && fit.mode !== 'normalized') {                                         // ANCHOR D2
      refuse(check, 'correction-ambiguous', `the corrected find for ${check} does not bind exactly once in the built ${declaration.file}: ${bindingWhy(fit.mode, declaration.file)}`)
      continue
    }
    entries.push({ check, file: declaration.file, find: entry.find, replace: entry.replace })
  }
  return { entries, refusals }
}

// #874 — the accepted candidates substituted into the declaration list. The plan's `mutations`
// array is never edited: this is the ONE place a build-time anchor replaces a plan-time one, and
// the `corrected` flag it sets is what lets the proof attribute the row to the builder.
export function correctedMutations(mutations, binds, corrections) {
  const byCheck = new Map((Array.isArray(corrections) ? corrections : []).map((entry) => [entry.check, entry]))
  return (Array.isArray(mutations) ? mutations : []).map((entry) => {
    const correction = byCheck.get(entry?.check)
    return correction === undefined ? entry : { ...entry, find: correction.find, replace: correction.replace, corrected: true }
  })
}

// #874 — ONE TERMINAL STATE per check, computed once, before bindReport(), settleCheckProof() or
// anchorAbsentWhy() reads anything. The plan-check's finding, in one function: a statically
// admissible correction is a CANDIDATE and nothing more. The final states are exactly
//   accepted                       — a candidate whose corrected row was adjudicated `killed`
//   refused / correction-green     — a candidate whose corrected row SURVIVED
//   refused / correction-unproven  — a candidate that never produced an adjudicated row at all
//                                    (an earlier contained throw, or a loop that never reached it)
//   refused / <static reason>      — a candidate the validator refused
//   none                           — no correction was offered for this check
// `unresolved` comes from the BIND REPORT, never from the proof rows that happened to execute: a
// declaration measured absent before the pass began stays a disagreement even if an earlier
// mutation threw and its own row was never written.
export function finalizeCorrections(binds, corrections, rows) {
  const bindRows = Array.isArray(binds) ? binds : []
  const proofRows = Array.isArray(rows) ? rows : []
  const candidates = new Set((corrections?.entries || []).map((entry) => entry.check))
  const staticRefusal = new Map()
  for (const refusal of corrections?.refusals || []) {
    if (refusal?.check != null && !staticRefusal.has(refusal.check)) staticRefusal.set(refusal.check, refusal.reason)
  }
  const outcomeOf = (check) => proofRows.find((row) => row.check === check)?.outcome ?? null
  const terminal = (check) => {
    if (candidates.has(check)) {
      const outcome = outcomeOf(check)
      // MUTATION C2: accept on any outcome rather than only on `killed` and a correction is
      // credited before the evidence exists — the premature acceptance #874 is about, one level
      // down: a survived or never-adjudicated correction reaches the journal as `accepted`.
      if (outcome === 'killed') return { correction: 'accepted', refusal: null }                     // ANCHOR C2
      // MUTATION D3: return `accepted` from this arm and the third acceptance condition is deleted:
      // the builder can pick a no-op anchor, the check resolves, and the lane commits with a
      // mutation that killed nothing.
      return { correction: 'refused', refusal: outcome === 'survived' ? 'correction-green' : 'correction-unproven' }   // ANCHOR D3
    }
    if (staticRefusal.has(check)) return { correction: 'refused', refusal: staticRefusal.get(check) }
    return { correction: 'none', refusal: null }
  }
  const withTerminal = (row) => { const t = terminal(row.check); return { ...row, correction: t.correction, ...(t.refusal ? { correction_refusal: t.refusal } : {}) } }
  const finalBinds = bindRows.map(withTerminal)
  // A row for a check nobody corrected is returned UNTOUCHED — INCLUDING an uncorrected
  // binding-failure row. Only a check that has a correction CANDIDATE or a static refusal is
  // decorated, because only those have terminal correction state worth reading. The terminal state
  // for every declaration lives on `finalBinds` and on the dedicated absence journal row, which is
  // where the operator reads it; putting `correction: 'none'` on a legacy proof row would change a
  // shape nothing asked to change and break the exact deep-equals at crew/drive.test.mjs:4276
  // (killed), :4303 (exempt), :4339 (anchor-absent) and :4610 (unapplied) for no gain.
  const finalRows = proofRows.map((row) => (candidates.has(row.check) || staticRefusal.has(row.check) ? withTerminal(row) : row))
  // MUTATION B3: derive this from `finalRows` instead and an absent declaration the pass never
  // reached vanishes from the routing decision — proof rows carry no `status`, so the filter
  // matches nothing and the lane continues as `unproven`, exactly as before #874.
  const unresolved = finalBinds.filter((row) => row.status === 'absent' && row.correction !== 'accepted')   // ANCHOR B3
  return { binds: finalBinds, rows: finalRows, unresolved }
}

// #874 (1)(2) — the operator-facing sentence for a plan/build disagreement, and the one place that
// names the class. It ALWAYS carries the literal `anchor-absent`, because that token is what
// escalationCause Rule 2 (scripts/factory/ledger.mjs:189) reads to classify the row as
// `plan-build-disagreement` / `driver`; a sentence without it lands `unclassified` (measured).
// It ALSO keeps the established literal `did not BIND to the built tree`, which is the phrase
// today's percheckNote uses for the same class (crew/drive.mjs:3435) and which four existing
// assertions read — positively at crew/drive.test.mjs:4088 and :4128, and negatively at :4089
// (`did not kill` must NOT appear on an anchor-absent escalation) and :4131 (`did not BIND` must
// NOT appear on a survived one). This sentence takes the route percheckNote's binding-failure
// branch used to take, so it inherits that branch's vocabulary rather than minting a second one.
export function anchorAbsentWhy(unresolved) {
  const rows = Array.isArray(unresolved) ? unresolved : []
  const detail = rows.map((row) => `${JSON.stringify(row.check)} in ${row.file} (bind ${row.status}, correction ${row.correction}${row.correction_refusal ? `/${row.correction_refusal}` : ''}${row.why ? `: ${row.why}` : ''})`).join('; ')
  return `the per-check proof found a PLAN/BUILD disagreement, not a gate defect — anchor-absent: ${rows.length} declared ${rows.length === 1 ? 'anchor' : 'anchors'} did not BIND to the built tree with an accepted correction: ${detail}. The plan predicted source the builder did not write; gate custody cannot repair it, because the lead may not edit the planner's envelope and the planner is never assigned again`
}

// --- the journal channel split (#608's producer half) --------------------------
// The journal is two interleaved streams and said so nowhere. Measured on
// b199-resumestate's 872-row archive: 747 rows (85.7%) are teardown bookkeeping
// and 78 (8.9%) are the run of record, so a reader of journal.jsonl reads the
// heartbeat and calls it the run. A consumer could not separate them without
// pattern-matching event names — and the driver's own rows carry no `event` key
// at all (crew/drive.mjs:1594,1827,1852), so a name-matcher is blind to all 38 of
// its emit sites and silently misfiles the next one someone adds. That is how the
// 85% happened, so the channel is decided at the EMIT SITE: every journal write in
// this file and in crew/seat-io.mjs names one of the two wrappers below, and the
// suite refuses a write that names neither.
//
// This is the FENCED PRODUCER HALF. Eight more modules write to the same journal
// (crew/crew.mjs, crew/child.mjs, crew/headless.mjs, crew/headless-rpc.mjs, the
// three pi extensions, scripts/factory/lane-watch.mjs) and are out of this lane's
// fence; the vocabulary is exported so wiring them is one line per site.
//
// record      — what the task DID: stages and their completions, assignments,
//               envelopes, decisions, consults, dissents, seat refusals, re-asks,
//               seat deaths and reseats, gate outcomes, escalations.
// operational — the machinery keeping processes and surfaces tidy, and the
//               liveness OBSERVATIONS that only watch it: descendant capture and
//               reclaim, seat-root settle, teardown sweeps, process group reaping,
//               transcript staleness, pane-usage accounting, viewer surfaces.
// #751 The bare `bounce` a lead running an older charter still answers. Where a
// site offers the two recipients IN PLACE of that bare name, the bare answer means
// the one it always meant — the builder — so vocabulary drift costs a journal note,
// not an escalation; the same rule reads an ADVISOR's bare recommendation, so a
// perspective is never silently dropped for saying the old word. Declared down here,
// below every crew/roles citation this file carries, so the call sites inside
// consultLead and askLead add no line above them (#743, #748).
export function bounceTargetOf(decision, options) {
  const offered = Array.isArray(options) ? options : []
  if (decision !== 'bounce' || offered.includes('bounce') || !offered.includes('bounce-builder')) return decision
  return 'bounce-builder'
}

// The re-review brief's stale-verdict note. `null` when the review round was not
// reached through a reviewer bounce, so an ordinary review brief is unchanged.
// ONE helper serves BOTH exhaustion sites, so it may state only what holds at both.
// At site A the ordinary review-fix path executes `continue build` before the
// top-of-review exhaustion is reached again; at site B the consult follows the
// verdict directly with no tree-changing stage between them. "the tree moved after
// the review" is therefore the LEAD's decision rule, documented in crew/roles/lead.md,
// not a chronology this helper can assert after either call site. What is true at
// both is the lead's ruling and the state of the CURRENT tree. "every configured
// acceptance gate" is deliberate too: gateCmd is nullable and the acceptance-gate
// stage is conditional on it.
export function staleVerdictLines(stale) {
  if (!stale || typeof stale.path !== 'string') return []
  return ['',
    `The lead ruled the verdict in ${stale.path} STALE (${stale.where}) against the CURRENT tree`,
    `and ruled its finding already closed. This reviewer bounce itself built nothing;`,
    `the CURRENT tree has already passed the scope gate, the validation lane, and every`,
    `configured acceptance gate. You are REPLACING that verdict against this tree,`,
    `not answering it — read the diff again.`]
}

// #843 — the plan-acceptance scope vocabulary. `dispatched: null`, never 0: a lane
// dispatched with no scope was never COMPARED, and an unmeasured cell carries null and a
// closed reason rather than a fabricated zero (CLAUDE.md). `same` is its own token so a
// reader can tell "compared, identical" from "never compared".
export const PLAN_SCOPE = Object.freeze({
  undispatched: 'plan-scope-undispatched',
  same: 'plan-scope-same',
  narrowed: 'plan-scope-narrowed',
  widened: 'plan-scope-widened',
})
export const PLAN_SCOPE_VERDICTS = Object.freeze(Object.values(PLAN_SCOPE))
// Array-ness and non-emptiness are all this helper judges about `dispatched`; a non-empty
// MALFORMED array is compared as dispatched, which is outside the production contract —
// every dispatch path validates the scope with the same leaf before the driver sees it
// (crew/crew.mjs:427, crew/child.mjs:71, crew/daemon.mjs:105), so a second copy here would
// be the drift that leaf exists to prevent.
export function planScopeVerdict(dispatched, planned) {
  const asked = Array.isArray(planned) ? planned : []
  if (!Array.isArray(dispatched) || dispatched.length === 0) {
    return { verdict: PLAN_SCOPE.undispatched, added: [], dropped: [], dispatched: null, planned: asked.length }
  }
  const added = outOfScopeFiles(asked, scopeMatcher(dispatched))
  const dropped = outOfScopeFiles(dispatched, scopeMatcher(asked))
  // Widening DOMINATES a simultaneous drop: b359 both added two modules and shed the two
  // anchor manifests it was dispatched to repair, and the refusal must name the additions.
  const verdict = added.length > 0 ? PLAN_SCOPE.widened : dropped.length > 0 ? PLAN_SCOPE.narrowed : PLAN_SCOPE.same
  return { verdict, added, dropped, dispatched: dispatched.length, planned: asked.length }
}
export function planScopeWhy(verdict, final) {
  return `the plan widens the dispatched write surface with ${verdict.added.join(', ')} — a lane may narrow the surface it was dispatched with, never widen it${final ? '; on the final plan round there is no revision left to bounce it to' : ''}`
}
export function planScopeBounceLines(round, verdict, briefFile, dispatched) {
  return [
    `# Plan scope bounce (round ${round})`, '',
    planScopeWhy(verdict, false), '',
    'The dispatched write surface — the only files this lane may write:',
    ...dispatched.map((f) => `- ${f}`), '',
    'Your files_in_scope added, and this lane may not:',
    ...verdict.added.map((f) => `- ${f}`), '',
    'Re-plan INSIDE the dispatched surface. Narrowing it is legal and is recorded, not refused;',
    'if the task genuinely cannot be built inside it, return status insufficient with the gap as',
    'a numbered details.questions entry rather than widening the surface yourself.', '',
    `Original brief: ${briefFile}`,
  ]
}

// #915 — a validation lane is a SHELL COMMAND, so its inputs must be recovered from it with
// real shell-word rules before any of them can be resolved against the tree. A whitespace
// split is not enough: this repo already emits quoted words that contain the quote
// character itself (shellArg at :2002, crew/drive.test.mjs:10588-10591). Adjacent quote
// runs concatenate, exactly as /bin/sh does. A quote that never closes is a DEFECT, never
// a guess.
export function shellWords(text) {
  const src = String(text ?? '')
  const words = []
  let word = null
  let mode = 'plain'
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (mode === 'single') { if (ch === "'") mode = 'plain'; else word += ch; continue }
    if (mode === 'double') {
      if (ch === '"') { mode = 'plain'; continue }
      if (ch === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) { i += 1; word += src[i]; continue }
      word += ch
      continue
    }
    if (/\s/.test(ch)) { if (word !== null) { words.push(word); word = null } continue }
    if (ch === "'") { mode = 'single'; word = word ?? ''; continue }
    if (ch === '"') { mode = 'double'; word = word ?? ''; continue }
    if (ch === '\\' && i + 1 < src.length) { i += 1; word = (word ?? '') + src[i]; continue }
    word = (word ?? '') + ch
  }
  if (mode !== 'plain') return { words: [], defect: `the lane has an unterminated ${mode} quote` }
  if (word !== null) words.push(word)
  return { words, defect: null }
}
// The shape this driver claims to have parsed. Node-test-ness is established FIRST, and
// only then does the driver decide between parsing and refusing — the order is the whole
// point. A lane that does not ATTEMPT a node --test run has no Node-test inputs for this
// resolver to judge and stays `opaque`: crew/drive.test.mjs passes the lane 'lane-cmd' at
// 221 sites and crew/daemon.test.mjs:1987-1994 drives the real loop with it from outside
// this lane's write surface. A lane that DOES attempt one and that this driver cannot parse
// fails CLOSED as `unparsable`, which pushes a refused row: accepting it unparsed would send
// it to /bin/sh verbatim (:4779), where a pipeline's exit status is `cat`'s and node's own
// load failure is invisible.
export function laneCommandShape(cmd) {
  const { words, defect } = shellWords(cmd)
  if (defect) return { shape: 'unparsable', words: [], why: defect }
  if (words.length === 0) return { shape: 'opaque', words, why: 'the lane is empty' }
  const basename = (word) => word.slice(word.lastIndexOf('/') + 1)
  if (!words.includes('--test') || !words.some((word) => basename(word) === 'node')) return { shape: 'opaque', words, why: `the lane does not present itself as a node --test invocation (${words[0]})` }
  if (words.some((word) => /[&|;<>]/.test(word))) return { shape: 'unparsable', words, why: 'the lane attempts a node --test run through shell operators or redirection, which this driver cannot resolve' }
  if (basename(words[0]) !== 'node') return { shape: 'unparsable', words, why: `the lane attempts a node --test run but its executable is ${words[0]}, so this driver cannot tell which words are its inputs` }
  return { shape: 'node-test', words, why: null }
}
// Every input of a node --test lane, with SCALAR option values consumed, PATH option values
// kept as inputs, and globs kept SEPARATE — a glob is refused below, never omitted. `--`
// enters END-OF-OPTIONS mode: every word after it is a positional even when it begins with
// `-`, which is the only way `node --test -- -fixture.jsonl` names an input at all. A
// LANE_PATH_OPTIONS value is an input in BOTH spellings, because `--import=x` and `--import x`
// make node load the same file and #915 judges what node loads.
export function laneCommandInputs(cmd) {
  const shape = laneCommandShape(cmd)
  const inputs = []
  const globs = []
  if (shape.shape !== 'node-test') return { shape, inputs, globs }
  let endOfOptions = false
  const take = (word) => { if (word.includes('*') || word.includes('?')) globs.push(word); else inputs.push(word) }
  for (let i = 1; i < shape.words.length; i += 1) {
    const word = shape.words[i]
    if (!endOfOptions && word === '--') { endOfOptions = true; continue }
    if (!endOfOptions && word.startsWith('-')) {
      const eq = word.indexOf('=')
      const name = eq > 0 ? word.slice(0, eq) : word
      if (LANE_PATH_OPTIONS.includes(name)) { const value = eq > 0 ? word.slice(eq + 1) : shape.words[i += 1]; if (value !== undefined && value !== '') take(value); continue }
      if (LANE_VALUE_OPTIONS.includes(word)) i += 1
      continue
    }
    take(word)
  }
  return { shape, inputs, globs }
}
// ONE command, one line per input, run in the checkout by io.run (crew/seat-io.mjs:3100).
// This is the AUTHORITATIVE type probe: a directory is proven by `[ -d ]`, never inferred
// from a token that happens to carry no extension.
export function laneProbeCommand(inputs) {
  return `for p in ${inputs.map((input) => shellArg(input)).join(' ')}; do if [ -d "$p" ]; then echo "dir $p"; elif [ -f "$p" ]; then echo "file $p"; elif [ -e "$p" ]; then echo "other $p"; else echo "absent $p"; fi; done`
}
export function laneProbeKinds(output) {
  const kinds = new Map()
  for (const line of String(output ?? '').split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const kind = line.slice(0, space)
    if (LANE_PROBE_KINDS.includes(kind)) kinds.set(line.slice(space + 1), kind)
  }
  return kinds
}
// null when the basename carries no extension.
export function laneInputExtension(token) {
  const base = token.slice(token.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : null
}
// `probe` takes the input list and returns a Map of input -> kind. An input the probe did
// not report is `unreadable` and REFUSED: an unmeasured cell is never read as a pass.
export function resolveValidationLane(cmd, probe) {
  const { shape, inputs, globs } = laneCommandInputs(cmd)
  const rows = []
  if (shape.shape === 'unparsable') rows.push({ input: String(cmd ?? ''), verdict: 'unreadable', why: shape.why })
  for (const glob of globs) rows.push({ input: glob, verdict: 'glob-unresolved', why: 'this driver does not expand a glob, so it cannot resolve one — name the test files' })
  const kinds = inputs.length > 0 ? probe(inputs) : new Map()
  for (const input of inputs) {
    const kind = kinds.get(input) ?? null
    if (kind === null) { rows.push({ input, verdict: 'unreadable', why: 'the tree probe returned no verdict for this input' }); continue }
    if (kind === 'absent') { rows.push({ input, verdict: 'missing', why: 'no such path in this checkout' }); continue }
    if (kind === 'dir') { rows.push({ input, verdict: 'loadable', why: null }); continue }
    if (kind !== 'file') { rows.push({ input, verdict: 'unsupported-type', why: `the path exists but is neither a regular file nor a directory (${kind})` }); continue }
    const ext = laneInputExtension(input)
    if (ext !== null && LOADABLE_LANE_EXTENSIONS.includes(ext)) rows.push({ input, verdict: 'loadable', why: null })
    else rows.push({ input, verdict: 'unsupported-extension', why: `node --test has no loader for ${ext === null ? 'a regular file with no extension' : ext}` })
  }
  const counts = { total: rows.length }
  for (const verdict of LANE_INPUT_VERDICTS) counts[verdict] = rows.filter((row) => row.verdict === verdict).length
  return { shape, rows, refused: rows.filter((row) => row.verdict !== 'loadable'), counts }
}
export function validationLaneWhy(resolved, final) {
  return `${VALIDATION_LANE_UNLOADABLE}: the plan's validation_lane names ${resolved.refused.length} input(s) node --test cannot run — ${resolved.refused.map((row) => `${row.input} (${row.why})`).join('; ')}${final ? '; on the final plan round there is no revision left to bounce it to' : ''}`
}
export function validationLaneBounceLines(round, cmd, resolved, briefFile) {
  return [
    `# Validation lane bounce (round ${round})`, '',
    validationLaneWhy(resolved, false), '',
    'The lane you returned, unedited — this driver refuses a lane, it never rewrites one:',
    `    ${cmd}`, '',
    'The inputs it refused:',
    ...resolved.refused.map((row) => `- ${row.input} — ${row.why}`), '',
    'Every input of a node --test lane must EXIST in the checkout and be loadable: a directory,',
    `or a regular file ending ${LOADABLE_LANE_EXTENSIONS.join(', ')}. A glob is refused because this driver`,
    'does not expand one. Return a details.validation_lane naming only test files. Nothing was',
    'dropped from your lane and nothing will be.', '',
    `Original brief: ${briefFile}`,
  ]
}

export const JOURNAL_CHANNELS = Object.freeze({ record: 'record', operational: 'operational' })
export const JOURNAL_CHANNEL_NAMES = Object.freeze(Object.keys(JOURNAL_CHANNELS))

// ADDITIVE by construction, and in this order for a reason: the payload spreads
// FIRST so no existing key can be lost, and the channel is stamped LAST so the
// emit site's choice always wins over a `channel` arriving inside a spread
// payload (crew/drive.mjs:2787 spreads a caller-built panel entry).
export const recordRow = (row) => ({ ...row, channel: JOURNAL_CHANNELS.record })
export const operationalRow = (row) => ({ ...row, channel: JOURNAL_CHANNELS.operational })

// --- suite slots (#824, parent #822) -----------------------------------------------
// The phases below are the only places this driver competes with OTHER LANES for local
// CPU. A model turn is not one of them: a seat waiting on a provider costs this host
// nothing, so assignAndWait, the panel and every consult run unslotted BY CONSTRUCTION —
// there is no acquire on that path to disable.
export const SUITE_SLOT_PHASES = Object.freeze({ gate: 'gate', warm: 'suite-warm', cold: 'suite-cold' })
export const SUITE_SLOT_PHASE_NAMES = Object.freeze(Object.values(SUITE_SLOT_PHASES))
export const PHASE_SLOT_WAIT_EVENT = 'phase-slot-wait'

// crew/reclaim.mjs's idiom, and crew/host-load.mjs:96's copy of it: a synchronous wait
// with no busy loop. Copied a third time for the reason the second copy already records
// — neither module exports it. io.sleep overrides it, which is how a test waits in zero
// wall-clock.
const slotNap = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// ONE policy under one name, and ONE root. slotPolicy (crew/host-load.mjs:101) is the
// resolver the shipped dispatcher already takes (scripts/factory/dispatch-batch.mjs:1624),
// so an unconfigured host queues in BOTH consumers and CREW_SUITE_SLOTS=0 stays the one
// documented off switch (crew/reclaim.mjs:1169-1175). The root is factoryStateRoot's,
// verbatim (scripts/factory/dispatch-batch.mjs:1508-1510) and NOT the arms/profile
// factory root: in a relocated factory the dispatcher and the driver must lease from the
// same slots/ directory or the cross-lane cap is two caps.
export function slotAdmission(env = process.env) {
  const policy = slotPolicy({ env })
  if (!policy) return null
  const root = env?.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  return { capacity: policy.capacity, root }
}

// #823's acquire is non-blocking (crew/reclaim.mjs:1274) and this is the driver's loop
// around it. A null pool means no policy, and then this is a call to run() and nothing
// else — no row, no beat, no branch a reader could see.
export function withPhaseSlot({ pool, phase, owner, now, sleep = slotNap, log = () => {},
  emit = () => {}, ceiling = SLOT_WAIT_CEILING_MS, interval = SLOT_WAIT_INTERVAL_MS } = {}, run) {
  if (!pool) return run()
  const startedAt = now()
  // A clock that does not advance is not a measurement, so the loop is bounded by scans
  // as well as by time; neither bound alone can wedge a lane.
  const maxScans = Math.max(1, Math.ceil(ceiling / interval) + 1)
  let depth = null
  let handle = null
  for (let scan = 0; scan < maxScans; scan += 1) {
    // NO catch here, deliberately. A store that cannot answer is not admission:
    // swallowing an unresolvable claim would let every affected lane exceed K at once,
    // exactly when the pool cannot protect the host. The store exposes that state as a
    // throw on purpose (crew/reclaim.mjs:1260-1264) and #825's wrapper does not swallow
    // it either (crew/host-load.mjs:115-133). Only a COMPLETED wait that reaches the
    // ceiling runs unslotted.
    const attempt = pool.acquire({ owner })
    if (attempt?.handle) { handle = attempt.handle; break }
    depth = Number.isSafeInteger(attempt?.depth) ? attempt.depth : null
    // The driver is ALIVE and this completed scan is the observation that proves it.
    // Without this a lane queued behind K suites goes quiet for up to the ceiling and
    // reads as DEAD to exactly the liveness code that exists to prevent it
    // (crew/seat-io.mjs:1416, #813).
    emit({ kind: 'heartbeat', at: now(), role: null })
    if (now() - startedAt >= ceiling) break
    sleep(interval)
  }
  // ADMISSION row, written once, whether or not a slot was won: a wait nobody recorded
  // is a wait nobody can price. queue_depth is null when no scan ever reported one —
  // absent, never 0 (#297).
  // The optional-call spelling is deliberate: the driver's source inventory recognizes
  // this helper sink and therefore accounts for the operational row below.
  const recordWait = () => log?.(operationalRow({ at: now(), event: PHASE_SLOT_WAIT_EVENT, kind: phase,
    queue_depth: depth, waited_ms: now() - startedAt, slotted: handle !== null }))
  // A queue is not a refusal (crew/reclaim.mjs:1140): a ceiling REACHED — and only that
  // — hands the caller its phase back unslotted rather than failing a run that would
  // have succeeded. Nothing is held on this path, so the row is written outside any
  // release region.
  if (!handle) { recordWait(); return run() }
  // FINALLY, not a trailing statement, and the row write is INSIDE it. io.runCold THROWS
  // rather than report a verdict it could not take (crew/drive.mjs:4745) — and so does
  // io.log: the driver turns a journal fault into an escalation
  // (crew/drive.test.mjs:7440-7457). Every now() and every journal operation performed
  // after a successful acquire therefore sits inside the release region; a phase — or a
  // row — that escalates or crashes holding its slot would otherwise strand it for every
  // other lane until the pool reclaims a dead pid, which it cannot do while this driver
  // is still alive.
  try { recordWait(); return run() } finally { pool.release(handle) }
}

// #800 — the reviewer's finding DISPOSITION. Declared down here, below every
// crew/roles citation this file carries, so the call sites in envelopeDefect,
// reviewFindings, assignAndWait, panelReview and the review loop add no line
// above them (#743, #748).
export const FINDING_DISPOSITIONS = Object.freeze(['auto-fix', 'ask-user', 'no-op'])

// The disposition this entry declares, or null. OUT-OF-ENUM READS AS ABSENT: the
// field is optional in this release, and a value the driver cannot recognise is
// unknown, never a guess — an unrecognised disposition gets today's handling
// (a seat closes it) rather than a mechanical apply nobody authorised.
export function dispositionOf(entry) {
  const declared = entry && typeof entry === 'object' ? entry.disposition : undefined
  return FINDING_DISPOSITIONS.includes(declared) ? declared : null
}

// #800 ADDENDUM — the closed shape of a finding id that may reach a FILESYSTEM PATH.
// `art()` is string concatenation (crew/drive.mjs:1789) and the applier interpolates
// the id into a patch artifact filename, so the id is the one reviewer-authored value
// in this file that becomes a path component. Bounded on BOTH axes because the two
// failures differ: the character set keeps `../` and a NUL out of the path, and the
// 64-character bound keeps a long-but-legal id from throwing ENAMETOOLONG on a real
// filesystem before the fix is either applied or journalled refused.
// NARROWER than crew/driver.mjs's SAFE_TOKEN_RE by one character on purpose: dropping
// `.` makes the companion DOTS_ONLY_RE unnecessary, so ONE regex is the whole contract.
export const FINDING_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

// A reviewer's `pass` may not carry a must-fix: the charter has always said a
// must-fix forces changes-needed (crew/roles/reviewer.md), and until now nothing
// checked it, so a pass with an open must-fix committed (#772). Read from the RAW
// entries: REFUSING is the safe direction, so a must-fix reviewFindings had to drop
// still must refuse the pass. AUTHORIZING is the opposite — see acceptedRawById.
// Returns an envelope refusal or null.
export function verdictFindingsDefect(details) {
  const verdict = details && typeof details === 'object' ? details.verdict : undefined
  if (verdict !== 'pass' && verdict !== 'approve') return null
  const entries = Array.isArray(details.findings) ? details.findings : []
  const mustFix = entries.filter((entry) => entry && typeof entry === 'object' && entry.severity === 'must-fix')
  const counted = Number.isInteger(details.must_fix) && details.must_fix > 0
  if (mustFix.length === 0 && !counted) return null
  const named = mustFix.map((entry) => (typeof entry.id === 'string' ? entry.id : '(unnamed)')).join(', ')
  return {
    reason: 'verdict-findings',
    why: `verdict is ${JSON.stringify(verdict)} but the review carries ${mustFix.length || details.must_fix} must-fix finding(s)${named ? ` (${named})` : ''} — a must-fix forces changes-needed`,
  }
}

// #800 ADDENDUM — an id outside FINDING_ID_SHAPE is a SHAPE DEFECT on the envelope,
// refused BY NAME and re-asked. It is never rewritten and never truncated: truncation
// is what mints a collision — two long ids sharing a prefix resolve to ONE artifact
// path and the second finding's bytes overwrite the first's before either is applied.
// Read from the RAW entries, like verdictFindingsDefect, because refusing is the safe
// direction. An entry with NO id (or a non-string, or blank) is left exactly as it is
// today: reviewFindings drops it (crew/drive.mjs:826-829), so it reaches no path, and
// refusing the whole envelope for it would change behaviour this task never asked for.
// The reported id is TRUNCATED IN THE MESSAGE ONLY — a 1,000-character id must not
// become a 1,000-character journal row — and the truncation is visibly marked.
export function findingIdDefect(details) {
  const entries = Array.isArray(details?.findings) ? details.findings : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') continue
    if (FINDING_ID_SHAPE.test(entry.id)) continue
    const shown = entry.id.length > 80 ? `${entry.id.slice(0, 80)}… (${entry.id.length} chars)` : entry.id
    return {
      reason: 'finding-id',
      why: `finding id ${JSON.stringify(shown)} is outside the closed shape ${String(FINDING_ID_SHAPE)} — a finding id becomes a patch artifact path component, so it is refused rather than rewritten`,
    }
  }
  return null
}

// The ONE shape gate on a reviewer envelope, so envelopeDefect, assignAndWait,
// panelReview and the review loop can never disagree about what is refusable.
// Order is stated, not incidental: the verdict contradiction is the older and more
// consequential defect, so it is the reason a run reports when both are true.
export function reviewShapeDefect(details) {
  return verdictFindingsDefect(details) || findingIdDefect(details)
}

// #800 ADDENDUM — a guarded write. INSTRUMENTATION IS NEVER LOAD-BEARING and neither
// is a patch artifact: a path the filesystem refuses (a component too long, a byte the
// OS rejects, a directory that vanished) must refuse the FINDING, not the run. Returns
// null on success or the throw's message; it never re-throws.
// `??` and NOT `||`, prescribed and load-bearing: `new Error('')` has a FALSY message, so
// `(err && err.message) || err` stringifies the Error OBJECT to "Error" and the empty-message
// fallback below becomes unreachable. `err?.message ?? err ?? ''` keeps the empty string,
// which is falsy, so the fallback fires — which is what the unit case claims.
export function guardedWrite(io, filePath, contents) {
  try { io.writeFile(filePath, contents); return null } catch (err) { return String(err?.message ?? err ?? '') || 'the write threw with no message' }
}

// The RAW entry behind each ACCEPTED finding, by id. It mirrors reviewFindings's
// acceptance order EXACTLY — id, then severity, then `seen` — because that order is
// load-bearing: reviewFindings rejects a malformed severity BEFORE adding the id to
// `seen` (crew/drive.mjs:826-838), so a later valid entry sharing that id is the one
// accepted. A map keyed on "first entry with a string id" would hand the REJECTED
// entry's patch bytes to the accepted finding's routing — a confused deputy, and the
// exact opposite of "only accepted findings authorize". ONE helper, used by both
// dispositionPlan and panelReview, so the two can never drift apart.
export function acceptedRawById(details) {
  const accepted = new Map()
  const seen = new Set()
  for (const entry of Array.isArray(details?.findings) ? details.findings : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') continue
    if (!FINDING_SEVERITIES.includes(entry.severity)) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    accepted.set(entry.id, entry)
  }
  return accepted
}

// The files a unified diff would write, repo-relative — or a refusal naming why the
// write surface could not be read. FAILS CLOSED, PER SECTION: a patch is parsed by
// `diff --git` section and the WHOLE patch is refused when ANY section fails, because
// a patch whose second section is unreadable can still carry a first section that
// looks in-scope, and outOfScopeFiles would then be handed an incomplete list while
// git apply applies both. Rename/copy metadata, binary patches and quoted paths are
// rejected explicitly; a section carrying no `---`/`+++` pair (a mode-only change) is
// rejected by the pair rule; a side that decodes to the EMPTY path is rejected too,
// because outOfScopeFiles([]) is [] and an unread surface would otherwise pass the
// scope check trivially. `/dev/null` is allowed on ONE side only.
export const PATCH_METADATA_REFUSED = Object.freeze(['rename from ', 'rename to ', 'copy from ', 'copy to ', 'GIT binary patch'])
export function patchTargets(patch) {
  const refuse = (why) => ({ targets: [], refusal: why })
  if (typeof patch !== 'string' || patch.trim() === '') return refuse('the patch is empty')
  const lines = patch.split('\n')
  const starts = []
  lines.forEach((line, index) => { if (line.startsWith('diff --git ')) starts.push(index) })
  if (starts.length === 0) return refuse('the patch declares no "diff --git" section, so its write surface cannot be read')
  if (lines.slice(0, starts[0]).some((line) => line.trim() !== '')) return refuse('the patch carries content before its first "diff --git" section')
  const targets = new Set()
  for (let i = 0; i < starts.length; i += 1) {
    const section = lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : lines.length)
    for (const banned of PATCH_METADATA_REFUSED) {
      if (section.some((line) => line.startsWith(banned))) return refuse(`a section carries "${banned.trim()}" metadata, whose write surface this parser does not decode`)
    }
    const olds = section.filter((line) => line.startsWith('--- '))
    const news = section.filter((line) => line.startsWith('+++ '))
    if (olds.length !== 1 || news.length !== 1) return refuse(`section ${JSON.stringify(section[0])} does not carry exactly one "---"/"+++" target pair`)
    const read = (line) => {
      const raw = line.slice(4).split('\t')[0].trim()
      if (raw === '/dev/null') return { devNull: true }
      if (raw.startsWith('"')) return { quoted: true }
      return { path: raw.replace(/^[ab]\//, '') }
    }
    const before = read(olds[0])
    const after = read(news[0])
    if (before.quoted || after.quoted) return refuse('a section carries a quoted path this parser does not decode')
    if (before.devNull && after.devNull) return refuse('a section names /dev/null on both sides, so it writes nothing this parser can check against files_in_scope')
    for (const side of [before, after]) {
      if (side.devNull) continue
      if (!side.path) return refuse('a section decodes to an empty path, so its write surface cannot be checked against files_in_scope')
      targets.add(side.path)
    }
  }
  // Defense in depth: an empty target set would pass outOfScopeFiles trivially. The
  // per-side rule above makes this unreachable today — deliberately kept, and NOT
  // given a gate check, because an unreachable guard is one no mutation can kill and
  // a check no mutation can kill is vacuous by this repo's own rule.
  if (targets.size === 0) return refuse('the patch names no file this parser can check against files_in_scope')
  return { targets: [...targets], refusal: null }
}

// Split one review's findings by what the DRIVER can do with them, per ADR-030's
// programmatic-over-model-tokens rule (#800, TRD §5 R4):
//   autoFix   — mechanically safe and carrying a patch: code applies it, no seat.
//   askUser   — touches behaviour or scope: the LEAD decides, never code.
//   needsSeat — everything else a verdict demands: today's builder round.
// A `no-op` finding is informational and appears in none of the three. Routing comes
// from the normalized (accepted) findings and the patch bytes from acceptedRawById,
// so a malformed or duplicate entry can neither route nor execute.
export function dispositionPlan(details) {
  const parsed = reviewFindings(details)
  const accepted = parsed ? parsed.findings : []
  const raw = acceptedRawById(details)
  const autoFix = []
  const askUser = []
  const needsSeat = []
  for (const finding of accepted) {
    const disposition = finding.disposition
    const entry = raw.get(finding.id) || {}
    if (disposition === 'auto-fix' && typeof entry.patch === 'string' && entry.patch.trim() !== '') {
      autoFix.push({ id: finding.id, severity: finding.severity, patch: entry.patch })
      continue
    }
    if (disposition === 'ask-user') {
      askUser.push({ id: finding.id, severity: finding.severity, location: finding.location, summary: finding.summary })
      continue
    }
    if (disposition === 'no-op') continue
    if (finding.severity === 'must-fix' || finding.severity === 'should-fix') needsSeat.push(finding.id)
  }
  return { autoFix, askUser, needsSeat }
}

// The lead's ask-user consult body. The lead decides what to do with findings the
// reviewer says a human must weigh — never re-deciding the findings themselves.
export function askUserLines(findings) {
  return [
    `The reviewer marked ${findings.length} finding(s) \`ask-user\`: they touch behaviour or scope, so code may not close them.`,
    ...findings.map((f) => `- ${f.id} (${f.severity ?? 'unstated'}) ${f.location ?? ''} — ${f.summary ?? ''}`.replace(/\s+/g, ' ').trim()),
    'Send them to the builder with guidance, or escalate to a human.',
  ]
}

// #846 — the driver knows its own artifact vocabulary. A `returns/*.json` inside the
// CHECKOUT is protocol-shaped debris in a protocol-named directory, not a rogue source
// edit; naming it as one sent an operator hunting a change nobody had made (b363).
export const SCOPE_REFUSALS = Object.freeze(['out-of-scope-edits', 'envelope-in-checkout', 'envelope-and-edits'])
export const ENVELOPE_DEBRIS = /(?:^|\/)returns\/[^/]+\.json$/
export function scopeRefusal(outOfScope) {
  const files = (Array.isArray(outOfScope) ? outOfScope : []).filter((f) => typeof f === 'string' && f !== '')
  const envelopes = files.filter((f) => ENVELOPE_DEBRIS.test(f))
  const edits = files.filter((f) => !ENVELOPE_DEBRIS.test(f))
  const envelopeWhy = `an envelope was written to the checkout instead of the assignment's absolute returnPath: ${envelopes.join(', ')}`
  const editWhy = `out-of-scope edits persisted: ${edits.join(', ')}`                 // ANCHOR A3
  if (files.length === 0) return { reason: null, envelopes, edits, why: null }
  if (envelopes.length === 0) return { reason: 'out-of-scope-edits', envelopes, edits, why: editWhy }
  // MUTATION A2: return the generic refusal here and a returns/*.json in the checkout
  // is once more reported as a rogue source edit.
  if (edits.length === 0) return { reason: 'envelope-in-checkout', envelopes, edits, why: envelopeWhy }   // ANCHOR A2
  return { reason: 'envelope-and-edits', envelopes, edits, why: `${envelopeWhy}; ${editWhy}` }
}

export function scopeBounceBrief(round, refusal, scopeFiles, planPath) {
  const lines = [`# Scope bounce (round ${round})`, '']
  if (refusal.envelopes.length > 0) {
    lines.push("An ENVELOPE was written into the CHECKOUT instead of the assignment's absolute returnPath:",
      ...refusal.envelopes.map((f) => `- ${f}`),
      'Delete it from the checkout and write your envelope to the returnPath the assignment names. Every scratch or fixture envelope belongs in a tmpdir.', '')
  }
  if (refusal.edits.length > 0) {
    lines.push("These files are OUTSIDE the plan's scope — revert them or stop touching them:",
      ...refusal.edits.map((f) => `- ${f}`), '')
  }
  lines.push('In-scope set:', ...scopeFiles.map((f) => `- ${f}`), `Plan: ${planPath}`)
  return lines.join('\n')
}

// #839 — the closed set of marks a REVIEWER may put on a finding to say the defect
// class cannot become a mechanical guard (a naming choice, docs prose). Read ONLY from
// a review envelope: the seat that found the defect is the seat that knows whether it
// is expressible, and a builder that could set this could exempt itself from every
// guard the review asked for. It is NOT a fourth disposition — FINDING_DISPOSITIONS is
// pinned against prose by skills/pr-review/findings-shape.test.mjs:79.
export const HARDENING_MARKS = Object.freeze(['ungateable'])
export function hardeningOf(entry) {
  const declared = typeof entry?.hardening === 'string' ? entry.hardening.trim() : null
  const why = typeof entry?.hardening_why === 'string' ? entry.hardening_why.trim() : ''
  return HARDENING_MARKS.includes(declared) && why !== '' ? declared : null
}

export const HARDENING_REFUSALS = Object.freeze([
  'no-declaration', 'not-an-array', 'unknown-finding', 'duplicate-finding',
  'test-not-in-scope', 'file-not-in-scope', 'name-missing', 'name-file-wrapper', 'find-missing',
  'replace-identical', 'builder-exemption',
])
// Proof OUTCOMES. `name-not-new` is the check's own word for an already-existing test
// name; it lives here rather than in HARDENING_REFUSALS because the witness it is
// measured against exists at PROOF time, not at declaration-validation time.
export const HARDENING_OUTCOMES = Object.freeze([
  'killed', 'survived', 'ungateable',
  'name-not-new', 'name-absent', 'name-ambiguous', 'control-red', 'control-skipped',
  'pre-repair-green',
  'witness-missing', 'witness-absent', 'witness-unreadable',
  'unproven', 'unapplied', 'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe',
])

// #839 — `parseSuiteCounts` (crew/drive.mjs:1789) reads AGGREGATE totals and names no
// test, and a `--test-name-pattern` matching nothing reports the FILE wrapper as
// `ok 1 - <file>` with `# pass 1 # fail 0` (measured, Node v26.7.0). An aggregate rule
// therefore reads an ABSENT check as a passing one and reads ANY unrelated red — a
// syntax error, another subtest — as the declared check failing. Neither is proof, so
// hardening is adjudicated on the EXACT declared subtest and nothing else.
// `parseSuiteCounts` remains the suite-summary parser and adjudicates no hardening.
// EXISTENCE and SUCCESS are different questions, and one parser answers both only if it
// keeps them apart (round-3 check, Prescription 1). A nested subtest line is INDENTED and
// a skipped one carries a `# SKIP`/`# TODO` directive; both are names that EXIST. A parser
// that anchors at `^` or discards a directive line reports `absent` for a check that was
// already there, and `absent` is the one verdict the growth step reads as "the gate grew".
export const NAME_VERDICTS = Object.freeze(['passed', 'failed', 'skipped', 'absent', 'ambiguous'])
export function nameVerdict(output, name) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '')
  const hits = []
  for (const line of text.split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.*)$/.exec(line)   // \s*: a NESTED subtest is indented
    if (!m) continue
    const directive = /#\s*(SKIP|TODO)\b/.test(m[2])
    const label = m[2].replace(/\s*#\s*(SKIP|TODO)\b.*$/, '').trim()  // strip AFTER the name is kept
    if (label !== String(name)) continue                 // EXACT: a file wrapper is not a check
    hits.push(directive ? 'skipped' : (m[1] === 'ok' ? 'passed' : 'failed'))
  }
  if (hits.length === 0) return 'absent'                 // the name is on NO line of this run
  if (hits.length > 1) return 'ambiguous'                // two tests of one name adjudicate nothing
  return hits[0]
}

// The findings that OWE a permanent guard, and the ones the reviewer exempted. Derived
// from the FINDINGS, never from the routing: `dispositionPlan(...).needsSeat` excludes
// auto-fix, ask-user and no-op (crew/drive.mjs:5030-5043), yet an ask-user must-fix
// reaches the builder at crew/drive.mjs:4258-4278 and an auto-fix-only must-fix changes
// the tree and re-reviews in place at crew/drive.mjs:4283-4291. Disposition selects WHO
// repairs; it is not a hardening waiver.
export function hardeningDebt(details) {
  const parsed = reviewFindings(details)
  // MUTATION B5e: restore the needsSeat-only selection and disposition silently waives
  // hardening debt on both the auto-fix and the ask-user repair routes.
  const candidates = parsed?.findings ?? []                                            // ANCHOR B5e
  const owed = []
  const exempt = []
  for (const finding of candidates) {
    if (finding.severity !== 'must-fix') continue
    // MUTATION B7a: stop reading the reviewer's mark and a finding the reviewer
    // declared ungateable is demanded a guard that cannot exist.
    if (finding.hardening === 'ungateable') {                                          // ANCHOR B7a
      exempt.push({ id: finding.id, why: finding.hardening_why })
      continue
    }
    owed.push({ id: finding.id, location: finding.location, summary: finding.summary })
  }
  return { owed, exempt }
}

// A node --test-name-pattern is a REGEX, so the declared name is escaped before it
// becomes one: an unescaped `(` is a syntax error and an unescaped `.` matches a name
// nobody wrote.
export function hardenCommand(testFile, name) {
  const pattern = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `node --test --test-reporter=tap --test-name-pattern=${shellArg(pattern)} ${shellArg(testFile)}`
}

// #839 — the WITNESS run carries NO name filter, and that is load-bearing.
// `--test-name-pattern` SUPPRESSES a nested test whose PARENT does not also match, so a
// filtered witness run cannot observe a nested pre-existing name and `nameVerdict` cannot
// see a line node never emits. Re-measured on this checkout, Node v26.7.0, on a file
// declaring ``test('outer', async (t) => { await t.test(`${label} guard`, { skip: true }, …) })``:
//   --test-name-pattern='F1 guard'          → `ok 1 - n.test.mjs`, `# pass 1 # fail 0 # skipped 0` — NO `F1 guard` line
//   --test-name-pattern='outer|F1 guard'    → `    ok 1 - F1 guard # SKIP`, `# skipped 1`
//   no filter at all                        → `    ok 1 - F1 guard # SKIP`, `# skipped 1`
// The unfiltered run exists ONLY so node registers nested descendants; the exact declared
// name is still the sole adjudicator, through `nameVerdict`. The repaired control, the
// witnessed pre-repair and the mutant runs stay FILTERED — they ask whether one named
// check passes, not what names exist.
export function hardenWitnessCommand(testFile) {
  // MUTATION B5f: filter the witness run to the declared child name and node suppresses
  // the nested line, so an already-existing nested check reads `absent` and is credited
  // as gate growth.
  return `node --test --test-reporter=tap ${shellArg(testFile)}`                       // ANCHOR B5f
}

// #839 — ONE predicate for both declared paths, drawn where `validateMutations` already
// draws it for a declared mutation file (crew/drive.mjs:1475-1500). A directory scope
// matcher is a RAW PREFIX check (crew/drive.mjs:1519-1522), so under scope `crew/tests/`
// the path `crew/tests/../../outside.mjs` satisfies `inScope` and
// `${ctx.checkout}/${file}` escapes the authorized subtree. The hardening proof READS,
// RUNS and WRITES builder-declared paths, so it needs that same boundary — the traversal
// must be refused BEFORE any io.readFile, io.run or io.writeFile touches it.
// MUTATION B10: drop the traversal conjunct and a declared `crew/tests/../../outside.mjs`
// is read, run and written outside the fence.
export const scopedPath = (file, inScope) => typeof file === 'string' && validateScopeEntries([file]).length === 0 && !file.endsWith('/') && inScope(file)   // ANCHOR B10

// ONE token-change predicate, shared by the plan-mutation contract (`validateMutations`,
// crew/drive.mjs:1510) and the hardening declaration contract. `normalizeAnchor` is the
// BINDER's own normalization (crew/drive.mjs:4662), so validation and binding can never
// drift on the characters they disagree about; duplicating this comparison at two call
// sites would recreate exactly the drift the shared helper exists to prevent — and would
// make B13's anchor ambiguous.
// MUTATION B13: make every declaration look like a token change and a hardening mutation
// that only re-spaces its `find` is admitted and can be credited `killed`.
export function mutationChangesTokens(find, replace) {
  return normalizeAnchor(find).text !== normalizeAnchor(replace).text                    // ANCHOR B13
}

export function validateHardened(details, owed, inScope) {
  const wanted = Array.isArray(owed) ? owed : []
  const wantedIds = wanted.map(({ id }) => id)
  const wantedSet = new Set(wantedIds)
  const refusals = []
  const entries = []
  const refusedOwed = new Set()
  const refuse = (finding, reason, why) => {
    if (wantedSet.has(finding)) {
      if (refusedOwed.has(finding)) return
      refusedOwed.add(finding)
    }
    refusals.push({ finding: finding ?? null, reason, why })
  }
  const declared = details?.hardened
  if (declared !== undefined && !Array.isArray(declared)) {
    for (const id of wantedIds) refuse(id, 'not-an-array', 'details.hardened must be an array of declarations')
    return { entries, refusals }
  }
  const byFinding = new Map()
  for (const entry of Array.isArray(declared) ? declared : []) {
    const id = entry && typeof entry === 'object' && typeof entry.finding === 'string' ? entry.finding : null
    if (!id || !wantedSet.has(id)) {
      refuse(id, 'unknown-finding', `the hardened entry names ${id ?? '(no finding)'} but the review carries no owed finding with that id`)
      continue
    }
    if (byFinding.has(id)) {
      refuse(id, 'duplicate-finding', `more than one details.hardened entry names finding ${id}`)
      continue
    }
    byFinding.set(id, entry)
  }
  const scope = typeof inScope === 'function' ? inScope : () => false
  for (const id of wantedIds) {
    const entry = byFinding.get(id)
    // MUTATION B6: strip the finding id and the reason out of this refusal and the
    // bounce is the bare `insufficient` #839 (5) forbids — the operator is told a
    // repair failed and never told WHICH finding lacks a check.
    if (entry === undefined) {
      if (!refusedOwed.has(id)) {
        refusals.push({ finding: id, reason: 'no-declaration', why: `no details.hardened entry names finding ${id}` })   // ANCHOR B6
        refusedOwed.add(id)
      }
      continue
    }
    // MUTATION B7b: stop refusing a builder-claimed exemption and the builder can
    // exempt itself from every guard the reviewer asked for.
    if (entry.hardening !== undefined || entry.exempt !== undefined || entry.ungateable !== undefined) {   // ANCHOR B7b
      refuse(id, 'builder-exemption', `only the reviewer may mark a finding ${HARDENING_MARKS.join(' or ')}; a builder entry claiming it is refused`)
      continue
    }
    if (!scopedPath(entry.test, scope)) {
      refuse(id, 'test-not-in-scope', `the hardened test ${entry.test ?? '(missing)'} is not a file inside files_in_scope`)
      continue
    }
    if (!scopedPath(entry.file, scope)) {
      refuse(id, 'file-not-in-scope', `the hardened implementation ${entry.file ?? '(missing)'} is not a file inside files_in_scope`)
      continue
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      refuse(id, 'name-missing', `the hardened entry for finding ${id} must carry a non-empty test name`)
      continue
    }
    // #839 — node reports the TEST-FILE ARGUMENT as the wrapper subtest whenever no exact
    // subtest ran, so a declared `name` equal to the declared `test` is adjudicated by that
    // wrapper and not by any named check. Re-measured on Node v26.7.0 with
    // `wrapper.test.mjs` under `--test-name-pattern='wrapper\\.test\\.mjs'`: a module with no
    // matching `test()` emits `ok 1 - wrapper.test.mjs` (`nameVerdict` → `passed`), and the
    // same module throwing at top level emits `not ok 1 - wrapper.test.mjs`
    // (`nameVerdict` → `failed`). A builder could then land a bare top-level assertion, get
    // `passed` on the repaired control and `failed` on both the witnessed implementation and
    // the mutant, and reach `killed` — the guard may be real, but it is not the new NAMED
    // check #839 requires and the journal would record a file path as the check name. The
    // name is REFUSED, never silently rewritten.
    // MUTATION B12: drop this branch and a declared name equal to the test file is
    // adjudicated by node's own wrapper label and falsely accepted as a named guard.
    if (entry.name === entry.test) {                                                     // ANCHOR B12
      refuse(id, 'name-file-wrapper', `the declared name ${entry.name} is the test FILE: node reports the test-file argument as a passing or failing wrapper subtest when no exact subtest ran, so a file path cannot identify a named guard`)
      continue
    }
    // #839 — the whitespace rule is the SAME rule the plan-mutation contract already
    // enforces (crew/drive.mjs:1505-1511), through the SAME predicate: a pair whose
    // normalized forms are equal binds the same token sequence and rewrites the same
    // tokens, so it mutates nothing (#742). `replace-identical` is the existing token and
    // its `why` says so in the contract's own words.
    if (typeof entry.find !== 'string' || entry.find.length === 0) {
      refuse(id, 'find-missing', `the hardened entry for finding ${id} must carry a non-empty literal find`)
      continue
    }
    if (typeof entry.replace !== 'string' || entry.replace === entry.find || !mutationChangesTokens(entry.find, entry.replace)) {
      refuse(id, 'replace-identical', 'find and replace differ only in whitespace — that mutates no token')
      continue
    }
    entries.push(entry)
  }
  return { entries, refusals }
}

export function hardeningBounceLines(round, refusals, rows) {
  const lines = [`# Hardening bounce (round ${round})`, '', 'Every owed must-fix needs a permanent named guard proven by its declared mutation.']
  for (const refusal of Array.isArray(refusals) ? refusals : []) {
    lines.push(`- ${refusal.finding ?? '(unknown finding)'}: ${refusal.reason} — ${refusal.why}`)
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.outcome === 'killed' || row.outcome === 'ungateable') continue
    lines.push(`- ${row.finding}: ${row.outcome} — ${row.why}`)
  }
  lines.push('', 'Return details.hardened entries shaped exactly as { finding, test, name, file, find, replace }; the declared name must not exist on the tree the review read.', `Hardening proof for round ${round} did not close every finding.`)
  return lines
}

export function hardeningBriefLines(owed, exempt) {
  const findings = Array.isArray(owed) ? owed : []
  if (findings.length === 0) return []
  const lines = ['', '## Permanent guards required (#839)', 'Every must-fix below needs a permanent named test guard, and its declared kill-mutation must be proven by the driver.']
  lines.push(...findings.map(({ id, location, summary }) => `- ${id} (${location || 'location unspecified'}) — ${summary || 'close this finding with a named guard'}`))
  lines.push('Declare each guard in details.hardened with the exact shape { finding, test, name, file, find, replace }.', 'The declared name must be one that does not exist on the tree the review read; only the reviewer may mark a finding ungateable with a non-empty hardening_why.')
  if (Array.isArray(exempt) && exempt.length > 0) lines.push(...exempt.map(({ id }) => `Reviewer exemption recorded for ${id}.`))
  return lines
}
