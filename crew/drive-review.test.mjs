// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync } from 'node:fs'
import {
  FALSIFICATION_HEADING, FALSIFICATION_PATH, FALSIFICATION_ABSENT, falsificationLines,
  ACCEPT_FINDINGS, ACCEPT_FINDINGS_SOFT, ACCEPT_REASKS, adversarialPlanEnv, ACCEPT_REFUSALS, B318_GATED_RUNS, B376_FILES, B376_FINDING, B376_GREEN, B376_HARDENED, B376_MUT_RED, B376_PRE_RED, B376_TEST_FILE, CENSUS_ABSENT_REASONS, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE, SCREENER_MODELS, SCREENER_REGISTER, screenerResult, CHECK_BUILT, CHECK_CLEAN, CHECK_ENVELOPES, CHECK_MUTATION, CHECK_RUNS, CLOBBER_R2, CONVERGE_GATE, CONVERGE_PLAN, CRASH_FINDINGS, CRASH_STAGES, CTX, CTX_REPAIR, CTX_TL, DECISIONS, D_ASK, D_AUTO, D_COLLISION_CTX, D_PANEL_CTX, D_PATCH_A, D_PATCH_B, ENVELOPE_REFUSAL_REASONS, FINDING_DISPOSITIONS, LIMITS, MUST_FIX_REFUTATION_FINDINGS, NAME_VERDICTS, PANEL_ADJUDICATORS, PANEL_PARTNERS, PERSPECTIVE_TARGETS, PLAN_CHECK_FINDINGS, PLAN_RESIDUAL, PLAN_SCOPE, PLAN_SCOPE_VERDICTS, RED, REFUTATION_CLAIM, REFUTATION_CONVERGE_PLAN, REFUTATION_CONVERGE_RUNS, REFUTATION_EVIDENCE_MAX, RESIDUAL_TYPES, REVIEW_FINDINGS, REVIEW_GATE_PASS, S843_ADDED, S843_D2, S843_DISPATCHED, S843_DROPPED, S843_NARROWED, S843_RUNS, SECOND_OPINION, TD, THREW, TRIAGE_FILES, TRIAGE_NOTE, VARIANTS, acceptBounceLines, acceptContractLines, acceptedRawById, assertDriverIdRefusal, b127GroupCommand, b127InvokeGate, b127Lines, b127PidAlive, b127Spy, b318Builders, b318GatedPlan, b318Options, b318ReviewGrants, b318SiteA, b318SiteB, b376ProofIo, bounceTargetOf, buildEnv, checkEnv, classCollisionIo, closeoutIo, crashRun, dAdjEnv, dAutoRows, dBuilders, dDecisionBrief, dGitApplies, dLeads, dOffers, dPanelOutcomes, dPartnerEnv, dPatchWrite, dPlanEnv, dRemintRows, dReviewEnv, dispositionIo, dispositionOf, dispositionPanelIo, dispositionPlan, divergentCollisionIo, divergentPlanScenario, driveTask, envelopeDefect, envelopeFieldsPresent, exhaustionAcceptIo, fakeIo, findingIdDefect, gateReapSweepCommand, gateReapVerdict, hardenCommand, hardenWitnessCommand, join, leadEnv, legacyReviewerExemptions, nameVerdict, observeTurnCensus, panelSeats, phaseTrace, planAcceptContractLines, planCheckAcceptIo, planEnv, planRevisionRun, planScopeVerdict, planThenReviewIo, protectedPlanEnv, protectedReseatRefusal, publicationIo, readFileSync, reconEnv, regrantVerdict, resolveValidationLane, reviewConvergeRun, reviewEnv, reviewFindings, reviewOutcome, reviewShapeDefect, rmSync, roundCursor, s843Ctx, s843Io, s843PlanEnv, s843Rows, scratchDir, shapeDefect, slotCtx, slotFactory, spawnSync, staleVerdictLines, triageEnv, turnCeilingBreached, twoRoundReviewIo, validateAcceptDecision, validateCarve, validatePlanResiduals, validateScopeEntries, validationPlan, validationProbeRun, validationRows, verdictFindingsDefect, writeFileSync,
} from './drive-fixtures.mjs'
import { CREATES_MARK, HARDENING_PRESCRIPTION_REASONS, HARDENING_PRESCRIPTION_RESOLUTION, createsFromBrief, hardeningPrescriptionConflict, hardeningTestPath, planScopeWhy, prescriptionAuthorshipEvidence, prescriptionSpanIsLaneAuthored, prescriptionSpansAreLaneAuthored, scopeSuggestions, shellArg, VACUITY_CLAIMS, vacuityFindingDefect } from './drive.mjs'
import { screenerAdjudicationRows } from './screener.mjs'
import { ROOT as REPO_ROOT } from '../test/helpers.mjs'
import { checkSkillAnchors, laneFence, partitionShifts, shiftsAreOwedHere } from '../skills/qa-test-writing/anchor-pin.mjs'

const A1_ENVELOPE_TRACE = Object.freeze(['review_only', 'scope-gate', 'envelope-accept'])
const A1_REPAIR_TRACE = Object.freeze(['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'suite'])
const B1_REPEAT_TRACE = Object.freeze(['review', 'review', 'review'])
const C1_ENVELOPE_SEAT_SCOPE = Object.freeze(['review_only', 'scope-gate'])
const C1_ENVELOPE_SCOPE_ACCEPT = Object.freeze(['scope-gate', 'envelope-accept'])
const C1_REPAIR_OPEN = Object.freeze(['repair', 'build'])

const normaliseStageHeads = (stages) => (Array.isArray(stages) ? stages : [])
  .map((label) => String(label).split(':')[0])
  .filter((head) => !['done', 'escalate'].includes(head))

const REVIEW_RUN_ID = 'run-review-783'
const REVIEW_CTX = Object.freeze({ ...CTX, variant: 'review_only', run_id: REVIEW_RUN_ID, roles: ['reviewer'], seatedRoles: ['reviewer'] })
const REVIEW_BASE_SHA = Object.freeze('a'.repeat(40))
const REVIEW_HEAD_SHA = Object.freeze('b'.repeat(40))
const REVIEW_IDENTITY = Object.freeze({ base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA })
const REVIEW_NULL_PROTO_IDENTITY = Object.freeze(Object.assign(Object.create(null), { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA }))
const REVIEW_CONTEXTFUL_CTX = Object.freeze({ ...REVIEW_CTX, review_identity: REVIEW_IDENTITY })
const REVIEW_NULL_PROTO_CTX = Object.freeze({ ...REVIEW_CTX, review_identity: REVIEW_NULL_PROTO_IDENTITY })
const REVIEW_FINDING = Object.freeze({
  id: 'finding-1', severity: 'should-fix', location: 'src/example.mjs:12',
  summary: 'the reviewed change needs a follow-up', evidence: 'the changed branch is not covered', disposition: 'ask-user',
})
const reviewDiffCommand = (base, head) => `git diff --name-only -z --end-of-options ${shellArg(`${base}...${head}`)} --`
const reviewDiffRuns = (result, base = 'base-sha', head = 'head-sha') => ({ [reviewDiffCommand(base, head)]: result })
const SCREENER_PROPOSAL = Object.freeze({
  id: 'screen-1', axis: 'correctness', model: 'screen-model', severity: 'consider', disposition: 'ask-user',
  location: 'src/example.mjs:12', summary: 'the advisory observation', source: 'screener', status: 'proposed',
})

function injectedScreenerIo({ panel = false, child = screenerResult([SCREENER_PROPOSAL]), register = SCREENER_REGISTER, models = SCREENER_MODELS, diff = { ok: true, output: 'diff --git a/src/example.mjs b/src/example.mjs\n+changed\n' }, reviewerDetails = {}, reviewer = null, files = {}, ...rest } = {}) {
  const baseReviewer = reviewEnv('pass')
  const reviewerEnvelope = reviewer || { ...baseReviewer, details: { ...baseReviewer.details, ...reviewerDetails } }
  const envelopes = panel
    ? {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewerEnvelope,
      'tech-lead:1': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true } },
    }
    : { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewerEnvelope }
  return fakeIo({
    envelopes,
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' }, ...(rest.runs || {}) },
    changed: ['a.mjs', 'a.test.mjs'],
    files: { [`${TD}/plan.md`]: '# accepted plan', ...files },
    screener: { register, models, diff, child },
    ...rest,
  })
}

function reviewEnvelope({ outcome = 'findings', findings = [REVIEW_FINDING], assignment_id = 'd1', run_id = REVIEW_RUN_ID, role = 'reviewer', details = {} } = {}) {
  return {
    assignment_id, run_id, role, status: 'done', summary: 'review complete', artifacts: [`${TD}/review.md`],
    details: { base: 'base-sha', head: 'head-sha', outcome, findings, reviewed_files: [], unreviewable_files: [], ...details },
  }
}

function reviewIdentityEnvelope(baseSha, headSha) {
  return reviewEnvelope({ details: { base: baseSha, head: headSha } })
}

function zeroTurnReviewEnvelope(assignment_id = 'd1') {
  return {
    assignment_id, run_id: REVIEW_RUN_ID, role: 'reviewer', status: 'insufficient', summary: 'the RPC seat produced no envelope', artifacts: [],
    details: { degraded: 'rpc-no-envelope', reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null },
  }
}

function strictReviewIo(envelope, { changed = [], runs = {} } = {}) {
  const io = fakeIo({ changed, runs })
  const assign = io.assign.bind(io)
  io.assign = function (spec) {
    const assigned = assign(spec)
    const id = `d${this.calls.assign.length}`
    return { ...assigned, id, returnPath: `/crew/returns/${REVIEW_RUN_ID}/${id}.json` }
  }
  io.wait = function (returnPath, timeoutS) {
    this.calls.waits.push({ returnPath, timeoutS })
    return typeof envelope === 'function' ? envelope(returnPath) : envelope
  }
  return io
}

const PANEL_RUN_ID = 'run-panel-784'
const PANEL_BASE_SHA = 'a'.repeat(40)
const PANEL_HEAD_SHA = 'b'.repeat(40)
const PANEL_IDENTITY = Object.freeze({ base_sha: PANEL_BASE_SHA, head_sha: PANEL_HEAD_SHA })

function panelEnvelope({ role, status = 'done', base = PANEL_BASE_SHA, head = PANEL_HEAD_SHA, findings = [], details = {}, summary = 'panel seat complete' } = {}) {
  return {
    assignment_id: 'placeholder', run_id: PANEL_RUN_ID, role, status, summary,
    artifacts: [`${TD}/panel-${role}.md`],
    details: { base, head, outcome: findings.length > 0 ? 'findings' : 'no-findings', findings, reviewed_files: [], unreviewable_files: [], ...details },
  }
}

function panelContext(over = {}) {
  return { ...CTX, variant: 'review_panel', run_id: PANEL_RUN_ID, roles: ['reviewer', 'tech-lead', 'lead'], seatedRoles: ['reviewer', 'tech-lead', 'lead'], review_identity: PANEL_IDENTITY, ...over }
}

function strictPanelIo({ reviewer = panelEnvelope({ role: 'reviewer' }), partner = panelEnvelope({ role: 'tech-lead' }), adjudicator = panelEnvelope({ role: 'lead', details: { adjudications: [] } }), changed = [], runs = {} } = {}) {
  const io = fakeIo({ changed, runs: { ...runs } })
  let changedCalls = 0
  const changedFiles = io.changedFiles.bind(io)
  io.changedFiles = function () { changedCalls += 1; return changedFiles() }
  io.panelChangedCalls = () => changedCalls
  const envelopes = { reviewer, 'tech-lead': partner, lead: adjudicator }
  const assign = io.assign.bind(io)
  io.assign = function (spec) {
    const assigned = assign(spec)
    const id = `panel-${this.calls.assign.length}`
    return { ...assigned, id, returnPath: `${spec.role}:panel` }
  }
  io.wait = function (returnPath, timeoutS) {
    this.calls.waits.push({ returnPath, timeoutS })
    const role = returnPath.split(':')[0]
    const env = envelopes[role]
    return typeof env === 'function' ? env(role) : { ...env, role, assignment_id: `panel-${this.calls.assign.findIndex(({ role: assignedRole }) => assignedRole === role) + 1}`, run_id: PANEL_RUN_ID }
  }
  return io
}

const PANEL_CONSENSUS_A = { id: 'panel-shared-a', severity: 'should-fix', location: 'src/a.mjs:1', summary: 'shared concern', evidence: 'reviewer evidence', disposition: 'ask-user' }
const PANEL_CONSENSUS_B = { id: 'panel-shared-b', severity: 'should-fix', location: 'src/a.mjs:1', summary: 'shared concern', evidence: 'partner evidence', disposition: 'ask-user' }
const PANEL_DIVERGENCE = { id: 'panel-only-a', severity: 'consider', location: 'src/b.mjs:2', summary: 'one-sided concern', evidence: 'one-sided evidence', disposition: 'no-op' }

const VERIFY_RUN_ID = 'run-verify-784'
const VERIFY_CTX = Object.freeze({ ...CTX, variant: 'verify_only', run_id: VERIFY_RUN_ID, roles: ['reviewer'], seatedRoles: ['reviewer'] })
const VERIFY_TARGETS = Object.freeze([{ id: 'target-1', target: 'the declared behavior' }])
const VERIFY_ASSUMPTIONS = Object.freeze([{ name: 'runtime', assumption: 'the supported runtime is available' }])
const VERIFY_ENVIRONMENT = Object.freeze([{ name: 'runtime', observed: 'node test runtime' }])

function verificationEnvelope({ assignment_id = 'd1', run_id = VERIFY_RUN_ID, role = 'reviewer', details = {} } = {}) {
  return {
    assignment_id, run_id, role, status: 'done', summary: 'verification complete', artifacts: [`${TD}/verification.md`],
    details: {
      verification_targets: [...VERIFY_TARGETS],
      environment_assumptions: [...VERIFY_ASSUMPTIONS],
      product_verdict: 'passing',
      check_matrix: [{ id: 'target-1', status: 'passed', command: 'node --test', result: 'ok', evidence: 'captured test output' }],
      environment: [...VERIFY_ENVIRONMENT],
      environmental_blockers: [],
      ...details,
    },
  }
}

function strictVerifyIo(envelope, { changed = [] } = {}) {
  const io = fakeIo({ changed })
  const assign = io.assign.bind(io)
  io.assign = function (spec) {
    const assigned = assign(spec)
    const id = `d${this.calls.assign.length}`
    return { ...assigned, id, returnPath: `/crew/returns/${VERIFY_RUN_ID}/${id}.json` }
  }
  io.wait = function (returnPath, timeoutS) {
    this.calls.waits.push({ returnPath, timeoutS })
    return typeof envelope === 'function' ? envelope(returnPath) : envelope
  }
  return io
}

test('a plan-check accept records the residual the lead named', () => {
  const io = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].where, 'plan-check')
  assert.equal(rows[0].outcome, 'accepted')
  assert.deepEqual(rows[0].residuals, [PLAN_RESIDUAL])
  assert.deepEqual(result.details.accept_decision, rows[0])
})

test('a plan-check accept naming no residual records an empty accept', () => {
  const io = planCheckAcceptIo()
  const result = driveTask(CTX_TL, io)
  const row = io.calls.logs.find((entry) => entry.accept_decision)?.accept_decision
  assert.equal(result.status, 'done')
  assert.equal(row.outcome, 'accepted')
  assert.deepEqual(row.residuals, [])
  assert.deepEqual(result.details.accept_decision.residuals, [])
})

test('an accepted decision records refusal null and reasked 0', () => {
  const io = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const result = driveTask(CTX_TL, io)
  const row = result.details.accept_decision
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(row.outcome, 'accepted')
  assert.equal(row.refusal, null)
  assert.equal(row.reasked, 0)
})

test('a correctness-unverified plan-check residual still escalates', () => {
  const io = planCheckAcceptIo({ residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(result.details.accept_decision.outcome, 'escalated')
  assert.deepEqual(result.details.accept_decision.unverified, ['plan-gap'])
  assert.equal(io.calls.commits.length, 0)
})

test('a malformed plan-check residual refuses the accept with keyed errors', () => {
  const malformed = { residuals: [
    { id: 'bad-type', type: 'not-a-residual-type', summary: 'named gap' },
    { id: 'no-summary', type: 'cosmetic' },
  ] }
  const io = planCheckAcceptIo(malformed, { leadAnswers: [malformed] })
  const result = driveTask(CTX_TL, io)
  const row = io.calls.logs.find((entry) => entry.accept_decision)?.accept_decision
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(io.calls.commits.length, 0)
  assert.ok(row.errors.some((error) => error.id === 'bad-type' && error.why === 'unknown residual type'))
  assert.ok(row.errors.some((error) => error.id === 'no-summary' && error.why === 'empty residual summary'))
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('the plan-check consult names residuals, types, and its unchanged options', () => {
  const io = planCheckAcceptIo()
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /details\.residuals/)
  for (const type of RESIDUAL_TYPES) assert.match(brief, new RegExp(type))
  const optionsBlock = brief.match(/## Your options[\s\S]*?\n\n## Context \(/)[0]
  const options = [...optionsBlock.matchAll(/^- ([^\n]+)/gm)]
    .map(([, option]) => option.replace(/\s+\(.*$/, ''))
  assert.deepEqual(options, ['bounce', 'accept', 'escalate', 'second-opinion'])
  for (const type of RESIDUAL_TYPES) assert.match(planAcceptContractLines().join('\n'), new RegExp(type))
})

test('the measured b287 refuted-only accept bounces once and a corrected answer accepts', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { outcome: rows[0].outcome, refusal: rows[0].refusal, reasked: rows[0].reasked, residuals: rows[0].residuals },
    { outcome: 'accepted', refusal: null, reasked: 1, residuals: [PLAN_RESIDUAL] },
  )
})

test('the accept re-ask brief carries the validator refusal and the contract this stage offers', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1-reask1.md`]
  assert.ok(brief)
  assert.match(brief, /refuted is not supported at a plan-check accept/)
  for (const line of planAcceptContractLines()) {
    if (line !== '') assert.ok(brief.includes(line), `missing contract line: ${line}`)
  }
})

test('a second malformed accept escalates once and carries the original refusal', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [{ id: 'no-summary', type: 'cosmetic' }] }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.match(result.details.escalation.why, /empty residual summary/)
  assert.match(result.details.escalation.why, /refuted is not supported/)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('a form refusal is typed malformed and a correctness-unverified one judgment', () => {
  const formIo = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'not a plan residual' }] },
    { leadAnswers: [{ refuted: [{ id: 'C1', evidence: 'not a plan residual' }] }] },
  )
  const form = driveTask(CTX_TL, formIo)
  const formRow = form.details.accept_decision

  const judgmentIo = planCheckAcceptIo({ residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] })
  const judgment = driveTask(CTX_TL, judgmentIo)
  const judgmentRow = judgment.details.accept_decision

  assert.equal(form.status, 'escalation')
  assert.equal(judgment.status, 'escalation')
  assert.equal(formRow.outcome, 'escalated')
  assert.equal(judgmentRow.outcome, 'escalated')
  assert.equal(formRow.refusal, 'malformed')
  assert.equal(judgmentRow.refusal, 'judgment')
  assert.ok(ACCEPT_REFUSALS.includes(formRow.refusal))
  assert.ok(ACCEPT_REFUSALS.includes(judgmentRow.refusal))
})

test('a judgement refusal is never re-asked', () => {
  const io = planCheckAcceptIo(
    { residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 0)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 1)
})

test('a malformed review-exhaustion accept is re-asked with the keyed contract', () => {
  const io = planThenReviewIo(
    { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] },
    { residuals: [{ id: 'RV-plan-1', type: 'cosmetic' }], refuted: [] },
  )
  const result = driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-2-reask1.md`]
  assert.ok(brief)
  for (const line of acceptContractLines(PLAN_CHECK_FINDINGS)) {
    if (line !== '') assert.ok(brief.includes(line), `missing contract line: ${line}`)
  }
  assert.equal(result.status, 'done')
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.equal(result.details.accept_decision.outcome, 'accepted')
})

test('a later refused review accept supersedes the plan-check decision on converge', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv({ details: CONVERGE_PLAN().details }), 'planner:2': adversarialPlanEnv({ details: CONVERGE_PLAN().details }),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'),
      'lead:1': leadEnv('accept', 'record the plan gap', { residuals: [PLAN_RESIDUAL] }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', legacyReviewerExemptions(REVIEW_FINDINGS)),
      'lead:2': leadEnv('accept', 'record the refused review claim', { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] }),
      'lead:3': leadEnv('accept', 'record the refused review claim', { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] }),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: CONVERGE_GATE },
      'gate-cmd': { ok: true, output: REVIEW_GATE_PASS },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'], gh: true,
  })
  const result = driveTask({ ...CTX_TL, limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 1 } }, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'converge')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.deepEqual(result.details.accept_decision, rows.at(-1))
  assert.equal(result.details.accept_decision.outcome, 'escalated')
})

test('reviewOutcome normalizes reviewer verdicts and count fields', () => {
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'revise', must_fix: 3, should_fix: 2, consider: 1 },
  }), { verdict: 'changes-needed', must_fix: 3, should_fix: 2, consider: 1 })
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'approve', must_fix: -1, should_fix: 1.5, consider: '0' },
  }), { verdict: 'pass', must_fix: null, should_fix: null, consider: null })
  assert.equal(reviewOutcome('planner', { status: 'done', details: { verdict: 'pass' } }), null)
  assert.equal(reviewOutcome('reviewer', { status: 'done', details: { defect: 'gate' } }), null)
})

test('reviewOutcome carries reviewer findings verbatim and stable', () => {
  const envelope = {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 1, should_fix: 1, consider: 0,
      findings: [
        { id: 'RV1-2', severity: 'should-fix', location: ' a.mjs:12 ', summary: ' second ' },
        { id: 'RV1-1', severity: 'must-fix', location: 'b.mjs:3', summary: 'first' },
      ],
    },
  }
  const first = reviewOutcome('reviewer', envelope)
  const second = reviewOutcome('reviewer', envelope)
  assert.deepEqual(first.findings, [
    { id: 'RV1-2', severity: 'should-fix', location: 'a.mjs:12', summary: 'second', disposition: null },
    { id: 'RV1-1', severity: 'must-fix', location: 'b.mjs:3', summary: 'first', disposition: null },
  ])
  assert.deepEqual(second.findings, first.findings)
  assert.deepEqual(first.findings_report, {
    total: 2,
    tally: { must_fix: 1, should_fix: 1, consider: 0 },
    rejected: [], count_mismatch: [],
  })
})

test('malformed findings are dropped and reported, never thrown', () => {
  const out = reviewOutcome('reviewer', {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 1,
      findings: [
        { id: 'ok-1', severity: 'must-fix' },
        { id: 'ok-1', severity: 'consider' },
        { severity: 'consider' },
        { id: 'bad-sev', severity: 'blocker' },
        'not-an-object',
      ],
    },
  })
  assert.deepEqual(out.findings, [{ id: 'ok-1', severity: 'must-fix', location: null, summary: null, disposition: null }])
  assert.deepEqual(out.findings_report.rejected, [
    { index: 1, why: 'duplicate id' },
    { index: 2, why: 'missing id' },
    { index: 3, why: 'severity outside the closed set' },
    { index: 4, why: 'missing id' },
  ])
  assert.deepEqual(reviewFindings({ findings: 'not-an-array' }), null)
})

test('an envelope without findings yields exactly today\'s outcome object', () => {
  const expected = { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 }
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 },
  }), expected)
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0, findings: 'nonsense' },
  }), expected)
})

test('counts that disagree with findings are recorded, not corrected', () => {
  const out = reviewOutcome('reviewer', {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 3, should_fix: 2, consider: 0,
      findings: [{ id: 'f1', severity: 'must-fix' }],
    },
  })
  assert.equal(out.must_fix, 3)
  assert.equal(out.should_fix, 2)
  assert.equal(out.consider, 0)
  assert.deepEqual(out.findings_report.count_mismatch, ['must_fix', 'should_fix'])
})

test('a drive with findings produces the same result as one without', () => {
  const reviewer = (findings) => {
    const base = reviewEnv('pass')
    return {
      ...base,
      details: {
        ...base.details, must_fix: 0, should_fix: 0, consider: 0,
        ...(findings === undefined ? {} : { findings }),
      },
    }
  }
  const run = (review) => {
    const io = fakeIo({
      envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': review },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    return { result: driveTask(CTX, io), io }
  }
  const without = run(reviewer())
  const withFindings = run(reviewer([
    { id: 'RV1-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'failure scenario', patch: '@@ not a diff the driver may read @@' },
  ]))
  assert.deepEqual(withFindings.result, without.result)
  assert.equal(withFindings.io.calls.run.filter((r) => /^git apply /.test(r.cmd)).length, 0)
  assert.equal(withFindings.io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  assert.ok(withFindings.io.calls.logs.some((line) => line.review_outcome?.findings?.some((f) => f.id === 'RV1-1')))
  const note = withFindings.io.calls.logs.find((line) => line.review_findings_note)?.review_findings_note
  assert.deepEqual(note?.count_mismatch, ['should_fix'])
})

test('validateAcceptDecision collects each typed residual error without throwing', () => {
  const cases = [
    ['residuals must be an array', { findings: [], residuals: {} }],
    ['refuted must be an array', { findings: [], refuted: {} }],
    ['missing id', { findings: [], residuals: [{}] }],
    ['invalid type', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], residuals: [{ id: 'RV1-1', type: 'other' }] }],
    ['empty refutation evidence', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], refuted: [{ id: 'RV1-1', evidence: '  ' }] }],
    ['unknown id', { findings: [], residuals: [{ id: 'RV1-9', type: 'cosmetic' }] }],
    ['duplicate id', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], residuals: [{ id: 'RV1-1', type: 'cosmetic' }], refuted: [{ id: 'RV1-1', evidence: 'not real' }] }],
    ['must-fix may not be typed cosmetic', { findings: [{ id: 'RV1-1', severity: 'must-fix' }], residuals: [{ id: 'RV1-1', type: 'cosmetic' }] }],
    ['omitted id', { findings: [{ id: 'RV1-1', severity: 'must-fix' }] }],
  ]
  for (const [why, input] of cases) {
    const result = validateAcceptDecision(input)
    assert.equal(result.ok, false, why)
    assert.ok(result.errors.some((error) => error.why === why), why)
  }
})

test('validateAcceptDecision accepts empty findings with an empty decision', () => {
  assert.deepEqual(validateAcceptDecision({ findings: [], residuals: [], refuted: [] }), {
    ok: true, residuals: [], refuted: [], unverified: [], refuted_must_fix: [],
  })
})

test('validatePlanResiduals normalizes valid entries and fails closed on malformed input', () => {
  const long = `  ${'x'.repeat(REFUTATION_EVIDENCE_MAX)}TAIL  `
  const valid = validatePlanResiduals([{ id: '  gap-1  ', type: 'cosmetic', summary: long }])
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.residuals[0].id, 'gap-1')
  assert.equal(valid.residuals[0].summary.length, REFUTATION_EVIDENCE_MAX)
  assert.equal(valid.residuals[0].summary.endsWith('…'), true)
  assert.deepEqual(valid.unverified, [])
  assert.deepEqual(valid.refuted, [])
  assert.deepEqual(valid.refuted_must_fix, [])

  const malformed = [
    ['missing id', [{ type: 'cosmetic', summary: 'named gap' }]],
    ['unknown residual type', [{ id: 'bad-type', type: 'other', summary: 'named gap' }]],
    ['empty residual summary', [{ id: 'empty-summary', type: 'cosmetic', summary: '  ' }]],
    ['duplicate id', [{ id: 'same', type: 'cosmetic', summary: 'first' }, { id: 'same', type: 'cosmetic', summary: 'second' }]],
    ['residuals must be an array', {}],
  ]
  for (const [why, residuals] of malformed) {
    const result = validatePlanResiduals(residuals)
    assert.equal(result.ok, false, why)
    assert.ok(result.errors.some((error) => error.why === why), why)
  }

  for (const refuted of [undefined, null, []]) {
    const result = validatePlanResiduals([], refuted)
    assert.equal(result.ok, true)
    assert.deepEqual(result.refuted, [])
  }
  for (const refuted of [{}, [{ id: 'RV1-1' }]]) {
    const result = validatePlanResiduals([], refuted)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.why.includes('refuted')))
  }
})

test('planAcceptContractLines names the existing residual field and vocabulary', () => {
  const text = planAcceptContractLines().join('\n')
  assert.match(text, /details\.residuals/)
  for (const type of RESIDUAL_TYPES) assert.match(text, new RegExp(type))
})

test('acceptContractLines lists findings and the typed residual/refutation instructions', () => {
  const findings = [
    { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'close this' },
    { id: 'RV1-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'consider this' },
  ]
  const lines = acceptContractLines(findings)
  const text = lines.join('\n')
  assert.ok(text.includes('- RV1-1 (must-fix) a.mjs:1 — close this'))
  assert.match(text, /residuals/)
  assert.match(text, /refuted/)
  assert.ok(lines.some((line) => /Refuting a must-fix[\s\S]*escalates to a human every time/i.test(line)))
  assert.ok(lines.some((line) => /refuted should-fix still accepts/i.test(line)))
  for (const finding of findings) assert.equal(text.split(finding.id).length - 1, 1)
  assert.deepEqual(acceptContractLines(null), [])
})

test('acceptBounceLines renders hostile entries without throwing and appends the contract', () => {
  let rendered
  assert.doesNotThrow(() => {
    acceptBounceLines(null, null)
    rendered = acceptBounceLines([{}, { id: 1 }, null], planAcceptContractLines()).join('\n')
  })
  for (const line of planAcceptContractLines()) {
    if (line !== '') assert.ok(rendered.includes(line), `missing contract line: ${line}`)
  }
  assert.match(rendered, new RegExp(`ACCEPT_REASKS = ${ACCEPT_REASKS}`))
})

test('the crew policy artifacts escalate at plan acceptance exactly like the roster', () => {
  for (const path of ['crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json', 'crew/roster.json']) {
    const refusingIo = fakeIo({
      envelopes: { 'planner:1': protectedPlanEnv([path], 'proved') },
      reseat: protectedReseatRefusal,
    })
    const refusal = driveTask(CTX, refusingIo)
    assert.equal(refusal.status, 'escalation')
    assert.equal(refusal.details.escalation.where, 'sensitivity-floor')
    assert.ok(refusal.details.escalation.why.includes(path))
    assert.equal(refusingIo.calls.assign.filter(({ role }) => role === 'builder').length, 0)

    const applyingIo = fakeIo({
      envelopes: { 'planner:1': protectedPlanEnv([path], 'proved'), 'builder:1': buildEnv({ details: { ...buildEnv().details, files_changed: [path] } }), 'reviewer:1': reviewEnv('pass') },
      runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      files: { [`${CTX.checkout}/${path}`]: 'true' },
      changed: [path],
      reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
    })
    const applied = driveTask(CTX, applyingIo)
    assert.equal(applied.status, 'done')
    assert.equal(applyingIo.calls.reseat.length, 1)
  }
})

test('a passing verify round is free while the changes-needed round is charged', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(
    io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round),
    [
      { n: 1, verdict: 'changes-needed', accounting: 'counted', charged: 1 },
      { n: 2, verdict: 'pass', accounting: 'free', charged: 1 },
    ],
  )
})

test('review exhaustion on a revise-revise sequence is unchanged', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  const want = 'Review rounds are exhausted (2) and the last verdict was revise. Grant one more review/build round, accept with residuals, or escalate?'
  assert.ok(io.calls.writes[`${TD}/decision-1.md`].includes(want))
  assert.equal(res.details.consults, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

test('an unreadable verdict is charged nothing and reuses its round number', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'unknown-shape', review_path: `${TD}/review.md` } },
      'lead:1': leadEnv('bounce'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:r1', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done'])
  assert.deepEqual(
    io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round),
    [
      { n: 1, verdict: 'unknown-shape', accounting: 'free', charged: 0 },
      { n: 1, verdict: 'pass', accounting: 'free', charged: 0 },
    ],
  )
})

test('review rounds exhausted + lead accepts -> commit proceeds with residuals', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  assert.equal(io.calls.commits.length, 1)
})

