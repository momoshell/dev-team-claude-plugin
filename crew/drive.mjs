import { draftPrBody, draftPrTitle, followUpIssueBody, followUpIssueTitle, gateSummaryLine, residualList } from './converge.mjs'
import { adjudicatePanel, fuseFindings } from './escalation-policy.mjs'
import { VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT } from './variants.mjs'
import { protectedHitsIn, resolveProtectedPaths } from './protected-paths.mjs'

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
  extra_rounds: 1, // lead-granted rounds at REVIEW / PLAN-CHECK exhaustion
  lead_consults: 4, // total decision consults per task
  gate_fails_to_triage: 2, // gate failures before build-vs-gate-defect triage
  gate_repairs: 1, // the gate's author may repair it at most once per task
})

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

// The decision enum the lead may return. The driver offers a SUBSET as
// options in each consult; any answer outside the offered set is treated as
// escalate (fail toward the human, never toward silent progress).
export const DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])

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
// The CLOSED set of reasons an envelope refusal can name (#427). A refusal is a
// {reason, why} pair whose reason is one of these; prose stays in `why`.
export const ENVELOPE_REFUSAL_REASONS = Object.freeze([
  'no-envelope', 'summary', 'artifacts', 'details', 'field-missing', 'field-kind', 'field-item',
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
export const REVIEWED_CORE_STAGES = Object.freeze(['build', 'scope-gate', 'lane', 'review', 'suite', 'commit'])
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
  'lane', 'gate', 'gate-baseline', 'gate-proof', 'review', 'suite', 'commit', 'converge'])
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
  return null
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

export function growthRecord(prev, first, { round, plan_bytes, gate_bytes, files_in_scope_count } = {}) {
  const plan = integerOrNull(plan_bytes)
  const gate = integerOrNull(gate_bytes)
  const previous = prev && typeof prev === 'object' ? prev : null
  const plan_delta = previous && plan !== null && Number.isInteger(previous.plan_bytes)
    ? plan - previous.plan_bytes : null
  const gate_delta = previous && gate !== null && Number.isInteger(previous.gate_bytes)
    ? gate - previous.gate_bytes : null
  const measured = [plan, gate].filter((value) => value !== null)
  const combined_bytes = measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null
  const round1_combined_bytes = first?.combined_bytes ?? null
  const ratio = combined_bytes !== null && round1_combined_bytes !== null && round1_combined_bytes !== 0
    ? Math.round((combined_bytes / round1_combined_bytes) * 100) / 100 : null
  const divergent = round >= 2 && combined_bytes !== null && round1_combined_bytes > 0
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
  }
}

