import { draftPrBody, draftPrTitle, followUpIssueBody, followUpIssueTitle, gateSummaryLine, residualList } from './converge.mjs'
import { adjudicatePanel, fuseFindings } from './escalation-policy.mjs'

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
// realIo() (in crew.mjs) wires it to driver.mjs + child_process.

export const LIMITS = Object.freeze({
  plan_rounds: 2, // planner attempts (initial + bounces)
  build_rounds: 3, // builder attempts across lane/scope/review bounces
  review_rounds: 2, // reviewer verdicts
  extra_rounds: 1, // lead-granted rounds at REVIEW / PLAN-CHECK exhaustion
  lead_consults: 4, // total decision consults per task
  gate_fails_to_triage: 2, // gate failures before build-vs-gate-defect triage
  gate_repairs: 1, // the gate's author may repair it at most once per task
})

export const WAITS_S = Object.freeze({
  planner: 1800, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
})

// The decision enum the lead may return. The driver offers a SUBSET as
// options in each consult; any answer outside the offered set is treated as
// escalate (fail toward the human, never toward silent progress).
export const DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])

// #45 Tier B slice 1. The failure upgrade is spent ONCE PER TASK, across all
// roles and all bounce kinds — the ratified budget is per task, not per role.
export const FAILURE_UPGRADE = 'failure-upgrade'
export const SENSITIVITY_FLOOR = 'sensitivity-floor'
export const JUDGE_TIER = 'judge'
// Ratified for this repo on issue #250 (orchestrator, 2026-08-16). Directories
// are trailing-slash prefixes, spelled as files_in_scope entries are spelled.
// crew/roles/ is deliberately absent: charters are pinned by tests already.
// Per-repo lists arrive with #252; this slice hardcodes the ratified one.
export const PROTECTED_PATHS = Object.freeze([
  '.github/workflows/', 'crew/roster.json', 'crew/roster.schema.json',
  'crew/reclaim.mjs', 'crew/escalation-policy.mjs', 'crew/drive.mjs', 'docs/adr/',
])
export const MODIFIER_OUTCOMES = Object.freeze(['applied', 'transport', 'exhausted', 'no-tier', 'agent-change', 'spent'])

// The compounding valve: on the FIRST round of a consult the lead may answer
// decision='second-opinion' with details.from=<a seated judgment member>.
// CODE then gathers that member's perspective — same question and context,
// deliberately WITHOUT the lead's leaning (unseeded, so it is genuinely
// independent) — and re-asks the lead once, with the perspective attached
// and the valve removed. One hop, then the judge must judge. The whole
// exchange counts as ONE consult against the limit.
export const SECOND_OPINION = 'second-opinion'
export const PERSPECTIVE_TARGETS = Object.freeze(['reviewer', 'tech-lead', 'planner'])
export const PANEL_PARTNERS = Object.freeze(['tech-lead', 'planner'])
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
    const evidenceValid = typeof evidence === 'string' && evidence.trim().length > 0
    if (id === null) error(null, 'missing id')
    if (!evidenceValid) error(id, 'empty refutation evidence')
    return { id, evidenceValid }
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
  const refutedOut = refutedClaims
    .filter(({ id, evidenceValid }) => id !== null && findingById.has(id) && evidenceValid)
    .map(({ id }) => ({ id }))
  const unverified = residualsOut
    .filter((residual) => residual.type === 'correctness-unverified')
    .map((residual) => residual.id)
  const result = {
    ok: errors.length === 0,
    residuals: residualsOut,
    refuted: refutedOut,
    unverified,
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
  )
  return lines
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

export function scopeMatcher(entries) {
  return (repoRelativePath) => entries.some((entry) => entry.endsWith('/')
    ? repoRelativePath.startsWith(entry)
    : repoRelativePath === entry)
}