test('a findings-less later round leaves the canonical accept contract intact', () => {
  const io = twoRoundReviewIo(undefined, {})
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  assert.ok(res.details.accepted_via == null)
  const record = res.details.accept_decision
  assert.equal(record.findings_total, 2)
  for (const id of ['RV1-1', 'RV1-2']) {
    assert.ok(record.errors.some((error) => error.id === id && error.why === 'omitted id'))
  }
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /RV1-1 \(must-fix\)/)
  assert.match(brief, /For an accept, name every listed finding exactly once/)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('a findings-carrying later round replaces the canonical accept contract', () => {
  const io = twoRoundReviewIo(CLOBBER_R2, { residuals: [{ id: 'RV9-1', type: 'cosmetic' }], refuted: [] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  const record = io.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(record.findings_total, 1)
  assert.equal(record.outcome, 'accepted')
})

test('the superseded round-1 findings are not shown in the round-2 contract', () => {
  const io = twoRoundReviewIo(CLOBBER_R2, { residuals: [{ id: 'RV9-1', type: 'cosmetic' }], refuted: [] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /RV9-1 \(should-fix\)/)
  assert.doesNotMatch(brief, /RV1-1/)
  assert.doesNotMatch(brief, /RV1-2/)
})

test('an empty findings array is a report and replaces the set; an absent key is not', () => {
  const absentIo = twoRoundReviewIo(undefined, {})
  const absent = driveTask(CTX, absentIo)
  const emptyIo = twoRoundReviewIo([], { residuals: [], refuted: [] })
  const empty = driveTask(CTX, emptyIo)
  assert.equal(absent.status, 'escalation')
  assert.equal(absentIo.calls.commits.length, 0)
  assert.equal(empty.status, 'done')
  assert.equal(emptyIo.calls.commits.length, 1)
  const record = emptyIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(record.findings_total, 0)
  assert.equal(record.outcome, 'accepted')
})

test('reviewOutcome distinguishes an absent findings key from an empty array', () => {
  const withoutFindings = reviewOutcome('reviewer', reviewEnv('changes-needed'))
  assert.equal('findings' in withoutFindings, false)
  const withFindings = reviewOutcome('reviewer', reviewEnv('changes-needed', []))
  assert.deepEqual(withFindings.findings, [])
  assert.equal(withFindings.findings_report.total, 0)
})

test('the same rule holds at build exhaustion', () => {
  const io = twoRoundReviewIo(undefined, {})
  const res = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 3 } }, io)
  assert.equal(res.details.accept_decision.where, 'build-exhausted')
  assert.equal(res.details.accept_decision.findings_total, 2)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

test('valid typed accept at review exhaustion commits with a should-fix refutation', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'the reviewer mistook a test fixture for runtime code' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.match(res.details.accepted_via, /residuals/)
  assert.equal(io.calls.commits.length, 1)
})

test('the viz-intake incident replays as an escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true }, MUST_FIX_REFUTATION_FINDINGS)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.match(res.details.escalation.why, /RV2-1/)
  assert.match(res.details.escalation.why, /row\.reason is unique within a group/)
  assert.equal(io.calls.commits.length, 0)
})

test('the build-exhaustion must-fix refusal bypasses convergence', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true, runs: REFUTATION_CONVERGE_RUNS }, MUST_FIX_REFUTATION_FINDINGS, REFUTATION_CONVERGE_PLAN())
  const res = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.match(res.details.escalation.why, /RV2-1/)
  assert.match(res.details.escalation.why, /row\.reason is unique within a group/)
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('the refused decision is recorded valid, not malformed', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, {}, MUST_FIX_REFUTATION_FINDINGS)
  const res = driveTask(CTX, io)
  const record = res.details.accept_decision
  assert.deepEqual(record.errors, [])
  assert.equal(record.outcome, 'escalated')
  assert.deepEqual(record.refuted_must_fix, ['RV2-1'])
  assert.equal(record.refuted[0].evidence, REFUTATION_CLAIM)
})

test('a refuted must-fix is a judgement and is never re-asked', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: 'the must-fix is not a real defect' }],
  }, {}, MUST_FIX_REFUTATION_FINDINGS)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'refuted-must-fix')
  assert.equal(result.details.accept_decision.refusal, 'judgment')
  assert.equal(result.details.accept_decision.reasked, 0)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 0)
})

test('refutation evidence is bounded', () => {
  const findings = [{ id: 'RV2-1', severity: 'should-fix' }]
  const long = `${'x'.repeat(REFUTATION_EVIDENCE_MAX)}TAIL`
  const bounded = validateAcceptDecision({
    findings, residuals: [], refuted: [{ id: 'RV2-1', evidence: long }],
  })
  assert.equal(bounded.refuted[0].evidence.length, REFUTATION_EVIDENCE_MAX)
  assert.equal(bounded.refuted[0].evidence.endsWith('…'), true)
  const short = validateAcceptDecision({
    findings, residuals: [], refuted: [{ id: 'RV2-1', evidence: '  a short claim  ' }],
  })
  assert.equal(short.refuted[0].evidence, 'a short claim')
})

test('a refuted should-fix still accepts', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'the reviewer mistook a test fixture for runtime code' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
})

test('accepted_via states what the record contains', () => {
  const shouldFixIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const shouldFix = driveTask(CTX, shouldFixIo)
  assert.match(shouldFix.details.accepted_via, /0 residuals and 1 refutation/)

  const mixedFindings = [
    { id: 'RV2-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'first' },
    { id: 'RV2-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'second' },
  ]
  const mixedIo = exhaustionAcceptIo({
    residuals: [{ id: 'RV2-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV2-2', evidence: 'not real' }],
  }, {}, mixedFindings)
  const mixed = driveTask(CTX, mixedIo)
  assert.match(mixed.details.accepted_via, /1 residual and 1 refutation/)

  const buildIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const build = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, buildIo)
  assert.match(build.details.accepted_via, /\(build rounds exhausted\)$/)
})

test('the accept re-ask does not spend a lead consult', () => {
  const bouncingIo = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const bouncing = driveTask(CTX_TL, bouncingIo)
  const directIo = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const direct = driveTask(CTX_TL, directIo)

  assert.equal(bouncing.status, 'done')
  assert.equal(direct.status, 'done')
  assert.equal(bouncing.details.consults, 1)
  assert.equal(direct.details.consults, 1)
  assert.equal(bouncingIo.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
  assert.equal(directIo.calls.assign.filter((entry) => entry.role === 'lead').length, 1)
})

test('the converge seam does not swallow a refuted must-fix', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true, runs: REFUTATION_CONVERGE_RUNS }, MUST_FIX_REFUTATION_FINDINGS, REFUTATION_CONVERGE_PLAN())
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('must-fix typed cosmetic accept fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*must-fix may not be typed cosmetic/)
})

test('correctness-unverified residual fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'correctness-unverified' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*correctness-unverified/)
})

test('omitted finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({ refuted: [{ id: 'RV1-1', evidence: '   ' }] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-2.*omitted id/)
})

test('duplicate finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [
      { id: 'RV1-2', evidence: 'not real' },
      { id: 'RV1-1', evidence: '   ' },
    ],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-2.*duplicate id/)
})

test('unknown finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [
      { id: 'RV1-2', type: 'cosmetic' },
      { id: 'RV1-9', type: 'cosmetic' },
    ],
    refuted: [{ id: 'RV1-1', evidence: '   ' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-9.*unknown id/)
})

test('no-lead tier remains a mechanical escalation with zero lead assigns', () => {
  const mechanical = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'reviewer:2': reviewEnv('changes-needed', ACCEPT_FINDINGS),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, roles: ['planner', 'builder', 'reviewer'] }, mechanical)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.ok(mechanical.calls.assign.every((a) => a.role !== 'lead'))
  assert.equal(mechanical.calls.assign.filter((a) => a.role === 'lead').length, 0)
})

test('exhaustion accept brief lists every finding and the typed fields', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-1', evidence: 'not real' }],
  })
  driveTask(CTX, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.ok(brief)
  for (const finding of ACCEPT_FINDINGS) assert.match(brief, new RegExp(finding.id))
  assert.match(brief, /residuals/)
  assert.match(brief, /refuted/)
})

test('accept decision records accepted and refused outcomes in the journal and emit stream', () => {
  const acceptedIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, { emit: true }, ACCEPT_FINDINGS_SOFT)
  driveTask(CTX, acceptedIo)
  const acceptedLog = acceptedIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(acceptedLog.outcome, 'accepted')
  assert.ok(acceptedIo.calls.emits.some((event) => event.kind === 'accept-decision' && event.outcome === 'accepted'))

  const refusedIo = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, { emit: true })
  driveTask(CTX, refusedIo)
  const refusedLog = refusedIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(refusedLog.outcome, 'escalated')
  assert.ok(refusedLog.errors.some((error) => error.id === 'RV1-1'))
})

test('fail-closed accept escalation composes with the regrant policy shape', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'reviewer:2': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'lead:1': leadEnv('bounce'),
      'lead:2': leadEnv('accept', 'invalid typed decision', {
        residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
        refuted: [{ id: 'RV1-2', evidence: 'not real' }],
      }),
      'lead:3': leadEnv('accept', 'invalid typed decision', {
        residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
        refuted: [{ id: 'RV1-2', evidence: 'not real' }],
      }),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  const verdict = regrantVerdict(result, [{ must_fix: 2 }, { must_fix: 1 }])
  assert.equal(verdict.reasons.find((reason) => reason.condition === 'where-review').ok, true)
  assert.equal(verdict.reasons.find((reason) => reason.condition === 'grant-spent').ok, true)
})

test('A1', () => {
  const planPath = `${TD}/plan.md`
  const checkPath = `${TD}/plan-check.md`
  const planBody = 'inline plan context body: the plan remains readable.'
  const checkBody = 'inline plan-check context body: the check remains readable.'
  const io = planCheckAcceptIo({}, {
    files: { [planPath]: planBody, [checkPath]: checkBody },
  })
  const result = driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  const row = io.calls.logs.find((entry) => entry.lead_consult_context)?.lead_consult_context
  assert.equal(result.status, 'done')
  assert.ok(brief.includes(planBody))
  assert.ok(brief.includes(checkBody))
  assert.match(brief, /## Context \(delivery mode: inline\)/)
  assert.doesNotMatch(brief, /## Context files/)
  assert.equal(row.mode, 'inline')
  assert.ok(row.sources.every((source) => !Object.prototype.hasOwnProperty.call(source, 'content')))
})

test('B1', () => {
  const planPath = `${TD}/plan.md`
  const checkPath = `${TD}/plan-check.md`
  const cases = [
    {
      name: 'individual source over the ceiling',
      values: {
        [planPath]: `oversized context body\\n${'x'.repeat(52_000)}`,
        [checkPath]: 'small context body',
      },
    },
    {
      name: 'aggregate source bodies cross the ceiling',
      values: {
        [planPath]: `aggregate first body\\n${'a'.repeat(26_000)}`,
        [checkPath]: `aggregate second body\\n${'b'.repeat(26_000)}`,
      },
    },
    {
      name: 'multibyte source crosses the UTF-8 ceiling',
      values: {
        [planPath]: `multibyte context body\\n${'界'.repeat(17_000)}`,
        [checkPath]: 'small multibyte companion',
      },
    },
  ]
  for (const candidate of cases) {
    const io = planCheckAcceptIo({}, { files: candidate.values })
    const result = driveTask(CTX_TL, io)
    const brief = io.calls.writes[`${TD}/decision-1.md`]
    const row = io.calls.logs.find((entry) => entry.lead_consult_context)?.lead_consult_context
    const downgraded = row.sources.filter((source) => source.mode === 'path')
    const reason = 'rendered decision brief exceeded 51,200-byte limit'
    assert.equal(result.status, 'done', candidate.name)
    assert.ok(Buffer.byteLength(brief, 'utf8') <= 51_200, candidate.name)
    assert.ok(downgraded.length > 0, candidate.name)
    assert.ok(['mixed', 'path-fallback'].includes(row.mode), candidate.name)
    assert.ok(Object.values(candidate.values).some((body) => !brief.includes(body)), candidate.name)
    for (const source of downgraded) {
      assert.equal(source.reason, reason, candidate.name)
      assert.ok(brief.includes(`Delivery mode: path fallback (${reason})`), candidate.name)
      assert.ok(brief.includes(`Path: ${source.path}`), candidate.name)
    }
  }
})

test('C1', () => {
  const planPath = `${TD}/plan.md`
  const checkPath = `${TD}/plan-check.md`
  const malformed = { residuals: [{ id: 'bad-residual', type: 'not-a-residual-type', summary: 'malformed' }] }
  const io = planCheckAcceptIo(malformed, {
    leadAnswers: [{ residuals: [PLAN_RESIDUAL] }],
    files: { [planPath]: 'ordinary plan body', [checkPath]: 'ordinary check body' },
  })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs
    .filter((entry) => entry.lead_consult_context)
    .map((entry) => entry.lead_consult_context)
  assert.equal(result.status, 'done')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(({ brief, consult, round, mode }) => ({ brief, consult, round, mode })), [
    { brief: `${TD}/decision-1.md`, consult: 1, round: 1, mode: 'inline' },
    { brief: `${TD}/decision-1-reask1.md`, consult: 1, round: 1, mode: 'inline' },
  ])
  for (const row of rows) assert.ok(row.sources.every((source) => !Object.prototype.hasOwnProperty.call(source, 'content')))
})

test('D1', () => {
  const io = planCheckAcceptIo()
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  const optionsBlock = brief.match(/(## Your options[\s\S]*?)\n\n## Context \(/)
  const expected = [
    '## Your options (answer with exactly one in details.decision)',
    '- bounce',
    '- accept',
    '- escalate',
    '- second-opinion (set details.from to one of: reviewer, tech-lead — code will gather their independent view and re-ask you once)',
  ].join('\n')
  assert.ok(optionsBlock)
  assert.equal(optionsBlock[1], expected)
})

test('D2', () => {
  const io = planCheckAcceptIo()
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  const expected = 'Reply with a ReturnEnvelope whose details are {"decision": <option>, "reason": "...", "guidance": "...", "from": "<role>" when requesting a second opinion}.'
  assert.ok(brief.includes(expected))
})

test('D3', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous brief' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'the brief means X; plan for X', recommendation: 'bounce', confidence: 'high' } },
      'lead:2': leadEnv('bounce', 'plan for X per the reviewer perspective'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const first = io.calls.writes[`${TD}/decision-1.md`]
  const final = io.calls.writes[`${TD}/decision-1b.md`]
  const valve = '- second-opinion (set details.from to one of: reviewer — code will gather their independent view and re-ask you once)'
  assert.equal(result.status, 'done')
  assert.ok(first.includes(valve))
  assert.doesNotMatch(final, /second-opinion \(set details\.from/)
})

test('E1', () => {
  const guidance = 'the brief means X not Y; plan for X'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }),
      'lead:1': leadEnv('bounce', guidance),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.equal(result.status, 'done')
  assert.ok(decision.includes("guidance is REQUIRED when decision is bounce — it becomes the bounce brief's steer."))
  assert.ok(bounce.includes(guidance))
})

test('F1', () => {
  const checkPath = `${TD}/plan-check.md`
  const cases = [
    { name: 'thrown read', throw: true, reason: 'read failed: context permission denied' },
    { name: 'null source', value: null, reason: 'source is absent' },
    { name: 'non-string source', value: 42, reason: 'source is not text (number)' },
    { name: 'empty source', value: '', reason: 'source is empty' },
  ]
  for (const candidate of cases) {
    const io = planCheckAcceptIo({}, { files: {} })
    const originalRead = io.readFile
    io.readFile = (path) => {
      if (path === checkPath) {
        if (candidate.throw) throw new Error('context permission denied')
        return candidate.value
      }
      return originalRead(path)
    }
    const result = driveTask(CTX_TL, io)
    const brief = io.calls.writes[`${TD}/decision-1.md`]
    const row = io.calls.logs.find((entry) => entry.lead_consult_context)?.lead_consult_context
    const source = row.sources.find((entry) => entry.path === checkPath)
    assert.equal(result.status, 'done', candidate.name)
    assert.equal(row.mode, 'path-fallback', candidate.name)
    assert.deepEqual({ mode: source.mode, state: source.state, bytes: source.bytes, reason: source.reason }, {
      mode: 'path', state: 'absent', bytes: null, reason: candidate.reason,
    }, candidate.name)
    assert.ok(brief.includes(`Path: ${checkPath}`), candidate.name)
    assert.ok(brief.includes(`Delivery mode: path fallback (${candidate.reason})`), candidate.name)
    assert.doesNotMatch(brief, /substituted inline content/, candidate.name)
    assert.ok(io.calls.assign.some((entry) => entry.role === 'lead'), candidate.name)
  }
})

test('second-opinion valve: lead requests reviewer perspective, code gathers it unseeded, lead decides on re-ask', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous brief' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'the brief means X; plan for X', recommendation: 'bounce', confidence: 'high' } },
      'lead:2': leadEnv('bounce', 'plan for X per the reviewer perspective'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1) // the compounded exchange is ONE consult
  // the perspective brief went to the reviewer and does NOT leak the lead's leaning
  const pBrief = Object.entries(io.calls.writes).find(([k]) => /perspective-1\.md/.test(k))[1]
  assert.match(pBrief, /advising a decision/)
  // Unseeded means the lead's LEANING is structurally absent (it never
  // exists in any artifact); the decision vocabulary IS shared so the
  // recommendation comes back machine-comparable.
  assert.match(pBrief, /own view is deliberately not shared/)
  assert.match(pBrief, /recommendation/)
  // the second decision brief carries the perspective, and no valve
  const b2 = Object.entries(io.calls.writes).find(([k]) => /decision-1b\.md/.test(k))[1]
  assert.match(b2, /Independent perspective from reviewer/)
  assert.match(b2, /plan for X/)
  assert.doesNotMatch(b2, /second-opinion \(set details\.from/)
})

test('a second second-opinion answer escalates — one hop is the bound', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'unclear', confidence: 'low' } },
      'lead:2': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'planner' } },
    },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /one hop is the bound/)
})

test('second-opinion naming an unseated member escalates', () => {
  const ctx = { ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'] } // no tech-lead seated
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'tech-lead' } },
    },
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /not a seated judgment member/)
})

test('compounding policy: lead accept over advisor escalate -> binding escalation naming the dissent', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:3': { status: 'done', role: 'reviewer', details: { perspective: 'these residuals are load-bearing', recommendation: 'escalate', confidence: 'high' } },
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /independently recommended escalate/)
  assert.equal(res.details.dissents.length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('compounding policy: lead bounce over advisor escalate -> lead prevails (safe direction), dissent recorded, task completes', () => {
  // planner-insufficient consult: options are bounce|escalate. Advisor says
  // escalate, lead says bounce — the split is recorded but a SAFE-direction
  // lead decision is never overridden.
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'seems unresolvable to me', recommendation: 'escalate', confidence: 'low' } },
      'lead:2': leadEnv('bounce', 'the brief means X; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents[0], { from: 'reviewer', recommendation: 'escalate', lead_decision: 'bounce', consult: 1 })
  assert.equal(io.calls.commits.length, 1)
})

test('compounding policy: a now-on-menu advisor recommendation records dissent without binding', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:3': { status: 'done', role: 'reviewer', details: { perspective: 'one more round would do it', recommendation: 'bounce', confidence: 'medium' } },
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents[0], { from: 'reviewer', recommendation: 'bounce-builder', lead_decision: 'accept', consult: 1 })
  assert.equal(io.calls.commits.length, 1)
})

test('compounding policy: agreement leaves no dissent recorded', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'bounce with X', recommendation: 'bounce', confidence: 'high' } },
      'lead:2': leadEnv('bounce', 'do X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents, [])
})

test('a gate reap kills the process GROUP, and a leaked descendant is proven dead', { timeout: 20_000 }, () => {
  const run = b127InvokeGate({ cmd: ['nohup sleep 25 >/dev/null 2>&1 &', 'echo "leaked $!"', 'exit 0'].join('\n') })
  const pid = /leaked (\d+)/.exec(run.stdout)?.[1]
  try {
    assert.ok(pid, `expected the fixture to report its leaked descendant pid, found ${JSON.stringify(run.stdout)}`)
    assert.equal(run.status, 0)
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    const deadline = Date.now() + 10_000
    while (b127PidAlive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.05'])
    assert.equal(b127PidAlive(pid), false, `leaked descendant ${pid} remained alive after the group reap`)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    rmSync(run.dir, { recursive: true, force: true })
  }
})

test('a normal gate reap is idempotent when its report is already proven', () => {
  const run = b127InvokeGate({ cmd: ['nohup sleep 25 >/dev/null 2>&1 &', 'echo "leaked $!"', 'exit 0'].join('\n') })
  const pid = /leaked (\d+)/.exec(run.stdout)?.[1]
  try {
    assert.ok(pid)
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    const before = readFileSync(run.paths.report, 'utf8')
    const sweep = spawnSync('/bin/sh', ['-c', gateReapSweepCommand(run.paths)], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(sweep.status, 0)
    const after = readFileSync(run.paths.report, 'utf8')
    assert.equal(after, before)
    assert.deepEqual(gateReapVerdict(after), run.verdict)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    rmSync(run.dir, { recursive: true, force: true })
  }
})

test('a gate that exits cleanly is never signalled', () => {
  const dir = scratchDir('b127-gate-clean-')
  const sleepLog = join(dir, 'sleep.log')
  try {
    const run = b127InvokeGate({ dir, cmd: 'echo clean\nexit 0', overrides: {
      sleepCmd: b127Spy(dir, 'sleep-spy', `#!/bin/sh\necho x >> '${sleepLog}'\nexit 0\n`),
    } })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, 'clean\n')
    assert.equal(run.stderr, '')
    assert.equal(run.verdict.outcome, 'already-dead')
    assert.equal(run.verdict.signals, 0)
    assert.equal(b127Lines(sleepLog), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused KILL after a delivered TERM is unproven, never failed', () => {
  const dir = scratchDir('b127-gate-mixed-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const run = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-spy', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nprintf '%s 4242 S\\n' "$p"\n`),
      sleepCmd: b127Spy(dir, 'sleep-spy', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(dir, 'kill-spy', '#!/bin/sh\ncase "$1" in -TERM) exit 0 ;; *) exit 1 ;; esac\n'),
    } })
    assert.equal(run.verdict.outcome, 'unproven')
    assert.equal(run.verdict.signals, 1)
    assert.notEqual(run.verdict.outcome, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused first signal is unproven with zero signals, while a dead-after-refusal group is proven', () => {
  const dir = scratchDir('b127-gate-refused-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const alive = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-alive', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nprintf '%s 4242 S\\n' "$p"\n`),
      sleepCmd: b127Spy(dir, 'sleep-alive', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(dir, 'kill-refused', '#!/bin/sh\nexit 1\n'),
    } })
    assert.equal(alive.verdict.outcome, 'unproven')
    assert.equal(alive.verdict.signals, 0)
    assert.notEqual(alive.verdict.outcome, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const deadDir = scratchDir('b127-gate-dead-')
  try {
    const pgidCopy = join(deadDir, 'pgid.copy')
    const deadFlag = join(deadDir, 'dead.flag')
    const dead = b127InvokeGate({ dir: deadDir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(deadDir, 'ps-dead', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nif [ -f '${deadFlag}' ]; then printf '1 1 S\\n'; else printf '%s 4242 S\\n' "$p"; fi\n`),
      sleepCmd: b127Spy(deadDir, 'sleep-dead', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(deadDir, 'kill-dead', `#!/bin/sh\n: > '${deadFlag}'\nexit 1\n`),
    } })
    assert.equal(dead.verdict.outcome, 'proven')
    assert.equal(dead.verdict.signals, 0)
  } finally {
    rmSync(deadDir, { recursive: true, force: true })
  }
})

test('a gate reap observes a group dying during the fourth settle round', () => {
  const dir = scratchDir('b127-gate-boundary-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const sleepLog = join(dir, 'sleep.log')
    const deadFlag = join(dir, 'dead.flag')
    const run = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-spy', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nif [ -f '${deadFlag}' ]; then printf '1 1 S\\n'; else printf '%s 4242 S\\n' "$p"; fi\n`),
      sleepCmd: b127Spy(dir, 'sleep-spy', `#!/bin/sh\necho x >> '${sleepLog}'\nn=$(wc -l < '${sleepLog}' | tr -d ' ')\nif [ "$n" -ge 4 ]; then : > '${deadFlag}'; fi\nexit 0\n`),
      killCmd: b127Spy(dir, 'kill-spy', '#!/bin/sh\nexit 0\n'),
    } })
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    assert.equal(b127Lines(sleepLog), 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate invocations emit distinct verdicts and ordinary red-then-green raises no attention', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) },
      'gate-cmd:2': { ok: false, output: 'still red' },
      'gate-cmd:3': { ok: true, output: 'green' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  const gates = io.calls.emits.filter((event) => event.kind === 'gate')
  assert.equal(res.status, 'done')
  assert.deepEqual(gates.map(({ name }) => name), ['gate-baseline', 'gate:r1', 'gate:r2'])
  assert.deepEqual(gates.map(({ attempt }) => attempt), [1, 2, 3])
  assert.deepEqual(gates.map(({ ok }) => ok), [false, false, true])
  assert.ok(gates.every(({ cmd }) => cmd === 'gate-cmd'))
  assert.equal(io.calls.emits.filter((event) => event.kind === 'attention').length, 0)
})

test('#153: a baseline whose checks THREW bounces the lead and does NOT spend the gate repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-broken': { ok: false, output: THREW },        // red, but it never RAN
      'gate-fixed:1': { ok: false, output: RED(47) },     // repaired: honestly red
      'gate-fixed:2': { ok: true, output: '' },           // green after the build
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /the gate did not RUN/.test(w))
  assert.ok(bounce, 'expected the defective-gate bounce brief')
  assert.match(bounce, /THREW instead of adjudicating/)
  assert.match(bounce, /must be FIXED, not deleted/)
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.deepEqual(res.details.gate.replaced, ['gate-broken'])
  // Pre-build hygiene, not a mid-run gate change: the ONE repair is still unspent.
  assert.equal(res.details.gate.repairs, 0)
})

test('#440: a vacuous-green baseline repaired into a DEFECTIVE red escalates — a repair may not trade green for broken', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-vacuous-440' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-broken-440' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-vacuous-440': { ok: true, output: '' },
      'gate-broken-440': { ok: false, output: THREW },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation?.why ?? '', /THREW instead of adjudicating/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0, 'never build against a repaired gate that cannot run')
})

test('the accepted plan is mounted once in the live viewer, on the plan path', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.showDoc, [`${TD}/plan.md`])
})

test('a bounced plan mounts the viewer once — after acceptance, never twice', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }),
      'lead:1': leadEnv('bounce', 'the brief means X not Y; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.showDoc.length, 1)
  assert.deepEqual(io.calls.showDoc, [`${TD}/plan.md`])
})

test('unreadable reviewer verdict + granted bounce re-asks the REVIEWER in place — the builder is NOT re-run', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'maybe?' } },
      'lead:1': leadEnv('bounce'),
      'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
})

test('an envelope carrying its OWN assignment_id is accepted', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ assignment_id: 'planner1' }), // fakeIo ids are `${role}${n}`
      'builder:1': buildEnv({ assignment_id: 'builder1' }),
      'reviewer:1': { ...reviewEnv('pass'), assignment_id: 'reviewer1' },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, io).status, 'done')
})

test('accepted_via records a lead accept-with-residuals distinctly from a review pass', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.match(res.details.accepted_via, /residuals/)
  assert.match(res.summary, /residuals/)
  assert.doesNotMatch(res.summary, /review pass/) // the envelope never asserts a review that did not happen
})

test('DECISIONS and LIMITS are the frozen public contract', () => {
  assert.ok(Object.isFrozen(DECISIONS) && Object.isFrozen(LIMITS))
  assert.deepEqual([...DECISIONS], ['bounce', 'bounce-builder', 'bounce-reviewer', 'accept', 'escalate'])
  assert.equal(SECOND_OPINION, 'second-opinion')
  assert.ok(Object.isFrozen(PERSPECTIVE_TARGETS))
})

test('reviewer envelope events carry normalized outcomes while planner and builder events do not', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const envelopes = io.calls.emits.filter((event) => event.kind === 'envelope')
  const reviewer = envelopes.find((event) => event.role === 'reviewer')
  assert.deepEqual(reviewer.review, { verdict: 'changes-needed', must_fix: 1, should_fix: null, consider: null })
  assert.ok(envelopes.filter((event) => event.role !== 'reviewer').every((event) => !('review' in event)))
  assert.deepEqual(io.calls.logs.find((line) => line.review_outcome).review_outcome, {
    dispatch: 'reviewer1', verdict: 'changes-needed', must_fix: 1, should_fix: null, consider: null,
  })
})

test('emit mirrors lead decisions and dissents', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'residuals matter', recommendation: 'escalate', confidence: 'high' } },
      'lead:2': leadEnv('bounce'), 'planner:2': planEnv(), 'builder:1': buildEnv(),
      'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  assert.ok(io.calls.emits.some((e) => e.kind === 'decision' && e.decided === 'bounce'))
  assert.ok(io.calls.emits.some((e) => e.kind === 'dissent' && e.from === 'reviewer' && e.recommendation === 'escalate' && e.lead_decision === 'bounce'))
})

test('a diverging round leaves bounce, accept and escalate all open', () => {
  const { io } = divergentPlanScenario('escalate')
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  for (const option of ['bounce', 'accept', 'escalate']) assert.match(decision, new RegExp(`^- ${option}$`, 'm'))
})

test('the unexhausted plan path keeps its diagnostics unchanged', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.deepEqual(Object.keys(result.details).sort(), [
    'accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'enforcements', 'escalation', 'extra_rounds_granted',
    'files_committed', 'gate', 'growth', 'modifiers', 'stages',
  ])
  assert.deepEqual(result.details.stages, ['plan:r1', 'check:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done'])
  assert.equal(io.calls.logs.filter((entry) => entry.accept_decision).length, 0)
  assert.equal(io.calls.assign.some(({ role }) => role === 'lead'), false)
  assert.equal(Object.keys(io.calls.writes).some((path) => /decision-\d+b?\.md$/.test(path)), false)
})

test('validateCarve enforces the closed verdict and first-slice scope contract', () => {
  for (const verdict of [undefined, null, 'PROCEED', 'split']) {
    const result = validateCarve({ carve_verdict: verdict })
    assert.equal(result.verdict, null)
    assert.equal(result.slices.length, 0)
    assert.ok(result.why)
  }
  assert.deepEqual(validateCarve({ carve_verdict: 'proceed' }), { verdict: 'proceed', slices: [], defect: null, why: null })
  const good = validateCarve({
    carve_verdict: 'carve',
    carve_slices: [
      { summary: ' first ', files_in_scope: ['a.mjs'], extra: 'drop me' },
      { summary: 'second', files_in_scope: ['b.mjs'] },
    ],
  })
  assert.deepEqual(good, {
    verdict: 'carve', slices: [
      { summary: 'first', files_in_scope: ['a.mjs'] },
      { summary: 'second', files_in_scope: ['b.mjs'] },
    ], defect: null, why: null,
  })
  for (const carve_slices of [[], null, {}, [{ summary: 'bad', files_in_scope: ['../bad'] }]]) {
    const result = validateCarve({ carve_verdict: 'carve', carve_slices })
    assert.equal(result.verdict, 'carve')
    assert.ok(result.defect)
  }
})

test('a plan revision without carve_verdict escalates before check:r2', () => {
  const { result } = planRevisionRun(adversarialPlanEnv({ details: { ...planEnv().details, carve_verdict: undefined } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.ok(!result.details.stages.includes('check:r2'))
})

test('a proceed verdict continues to check:r2', () => {
  const { result } = planRevisionRun(adversarialPlanEnv({ details: { ...planEnv().details, carve_verdict: 'proceed' } }))
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('check:r2'))
})

test('round 1 does not require a carve verdict', () => {
  const details = { ...planEnv().details }
  delete details.carve_verdict
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('build:r1'))
})

test('b382 A1 an acceptance gate run takes and gives back a suite slot', () => {
  const io = closeoutIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    slots: slotFactory(),
  })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'gate', 'run:gate-cmd')
})

test('review-round exhaustion converges with review residuals and no gate-red entry', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 2 })
  assert.equal(result.status, 'converge')
  assert.equal(result.details.escalation.where, 'review')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.commits.length, 1)
})

test('panelSeats chooses the first available partner and distinct adjudicator', () => {
  assert.deepEqual(PANEL_PARTNERS, ['tech-lead'])
  assert.deepEqual(PANEL_ADJUDICATORS, ['lead', 'tech-lead'])
  assert.equal(panelSeats(['reviewer', 'planner', 'lead']), null)
  assert.deepEqual(panelSeats(['reviewer', 'tech-lead', 'lead', 'planner']), { partner: 'tech-lead', adjudicator: 'lead' })
  assert.deepEqual(panelSeats(['reviewer', 'tech-lead']), null)
  assert.deepEqual(panelSeats(['reviewer', 'lead']), null)
  assert.deepEqual(panelSeats(null), null)
})

test('continuation panel assigns reviewer, partner, and adjudicator with blind briefs', () => {
  const findingsA = [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:10-20', summary: 'only A', hardening: 'ungateable', hardening_why: 'legacy panel fixture' }]
  const findingsB = [{ id: 'B1', severity: 'must-fix', location: 'a.mjs:12-18', summary: 'only B' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', findingsA),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: findingsB } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true } },
      'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass', []),
      'tech-lead:3': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:2': { status: 'done', role: 'lead', details: { adjudications: [], closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.slice(0, 6).map(({ role }) => role), ['planner', 'tech-lead', 'builder', 'reviewer', 'tech-lead', 'lead'])
  const panelRow = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(panelRow.findings[0].reviewer, 'both')
  assert.equal(io.calls.writes[`${TD}/panel-a-brief-1.md`].includes('only B'), false)
  assert.equal(io.calls.writes[`${TD}/panel-b-brief-1.md`].includes('only A'), false)
})

test('panel degradation falls back to reviewer A without escalating', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
      // tech-lead:1 is the plan check; tech-lead:2 (the panel partner) is deliberately absent.
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.some((line) => line.panel_degraded === 'tech-lead'))
  assert.equal(io.calls.logs.some((line) => line.review_outcome?.panel), false)
})