export function growthLines(record) {
  return [
    '## Plan growth (evidence, never a verdict — no measurement here can fail a run)',
    `round=${record.round} plan_bytes=${record.plan_bytes} plan_delta=${record.plan_delta} gate_bytes=${record.gate_bytes} gate_delta=${record.gate_delta} combined_bytes=${record.combined_bytes} round1_combined_bytes=${record.round1_combined_bytes} files_in_scope=${record.files_in_scope_count} ratio=${record.ratio} divergent=${record.divergent}`,
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
    seen.add(entry.id)
    findings.push({
      id: entry.id,
      severity: entry.severity,
      location: trimmedOrNull(entry.location),
      summary: trimmedOrNull(entry.summary),
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
    .map(({ id, type }) => ({ id, type, severity: findingById.get(id).severity }))
  const bounded = (text) => text.length > REFUTATION_EVIDENCE_MAX
    ? `${text.slice(0, REFUTATION_EVIDENCE_MAX - 1)}…`
    : text
  const refutedOut = refutedClaims
    .filter(({ id, evidenceValid }) => id !== null && findingById.has(id) && evidenceValid)
    .map(({ id, evidence }) => ({ id, severity: findingById.get(id).severity, evidence: bounded(evidence) }))
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
export const MUTATION_OUTCOMES = Object.freeze(['killed', 'survived', 'unapplied', 'exempt'])
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
  const issues = []
  for (const issue of Array.isArray(planEnv?.details?.issues) ? planEnv.details.issues : []) {
    const digits = String(issue).trim().replace(/^#/, '')
    if (/^\d+$/.test(digits) && !issues.includes(`#${digits}`)) issues.push(`#${digits}`)
  }
  const refs = issues.length ? `Refs: ${issues.join(', ')}` : ''
  return [subject, bodyPart, refs].filter(Boolean).join('\n\n')
}

// --- the driver ----------------------------------------------------------------
// ctx: { task, briefFile, taskDir, checkout, roles: [..seated roles..],
//        lane: <fallback validation command|null>, suite: <full-suite command>,
//        protectedPaths: <resolved per-checkout paths>,
//        laneFence?: [{lane, files:[..]}] — OTHER lanes' write surfaces; absent = unfenced,
//        protectedPathsBasis: <why those paths are in force>,
//        journal: <real journal.jsonl path (lives in the CREW dir)>,
//        limits?, waits?: {<role>: <seconds>} — the per-role seat wait budget overlay (resolveWaits/waitsCtx above) }
// io:  { assign({role, briefFile, note}) -> {id, returnPath},
//        wait(returnPath, timeoutS) -> envelope|null,
//        writeFile(path, content) -> void, readFile(path) -> string|null,
//        run(cmd) -> {ok, output},            // shell, cwd=checkout
//        runClean(cmd) -> {ok, output},      // OPTIONAL: run cmd against the
//                                            // checkout with the uncommitted
//                                            // changes temporarily set aside
//        reseat(role, {reason}) -> closed result // OPTIONAL, never load-bearing
//        changedFiles() -> [repo-relative..], // git status --porcelain paths
//        commit(files, message) -> hash,
//        log(obj) -> void,                    // journal line (code-owned)
//        emit(event) -> void,                 // OPTIONAL: mirror a drive event to the factory ledger; instrumentation is NEVER load-bearing
//        createDraftPr({title, body}) -> {number, url},  // OPTIONAL: factory-mode
//        createIssue({title, body})   -> {number, url},  // gh seam. Both present
//                                                     // => the converge terminal is armed;
//                                                     // absent (every shipped io today)
//                                                     // => behavior is exactly as before.
//        now() -> ms }
export function driveTask(ctx, io) {
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
  const S = { consults: 0, stages: [], commit: null, dissents: [], grants: [], growth: [], modifiers: [], acceptFindings: null, seqHighWater: 0 }
  const art = (name) => `${ctx.taskDir}/${name}`
  // The journal lives in the CREW dir, not the task dir — take its real path
  // from ctx so decision briefs and escalation artifacts never cite a 404.
  const journal = ctx.journal || art('journal.jsonl')
  let gateBlock = () => null

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
    try { S.modifiers.push(record); io.log({ at: io.now(), modifier: record }) } catch { /* never load-bearing */ }
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
    try { S.modifiers.push(record); io.log({ at: io.now(), modifier: record }) } catch { /* never load-bearing */ }
    emit({ kind: 'modifier', modifier: record.modifier, bounce: 'plan-accept', role: 'reviewer',
      outcome: record.outcome, why: record.why, from: record.from ?? null, to: record.to ?? null, rung: record.rung ?? null })
    return record
  }

  const openStages = []
  const stageComplete = () => {
    const label = openStages.pop()
    if (label === undefined) return
    io.log({ at: io.now(), stage_done: label })
  }
  const stage = (label) => {
    const violation = undeclaredStage(shape, label)
    if (violation) throw fail('variant', `the ${variant} shape ${violation}`)
    openStages.push(label)
    S.stages.push(label); io.log({ at: io.now(), stage: label }); io.status?.(label); emit({ kind: 'stage', label })
  }

  // Per-run gate invocation counter. The ledger's gate_results is UNIQUE on
  // (adw_id, gate_name, attempt) with INSERT OR IGNORE, so a repeated attempt
  // number silently DROPS a verdict — this counter is monotonic per run so
  // every invocation lands its own row. It is driver-owned on purpose: the
  // emitter's bumpGateAttempt answers 0 when degraded, which would collide.
  let gateAttempt = 0
  let lastGateOutput = null
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
      res = runner.call(io, wrappable ? wrapped : cmd)
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
      io.log({ at: io.now(), gate_reap: { name, attempt: gateAttempt, ...reap } })
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
    io.log({ at: io.now(), no_lead_escalation: why })
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
    const suiteRes = io.run(ctx.suite)
    if (!suiteRes.ok) {
      io.log({ at: io.now(), converge_declined: 'suite red' })
      emit({ kind: 'converge', action: 'declined', where: 'suite', why: 'suite red' })
      stageComplete()
      return null
    }

    stageComplete()
    stage('converge:issues')
    const residuals = residualList({ findings: S.lastReview?.findings ?? null, gateSummary, gateRed })
    if (residuals.length === 0) {
      io.log({ at: io.now(), converge_declined: 'no residuals' })
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
        io.log({ at: io.now(), converge_declined: 'issue filing failed', residual: residual.id, why: detail })
        emit({ kind: 'converge', action: 'declined', where: 'issues', residual: residual.id, why: detail })
        stageComplete()
        return null
      }
      if (!filed || !Number.isInteger(filed.number)) {
        const detail = `malformed issue result for ${residual.id}`
        io.log({ at: io.now(), converge_declined: 'issue filing failed', residual: residual.id, why: detail })
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
    if (!hasCommitSubject) io.log({ at: io.now(), commit_subject: 'fallback-from-plan-summary' })
    const committing = io.changedFiles().filter(inScope)
    S.commit = io.commit(committing, message)
    emit({ kind: 'converge', action: 'committed', commit: S.commit, files: committing.length })

    stageComplete()
    stage('converge:pr')
    let pr
    try {
      pr = io.createDraftPr({
        title: draftPrTitle({ task: ctx.task }),
        body: draftPrBody({
          gateSummary,
          findings: residuals,
          escalation: { where, why },
          roundHistory: [...S.stages],
          gateRed,
        }),
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
        extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers,
        gate: gateBlock(),
        converge: {
          pr: { number: pr.number, url: pr.url }, draft: true, issues, residuals,
          gate_summary: { line: gateSummary.line, total: gateSummary.total, failed: gateSummary.failed, errored: gateSummary.errored },
        },
      },
    }
    stageComplete()
    return result
  }

  function assignAndWait(role, briefFile, note) {
    const { id, returnPath } = io.assign({ role, briefFile, note })
    const seq = /^d(\d+)$/.exec(id)?.[1]
    if (seq) S.seqHighWater = Math.max(S.seqHighWater, Number(seq))
    io.log({ at: io.now(), assign: id, role, brief: briefFile })
    emit({ kind: 'assign', id, role, brief: briefFile })
    const env = io.wait(returnPath, waits[role] || 1200)
    const review = reviewOutcome(role, env)
    emit({ kind: 'envelope', id, role, status: env?.status || 'no-envelope', ...(review ? { review } : {}) })
    if (review) io.log({ at: io.now(), review_outcome: { dispatch: id, ...review } })
    // The canonical set follows the rule lastReview already follows: a reviewer
    // envelope that CARRIES a findings array replaces it; one that carries no
    // findings key at all leaves it intact (#542). An EMPTY array is truthy and
    // therefore replaces — that is a reviewer saying "I looked and found
    // nothing", which IS a report. An ABSENT key is a seat that did not report,
    // and absence is not zero (#442). Clobbering here erased the whole accept
    // contract and committed on a record claiming zero residuals.
    if (review?.findings) S.acceptFindings = review.findings
    if (review?.findings) S.lastReview = review
    if (review?.findings_report && (review.findings_report.count_mismatch.length || review.findings_report.rejected.length)) {
      io.log({ at: io.now(), review_findings_note: { dispatch: id, ...review.findings_report } })
    }
    if (!validEnvelope(env, role, id)) {
      // env == null was already recorded by io.wait as a 'timeout'; this branch
      // is the seat that DID answer, with something the driver cannot use.
      if (env != null) emit({ kind: 'cell-failure', role, id, failure: 'unusable-envelope', stage: null, detail: `envelope at ${returnPath} failed the shape or anti-replay check` })
      const diagnosis = env == null ? io.waitDiagnosis?.(returnPath) : null       // verbatim: mutation A9
      throw fail(role, `no valid envelope at ${returnPath} within ${waits[role]}s${diagnosis?.text ? ` — ${diagnosis.text}` : ''}`)
    }
    io.log({ at: io.now(), envelope: id, role, status: env.status })
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
      io.log({ at: io.now(), no_lead_escalation: reason })
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
    const recommendation = pEnv.status === 'done' && options.includes(pEnv.details?.recommendation)
      ? pEnv.details.recommendation : null
    const perspective = pEnv.status === 'done'
      ? `${pEnv.details?.perspective || pEnv.summary || '(empty perspective)'} [recommends: ${recommendation || 'unstated'}; confidence: ${pEnv.details?.confidence || 'unstated'}]`
      : `(${from} returned ${pEnv.status}: ${pEnv.summary || 'no detail'})`
    io.log({ at: io.now(), perspective_from: from, recommendation, consult: S.consults })

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
      io.log({ at: io.now(), dissent })
      emit({ kind: 'dissent', ...dissent })
      if (second.decision === 'accept' && recommendation === 'escalate') {
        return { decision: 'escalate', reason: `lead accepted but ${from} independently recommended escalate — on the lenient path a single judge asking for a human is binding` }
      }
    }
    return second
  }

  function askLead(question, options, contextPaths, { round, targets }) {
    const briefPath = art(`decision-${S.consults}${round === 2 ? 'b' : ''}.md`)
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
    const env = assignAndWait('lead', briefPath, round === 2 ? 'decision-final' : 'decision')
    const d = env.details || {}
    // Round 2: a repeat second-opinion passes through raw so consultLead can
    // name the one-hop bound precisely in its escalation reason.
    if (round === 2 && env.status === 'done' && d.decision === SECOND_OPINION) {
      return { decision: SECOND_OPINION }
    }
    const allowed = round === 1 && targets.length > 0 ? [...options, SECOND_OPINION] : options
    if (env.status !== 'done' || !allowed.includes(d.decision)) {
      return { decision: 'escalate', reason: `lead returned ${env.status}/${d.decision ?? 'no decision'} — treating as escalate` }
    }
    io.log({ at: io.now(), decision: d.decision, consult: S.consults, round, reason: d.reason })
    emit({ kind: 'decision', decided: d.decision, why: d.reason || '', consult: S.consults, round })
    return {
      decision: d.decision, reason: d.reason || '', guidance: d.guidance || '', from: d.from,
      residuals: d.residuals, refuted: d.refuted, answers: d.answers,
    }
  }

  // A lead-granted extra round at an exhaustion point that could not grant
  // before. `limits.extra_rounds` is the bound, and it is enforced by NOT
  // OFFERING 'bounce' once spent — an out-of-set answer already escalates
  // (askLead), so a lead that asks anyway fails toward the human.
  const canGrant = () => S.grants.length < limits.extra_rounds
  const grant = (where, round) => {
    S.grants.push({ where, round })
    io.log({ at: io.now(), extra_round_granted: { where, round, consult: S.consults } })
  }

  function escalate(where, why, extraArtifacts = [], extraDetails = {}) {
    stage(`escalate:${where}`)
    const details = {
      stages: S.stages, escalation: { where, why }, commit: null, dissents: S.dissents,
      extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers,
      gate: gateBlock(),
      seq_high_water: S.seqHighWater,
      gate_attempt_high_water: gateAttempt,
      cursor: roundCursor(S.stages),
      consults_spent: S.consults,
      accept_findings: S.acceptFindings,
      head: ctx.head ?? null,
      ...extraDetails,
    }
    const result = {
      status: 'escalation',
      summary: `Task ${ctx.task} needs a human: ${why}`,
      artifacts: [journal, ...extraArtifacts],
      details,
    }
    stageComplete()
    return result
  }

  // Settle a lead accept at either exhaustion point. A missing findings array
  // is the older reviewer contract and remains a legacy accept; an explicit
  // array is always checked against the latest canonical set and recorded.
  function settleAccept(c, where) {
    const findings = S.acceptFindings
    const check = findings === null
      ? { ok: true, residuals: [], refuted: [], unverified: [], refuted_must_fix: [] }
      : validateAcceptDecision({ findings, residuals: c.residuals, refuted: c.refuted })
    const errors = check.errors || []
    const refusedMustFix = check.refuted_must_fix || []
    const outcome = check.ok && check.unverified.length === 0 && refusedMustFix.length === 0 ? 'accepted' : 'escalated'
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
      findings_total: Array.isArray(findings) ? findings.length : 0,
      residuals: check.residuals,
      refuted: check.refuted,
      unverified: check.unverified,
      refuted_must_fix: refusedMustFix,
      errors,
    }
    io.log({ at: io.now(), accept_decision: record })
    emit({ kind: 'accept-decision', ...record })
    return { ok: outcome === 'accepted', why, record, refusedMustFix: refusedMustFix.length > 0 }
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
    io.log({ at: io.now(), envelope_accepted: { variant, seat, files_changed: 0, fields: observedFields } })
    stageComplete()
    stage('done')
    const result = {
      status: 'done',
      summary: `${variant} ${ctx.task} complete: envelope accepted on shape, 0 files changed. Stages: ${S.stages.join(' | ')}`,
      artifacts: [journal, ...env.artifacts],
      details: {
        variant, commit: null, stages: S.stages, files_committed: [], consults: S.consults,
        dissents: S.dissents, accepted_via: shape.accepted_by, escalation: null,
        extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, gate: null,
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
    io.log({ at: io.now(), triage: {
      variant, seat: 'planner', scope_source: shape.sources.scope, lane_source: shape.sources.lane,
      gate_source: shape.sources.gate, inherited: inherited.length, scope: scope.length,
    } })
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
    io.log({ at: io.now(), directed: {
      variant, seat: null, scope_source: shape.sources.scope, lane_source: shape.sources.lane,
      gate_source: shape.sources.gate, scope: directed.files_in_scope.length,
    } })
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
  let extraPlanRounds = 0
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
  for (let round = 1; plans && round <= limits.plan_rounds + extraPlanRounds; round += 1) {
    stage(`plan:r${round}`)
    const env = assignAndWait('planner', planBrief, round === 1 ? 'plan' : 'plan-revision')
    if (env.status !== 'done') {
      const asked = parseQuestions(env.details)
      const questions = asked?.questions ?? []
      if (asked) io.log({ at: io.now(), member_questions: { role: 'planner', round, total: questions.length, ids: questions.map((q) => q.id), rejected: asked.rejected } })
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
      if (questions.length > 0) io.log({ at: io.now(), question_answers: { role: 'planner', round, answered: matched.answered.map((a) => a.id), unanswered: matched.unanswered, rejected: matched.rejected } })
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
        try { io.log({ at: io.now(), gate_path_rejected: value }) } catch { /* evidence only */ }
        return null
      }
      const record = growthRecord(S.growth.at(-1), S.growth[0], {
        round,
        plan_bytes: bytesOf(env.details?.plan_path || art('plan.md')),
        gate_bytes: bytesOf(gatePathOf(env.details)),
        files_in_scope_count: Array.isArray(env.details?.files_in_scope) ? env.details.files_in_scope.length : null,
      })
      S.growth.push(record)
      io.log({ at: io.now(), plan_growth: record })
    } catch { /* measurement is never load-bearing */ }
    if (round >= 2) {
      const carve = validateCarve(env.details)
      io.log({ at: io.now(), carve_verdict: { round, verdict: carve.verdict, defect: carve.defect } })
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
    if (round >= limits.plan_rounds + extraPlanRounds) {
      const options = canGrant() ? ['bounce', 'accept', 'escalate'] : ['accept', 'escalate']
      const c = consultLead(
        `The plan check still says revise after ${round} round(s). Grant one more plan round, accept the latest plan anyway, or escalate?`,
        options, [planPath, check.details?.check_path || art('plan-check.md')],
      )
      if (c.decision === 'escalate') {
        stageComplete()
        stageComplete()
        return escalate('plan-check', c.reason)
      }
      if (c.decision === 'bounce') {
        grant('plan-check', round)
        extraPlanRounds += 1
        const b = art(`plan-bounce-r${round}.md`)
        failureUpgrade('plan', 'planner')
        io.writeFile(b, planRevisionBrief(round, check))
        planBrief = b
        planEnv = null
        stageComplete()
        stageComplete()
        continue
      }
      stageComplete()
      stageComplete()
      break // accept: proceed on the latest plan
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
  if (!planEnv) return escalate('plan', `no accepted plan within ${limits.plan_rounds + extraPlanRounds} rounds`)
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
  let checkProofVerdict = null // 'proven' | 'failed' | 'unproven' | null — the PER-CHECK
  let checkProofPending = null // the generation that OWES a per-check pass, awaiting an observed green
  let gateProofFatal = null    // the built tree still carries a mutation: the run must stop
  gateBlock = () => (gateCmd ? { cmd: gateCmd, repairs: gateRepairs, generation: gateGeneration, discrimination: gateDiscrimination ?? 'unproven', reap: { ...gateReapTally }, ...(gateProofNote ? { discrimination_note: gateProofNote } : {}), ...(gateHistory.length ? { replaced: gateHistory } : {}), ...(gateReverified !== null ? { reverified: gateReverified } : {}), ...(checkProofs ? { check_discrimination: checkProofVerdict, check_discriminations: checkProofs } : {}), ...(checkProofNote ? { check_proof_note: checkProofNote } : {}) } : null)
  const resetCheckProof = () => {
    checkProofs = null; checkProofOutput = null; checkProofNote = null
    checkProofVerdict = null; checkProofPending = null
  }
  const recordGateProof = (label) => {
    resetCheckProof()                     // FIRST, before every early return: a
    gateProvenGeneration = gateGeneration  // generation never inherits the previous
    const settleProof = (summary) => {
      io.log({ at: io.now(), gate_discrimination: gateDiscrimination, gate_generation: gateGeneration, gate_summary: summary, gate_proof_note: gateProofNote })
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
      io.log({ at: io.now(), gate_proof_unproven: err.message, gate_generation: gateGeneration })
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
  const percheckNote = (row) => `the per-check proof did not kill ${JSON.stringify(row?.check)}: ${row?.why}`
  const proofNote = () => (checkProofVerdict === 'failed'
    ? percheckNote((checkProofs || []).find((row) => row.outcome === 'survived' || row.outcome === 'unapplied'))
    : gateProofNote)
  const completeCheckProof = (label) => {
    checkProofPending = null
    stage(label)
    const rows = []
    let survivor = null
    let active = null            // the ONE mutation in flight: {abs, original, writeAttempted}
    try {
      for (const [index, mutation] of mutations.entries()) {
        if (mutation.exempt) {
          rows.push({ check: mutation.check, outcome: 'exempt', why: mutation.exempt, file: null, summary: null })
          continue
        }
        const abs = `${ctx.checkout}/${mutation.file}`
        active = { abs, original: null, writeAttempted: false }
        const original = io.readFile(abs)          // may throw: nothing written yet
        active.original = original
        if (original === null || !original.includes(mutation.find)) {
          rows.push({ check: mutation.check, outcome: 'unapplied', file: mutation.file, summary: null,
            why: original === null
              ? `${mutation.file} does not exist in the built tree`
              : `the declared find text is not in the built ${mutation.file}` })
          survivor ??= rows[rows.length - 1]
          active = null
          continue
        }
        let res = null
        try {
          active.writeAttempted = true
          io.writeFile(abs, original.replaceAll(mutation.find, mutation.replace))
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
        if (why) { survivor ??= rows[rows.length - 1]; checkProofOutput ??= res.output }
      }
    } catch (err) {
      checkProofNote = err?.message || String(err)
      io.log({ at: io.now(), gate_check_proof_unproven: checkProofNote, gate_generation: gateGeneration })
      gateProofFatal = dirtyAfterFailure(active, err)
    }
    checkProofs = rows
    // Precedence, and it matters: a KNOWN survivor is a gate defect even if the
    // pass was later interrupted; an interrupted pass with no survivor proved
    // nothing and may never claim `proven` — that is the same false claim as a
    // vacuous check passing the whole-gate proof, one level down.
    checkProofVerdict = survivor ? 'failed' : checkProofNote ? 'unproven' : 'proven'
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
    catch (readErr) { return `${active.abs} could not be re-read after a failed per-check mutation (${readErr.message}; original failure: ${err.message})` }
    if (current === active.original) return null
    return `${active.abs} does not match the built content after a per-check mutation (${current === null ? 'the file is gone' : 'byte comparison failed'}): ${err.message}`
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
    io.log({ at: io.now(), gate_check_discrimination: checkProofVerdict, gate_generation: gateGeneration,
      gate_check_discriminations: checkProofs, ...(checkProofNote ? { gate_check_proof_note: checkProofNote } : {}) })
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
  let lastReviewPath = art('review.md')
  let panelBriefText = ''
  let panelBounceFindings = ''
  const panelStandingQuestion = 'state the invariant the prior rounds\' instances share; does this diff close it?'
  const panelLog = (entry) => {
    try { io.log({ at: io.now(), ...entry }) } catch { /* panel evidence is never load-bearing */ }
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
    const structuredDivergences = fused.divergent.map(({ id, source, severity, location, summary }) => ({
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

    const adjudicated = adjudicatePanel(fused.divergent, adjEnv.details)
    const findings = [
      ...fused.consensus.map(({ id, severity, location, summary }) => ({
        id, severity, location, summary, reviewer: 'both',
      })),
      ...adjudicated.upheld.map(({ id, severity, location, summary, source }) => ({
        id, severity, location, summary, reviewer: source,
      })),
    ]
    if (adjudicated.closesClass !== true && !findings.some((finding) => finding.severity === 'must-fix')) {
      findings.push({
        id: `panel-class-${n}`,
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
    const outcome = {
      dispatch: `panel-r${n}`,
      panel: true,
      verdict,
      must_fix: review.details.must_fix,
      should_fix: review.details.should_fix,
      consider: review.details.consider,
      findings,
      sources: ['reviewer', panel.partner],
      adjudicator: panel.adjudicator,
      class_invariant: adjudicated.classInvariant,
      closes_class: adjudicated.closesClass,
    }
    panelLog({ review_outcome: outcome })
    S.acceptFindings = findings
    S.lastReview = {
      verdict,
      must_fix: review.details.must_fix,
      should_fix: review.details.should_fix,
      consider: review.details.consider,
      findings,
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
    ].join('\n')
  }
  const panel = ctx.continuation === true ? panelSeats(seatList) : null
  if (ctx.continuation === true && !panel) panelLog({ panel_skipped: 'seats' })
  let gateTriaged = false
  build:
  for (let round = 1; round <= limits.build_rounds + extraRounds; round += 1) {
    const finalRound = () => round >= limits.build_rounds + extraRounds
    stage(`build:r${round}`)
    const env = assignAndWait('builder', buildBrief, buildNote)
    if (env.status !== 'done') {
      const asked = parseQuestions(env.details)
      const questions = asked?.questions ?? []
      if (asked) io.log({ at: io.now(), member_questions: { role: 'builder', round, total: questions.length, ids: questions.map((q) => q.id), rejected: asked.rejected } })
      const c = consultLead(
        [`The builder returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce with guidance, or escalate?`,
          ...questionConsultLines('builder', questions)].join('\n'),
        ['bounce', 'escalate'], [buildBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') {
        stageComplete()
        return escalate('build', c.reason, env.artifacts || [])
      }
      if (finalRound()) extraRounds += 1 // the granted bounce needs a round to land in
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('build', 'builder')
      const matched = matchAnswers(questions, c.answers)
      if (questions.length > 0) io.log({ at: io.now(), question_answers: { role: 'builder', round, answered: matched.answered.map((a) => a.id), unanswered: matched.unanswered, rejected: matched.rejected } })
      io.writeFile(b, [
        `# Build bounce (round ${round})`, '', c.guidance, '',
        `Plan: ${planPath}`,
        ...answerBounceLines(questions, matched),
      ].join('\n'))
      buildBrief = b; buildNote = 'build-fix'
      stageComplete()
      continue
    }
    builderEnv = env
    stageComplete()

    // Gate A (mechanical): scope by git, never by self-report.
    stage(`scope-gate:r${round}`)
    const changed = io.changedFiles()
    const gateFenceHits = laneFenceHits(changed, ctx.laneFence)
    if (gateFenceHits.length > 0) {
      stageComplete()
      return escalate('scope',
        `the build crossed another live lane's fence: ${fenceBreachList(gateFenceHits)} — a file a sibling crew owns is never a bounce, it is a human's call`)
    }
    const outOfScope = outOfScopeFiles(changed, inScope)
    if (outOfScope.length > 0) {
      if (!plans || finalRound()) {
        stageComplete()
        return escalate('scope', `out-of-scope edits persisted: ${outOfScope.join(', ')}`)
      }
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('scope', 'builder')
      io.writeFile(b, `# Scope bounce (round ${round})\n\nThese files are OUTSIDE the plan's scope — revert them or stop touching them:\n${outOfScope.map((f) => `- ${f}`).join('\n')}\n\nIn-scope set:\n${scopeFiles.map((f) => `- ${f}`).join('\n')}\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'scope-fix'
      stageComplete()
      continue
    }
    stageComplete()

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

    // Gate C (judgment, but enum-consumed): the reviewer. An unreadable
    // verdict re-asks the REVIEWER in place — the builder is never re-run
    // for a reviewer's malformed envelope.
    while (true) {
      if (reviews >= limits.review_rounds + extraReviews) {
        const options = canGrant() ? ['bounce', 'accept', 'escalate'] : ['accept', 'escalate']
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
        if (c.decision === 'bounce') {
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
        const settledAccept = settleAccept(c, 'review-exhausted')
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
        accepted = acceptedViaLabel(settledAccept.record)
        stageComplete()
        break build
      }
      const roundNo = reviews + 1
      stage(`review:r${roundNo}`)
      const revBrief = art(`review-brief-${roundNo}.md`)
      panelBriefText = [
        `# Review (round ${roundNo})`, '',
        `Plan of record: ${planPath}. Changes are uncommitted in ${ctx.checkout} — read the diff with git.`,
        `Re-run the validation lane yourself: ${lane}`,
        `Write review.md in the task dir. details.verdict must be pass or changes-needed.`,
      ].join('\n')
      io.writeFile(revBrief, panelBriefText)
      const review = panel ? panelReview(roundNo, panel) : assignAndWait('reviewer', revBrief, 'review')
      lastReviewPath = review.details?.review_path || art('review.md')
      const v = verdictOf(review)
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
      io.log({ at: io.now(), review_round: { n: roundNo, verdict: review.details?.verdict ?? null, accounting: counted ? 'counted' : 'free', charged: reviews } })
      if (v === 'pass') { stageComplete(); stage('review:pass'); accepted = 'review pass'; stageComplete(); break build }
      if (v === 'revise') {
        if (finalRound()) {
          const options = canGrant() ? ['bounce', 'accept', 'escalate'] : ['accept', 'escalate']
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
          if (c.decision === 'bounce') {
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
          const settledAccept = settleAccept(c, 'build-exhausted')
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
        `The reviewer returned an unreadable verdict (status=${review.status}, verdict=${review.details?.verdict}). Bounce the reviewer, or escalate?`,
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

  // ---- 3. FINISH: full suite (code) + commit-on-green (code) --------------------
  stage('suite')
  const suiteRes = io.run(ctx.suite)
  if (!suiteRes.ok) {
    stageComplete()
    return escalate('suite', `full suite red after acceptance — this needs eyes:\n${suiteRes.output.slice(-2000)}`)
  }
  stageComplete()
  stage('commit')
  const message = composeCommitMessage({ task: ctx.task, planEnv, builderEnv })
  const hasCommitSubject = String(planEnv.details?.commit_subject || '').split('\n').some((line) => line.trim())
  if (!hasCommitSubject) io.log({ at: io.now(), commit_subject: 'fallback-from-plan-summary' })
  const committing = io.changedFiles().filter(inScope)
  S.commit = io.commit(committing, message)
  stageComplete()
  stage('done')

  const result = {
    status: 'done',
    summary: `Task ${ctx.task} complete: committed ${S.commit} (${committing.length} files), suite green, ${accepted}. Stages: ${S.stages.join(' | ')}`,
    artifacts: [planPath, art('review.md'), journal],
    details: {
      ...(variant === DIRECTED_STAGE_HEAD ? { variant } : {}),
      commit: S.commit, stages: S.stages, files_committed: committing, consults: S.consults,
      dissents: S.dissents, accepted_via: accepted, escalation: null,
      extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers,
      gate: gateBlock(),
    },
  }
  stageComplete()
  return result
}