export function protectedHits(entries) {
  const hits = []
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = String(raw ?? '')
    if (!entry) continue
    // Both directions: a scope entry under a protected directory ('docs/adr/031.md'
    // vs 'docs/adr/'), and a scope directory that contains a protected file.
    if (PROTECTED_PATHS.some((p) => entry === p || (p.endsWith('/') && entry.startsWith(p)) || (entry.endsWith('/') && p.startsWith(entry)))) {
      if (!hits.includes(entry)) hits.push(entry)
    }
  }
  return hits
}

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
//        journal: <real journal.jsonl path (lives in the CREW dir)>,
//        limits?, waits? }
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
  const limits = { ...LIMITS, ...(ctx.limits || {}) }
  const waits = { ...WAITS_S, ...(ctx.waits || {}) }
  const S = { consults: 0, stages: [], commit: null, dissents: [], grants: [], growth: [], modifiers: [], acceptFindings: null }
  const art = (name) => `${ctx.taskDir}/${name}`
  // The journal lives in the CREW dir, not the task dir — take its real path
  // from ctx so decision briefs and escalation artifacts never cite a 404.
  const journal = ctx.journal || art('journal.jsonl')

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

  // Every stage transition goes to the journal AND (when io provides it) to
  // a live status surface — the workspace pill — so a quiet team is never
  // illegible: the pill says which CODE stage is running (suite, gate,
  // commit...). On escalation it freezes at the failing stage.
  const stage = (label) => { S.stages.push(label); io.log({ at: io.now(), stage: label }); io.status?.(label); emit({ kind: 'stage', label }) }

  // Per-run gate invocation counter. The ledger's gate_results is UNIQUE on
  // (adw_id, gate_name, attempt) with INSERT OR IGNORE, so a repeated attempt
  // number silently DROPS a verdict — this counter is monotonic per run so
  // every invocation lands its own row. It is driver-owned on purpose: the
  // emitter's bumpGateAttempt answers 0 when degraded, which would collide.
  let gateAttempt = 0
  let lastGateOutput = null
  // `runner` is an io METHOD, so it must be invoked as one: `realIo.runClean`
  // calls `this.run(cmd)` (crew/realio.mjs:241,245), and passing it detached
  // (`runGate(..., io.runClean)` below) made `this` undefined under ESM strict
  // mode — a live driver crash at `gate-reverify`. The fake io in
  // drive.test.mjs defines runClean as an arrow that never reads `this`, so
  // the contract's own specification could not express the requirement the
  // shipped implementation had. Bind here rather than forbid `this` in io
  // implementations: every other io call site in this file is a method call,
  // and this keeps that true for runners too.
  const runGate = (name, cmd, runner = io.run, pristine = false) => {
    const res = runner.call(io, cmd)
    gateAttempt += 1
    emit({ kind: 'gate', name, attempt: gateAttempt, ok: !!res.ok, cmd, summary: parseGateSummary(res.output), generation: gateGeneration, pristine })
    return res
  }
  // Attention fires ONLY where the gate loop stops being self-correcting:
  // exhaustion, or escalation of the build-vs-gate question to triage. A
  // red-then-green cycle is the loop working and raises nothing.
  // park_id is explicitly null: #125 mints park ids and has not landed.
  const gateAttention = (why, artifacts = []) =>
    emit({ kind: 'attention', moment: 'gate', park_id: null, task: ctx.task, why, artifacts })
  const gateEscalate = (why, extra = []) => { gateAttention(why, [journal, ...extra]); return escalate('gate', why, extra) }

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
      return null
    }

    stage('converge:issues')
    const residuals = residualList({ findings: S.lastReview?.findings ?? null, gateSummary, gateRed })
    if (residuals.length === 0) {
      io.log({ at: io.now(), converge_declined: 'no residuals' })
      emit({ kind: 'converge', action: 'declined', where: 'residuals', why: 'no residuals to record' })
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
        return null
      }
      if (!filed || !Number.isInteger(filed.number)) {
        const detail = `malformed issue result for ${residual.id}`
        io.log({ at: io.now(), converge_declined: 'issue filing failed', residual: residual.id, why: detail })
        emit({ kind: 'converge', action: 'declined', where: 'issues', residual: residual.id, why: detail })
        return null
      }
      residual.issue = { number: filed.number, url: filed.url }
      issues.push({ number: filed.number, url: filed.url })
      emit({ kind: 'converge', action: 'issue-filed', residual: residual.id, number: filed.number })
    }

    stage('converge:commit')
    const message = composeCommitMessage({ task: ctx.task, planEnv, builderEnv })
    const hasCommitSubject = String(planEnv.details?.commit_subject || '').split('\n').some((line) => line.trim())
    if (!hasCommitSubject) io.log({ at: io.now(), commit_subject: 'fallback-from-plan-summary' })
    const committing = io.changedFiles().filter(inScope)
    S.commit = io.commit(committing, message)
    emit({ kind: 'converge', action: 'committed', commit: S.commit, files: committing.length })

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
      return escalate(
        'converge-pr',
        `the work is committed at ${S.commit} but the draft PR could not be opened: ${detail}`,
        [],
        { commit: S.commit, converge: { pr: null, issues } },
      )
    }
    if (!pr || !Number.isInteger(pr.number) || typeof pr.url !== 'string' || pr.url.length === 0) {
      const detail = 'malformed draft PR result'
      return escalate(
        'converge-pr',
        `the work is committed at ${S.commit} but the draft PR could not be opened: ${detail}`,
        [],
        { commit: S.commit, converge: { pr: null, issues } },
      )
    }

    stage('converge')
    emit({ kind: 'converge', action: 'settled', commit: S.commit, pr: pr.number, issues: issues.length })
    return {
      status: 'converge',
      summary: `Task ${ctx.task} converged with residuals: committed ${S.commit} (${committing.length} files), suite green, ${gateRed ? 'gate red' : 'gate green with unresolved review findings'} — DRAFT PR #${pr.number}, ${issues.length} follow-up issue(s) filed. Merge authority stays human.`,
      artifacts: [planPath, journal],
      details: {
        commit: S.commit, stages: S.stages, files_committed: committing, consults: S.consults,
        dissents: S.dissents, accepted_via: null, escalation: { where, why },
        extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers,
        gate: gateCmd ? { cmd: gateCmd, repairs: gateRepairs, generation: gateGeneration, discrimination: gateDiscrimination ?? 'unproven', ...(gateProofNote ? { discrimination_note: gateProofNote } : {}), ...(gateHistory.length ? { replaced: gateHistory } : {}), ...(gateReverified !== null ? { reverified: gateReverified } : {}) } : null,
        converge: {
          pr: { number: pr.number, url: pr.url }, draft: true, issues, residuals,
          gate_summary: { line: gateSummary.line, total: gateSummary.total, failed: gateSummary.failed, errored: gateSummary.errored },
        },
      },
    }
  }

  function assignAndWait(role, briefFile, note) {
    const { id, returnPath } = io.assign({ role, briefFile, note })
    io.log({ at: io.now(), assign: id, role, brief: briefFile })
    emit({ kind: 'assign', id, role, brief: briefFile })
    const env = io.wait(returnPath, waits[role] || 1200)
    const review = reviewOutcome(role, env)
    emit({ kind: 'envelope', id, role, status: env?.status || 'no-envelope', ...(review ? { review } : {}) })
    if (review) io.log({ at: io.now(), review_outcome: { dispatch: id, ...review } })
    if (review) S.acceptFindings = review.findings ?? null
    if (review?.findings) S.lastReview = review
    if (review?.findings_report && (review.findings_report.count_mismatch.length || review.findings_report.rejected.length)) {
      io.log({ at: io.now(), review_findings_note: { dispatch: id, ...review.findings_report } })
    }
    if (!validEnvelope(env, role, id)) {
      // env == null was already recorded by io.wait as a 'timeout'; this branch
      // is the seat that DID answer, with something the driver cannot use.
      if (env != null) emit({ kind: 'cell-failure', role, id, failure: 'unusable-envelope', stage: null, detail: `envelope at ${returnPath} failed the shape or anti-replay check` })
      throw fail(role, `no valid envelope at ${returnPath} within ${waits[role]}s`)
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
    return {
      status: 'escalation',
      summary: `Task ${ctx.task} needs a human: ${why}`,
      artifacts: [journal, ...extraArtifacts],
      details: { stages: S.stages, escalation: { where, why }, commit: null, dissents: S.dissents, extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers, ...extraDetails },
    }
  }

  // Settle a lead accept at either exhaustion point. A missing findings array
  // is the older reviewer contract and remains a legacy accept; an explicit
  // array is always checked against the latest canonical set and recorded.
  function settleAccept(c, where) {
    const findings = S.acceptFindings
    const check = findings === null
      ? { ok: true, residuals: [], refuted: [], unverified: [] }
      : validateAcceptDecision({ findings, residuals: c.residuals, refuted: c.refuted })
    const errors = check.errors || []
    const outcome = check.ok && check.unverified.length === 0 ? 'accepted' : 'escalated'
    const errorWhy = errors.map(({ id, why }) => `${id ?? 'decision'} ${why}`)
    const unverifiedWhy = check.unverified.map((id) => `${id} is correctness-unverified`)
    const whyParts = [...errorWhy, ...unverifiedWhy]
    const why = outcome === 'accepted' ? null
      : `${errors.length > 0 ? 'accept-with-residuals rejected' : 'accept-with-residuals escalated'}: ${whyParts.join('; ')}`
    const record = {
      where,
      outcome,
      findings_total: Array.isArray(findings) ? findings.length : 0,
      residuals: check.residuals,
      refuted: check.refuted,
      unverified: check.unverified,
      errors,
    }
    io.log({ at: io.now(), accept_decision: record })
    emit({ kind: 'accept-decision', ...record })
    return { ok: outcome === 'accepted', why, record }
  }

  const acceptQuestion = (question) => {
    const lines = acceptContractLines(S.acceptFindings)
    return lines.length > 0 ? `${question}\n\n${lines.join('\n')}` : question
  }

  // Fired at most once per run: the plan viewer is a singleton. Today plan
  // acceptance happens exactly once, so this is defensive — a future re-entry
  // into acceptance must never mount a second pane.
  let docShown = false

  // ---- 1. PLAN ----------------------------------------------------------------
  let planEnv = null
  let planBrief = ctx.briefFile
  let extraPlanRounds = 0
  for (let round = 1; round <= limits.plan_rounds + extraPlanRounds; round += 1) {
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
      if (c.decision === 'escalate') return escalate('plan', c.reason, env.artifacts || [])
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
      if (!carve.verdict) return escalate('plan-carve', carve.why, env.artifacts || [],
        { carve: { verdict: null, slices: [], defect: null } })
      if (carve.verdict === 'carve') return escalate('plan-carve',
        `the planner returned carve_verdict=carve on plan round ${round} — the plan is too large to build whole; the slices below are the human's starting point${carve.defect ? ` (slice list defect: ${carve.defect})` : ''}`,
        env.artifacts || [], { carve: { verdict: 'carve', slices: carve.slices, defect: carve.defect } })
    }

    // ---- 1b. CHECK (only when a tech-lead is seated) ---------------------------
    if (!ctx.roles.includes('tech-lead')) break
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
    if (v === 'pass') break
    if (round >= limits.plan_rounds + extraPlanRounds) {
      const options = canGrant() ? ['bounce', 'accept', 'escalate'] : ['accept', 'escalate']
      const c = consultLead(
        `The plan check still says revise after ${round} round(s). Grant one more plan round, accept the latest plan anyway, or escalate?`,
        options, [planPath, check.details?.check_path || art('plan-check.md')],
      )
      if (c.decision === 'escalate') return escalate('plan-check', c.reason)
      if (c.decision === 'bounce') {
        grant('plan-check', round)
        extraPlanRounds += 1
        const b = art(`plan-bounce-r${round}.md`)
        failureUpgrade('plan', 'planner')
        io.writeFile(b, [
          `# Plan revision (round ${round})`, '',
          `Revise plan.md per the check at ${check.details?.check_path || art('plan-check.md')}. Close every must-fix. Original brief: ${ctx.briefFile}`,
          '',
          ...growthLines(S.growth.at(-1)),
        ].join('\n'))
        planBrief = b
        planEnv = null
        continue
      }
      break // accept: proceed on the latest plan
    }
    const b = art(`plan-bounce-r${round}.md`)
    failureUpgrade('plan', 'planner')
    io.writeFile(b, [
      `# Plan revision (round ${round})`, '',
      `Revise plan.md per the check at ${check.details?.check_path || art('plan-check.md')}. Close every must-fix. Original brief: ${ctx.briefFile}`,
      '',
      ...growthLines(S.growth.at(-1)),
    ].join('\n'))
    planBrief = b
    planEnv = null
  }
  if (!planEnv) return escalate('plan', `no accepted plan within ${limits.plan_rounds + extraPlanRounds} rounds`)

  const planPath = planEnv.details?.plan_path || art('plan.md')
  // Put the plan of record on screen, once (io.showDoc is OPTIONAL — an io
  // without it behaves exactly as before, stage sequence included). cmux's
  // markdown viewer live-watches the file and the plan path is stable for the
  // whole task, so ONE mount covers every later revision: there is deliberately
  // no close-and-remount cycle here.
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
  const inScope = scopeMatcher(scopeFiles)
  const lane = planEnv.details?.validation_lane || ctx.lane
  if (!lane) return escalate('plan', 'no validation lane (neither planner envelope nor --lane provided)')

  // #250: what the diff touches decides who reviews it. Protected scope demands
  // the judge tier's reviewer cell; anything less stops the run here rather than
  // reviewing under an under-graded seat.
  const floorHits = protectedHits(scopeFiles)
  if (floorHits.length > 0) {
    const floor = sensitivityFloor(floorHits)
    if (floor.outcome !== 'applied') {
      return escalate('sensitivity-floor',
        `the plan's files_in_scope touches protected paths (${floorHits.join(', ')}) and the sensitivity floor could not seat the judge tier's reviewer cell (${floor.outcome}${floor.why ? `: ${floor.why}` : ''}) — a protected change is never reviewed under an under-graded reviewer`,
        planEnv.artifacts || [])
    }
  }

  // ---- 1c. ACCEPTANCE GATE, gate-first (fusion-harness pattern) ---------------
  // The planner may author an executable acceptance gate in the TASK DIR
  // (outside the repo — immutable to the builder by construction): a command
  // that exits 0 iff what-was-asked is what-got-built. Two rules, enforced
  // mechanically: the gate is written BEFORE any build, and the BASELINE run
  // must fail RED — a green baseline means the gate is vacuous or the work
  // already exists, and either way the planner hears about it loudly (the
  // exact defect class the v2 plan review caught by hand, mechanized).
  let gateCmd = planEnv.details?.gate_cmd || null
  let gateRepairs = 0
  let gateReverified = null // set only when a MID-RUN repair is accepted:
                            // true = proven red on the pristine tree,
                            // false = io has no runClean, the proof could not run
  const gateHistory = [] // every replaced gate_cmd, for the human's audit trail
  // #168 / ADR-030 §3: the driver MEASURES whether the gate discriminates —
  // whether its verdict differs between the built tree and the pristine one.
  // Identity is DRIVER-OWNED and is not the command string: the repair brief
  // expressly permits returning an identical command, and editing gate.mjs in
  // place leaves `node …/gate.mjs` byte-identical (:583-588).
  let gateGeneration = 1
  let gateProvenGeneration = null // the generation whose proof is already recorded
  let gateDiscrimination = null   // 'proven' | 'failed' | 'unproven'
  let gateProofNote = null        // operator-facing detail, set only on a contained throw
  let gateProofOutput = null

  // The proof, recorded ONCE per generation at that generation's first pristine
  // run — the repair re-proof when there is one, otherwise the gate's first
  // green. It is never rerun per build round: the property cannot change unless
  // the generation does. Returns the pristine result when one was obtained, so
  // the repair path can keep its own (unchanged) escalate-on-green behavior.
  //
  // This is evidence ABOUT the gate and may NEVER become a new way to lose a
  // build (ADR-030, ratification amendment). io.runClean is optional, and
  // realIo.runClean THROWS on a failed stash push/pop (crew/realio.mjs:261,266);
  // both cases record 'unproven' and the run continues untouched. The throw's
  // message — which names the builder's work sitting in the stash — is kept on
  // details.gate and journalled, never swallowed.
  const recordGateProof = (label) => {
    gateProvenGeneration = gateGeneration
    const settleProof = (summary) => {
      io.log({ at: io.now(), gate_discrimination: gateDiscrimination, gate_generation: gateGeneration, gate_summary: summary, gate_proof_note: gateProofNote })
      emit({ kind: 'discrimination', generation: gateGeneration, verdict: gateDiscrimination, summary, note: gateProofNote })
    }
    if (typeof io.runClean !== 'function') {
      gateDiscrimination = 'unproven'
      settleProof(null)
      return null
    }
    let pristine
    try {
      stage(label)
      pristine = runGate(label, gateCmd, io.runClean, true)
    } catch (err) {
      gateDiscrimination = 'unproven'
      gateProofNote = err.message
      io.log({ at: io.now(), gate_proof_unproven: err.message, gate_generation: gateGeneration })
      settleProof(null)
      return null
    }
    // The FULL predicate (:76-82), not bare non-zero exit: a crash, a missing
    // summary, or an errored check is not discrimination. A green pristine run
    // is 'failed' whatever it printed.
    gateProofOutput = pristine.output
    const defect = pristine.ok
      ? "the gate is STILL green at baseline (pristine tree, the builder's changes set aside), so its verdict does not depend on the work"
      : baselineGateDefect(pristine.output)
    gateDiscrimination = defect ? 'failed' : 'proven'
    gateProofNote = defect // null when proven; the throw path sets it above
    settleProof(parseGateSummary(pristine.output))
    return pristine
  }

  // Accept a planner-returned replacement gate: a NEW generation (identity is
  // the driver's, not the command string) that must prove itself on the
  // pristine tree before it is trusted against the already-built tree.
  const acceptRepairedGate = (cmd, label) => {
    gateHistory.push(gateCmd)
    gateCmd = cmd
    gateGeneration += 1
    recordGateProof(label)
    gateReverified = gateDiscrimination === 'proven'
  }

  // ADR-030 §3: a failed proof is a GATE defect. The planner repairs it once,
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
    while (gateDiscrimination === 'failed') {
      if (gateRepairs >= limits.gate_repairs) {
        return { escalation: gateEscalate(`the acceptance gate did not prove it discriminates and the single gate repair is spent — ${gateProofNote}. Gate: ${gateCmd}`) }
      }
      gateRepairs += 1
      stage(`gate-repair:${gateRepairs}`)
      const b = art('gate-discrimination-bounce.md')
      io.writeFile(b, [
        '# Gate repair: your gate does not DISCRIMINATE (one repair allowed per task)',
        '',
        'The build is GREEN against your acceptance gate — but the driver ran the SAME',
        "gate on the PRISTINE (pre-build) tree, with the builder's changes stashed away,",
        `and the result is not proof that the gate measures the work: ${gateProofNote}.`,
        '',
        'A gate whose verdict does not depend on the work cannot accept it.',
        '',
        'Pristine run (verbatim, last 2000 chars):',
        gateProofOutput.slice(-2000),
        '',
        'Preserve your old gate under a .r1 suffix, then fix it so it checks exactly what',
        'the brief asked — you may NOT weaken or delete a legitimate check, and it must',
        'print a final GATE-SUMMARY {"total":<n>,"failed":<n>,"errored":0} line.',
        'Return the (possibly identical) gate_cmd in details.',
        '',
        `Gate: ${gateCmd}`,
        `Plan: ${planPath}`,
        `Brief: ${ctx.briefFile}`,
      ].join('\n'))
      const rep = assignAndWait('planner', b, 'gate-repair')
      if (!(rep.status === 'done' && rep.details?.gate_cmd)) {
        return { escalation: gateEscalate(`the gate could not be repaired after a failed discrimination proof (planner returned ${rep.status}: ${rep.summary || 'no detail'}) — ${gateProofNote}. Gate: ${gateCmd}`) }
      }
      acceptRepairedGate(rep.details.gate_cmd, `gate-reverify:${gateRepairs}`)
      repaired = true
    }
    return { repaired }
  }

  if (gateCmd) {
    stage('gate-baseline')
    const baseline = runGate('gate-baseline', gateCmd)
    if (baseline.ok) {
      stage('gate-baseline:green-bounce')
      const b = art('gate-vacuous-bounce.md')
      io.writeFile(b, `# Gate bounce: baseline ran GREEN\n\nYour acceptance gate passed BEFORE any work was built. Either the gate does not actually check the requested change, or the work already exists. Fix the gate (or report the work as already done via status insufficient):\n\n    ${gateCmd}\n\nOutput:\n${baseline.output.slice(-2000)}\n\nOriginal brief: ${ctx.briefFile}`)
      const env2 = assignAndWait('planner', b, 'gate-fix')
      if (env2.status !== 'done' || !env2.details?.gate_cmd) {
        return gateEscalate(`baseline-green gate could not be repaired (planner returned ${env2.status}: ${env2.summary || 'no detail'})`)
      }
      gateHistory.push(gateCmd)
      gateCmd = env2.details.gate_cmd
      const re = runGate('gate-baseline:recheck', gateCmd)
      if (re.ok) return gateEscalate('repaired gate STILL green at baseline — vacuous acceptance cannot be built against')
    } else {
      // Red — but red HOW? (#153) Non-zero exit is also what a gate whose
      // every check throws produces, and at baseline everything is red, so a
      // broken check is invisible until the implementation makes it
      // reachable — nine stages later, with the one gate repair already spent.
      // This bounce is pre-build hygiene and deliberately does NOT consume
      // gateRepairs, exactly like the vacuous-green bounce above.
      let defect = baselineGateDefect(baseline.output)
      if (defect) {
        stage('gate-baseline:defect-bounce')
        const b = art('gate-defect-bounce.md')
        io.writeFile(b, `# Gate bounce: the gate did not RUN\n\nYour gate exited non-zero, but that is not proof it is red for the right reason: ${defect}.\n\nA baseline is only acceptable when every check RAN and failed. Repair the gate so it executes end to end, and print a final summary line the driver can read:\n\n    ${GATE_SUMMARY_PREFIX} {"total":<n>,"failed":<n>,"errored":0}\n\nDo not weaken or remove a check to make this pass — a check that cannot run must be FIXED, not deleted. Preserve the old gate under a suffixed copy.\n\nGate: ${gateCmd}\n\nOutput:\n${baseline.output.slice(-2000)}\n\nOriginal brief: ${ctx.briefFile}`)
        const env3 = assignAndWait('planner', b, 'gate-fix')
        if (env3.status !== 'done' || !env3.details?.gate_cmd) {
          return gateEscalate(`defective gate could not be repaired (planner returned ${env3.status}: ${env3.summary || 'no detail'})`)
        }
        gateHistory.push(gateCmd)
        gateCmd = env3.details.gate_cmd
        const re = runGate('gate-baseline:recheck', gateCmd)
        if (re.ok) return gateEscalate('repaired gate is GREEN at baseline — vacuous acceptance cannot be built against')
        defect = baselineGateDefect(re.output)
        if (defect) return gateEscalate(`repaired gate STILL does not run at baseline: ${defect}`)
      }
    }
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
      return aEnv
    }
    if (!bEnv || bEnv.status !== 'done' || !verdictOf(bEnv)) {
      panelDegraded(panel.partner)
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
      return aEnv
    }
    if (!adjEnv || adjEnv.status !== 'done') {
      panelDegraded(panel.adjudicator)
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
    return review
  }
  const reviewBounceBrief = (round, reviewPath) => {
    const panelNote = panelBounceFindings
      ? `\n\nPanel fused findings (close every one):\n${panelBounceFindings}` : ''
    return `# Review bounce (round ${round})\n\nClose every must-fix in the review at ${reviewPath}. Plan: ${planPath}${panelNote}`
  }
  const seatList = Array.isArray(ctx.seatedRoles) ? ctx.seatedRoles : ctx.roles
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
      if (c.decision === 'escalate') return escalate('build', c.reason, env.artifacts || [])
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
      continue
    }
    builderEnv = env

    // Gate A (mechanical): scope by git, never by self-report.
    stage(`scope-gate:r${round}`)
    const changed = io.changedFiles()
    const outOfScope = changed.filter((f) => !inScope(f))
    if (outOfScope.length > 0) {
      if (finalRound()) return escalate('scope', `out-of-scope edits persisted: ${outOfScope.join(', ')}`)
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('scope', 'builder')
      io.writeFile(b, `# Scope bounce (round ${round})\n\nThese files are OUTSIDE the plan's scope — revert them or stop touching them:\n${outOfScope.map((f) => `- ${f}`).join('\n')}\n\nIn-scope set:\n${scopeFiles.map((f) => `- ${f}`).join('\n')}\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'scope-fix'
      continue
    }

    // Gate B (mechanical): the validation lane, run by code.
    stage(`lane:r${round}`)
    const laneRes = io.run(lane)
    if (!laneRes.ok) {
      if (finalRound()) {
        const c = consultLead(
          `The validation lane is still red after ${round} rounds. Bounce once more with guidance, or escalate?`,
          ['bounce', 'escalate'], [planPath, journal],
        )
        if (c.decision !== 'bounce') return escalate('lane', c.reason)
        extraRounds += 1
      }
      const b = art(`build-bounce-r${round}.md`)
      failureUpgrade('lane', 'builder')
      io.writeFile(b, `# Lane bounce (round ${round})\n\nThe validation lane is RED. Make it green:\n\n    ${lane}\n\nFailures:\n${laneRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'lane-fix'
      continue
    }

    // Gate B2 (mechanical): the acceptance gate, when the plan authored one.
    // Failures feed back VERBATIM; repeated failures trigger ONE build-vs-gate
    // defect triage by the reviewer (closed enum); a gate defect lets the
    // planner repair its own gate ONCE (old gate preserved in gateHistory),
    // and the repaired gate re-runs immediately WITHOUT consuming a builder
    // round. The repair contract forbids weakening any legitimate check. When
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
          gateRepairs += 1
          stage(`gate-repair:${gateRepairs}`)
          const rBrief = art('gate-repair-bounce.md')
          io.writeFile(rBrief, `# Gate repair (one allowed per task)\n\nThe reviewer diagnosed a GATE DEFECT: ${triage.details?.reason || ''}\n\nPreserve your old gate under a .r1 suffix, then fix the gate so it checks exactly what the brief asked — you may NOT weaken any legitimate check. Return the (possibly identical) gate_cmd in details.\n\nGate: ${gateCmd}\nPlan: ${planPath}\nBrief: ${ctx.briefFile}`)
          const rep = assignAndWait('planner', rBrief, 'gate-repair')
          if (rep.status === 'done' && rep.details?.gate_cmd) {
            acceptRepairedGate(rep.details.gate_cmd, `gate-reverify:${gateRepairs}`)
            // The re-proof no longer trusts bare `pristine.ok`: a repaired gate
            // that crashes or prints no summary on the pristine tree is not red
            // for the right reason either (#153, ADR-030 §3). The budget is
            // already spent here, so a failed re-proof escalates — with the
            // diagnosis that actually applies.
            const settled = settleFailedProof()
            if (settled.escalation) return settled.escalation
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
        if (settled.escalation) return settled.escalation
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
            if (settled) return settled
            return gateEscalate(c.reason)
          }
          extraRounds += 1
        }
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('gate', 'builder')
        io.writeFile(b, `# Gate bounce (round ${round})\n\nThe ACCEPTANCE GATE is red — the build does not yet do what was asked. The gate is immutable to you; make the build satisfy it:\n\n    ${gateCmd}\n\nFailures (verbatim):\n${gateRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
        buildBrief = b; buildNote = 'gate-fix'
        continue
      }
      lastGateOutput = gateRes.output
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
          if (settled) return settled
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
          continue build
        }
        const settledAccept = settleAccept(c, 'review-exhausted')
        if (!settledAccept.ok) {
          const settled = convergeSettle({ why: settledAccept.why, where: 'review', gateOutput: lastGateOutput, gateRed: false })
          if (settled) return settled
          return escalate('review', settledAccept.why, [], { accept_decision: settledAccept.record })
        }
        accepted = 'lead accepted with residuals (review rounds exhausted)'
        break build
      }
      stage(`review:r${reviews + 1}`)
      const revBrief = art(`review-brief-${reviews + 1}.md`)
      panelBriefText = [
        `# Review (round ${reviews + 1})`, '',
        `Plan of record: ${planPath}. Changes are uncommitted in ${ctx.checkout} — read the diff with git.`,
        `Re-run the validation lane yourself: ${lane}`,
        `Write review.md in the task dir. details.verdict must be pass or changes-needed.`,
      ].join('\n')
      io.writeFile(revBrief, panelBriefText)
      const review = panel ? panelReview(reviews + 1, panel) : assignAndWait('reviewer', revBrief, 'review')
      reviews += 1
      lastReviewPath = review.details?.review_path || art('review.md')
      const v = verdictOf(review)
      if (v === 'pass') { stage('review:pass'); accepted = 'review pass'; break build }
      if (v === 'revise') {
        if (finalRound()) {
          const options = canGrant() ? ['bounce', 'accept', 'escalate'] : ['accept', 'escalate']
          const c = consultLead(
            acceptQuestion(`Build rounds are exhausted but the review says changes-needed. Grant one more review/build round, accept with residuals, or escalate?`),
            options, [planPath, lastReviewPath],
          )
          if (c.decision === 'escalate') {
            const settled = convergeSettle({ why: c.reason, where: 'review', gateOutput: lastGateOutput, gateRed: false })
            if (settled) return settled
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
            continue build
          }
          const settledAccept = settleAccept(c, 'build-exhausted')
          if (!settledAccept.ok) {
            const settled = convergeSettle({ why: settledAccept.why, where: 'review', gateOutput: lastGateOutput, gateRed: false })
            if (settled) return settled
            return escalate('review', settledAccept.why, [], { accept_decision: settledAccept.record })
          }
          accepted = 'lead accepted with residuals (build rounds exhausted)'
          break build
        }
        const b = art(`build-bounce-r${round}.md`)
        failureUpgrade('review', 'builder')
        io.writeFile(b, reviewBounceBrief(round, review.details?.review_path || art('review.md')))
        buildBrief = b; buildNote = 'review-fix'
        continue build
      }
      const c = consultLead(
        `The reviewer returned an unreadable verdict (status=${review.status}, verdict=${review.details?.verdict}). Bounce the reviewer, or escalate?`,
        ['bounce', 'escalate'], [revBrief, ...(review.artifacts || [])],
        { exclude: 'reviewer' },
      )
      if (c.decision === 'escalate') return escalate('review', c.reason)
      reviews -= 1 // the re-ask replaces the unreadable round; loop re-asks in place
    }
  }
  if (!builderEnv || !accepted) {
    return escalate('build', `no accepted build within ${limits.build_rounds + extraRounds} rounds`)
  }

  // ---- 3. FINISH: full suite (code) + commit-on-green (code) --------------------
  stage('suite')
  const suiteRes = io.run(ctx.suite)
  if (!suiteRes.ok) {
    return escalate('suite', `full suite red after acceptance — this needs eyes:\n${suiteRes.output.slice(-2000)}`)
  }
  stage('commit')
  const message = composeCommitMessage({ task: ctx.task, planEnv, builderEnv })
  const hasCommitSubject = String(planEnv.details?.commit_subject || '').split('\n').some((line) => line.trim())
  if (!hasCommitSubject) io.log({ at: io.now(), commit_subject: 'fallback-from-plan-summary' })
  const committing = io.changedFiles().filter(inScope)
  S.commit = io.commit(committing, message)
  stage('done')

  return {
    status: 'done',
    summary: `Task ${ctx.task} complete: committed ${S.commit} (${committing.length} files), suite green, ${accepted}. Stages: ${S.stages.join(' | ')}`,
    artifacts: [planPath, art('review.md'), journal],
    details: {
      commit: S.commit, stages: S.stages, files_committed: committing, consults: S.consults,
      dissents: S.dissents, accepted_via: accepted, escalation: null,
      extra_rounds_granted: S.grants, growth: S.growth, modifiers: S.modifiers,
      gate: gateCmd ? { cmd: gateCmd, repairs: gateRepairs, generation: gateGeneration, discrimination: gateDiscrimination ?? 'unproven', ...(gateProofNote ? { discrimination_note: gateProofNote } : {}), ...(gateHistory.length ? { replaced: gateHistory } : {}), ...(gateReverified !== null ? { reverified: gateReverified } : {}) } : null,
    },
  }
}