test('panel dismissals become panel dissents and are removed from the fused verdict', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A only' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [{ id: 'A1', disposition: 'dismiss', reason: 'not a defect' }], closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  const dissent = result.details.dissents.find((entry) => entry.kind === 'panel-divergence')
  assert.deepEqual(dissent, {
    kind: 'panel-divergence', from: 'reviewer', finding_id: 'A1', severity: 'must-fix',
    location: 'a.mjs:1', summary: 'A only', disposition: 'dismissed', reason: 'not a defect', round: 1,
  })
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.deepEqual(outcome.findings, [])
})

test('an unclosed panel class adds a synthetic must-fix and preserves a review bounce without findings', () => {
  const classGuard = { ...B376_HARDENED, finding: 'panel-class-1', name: 'panel class guard' }
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('pass', []),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:1': { status: 'done', role: 'lead', details: { closes_class: false, class_invariant: 'class remains open' } },
      'builder:2': buildEnv({ details: { ...buildEnv().details, hardened: [classGuard] } }), 'reviewer:2': reviewEnv('pass', []),
      'tech-lead:3': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:2': { status: 'done', role: 'lead', details: { closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], files: B376_FILES, writeThrough: true,
  })
  const baseRun = io.run
  io.run = function (cmd) {
    const result = baseRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
    if (cmd === hardenCommand(B376_TEST_FILE, 'panel class guard')) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      const output = [B376_GREEN, B376_PRE_RED, B376_MUT_RED][count - 1] || B376_MUT_RED
      return { ...output, output: output.output.replaceAll('F1 guard', 'panel class guard') }
    }
    return result
  }
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 2, review_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(outcome.verdict, 'changes-needed')
  assert.deepEqual(outcome.findings[0], {
    id: 'panel-class-1', severity: 'must-fix', location: null,
    summary: 'class remains open', reviewer: 'adjudicator',
  })
  assert.match(Object.values(io.calls.writes).find((value) => /Review bounce/.test(value)) || '', /panel-class-1/)
})

test('a changes-needed reviewer without typed findings cannot be upgraded by an empty panel', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'B1', severity: 'should-fix', location: 'a.mjs:2', summary: 'partner note' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { closes_class: true } },
      'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.commits.length, 0)
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(outcome.verdict, 'changes-needed')
  assert.equal(outcome.must_fix, 1)
  assert.equal(outcome.findings[0].id, 'B1')
})

test('full is trace-identical and keeps the eleven legacy detail keys', () => {
  const make = (variant) => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const omittedIo = make()
  const explicitIo = make()
  const omitted = driveTask(CTX, omittedIo)
  const explicit = driveTask({ ...CTX, variant: 'full' }, explicitIo)
  assert.deepEqual(omitted.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done'])
  assert.deepEqual(Object.keys(omitted.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'enforcements', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.deepEqual(omitted, explicit)
  assert.deepEqual(omittedIo.calls, explicitIo.calls)
})

test('repair uses one bounded triage round and keeps the reviewed finish path', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['repair:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done'])
  assert.equal(result.details.commit, 'abc1234')
  assert.equal(result.details.gate, null)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'a.test.mjs'])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 1)
  assert.deepEqual(Object.keys(result.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'enforcements', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.equal(io.calls.assign.find(({ role }) => role === 'builder').briefFile, TRIAGE_NOTE)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /Failure brief \(verbatim\)/)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /files_in_scope/)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /\n- a\.mjs\n/)
  assert.doesNotMatch(JSON.stringify(io.calls.logs), /\"stage\":\"(?:plan|check|gate)/)
})

test('A1-envelope: review_only emits the complete envelope trace', () => {
  const result = driveTask(REVIEW_CTX, strictReviewIo(reviewEnvelope()))
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages), A1_ENVELOPE_TRACE)
})

test('A1-repair: repair emits its ordered branch projection', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages), [
    'repair', 'build', 'scope-gate', 'lane', 'review', 'review', 'commit', 'document', 'suite', 'suite',
  ])
  const projection = result.details.stages
    .filter((label) => label !== 'review:pass' && label !== 'suite:cold')
    .filter((label) => !['done', 'escalate'].includes(String(label).split(':')[0]))
    .map((label) => String(label).split(':')[0])
  assert.deepEqual(projection, A1_REPAIR_TRACE)
})

test('B1-repeat: a true review bounce retains all reviewer heads', () => {
  const { result, io } = b318SiteA('bounce')
  assert.equal(result.status, 'done')
  const reviews = normaliseStageHeads(result.details.stages).filter((head) => head === 'review')
  assert.deepEqual(reviews, B1_REPEAT_TRACE)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
})

test('C1-envelope-seat-scope: the named envelope seat precedes scope proof', () => {
  const result = driveTask(REVIEW_CTX, strictReviewIo(reviewEnvelope()))
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages).slice(0, 2), C1_ENVELOPE_SEAT_SCOPE)
})

test('C1-envelope-scope-accept: scope proof precedes envelope acceptance', () => {
  const result = driveTask(REVIEW_CTX, strictReviewIo(reviewEnvelope()))
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages).slice(1, 3), C1_ENVELOPE_SCOPE_ACCEPT)
})

test('C1-repair-open: repair opens before its build', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages).slice(0, 2), C1_REPAIR_OPEN)
})

test('full, scout and repair declarations remain byte-identical snapshots', () => {
  const FULL_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'document', 'rebase', 'suite', 'publish', 'converge'],
    off_critical_path_stages: [],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [], assignment: null,
  }
  const SCOUT_SNAPSHOT = {
    execution: 'envelope', required_seats: ['planner'],
    stages: ['scout', 'scope-gate', 'envelope-accept'],
    off_critical_path_stages: [],
    writes: 'none',
    accepted_by: 'envelope shape',
    envelope_fields: [{ name: 'findings', kind: 'records', item_fields: ['summary', 'evidence'], optional_item_fields: ['program', 'output'] }],
    assignment: 'Read-only recon. Answer the brief from the code and the checkout, write your notes into the task dir, and change nothing. `program` is a command or script you actually ran, and it always travels with the `output` it produced. If you ran nothing, omit both.',
  }
  const REPAIR_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'],
    off_critical_path_stages: [],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [],
    assignment: 'Bounded triage. Read the failure the task brief carries verbatim, then write the smallest fix the builder can execute inside the scope this run inherits. This is NOT a plan round: there is no revision, no plan-check, no second attempt, and no acceptance gate.',
    sources: { scope: 'inherited', lane: 'ctx', gate: 'none' },
  }
  assert.deepEqual(VARIANTS.full, FULL_SNAPSHOT)
  assert.deepEqual(VARIANTS.scout, SCOUT_SNAPSHOT)
  assert.deepEqual(VARIANTS.repair, REPAIR_SNAPSHOT)
})

test('scout runs only recon, scope proof, envelope acceptance, and done', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['scout:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.deepEqual(io.calls.run, [])
})

test('scout rejects envelopes that do not match its declared shape', () => {
  const cases = [
    { details: {} }, { details: { findings: [] } }, { details: { findings: [null] } },
    { details: { findings: [{ summary: 's' }] } },
    { details: { findings: [{ summary: '  ', evidence: 'e' }] } },
    { summary: '' }, { artifacts: null }, { artifacts: [7] },
    { artifacts: ['/etc/passwd'] }, { artifacts: [`${TD}/../escape.md`] }, { details: null },
  ]
  for (const over of cases) {
    const malformed = reconEnv(over)
    const io = fakeIo({ envelopes: {
      'planner:1': malformed,
      'planner1.shape-reask.planner.json': malformed,
    }, changed: [] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
  }
  assert.equal(envelopeDefect(reconEnv(), VARIANTS.scout, { taskDir: TD }), null)
  assert.equal(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).reason, 'no-envelope')
  assert.match(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).why, /no envelope/)
})

test('A1 accepts paired optional scout lab evidence', () => {
  const finding = {
    summary: 'the loop is code-owned', evidence: 'crew/drive.mjs:720',
    program: 'node scripts/check-loop.mjs', output: 'loop check passed',
  }
  const env = reconEnv({ details: { findings: [finding] } })
  assert.equal(envelopeDefect(env, VARIANTS.scout, { taskDir: TD }), null)
  assert.deepEqual(env.details.findings, [finding])
  assert.deepEqual(VARIANTS.scout.envelope_fields[0].optional_item_fields, ['program', 'output'])
})

test('B1 preserves legacy scout findings without lab evidence', () => {
  const env = reconEnv()
  assert.equal(envelopeDefect(env, VARIANTS.scout, { taskDir: TD }), null)
  assert.deepEqual(env.details, { findings: [{ summary: 'the loop is code-owned', evidence: 'crew/drive.mjs:720' }] })
})

test('C1P refuses a scout program without output', () => {
  const env = reconEnv({ details: { findings: [{ summary: 's', evidence: 'e', program: 'node check.mjs' }] } })
  const defect = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
  assert.match(defect.why, /program requires output/)
})

test('C1O refuses scout output without a program', () => {
  const env = reconEnv({ details: { findings: [{ summary: 's', evidence: 'e', output: 'check passed' }] } })
  const defect = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
  assert.match(defect.why, /output requires program/)
})

test('D1 validates a present optional scout field as non-empty', () => {
  const env = reconEnv({ details: { findings: [{ summary: 's', evidence: 'e', program: '', output: 'check passed' }] } })
  const defect = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
})

test('E1 refuses required and optional item field overlap', () => {
  const field = VARIANTS.scout.envelope_fields[0]
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [{ ...field, item_fields: ['summary', 'evidence'], optional_item_fields: ['evidence'] }],
  }
  assert.equal(typeof shapeDefect(shape, 'scout'), 'string')
})

test('F1 validates optional item field declaration shape', () => {
  const field = VARIANTS.scout.envelope_fields[0]
  for (const optional_item_fields of [null, 'program', [1], [''], ['program', 'program']]) {
    const shape = { ...VARIANTS.scout, envelope_fields: [{ ...field, optional_item_fields }] }
    assert.equal(typeof shapeDefect(shape, 'scout'), 'string', JSON.stringify(optional_item_fields))
  }
})

test('F2 permits optional_item_fields only on records', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [{ name: 'note', kind: 'text', optional_item_fields: ['program'] }],
  }
  assert.equal(typeof shapeDefect(shape, 'scout'), 'string')
})

test('G1 leaves every legacy non-scout variant envelope contract unchanged', () => {
  const expected = JSON.parse(`{"full":{"execution":"reviewed","required_seats":"tier","stages":["plan","check","build","scope-gate","lane","gate","gate-baseline","gate-repair","gate-reverify","gate-proof","review","commit","document","rebase","suite","publish","converge"],"off_critical_path_stages":[],"writes":"planned","accepted_by":"a review verdict of pass, or a lead accept at review or build exhaustion","envelope_fields":[],"assignment":null},"review_only":{"execution":"envelope","required_seats":["reviewer"],"stages":["review_only","scope-gate","envelope-accept"],"off_critical_path_stages":[],"writes":"none","accepted_by":"structured envelope plus zero-write proof; no commit","strict_identity":true,"report_values":true,"envelope_fields":[{"name":"base","kind":"text"},{"name":"head","kind":"text"},{"name":"outcome","kind":"text","values":["findings","no-findings"]},{"name":"findings","kind":"records","allow_empty":true,"item_fields":["id","severity","location","summary","evidence","disposition"],"item_values":{"severity":["must-fix","should-fix","consider"],"disposition":["auto-fix","ask-user","no-op"]},"item_patterns":{"id":"^[A-Za-z0-9_-]{1,64}$"},"cardinality":{"discriminator":"outcome","empty":"no-findings","nonempty":"findings"}}, {"name":"reviewed_files","kind":"paths","allow_empty":true},{"name":"unreviewable_files","kind":"records","allow_empty":true,"item_fields":["path","reason"],"item_values":{"reason":["binary","generated","too-large","out-of-context"]}}],"assignment":"Review the returned base/head identity and the declared change set as a read-only code review. This assignment supersedes the ordinary reviewer deliverable: do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted. Return the complete structured envelope with non-empty base and head, outcome findings or no-findings, reviewed_files as an array of paths, and unreviewable_files as records with path and reason; every unreviewable reason must be binary, generated, too-large, or out-of-context, every listed path must belong to the base/head change set, and reviewed_files and unreviewable_files must be disjoint. Return findings records containing id, severity, location, summary, evidence, and disposition; findings must be empty exactly when outcome is no-findings and non-empty when outcome is findings."},"repair":{"execution":"reviewed","required_seats":"tier","stages":["repair","build","scope-gate","lane","review","commit","document","rebase","suite","publish"],"off_critical_path_stages":[],"writes":"planned","accepted_by":"a review verdict of pass, or a lead accept at review or build exhaustion","envelope_fields":[],"assignment":"Bounded triage. Read the failure the task brief carries verbatim, then write the smallest fix the builder can execute inside the scope this run inherits. This is NOT a plan round: there is no revision, no plan-check, no second attempt, and no acceptance gate.","sources":{"scope":"inherited","lane":"ctx","gate":"none"}},"directed":{"execution":"reviewed","required_seats":["builder","reviewer"],"stages":["directed","build","scope-gate","lane","gate","gate-baseline","gate-proof","review","commit","document","rebase","suite","publish","converge"],"off_critical_path_stages":[],"writes":"planned","accepted_by":"a review verdict of pass, or a lead accept at review or build exhaustion","envelope_fields":[],"assignment":null,"sources":{"scope":"brief","lane":"ctx","gate":"brief"}},"verify_only":{"execution":"envelope","required_seats":["reviewer"],"stages":["verify_only","scope-gate","envelope-accept"],"off_critical_path_stages":[],"writes":"none","accepted_by":"complete structured verification report plus zero-write proof; no commit, regardless of product verdict","strict_identity":true,"report_values":true,"envelope_fields":[{"name":"verification_targets","kind":"records","item_fields":["id","target"]},{"name":"environment_assumptions","kind":"records","item_fields":["name","assumption"]},{"name":"product_verdict","kind":"text","values":["passing","failing"]},{"name":"check_matrix","kind":"records","allow_empty":true,"item_fields":["id","status","command","result","evidence"],"item_values":{"status":["passed","failed","blocked","not run"]},"covers":{"field":"verification_targets","key":"id"}},{"name":"environment","kind":"records","item_fields":["name","observed"]},{"name":"environmental_blockers","kind":"records","allow_empty":true,"item_fields":["target","reason"]}],"assignment":"Read-only verification. Return a complete structured verification report with details.verification_targets as non-empty records with id,target; details.environment_assumptions as non-empty records with name,assumption; details.product_verdict as passing or failing; details.check_matrix as records with id,status,command,result,evidence and one row for each verification target; details.environment as non-empty records with name,observed; and details.environmental_blockers as records with target,reason. Ephemeral build/test artifacts may exist only while checks run and must be removed before return; the final checkout must be clean. No tester role is introduced."}}`)
  const actual = Object.fromEntries(Object.entries(VARIANTS).filter(([name]) => name !== 'scout' && name !== 'review_panel'))
  assert.deepEqual(actual, expected)
})

test('H1 renders optional scout item fields as optional guidance', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  const brief = io.calls.writes[`${TD}/scout-brief.md`]
  assert.equal(result.status, 'done')
  assert.match(brief, /; optional fields program and output are each non-empty when present/)
  assert.doesNotMatch(brief, /each with a non-empty summary and a non-empty evidence and a non-empty program/)
})

test('I1V enforces item_values on present optional fields', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [{
      name: 'findings', kind: 'records', item_fields: ['summary'], optional_item_fields: ['program'],
      item_values: { program: Object.freeze(['allowed']) },
    }],
  }
  const env = reconEnv({ details: { findings: [{ summary: 's', program: 'forbidden' }] } })
  const defect = envelopeDefect(env, shape, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
})

test('I1P enforces item_patterns on present optional fields', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [{
      name: 'findings', kind: 'records', item_fields: ['summary'], optional_item_fields: ['program'],
      item_patterns: { program: '^[a-z]+$' },
    }],
  }
  const env = reconEnv({ details: { findings: [{ summary: 's', program: 'INVALID' }] } })
  const defect = envelopeDefect(env, shape, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
})

test('the envelope refusal reason set is closed and frozen', () => {
  assert.equal(Object.isFrozen(ENVELOPE_REFUSAL_REASONS), true)
  assert.deepEqual([...ENVELOPE_REFUSAL_REASONS], ['no-envelope', 'summary', 'artifacts', 'details', 'field-missing', 'field-kind', 'field-item', 'verdict-findings', 'finding-id', 'vacuity-classification', 'carried-silent', 'validation-lane-unloadable'])
  const malformed = [
    null,
    'not an object',
    { ...reconEnv(), summary: '' },
    { ...reconEnv(), artifacts: null },
    { ...reconEnv(), artifacts: [7] },
    { ...reconEnv(), artifacts: ['/etc/passwd'] },
    { ...reconEnv(), artifacts: [`${TD}/../escape.md`] },
    { ...reconEnv(), details: null },
    { ...reconEnv(), details: {} },
    { ...reconEnv(), details: { findings: 'not an array' } },
    { ...reconEnv(), details: { findings: [null] } },
    { ...reconEnv(), details: { findings: [{ summary: 's' }] } },
  ]
  for (const env of malformed) {
    const defect = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
    assert.ok(defect && typeof defect === 'object' && !Array.isArray(defect))
    assert.ok(ENVELOPE_REFUSAL_REASONS.includes(defect.reason))
    assert.equal(typeof defect.why, 'string')
    assert.ok(defect.why.trim())
  }
})

test('an envelope that omits a declared field is refused, per declared field', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const envelope = (details) => ({
    status: 'done', role: 'planner', summary: 'recon complete', artifacts: [`${TD}/scout.md`], details,
  })
  const complete = { alpha: 'a sentence', beta: [{ summary: 's', evidence: 'e' }] }
  for (const field of shape.envelope_fields) {
    const details = { ...complete }
    delete details[field.name]
    const defect = envelopeDefect(envelope(details), shape, { taskDir: TD })
    assert.equal(defect.reason, 'field-missing')
    assert.ok(defect.why.includes(field.name))
  }
  for (const field of VARIANTS.scout.envelope_fields) {
    const defect = envelopeDefect(reconEnv({ details: {} }), VARIANTS.scout, { taskDir: TD })
    assert.equal(defect.reason, 'field-missing')
    assert.ok(defect.why.includes(field.name))
  }
  const undefinedValue = envelopeDefect(reconEnv({ details: { findings: undefined } }), VARIANTS.scout, { taskDir: TD })
  assert.equal(undefinedValue.reason, 'field-missing')
  assert.ok(undefinedValue.why.includes('findings'))
})

test('a well-formed envelope is still accepted, and extra material never over-refuses', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const record = { summary: 's', evidence: 'e', extra: 'ignored' }
  const twoField = {
    status: 'done', role: 'planner', summary: 'recon complete',
    artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
    details: { alpha: 'a sentence', beta: [record], unrelated: 7 },
  }
  assert.equal(envelopeDefect(twoField, shape, { taskDir: TD }), null)
  assert.equal(envelopeDefect(reconEnv({
    artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
    details: { findings: [record], unrelated: 7 },
  }), VARIANTS.scout, { taskDir: TD }), null)

  const io = fakeIo({
    envelopes: { 'planner:1': reconEnv({
      artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
      details: { findings: [record], unrelated: 7 },
    }) },
    changed: [],
  })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['scout:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.equal(result.details.accepted_via, VARIANTS.scout.accepted_by)
  assert.equal(io.calls.commits.length, 0)
})

test('an accepted envelope run READS the envelope to report its fields', () => {
  const source = reconEnv()
  let presenceReads = 0
  const env = {
    ...source,
    details: new Proxy(source.details, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'findings') presenceReads += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    }),
  }
  const io = fakeIo({ envelopes: { 'planner:1': env }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  const expected = envelopeFieldsPresent(reconEnv(), VARIANTS.scout)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.envelope.fields, expected)
  const line = io.calls.logs.find((entry) => entry.envelope_accepted)
  assert.ok(line)
  assert.deepEqual(line.envelope_accepted.fields, expected)
  assert.equal(line.envelope_accepted.files_changed, 0)
  assert.equal(line.envelope_accepted.seat, 'planner')
  assert.equal(presenceReads, 2)
})

test('an envelope refusal escalates naming the reason the validator produced', () => {
  const cases = [
    ['summary', reconEnv({ summary: '' })],
    ['artifacts', reconEnv({ artifacts: ['/etc/passwd'] })],
    ['details', reconEnv({ details: null })],
    ['field-missing', reconEnv({ details: {} })],
    ['field-kind', reconEnv({ details: { findings: 'not an array' } })],
    ['field-item', reconEnv({ details: { findings: [{ summary: 's' }] } })],
  ]
  for (const [expectedReason, env] of cases) {
    const direct = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
    assert.equal(direct.reason, expectedReason)
    const io = fakeIo({ envelopes: {
      'planner:1': env,
      'planner1.shape-reask.planner.json': env,
    }, changed: [] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
    assert.ok(result.details.escalation.why.includes(`[${direct.reason}]`))
    assert.equal(result.details.stages.includes('envelope-accept'), false)
    assert.equal(io.calls.commits.length, 0)
  }
})

test('shapeDefect still judges the DECLARATION alone, unchanged', () => {
  for (const [name, shape] of Object.entries(VARIANTS)) assert.equal(shapeDefect(shape, name), null)
  const unknown = shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'unknown' }] }, 'scout')
  assert.equal(typeof unknown, 'string')
  assert.match(unknown, /kind/)
  const kindless = shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings' }] }, 'scout')
  assert.equal(typeof kindless, 'string')
  assert.match(kindless, /kind/)
})

test("a reviewed shape's acceptance is untouched by the envelope contract", () => {
  const planEnvelope = planEnv()
  for (const name of ['full', 'repair', 'directed']) {
    assert.equal(VARIANTS[name].envelope_fields.length, 0)
    assert.equal(envelopeDefect(planEnvelope, VARIANTS[name], { taskDir: TD }), null)
  }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, variant: 'full' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(Object.keys(result.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'enforcements', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.equal(io.calls.logs.some((line) => line.envelope_accepted), false)

  const triageIo = fakeIo({ envelopes: { 'planner:1': triageEnv({ summary: '' }) }, changed: [] })
  const triageResult = driveTask(CTX_REPAIR, triageIo)
  assert.equal(triageResult.status, 'escalation')
  assert.equal(triageResult.details.escalation.where, 'triage')
  assert.equal(triageResult.details.escalation.why, 'the triage envelope is not one the driver can build from: summary must be a non-empty string')
})

test('scout acceptance uses its own contract and journals envelope acceptance', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.details.accepted_via, VARIANTS.scout.accepted_by)
  assert.doesNotMatch(JSON.stringify(result), /review pass|review:pass|review_outcome/i)
  assert.doesNotMatch(JSON.stringify(io.calls.logs), /review pass|review:pass|review_outcome/i)
  assert.ok(io.calls.logs.some((line) => line.envelope_accepted))
})

test('the panel is skipped without a tech-lead, and this drive hands the seated planner no panel assignment', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []) },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.some((line) => line.panel_skipped === 'seats'))
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  assert.deepEqual(io.calls.assign.filter(({ role }) => role === 'planner').map(({ note }) => note), ['plan'], 'the seated planner is assigned for the plan round only, never a panel seat')
  assert.deepEqual(PANEL_PARTNERS, ['tech-lead'])
  assert.deepEqual(PERSPECTIVE_TARGETS, ['reviewer', 'tech-lead'])
})

test('T3 — the resume counters are measured', () => {
  const { envelope } = crashRun()
  assert.deepEqual(envelope.details.stages, CRASH_STAGES)
  assert.deepEqual(envelope.details.cursor, { plan_round: 1, build_round: 3, review_round: 1 })
  assert.equal(envelope.details.seq_high_water, 6)
  assert.equal(envelope.details.consults_spent, 1)
  assert.deepEqual(envelope.details.accept_findings, CRASH_FINDINGS)
})

test('roundCursor reads the last round of each loop and a live escalation', () => {
  assert.deepEqual(roundCursor(['plan:r1', 'plan:r2', 'build:r1', 'review:r1', 'build:r2']), { plan_round: 2, build_round: 2, review_round: 1 })
  assert.deepEqual(roundCursor([]), { plan_round: null, build_round: null, review_round: null })
  assert.deepEqual(roundCursor(null), { plan_round: null, build_round: null, review_round: null })
  assert.deepEqual(roundCursor(['plan:r1', null, 4, 'other']), { plan_round: 1, build_round: null, review_round: null })
  const result = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.deepEqual(result.details.cursor, { plan_round: 1, build_round: 1, review_round: 1 })
})

test('review pass, review panel and check labels are not round cursors', () => {
  assert.deepEqual(roundCursor(['plan:r1', 'check:r2', 'review:r1', 'review:panel-r2', 'review:pass']), { plan_round: 1, build_round: null, review_round: 1 })
})

test('consults and reviewer findings carry into an escalation', () => {
  const consulted = driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'lane-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.equal(consulted.details.consults_spent, 1)
  const noConsult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() }, changed: ['a.mjs', 'outside.mjs'] }))
  assert.equal(noConsult.details.consults_spent, 0)
  const findings = [{ id: 'RV1', severity: 'should-fix', location: 'a.mjs:1', summary: 'open' }]
  const normalizedFindings = [{ ...findings[0], disposition: null }]
  const carried = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', findings) }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.deepEqual(carried.details.accept_findings, normalizedFindings)
  const absent = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.equal(absent.details.accept_findings, null)
})

test('panel fused findings are the canonical accept findings', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true } },
      'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1 } }, io)
  const panel = io.calls.logs.map((row) => row.review_outcome).find((row) => row?.panel)
  assert.equal(result.status, 'escalation')
  assert.deepEqual(result.details.accept_findings, panel.findings)
  assert.ok(result.details.accept_findings.some((finding) => finding.reviewer === 'both'))
})

test('nested panel child completes while unfinished review parent does not', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'B1', severity: 'must-fix', location: 'a.mjs:2', summary: 'B' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], closes_class: true } }, 'lead:2': null,
    }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.ok(io.calls.logs.some((row) => row.stage_done === 'review:panel-r1'))
  assert.equal(io.calls.logs.some((row) => row.stage_done === 'review:r1'), false)
})

test('the two review-exhaustion consults offer both recipients', () => {
  const want = ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate', 'second-opinion']
  for (const { io } of [b318SiteA('bounce-reviewer'), b318SiteB('bounce-reviewer')]) {
    assert.deepEqual(b318Options(io.calls.writes[`${TD}/decision-1.md`]), want)
  }
})

test('either target spends the one review grant', () => {
  const { io, result } = b318SiteA('bounce-reviewer', { secondReview: 'changes-needed', secondLead: 'escalate' })
  assert.equal(result.status, 'escalation')
  // The valve is offered on the FIRST round of every consult, so it rides along.
  assert.deepEqual(b318Options(io.calls.writes[`${TD}/decision-2.md`]), ['accept', 'escalate', 'second-opinion'])
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('bounce-reviewer at build exhaustion re-reviews without a build', () => {
  const { io, result } = b318SiteB('bounce-reviewer')
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1',
    'review:r2', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done',
  ])
  assert.equal(b318Builders(io).length, 1)
})

test('the re-review brief states only what holds at both exhaustion sites', () => {
  for (const [label, { io }] of [['site A', b318SiteA('bounce-reviewer')], ['site B', b318SiteB('bounce-reviewer')]]) {
    const brief = io.calls.writes[`${TD}/review-brief-2.md`]
    const flat = brief.replace(/\s+/g, ' ')
    assert.ok(flat.includes('STALE'), `${label}: no STALE`)
    const where = label === 'site A' ? 'review-exhausted' : 'build-exhausted'
    assert.ok(flat.includes(`STALE (${where})`), `${label}: wrong exhaustion label`)
    assert.ok(flat.includes(`${TD}/review.md`), `${label}: no review path`)
    assert.ok(flat.includes('against the CURRENT tree'), `${label}: no CURRENT tree`)
    assert.ok(flat.includes('reviewer bounce itself built nothing'), `${label}: no built-nothing clause`)
    assert.ok(flat.includes('every configured acceptance gate'), `${label}: no configured-gate clause`)
    // One helper serves both sites, so neither chronology may be asserted: the
    // site-A path builds after the standing verdict, while the site-B consult
    // follows its verdict directly.
    assert.equal(flat.includes('nothing has been built since it was written'), false, `${label}: false chronology`)
    assert.equal(flat.includes('the tree moved after'), false, `${label}: unconditional chronology`)
    assert.equal(io.calls.writes[`${TD}/review-brief-1.md`].includes('STALE'), false, `${label}: first brief contaminated`)
  }
})

test('bounceTargetOf maps only where the bare name is off the menu', () => {
  const targets = ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate']
  assert.equal(bounceTargetOf('bounce', ['bounce', 'accept', 'escalate']), 'bounce')
  assert.equal(bounceTargetOf('bounce', targets), 'bounce-builder')
  assert.equal(bounceTargetOf('accept', targets), 'accept')
  assert.equal(bounceTargetOf('bounce', ['accept', 'escalate']), 'bounce')
  assert.equal(bounceTargetOf('bounce', null), 'bounce')
  assert.equal(bounceTargetOf(undefined, targets), undefined)
})

test('staleVerdictLines is empty for an ordinary review round', () => {
  for (const input of [null, undefined, {}, { path: 7 }, { where: 'review-exhausted' }]) {
    assert.deepEqual(staleVerdictLines(input), [])
  }
})

test('staleVerdictLines states only what holds at both sites', () => {
  const flat = staleVerdictLines({ path: '/t/review.md', where: 'build-exhausted' }).join('\n').replace(/\s+/g, ' ')
  for (const token of ['/t/review.md', 'STALE', 'build-exhausted', 'against the CURRENT tree',
    'reviewer bounce itself built nothing', 'every configured acceptance gate']) {
    assert.ok(flat.includes(token), `stale note must say ${token}`)
  }
  assert.equal(flat.includes('nothing has been built since it was written'), false)
  assert.equal(flat.includes('the tree moved after'), false)
})

test('a stale re-review brief survives an unreadable in-place re-ask', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': b318GatedPlan(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'),
      'reviewer:2': { status: 'done', role: 'reviewer', details: { verdict: 'unknown-shape' } },
      'reviewer:3': reviewEnv('changes-needed'),
      'lead:1': leadEnv('bounce-reviewer'), 'lead:2': leadEnv('bounce'), 'lead:3': leadEnv('escalate'),
    },
    runs: B318_GATED_RUNS,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 3)
  const briefs = io.calls.writeLog
    .filter(({ path }) => path === `${TD}/review-brief-2.md`)
    .map(({ content }) => content)
  assert.equal(briefs.length, 2)
  assert.match(briefs[1], /STALE/)
})

test('plan-check accept residuals survive into the single driver-written publication body', () => {
  const residual = { id: 'PC1-9', type: 'cosmetic', summary: 'phase table remains for the sibling lane' }
  const io = publicationIo({ envelopes: {
    'planner:1': adversarialPlanEnv(), 'planner:2': adversarialPlanEnv(),
    'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'),
    'lead:1': leadEnv('accept', '', { residuals: [residual] }),
    'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  } })
  const ctx = {
    ...CTX, roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'],
    task: 'plan-accept', journal: `${TD}/journal.jsonl`, limits: { plan_rounds: 2 },
    publish: { branch: 'feature/plan-accept' },
  }
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'done')
  assert.match(io.calls.writes[`${TD}/pr-body.md`], /PC1-9 \(cosmetic\): phase table remains for the sibling lane/)
})

test('#800 §7b 1 — verdictFindingsDefect refuses raw pass must-fixes', () => {
  const mustFix = { id: 'RV1-1', severity: 'must-fix' }
  assert.equal(verdictFindingsDefect({ verdict: 'pass', findings: [mustFix] })?.reason, 'verdict-findings')
  assert.equal(verdictFindingsDefect({ verdict: 'approve', must_fix: 2 })?.reason, 'verdict-findings')
  assert.equal(verdictFindingsDefect({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }] }), null)
  assert.equal(verdictFindingsDefect({ verdict: 'changes-needed', findings: [mustFix] }), null)
  const duplicate = { verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }, mustFix] }
  assert.deepEqual(reviewFindings(duplicate).findings.map(({ severity }) => severity), ['should-fix'])
  assert.equal(verdictFindingsDefect(duplicate)?.reason, 'verdict-findings')
})

test('#800 §7b 2 — reviewer envelope refusals are closed and shape-owned', () => {
  assert.ok(ENVELOPE_REFUSAL_REASONS.includes('verdict-findings'))
  assert.ok(ENVELOPE_REFUSAL_REASONS.includes('finding-id'))
  const envelope = (details) => ({ status: 'done', role: 'reviewer', summary: 'reviewed', artifacts: [], details })
  assert.equal(envelopeDefect(envelope({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'must-fix' }] }), VARIANTS.full, { taskDir: TD })?.reason, 'verdict-findings')
  assert.equal(envelopeDefect(envelope({ verdict: 'changes-needed', findings: [{ id: '../../escape', severity: 'must-fix' }] }), VARIANTS.full, { taskDir: TD })?.reason, 'finding-id')
})

test('#800 §7b 3 — a refused pass must-fix re-asks the reviewer at the free round', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
      'lead:1': leadEnv('bounce'), 'reviewer:2': dReviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('review')), ['review:r1', 'review:r1', 'review:pass'])
  assert.equal(io.calls.logs.find((row) => row.review_round?.refused)?.review_round.refused, 'verdict-findings')
})

test('#800 §7b 5 — a refused pass must-fix never becomes canonical accept findings', () => {
  const io = dispositionIo([{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.details.accept_findings, null)
})

test('#800 §7b 6 — a refused ask-user finding reaches only the reviewer-refusal consult', () => {
  const io = dispositionIo([{ ...D_ASK, verdict: undefined }], { verdict: 'pass', leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'done')
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'escalate'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
  assert.equal(io.calls.writes[`${TD}/build-bounce-r1.md`], undefined)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
})

test('#800 §7b 7 — a continuation panel refuses pass must-fix before assigning panel seats', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
      'lead:1': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(D_PANEL_CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
})

test('#800 §7b 8 — an unreadable verdict cannot execute ask-user routing', () => {
  const io = dispositionIo([D_ASK], { verdict: 'not-a-verdict' })
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 9 — disposition parsing routes only accepted declared values', () => {
  for (const declared of FINDING_DISPOSITIONS) assert.equal(dispositionOf({ disposition: declared }), declared)
  assert.equal(dispositionOf({ disposition: 'surprise' }), null)
  const routed = dispositionPlan({
    findings: [
      { id: 'auto', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'seat', severity: 'must-fix', disposition: 'auto-fix' },
      { id: 'ask', severity: 'should-fix', location: 'a.mjs:2', summary: 'human choice', disposition: 'ask-user' },
      { id: 'noop', severity: 'must-fix', disposition: 'no-op' },
    ],
  })
  assert.deepEqual(routed.autoFix, [{ id: 'auto', severity: 'must-fix', patch: D_PATCH_A }])
  assert.deepEqual(routed.askUser, [{ id: 'ask', severity: 'should-fix', location: 'a.mjs:2', summary: 'human choice' }])
  assert.deepEqual(routed.needsSeat, ['seat'])
  const hostile = dispositionPlan({
    findings: [
      { id: 'same', severity: 'blocker', disposition: 'auto-fix', patch: D_PATCH_B },
      { id: 'same', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'duplicate', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'duplicate', severity: 'must-fix', disposition: 'ask-user', patch: D_PATCH_B },
    ],
  })
  assert.deepEqual(hostile.autoFix.map(({ id, patch }) => ({ id, patch })), [{ id: 'same', patch: D_PATCH_A }, { id: 'duplicate', patch: D_PATCH_A }])
  assert.deepEqual(hostile.askUser, [])
})

test('#800 §7b 10 — acceptedRawById mirrors reviewFindings acceptance order', () => {
  const details = {
    findings: [
      { id: 'second', severity: 'blocker', patch: 'rejected' },
      { id: 'second', severity: 'must-fix', patch: 'accepted-second' },
      { id: 'first', severity: 'must-fix', patch: 'accepted-first' },
      { id: 'first', severity: 'should-fix', patch: 'duplicate' },
      { severity: 'must-fix', patch: 'missing-id' },
    ],
  }
  const accepted = acceptedRawById(details)
  assert.equal(accepted.get('second').patch, 'accepted-second')
  assert.equal(accepted.get('first').patch, 'accepted-first')
  assert.equal(accepted.has(undefined), false)
  assert.deepEqual([...accepted.keys()], reviewFindings(details).findings.map(({ id }) => id))
})

test('#800 §7b 11 — ordinary confused-deputy findings apply only accepted patch bytes', () => {
  const io = dispositionIo([
    { id: 'RV1-1', severity: 'blocker', location: 'b.mjs:1', summary: 'rejected', disposition: 'auto-fix', patch: D_PATCH_B },
    { ...D_AUTO, summary: 'accepted' },
  ])
  const result = driveTask(CTX, io)
  const written = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(written.includes('a/a.mjs'), true)
  assert.equal(written.includes('a/b.mjs'), false)
})

test('#800 §7b 12 — panel confused-deputy findings apply only accepted patch bytes', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [
      { id: 'RV1-1', severity: 'blocker', location: 'b.mjs:1', summary: 'rejected', disposition: 'auto-fix', patch: D_PATCH_B },
      { ...D_AUTO, summary: 'accepted' },
    ]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'accepted' }]),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const written = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(written.includes('a/a.mjs'), true)
  assert.equal(written.includes('a/b.mjs'), false)
})

test('#800 §7b 23 — changes-needed ask-user findings go to the lead or review-unresolved', () => {
  const io = dispositionIo(D_ASK)
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.deepEqual(result.details.ask_user, ['RV1-1'])
  assert.equal(dOffers(brief, 'bounce-builder'), true)
  assert.equal(dOffers(brief, 'escalate'), true)
})

test('#800 §7b 24 — pass ask-user findings pause acceptance for the lead', () => {
  const io = dispositionIo({ ...D_ASK, severity: 'should-fix' }, { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(io).length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 29 — a panel pass must-fix refusal re-asks reviewer A before any panel work', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('bounce'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const firstLead = io.calls.assign.findIndex(({ role }) => role === 'lead')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.slice(0, firstLead).some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'verdict-findings'), true)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('review')), ['review:r1', 'review:panel-r1', 'review:r1', 'review:panel-r1', 'review:pass'])
})

test('#800 §7b 30 — upheld panel reviewer findings retain auto-fix and ask-user routing', () => {
  const auto = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_AUTO]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: D_AUTO.summary }]),
  })
  const autoResult = driveTask(D_PANEL_CTX, auto)
  assert.equal(autoResult.status, 'done')
  assert.equal(dGitApplies(auto).length, 1)

  const ask = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_ASK]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: D_ASK.summary }]),
    adjudication2: leadEnv('escalate'),
  })
  const askResult = driveTask(D_PANEL_CTX, ask)
  assert.equal(askResult.status, 'escalation')
  assert.equal(askResult.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(ask).length, 2)
})

test('#800 §7b 31 — dismissed panel auto-fixes never execute', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_AUTO]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: dAdjEnv({ adjudications: [{ id: 'RV1-1', disposition: 'dismiss', reason: 'not a defect' }] }),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 32 — panel canonical findings are patch-free and match their journal outcome', () => {
  const auto = { ...D_AUTO, id: 'RV1-1', severity: 'should-fix' }
  const ask = { ...D_ASK, id: 'RV1-2' }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [auto, ask]),
    partner1: dPartnerEnv('changes-needed', [
      { id: 'TL-1', severity: 'should-fix', location: 'a.mjs:1', summary: auto.summary },
      { id: 'TL-2', severity: 'must-fix', location: 'a.mjs:1', summary: ask.summary },
    ]),
    adjudication2: leadEnv('escalate'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const outcome = io.calls.logs.map((row) => row.review_outcome).find((row) => row?.panel)
  assert.equal(result.status, 'escalation')
  assert.ok(outcome)
  assert.ok(result.details.accept_findings.every((finding) => !Object.hasOwn(finding, 'patch')))
  assert.deepEqual(result.details.accept_findings, outcome.findings)
})

test('#800 §7b 33 — a patch without a disposition preserves legacy pass behavior', () => {
  const without = dispositionIo([], { verdict: 'pass' })
  const withPatch = dispositionIo([{ id: 'RV1-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'legacy', patch: D_PATCH_A }], { verdict: 'pass' })
  const plain = driveTask(CTX, without)
  const legacy = driveTask(CTX, withPatch)
  assert.deepEqual(legacy, plain)
  assert.equal(dGitApplies(withPatch).length, 0)
  assert.equal(dLeads(withPatch).length, 0)
})

test('#800 §7b 35 — findingIdDefect admits bounded tokens and refuses unsafe raw ids', () => {
  for (const id of ['RV1-1', 'panel-class-3', 'a', 'x'.repeat(64), 'A_b-9']) {
    assert.equal(findingIdDefect({ findings: [{ id, severity: 'must-fix' }] }), null, id)
  }
  for (const id of ['../../escape', 'a/b', 'a.b', '  RV1-1  ', 'a b', 'x'.repeat(65), 'x'.repeat(1000)]) {
    assert.equal(findingIdDefect({ findings: [{ id, severity: 'must-fix' }] })?.reason, 'finding-id', id)
  }
  for (const entry of [{ severity: 'must-fix' }, { id: 1, severity: 'must-fix' }, { id: '  ', severity: 'must-fix' }]) {
    assert.equal(findingIdDefect({ findings: [entry] }), null)
  }
  const long = findingIdDefect({ findings: [{ id: 'x'.repeat(1000), severity: 'must-fix' }] })
  assert.ok(long.why.length < 300)
  assert.match(long.why, /…/)
})

test('#800 §7b 36 — reviewShapeDefect has a stable refusal precedence', () => {
  assert.equal(reviewShapeDefect({ verdict: 'pass', findings: [{ id: '../../escape', severity: 'must-fix' }] })?.reason, 'verdict-findings')
  assert.equal(reviewShapeDefect({ verdict: 'changes-needed', findings: [{ id: '../../escape', severity: 'must-fix' }] })?.reason, 'finding-id')
  assert.equal(reviewShapeDefect({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }] }), null)
})

test('#800 §7b 37 — traversal finding ids are refused by name before any artifact path', () => {
  const id = '../../escape'
  const io = dispositionIo({ ...D_AUTO, id }, { leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  assertDriverIdRefusal(io, result, id)
})

test('#800 §7b 38 — thousand-character finding ids are refused before filesystem limits', () => {
  const id = 'x'.repeat(1000)
  const io = dispositionIo({ ...D_AUTO, id }, { leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  assertDriverIdRefusal(io, result, id)
  assert.equal(Object.keys(io.calls.writes).some((path) => path.split('/').some((part) => Buffer.byteLength(part) > 255)), false)
})

test('#800 §7b 39 — a panel refuses an out-of-shape reviewer-A id before panel assignments', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [{ ...D_AUTO, id: '../../escape' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'finding-id'), true)
  assert.equal(Object.keys(io.calls.writes).some((path) => /\/auto-fix-/.test(path)), false)
})

test('#800 §7b 43 — panel class findings remint around a reviewer-origin collision', () => {
  const io = classCollisionIo()
  const result = driveTask(D_COLLISION_CTX, io)
  const first = dPanelOutcomes(io)[0]
  const ids = first.findings.map(({ id }) => id)
  const klass = first.findings.filter(({ severity, reviewer }) => severity === 'must-fix' && reviewer === 'adjudicator')
  assert.equal(result.status, 'done')
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(klass.map(({ id }) => id), ['panel-remint-1'])
  assert.deepEqual(dRemintRows(io), [{ source: 'adjudicator', from: 'panel-class-1', to: 'panel-remint-1' }])
  assert.equal(dBuilders(io).length, 2)
  assert.equal(dGitApplies(io).length, 1)
})

test('#800 §7b 44 — divergent collisions preserve reviewer A ids and refuse a pinned optional prescription', () => {
  const io = divergentCollisionIo()
  const result = driveTask(D_COLLISION_CTX, io)
  const first = dPanelOutcomes(io)[0]
  const adjudication = io.calls.writes[`${TD}/panel-adjudication-1.md`] || ''
  const patch = dPatchWrite(io)?.[1] || ''
  const conflict = result.details.hardening_prescription_conflict
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'RV1-1' && reviewer === 'reviewer'))
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'panel-remint-1' && reviewer === 'tech-lead'))
  assert.match(adjudication, /panel-remint-1/)
  assert.equal(conflict.finding.id, 'panel-remint-1')
  assert.equal(conflict.file, 'a.test.mjs')
  assert.equal(dGitApplies(io).length, 0)
  assert.equal(patch, '')
})

test('RV1-1 reviewer hardening survives a reminted one-sided split', () => {
  const reviewer = [
    { id: 'F1', severity: 'must-fix', location: 'a.mjs:1', summary: 'S1', disposition: 'no-op' },
    {
      id: 'F2', severity: 'must-fix', location: 'a.mjs:2', summary: 'S2', disposition: 'no-op',
      hardening: 'ungateable', hardening_why: 'the reviewer exempted this finding before panel reminting',
    },
  ]
  const partner = {
    id: 'F2', severity: 'must-fix', location: 'a.mjs:1', summary: 'S1',
    disposition: 'ask-user', vacuity_claim: 'mutation-survived',
  }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', reviewer),
    partner1: dPartnerEnv('changes-needed', [partner]),
    adjudication2: leadEnv('escalate'),
  })
  driveTask(D_PANEL_CTX, io)
  const outcome = dPanelOutcomes(io)[0]
  const reminted = outcome.findings.find(({ id, reviewer: origin }) => id === 'panel-remint-1' && origin === 'reviewer')
  assert.deepEqual(dRemintRows(io), [{ source: 'reviewer', from: 'F2', to: 'panel-remint-1' }])
  assert.deepEqual(
    { id: reminted?.id, reviewer: reminted?.reviewer, hardening: reminted?.hardening, hardening_why: reminted?.hardening_why },
    {
      id: 'panel-remint-1', reviewer: 'reviewer', hardening: 'ungateable',
      hardening_why: 'the reviewer exempted this finding before panel reminting',
    },
  )
})

test('#800 §7b 45 — each reminted final id has one auditable remint join', () => {
  const cases = [
    [classCollisionIo(), 'panel-class-1'],
    [divergentCollisionIo(), 'RV1-1'],
  ]
  for (const [io, original] of cases) {
    const result = driveTask(D_COLLISION_CTX, io)
    assert.equal(result.status, original === 'RV1-1' ? 'escalation' : 'done')
    const reminted = dPanelOutcomes(io)[0].findings.filter(({ id }) => id.startsWith('panel-remint-')).map(({ id }) => id)
    const rows = dRemintRows(io)
    assert.deepEqual(reminted, ['panel-remint-1'])
    assert.deepEqual(rows, [{ source: original === 'panel-class-1' ? 'adjudicator' : 'tech-lead', from: original, to: 'panel-remint-1' }])
    assert.equal(rows.every(({ to }) => reminted.includes(to)), true)
  }
})

test('#800 §7b 46 — a pass carrying ask-user and auto-fix records the skipped patch', () => {
  const auto = { ...D_AUTO, severity: 'should-fix' }
  const ask = { ...D_ASK, id: 'RV1-2', severity: 'should-fix' }
  const io = dispositionIo([auto, ask], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  const rows = dAutoRows(io)
  assert.equal(result.status, 'escalation')
  assert.equal(dLeads(io).length, 1)
  assert.equal(dGitApplies(io).length, 0)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].applied, [])
  assert.deepEqual(rows[0].refused, [{ id: 'RV1-1', why: 'a pass verdict is not a fix path — the driver applies a patch only on changes-needed' }])
})

test('#800 §7b 48 — continuation panels journal the exact shape refusal they saw', () => {
  const idIo = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [{ ...D_AUTO, id: '../../escape' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const idResult = driveTask(D_PANEL_CTX, idIo)
  assert.equal(idResult.status, 'escalation')
  assert.equal(idIo.calls.logs.some((row) => row.panel_skipped === 'finding-id'), true)

  const verdictIo = dispositionPanelIo({
    reviewer1: dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const verdictResult = driveTask(D_PANEL_CTX, verdictIo)
  assert.equal(verdictResult.status, 'escalation')
  assert.equal(verdictIo.calls.logs.some((row) => row.panel_skipped === 'verdict-findings'), true)
})

test('planScopeVerdict is pure and names all five states', () => {
  assert.equal(Object.isFrozen(PLAN_SCOPE), true)
  assert.deepEqual(PLAN_SCOPE_VERDICTS, [
    'plan-scope-undispatched', 'plan-scope-same', 'plan-scope-narrowed', 'plan-scope-widened', 'plan-scope-malformed',
  ])
  assert.equal(Object.isFrozen(PLAN_SCOPE_VERDICTS), true)

  // Never compared is a STATE, not a zero: dispatched is null, never 0.
  for (const absent of [undefined, null, [], 'a.mjs']) {
    const v = planScopeVerdict(absent, ['a.mjs'])
    assert.equal(v.verdict, PLAN_SCOPE.undispatched)
    assert.equal(v.dispatched, null)
    assert.deepEqual([v.added, v.dropped], [[], []])
  }

  const same = planScopeVerdict(['a.mjs', 'b.mjs'], ['b.mjs', 'a.mjs'])
  assert.equal(same.verdict, PLAN_SCOPE.same)
  assert.deepEqual([same.added, same.dropped], [[], []])
  assert.deepEqual([same.dispatched, same.planned], [2, 2])

  // A LEGAL directory prefix — crew/ alone is rejected by validateScopeEntries, so the
  // fixture uses a two-segment prefix.
  assert.deepEqual(validateScopeEntries(['crew/roles/']), [])
  const prefix = planScopeVerdict(['crew/roles/'], ['crew/roles/anchors.json'])
  assert.equal(prefix.verdict, PLAN_SCOPE.narrowed)
  assert.deepEqual(prefix.added, [])
  assert.deepEqual(prefix.dropped, ['crew/roles/'])

  const narrowed = planScopeVerdict(S843_DISPATCHED, S843_NARROWED)
  assert.equal(narrowed.verdict, PLAN_SCOPE.narrowed)
  assert.deepEqual(narrowed.dropped, [...S843_DROPPED])
  assert.deepEqual(narrowed.added, [])

  // Widening DOMINATES a simultaneous drop — b359 did both, and the refusal must name
  // the additions.
  const both = planScopeVerdict(S843_DISPATCHED, S843_D2)
  assert.equal(both.verdict, PLAN_SCOPE.widened)
  assert.deepEqual(both.added, [...S843_ADDED])
  assert.deepEqual(both.dropped, [...S843_DROPPED])

  // A non-array planned scope reads as [], never as a throw.
  const none = planScopeVerdict(['a.mjs'], undefined)
  assert.equal(none.verdict, PLAN_SCOPE.narrowed)
  assert.equal(none.planned, 0)
})

test('a narrowed plan is accepted and journals what it shed', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_NARROWED, true), 'tech-lead:1': checkEnv('approve'),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx({ roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'] }), io)
  assert.equal(result.status, 'done')
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.narrowed)
  assert.equal(rows[0].round, 1)
  assert.deepEqual([...rows[0].dropped].sort(), [...S843_DROPPED].sort())
  assert.deepEqual(rows[0].added, [])
  assert.deepEqual([rows[0].dispatched, rows[0].planned], [8, 6])
})

test('a matching plan is accepted and journals its identical scope', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_DISPATCHED, true), 'tech-lead:1': checkEnv('approve'),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx({ roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'] }), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'check:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass',
    'commit', 'document', 'suite', 'suite:cold', 'done',
  ])
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.same)
  assert.deepEqual([rows[0].added, rows[0].dropped], [[], []])
})

test('a lane with no dispatched scope is unchanged and says so', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: S843_RUNS, changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass',
    'commit', 'document', 'suite', 'suite:cold', 'done',
  ])
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.undispatched)
  assert.equal(rows[0].dispatched, null)
  assert.deepEqual([rows[0].added, rows[0].dropped], [[], []])
})

// MUTATIONS A9 and A10 — the extension is consulted only after the probe has proved file.
test('an extensionless regular file is refused and a dotted directory is not', () => {
  const cmd = 'node --test crew/runner test/fixtures.jsonl'
  const resolved = resolveValidationLane(cmd, () => new Map([
    ['crew/runner', 'file'], ['test/fixtures.jsonl', 'dir'],
  ]))
  assert.deepEqual(resolved.rows.map(({ input, verdict }) => ({ input, verdict })), [
    { input: 'crew/runner', verdict: 'unsupported-extension' },
    { input: 'test/fixtures.jsonl', verdict: 'loadable' },
  ])
})

// MUTATIONS A3, A5 and A7 — opaque lanes stay untouched, accepted lanes are byte-identical,
// and only the planner's lane is resolved.
test('an unparsed lane is accepted with no probe, an accepted lane runs byte-identically, and ctx.lane is never resolved', () => {
  const opaqueIo = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const opaqueResult = driveTask(CTX, opaqueIo)
  assert.equal(opaqueResult.status, 'done')
  assert.equal(opaqueIo.calls.assign.filter(({ role }) => role === 'planner').length, 1)
  assert.equal(opaqueIo.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(opaqueIo.calls.run.some(({ cmd }) => cmd.startsWith('for p in ')), false)

  const lane = 'node --test crew/drive.test.mjs'
  const acceptedIo = fakeIo({
    envelopes: { 'planner:1': validationPlan(lane), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { ...validationProbeRun(lane, { 'crew/drive.test.mjs': 'file' }), 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const acceptedResult = driveTask(CTX, acceptedIo)
  assert.equal(acceptedResult.status, 'done')
  assert.equal(acceptedIo.calls.run.some(({ cmd }) => cmd === lane), true)
  const acceptedPayload = validationRows(acceptedIo)[0]?.validation_lane_resolved
  assert.deepEqual(
    { shape: acceptedPayload?.shape, total: acceptedPayload?.total, refused: acceptedPayload?.refused },
    { shape: 'node-test', total: 1, refused: [] },
  )

  const details = { ...planEnv().details }
  delete details.validation_lane
  const ctxLane = 'node --test test/fixtures/cmux-events-input-sent.jsonl'
  const ctxIo = fakeIo({
    envelopes: { 'planner:1': planEnv({ details }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const ctxResult = driveTask({ ...CTX, lane: ctxLane }, ctxIo)
  assert.equal(ctxResult.status, 'done')
  assert.equal(ctxIo.calls.assign.filter(({ role }) => role === 'planner').length, 1)
  assert.equal(ctxIo.calls.run.some(({ cmd }) => cmd.startsWith('for p in ')), false)
  assert.equal(ctxIo.calls.run.some(({ cmd }) => cmd === ctxLane), true)
})

test('b376 B5f the witnessed run executes nested checks without filtering their parents', () => {
  const root = scratchDir('b376-witness-')
  const testFile = join(root, 'nested.test.mjs')
  const source = [
    "import { test } from 'node:test'",
    "const label = 'F1'",
    "test('outer', async (t) => { await t.test(`${label} guard`, { skip: true }, () => {}) })",
  ].join('\n') + '\n'
  try {
    writeFileSync(testFile, source)
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    const full = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { encoding: 'utf8', env: childEnv })
    const filtered = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=F1 guard', testFile], { encoding: 'utf8', env: childEnv })
    assert.equal(full.status, 0)
    assert.equal(nameVerdict(full.stdout, 'F1 guard'), 'skipped')
    assert.equal(nameVerdict(filtered.stdout, 'F1 guard'), 'absent')

    const io = b376ProofIo()
    driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    const witnessCalls = io.calls.run.filter(({ cmd }) => cmd === "node --test --test-reporter=tap 'a.test.mjs'")
    assert.equal(witnessCalls.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('b376 B7c only reviewer-origin ungateable survives a continuation panel', () => {
  const partnerFinding = { id: 'F2', severity: 'must-fix', location: 'a.mjs:1', summary: 'the partner guard', hardening: 'ungateable', hardening_why: 'the partner cannot waive this' }
  const reviewerFinding = { ...B376_FINDING, hardening: 'ungateable', hardening_why: 'reviewer cannot name a safe guard' }
  const f2 = { ...B376_HARDENED, finding: 'F2', name: 'F2 guard', find: 'const guard = false', replace: 'const guard = true' }
  const panel = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewerFinding]),
    partner1: dPartnerEnv('changes-needed', [B376_FINDING, partnerFinding]), adjudication1: dAdjEnv(),
    reviewer2: dReviewEnv('pass', []), partner2: dPartnerEnv('pass', []), adjudication2: dAdjEnv(),
    builder2: buildEnv({ details: { ...buildEnv().details, hardened: [f2] } }),
    files: B376_FILES, writeThrough: true,
  })
  const f2Outputs = [B376_GREEN, B376_PRE_RED, B376_MUT_RED].map((entry) => ({ ...entry, output: entry.output.replaceAll('F1 guard', 'F2 guard') }))
  const oldRun = panel.run
  panel.run = function (cmd) {
    const result = oldRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
    if (cmd === hardenCommand(B376_TEST_FILE, 'F2 guard')) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      return f2Outputs[count - 1] || f2Outputs.at(-1)
    }
    return result
  }
  const result = driveTask({ ...D_PANEL_CTX, limits: { build_rounds: 2 } }, panel)
  assert.equal(result.status, 'done')
  const rows = panel.calls.logs.filter((entry) => entry.finding_hardened).map((entry) => entry.finding_hardened)
  assert.equal(rows.some((row) => row.finding === 'F1' && row.outcome === 'ungateable'), true)
  assert.equal(rows.some((row) => row.finding === 'F2' && row.outcome === 'killed'), true)
})

test('#839 name verdicts classify recorded Node TAP outcomes', () => {
  const root = scratchDir('b376-name-verdict-')
  const testFile = join(root, 'name-verdict.test.mjs')
  const source = [
    "import { test } from 'node:test'",
    "test('passed', () => {})",
    "test('failed', () => { throw new Error('expected failure') })",
    "test('duplicate', () => {})",
    "test('duplicate', () => {})",
    "test('skipped', { skip: true }, () => {})",
    "test('todo', { todo: true }, () => {})",
    "test('outer', async (t) => {",
    "  await t.test('nested passed', () => {})",
    "  await t.test('nested failed', () => { throw new Error('expected failure') })",
    '})',
  ].join('\n')
  try {
    writeFileSync(testFile, `${source}\n`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const recorded = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { encoding: 'utf8', env })
    const noMatch = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=no-such-check', testFile], { encoding: 'utf8', env })
    assert.equal(recorded.status, 1)
    assert.equal(noMatch.status, 0)
    assert.deepEqual(NAME_VERDICTS, ['passed', 'failed', 'skipped', 'absent', 'ambiguous'])
    assert.equal(nameVerdict(recorded.stdout, 'passed'), 'passed')
    assert.equal(nameVerdict(recorded.stdout, 'failed'), 'failed')
    assert.equal(nameVerdict(recorded.stdout, 'duplicate'), 'ambiguous')
    assert.equal(nameVerdict(recorded.stdout, 'skipped'), 'skipped')
    assert.equal(nameVerdict(recorded.stdout, 'todo'), 'skipped')
    assert.equal(nameVerdict(recorded.stdout, 'nested passed'), 'passed')
    assert.equal(nameVerdict(recorded.stdout, 'nested failed'), 'failed')
    assert.equal(nameVerdict(noMatch.stdout, 'passed'), 'absent')
    assert.equal(nameVerdict(recorded.stdout, 'not present'), 'absent')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('turn-census observation uses outcome-qualified composite keys and never fabricates a breach', () => {
  const json = (dispatch_id, role, turns, outcome = 'ok', absent_reason = null) => ({
    headless_outcome: outcome,
    seat_turn_census: { dispatch_id, role, transport: 'headless-json', turns, absent_reason },
  })
  const rpc = (dispatch_id, role, outcome) => [
    { rpc_outcome: outcome, id: dispatch_id, role },
    { seat_turn_census: { dispatch_id, role, transport: 'headless-rpc', turns: 12, absent_reason: null } },
  ]
  assert.deepEqual(observeTurnCensus([], 'd1', 'planner'), { turns: null, absent: CENSUS_ROW_ABSENT, adjudicate: true })
  assert.deepEqual(observeTurnCensus([json('d1', 'planner', 12)], 'd1', 'planner'), { turns: 12, absent: null, adjudicate: true })
  assert.equal(observeTurnCensus([json('d1', 'planner', 12, 'ok-degraded')], 'd1', 'planner').turns, 12)
  assert.equal(observeTurnCensus([json('d1', 'planner', 99, 'budget-refused')], 'd1', 'planner').absent, CENSUS_ROW_ABSENT)
  assert.equal(observeTurnCensus([{ seat_turn_census: { dispatch_id: 'd1', role: 'planner', transport: 'headless-json', turns: 99 } }], 'd1', 'planner').absent, CENSUS_ROW_ABSENT)
  assert.deepEqual(observeTurnCensus(rpc('d1', 'planner', 'no-envelope'), 'd1', 'planner'), { turns: null, absent: null, adjudicate: false })
  assert.equal(observeTurnCensus([json('d2', 'planner', 8), json('d1', 'reviewer', 77)], 'd1', 'planner').absent, CENSUS_ROW_ABSENT)
  assert.equal(observeTurnCensus([json('d1', 'reviewer', 77)], 'd1', 'reviewer').turns, 77)
  assert.equal(observeTurnCensus([{ rpc_outcome: 'ok', id: 'd1', role: 'reviewer' }, ...rpc('d1', 'planner', 'ok')], 'd1', 'planner').turns, 12)
  assert.equal(observeTurnCensus([json('d1', 'planner', '12')], 'd1', 'planner').absent, CENSUS_TURNS_ABSENT)
  assert.equal(observeTurnCensus([json('d1', 'planner', 0, 'ok', 'producer prose')], 'd1', 'planner').turns, 0)
  assert.equal(observeTurnCensus([json('d1', 'planner', null, 'ok', 'the stream exists but carries no parsable frame')], 'd1', 'planner').absent, CENSUS_TURNS_ABSENT)
  assert.equal(observeTurnCensus([json('d1', 'planner', null, 'ok', 42)], 'd1', 'planner').absent, CENSUS_TURNS_ABSENT)
  assert.equal(observeTurnCensus([{ ...json('d1', 'planner', 88, 'budget-refused') }, { rpc_outcome: 'ok', id: 'd1', role: 'planner' }], 'd1', 'planner').absent, CENSUS_ROW_ABSENT)
  assert.equal(observeTurnCensus([...rpc('d1', 'planner', 'budget-refused'), { rpc_outcome: 'ok', id: 'd1', role: 'planner' }], 'd1', 'planner').absent, CENSUS_ROW_ABSENT)
  for (const [turns, budget, expected] of [[12, 10, true], [10, 10, false], [9, 10, false], [null, 10, false], [0, 10, false], [12, null, false], ['12', 10, false]]) {
    assert.equal(turnCeilingBreached(turns, budget), expected, `${JSON.stringify([turns, budget])}`)
  }
  assert.ok(CENSUS_ABSENT_REASONS.includes(CENSUS_TURNS_ABSENT))
  assert.ok(CENSUS_ABSENT_REASONS.includes(CENSUS_ROW_ABSENT))
  assert.ok(CENSUS_ABSENT_REASONS.includes(CENSUS_UNREADABLE))
})

test('b433 driver carries policy before acceptance and fences only the accepted builder', () => {
  const preAcceptance = planCheckAcceptIo()
  const result = driveTask(CTX_TL, preAcceptance)
  assert.equal(result.status, 'done')
  const planner = preAcceptance.calls.assign.find((entry) => entry.role === 'planner')
  const techLead = preAcceptance.calls.assign.find((entry) => entry.role === 'tech-lead')
  const builder = preAcceptance.calls.assign.find((entry) => entry.role === 'builder')
  const reviewer = preAcceptance.calls.assign.find((entry) => entry.role === 'reviewer')
  assert.deepEqual(planner.policy, { suiteCommand: CTX_TL.suite, gatePath: `${TD}/gate.mjs`, fence: [] })
  assert.deepEqual(techLead.policy, { suiteCommand: CTX_TL.suite, gatePath: `${TD}/gate.mjs`, fence: [] })
  assert.deepEqual(builder.policy, { suiteCommand: CTX_TL.suite, gatePath: `${TD}/gate.mjs`, fence: ['a.mjs', 'a.test.mjs'] })
  assert.deepEqual(reviewer.policy, { suiteCommand: CTX_TL.suite, gatePath: `${TD}/gate.mjs`, fence: [] })
})

const DIFF_REPORT_REASON = 'mutants beyond the configured cap are omitted because each mutant runs both the accepted validation lane and gate and large diffs otherwise multiply suite cost; omitted mutants are a blind spot'
const diffReport = (mutants = [], over = {}) => ({
  generation: 1, cap: 8, configured_cap: 8, cap_omitted: 0,
  total_candidates: mutants.length, generated: mutants.length,
  killed: mutants.filter((row) => row.outcome === 'killed').length,
  survived: mutants.filter((row) => row.outcome === 'survived').length,
  skipped: mutants.filter((row) => row.outcome === 'skipped').length,
  omitted: 0, omitted_reason: DIFF_REPORT_REASON, blind_spot: null, skip_counts: {}, mutants, ...over,
})
const diffSurvivor = { id: 'diff-survivor-1', path: 'a.mjs', line: 1, operator: 'literal', replacement: 'const value = false', validation_lane: 'lane-cmd', gate_cmd: 'gate-cmd', outcome: 'survived' }

function diffDriverIo({ report = diffReport([diffSurvivor]), mutations = [], review = reviewEnv('pass'), target = 'const value = true\n', capEnv = undefined, reportFile = undefined, runnerStatus = 0, runnerStderr = '' } = {}) {
  const plan = planEnv({ details: {
    ...planEnv().details, files_in_scope: ['a.mjs'], gate_cmd: 'gate-cmd', validation_lane: 'lane-cmd', mutations,
  } })
  const envelopes = { 'planner:1': plan, 'builder:1': buildEnv(), 'reviewer:1': review }
  // The declared mutations name implemented checks, so the red baseline inventories
  // them: a complete baseline missing a declared check reads as a phantom refusal.
  const declaredFails = mutations.filter((entry) => entry && typeof entry.check === 'string').map((entry) => `FAIL ${entry.check}: caught`)
  const baselineOutput = declaredFails.length === 0
    ? 'FAIL baseline\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}'
    : `${declaredFails.join('\n')}\nGATE-SUMMARY {"total":${declaredFails.length},"failed":${declaredFails.length},"errored":0}`
  const runs = {
    'gate-cmd:1': { ok: false, output: baselineOutput },
    'gate-cmd:2': { ok: true, output: 'green\nGATE-SUMMARY {"total":1,"failed":0,"errored":0}' },
    'gate-cmd:3': { ok: false, output: 'FAIL declared: caught\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}' },
    'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
  }
  const files = { [`${CTX.checkout}/a.mjs`]: target }
  if (reportFile !== undefined) files[`${TD}/diff-mutation-1.report.json`] = typeof reportFile === 'string' ? reportFile : JSON.stringify(reportFile)
  const runnerEntry = { ok: runnerStatus === 0, output: '', status: runnerStatus, stderr: runnerStderr }
  if (report !== null) runnerEntry.output = `DIFF-MUTATION-SUMMARY ${JSON.stringify(report)}`
  const options = {
    envelopes, runs, cleanRuns: { 'gate-cmd': { ok: false, output: baselineOutput },
    }, files, writeThrough: true,
    diffListing: 'a.mjs\0', changed: Array.from({ length: 12 }, () => ['a.mjs']),
    diffReports: [runnerEntry],
  }
  return fakeIo({ ...options, ...(capEnv === undefined ? {} : { env: { CREW_DIFF_MUTATION_CAP: capEnv } }) })
}

function legacyDiffRows(io) {
  const keys = ['gate_discrimination', 'mutation_anchor_bind', 'mutation_anchor_absent', 'gate_check_discrimination']
  return io.calls.logs.filter((row) => keys.some((key) => Object.hasOwn(row, key))).map((row) => {
    const key = keys.find((candidate) => Object.hasOwn(row, candidate))
    return { [key]: row[key] }
  })
}

test('B1 green mutant is a typed survivor in the reviewer brief', () => {
  const io = diffDriverIo({ report: diffReport([diffSurvivor]) })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  const brief = io.calls.writes[`${TD}/review-brief-1.md`]
  const findings = JSON.parse(brief.split('## Diff-mutant findings\n')[1].trim())
  assert.deepEqual(findings, [{ id: diffSurvivor.id, path: diffSurvivor.path, line: diffSurvivor.line, operator: diffSurvivor.operator, replacement: diffSurvivor.replacement, validation_lane: 'lane-cmd', gate_cmd: 'gate-cmd' }])
})

test('RV1-4 reviewer brief discloses timeout kills beside empty findings', () => {
  const timeout = { id: 'timed-out', path: 'a.mjs', line: 1, operator: 'literal', replacement: 'false', outcome: 'killed', kill_reason: 'timeout' }
  const io = diffDriverIo({ report: diffReport([timeout], { timeout_killed: 1 }) })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const brief = io.calls.writes[`${TD}/review-brief-1.md`]
  assert.match(brief, /## Diff-mutant findings\n\[\]\nTimeout kills: 1 of 1 kills were per-run timeouts \(120s\), not red runs; a timeout kill does not prove the gate discriminates\./)
})

test('RV2-3 timeout kills are counted over the forwarded mutants, not the latest round tally', () => {
  // The merged brief report takes tallies from the latest round only; an earlier round's
  // timeout kill reaches the brief as a mutant whose round tally is no longer present.
  const timeout = { id: 'timed-out', path: 'a.mjs', line: 1, operator: 'literal', replacement: 'false', outcome: 'killed', kill_reason: 'timeout' }
  const red = { id: 'red', path: 'a.mjs', line: 2, operator: 'literal', replacement: 'true', outcome: 'killed' }
  const io = diffDriverIo({ report: diffReport([timeout, red], { timeout_killed: 0 }) })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const brief = io.calls.writes[`${TD}/review-brief-1.md`]
  assert.match(brief, /Timeout kills: 1 of 2 kills were per-run timeouts/)
})

test('D1 diff proof leaves declared-anchor proof bytes unchanged', () => {
  const mutation = { check: 'declared', file: 'a.mjs', find: 'true', replace: 'false' }
  const noDiff = diffDriverIo({ mutations: [mutation], report: diffReport([]) })
  const populated = diffDriverIo({ mutations: [mutation], report: diffReport([diffSurvivor]) })
  const first = driveTask(CTX, noDiff)
  const second = driveTask(CTX, populated)
  assert.equal(first.status, 'done')
  assert.equal(second.status, 'done')
  assert.deepEqual(legacyDiffRows(noDiff), legacyDiffRows(populated))
})

test('E1 diff proof journals generated killed survived and skipped reasons', () => {
  const mixed = diffReport([
    { id: 'killed', path: 'a.mjs', line: 1, operator: 'literal', outcome: 'killed' },
    diffSurvivor,
    { id: 'skipped', path: 'a.mjs', line: 2, operator: null, outcome: 'skipped', skip_reason: 'comment-or-blank' },
  ], { total_candidates: 3, generated: 2, killed: 1, survived: 1, skipped: 1, skip_counts: { 'comment-or-blank': 1 }, omitted: 2, cap_omitted: 2, blind_spot: DIFF_REPORT_REASON })
  const io = diffDriverIo({ report: mixed })
  const result = driveTask(CTX, io)
  const row = io.calls.logs.find((entry) => entry.diff_mutation_proof)?.diff_mutation_proof
  assert.equal(result.status, 'done')
  for (const key of ['generation', 'cap', 'configured_cap', 'cap_omitted', 'total_candidates', 'generated', 'killed', 'survived', 'skipped', 'omitted']) assert.equal(Number.isInteger(row[key]), true)
  assert.deepEqual(row.skip_counts, { 'comment-or-blank': 1 })
  assert.equal(row.mutants.length, 3)
  assert.match(row.blind_spot, /each mutant runs both the accepted validation lane and gate/)

  const zeroIo = diffDriverIo({ report: diffReport([]) })
  driveTask(CTX, zeroIo)
  const zero = zeroIo.calls.logs.find((entry) => entry.diff_mutation_proof)?.diff_mutation_proof
  assert.equal(zero.generated, 0)
  assert.equal(zero.killed, 0)
  assert.equal(zero.survived, 0)
  assert.equal(zero.skipped, 0)

  const unavailableIo = diffDriverIo({ report: null })
  driveTask(CTX, unavailableIo)
  const unavailable = unavailableIo.calls.logs.find((entry) => entry.diff_mutation_proof)?.diff_mutation_proof
  assert.equal(unavailable.skipped, 1)
  assert.equal(unavailable.skip_counts['runner-unavailable'], 1)
})

test('G1 equivalent reviewer verdict journals judgment without a kill', () => {
  const review = reviewEnv('pass')
  review.details.diff_mutant_judgments = [
    { id: diffSurvivor.id, verdict: 'equivalent', reason: 'the change is intentionally redundant' },
    { id: 'unknown', verdict: 'equivalent', reason: 'not a known mutant' },
    { id: diffSurvivor.id, verdict: 'equivalent', reason: 'duplicate' },
  ]
  const io = diffDriverIo({ review })
  const result = driveTask(CTX, io)
  const rows = io.calls.logs.filter((entry) => entry.kind === 'JUDGMENT').map((entry) => entry.diff_mutant_judgment)
  const proof = io.calls.logs.find((entry) => entry.diff_mutation_proof).diff_mutation_proof
  assert.equal(result.status, 'done')
  assert.equal(proof.killed, 0)
  assert.equal(rows[0].outcome, 'judgment')
  assert.equal(rows[0].verdict, 'equivalent')
  assert.equal(rows[1].outcome, 'rejected')
  assert.equal(rows[2].outcome, 'rejected')
})

test('H1 survivor proceeds to review without automatic escalation', () => {
  const io = diffDriverIo({ report: diffReport([diffSurvivor]) })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
})

const D3_SCOPE_DISPATCHED = Object.freeze(['crew/drive-fixtures.mjs'])
const D3_SCOPE_HEALTH = 'git rev-parse --is-inside-work-tree'
const d3ScopeInventory = (path) => `git ls-files --error-unmatch -- '${path}'`
const d3ScopeCtx = (dispatched = D3_SCOPE_DISPATCHED, over = {}) => s843Ctx({
  ...over, files_in_scope: [...dispatched],
})
const d3ScopeIo = (dispatched, planned, runs = {}, changed = [dispatched[0]], needsAdversary = false) => fakeIo({
  envelopes: {
    'planner:1': s843PlanEnv(planned, needsAdversary),
    'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  },
  runs: { ...S843_RUNS, ...runs }, changed,
})

test('A1 near miss has its own refusal', () => {
  const bad = 'crew/drive-fixtures.mennials'
  const io = d3ScopeIo(D3_SCOPE_DISPATCHED, [bad], {
    [D3_SCOPE_HEALTH]: { ok: true, output: '' },
    [d3ScopeInventory(bad)]: { ok: false, output: '' },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, PLAN_SCOPE.malformed)
  assert.ok(result.details.escalation.why.includes(bad))
  assert.equal(s843Rows(io).length, 0)
})

test('B1 malformed refusal names its correction', () => {
  const bad = 'crew/drive-fixtures.mennials'
  const candidate = 'crew/drive-fixtures.mjs'
  const dispatched = [candidate, candidate, 'crew/']
  const suggestions = scopeSuggestions([bad, bad], dispatched)
  assert.equal(suggestions.size, 1)
  assert.equal(suggestions.get(bad), candidate)
  const tie = scopeSuggestions(['crew/drive-fixture.mjs'], [
    'crew/drive-fixtures.mjs', 'crew/drive-fixturex.mjs', 'crew/roles/',
  ])
  assert.equal(tie.size, 0)
  const verdict = planScopeVerdict([candidate], [bad], new Set())
  assert.match(planScopeWhy(verdict, true), /did you mean crew\/drive-fixtures\.mjs, which is in your surface\?/)
})

test('C1 untracked non near miss is malformed by name', () => {
  const bad = 'outside-scope-file.mjs'
  const inventory = d3ScopeInventory(bad)
  const cases = [
    { name: 'unmatched', runs: { [D3_SCOPE_HEALTH]: { ok: true, output: '' }, [inventory]: { ok: false, output: '' } } },
    { name: 'failed health', runs: { [D3_SCOPE_HEALTH]: { ok: false, output: '' } } },
    { name: 'throwing health', runs: {}, throwAt: D3_SCOPE_HEALTH },
    { name: 'throwing inventory', runs: { [D3_SCOPE_HEALTH]: { ok: true, output: '' } }, throwAt: inventory },
  ]
  for (const scenario of cases) {
    const io = d3ScopeIo(D3_SCOPE_DISPATCHED, [bad], scenario.runs)
    if (scenario.throwAt) {
      const run = io.run.bind(io)
      io.run = (cmd) => {
        if (cmd === scenario.throwAt) throw new Error(`${scenario.name} probe`)
        return run(cmd)
      }
    }
    const result = driveTask(d3ScopeCtx(), io)
    assert.equal(result.status, 'escalation', scenario.name)
    assert.equal(result.details.escalation.where, scenario.name === 'unmatched' ? PLAN_SCOPE.malformed : 'plan', scenario.name)
    assert.ok(result.details.escalation.why.includes(bad), scenario.name)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0, scenario.name)
    assert.equal(s843Rows(io).length, 0, scenario.name)
  }

  const nonFinalIo = d3ScopeIo(D3_SCOPE_DISPATCHED, [bad])
  nonFinalIo.reseat = (role, options) => {
    nonFinalIo.calls.reseat.push({ role, options })
    return { applied: true, from: { id: 'planner' }, to: { id: 'judge' }, rung: 'mechanical→judge' }
  }
  const run = nonFinalIo.run.bind(nonFinalIo)
  nonFinalIo.run = (cmd) => {
    if (cmd === D3_SCOPE_HEALTH) throw new Error('non-final health probe')
    return run(cmd)
  }
  const nonFinal = driveTask(d3ScopeCtx(D3_SCOPE_DISPATCHED, {
    limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 },
  }), nonFinalIo)
  assert.equal(nonFinal.status, 'escalation')
  assert.equal(nonFinal.details.escalation.where, 'plan')
  assert.ok(nonFinal.details.escalation.why.includes(bad))
  assert.equal(nonFinalIo.calls.assign.filter(({ role }) => role === 'planner').length, 1)
  assert.equal(Object.hasOwn(nonFinalIo.calls.writes, `${TD}/plan-bounce-r1.md`), false)
  assert.equal(nonFinalIo.calls.reseat.length, 0)
  assert.equal(nonFinalIo.calls.logs.some((row) => row.modifier?.kind === 'plan' && row.modifier?.role === 'planner'), false)
})

test('D1 tracked widening is recorded context', () => {
  const tracked = 'crew/drive-review.test.mjs'
  const runs = {
    [D3_SCOPE_HEALTH]: { ok: true, output: '' },
    [d3ScopeInventory(tracked)]: { ok: true, output: '' },
  }
  const io = d3ScopeIo(D3_SCOPE_DISPATCHED, [...D3_SCOPE_DISPATCHED, tracked], runs)
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.escalation, null)
  assert.deepEqual(s843Rows(io)[0], {
    round: 1, verdict: PLAN_SCOPE.widened, added: [tracked], dropped: [], dispatched: 1, planned: 2,
    malformed: [], suggestions: new Map(), effective: [...D3_SCOPE_DISPATCHED, tracked],
  })
  assert.equal(io.calls.run.some(({ cmd }) => cmd === D3_SCOPE_HEALTH), true)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === d3ScopeInventory(tracked)), true)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)

  const prefix = 'crew/new-surface/'
  const prefixIo = d3ScopeIo(D3_SCOPE_DISPATCHED, [...D3_SCOPE_DISPATCHED, prefix])
  const prefixResult = driveTask(d3ScopeCtx(), prefixIo)
  assert.equal(prefixResult.status, 'done')
  assert.equal(s843Rows(prefixIo)[0].verdict, PLAN_SCOPE.widened)
  assert.equal(prefixIo.calls.run.some(({ cmd }) => cmd === D3_SCOPE_HEALTH || cmd.startsWith('git ls-files --error-unmatch --')), false)
})

test('E1a malformed scope never reaches adversary trigger inputs', () => {
  const seatedRoles = ['lead', 'planner', 'tech-lead', 'builder', 'reviewer']
  const controlIo = d3ScopeIo(D3_SCOPE_DISPATCHED, [...D3_SCOPE_DISPATCHED])
  const control = driveTask(d3ScopeCtx(D3_SCOPE_DISPATCHED, { roles: seatedRoles }), controlIo)
  assert.equal(control.status, 'done')
  assert.equal(controlIo.calls.assign.filter(({ role }) => role === 'tech-lead').length, 0)

  const protectedIo = s843Io({
    'planner:1': s843PlanEnv(['crew/drive.mjs'], false),
    'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  }, ['crew/drive.mjs'])
  const protectedResult = driveTask(s843Ctx({ files_in_scope: ['crew/drive.mjs'], roles: seatedRoles }), protectedIo)
  assert.equal(protectedResult.status, 'done')
  assert.equal(protectedIo.calls.assign.filter(({ role }) => role === 'tech-lead').length, 1)

  const malformedIo = d3ScopeIo(D3_SCOPE_DISPATCHED, [null], {}, [D3_SCOPE_DISPATCHED[0]], true)
  const malformed = driveTask(d3ScopeCtx(D3_SCOPE_DISPATCHED, { roles: seatedRoles }), malformedIo)
  assert.equal(malformed.status, 'escalation')
  assert.equal(malformed.details.escalation.where, 'plan')
  assert.equal(malformedIo.calls.assign.filter(({ role }) => role === 'tech-lead').length, 0)
  assert.equal(s843Rows(malformedIo).length, 0)
})

test('E1b malformed scope never reaches scope comparison inputs', () => {
  const validIo = d3ScopeIo(D3_SCOPE_DISPATCHED, [...D3_SCOPE_DISPATCHED])
  const valid = driveTask(d3ScopeCtx(), validIo)
  assert.equal(valid.status, 'done')
  assert.equal(s843Rows(validIo)[0].verdict, PLAN_SCOPE.same)

  for (const files of [[null], [D3_SCOPE_DISPATCHED[0], 42], [], 'not-an-array', [D3_SCOPE_DISPATCHED[0], '']]) {
    const io = d3ScopeIo(D3_SCOPE_DISPATCHED, files)
    const result = driveTask(d3ScopeCtx(), io)
    assert.equal(result.status, 'escalation', JSON.stringify(files))
    assert.equal(result.details.escalation.where, 'plan', JSON.stringify(files))
    assert.match(result.details.escalation.why, /files_in_scope/, JSON.stringify(files))
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0, JSON.stringify(files))
    assert.equal(s843Rows(io).length, 0, JSON.stringify(files))
  }
})

test('F1 final round malformed scope carries recovery', () => {
  const bad = 'crew/drive-fixtures.mennials'
  const candidate = 'crew/drive-fixtures.mjs'
  const io = d3ScopeIo(D3_SCOPE_DISPATCHED, [bad], {
    [D3_SCOPE_HEALTH]: { ok: true, output: '' },
    [d3ScopeInventory(bad)]: { ok: false, output: '' },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, PLAN_SCOPE.malformed)
  assert.ok(result.details.escalation.why.includes(bad))
  assert.ok(result.details.escalation.why.includes(`did you mean ${candidate}, which is in your surface?`))
  assert.equal(s843Rows(io).length, 0)
})

test('G1 legal exact and narrow scope stays byte identical', () => {
  const dispatched = ['crew/drive-fixtures.mjs', 'crew/drive-review.test.mjs']
  const narrowed = ['crew/drive-fixtures.mjs']
  assert.deepEqual(planScopeVerdict(dispatched, dispatched), {
    verdict: PLAN_SCOPE.same, added: [], dropped: [], dispatched: 2, planned: 2,
  })
  assert.deepEqual(planScopeVerdict(dispatched, narrowed), {
    verdict: PLAN_SCOPE.narrowed, added: [], dropped: ['crew/drive-review.test.mjs'], dispatched: 2, planned: 1,
  })

  const exactIo = d3ScopeIo(dispatched, dispatched, {}, [dispatched[0]])
  const narrowIo = d3ScopeIo(dispatched, narrowed, {}, [dispatched[0]])
  const exact = driveTask(d3ScopeCtx(dispatched), exactIo)
  const narrow = driveTask(d3ScopeCtx(dispatched), narrowIo)
  const legalStages = ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'document', 'suite', 'suite:cold', 'done']
  assert.equal(exact.status, 'done')
  assert.equal(narrow.status, 'done')
  assert.deepEqual(exact.details.stages, legalStages)
  assert.deepEqual(narrow.details.stages, legalStages)
  assert.equal(s843Rows(exactIo)[0].verdict, PLAN_SCOPE.same)
  assert.equal(s843Rows(narrowIo)[0].verdict, PLAN_SCOPE.narrowed)
  for (const io of [exactIo, narrowIo]) {
    assert.equal(io.calls.run.some(({ cmd }) => cmd === D3_SCOPE_HEALTH || cmd.startsWith('git ls-files --error-unmatch --')), false)
  }
})

test('H1 correction is suggested and never substituted', () => {
  const bad = 'crew/drive-fixtures.mennials'
  const candidate = 'crew/drive-fixtures.mjs'
  const asked = Object.freeze([bad])
  const before = [...asked]
  const verdict = planScopeVerdict([candidate], asked, new Set())
  assert.equal(verdict.verdict, PLAN_SCOPE.malformed)
  assert.deepEqual(verdict.effective, before)
  assert.deepEqual(asked, before)
  assert.equal(verdict.effective.includes(candidate), false)
  assert.equal(verdict.suggestions.get(bad), candidate)
})

test('b595 A1', () => {
  const finding = { id: 'B595-A1-open', severity: 'must-fix', location: 'a.mjs:1', summary: 'open contradiction' }
  const refusal = verdictFindingsDefect({ verdict: 'pass', must_fix: 1, findings: [finding] })
  assert.equal(refusal?.reason, 'verdict-findings')
  assert.match(refusal?.why || '', /B595-A1-open/)
})

test('b595 B1', () => {
  const finding = { id: 'B595-B1-open', severity: 'must-fix', location: 'a.mjs:1', summary: 'open contradiction' }
  const io = fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', [finding]), 'lead:1': leadEnv('bounce'),
      'reviewer:2': dReviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
  assert.match(dDecisionBrief(io), /verdict-findings/)
  assert.match(dDecisionBrief(io), /B595-B1-open/)
  assert.equal(result.details.escalation, null)
})

test('b595 C1', () => {
  assert.deepEqual([...VACUITY_CLAIMS], ['mutation-survived', 'source-text-only'])
  for (const claim of VACUITY_CLAIMS) {
    const severity = vacuityFindingDefect({ findings: [{ id: `B595-C1-${claim}`, severity: 'consider', disposition: 'no-op', vacuity_claim: claim }] })
    assert.equal(severity?.reason, 'vacuity-classification')
    assert.match(severity?.why || '', new RegExp(`${claim}.*must-fix`))
    const noOp = vacuityFindingDefect({ findings: [{ id: `B595-C1-no-op-${claim}`, severity: 'must-fix', disposition: 'no-op', vacuity_claim: claim }] })
    assert.equal(noOp?.reason, 'vacuity-classification')
    assert.match(noOp?.why || '', new RegExp(`${claim}.*no-op`))
  }
  const unknown = reviewShapeDefect({ verdict: 'changes-needed', findings: [{ id: 'B595-C1-unknown', severity: 'must-fix', disposition: 'auto-fix', vacuity_claim: 'invented-claim' }] })
  assert.equal(unknown?.reason, 'vacuity-classification')
  assert.match(unknown?.why || '', /B595-C1-unknown/)
  assert.match(unknown?.why || '', /invented-claim/)
  const combined = { id: '../../escape', severity: 'consider', disposition: 'no-op', vacuity_claim: 'source-text-only' }
  const combinedRefusal = reviewShapeDefect({ verdict: 'changes-needed', findings: [combined] })
  assert.equal(combinedRefusal?.reason, 'finding-id')
  assert.notEqual(combinedRefusal?.reason, 'vacuity-classification')
})

test('A1 seat refuses incompatible vacuity routing', () => {
  const finding = {
    id: 'B605-A1-no-op-claim', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'a no-op cannot carry vacuity evidence', disposition: 'no-op', vacuity_claim: 'mutation-survived',
  }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [finding]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('bounce'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const firstLead = io.calls.assign.findIndex(({ role }) => role === 'lead')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'vacuity-classification'), true)
  assert.equal(io.calls.assign.slice(0, firstLead).some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
})

test('B1 legal one-sided vacuity panel completes', () => {
  const reviewer = {
    id: 'B605-B1-reviewer', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'reviewer records no actionable vacuity', disposition: 'no-op',
  }
  const partner = {
    id: 'B605-B1-partner', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'partner records survived behavior', disposition: 'ask-user', vacuity_claim: 'mutation-survived',
  }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewer]),
    partner1: dPartnerEnv('changes-needed', [partner]),
    adjudication1: dAdjEnv({ adjudications: [
      { id: reviewer.id, disposition: 'uphold', reason: 'retain reviewer evidence' },
      { id: partner.id, disposition: 'uphold', reason: 'retain partner evidence' },
    ] }),
  })
  driveTask(D_PANEL_CTX, io)
  const outcome = dPanelOutcomes(io)[0]
  assert.ok(outcome)
  assert.equal(outcome.panel, true)
  assert.equal(io.calls.logs.some((row) => row.panel_refused), false)
  assert.equal(outcome.findings.length, 2)
})

test('C1 illegal single envelope remains refused', () => {
  const finding = {
    id: 'B605-C1-unknown', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'an unknown vacuity class is not admissible', disposition: 'ask-user', vacuity_claim: 'invented-claim',
  }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [finding]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('bounce'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const firstLead = io.calls.assign.findIndex(({ role }) => role === 'lead')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'vacuity-classification'), true)
  assert.equal(io.calls.assign.slice(0, firstLead).some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
})

test('D1 vacuity cannot reach pass as nonblocking', () => {
  const finding = {
    id: 'B605-D1-consider-claim', severity: 'consider', location: 'a.mjs:1',
    summary: 'a nonblocking claim must not pass', disposition: 'ask-user', vacuity_claim: 'source-text-only',
  }
  const io = dispositionIo(finding, { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), true)
  assert.equal(result.details.accepted_via ?? null, null)
  assert.equal(io.calls.commits.length, 0)
})

test('E1 conflicting vacuity arm remains discriminating', () => {
  const reviewer = {
    id: 'B605-E1-conflict', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'the vacuity claim needs agreement', disposition: 'auto-fix', patch: D_PATCH_A, vacuity_claim: 'mutation-survived',
  }
  const partner = { ...reviewer, vacuity_claim: 'source-text-only' }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewer]),
    partner1: dPartnerEnv('changes-needed', [partner]),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-adjudication'), true)
  assert.equal(io.calls.logs.some((row) => row.panel_refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.review_outcome?.panel), false)
})

test('F1 finding-id refusal retains precedence', () => {
  const refusal = reviewShapeDefect({
    verdict: 'changes-needed',
    findings: [{
      id: '../../escape', severity: 'consider', disposition: 'no-op', vacuity_claim: 'source-text-only',
    }],
  })
  assert.equal(refusal?.reason, 'finding-id')
})

test('G1 fusion preserves each origin disposition', () => {
  const reviewer = {
    id: 'B605-G1-reviewer', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'reviewer records no actionable vacuity', disposition: 'no-op',
  }
  const partner = {
    id: 'B605-G1-partner', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'partner records survived behavior', disposition: 'ask-user', vacuity_claim: 'mutation-survived',
  }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewer]),
    partner1: dPartnerEnv('changes-needed', [partner]),
    adjudication1: dAdjEnv({ adjudications: [
      { id: reviewer.id, disposition: 'uphold', reason: 'retain reviewer evidence' },
      { id: partner.id, disposition: 'uphold', reason: 'retain partner evidence' },
    ] }),
  })
  driveTask(D_PANEL_CTX, io)
  const outcome = dPanelOutcomes(io)[0]
  assert.ok(outcome)
  const byOrigin = new Map(outcome.findings.map((finding) => [finding.reviewer, finding]))
  assert.equal(byOrigin.get('reviewer')?.disposition, 'no-op')
  assert.equal(byOrigin.get('tech-lead')?.disposition, 'ask-user')
  assert.equal(byOrigin.get('tech-lead')?.vacuity_claim, 'mutation-survived')
  assert.equal(outcome.findings.some((finding) => Object.hasOwn(finding, 'originId')), false)
})

test('b595 D1', () => {
  const finding = { id: 'B595-D1-observation', severity: 'consider', location: 'a.mjs:1', summary: 'harmless observation', disposition: 'no-op' }
  assert.deepEqual(dispositionPlan({ findings: [finding] }), { autoFix: [], askUser: [], needsSeat: [] })
  const io = fakeIo({
    envelopes: { 'planner:1': dPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': dReviewEnv('pass', [finding]) },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(io.calls.assign.some(({ role }) => role === 'lead'), false)
})

test('b595 E1', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': dPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.accept_findings ?? null, null)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
})

test('b595 F1', () => {
  const findings = Array.from({ length: 7 }, (_, index) => ({
    id: `B590-${index + 1}`,
    severity: index === 0 ? 'must-fix' : 'consider',
    location: `a.mjs:${index + 1}`,
    summary: `b590 observation ${index + 1}`,
    disposition: 'no-op',
  }))
  const partnerFindings = findings.map((finding, index) => index === 0
    ? { ...finding, disposition: 'ask-user', vacuity_claim: 'source-text-only' }
    : { ...finding })
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('changes-needed', findings), 'tech-lead:2': dPartnerEnv('changes-needed', partnerFindings),
      'lead:1': dAdjEnv(), 'lead:2': leadEnv('escalate'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  assert.notEqual(result.details.accept_findings ?? null, null)
  assert.equal(io.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), false)
  assert.equal(io.calls.logs.some((row) => row.review_outcome?.panel), true)
  assert.equal(io.calls.logs.some((row) => row.panel_refused), false)
  assert.equal(io.calls.logs.some((row) => row.panel_degraded === 'tech-lead'), false)

  const conflictReviewer = {
    id: 'B595-H1-conflict', severity: 'must-fix', location: 'a.mjs:1',
    summary: 'the same vacuity claim needs agreement', vacuity_claim: 'mutation-survived',
  }
  const conflictPartner = { ...conflictReviewer, vacuity_claim: 'source-text-only' }
  const conflictIo = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('changes-needed', [conflictReviewer]),
      'tech-lead:2': dPartnerEnv('changes-needed', [conflictPartner]), 'lead:1': dAdjEnv(),
      'lead:2': leadEnv('bounce'), 'reviewer:2': dReviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const conflictResult = driveTask(D_PANEL_CTX, conflictIo)
  assert.equal(conflictResult.status, 'done')
  assert.equal(conflictIo.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
  assert.equal(conflictResult.details.accept_findings ?? null, null)
  assert.equal(conflictIo.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), true)
  assert.equal(conflictIo.calls.logs.some((row) => row.review_outcome?.panel), false)
  assert.equal(conflictIo.calls.logs.some((row) => row.panel_refused === 'vacuity-classification'), true)
})

test('b595 G1', () => {
  const falseKill = 'A false kill proves nothing: removing a call while leaving its bookkeeping intact can make the suite red for the bookkeeping, not the removed behavior.'
  const io = fakeIo({
    files: { [`${CTX.checkout}/a.mjs`]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], {
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
    }),
    runs: {
      ...CHECK_RUNS(),
      'gate-cmd:3': { ok: true, output: 'still green\nGATE-SUMMARY {"total":3,"failed":0,"errored":0}' },
      'gate-fixed:1': { ok: true, output: 'green\nGATE-SUMMARY {"total":3,"failed":0,"errored":0}' },
      'gate-fixed:2': { ok: false, output: 'FAIL check-one: caught\nGATE-SUMMARY {"total":3,"failed":1,"errored":0}' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.writes[`${TD}/gate-discrimination-bounce.md`].includes(falseKill))
})

test('b600 K1', () => {
  const malformed = {
    id: 'B1', severity: 'consider', location: 'a.mjs:1', summary: 'partner observation',
    disposition: 'no-op', vacuity_claim: 'mutation-survived',
  }
  const wouldDismiss = { id: 'B1', disposition: 'dismiss', reason: 'not a defect' }
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', []), 'tech-lead:2': dPartnerEnv('changes-needed', [malformed]),
      'lead:1': dAdjEnv({ decision: 'bounce', guidance: 'retry the reviewer', adjudications: [wouldDismiss] }),
      'reviewer:2': dReviewEnv('pass', []), 'tech-lead:3': dPartnerEnv('changes-needed', [malformed]),
      'lead:2': dAdjEnv({ decision: 'escalate', adjudications: [wouldDismiss] }),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.accepted_via ?? null, null)
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-adjudication'), false)
  assert.equal(io.calls.logs.some((row) => row.panel_refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.review_round?.refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.review_outcome?.panel), false)
  assert.notEqual(result.details.accepted_via, 'review pass')
})

test('b600 L1', () => {
  const finding = { ...D_AUTO, id: 'B600-L1', summary: 'partner must-fix remains actionable' }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [finding]),
    partner1: dPartnerEnv('changes-needed', [{ ...finding }]),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const outcome = dPanelOutcomes(io)[0]
  assert.equal(result.status, 'done')
  assert.ok(io.calls.assign.some(({ note }) => note === 'panel-adjudication'))
  assert.ok(outcome)
  assert.equal(outcome.findings[0].disposition, 'auto-fix')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(result.details.accepted_via, 'review pass')
})

test('b600 M1', () => {
  const root = scratchDir('b600-anchor-pin-')
  mkdirSync(join(root, 'crew'), { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  cpSync(join(REPO_ROOT, 'crew/drive.mjs'), join(root, 'crew/drive.mjs'))
  cpSync(join(REPO_ROOT, 'skills/pr-review'), join(root, 'skills/pr-review'), { recursive: true })
  const sourcePath = join(root, 'crew/drive.mjs')
  const source = readFileSync(sourcePath, 'utf8')
  const anchor = '        panelResult = runPanelReview({'
  assert.equal(source.split(anchor).length - 1, 1)
  writeFileSync(sourcePath, source.replace(anchor, '        const panelResult = runPanelReview({'))
  const manifestPath = join(root, 'skills/pr-review/anchors.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const [key] = Object.entries(manifest).find(([, value]) => value.includes('panelResult = runPanelReview({')) || []
  assert.ok(key)
  const result = checkSkillAnchors({ root, skillDir: join(root, 'skills/pr-review'), manifestPath })
  assert.ok(result.failures.some((failure) => failure.startsWith(`${key}:`)))
  assert.equal(result.shifted.some((shift) => shift.key === key), false)
})

test('b600 N1', () => {
  // Deliberate inline exception: b600 N1 has no anchor-count floor, while assertAnchorsPinned requires one; inventing a floor would change valid deletions.
  const skillDir = join(REPO_ROOT, 'skills/pr-review')
  const result = checkSkillAnchors({ root: REPO_ROOT, skillDir, manifestPath: join(skillDir, 'anchors.json') })
  assert.deepEqual(result.failures, [])
  const fence = laneFence({ root: REPO_ROOT })
  const { inFence, outOfFence } = partitionShifts({ shifted: result.shifted, fence: fence.paths, manifest: 'skills/pr-review/anchors.json' })
  const repair = 'node skills/qa-test-writing/anchor-pin.mjs --repair-all skills/pr-review'
  // On the default branch there is no lane to defer to: this IS the post-merge pass
  // the warning names, so a deferred shift is owed here rather than warned about again.
  if (shiftsAreOwedHere(fence)) {
    assert.deepEqual(outOfFence.map((shift) => `${shift.key} -> ${shift.to}`), [], `no lane to defer to — repair here with: ${repair}`)
  }
  for (const shift of outOfFence) console.warn(`shifted ${shift.key} -> line ${shift.to}; repair after this lane merges, on main with: ${repair}`)
  assert.deepEqual(inFence, [], 'a shift this lane can repair here must be repaired, not tolerated')
})

test('b600 O1', () => {
  const reviewer = {
    id: 'B600-O1', severity: 'must-fix', location: 'a.mjs:1', summary: 'claims conflict',
    disposition: 'auto-fix', patch: D_PATCH_A, vacuity_claim: 'mutation-survived',
  }
  const partner = { ...reviewer, vacuity_claim: 'source-text-only' }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewer]),
    partner1: dPartnerEnv('changes-needed', [partner]),
    adjudication1: dAdjEnv(),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.ok(io.calls.assign.some(({ note }) => note === 'panel-adjudication'))
  assert.equal(io.calls.logs.some((row) => row.panel_refused === 'vacuity-classification'), true)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'vacuity-classification'), false)
  assert.equal(io.calls.logs.some((row) => row.review_outcome?.panel), false)
})

test('b600 P1', () => {
  const dismissed = {
    id: 'B600-P1-dismissed', severity: 'should-fix', location: 'a.mjs:3', summary: 'dismissed only in the panel',
  }
  const conflict = (vacuity_claim) => ({
    id: 'B600-P1-conflict', severity: 'must-fix', location: 'a.mjs:2', summary: 'vacuity claims disagree',
    disposition: 'auto-fix', patch: D_PATCH_A, vacuity_claim,
  })
  const dismiss = (decision, reason) => dAdjEnv({
    decision, guidance: decision === 'bounce' ? 'retry the panel' : undefined,
    adjudications: [{ id: dismissed.id, disposition: 'dismiss', reason }],
  })
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('changes-needed', [dismissed, conflict('mutation-survived')]),
      'tech-lead:2': dPartnerEnv('changes-needed', [conflict('source-text-only')]),
      'lead:1': dismiss('bounce', 'refused attempt one'), 'lead:2': leadEnv('bounce'),
      'reviewer:2': dReviewEnv('changes-needed', [dismissed, conflict('mutation-survived')]),
      'tech-lead:3': dPartnerEnv('changes-needed', [conflict('source-text-only')]),
      'lead:3': dismiss('bounce', 'refused attempt two'), 'lead:4': leadEnv('bounce'),
      'reviewer:3': dReviewEnv('changes-needed', [dismissed]),
      'tech-lead:4': dPartnerEnv('pass', []),
      'lead:5': dismiss('escalate', 'accepted attempt'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(D_PANEL_CTX, io)
  const panelDissents = result.details.dissents.filter((entry) => entry.kind === 'panel-divergence')
  assert.equal(result.status, 'done')
  assert.deepEqual(panelDissents, [{
    kind: 'panel-divergence', from: 'reviewer', finding_id: dismissed.id, severity: dismissed.severity,
    location: dismissed.location, summary: dismissed.summary, disposition: 'dismissed', reason: 'accepted attempt', round: 1,
  }])
  assert.equal(dPanelOutcomes(io).length, 1)
  assert.equal(io.calls.logs.filter((row) => row.dissent?.kind === 'panel-divergence').length, 1)
})

test('A1 review_only declares the reviewer seat and optional rigorous tech lead', () => {
  assert.equal(Object.keys(VARIANTS).includes('review_only'), true)
  assert.deepEqual(VARIANTS.review_only.required_seats, ['reviewer'])
  assert.equal(shapeDefect(VARIANTS.review_only, 'review_only'), null)
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask({ ...REVIEW_CTX, roles: ['reviewer', 'tech-lead'], seatedRoles: ['reviewer', 'tech-lead'] }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  assert.equal(io.calls.assign.some(({ role }) => role === 'tech-lead'), false)
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.equal(result.details.stages.some((stage) => stage.startsWith('commit') || (stage.startsWith('review') && !stage.startsWith('review_only'))), false)
})

test('B1 review_only refuses an envelope without declared base and head', () => {
  for (const field of ['base', 'head']) {
    const env = reviewEnvelope()
    delete env.details[field]
    const result = driveTask(REVIEW_CTX, strictReviewIo(env))
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
    assert.match(result.details.escalation.why, /\[field-missing\]/)
  }
})

test('B2 review_only requires exact dispatch and reviewer transport identity', () => {
  for (const [field, reason] of [['assignment_id', 'assignment-id-mismatch'], ['run_id', 'run-mismatch'], ['role', 'role-mismatch']]) {
    const env = reviewEnvelope()
    delete env[field]
    const result = driveTask(REVIEW_CTX, strictReviewIo(env))
    assert.equal(result.status, 'escalation')
    assert.match(result.details.escalation.why, new RegExp(reason))
  }
  const scout = driveTask({ ...CTX, variant: 'scout' }, fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] }))
  assert.equal(scout.status, 'done')
})

test('C1 review_only reuses the scout zero-write scope gate', () => {
  const scout = driveTask({ ...CTX, variant: 'scout' }, fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: ['src/write.mjs'] }))
  const review = driveTask(REVIEW_CTX, strictReviewIo(reviewEnvelope(), { changed: ['src/write.mjs'] }))
  for (const result of [scout, review]) {
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scope')
    assert.ok(result.details.stages.includes('scope-gate:r1'))
  }
})

test('RV1-1 review_only preserves zero-write proof before handled envelope refusal', () => {
  const env = reviewEnvelope()
  delete env.run_id
  const io = strictReviewIo(env, { changed: ['crew/drive.mjs'] })
  let changedCalls = 0
  const changedFiles = io.changedFiles.bind(io)
  io.changedFiles = () => {
    changedCalls += 1
    return changedFiles()
  }
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /crew\/drive\.mjs/)
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'escalate:scope'])
  assert.equal(changedCalls, 1)
})

test('D1 review_only requires every structured finding field', () => {
  for (const key of Object.keys(REVIEW_FINDING)) {
    const env = reviewEnvelope({ findings: [{ ...REVIEW_FINDING }] })
    delete env.details.findings[0][key]
    const defect = envelopeDefect(env, VARIANTS.review_only, { taskDir: TD })
    assert.equal(defect.reason, 'field-item', key)
  }
  for (const [key, value] of [['severity', 'urgent'], ['disposition', 'later'], ['id', 'not valid']]) {
    const env = reviewEnvelope({ findings: [{ ...REVIEW_FINDING, [key]: value }] })
    const defect = envelopeDefect(env, VARIANTS.review_only, { taskDir: TD })
    assert.equal(defect.reason, 'field-item', key)
  }
})

test('D2 envelope declaration metadata fails closed', () => {
  const withField = (name, change) => ({
    ...VARIANTS.review_only,
    envelope_fields: VARIANTS.review_only.envelope_fields.map((field) => field.name === name ? change(field) : field),
  })
  const withFindings = (change) => withField('findings', (field) => change({
    ...field,
    item_fields: [...field.item_fields],
    item_values: Object.fromEntries(Object.entries(field.item_values).map(([key, values]) => [key, [...values]])),
    item_patterns: { ...field.item_patterns }, cardinality: { ...field.cardinality },
  }))
  const malformed = [
    withFindings((field) => ({ ...field, cardinality: { ...field.cardinality, discriminator: 'missing' } })),
    withFindings((field) => ({ ...field, cardinality: { ...field.cardinality, discriminator: 'findings' } })),
    withFindings((field) => ({ ...field, cardinality: { ...field.cardinality, empty: 'unknown' } })),
    withFindings((field) => ({ ...field, item_values: { ...field.item_values, unknown: Object.freeze(['x']) } })),
    withFindings((field) => ({ ...field, item_patterns: { ...field.item_patterns, id: '[' } })),
    withFindings((field) => ({ ...field, allow_empty: 'yes' })),
    withField('outcome', (field) => ({ ...field, allow_empty: true })),
    withFindings((field) => ({ ...field, item_values: { ...field.item_values, severity: ['must-fix'] } })),
    withFindings((field) => ({ ...field, item_values: { ...field.item_values, severity: Object.freeze([]) } })),
  ]
  for (const shape of malformed) assert.equal(typeof shapeDefect(shape, 'review_only'), 'string')
})

test('D3 review_only paths reject record metadata and malformed members', () => {
  const pathsField = VARIANTS.review_only.envelope_fields.find((field) => field.name === 'reviewed_files')
  const withPaths = (change) => ({
    ...VARIANTS.review_only,
    envelope_fields: VARIANTS.review_only.envelope_fields.map((field) => field.name === 'reviewed_files' ? change({ ...field }) : field),
  })
  const malformed = [
    withPaths((field) => ({ ...field, item_fields: ['path'] })),
    withPaths((field) => ({ ...field, item_values: { path: ['x'] } })),
    withPaths((field) => ({ ...field, item_patterns: { path: '.+' } })),
    withPaths((field) => ({ ...field, cardinality: { discriminator: 'outcome', empty: 'no-findings', nonempty: 'findings' } })),
    withPaths((field) => ({ ...field, optional_item_fields: ['path'] })),
    withPaths((field) => ({ ...field, covers: { field: 'findings', key: 'id' } })),
    withPaths((field) => ({ ...field, allow_empty: 'yes' })),
  ]
  for (const shape of malformed) assert.equal(typeof shapeDefect(shape, 'review_only'), 'string')
  assert.equal(shapeDefect(VARIANTS.review_only, 'review_only'), null)
  assert.equal(envelopeDefect(reviewEnvelope({ details: { reviewed_files: [] } }), VARIANTS.review_only, { taskDir: TD }), null)
  for (const paths of [[''], ['  '], [null], [1], ['src/a.mjs', 'src/a.mjs']]) {
    const defect = envelopeDefect(reviewEnvelope({ details: { reviewed_files: paths } }), VARIANTS.review_only, { taskDir: TD })
    assert.equal(defect.reason, 'field-item', JSON.stringify(paths))
  }
  assert.equal(pathsField.allow_empty, true)
})

test('D4 object envelope fields accept objects and reject null arrays and scalars', () => {
  const valid = reviewEnvelope({ details: { panel: {} } })
  assert.equal(envelopeDefect(valid, VARIANTS.review_panel, { taskDir: TD }), null)
  for (const panel of [null, [], 'scalar', 1]) {
    const defect = envelopeDefect(reviewEnvelope({ details: { panel } }), VARIANTS.review_panel, { taskDir: TD })
    assert.equal(defect.reason, 'field-kind', JSON.stringify(panel))
  }
  for (const change of [
    { values: ['x'] }, { allow_empty: true }, { item_fields: ['x'] }, { covers: { field: 'findings', key: 'id' } },
  ]) {
    const field = { ...VARIANTS.review_panel.envelope_fields.find(({ name }) => name === 'panel'), ...change }
    const shape = { ...VARIANTS.review_panel, envelope_fields: VARIANTS.review_panel.envelope_fields.map((candidate) => candidate.name === 'panel' ? field : candidate) }
    assert.equal(typeof shapeDefect(shape, 'review_panel'), 'string', JSON.stringify(change))
  }
})

test('A1 coverage outside the declared change set is refused', () => {
  const declared = ['src/reviewed.mjs', 'src/generated.bin']
  const diff = `${declared.join('\0')}\0`
  const valid = reviewEnvelope({ details: {
    reviewed_files: ['src/reviewed.mjs'],
    unreviewable_files: [{ path: 'src/generated.bin', reason: 'generated' }],
  } })
  const acceptedIo = strictReviewIo(valid, { runs: reviewDiffRuns({ ok: true, output: diff }) })
  const accepted = driveTask(REVIEW_CTX, acceptedIo)
  assert.equal(accepted.status, 'done')
  for (const details of [
    { reviewed_files: ['src/outside.mjs'], unreviewable_files: [] },
    { reviewed_files: [], unreviewable_files: [{ path: 'src/outside.mjs', reason: 'generated' }] },
  ]) {
    const io = strictReviewIo(reviewEnvelope({ details }), { runs: reviewDiffRuns({ ok: true, output: diff }) })
    const result = driveTask(REVIEW_CTX, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
    assert.equal(io.calls.logs.some((row) => row.stage === 'envelope-accept'), false)
  }
  for (const probe of [
    { ok: false, output: 'git diff failed' },
    { ok: true, output: null },
    () => { throw new Error('diff interrupted') },
  ]) {
    const io = strictReviewIo(reviewEnvelope(), { runs: reviewDiffRuns(probe) })
    const result = driveTask(REVIEW_CTX, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
    assert.equal(io.calls.logs.some((row) => row.stage === 'envelope-accept'), false)
  }
})

test('A2 review diff terminates options before returned revisions', () => {
  const base = '--output=hostile.mjs'
  const head = 'head-sha'
  const env = reviewEnvelope({ details: { base, head } })
  const command = reviewDiffCommand(base, head)
  const io = strictReviewIo(env, { runs: { [command]: { ok: true, output: '' } } })
  const result = driveTask(REVIEW_CTX, io)
  const probe = io.calls.wrapped.find(({ wrapped }) => wrapped === command)?.wrapped
  assert.equal(result.status, 'done')
  assert.equal(typeof probe, 'string')
  assert.ok(probe.indexOf('--end-of-options') < probe.indexOf(shellArg(`${base}...${head}`)))
  assert.equal(probe.endsWith(' --'), true)
  assert.equal(io.calls.checkoutLog.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('B1 overlapping review coverage is refused', () => {
  const path = 'src/shared.mjs'
  const env = reviewEnvelope({ details: {
    reviewed_files: [path],
    unreviewable_files: [{ path, reason: 'out-of-context' }],
  } })
  const io = strictReviewIo(env, { runs: reviewDiffRuns({ ok: true, output: `${path}\0` }) })
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'envelope')
  assert.match(result.details.escalation.why, /both reviewed and unreviewable/)
  assert.equal(io.calls.logs.some((row) => row.stage === 'envelope-accept'), false)
})

test('B2 duplicate unreviewable paths are refused', () => {
  const path = 'src/generated.mjs'
  const env = reviewEnvelope({ details: {
    reviewed_files: [],
    unreviewable_files: [{ path, reason: 'generated' }, { path, reason: 'binary' }],
  } })
  const io = strictReviewIo(env, { runs: reviewDiffRuns({ ok: true, output: `${path}\0` }) })
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'envelope')
  assert.match(result.details.escalation.why, /duplicate paths/)
  assert.equal(io.calls.logs.some((row) => row.stage === 'envelope-accept'), false)
})

test('C1 unreviewable reasons are closed', () => {
  const reasons = ['binary', 'generated', 'too-large', 'out-of-context']
  assert.deepEqual(VARIANTS.review_only.envelope_fields.find((field) => field.name === 'unreviewable_files').item_values.reason, reasons)
  for (const reason of reasons) {
    const path = `src/${reason}.mjs`
    const env = reviewEnvelope({ details: { unreviewable_files: [{ path, reason }] } })
    const result = driveTask(REVIEW_CTX, strictReviewIo(env, { runs: reviewDiffRuns({ ok: true, output: `${path}\0` }) }))
    assert.equal(result.status, 'done', reason)
  }
  const unknown = reviewEnvelope({ details: { unreviewable_files: [{ path: 'src/unknown.mjs', reason: 'unknown' }] } })
  const defect = envelopeDefect(unknown, VARIANTS.review_only, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
})

test('D1 accepted review coverage is carried in envelope values', () => {
  const details = {
    reviewed_files: ['src/reviewed.mjs'],
    unreviewable_files: [{ path: 'src/binary.bin', reason: 'binary' }],
  }
  const env = reviewEnvelope({ details })
  const io = strictReviewIo(env, { runs: reviewDiffRuns({ ok: true, output: 'src/reviewed.mjs\0src/binary.bin\0' }) })
  const result = driveTask(REVIEW_CTX, io)
  const accepted = io.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.envelope.values, { ...reviewEnvelope().details, ...details })
  assert.deepEqual(accepted.values, result.details.envelope.values)
})

test('E1 review coverage preserves every other shipped shape contract', () => {
  for (const [name, shape] of Object.entries(VARIANTS)) assert.equal(shapeDefect(shape, name), null, name)
  const expected = {
    execution: 'envelope',
    required_seats: ['reviewer'],
    stages: ['review_only', 'scope-gate', 'envelope-accept'],
    off_critical_path_stages: [],
    writes: 'none',
    accepted_by: 'structured envelope plus zero-write proof; no commit',
    strict_identity: true,
    report_values: true,
    envelope_fields: [
      { name: 'base', kind: 'text' }, { name: 'head', kind: 'text' },
      { name: 'outcome', kind: 'text', values: ['findings', 'no-findings'] },
      {
        name: 'findings', kind: 'records', allow_empty: true,
        item_fields: ['id', 'severity', 'location', 'summary', 'evidence', 'disposition'],
        item_values: { severity: ['must-fix', 'should-fix', 'consider'], disposition: ['auto-fix', 'ask-user', 'no-op'] },
        item_patterns: { id: '^[A-Za-z0-9_-]{1,64}$' },
        cardinality: { discriminator: 'outcome', empty: 'no-findings', nonempty: 'findings' },
      },
      { name: 'reviewed_files', kind: 'paths', allow_empty: true },
      {
        name: 'unreviewable_files', kind: 'records', allow_empty: true,
        item_fields: ['path', 'reason'],
        item_values: { reason: ['binary', 'generated', 'too-large', 'out-of-context'] },
      },
    ],
    assignment: 'Review the returned base/head identity and the declared change set as a read-only code review. This assignment supersedes the ordinary reviewer deliverable: do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted. Return the complete structured envelope with non-empty base and head, outcome findings or no-findings, reviewed_files as an array of paths, and unreviewable_files as records with path and reason; every unreviewable reason must be binary, generated, too-large, or out-of-context, every listed path must belong to the base/head change set, and reviewed_files and unreviewable_files must be disjoint. Return findings records containing id, severity, location, summary, evidence, and disposition; findings must be empty exactly when outcome is no-findings and non-empty when outcome is findings.',
  }
  assert.deepEqual(VARIANTS.review_only, expected)
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.equal(result.details.envelope.seat, 'reviewer')
  assert.equal(result.details.envelope.files_changed, 0)
  assert.deepEqual(result.details.envelope.values, reviewEnvelope().details)
  assert.equal(result.details.commit, null)
  assert.equal(io.calls.commits.length, 0)
})

test('E2 review coverage paths render an accurate envelope contract', () => {
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask(REVIEW_CTX, io)
  const brief = io.calls.writes[`${TD}/review_only-brief.md`]
  assert.equal(result.status, 'done')
  assert.match(brief, /details\.reviewed_files: an array of non-empty path strings; empty is allowed/)
  assert.doesNotMatch(brief, /details\.reviewed_files: a non-empty string/)
})

test('A1 review identity rejects wrong returned base and head before acceptance', () => {
  const cases = [
    { base: 'c'.repeat(40), head: REVIEW_HEAD_SHA },
    { base: REVIEW_BASE_SHA, head: 'd'.repeat(40) },
  ]
  for (const returned of cases) {
    const io = strictReviewIo(reviewIdentityEnvelope(returned.base, returned.head))
    const result = driveTask(REVIEW_CONTEXTFUL_CTX, io)
    const refusal = {
      reason: 'identity-mismatch',
      expected: { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA },
      returned: { base_sha: returned.base, head_sha: returned.head },
    }
    assert.equal(result.status, 'escalation')
    assert.deepEqual(result.details.escalation.review_identity, refusal)
    const rows = io.calls.logs.filter((row) => row.review_identity_refused)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].review_identity_refused, refusal)
    assert.equal(io.calls.logs.some((row) => row.envelope_refused), false)
    assert.equal(io.calls.logs.some((row) => row.stage === 'envelope-accept'), false)
    assert.equal(io.calls.logs.some((row) => row.envelope_accepted), false)
    assert.equal(io.calls.commits.length, 0)
  }
})

test('B1 review identity rejects malformed context before dispatch', () => {
  const valueCases = []
  for (const field of ['base_sha', 'head_sha']) {
    for (const value of ['AF'.repeat(20), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
      const identity = { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA }
      identity[field] = value
      valueCases.push([`${field}-${value.length}`, identity])
    }
  }
  const missing = { base_sha: REVIEW_BASE_SHA }
  const ordinaryExtra = { ...REVIEW_IDENTITY, extra: true }
  const symbolExtra = { ...REVIEW_IDENTITY }
  Object.defineProperty(symbolExtra, Symbol('extra'), { value: true })
  const hiddenExtra = { ...REVIEW_IDENTITY }
  Object.defineProperty(hiddenExtra, 'extra', { value: true })
  const inherited = Object.assign(Object.create({ inherited: true }), REVIEW_IDENTITY)
  const custom = Object.assign(Object.create({}), REVIEW_IDENTITY)
  class ReviewIdentityClass {
    constructor() {
      this.base_sha = REVIEW_BASE_SHA
      this.head_sha = REVIEW_HEAD_SHA
    }
  }
  const throwingOwnKeys = new Proxy({ ...REVIEW_IDENTITY }, {
    ownKeys() { throw new Error('ownKeys denied') },
  })
  const throwingGetter = { head_sha: REVIEW_HEAD_SHA }
  Object.defineProperty(throwingGetter, 'base_sha', {
    enumerable: true,
    get() { throw new Error('getter denied') },
  })
  const cycle = { ...REVIEW_IDENTITY }
  cycle.self = cycle
  const bigInt = { base_sha: 1n, head_sha: REVIEW_HEAD_SHA }
  const shapeCases = [
    ['null', null], ['array', [REVIEW_BASE_SHA, REVIEW_HEAD_SHA]], ['missing', missing],
    ['ordinary-extra', ordinaryExtra], ['symbol-extra', symbolExtra], ['hidden-extra', hiddenExtra],
    ['inherited-prototype', inherited], ['custom-prototype', custom], ['class-prototype', new ReviewIdentityClass()],
    ['throwing-ownKeys', throwingOwnKeys], ['throwing-getter', throwingGetter], ['cycle', cycle], ['bigint', bigInt],
  ]
  for (const [label, identity] of [...valueCases, ...shapeCases]) {
    const ctx = Object.freeze({ ...REVIEW_CTX, review_identity: identity })
    const io = strictReviewIo(reviewEnvelope())
    const result = driveTask(ctx, io)
    assert.equal(result.status, 'escalation', label)
    assert.equal(result.details.escalation.review_identity.reason, 'review-identity-malformed', label)
    assert.equal(io.calls.assign.length, 0, label)
    assert.equal(io.calls.writes[`${TD}/review_only-brief.md`], undefined, label)
    assert.equal(io.calls.logs.some((row) => row.stage === 'review_only:r1'), false, label)
    assert.equal(io.calls.logs.some((row) => row.envelope_refused), false, label)
    const rows = io.calls.logs.filter((row) => row.review_identity_refused)
    assert.equal(rows.length, 1, label)
    assert.deepEqual(rows[0].review_identity_refused, result.details.escalation.review_identity, label)
    assert.doesNotThrow(() => JSON.stringify(rows[0]), label)
    assert.doesNotThrow(() => JSON.stringify(result), label)
  }

  const nullProtoIo = strictReviewIo(reviewIdentityEnvelope(REVIEW_BASE_SHA, REVIEW_HEAD_SHA))
  const nullProtoResult = driveTask(REVIEW_NULL_PROTO_CTX, nullProtoIo)
  assert.equal(nullProtoResult.status, 'done')
  const accepted = nullProtoIo.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
  assert.deepEqual(accepted.review_identity, {
    expected: { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA },
    returned: { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA },
    match: true,
  })
})

test('C1 review identity records a matching expected and returned pair', () => {
  const pairs = [
    { base_sha: REVIEW_BASE_SHA, head_sha: REVIEW_HEAD_SHA },
    { base_sha: 'c'.repeat(64), head_sha: 'd'.repeat(64) },
  ]
  for (const pair of pairs) {
    const identity = Object.freeze({ ...pair })
    const ctx = Object.freeze({ ...REVIEW_CTX, review_identity: identity })
    const io = strictReviewIo(reviewIdentityEnvelope(pair.base_sha, pair.head_sha))
    const result = driveTask(ctx, io)
    assert.equal(result.status, 'done')
    const expected = { ...pair }
    const audit = { expected, returned: { ...pair }, match: true }
    const accepted = io.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
    assert.deepEqual(accepted.review_identity, audit)
    assert.deepEqual(result.details.review_identity, audit)
  }
})

test('D1 review identity preserves the blockless review_only contract', () => {
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.deepEqual(result.details.envelope.values, reviewEnvelope().details)
  const accepted = io.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
  assert.equal(Object.hasOwn(accepted, 'review_identity'), false)
  assert.equal(Object.hasOwn(result.details, 'review_identity'), false)
  assert.equal(io.calls.commits.length, 0)

  const dirtyIo = strictReviewIo(reviewEnvelope(), { changed: ['crew/drive.mjs'] })
  const dirty = driveTask(REVIEW_CTX, dirtyIo)
  assert.equal(dirty.status, 'escalation')
  assert.deepEqual(dirty.details.stages, ['review_only:r1', 'scope-gate:r1', 'escalate:scope'])
  assert.deepEqual(dirty.details.escalation, {
    where: 'scope',
    why: 'a review_only run writes nothing, but the tree carries 1 changed file(s): crew/drive.mjs',
    question: {
      type: 'single-choice',
      prompt: 'How should this scope escalation be resolved?',
      options: ['widen-fence-to', 'split-lane', 'park'],
      slots: { files: ['crew/drive.mjs'] },
    },
  })
  assert.equal(Object.hasOwn(dirty.details, 'review_identity'), false)
  assert.equal(dirtyIo.calls.commits.length, 0)
})

test('E1 review_only round-trips no-findings as a measured outcome', () => {
  const populatedIo = strictReviewIo(reviewEnvelope())
  const populated = driveTask(REVIEW_CTX, populatedIo)
  const populatedAccepted = populatedIo.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
  assert.equal(populated.status, 'done')
  assert.deepEqual(populatedAccepted.values, populated.details.envelope.values)
  assert.deepEqual(populated.details.envelope.values, reviewEnvelope().details)

  const noneIo = strictReviewIo(reviewEnvelope({ outcome: 'no-findings', findings: [] }))
  const none = driveTask(REVIEW_CTX, noneIo)
  const noneAccepted = noneIo.calls.logs.find((row) => row.envelope_accepted).envelope_accepted
  assert.equal(none.status, 'done')
  assert.deepEqual(noneAccepted.values, none.details.envelope.values)
  assert.deepEqual(none.details.envelope.values, { base: 'base-sha', head: 'head-sha', outcome: 'no-findings', findings: [], reviewed_files: [], unreviewable_files: [] })
  const mismatch = reviewEnvelope({ outcome: 'findings', findings: [] })
  assert.equal(envelopeDefect(mismatch, VARIANTS.review_only, { taskDir: TD }).reason, 'field-item')

  const brief = noneIo.calls.writes[`${TD}/review_only-brief.md`]
  assert.match(brief, /assignment_id="d1".*run_id="run-review-783".*role="reviewer"/)
  assert.match(brief, /empty is allowed only when details\.outcome is "no-findings"/)
  assert.match(brief, /severity is one of must-fix \| should-fix \| consider/)
  assert.equal(brief.includes('id matches "^[A-Za-z0-9_-]{1,64}$"'), true)
  const scoutIo = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  driveTask({ ...CTX, variant: 'scout' }, scoutIo)
  assert.match(scoutIo.calls.writes[`${TD}/scout-brief.md`], /a non-empty array of records/)
  assert.doesNotMatch(scoutIo.calls.writes[`${TD}/scout-brief.md`], /empty is allowed/)
})

test('F1 review_only accepts envelope plus zero-write proof without a commit', () => {
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(VARIANTS.review_only.accepted_by, 'structured envelope plus zero-write proof; no commit')
  assert.equal(io.calls.commits.length, 0)
  assert.equal(result.details.commit, null)
})

test('G1 code review evidence acceptance requires identity and structured verdict', () => {
  const missingBase = reviewEnvelope()
  delete missingBase.details.base
  const missingOutcome = reviewEnvelope()
  delete missingOutcome.details.outcome
  const missingFindings = reviewEnvelope()
  delete missingFindings.details.findings
  for (const env of [missingBase, missingOutcome, missingFindings]) {
    const result = driveTask(REVIEW_CTX, strictReviewIo(env))
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.stages.includes('envelope-accept'), false)
  }
})

test('RV1-1 review_only normalizes only its envelope failure route', () => {
  const scout = driveTask({ ...CTX, variant: 'scout' }, fakeIo({ envelopes: { 'planner:1': null }, changed: [] }))
  assert.equal(scout.status, 'escalation')
  assert.equal(scout.details.escalation.where, 'scout')
  assert.deepEqual(scout.details.stages, ['scout:r1', 'scope-gate:r1', 'escalate:scout'])

  const review = driveTask(REVIEW_CTX, strictReviewIo(null))
  assert.equal(review.status, 'escalation')
  assert.equal(review.details.escalation.where, 'envelope')
  assert.deepEqual(review.details.stages, ['review_only:r1', 'scope-gate:r1', 'escalate:envelope'])
})

test('RV1-2 envelope enforcement brief survives generated identity refresh', () => {
  const io = strictReviewIo((returnPath) => (
    returnPath.endsWith('/d1.json') ? zeroTurnReviewEnvelope() : reviewEnvelope({ assignment_id: 'd2' })
  ))
  const result = driveTask(REVIEW_CTX, io)
  const reviewerAssignments = io.calls.assign.filter(({ role }) => role === 'reviewer')
  assert.equal(result.status, 'done')
  assert.equal(reviewerAssignments.length, 2)
  assert.match(reviewerAssignments[1].briefFile, new RegExp(`^${TD}/enforcement-reviewer-r\\d+\\.md$`))
  const recoveryBrief = io.calls.writes[reviewerAssignments[1].briefFile]
  assert.match(recoveryBrief, /^Your previous dispatch produced no envelope and took no turns \(zero-turn-non-start\)\.$/m)
  assert.match(recoveryBrief, /The same assignment is asked directly again/)
  assert.match(recoveryBrief, new RegExp(`Original brief: ${TD}/review_only-brief\\.md`))
  assert.match(io.calls.writes[`${TD}/review_only-brief.md`], /assignment_id="d2".*run_id="run-review-783".*role="reviewer"/)
  const applied = io.calls.logs.find((row) => row.seat_enforcement?.applied)?.seat_enforcement
  assert.equal(applied.brief, reviewerAssignments[1].briefFile)
  assert.equal(applied.dispatch, 'd2')
})

test('A1 verify_only declares the reviewer seat and envelope lifecycle', () => {
  assert.equal(Object.keys(VARIANTS).at(-1), 'verify_only')
  assert.deepEqual(VARIANTS.verify_only.required_seats, ['reviewer'])
  assert.deepEqual(VARIANTS.verify_only.stages, ['verify_only', 'scope-gate', 'envelope-accept'])
  assert.equal(shapeDefect(VARIANTS.verify_only, 'verify_only'), null)
  const io = strictVerifyIo(verificationEnvelope())
  const result = driveTask({ ...VERIFY_CTX, roles: ['reviewer', 'tech-lead'], seatedRoles: ['reviewer', 'tech-lead'] }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  assert.equal(io.calls.assign.some(({ role }) => role === 'tech-lead'), false)
  assert.deepEqual(result.details.stages, ['verify_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
})

test('B1 verify_only refuses missing verification declarations', () => {
  for (const field of ['verification_targets', 'environment_assumptions']) {
    for (const mode of ['omitted', 'empty']) {
      const env = verificationEnvelope()
      if (mode === 'omitted') delete env.details[field]
      else env.details[field] = []
      const result = driveTask(VERIFY_CTX, strictVerifyIo(env))
      assert.equal(result.status, 'escalation', `${field} ${mode}`)
      assert.equal(result.details.escalation.where, 'envelope', `${field} ${mode}`)
      assert.match(result.details.escalation.why, /\[(?:field-missing|field-kind)\]/, `${field} ${mode}`)
    }
  }
})

test('C1 verify_only reuses the scout and review_only zero-write proof', () => {
  const scout = driveTask({ ...CTX, variant: 'scout' }, fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: ['src/write.mjs'] }))
  const review = driveTask(REVIEW_CTX, strictReviewIo(reviewEnvelope(), { changed: ['src/write.mjs'] }))
  const verify = driveTask(VERIFY_CTX, strictVerifyIo(verificationEnvelope(), { changed: ['src/write.mjs'] }))
  for (const result of [scout, review, verify]) {
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scope')
    assert.ok(result.details.stages.includes('scope-gate:r1'))
  }
})

test('D1 verify_only records every declared check exactly once', () => {
  const targets = [{ id: 'target-a', target: 'first behavior' }, { id: 'target-b', target: 'second behavior' }]
  const matrix = (ids) => ids.map((id) => ({ id, status: 'passed', command: 'node --test', result: 'ok', evidence: `evidence for ${id}` }))
  const valid = verificationEnvelope({ details: { verification_targets: targets, check_matrix: matrix(['target-a', 'target-b']) } })
  assert.equal(envelopeDefect(valid, VARIANTS.verify_only, { taskDir: TD }), null)
  for (const ids of [['target-a', 'target-a'], ['target-a'], ['target-a', 'target-c']]) {
    const defect = envelopeDefect(verificationEnvelope({ details: { verification_targets: targets, check_matrix: matrix(ids) } }), VARIANTS.verify_only, { taskDir: TD })
    assert.equal(defect.reason, 'field-item', JSON.stringify(ids))
    assert.equal(ENVELOPE_REFUSAL_REASONS.includes(defect.reason), true)
  }
  const duplicateTargets = verificationEnvelope({ details: { verification_targets: [targets[0], targets[0]], check_matrix: matrix(['target-a', 'target-b']) } })
  const duplicateDefect = envelopeDefect(duplicateTargets, VARIANTS.verify_only, { taskDir: TD })
  assert.equal(duplicateDefect.reason, 'field-item')
  assert.equal(ENVELOPE_REFUSAL_REASONS.includes(duplicateDefect.reason), true)
})

test('D2 verify_only closes check statuses', () => {
  for (const status of ['passed', 'failed', 'blocked', 'not run']) {
    const blockers = status === 'blocked' || status === 'not run'
      ? [{ target: 'target-1', reason: `${status} environment blocker` }]
      : []
    const env = verificationEnvelope({ details: {
      check_matrix: [{ id: 'target-1', status, command: 'node --test', result: `${status} result`, evidence: `${status} evidence` }],
      environmental_blockers: blockers,
    } })
    const io = strictVerifyIo(env)
    const result = driveTask(VERIFY_CTX, io)
    assert.equal(result.status, 'done', status)
    assert.deepEqual(result.details.envelope.values.check_matrix, env.details.check_matrix, status)
    assert.deepEqual(result.details.envelope.values.environmental_blockers, blockers, status)
  }
  const outside = verificationEnvelope({ details: {
    check_matrix: [{ id: 'target-1', status: 'unknown', command: 'node --test', result: 'unknown', evidence: 'indeterminate' }],
  } })
  const rejected = driveTask(VERIFY_CTX, strictVerifyIo(outside))
  assert.equal(rejected.status, 'escalation')
  assert.equal(rejected.details.escalation.where, 'envelope')
  assert.match(rejected.details.escalation.why, /\[field-item\]/)
})

test('E1 verify_only accepts a complete failing product verdict', () => {
  const env = verificationEnvelope({ details: { product_verdict: 'failing' } })
  const io = strictVerifyIo(env)
  const result = driveTask(VERIFY_CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.envelope.values.product_verdict, 'failing')
  assert.equal(io.calls.commits.length, 0)
})

test('F1 verify_only refuses an incomplete check matrix', () => {
  const env = verificationEnvelope({ details: { check_matrix: [] } })
  const defect = envelopeDefect(env, VARIANTS.verify_only, { taskDir: TD })
  assert.equal(VARIANTS.verify_only.envelope_fields.find((field) => field.name === 'check_matrix').covers.field, 'verification_targets')
  assert.equal(defect.reason, 'field-item')
  assert.equal(ENVELOPE_REFUSAL_REASONS.includes(defect.reason), true)
})

test('RV1-1 verify_only brief requires a row for every verification target', () => {
  const io = strictVerifyIo(verificationEnvelope())
  const result = driveTask(VERIFY_CTX, io)
  const brief = io.calls.writes[`${TD}/verify_only-brief.md`]
  assert.equal(result.status, 'done')
  assert.equal(brief.includes('details.check_matrix: an array of records with a non-empty id and a non-empty status and a non-empty command and a non-empty result and a non-empty evidence; exactly one record for each details.verification_targets.id, so an empty array is refused whenever that field carries records; status is one of passed | failed | blocked | not run'), true)
})

test('G1 verify_only preserves command evidence', () => {
  const env = verificationEnvelope()
  delete env.details.check_matrix[0].command
  const defect = envelopeDefect(env, VARIANTS.verify_only, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
  assert.equal(ENVELOPE_REFUSAL_REASONS.includes(defect.reason), true)
})

test('G2 verify_only preserves result evidence', () => {
  const env = verificationEnvelope()
  delete env.details.check_matrix[0].result
  const defect = envelopeDefect(env, VARIANTS.verify_only, { taskDir: TD })
  assert.equal(defect.reason, 'field-item')
  assert.equal(ENVELOPE_REFUSAL_REASONS.includes(defect.reason), true)
})

test('G3 verify_only preserves environmental blockers', () => {
  const blockers = [{ target: 'target-1', reason: 'the runtime was unavailable' }]
  const env = verificationEnvelope({ details: { environmental_blockers: blockers } })
  const io = strictVerifyIo(env)
  const result = driveTask(VERIFY_CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.envelope.values.environmental_blockers, blockers)
})

test('H1 qa_verification requires an environment record', () => {
  const missing = verificationEnvelope()
  delete missing.details.environment
  const omitted = driveTask(VERIFY_CTX, strictVerifyIo(missing))
  assert.equal(omitted.status, 'escalation')
  assert.equal(omitted.details.escalation.where, 'envelope')
  assert.match(omitted.details.escalation.why, /\[field-missing\]/)

  const empty = verificationEnvelope({ details: { environment: [] } })
  const emptyResult = driveTask(VERIFY_CTX, strictVerifyIo(empty))
  assert.equal(emptyResult.status, 'escalation')
  assert.match(emptyResult.details.escalation.why, /\[field-kind\]/)
})

test('A1 review_panel runs three seats and returns one fused envelope', () => {
  const reviewer = panelEnvelope({ role: 'reviewer', findings: [PANEL_CONSENSUS_A, PANEL_DIVERGENCE] })
  const partner = panelEnvelope({ role: 'tech-lead', findings: [PANEL_CONSENSUS_B] })
  const adjudicator = panelEnvelope({ role: 'lead', details: { adjudications: [{ id: PANEL_DIVERGENCE.id, disposition: 'uphold', reason: 'the one-sided evidence is actionable' }] } })
  const io = strictPanelIo({ reviewer, partner, adjudicator, runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.map(({ role }) => role), ['reviewer', 'tech-lead', 'lead'])
  assert.deepEqual(result.details.stages, ['review_panel:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.equal(io.calls.logs.filter((row) => row.envelope_accepted).length, 1)
  assert.equal(result.details.panel.findings.some((finding) => finding.panel_disposition === 'consensus'), true)
  assert.ok(result.details.findings.some((finding) => finding.id === PANEL_CONSENSUS_A.id))
  assert.equal(io.calls.commits.length, 0)
})

test('B1 review_panel rejects seat identity mismatch before fusion', () => {
  const wrong = panelEnvelope({ role: 'reviewer', base: 'c'.repeat(40) })
  const io = strictPanelIo({ reviewer: wrong, runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'escalation')
  assert.deepEqual(result.details.panel.failure, {
    reason: 'identity-mismatch', seat: 'reviewer',
    expected: { base_sha: PANEL_BASE_SHA, head_sha: PANEL_HEAD_SHA },
    returned: { base_sha: 'c'.repeat(40), head_sha: PANEL_HEAD_SHA },
  })
  assert.deepEqual(io.calls.assign.map(({ role }) => role), ['reviewer', 'tech-lead'])
  assert.equal(io.calls.logs.some((row) => row.envelope_accepted), false)
})

test('B2 review_panel rejects PARTNER and ADJUDICATOR identity mismatch before fusion', () => {
  // MUTATION B2: check identity for the reviewer only and a partner or adjudicator returning a
  // foreign head is fused into the panel's findings.
  for (const [seat, over] of [
    ['tech-lead', { partner: panelEnvelope({ role: 'tech-lead', head: 'd'.repeat(40) }) }],
    ['lead', { adjudicator: panelEnvelope({ role: 'lead', head: 'e'.repeat(40), details: { adjudications: [] } }) }],
  ]) {
    const io = strictPanelIo({ runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA), ...over })
    const result = driveTask(panelContext(), io)
    assert.equal(result.status, 'escalation', seat)
    assert.equal(result.details.panel.failure.reason, 'identity-mismatch', seat)
    assert.equal(result.details.panel.failure.seat, seat)
    assert.deepEqual(result.details.panel.failure.expected, { base_sha: PANEL_BASE_SHA, head_sha: PANEL_HEAD_SHA }, seat)
    assert.equal(io.calls.logs.some((row) => row.envelope_accepted), false, seat)
  }
})

test('B3 review_panel refuses a malformed identity context before any seat', () => {
  // MUTATION B3: treat an unserialisable review_identity as absent and the panel dispatches seats
  // against an identity nothing can compare.
  const io = strictPanelIo({})
  const cyclic = {}; cyclic.self = cyclic
  const result = driveTask(panelContext({ review_identity: cyclic }), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.panel.failure.reason, 'review-identity-malformed')
  assert.deepEqual(io.calls.assign.map(({ role }) => role), [])
})

test('C1 review_panel preserves reviewer coverage and uses adjudicator coverage', () => {
  const declared = 'src/a.mjs\0src/b.mjs\0'
  const reviewer = panelEnvelope({ role: 'reviewer', details: { reviewed_files: ['src/a.mjs'], unreviewable_files: [{ path: 'src/b.mjs', reason: 'generated' }] } })
  const partner = panelEnvelope({ role: 'tech-lead', details: { reviewed_files: ['src/b.mjs'], unreviewable_files: [] } })
  const adjudicator = panelEnvelope({ role: 'lead', details: { adjudications: [], reviewed_files: ['src/a.mjs', 'src/b.mjs'], unreviewable_files: [] } })
  const io = strictPanelIo({ reviewer, partner, adjudicator, runs: reviewDiffRuns({ ok: true, output: declared }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.panel.changed_files, ['src/a.mjs', 'src/b.mjs'])
  assert.deepEqual(result.details.panel.reviewers, [
    { role: 'reviewer', reviewed_files: ['src/a.mjs'], unreviewable_files: [{ path: 'src/b.mjs', reason: 'generated' }] },
    { role: 'tech-lead', reviewed_files: ['src/b.mjs'], unreviewable_files: [] },
  ])
  assert.deepEqual(result.details.panel.adjudicator, { role: 'lead', reviewed_files: ['src/a.mjs', 'src/b.mjs'], unreviewable_files: [] })
  assert.deepEqual(result.details.reviewed_files, ['src/a.mjs', 'src/b.mjs'])
  assert.deepEqual(result.details.unreviewable_files, [])
  assert.equal(Object.hasOwn(result.details.panel.reviewers[0], 'seat'), false)
  assert.equal(Object.hasOwn(result.details.panel.reviewers[0], 'changed_files'), false)
})

test('D1 review_panel zero-write proof runs after every seat', () => {
  const clean = strictPanelIo({ runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const cleanResult = driveTask(panelContext(), clean)
  assert.equal(cleanResult.status, 'done')
  assert.equal(clean.panelChangedCalls(), 4)
  assert.equal(clean.calls.assign.length, 3)

  const dirty = strictPanelIo({ changed: [[], ['crew/drive.mjs']], runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const dirtyResult = driveTask(panelContext(), dirty)
  assert.equal(dirtyResult.status, 'escalation')
  assert.deepEqual(dirtyResult.details.panel.failure, {
    reason: 'panel-write-refusal', seat: 'tech-lead', paths: ['crew/drive.mjs'], evidence: 'panel seat complete',
  })
  assert.deepEqual(dirty.calls.assign.map(({ role }) => role), ['reviewer', 'tech-lead'])
})

test('D2 review_panel reports the fused values the shape declares', () => {
  // MUTATION D2: drop `accepted.values` (or details.envelope.values) and scripts/factory/pr-review.mjs
  // cannot consume a panel result at all — it reads details.envelope.values and nothing else.
  const io = strictPanelIo({ runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  // Serialize AT LOG TIME. fakeIo keeps the live object, so asserting on it later passes even when
  // values are attached after the row is written — the durable journal would still lack them.
  const serialized = []
  const baseLog = io.log.bind(io)
  io.log = function (row) { serialized.push(JSON.stringify(row)); return baseLog(row) }
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'done')
  assert.equal(VARIANTS.review_panel.report_values, true)
  const values = result.details.envelope.values
  assert.ok(values, 'the declared report_values shape must report values')
  assert.deepEqual(Object.keys(values).sort(), VARIANTS.review_panel.envelope_fields.map((field) => field.name).sort())
  assert.equal(values.base, PANEL_BASE_SHA)
  assert.equal(values.head, PANEL_HEAD_SHA)
  assert.deepEqual(values.findings, result.details.findings)
  assert.deepEqual(values.panel, result.details.panel)
  assert.equal(result.details.gate, null)
  // Sol's catch: a live object reference makes this pass even when values are attached AFTER the
  // row is logged. The durable journal row is JSON, so assert on a SNAPSHOT taken at log time.
  // MUTATION D2b: move the values assignment below logEnvelopeAccepted and this reddens.
  const acceptedRow = serialized.map((row) => JSON.parse(row)).find((row) => row.envelope_accepted)?.envelope_accepted
  assert.ok(acceptedRow.values, 'the journal row must carry values as serialized, not by reference')
  assert.deepEqual(acceptedRow.values, values)
})

test('D3 a panel write refusal names its paths where an operator reads them', () => {
  // MUTATION D3: drop the written paths from `why` and the escalation files slot, and the operator
  // surface says only that seat evidence was recorded — the one fact that matters is buried.
  const dirty = strictPanelIo({ changed: [[], ['crew/drive.mjs', 'crew/variants.mjs']], runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  const result = driveTask(panelContext(), dirty)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /crew\/drive\.mjs/)
  assert.match(result.details.escalation.why, /crew\/variants\.mjs/)
  // The scope question declares a `files` slot (crew/escalation-policy.mjs:335); that is where a
  // human reading the escalation finds them.
  assert.deepEqual(result.details.escalation.question.slots.files, ['crew/drive.mjs', 'crew/variants.mjs'])
})

test('E1 review_panel fails closed when partner or adjudicator is absent', () => {
  const absentPartner = driveTask(panelContext({ roles: ['reviewer', 'lead'], seatedRoles: ['reviewer', 'lead'] }), strictPanelIo())
  assert.equal(absentPartner.status, 'escalation')
  assert.equal(absentPartner.details.panel.failure.reason, 'panel-partner-absent')
  assert.deepEqual(absentPartner.details.panel.failure.seat, 'tech-lead')
  assert.deepEqual(absentPartner.details.stages, ['escalate:envelope'])

  const absentAdjudicator = driveTask(panelContext({ roles: ['reviewer', 'tech-lead'], seatedRoles: ['reviewer', 'tech-lead'] }), strictPanelIo())
  assert.equal(absentAdjudicator.status, 'escalation')
  assert.equal(absentAdjudicator.details.panel.failure.reason, 'panel-adjudicator-absent')
  assert.deepEqual(absentAdjudicator.details.panel.failure.seat, 'lead')
  assert.deepEqual(absentAdjudicator.details.stages, ['escalate:envelope'])

  const failedPartner = driveTask(panelContext(), strictPanelIo({ partner: panelEnvelope({ role: 'tech-lead', status: 'insufficient', summary: 'partner timeout' }) }))
  assert.equal(failedPartner.status, 'escalation')
  assert.equal(failedPartner.details.panel.failure.reason, 'panel-partner-failed')
  assert.deepEqual(failedPartner.details.panel.failure.seat, 'tech-lead')
  assert.deepEqual(failedPartner.details.panel.failure.evidence.status, 'insufficient')
  assert.deepEqual(failedPartner.details.panel.failure.evidence.summary, 'partner timeout')

  const failedAdjudicatorIo = strictPanelIo({ adjudicator: panelEnvelope({ role: 'lead', status: 'insufficient', summary: 'adjudicator timeout', details: { adjudications: [] } }) })
  const failedAdjudicator = driveTask(panelContext(), failedAdjudicatorIo)
  assert.equal(failedAdjudicator.status, 'escalation')
  assert.equal(failedAdjudicator.details.panel.failure.reason, 'panel-adjudicator-failed')
  assert.deepEqual(failedAdjudicator.details.panel.failure.seat, 'lead')
  assert.deepEqual(failedAdjudicator.details.panel.failure.evidence.status, 'insufficient')
  assert.equal(failedAdjudicator.details.panel.failure.evidence.summary, 'adjudicator timeout')
  assert.deepEqual(failedAdjudicatorIo.calls.assign.map(({ role }) => role), ['reviewer', 'tech-lead', 'lead'])
})

test('F1 review_panel retains dismissed provenance outside actionable findings', () => {
  const dismissed = panelEnvelope({ role: 'reviewer', findings: [PANEL_DIVERGENCE] })
  const io = strictPanelIo({
    reviewer: dismissed,
    adjudicator: panelEnvelope({ role: 'lead', details: { adjudications: [{ id: PANEL_DIVERGENCE.id, disposition: 'dismiss', reason: 'the evidence does not establish a defect' }] } }),
  })
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.outcome, 'no-findings')
  assert.deepEqual(result.details.findings, [])
  assert.deepEqual(result.details.panel.findings, [{
    id: PANEL_DIVERGENCE.id, raised_by: ['reviewer'], panel_disposition: 'dismissed', reason: 'the evidence does not establish a defect',
  }])
})

test('RV1-1 review_panel remints duplicate source ids with their own evidence', () => {
  const first = { id: 'F1', severity: 'must-fix', location: 'a.mjs:1', summary: 'first finding', evidence: 'first evidence', disposition: 'no-op' }
  const second = { id: 'F1', severity: 'consider', location: 'b.mjs:9', summary: 'second finding', evidence: 'second evidence', disposition: 'no-op' }
  const io = strictPanelIo({
    reviewer: panelEnvelope({ role: 'reviewer', findings: [first, second] }),
    adjudicator: panelEnvelope({ role: 'lead', details: { adjudications: [
      { id: 'F1', disposition: 'uphold', reason: 'first finding is actionable' },
      { id: 'panel-remint-1', disposition: 'uphold', reason: 'second finding is actionable' },
    ] } }),
  })
  const result = driveTask(panelContext(), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.findings, [
    first,
    { ...second, id: 'panel-remint-1' },
  ])
  assert.deepEqual(result.details.panel.findings, [
    { id: 'F1', raised_by: ['reviewer'], panel_disposition: 'upheld', reason: 'first finding is actionable' },
    { id: 'panel-remint-1', raised_by: ['reviewer'], panel_disposition: 'upheld', reason: 'second finding is actionable' },
  ])
})

test('RV1-2 review_panel refuses every invalid adjudication cover', () => {
  const finding = { ...PANEL_DIVERGENCE, id: 'panel-adjudication-finding' }
  const valid = { id: finding.id, disposition: 'uphold', reason: 'the finding is actionable' }
  const resultFor = (adjudications) => driveTask(panelContext(), strictPanelIo({
    reviewer: panelEnvelope({ role: 'reviewer', findings: [finding] }),
    adjudicator: panelEnvelope({ role: 'lead', details: { adjudications } }),
  }))
  // Each case asserts its OWN why. Sol measured that a shared-reason assertion is vacuous:
  // neutralising the id predicate stayed GREEN because the later exact-cover check returned the
  // same top-level refusal. MUTATION RV1-2: drop any one predicate in adjudicationDefect and
  // exactly the case naming it reddens.
  for (const [label, adjudications, why] of [
    ['not an array', 'not-an-array', /details\.adjudications must be an array/],
    ['missing id', [{ disposition: 'uphold', reason: 'no id at all' }], /needs a non-empty id/],
    ['blank id', [{ ...valid, id: '   ' }], /needs a non-empty id/],
    ['duplicate', [valid, { ...valid }], /duplicate adjudication id/],
    ['unknown disposition', [{ ...valid, disposition: 'maybe' }], /unknown disposition/],
    ['blank reason', [{ ...valid, reason: ' ' }], /needs a non-empty reason/],
    ['missing cover', [], /adjudications omit divergent ids; missing=\["panel-adjudication-finding"\]/],
    ['extra cover', [valid, { ...valid, id: 'extra-adjudication' }], /adjudications name ids that are not divergent; extra=\["extra-adjudication"\]/],
  ]) {
    const result = resultFor(adjudications)
    assert.equal(result.status, 'escalation', label)
    assert.equal(result.details.panel.failure.reason, 'panel-adjudication-invalid', label)
    assert.match(result.details.panel.failure.why, why, label)
  }

  // The seat contract names TOP-LEVEL details.adjudications. A nested details.panel.adjudications
  // form was accepted by an undeclared fallback and nothing guarded its removal.
  // MUTATION RV1-2-nested: restore the fallback at the adjudications assignment and this reddens.
  const nested = driveTask(panelContext(), strictPanelIo({
    reviewer: panelEnvelope({ role: 'reviewer', findings: [finding] }),
    adjudicator: panelEnvelope({ role: 'lead', details: { panel: { adjudications: [valid] } } }),
  }))
  assert.equal(nested.status, 'escalation')
  assert.equal(nested.details.panel.failure.reason, 'panel-adjudication-invalid')
  assert.match(nested.details.panel.failure.why, /details\.adjudications must be an array/)
})

test('H1 review_only remains byte-identical under panel execution', () => {
  assert.equal(JSON.stringify(VARIANTS.review_only.required_seats), JSON.stringify(['reviewer']))
  assert.deepEqual(VARIANTS.review_only.stages, ['review_only', 'scope-gate', 'envelope-accept'])
  const env = reviewEnvelope({ outcome: 'no-findings', findings: [] })
  const io = strictReviewIo(env)
  const result = driveTask(REVIEW_CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.map(({ role }) => role), ['reviewer'])
  assert.deepEqual(result.details.envelope.values, env.details)
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
})

test('J1 review_only declaration remains byte-identical', () => {
  const expected = {
    execution: 'envelope',
    required_seats: ['reviewer'],
    stages: ['review_only', 'scope-gate', 'envelope-accept'],
    off_critical_path_stages: [],
    writes: 'none',
    accepted_by: 'structured envelope plus zero-write proof; no commit',
    strict_identity: true,
    report_values: true,
    envelope_fields: [
      { name: 'base', kind: 'text' }, { name: 'head', kind: 'text' },
      { name: 'outcome', kind: 'text', values: ['findings', 'no-findings'] },
      {
        name: 'findings', kind: 'records', allow_empty: true,
        item_fields: ['id', 'severity', 'location', 'summary', 'evidence', 'disposition'],
        item_values: { severity: ['must-fix', 'should-fix', 'consider'], disposition: ['auto-fix', 'ask-user', 'no-op'] },
        item_patterns: { id: '^[A-Za-z0-9_-]{1,64}$' },
        cardinality: { discriminator: 'outcome', empty: 'no-findings', nonempty: 'findings' },
      },
      { name: 'reviewed_files', kind: 'paths', allow_empty: true },
      {
        name: 'unreviewable_files', kind: 'records', allow_empty: true,
        item_fields: ['path', 'reason'],
        item_values: { reason: ['binary', 'generated', 'too-large', 'out-of-context'] },
      },
    ],
    assignment: 'Review the returned base/head identity and the declared change set as a read-only code review. This assignment supersedes the ordinary reviewer deliverable: do not create, edit, delete, checkout, or commit anything in the checkout. Read-only validation is permitted. Return the complete structured envelope with non-empty base and head, outcome findings or no-findings, reviewed_files as an array of paths, and unreviewable_files as records with path and reason; every unreviewable reason must be binary, generated, too-large, or out-of-context, every listed path must belong to the base/head change set, and reviewed_files and unreviewable_files must be disjoint. Return findings records containing id, severity, location, summary, evidence, and disposition; findings must be empty exactly when outcome is no-findings and non-empty when outcome is findings.',
  }
  assert.equal(JSON.stringify(VARIANTS.review_only), JSON.stringify(expected))
})

test('J2 review_only stages remain byte-identical', () => {
  const io = strictReviewIo(reviewEnvelope())
  const result = driveTask(REVIEW_CTX, io)
  assert.deepEqual(VARIANTS.review_only.stages, ['review_only', 'scope-gate', 'envelope-accept'])
  assert.deepEqual(result.details.stages, ['review_only:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
})

test('screener wiring B1', () => {
  const ordinaryIo = injectedScreenerIo()
  driveTask({ ...CTX, head: 'base-head' }, ordinaryIo)
  assert.match(ordinaryIo.calls.writes[`${TD}/review-brief-1.md`], /screen-1/)

  const panelIo = injectedScreenerIo({ panel: true })
  driveTask({ ...D_PANEL_CTX, head: 'base-head' }, panelIo)
  for (const name of ['panel-a-brief-1.md', 'panel-b-brief-1.md']) {
    assert.match(panelIo.calls.writes[`${TD}/${name}`], /screen-1/)
  }
})

test('screener wiring C1', () => {
  const hostile = { ...SCREENER_PROPOSAL, severity: 'must-fix', blocking: true, failure: true, verdict: 'changes-needed', stage: 'escalate' }
  const io = injectedScreenerIo({ child: screenerResult([hostile]) })
  const result = driveTask({ ...CTX, head: 'base-head' }, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.accepted_via, 'review pass')
  assert.equal(io.calls.logs.some((row) => row.screener_proposal?.outcome === 'unadjudicated'), true)
  assert.equal(result.details.stages.some((stage) => stage.includes('screener')), false)
})

test('screener wiring D1', () => {
  const adjudications = [{ proposal_id: 'screen-1', outcome: 'adopted', finding_id: 'finding-1' }]
  const reviewer = reviewEnv('pass', [REVIEW_FINDING])
  reviewer.details.adjudications = adjudications
  const io = injectedScreenerIo({ reviewer })
  driveTask({ ...CTX, head: 'base-head' }, io)
  const rows = io.calls.logs.map((entry) => entry.screener_proposal).filter(Boolean)
  assert.deepEqual(rows, [{
    round: 1, proposal_id: 'screen-1', axis: 'correctness', model: 'screen-model', outcome: 'adopted', finding_id: 'finding-1',
  }])
  const adopted = screenerAdjudicationRows([SCREENER_PROPOSAL], adjudications, [{
    id: 'finding-1', severity: 'should-fix', location: 'src/example.mjs:12', summary: 'the reviewed change needs a follow-up', disposition: 'ask-user',
  }])
  assert.deepEqual(adopted.adopted, [{
    id: 'finding-1', severity: 'should-fix', location: 'src/example.mjs:12', summary: 'the reviewed change needs a follow-up', disposition: 'ask-user',
  }])
  assert.equal(adopted.adopted[0].source, undefined)
  assert.equal(adopted.adopted[0].status, undefined)
})

test('screener wiring E1', () => {
  const io = injectedScreenerIo({
    reviewerDetails: {
      adjudications: [{ proposal_id: 'screen-1', outcome: 'rejected', reason: 'first line\nsecond line' }],
    },
  })
  driveTask({ ...CTX, head: 'base-head' }, io)
  const row = io.calls.logs.map((entry) => entry.screener_proposal).find(Boolean)
  assert.equal(row.outcome, 'rejected')
  assert.equal(row.reason, 'first line second line')
})

test('screener wiring F1', () => {
  const io = injectedScreenerIo()
  driveTask({ ...CTX, head: 'base-head' }, io)
  const row = io.calls.logs.map((entry) => entry.screener_proposal).find(Boolean)
  assert.equal(row.model, 'screen-model')
})

test('screener wiring F2', () => {
  const accepted = reviewEnv('pass', [REVIEW_FINDING])
  accepted.details.adjudications = [{ proposal_id: 'screen-1', outcome: 'adopted', finding_id: 'finding-1' }]
  const acceptedIo = injectedScreenerIo({ reviewer: accepted })
  driveTask({ ...CTX, head: 'base-head' }, acceptedIo)
  assert.equal(acceptedIo.calls.logs.map((entry) => entry.screener_proposal).find(Boolean).outcome, 'adopted')

  const thrownIo = injectedScreenerIo()
  const wait = thrownIo.wait.bind(thrownIo)
  thrownIo.wait = (returnPath, timeoutS) => {
    if (returnPath === 'reviewer:1') throw new Error('reviewer transport failed')
    return wait(returnPath, timeoutS)
  }
  driveTask({ ...CTX, head: 'base-head' }, thrownIo)
  assert.equal(thrownIo.calls.logs.map((entry) => entry.screener_proposal).find(Boolean).outcome, 'unadjudicated')

  const refusedIo = injectedScreenerIo({ reviewer: { status: 'insufficient', role: 'reviewer', summary: 'silent', artifacts: [], details: {} } })
  driveTask({ ...CTX, head: 'base-head' }, refusedIo)
  assert.equal(refusedIo.calls.logs.map((entry) => entry.screener_proposal).find(Boolean).outcome, 'unadjudicated')

  const panelAccepted = reviewEnv('pass', [REVIEW_FINDING])
  panelAccepted.details.adjudications = [{ proposal_id: 'screen-1', outcome: 'adopted', finding_id: 'finding-1' }]
  const panelIo = injectedScreenerIo({ panel: true, reviewer: panelAccepted })
  const panelWait = panelIo.wait.bind(panelIo)
  panelIo.wait = (returnPath, timeoutS) => {
    if (returnPath === 'tech-lead:1') throw new Error('partner transport failed')
    return panelWait(returnPath, timeoutS)
  }
  driveTask({ ...D_PANEL_CTX, head: 'base-head' }, panelIo)
  assert.equal(panelIo.calls.logs.map((entry) => entry.screener_proposal).find(Boolean).outcome, 'adopted')
})

test('screener wiring G1', () => {
  const second = { ...SCREENER_PROPOSAL, id: 'screen-2', axis: 'scope' }
  const io = injectedScreenerIo({
    child: screenerResult([SCREENER_PROPOSAL, second]),
    reviewerDetails: {
      adjudications: [
        { proposal_id: 'screen-1', outcome: 'adopted', finding_id: 'finding-1' },
        { proposal_id: 'screen-2', outcome: 'rejected', reason: 'not in scope' },
      ],
      findings: [REVIEW_FINDING],
    },
  })
  driveTask({ ...CTX, head: 'base-head' }, io)
  const panel = io.calls.logs.map((entry) => entry.screener_panel).find(Boolean)
  const rows = io.calls.logs.map((entry) => entry.screener_proposal).filter(Boolean)
  const numerator = rows.filter(({ outcome }) => outcome === 'adopted').length
  const denominator = rows.length
  assert.equal(panel.proposals, denominator)
  assert.equal(numerator, 1)
  assert.equal(denominator, 2)
})

test('screener wiring H1', () => {
  const baseIo = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    files: { [`${TD}/plan.md`]: '# accepted plan' },
  })
  const base = driveTask({ ...CTX, head: 'base-head' }, baseIo)
  const absentIo = injectedScreenerIo({ register: JSON.stringify({ local_providers: {} }) })
  const absent = driveTask({ ...CTX, head: 'base-head' }, absentIo)
  const deadIo = injectedScreenerIo({ models: { ok: false, output: 'connection refused' } })
  const dead = driveTask({ ...CTX, head: 'base-head' }, deadIo)
  const zeroMembers = ['correctness', 'contract-drift', 'vacuity', 'scope'].map((axis) => ({ axis, model: 'screen-model', status: 'unanswered' }))
  const zeroIo = injectedScreenerIo({ child: screenerResult([], zeroMembers) })
  const zero = driveTask({ ...CTX, head: 'base-head' }, zeroIo)
  const shape = (result, io) => ({
    assignments: io.calls.assign.map(({ role, note, briefFile }) => ({ role, note, briefFile })),
    stages: result.details.stages,
    verdict: result.details.verdict,
    journal: io.calls.logs,
  })
  const expected = shape(base, baseIo)
  assert.deepEqual(shape(absent, absentIo), expected)
  assert.deepEqual(shape(dead, deadIo), expected)
  assert.deepEqual(shape(zero, zeroIo), expected)
})

test('screener wiring I1', () => {
  const zeroMembers = ['correctness', 'contract-drift', 'vacuity', 'scope'].map((axis) => ({ axis, model: 'screen-model', status: 'unanswered' }))
  const io = injectedScreenerIo({ child: screenerResult([], zeroMembers) })
  driveTask({ ...CTX, head: 'base-head' }, io)
  assert.equal(io.calls.logs.some((row) => row.screener_panel || row.screener_proposal), false)
})

const prescriptionPatch = (file) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1 @@',
  '-const old = 1',
  '+const next = 1',
  '',
].join('\n')

const prescriptionFinding = (over = {}) => ({
  id: 'F1', severity: 'must-fix', location: 'a.test.mjs:1', summary: 'the implementation defect', disposition: 'ask-user', ...over,
})

const readWitness = (file = 'a.test.mjs') => new Map([[file, { state: 'read', bytes: 'export const witnessed = true\n' }]])

test('A1 hardening prescription conflict stops at review accept', () => {
  const finding = { ...B376_FINDING, location: 'a.mjs:1', disposition: 'auto-fix', patch: prescriptionPatch('a.test.mjs') }
  const io = b376ProofIo({ reviewer1: reviewEnv('changes-needed', [finding]) })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  const conflict = result.details.hardening_prescription_conflict
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.equal(conflict.reason, 'pinned-test-prescription')
  assert.equal(conflict.file, 'a.test.mjs')
  assert.equal(conflict.finding.id, 'F1')
  assert.equal(dGitApplies(io).length, 0)
  assert.equal(io.calls.assign.some(({ role, n }) => role === 'builder' && n === 2), false)
})

test('B1 hardening prescription conflict has a closed reason', () => {
  assert.deepEqual(HARDENING_PRESCRIPTION_REASONS, ['pinned-test-prescription'])
  assert.equal(Object.isFrozen(HARDENING_PRESCRIPTION_REASONS), true)
  assert.equal(HARDENING_PRESCRIPTION_RESOLUTION, 'refuse-prescription')
  for (const reason of ['build', 'harden', 'review-unresolved', 'anchor-absent']) {
    assert.equal(HARDENING_PRESCRIPTION_REASONS.includes(reason), false)
  }
})

test('C1 unpinned review prescriptions remain unaffected', () => {
  const details = { findings: [prescriptionFinding({ location: 'a.test.mjs:1', disposition: 'auto-fix', patch: prescriptionPatch('other.test.mjs') })] }
  assert.equal(hardeningPrescriptionConflict(details, readWitness()), null)
})

test('D1 pinned test edits cannot substitute for implementation repair', () => {
  const io = b376ProofIo({ proofOutputs: [B376_GREEN, B376_GREEN, B376_MUT_RED] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.equal(row.outcome, 'pre-repair-green')
})

test('E1 conflict records the chosen prescription refusal', () => {
  const finding = { ...B376_FINDING, location: 'a.mjs:1', disposition: 'auto-fix', patch: prescriptionPatch('a.test.mjs') }
  const io = b376ProofIo({ reviewer1: reviewEnv('changes-needed', [finding]) })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  const conflict = result.details.hardening_prescription_conflict
  assert.equal(conflict.resolution, 'refuse-prescription')
  assert.equal(conflict.finding.id, finding.id)
  assert.equal(conflict.file, 'a.test.mjs')
})

test('F1 review without a hardening witness remains unaffected', () => {
  const details = { findings: [prescriptionFinding()] }
  assert.equal(hardeningPrescriptionConflict(details, undefined), null)
  assert.equal(hardeningPrescriptionConflict(details, null), null)
  assert.equal(hardeningPrescriptionConflict(details, new Map()), null)
})

test('G1 ungateable findings do not create prescription conflicts', () => {
  const details = { findings: [prescriptionFinding({ hardening: 'ungateable', hardening_why: 'the defect cannot become a guard' })] }
  assert.equal(hardeningPrescriptionConflict(details, readWitness()), null)
})

test('H1 no-op findings do not create prescription conflicts', () => {
  const details = { findings: [prescriptionFinding({ disposition: 'no-op' })] }
  assert.equal(hardeningPrescriptionConflict(details, readWitness()), null)
})

test('J1 only readable witness cells can conflict', () => {
  const details = { findings: [prescriptionFinding()] }
  assert.equal(hardeningPrescriptionConflict(details, new Map([['a.test.mjs', { state: 'absent', bytes: null }]])), null)
  assert.equal(hardeningPrescriptionConflict(details, new Map([['a.test.mjs', { state: 'unreadable', bytes: null, why: 'EACCES' }]])), null)
})

test('K1 conflict extraction requires the shared test path', () => {
  const details = { findings: [prescriptionFinding({ location: 'checks.mjs:1' })] }
  const witness = new Map([['checks.mjs', { state: 'read', bytes: 'export const witnessed = true\n' }]])
  assert.equal(hardeningPrescriptionConflict(details, witness), null)
  assert.equal(hardeningTestPath('checks.mjs'), false)
})

const prescriptionBlob = (path) => `100644 blob ${'a'.repeat(40)}\t${path}\0`
const prescriptionRead = (path, bytes = 'one\ntwo\nthree\n') => new Map([[path, { state: 'read', bytes }]])
const prescriptionAuthored = (path, spans, reason = null) => new Map([[path, { spans, reason }]])
const prescriptionPathSpan = (path, start, end = start) => ({ path, start, end })

function prescriptionRuntimeIo(io, { base = '', diff = '' } = {}) {
  const originalRun = io.run
  const calls = []
  io.run = function (cmd) {
    if (cmd.startsWith('git ls-tree -z --full-tree ')) {
      calls.push({ kind: 'tree', cmd })
      return typeof base === 'function' ? base(cmd, calls) : { ok: true, output: base }
    }
    if (cmd.startsWith("git diff --unified=0 'base-head' -- ")) {
      calls.push({ kind: 'diff', cmd })
      return typeof diff === 'function' ? diff(cmd, calls) : { ok: true, output: diff }
    }
    return originalRun.call(this, cmd)
  }
  io.prescriptionCalls = calls
  return io
}

const contextfulPrescriptionPatch = [
  'diff --git a/a.test.mjs b/a.test.mjs',
  '--- a/a.test.mjs',
  '+++ b/a.test.mjs',
  '@@ -1,3 +1,3 @@',
  ' context before',
  '-lane old',
  '+lane new',
  ' context after',
  '',
].join('\n')

const basePresentAuthoredDiff = [
  'diff --git a/a.test.mjs b/a.test.mjs',
  'index aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 100644',
  '--- a/a.test.mjs',
  '+++ b/a.test.mjs',
  '@@ -2,1 +2,1 @@',
  '-old',
  '+new',
  '',
].join('\n')

test('A1 lane-authored witnessed test lines admit the review prescription', () => {
  const finding = { ...B376_FINDING, disposition: 'auto-fix', patch: contextfulPrescriptionPatch }
  const io = prescriptionRuntimeIo(b376ProofIo({
    reviewer1: reviewEnv('changes-needed', [finding]),
    files: { ...B376_FILES, [`${CTX.checkout}/a.test.mjs`]: 'context before\nlane old\ncontext after\n' },
    runs: {},
  }), { base: prescriptionBlob('a.test.mjs'), diff: basePresentAuthoredDiff })
  const result = driveTask({ ...CTX, head: 'base-head', limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details?.escalation ?? null, null)
  assert.equal(io.prescriptionCalls.filter(({ kind }) => kind === 'tree').length, 1)
  assert.equal(io.prescriptionCalls.filter(({ kind }) => kind === 'diff').length, 1)
  assert.ok(dGitApplies(io).length > 0)
  assert.ok(io.calls.logs.some((entry) => entry.finding_hardened?.outcome === 'killed'))

  const createdPath = 'created.test.mjs'
  const createdFinding = { ...B376_FINDING, location: `${createdPath}:1-2` }
  const createdIo = prescriptionRuntimeIo(b376ProofIo({
    reviewer1: reviewEnv('changes-needed', [createdFinding]),
    files: { ...B376_FILES, [`${CTX.checkout}/${createdPath}`]: 'created one\ncreated two\n' },
    changed: ['a.mjs', 'a.test.mjs', createdPath],
    plan: { files_in_scope: ['a.mjs', 'a.test.mjs', createdPath] },
  }), { base: '' })
  const created = driveTask({ ...CTX, head: 'base-head', limits: { build_rounds: 2 } }, createdIo)
  assert.equal(created.status, 'done')
  assert.equal(created.details?.escalation ?? null, null)
  assert.equal(createdIo.prescriptionCalls.filter(({ kind }) => kind === 'tree').length, 1)
  assert.equal(createdIo.prescriptionCalls.filter(({ kind }) => kind === 'diff').length, 0)
  assert.ok(createdIo.calls.logs.some((entry) => entry.finding_hardened?.outcome === 'killed'))
})

test('B1 pre-existing witnessed test lines keep the pinned prescription refusal', () => {
  const path = 'a.test.mjs'
  const details = { findings: [prescriptionFinding({ location: `${path}:2` })] }
  const witness = prescriptionRead(path)
  const authored = prescriptionAuthored(path, [prescriptionPathSpan(path, 1)])
  assert.equal(prescriptionSpanIsLaneAuthored(prescriptionPathSpan(path, 2), authored), false)
  assert.equal(prescriptionSpansAreLaneAuthored([prescriptionPathSpan(path, 2)], authored), false)
  const conflict = hardeningPrescriptionConflict(details, witness, authored)
  assert.equal(conflict?.reason, HARDENING_PRESCRIPTION_REASONS[0])
  assert.equal(conflict?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
  assert.equal(conflict?.file, path)
})

test('C1 mixed auto-fix hunks keep the pinned prescription refusal', () => {
  const patch = [
    'diff --git a/a.test.mjs b/a.test.mjs',
    '--- a/a.test.mjs',
    '+++ b/a.test.mjs',
    '@@ -1,3 +1,3 @@',
    ' context before',
    '-lane authored',
    '+replacement one',
    ' context after',
    '@@ -5,3 +5,3 @@',
    ' context before two',
    '-pre-existing',
    '+replacement two',
    ' context after two',
    'diff --git a/a.mjs b/a.mjs',
    '--- a/a.mjs',
    '+++ b/a.mjs',
    '@@ -1 +1 @@',
    '-implementation old',
    '+implementation new',
    '',
  ].join('\n')
  const details = { findings: [prescriptionFinding({ disposition: 'auto-fix', patch })] }
  const witness = prescriptionRead('a.test.mjs', 'context before\nlane authored\ncontext after\nfour\ncontext before two\npre-existing\ncontext after two\n')
  const authored = prescriptionAuthored('a.test.mjs', [prescriptionPathSpan('a.test.mjs', 2)])
  const conflict = hardeningPrescriptionConflict(details, witness, authored)
  assert.equal(conflict?.reason, HARDENING_PRESCRIPTION_REASONS[0])
  assert.equal(conflict?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
  assert.equal(conflict?.file, 'a.test.mjs')

  const unrelatedPatch = [
    'diff --git a/a.test.mjs b/a.test.mjs',
    '--- a/a.test.mjs',
    '+++ b/a.test.mjs',
    '@@ -2 +2 @@',
    '-lane authored',
    '+replacement',
    'diff --git a/a.mjs b/a.mjs',
    '--- a/a.mjs',
    '+++ b/a.mjs',
    '@@ -1 +1 @@',
    '-pre-existing implementation',
    '+replacement implementation',
    '',
  ].join('\n')
  const unrelated = hardeningPrescriptionConflict(
    { findings: [prescriptionFinding({ disposition: 'auto-fix', patch: unrelatedPatch })] },
    prescriptionRead('a.test.mjs', 'one\nlane authored\nthree\n'),
    prescriptionAuthored('a.test.mjs', [prescriptionPathSpan('a.test.mjs', 2)]),
  )
  assert.equal(unrelated, null)
})

test('RV1-1 same-path patch sections retain every witnessed test coordinate', () => {
  const path = 'a.test.mjs'
  const patch = (firstBody) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -5 +5 @@',
    ...firstBody,
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -2 +2 @@',
    '-authored',
    '+replacement two',
    '',
  ].join('\n')
  const witness = prescriptionRead(path, 'one\nauthored\nthree\nfour\npre-existing\n')
  const authored = prescriptionAuthored(path, [prescriptionPathSpan(path, 2)])
  for (const firstBody of [
    ['-pre-existing', '+replacement one'],
    ['-pre-existing', '+replacement one', '+unexpected addition'],
  ]) {
    const details = { findings: [prescriptionFinding({ disposition: 'auto-fix', patch: patch(firstBody) })] }
    const conflict = hardeningPrescriptionConflict(details, witness, authored)
    assert.equal(conflict?.reason, HARDENING_PRESCRIPTION_REASONS[0])
    assert.equal(conflict?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
    assert.equal(conflict?.file, path)
  }
})

test('RV2-1 test hunk content matches its witnessed header coordinates', () => {
  const path = 'a.test.mjs'
  const witness = prescriptionRead(path, 'a\nb\nc\nd\ne\nf\ng\n')
  const shiftedPatch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -2,3 +2,3 @@',
    ' e',
    '-f',
    '+X',
    ' g',
    '',
  ].join('\n')
  const shifted = hardeningPrescriptionConflict(
    { findings: [prescriptionFinding({ disposition: 'auto-fix', patch: shiftedPatch })] },
    witness,
    prescriptionAuthored(path, [prescriptionPathSpan(path, 3)]),
    witness,
  )
  assert.equal(shifted?.reason, HARDENING_PRESCRIPTION_REASONS[0])
  assert.equal(shifted?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)

  const repeatedPatch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -2 +2 @@',
    '-b',
    '+B',
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -3 +3 @@',
    '-c',
    '+C',
    '',
  ].join('\n')
  const repeated = hardeningPrescriptionConflict(
    { findings: [prescriptionFinding({ disposition: 'auto-fix', patch: repeatedPatch })] },
    witness,
    prescriptionAuthored(path, [prescriptionPathSpan(path, 2, 3)]),
    witness,
  )
  assert.equal(repeated?.reason, HARDENING_PRESCRIPTION_REASONS[0])
  assert.equal(repeated?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
})

test('D1 unresolvable witnessed test locations keep the pinned prescription refusal', () => {
  const path = 'a.test.mjs'
  const witness = prescriptionRead(path)
  const unresolved = prescriptionAuthored(path, [], 'unknown evidence')
  for (const location of [
    `${path}:0`, `${path}:2-1`, `${path}:9007199254740992`, `${path}:1-9007199254740992`, `${path}:bad`, `${path}:1-2-3`,
  ]) {
    assert.doesNotThrow(() => {
      const conflict = hardeningPrescriptionConflict({ findings: [prescriptionFinding({ location })] }, witness, unresolved)
      assert.equal(conflict?.reason, HARDENING_PRESCRIPTION_REASONS[0])
      assert.equal(conflict?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
      assert.equal(conflict?.file, path)
    })
  }
  const valid = { findings: [prescriptionFinding({ location: `${path}:1` })] }
  const evidenceCases = [
    { run: () => ({ ok: false, output: '' }) },
    { run: () => ({ ok: true, output: 'not an ls-tree record' }) },
    { run: () => { throw new Error('interrupted') } },
    {
      run: (cmd) => cmd.startsWith('git ls-tree')
        ? { ok: true, output: prescriptionBlob(path) }
        : { ok: true, output: '@@ malformed hunk' },
    },
  ]
  for (const io of evidenceCases) {
    const evidence = prescriptionAuthorshipEvidence(valid, witness, { head: 'base-head' }, io)
    assert.equal(evidence.get(path)?.reason === null, false)
    assert.doesNotThrow(() => assert.equal(hardeningPrescriptionConflict(valid, witness, evidence)?.reason, HARDENING_PRESCRIPTION_REASONS[0]))
  }
})

test('E1 existing pinned prescription contracts remain unchanged', () => {
  const path = 'a.test.mjs'
  const witness = prescriptionRead(path)
  const ordinary = { findings: [prescriptionFinding({ location: `${path}:1` })] }
  assert.deepEqual(HARDENING_PRESCRIPTION_REASONS, ['pinned-test-prescription'])
  assert.equal(Object.isFrozen(HARDENING_PRESCRIPTION_REASONS), true)
  assert.equal(HARDENING_PRESCRIPTION_RESOLUTION, 'refuse-prescription')
  assert.equal(hardeningPrescriptionConflict(ordinary, witness)?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
  for (const location of [undefined, '', ':bad', 'unrelated prose']) {
    assert.equal(hardeningPrescriptionConflict({ findings: [prescriptionFinding({ location })] }, witness), null)
  }
  assert.equal(hardeningPrescriptionConflict(ordinary, undefined), null)
  assert.equal(hardeningPrescriptionConflict(ordinary, new Map()), null)
  assert.equal(hardeningPrescriptionConflict(ordinary, new Map([[path, { state: 'unreadable', bytes: null }]])), null)
  assert.equal(hardeningPrescriptionConflict({ findings: [prescriptionFinding({ location: 'checks.mjs:1' })] }, new Map([['checks.mjs', { state: 'read', bytes: 'x\n' }]])), null)
  assert.equal(hardeningPrescriptionConflict({ findings: [prescriptionFinding({ disposition: 'no-op' })] }, witness), null)
  assert.equal(hardeningPrescriptionConflict({ findings: [prescriptionFinding({ hardening: 'ungateable', hardening_why: 'no guard' })] }, witness), null)

  const deletionPatch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -2,1 +2,0 @@',
    '-two',
    '',
  ].join('\n')
  const deletion = { findings: [prescriptionFinding({ disposition: 'auto-fix', patch: deletionPatch })] }
  const authoredDeletion = prescriptionAuthored(path, [prescriptionPathSpan(path, 2)])
  assert.equal(hardeningPrescriptionConflict(deletion, witness, authoredDeletion), null)

  for (const patch of [
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -0,0 +1,1 @@',
      '+inserted',
      '',
    ].join('\n'),
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +2,2 @@',
      ' unchanged context',
      '+inserted',
      '',
    ].join('\n'),
  ]) {
    const insertion = { findings: [prescriptionFinding({ disposition: 'auto-fix', patch })] }
    const conflict = hardeningPrescriptionConflict(insertion, witness, prescriptionAuthored(path, [prescriptionPathSpan(path, 1, 3)]))
    assert.equal(conflict?.reason, HARDENING_PRESCRIPTION_REASONS[0])
    assert.equal(conflict?.resolution, HARDENING_PRESCRIPTION_RESOLUTION)
  }
})

test('A1 created plan scope is accepted', () => {
  const path = 'crew/created-scope.mjs'
  const briefText = ['# Created path', '', '## Where', `${CREATES_MARK}${path}`, '', '## Why', 'the plan creates the absent file'].join('\n')
  assert.deepEqual(createsFromBrief(briefText), [path])
  const io = fakeIo({
    envelopes: {
      'planner:1': s843PlanEnv([...D3_SCOPE_DISPATCHED, path]),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: S843_RUNS, changed: [D3_SCOPE_DISPATCHED[0]], files: { [CTX.briefFile]: briefText },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === D3_SCOPE_HEALTH), false)
  assert.equal(io.calls.run.some(({ cmd }) => cmd.startsWith('git ls-files')), false)
})

test('B1 created plan scope is planned context', () => {
  const path = 'crew/created-scope-context.mjs'
  const briefText = ['# Created path', '', '## Where', `${CREATES_MARK}${path}`, '', '## Why', 'the plan creates the absent file'].join('\n')
  assert.deepEqual(createsFromBrief(briefText), [path])
  const io = fakeIo({
    envelopes: {
      'planner:1': s843PlanEnv([...D3_SCOPE_DISPATCHED, path]),
      'builder:1': buildEnv({ details: { ...buildEnv().details, files_changed: [path] } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: S843_RUNS, changed: [path], files: { [CTX.briefFile]: briefText },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.logs.some((row) => row.scope_gate?.edits?.includes(path)), false)
})

test('B1 warning-leading created plan scope is accepted', () => {
  const path = 'crew/created-scope.mjs'
  const briefText = ['# Created path', '', '## Where', `warning · created · ${path} · reason: creates-parent-missing`, '', '## Why', 'the plan creates the absent file'].join('\n')
  assert.deepEqual(createsFromBrief(briefText), [path])
  const io = fakeIo({
    envelopes: {
      'planner:1': s843PlanEnv([...D3_SCOPE_DISPATCHED, path]),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: S843_RUNS, changed: [D3_SCOPE_DISPATCHED[0]], files: { [CTX.briefFile]: briefText },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(s843Rows(io).some(({ verdict }) => verdict === 'plan-scope-malformed'), false)
})

test('F1 legacy marked warning plan scope is accepted', () => {
  const path = 'crew/created-scope.mjs'
  const briefText = ['# Created path', '', '## Where', `${CREATES_MARK}${path} · warning: parent is unresolved`, '', '## Why', 'the plan creates the absent file'].join('\n')
  assert.deepEqual(createsFromBrief(briefText), [path])
  const io = fakeIo({
    envelopes: {
      'planner:1': s843PlanEnv([...D3_SCOPE_DISPATCHED, path]),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: S843_RUNS, changed: [D3_SCOPE_DISPATCHED[0]], files: { [CTX.briefFile]: briefText },
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(s843Rows(io).some(({ verdict }) => verdict === 'plan-scope-malformed'), false)
})

test('warning-leading created rows with incomplete fields are ignored', () => {
  for (const line of [
    'warning · created · crew/created-scope.mjs',
    'warning · created ·  · reason: creates-parent-missing',
    'warning · created · crew/created-scope.mjs · reason: ',
  ]) {
    const briefText = ['# Created path', '', '## Where', line, '', '## Why', 'the plan creates the absent file'].join('\n')
    assert.deepEqual(createsFromBrief(briefText), [], line)
  }
})

test('C1 undeclared untracked plan scope is refused', () => {
  const declared = 'crew/created-scope-whitespace.mjs'
  const cases = [
    { name: 'undeclared', path: 'crew/created-scope-untracked.mjs', creates: [] },
    { name: 'whitespace-distinct', path: `${declared} `, creates: [declared] },
  ]
  for (const scenario of cases) {
    const briefText = ['# Created path', '', '## Where', ...scenario.creates.map((path) => `${CREATES_MARK}${path}`), '', '## Why', 'the plan creates the absent file'].join('\n')
    assert.deepEqual(createsFromBrief(briefText), scenario.creates, scenario.name)
    const inventory = d3ScopeInventory(scenario.path)
    const io = fakeIo({
      envelopes: {
        'planner:1': s843PlanEnv([...D3_SCOPE_DISPATCHED, scenario.path]),
        'builder:1': buildEnv(),
      },
      runs: {
        ...S843_RUNS,
        [D3_SCOPE_HEALTH]: { ok: true, output: '' },
        [inventory]: { ok: false, output: '' },
      },
      changed: [D3_SCOPE_DISPATCHED[0]], files: { [CTX.briefFile]: briefText },
    })
    const result = driveTask(d3ScopeCtx(), io)
    assert.equal(result.status, 'escalation', scenario.name)
    assert.equal(result.details.escalation.where, PLAN_SCOPE.malformed, scenario.name)
    assert.ok(result.details.escalation.why.includes(scenario.path), scenario.name)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0, scenario.name)
  }
})

test('D1 malformed refusal names path and correction', () => {
  const candidate = D3_SCOPE_DISPATCHED[0]
  const bad = 'crew/drive-fixtures.mennials'
  const inventory = d3ScopeInventory(bad)
  const io = fakeIo({
    envelopes: {
      'planner:1': s843PlanEnv([candidate, bad]),
      'builder:1': buildEnv(),
    },
    runs: {
      ...S843_RUNS,
      [D3_SCOPE_HEALTH]: { ok: true, output: '' },
      [inventory]: { ok: false, output: '' },
    },
    changed: [candidate],
  })
  const result = driveTask(d3ScopeCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, PLAN_SCOPE.malformed)
  assert.ok(result.details.escalation.why.includes(bad))
  assert.ok(result.details.escalation.why.includes(`did you mean ${candidate}, which is in your surface?`))
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

// The falsification rules (KiroCrew-derived, Apache-2.0, see THIRD-PARTY-NOTICES.md) were
// written for reviewers and reached none of them: `scripts/factory/pr-review.mjs` pastes
// them into a PR-review brief, but a LANE reviewer saw only its charter. They are not a
// capability grant — claude accepts skill grants through its session --plugin-dir, but
// these review-specific rules are brief text, not a skill — so the brief carries them,
// from the one file, to every reviewing seat whatever agent it runs.
// Mutation killed: dropping the lines from the ordinary review brief; dropping them from
// the panel seat brief; swallowing an unreadable file instead of stating it.
test('every reviewing seat is briefed with the falsification rules, from the one file', () => {
  const rules = readFileSync(join(REPO_ROOT, FALSIFICATION_PATH), 'utf8').trim()
  const opening = rules.split('\n').find((line) => line.startsWith('How a finding earns'))
  assert.ok(opening, 'the rules file still opens with its own sentence')

  // The fake io serves the rules file the way a real checkout does; every other read is
  // untouched, so this proves the brief carries what the file says, not a fixture of it.
  const serveRules = (io, checkout) => {
    const base = io.readFile.bind(io)
    io.readFile = (path) => (path === `${checkout}/${FALSIFICATION_PATH}` ? rules : base(path))
    return io
  }
  const ordinaryIo = serveRules(injectedScreenerIo(), CTX.checkout)
  driveTask({ ...CTX, head: 'base-head' }, ordinaryIo)
  const ordinary = ordinaryIo.calls.writes[`${TD}/review-brief-1.md`]
  assert.ok(ordinary.includes(FALSIFICATION_HEADING), 'the ordinary review brief carries the heading')
  assert.ok(ordinary.includes(opening), 'and the rules themselves, not a summary of them')

  // The in-lane panel, whose seat briefs extend the ordinary one.
  const panelIo = serveRules(injectedScreenerIo({ panel: true }), D_PANEL_CTX.checkout)
  driveTask({ ...D_PANEL_CTX, head: 'base-head' }, panelIo)
  for (const name of ['panel-a-brief-1.md', 'panel-b-brief-1.md']) {
    const brief = panelIo.calls.writes[`${TD}/${name}`]
    assert.ok(brief.includes(FALSIFICATION_HEADING), `${name} carries the heading`)
    assert.ok(brief.includes(opening), `${name} carries the rules`)
  }

  // And the review_panel VARIANT, which builds its own seat briefs from scratch — a
  // separate carrier that the in-lane assertions above cannot see.
  const variantIo = serveRules(strictPanelIo(), CTX.checkout)
  driveTask(panelContext(), variantIo)
  for (const name of ['review-panel-reviewer-r1.md', 'review-panel-tech-lead-r1.md']) {
    const brief = variantIo.calls.writes[`${TD}/${name}`]
    assert.ok(brief, `${name} was written`)
    assert.ok(brief.includes(FALSIFICATION_HEADING), `${name} carries the heading`)
    assert.ok(brief.includes(opening), `${name} carries the rules`)
  }
})

// Unknown is stated, never dropped: a reviewer told nothing would judge on the verdict
// contract alone without knowing the rules were missing.
test('an unreadable rules file is named in the brief rather than silently omitted', () => {
  for (const [why, reader] of [
    ['throws', () => { throw new Error('gone') }],
    ['empty', () => '   '],
  ]) {
    const lines = falsificationLines({ readFile: reader }, '/checkout')
    assert.ok(lines.at(-1).startsWith(FALSIFICATION_ABSENT), `${why}: the absence is stated`)
    assert.ok(lines.at(-1).includes(FALSIFICATION_PATH), `${why}: it names the file`)
    assert.equal(lines.includes(FALSIFICATION_HEADING), false, `${why}: no heading over nothing`)
  }
})

const b646Killed = (n) => ({ id: `b646-killed-${n}`, path: 'a.mjs', line: n, operator: 'literal', replacement: 'const value = false', outcome: 'killed' })
const b646FileReport = () => diffReport(
  [...Array.from({ length: 7 }, (_, index) => b646Killed(index + 1)),
    { id: 'b646-skipped-1', path: 'a.mjs', line: 8, operator: null, outcome: 'skipped', skip_reason: 'comment-or-blank' }],
  { total_candidates: 8, skip_counts: { 'comment-or-blank': 1 } },
)
const diffProofRow = (io) => io.calls.logs.find((entry) => entry.diff_mutation_proof)?.diff_mutation_proof

test('A1 recovers valid on-disk diff report without sentinel', () => {
  const io = diffDriverIo({ report: null, reportFile: b646FileReport() })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const row = diffProofRow(io)
  assert.equal(row.generated, 8)
  assert.equal(row.killed, 7)
  assert.equal(row.survived, 0)
  assert.equal(row.skipped, 1)
  assert.deepEqual(row.skip_counts, { 'comment-or-blank': 1 })
  assert.equal(row.mutants.length, 8)
  assert.equal(row.report_source, 'report-file')
  assert.equal(row.skip_counts['runner-unavailable'], undefined)
})

test('B1 rejects invalid on-disk diff report through shared validation', () => {
  const io = diffDriverIo({ report: null, reportFile: diffReport([diffSurvivor], { generation: 2 }) })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const row = diffProofRow(io)
  assert.deepEqual(row.skip_counts, { 'runner-unavailable': 1 })
  assert.equal(row.generated, 0)
  assert.equal(row.survived, 0)
})

test('C1 uses runner-unavailable only when both report sources are invalid', () => {
  const sentinelOnly = diffDriverIo({ report: diffReport([diffSurvivor]), reportFile: diffReport([diffSurvivor], { generation: 2 }) })
  assert.equal(driveTask(CTX, sentinelOnly).status, 'done')
  const sentinelRow = diffProofRow(sentinelOnly)
  assert.equal(sentinelRow.survived, 1)
  assert.equal(sentinelRow.skip_counts['runner-unavailable'], undefined)

  const fileOnly = diffDriverIo({ report: null, reportFile: b646FileReport() })
  assert.equal(driveTask(CTX, fileOnly).status, 'done')
  const fileRow = diffProofRow(fileOnly)
  assert.equal(fileRow.generated, 8)
  assert.equal(fileRow.skip_counts['runner-unavailable'], undefined)

  const neither = diffDriverIo({ report: null, reportFile: diffReport([diffSurvivor], { generation: 2 }) })
  assert.equal(driveTask(CTX, neither).status, 'done')
  assert.deepEqual(diffProofRow(neither).skip_counts, { 'runner-unavailable': 1 })
})

test('D1 records runner exit status and stderr in unavailable why', () => {
  const io = diffDriverIo({ report: null, reportFile: 'torn-bytes{{{', runnerStatus: 3, runnerStderr: 'b907-distinctive-stderr-boom\n' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const row = diffProofRow(io)
  assert.deepEqual(row.skip_counts, { 'runner-unavailable': 1 })
  assert.match(row.why, /exit status 3/)
  assert.match(row.why, /b907-distinctive-stderr-boom/)
  assert.equal(row.why.includes('the diff runner emitted no final DIFF-MUTATION-SUMMARY sentinel'), false)
})

test('E1 distinguishes sentinel and report-file sources', () => {
  const sentinelIo = diffDriverIo({ report: diffReport([diffSurvivor]) })
  driveTask(CTX, sentinelIo)
  assert.equal(diffProofRow(sentinelIo).report_source, 'stdout-sentinel')

  const fileIo = diffDriverIo({ report: null, reportFile: b646FileReport() })
  driveTask(CTX, fileIo)
  assert.equal(diffProofRow(fileIo).report_source, 'report-file')

  const unavailableIo = diffDriverIo({ report: null })
  driveTask(CTX, unavailableIo)
  assert.equal(diffProofRow(unavailableIo).report_source, 'runner-unavailable')
})

test('R1 panel permission lead is registered before panel dispatch', async () => {
  const { permissionHandler } = await import('./acp-permission.mjs')
  let lead, wired = 0, selected, callbackAnswer
  let io
  const reviewer = () => {
    selected = permissionHandler({ lead: (payload) => (callbackAnswer = lead(payload)) })({
      toolCall: { title: 'permit', kind: 'edit' },
      options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }],
    })
    return { ...panelEnvelope({ role: 'reviewer' }), assignment_id: `panel-${io.calls.assign.findLastIndex(({ role }) => role === 'reviewer') + 1}` }
  }
  io = strictPanelIo({ reviewer, runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  io.setPermissionLead = (callback) => { wired += 1; lead = callback }
  const baseWait = io.wait.bind(io)
  let leadWaits = 0
  io.wait = function (path, timeout) {
    if (!path.startsWith('lead:')) return baseWait(path, timeout)
    this.calls.waits.push({ returnPath: path, timeoutS: timeout })
    const assignedId = `panel-${this.calls.assign.findLastIndex(({ role }) => role === 'lead') + 1}`
    const env = ++leadWaits === 1
      ? { ...panelEnvelope({ role: 'lead' }), details: { decision: 'a', reason: 'allow' } }
      : panelEnvelope({ role: 'lead', details: { adjudications: [] } })
    return { ...env, role: 'lead', assignment_id: assignedId, run_id: PANEL_RUN_ID }
  }
  driveTask(panelContext(), io)
  assert.equal(wired, 1)
  assert.equal(callbackAnswer?.decision, 'a')
  assert.equal(selected, 'a')
})

test('R2 panel permission second opinions exclude both panel seats and reject', async () => {
  const { permissionHandler } = await import('./acp-permission.mjs')
  let lead, wired = 0, selected, during
  let io
  const reviewer = () => {
    selected = permissionHandler({ lead })({
      toolCall: { title: 'permit', kind: 'edit' },
      options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }],
    })
    during = {
      reviewer: io.calls.assign.filter(({ role }) => role === 'reviewer').length,
      techLead: io.calls.assign.filter(({ role }) => role === 'tech-lead').length,
    }
    return { ...panelEnvelope({ role: 'reviewer' }), assignment_id: `panel-${io.calls.assign.findLastIndex(({ role }) => role === 'reviewer') + 1}` }
  }
  io = strictPanelIo({ reviewer, runs: reviewDiffRuns({ ok: true, output: '' }, PANEL_BASE_SHA, PANEL_HEAD_SHA) })
  io.setPermissionLead = (callback) => { wired += 1; lead = callback }
  const baseWait = io.wait.bind(io)
  let leadWaits = 0
  io.wait = function (path, timeout) {
    if (!path.startsWith('lead:')) return baseWait(path, timeout)
    this.calls.waits.push({ returnPath: path, timeoutS: timeout })
    const assignedId = `panel-${this.calls.assign.findLastIndex(({ role }) => role === 'lead') + 1}`
    const env = ++leadWaits === 1
      ? { ...panelEnvelope({ role: 'lead' }), details: { decision: SECOND_OPINION, from: 'tech-lead', reason: 'seek advice' } }
      : panelEnvelope({ role: 'lead', details: { adjudications: [] } })
    return { ...env, role: 'lead', assignment_id: assignedId, run_id: PANEL_RUN_ID }
  }
  driveTask(panelContext(), io)
  assert.equal(wired, 1)
  assert.deepEqual(during, { reviewer: 1, techLead: 0 })
  assert.equal(selected, 'r')
})

test('R3 panel permission registers once in ordinary full runs', () => {
  const io = fakeIo()
  let wired = 0
  io.setPermissionLead = () => { wired += 1 }
  driveTask(CTX, io)
  assert.equal(wired, 1)
})
