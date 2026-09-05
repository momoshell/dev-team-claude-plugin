// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADOPTED_PLAN_HEADING, ADOPT_BLOCK, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE, CTX, CTX_DIRECTED, CTX_TL, DIRECTED_FILES, ENVELOPE_REFUSAL_REASONS, FAILURE_UPGRADE, GATE_SUMMARY_PREFIX, GROWTH_DIVERGENCE_FACTOR, LANE_COMMAND_SHAPES, LANE_INPUT_VERDICTS, LANE_PATH_OPTIONS, LANE_VALUE_OPTIONS, LIMITS, NO_TURN_CEILING, PLAN_CHECK_ABSENT, PLAN_CHECK_INVALID, PLAN_CHECK_SEVERITIES, PLAN_CONVERGENCE_REASONS, RED, RUN_START_EVENT, S843_ADDED, S843_D2, S843_DISPATCHED, S843_NARROWED, TD, THREW, TURN_CEILING_REFUSALS, TURN_CEILING_ROLES, VALIDATION_LANE_UNLOADABLE, adoptionSignal, bothExhaustionPointsScenario, buildEnv, carriedPrLines, carriedPreambleLines, carriedResolution, carriedSilenceDefect, checkEnv, composeCommitMessage, divergeThenExhaustPlanScenario, divergenceConsultLines, divergentPlanScenario, driveTask, enforcementPreamble, fakeIo, growthLines, growthRecord, join, laneCommandInputs, laneCommandShape, laneFence, leadEnv, lineageFromJournal, persistentDivergenceScenario, planCheckAcceptIo, planCheckFindings, planCheckFindingsFromText, planConvergence, planEnv, planRevisionRun, planRoundCap, planThenReviewIo, protectedPlanEnv, resolveTurnCeilings, resolveValidationLane, resumeGreen, resumeKeys, resumeRed, reviewConvergeRun, reviewEnv, s843Bullets, s843Ctx, s843Io, s843PlanEnv, suiteRefusalEnv, turnCeilingsRecord, validationPlan, validationProbeRun,
} from './drive-fixtures.mjs'

test('a lead that answers escalate at the accept re-ask escalates with both reasons', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ decision: 'escalate', reason: 'a human should read this' }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.match(result.details.escalation.why, /refuted is not supported/)
  assert.match(result.details.escalation.why, /a human should read this/)
  assert.equal(io.calls.commits.length, 0)
})

test('a later refused review accept supersedes the plan-check decision on escalation', () => {
  const io = planThenReviewIo({ residuals: [{ id: 'unknown-review', type: 'cosmetic' }] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.equal(io.calls.commits.length, 0)
})

test('a later valid review accept supersedes the plan-check decision on done', () => {
  const io = planThenReviewIo({ residuals: [{ id: 'RV-plan-1', type: 'cosmetic' }], refuted: [] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.deepEqual(result.details.accept_decision, rows.at(-1))
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.equal(result.details.accept_decision.outcome, 'accepted')
  assert.notDeepEqual(result.details.accept_decision, rows[0])
})

test("a plan whose files_in_scope crosses a live lane fence is a refusal at plan acceptance", () => {
  const file = 'scripts/factory/intake.mjs'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [file] } }),
    },
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: [file] }] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, new RegExp(file.replaceAll('/', '\\/')))
  assert.match(result.details.escalation.why, /intake-loop/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('a path no lane owns crosses no fence', () => {
  const file = 'crew/roster-ladder.mjs'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [file] } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [file],
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }] }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(io.calls.commits[0].files, [file])
})

test('ctx.protectedPaths extends the sensitivity floor without replacing it', () => {
  const extraIo = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(['db/migrations/']), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['db/migrations/001.sql'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const extra = driveTask({ ...CTX, protectedPaths: ['db/migrations/'] }, extraIo)
  assert.equal(extra.status, 'done')
  assert.equal(extraIo.calls.reseat.length, 1)

  const floorIo = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const floor = driveTask({ ...CTX, protectedPaths: ['.github/workflows/', 'docs/adr/', 'package-lock.json'] }, floorIo)
  assert.equal(floor.status, 'done')
  assert.equal(floorIo.calls.reseat.length, 1)
})

test('directory-prefix scope commits concrete changed paths without a scope bounce', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['tasks/x/captures/', 'a.mjs'] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'tasks/x/captures/1.md', 'tasks/x/captures/2.md'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'tasks/x/captures/1.md', 'tasks/x/captures/2.md'])
  assert.deepEqual(res.details.files_committed, io.calls.commits[0].files)
})

test('unsupported scope entries escalate before assigning a builder', () => {
  for (const entry of ['crew/', 'crew/*.mjs']) {
    const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [entry, 'a.mjs'] } }) } })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'escalation')
    assert.ok(res.details.escalation.why.includes(entry))
    assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0)
  }
})

test('composeCommitMessage uses the plan subject, builder body, and ordered issue refs', () => {
  const msg = composeCommitMessage({
    task: 'hygiene',
    planEnv: { summary: 'whole change', details: { commit_subject: 'fix(crew): runtime', issues: [112, '114', '#117', 'bad', '#112'] } },
    builderEnv: { summary: 'ignored', details: { commit_message: 'test: repair the lane assertion' } },
  })
  assert.equal(msg, 'fix(crew): runtime\n\ntest: repair the lane assertion\n\nRefs: #112, #114, #117')
  assert.equal(composeCommitMessage({ task: 'x', planEnv: { summary: 'plan', details: {} }, builderEnv: { details: { commit_message: 'crew(x): plan' } } }), 'crew(x): plan')
  assert.doesNotMatch(composeCommitMessage({ task: 'x', planEnv: { summary: 'plan', details: {} }, builderEnv: { details: { commit_message: 'body' } } }), /Refs:/)
})

test('a plan bounce spends the failure upgrade for the planner', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous' }),
      'lead:1': leadEnv('bounce'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'exhausted', why: 'top rung', from: null }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers[0], {
    modifier: FAILURE_UPGRADE, kind: 'plan', role: 'planner', outcome: 'exhausted', why: 'top rung', from: null,
  })
  assert.deepEqual(io.calls.reseat[0].role, 'planner')
})

test('the plan-revision brief names the check and says to apply it verbatim', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': planEnv(), 'tech-lead:2': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  const brief = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(brief.startsWith('# Plan revision (round 1)'))
  assert.ok(brief.includes('plan-check.md'))
  assert.match(brief, /verbatim/)
  assert.match(brief, /do not re-derive/)
})

test('the granted plan-revision bounce carries the same instruction', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('approve'),
      'lead:1': leadEnv('bounce'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.match(io.calls.writes[`${TD}/plan-bounce-r2.md`], /do not re-derive/)
})

test('planner insufficient -> lead consult; bounce with guidance lands in the bounce brief', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }),
      'lead:1': leadEnv('bounce', 'the brief means X not Y; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  const bounce = Object.values(io.calls.writes).find((w) => /Plan bounce/.test(w))
  assert.match(bounce, /plan for X/)
})

test('planner questions make one consult and carry keyed answers into one bounce', () => {
  const questions = [
    { id: 'q1', question: 'Does X mean A or B?' },
    { id: 'q2', question: 'Where does Y live?' },
    { id: 'q3', question: 'Is Z in scope?' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps in the brief', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer the planner', { answers: [
        { id: 'q1', answer: 'X means A' }, { id: 'q3', answer: 'Z is out' },
      ] }),
      'planner:2': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  for (const question of questions) {
    assert.ok(decision.includes(question.id))
    assert.ok(decision.includes(question.question))
  }
  assert.ok(decision.includes('details.answers'))
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(bounce.includes('q1: Does X mean A or B?'))
  assert.ok(bounce.includes('ANSWER: X means A'))
  assert.ok(bounce.includes('q3: Is Z in scope?'))
  assert.ok(bounce.includes('ANSWER: Z is out'))
  assert.ok(bounce.includes('q2: Where does Y live?'))
  assert.ok(bounce.includes('UNANSWERED'))
  assert.ok(io.calls.logs.some((entry) => entry.member_questions?.role === 'planner' && entry.member_questions.total === 3))
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['q2'])
})

test('questionless planner and builder bounces remain byte-identical', () => {
  const plannerIo = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'planner stuck', details: {} }),
      'lead:1': leadEnv('bounce', 'steer'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, plannerIo).status, 'done')
  assert.equal(plannerIo.calls.writes[`${TD}/plan-bounce-r1.md`], `# Plan bounce (round 1)\n\nsteer\n\nOriginal brief: ${CTX.briefFile}\nPlanner said: planner stuck`)
  assert.doesNotMatch(plannerIo.calls.writes[`${TD}/decision-1.md`], /## The planner returned/)

  const builderIo = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'builder stuck', details: {} }),
      'lead:1': leadEnv('bounce', 'steer'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, builderIo).status, 'done')
  assert.equal(builderIo.calls.writes[`${TD}/build-bounce-r1.md`], `# Build bounce (round 1)\n\nsteer\n\nPlan: ${TD}/plan.md`)
})

test('malformed-only questions preserve the bounce and journal rejections', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps in the brief', details: { questions: [{ question: 'no id' }, 'garbage', { id: '  ' }] } }),
      'lead:1': leadEnv('bounce', 'steer'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.writes[`${TD}/plan-bounce-r1.md`], `# Plan bounce (round 1)\n\nsteer\n\nOriginal brief: ${CTX.briefFile}\nPlanner said: gaps in the brief`)
  assert.ok(io.calls.logs.some((entry) => entry.member_questions?.rejected?.length === 3))
})

test('omitted answers keep the bounce outcome and mark every id UNANSWERED', () => {
  const questions = [{ id: 'q1', question: 'first?' }, { id: 'q2', question: 'second?' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer', { answers: [] }), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(bounce.includes('q1: first?'))
  assert.ok(bounce.slice(bounce.indexOf('q1: first?')).includes('UNANSWERED'))
  assert.ok(bounce.includes('q2: second?'))
  assert.ok(bounce.slice(bounce.indexOf('q2: second?')).includes('UNANSWERED'))
  assert.doesNotMatch(bounce, /ANSWER:/)
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['q1', 'q2'])
})

test('tech-lead seated: revise verdict bounces the plan, approve on r2 proceeds', () => {
  const ctx = { ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'] }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': { status: 'done', details: { verdict: 'revise', check_path: `${TD}/plan-check.md` } },
      'planner:2': planEnv(), 'tech-lead:2': { status: 'done', details: { verdict: 'approve' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'tech-lead').length, 2)
  assert.match(Object.values(io.calls.writes).find((w) => /Plan revision/.test(w)), /plan-check\.md/)
})

test('consult limit exhausts to escalation (a looping lead cannot loop the driver)', () => {
  const envs = { }
  for (let i = 1; i <= 10; i += 1) envs[`planner:${i}`] = planEnv({ status: 'insufficient' })
  for (let i = 1; i <= 10; i += 1) envs[`lead:${i}`] = leadEnv('bounce')
  const io = fakeIo({ envelopes: envs })
  const res = driveTask({ ...CTX, limits: { plan_rounds: 10 } }, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /consult limit/)
})

test('gate-first: green baseline bounces the lead; repaired gate red at baseline proceeds; gate green after build -> done', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-v1' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-v2' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-v1': { ok: true, output: 'vacuously green' },        // baseline GREEN -> bounce
      'gate-v2:1': { ok: false, output: 'red at baseline\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },     // repaired gate properly red
      'gate-v2:2': { ok: true, output: '' },                     // green after build
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /baseline ran GREEN/.test(w))
  assert.ok(bounce, 'expected the vacuous-gate bounce brief')
  assert.equal(res.details.gate.cmd, 'gate-v2')
})

test('gate-first: repaired gate STILL green at baseline escalates — vacuous acceptance cannot be built against', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-v1' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-v2' } },
    },
    runs: { 'gate-v1': { ok: true, output: '' }, 'gate-v2': { ok: true, output: '' } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /STILL green at baseline/)
})

test('gate exhaustion emits exactly one gate attention with an explicit null park_id', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'lead:1': leadEnv('escalate'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) },
      'gate-cmd:2': { ok: false, output: 'still red' },
      'lane-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  const attention = io.calls.emits.filter((event) => event.kind === 'attention')
  assert.equal(res.status, 'escalation')
  assert.equal(attention.length, 1)
  assert.equal(attention[0].moment, 'gate')
  assert.ok(Object.hasOwn(attention[0], 'park_id'))
  assert.equal(attention[0].park_id, null)
})

test('pristine red with every check failed records proven discrimination', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
})

test('a no-summary failed proof routes through the lead repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: false, output: 'red but no summary' },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /printed no GATE-SUMMARY/)
})

test('a THREW failed proof routes through the lead repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: false, output: THREW },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /THREW/)
})

test('a second failed proof escalates after the single gate repair is spent', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: 'green first pristine run' },
      'gate-fixed': { ok: true, output: 'green replacement pristine run' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /spent/)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.runClean.length, 2)
})

test('a triage repair with a failed no-summary re-proof escalates without a second lead repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate is defective' } },
    },
    runs: {
      'gate-bad:1': { ok: false, output: RED(3) },
      'gate-bad:2': { ok: false, output: RED(3) },
      'gate-bad:3': { ok: false, output: RED(3) },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: 'red but no summary' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /printed no GATE-SUMMARY/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('a failed proof repaired to a red built-tree gate bounces the builder, then proceeds', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:1': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: 'green first pristine run' },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.generation, 2)
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

test('a failed proof whose lead repair omits gate_cmd escalates without a commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', summary: 'no gate returned', details: {} },
      'builder:1': buildEnv(),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green pristine run' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /could not be repaired/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('a throwing runClean records unproven and preserves its stash message in the journal', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanThrows: true,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(res.details.gate.discrimination, 'unproven')
  assert.match(res.details.gate.discrimination_note, /stash/)
  const journal = io.calls.logs.find((line) => line.gate_proof_unproven)
  assert.ok(journal)
  assert.equal(journal.gate_proof_unproven, res.details.gate.discrimination_note)
  const discrimination = io.calls.emits.find((event) => event.kind === 'discrimination')
  assert.deepEqual(discrimination, {
    kind: 'discrimination', generation: 1, verdict: 'unproven', summary: null,
    note: res.details.gate.discrimination_note,
  })
})

test('a review bounce does not repeat the first-green proof for one generation', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'gate-cmd:3': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
})

test('a byte-identical repair starts generation two and records its own proof', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong target' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: false, output: 'first build fail' },
      'gate-cmd:3': { ok: false, output: 'second build fail' }, 'gate-cmd:4': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 2)
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 1)
})

test('a baseline defect replacement stays generation one and keeps its audit trail', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-bad': { ok: false, output: 'no summary' },
      'gate-fixed:1': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 1)
  assert.equal(res.details.gate.repairs, 0)
  assert.deepEqual(res.details.gate.replaced, ['gate-bad'])
})

test('#153: a baseline with no summary line at all is treated as a defective gate', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-silent' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-silent': { ok: false, output: 'red at baseline' },
      'gate-fixed:1': { ok: false, output: RED() }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.ok(Object.values(io.calls.writes).find((w) => /cannot tell a red gate from a broken one/.test(w)))
})

test('#153: a repaired gate that STILL does not run escalates rather than building against it', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-still-broken' } },
    },
    runs: { 'gate-broken': { ok: false, output: THREW }, 'gate-still-broken': { ok: false, output: THREW } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /STILL does not run at baseline/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0, 'never build against a gate that cannot run')
})

test('#153: a repaired gate that comes back GREEN at baseline escalates as vacuous', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-vacuous' } },
    },
    runs: { 'gate-broken': { ok: false, output: THREW }, 'gate-vacuous': { ok: true, output: '' } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /GREEN at baseline/)
})

test('#153: an honestly-red baseline is untouched — no bounce, no extra planner round', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-ok' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'gate-ok:1': { ok: false, output: RED() }, 'gate-ok:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 1, 'exactly one planner round')
  assert.equal(Object.values(io.calls.writes).filter((w) => /did not RUN|ran GREEN/.test(w)).length, 0)
})

test("the viewer mounts on the planner's plan_path, not a hardcoded default", () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, plan_path: `${TD}/custom-plan.md` } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.showDoc, [`${TD}/custom-plan.md`])
})

test('emit mirrors assignments and envelope returns, including insufficient returns', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }), 'lead:1': leadEnv('bounce'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const assigns = io.calls.emits.filter((e) => e.kind === 'assign')
  const envelopes = io.calls.emits.filter((e) => e.kind === 'envelope')
  assert.equal(assigns.length, envelopes.length)
  assert.ok(assigns.some((e) => e.role === 'planner' && e.id === 'planner1'))
  assert.ok(envelopes.some((e) => e.role === 'planner' && e.status === 'insufficient'))
  for (const e of [...assigns, ...envelopes]) assert.ok(e.id && e.role)
})

test('a throwing io.emit changes nothing', () => {
  const input = {
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  }
  const plainIo = fakeIo(input)
  const plain = driveTask(CTX, plainIo)
  const noisyIo = fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } })
  const noisy = driveTask(CTX, noisyIo)
  assert.deepEqual(noisy, plain)
  assert.deepEqual(noisyIo.calls.run, plainIo.calls.run)
  assert.deepEqual(noisyIo.calls.runClean, plainIo.calls.runClean)
})

test('plan-check exhaustion can buy one plan round and re-check it', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('approve'),
      'lead:1': leadEnv('bounce'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 3)
  assert.equal(io.calls.assign.filter((a) => a.role === 'tech-lead').length, 3)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'plan-check', round: 2 }])
})

test('plan-check grant cap refuses a second bounce and escalates', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('revise'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'escalation')
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'plan-check', round: 2 }])
  const decisions = Object.entries(io.calls.writes).filter(([path]) => /decision-\d+b?\.md$/.test(path)).map(([, body]) => body)
  assert.equal(decisions.filter((body) => /^- bounce$/m.test(body)).length, 1)
})

test('done and escalation envelopes always record the grant list, including empty happy paths', () => {
  const done = driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  }))
  assert.deepEqual(done.details.extra_rounds_granted, [])
  const escalated = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': leadEnv('escalate') } }))
  assert.deepEqual(escalated.details.extra_rounds_granted, [])
})

test('growthRecord and growthLines use the cumulative two-times threshold and null evidence', () => {
  assert.equal(GROWTH_DIVERGENCE_FACTOR, 2)
  const first = growthRecord(null, null, { round: 1, plan_bytes: 100, gate_bytes: 100, files_in_scope_count: 2 })
  assert.deepEqual(first, {
    round: 1, plan_bytes: 100, gate_bytes: 100, plan_delta: null, gate_delta: null,
    combined_bytes: 200, round1_combined_bytes: null, files_in_scope_count: 2,
    ratio: null, divergent: false,
  })
  const doubled = growthRecord(first, first, { round: 2, plan_bytes: 200, gate_bytes: 200, files_in_scope_count: 2 })
  assert.equal(doubled.plan_delta, 100)
  assert.equal(doubled.gate_delta, 100)
  assert.equal(doubled.round1_combined_bytes, 200)
  assert.equal(doubled.ratio, 2)
  assert.equal(doubled.divergent, true)
  const under = growthRecord(first, first, { round: 2, plan_bytes: 199, gate_bytes: 199, files_in_scope_count: 2 })
  assert.equal(under.ratio, 1.99)
  assert.equal(under.divergent, false)
  const nulls = growthRecord(null, null, { round: 1, plan_bytes: null, gate_bytes: null, files_in_scope_count: null })
  assert.equal(nulls.combined_bytes, null)
  assert.match(growthLines(nulls).join('\n'), /plan_bytes=null.*gate_bytes=null.*combined_bytes=null.*ratio=null.*divergent=false/)
})

test('plan-check findings and convergence use closed machine-readable contracts', () => {
  assert.deepEqual([...PLAN_CHECK_SEVERITIES], ['blocker', 'major', 'minor'])
  assert.equal(Object.isFrozen(PLAN_CONVERGENCE_REASONS), true)
  assert.equal(planCheckFindings({}), null)
  const parsed = planCheckFindings({ findings: [
    { id: 'PC-1', severity: 'major', correction: 'close the branch' },
    { id: 'PC-1', severity: 'minor', correction: 'duplicate' },
    { id: 'PC-2', severity: 'bad', correction: 'bad severity' },
    { id: '../x', severity: 'minor', correction: 'bad id' },
    { id: 'PC-3', severity: 'minor', correction: '   ' },
  ] })
  assert.deepEqual(parsed.findings, [{ id: 'PC-1', severity: 'major', correction: 'close the branch' }])
  assert.equal(parsed.rejected.length, 4)
  const findings = planCheckFindings({ findings: [{ id: 'PC-4', severity: 'minor', correction: 'do the thing' }] })
  assert.deepEqual(planConvergence({ verdict: 'approve', round: 2, findings, priorClosed: true }), {
    converged: false, reason: 'verdict-not-revise', blocker: false, carried: [],
  })
  assert.deepEqual(planConvergence({ verdict: 'revise', round: 2, findings: null, priorClosed: true }), {
    converged: false, reason: 'findings-absent', blocker: false, carried: [],
  })
  assert.equal(planConvergence({ verdict: 'revise', round: 1, findings, priorClosed: true }).reason, 'round-1')
  assert.equal(planConvergence({ verdict: 'revise', round: 2, findings: planCheckFindings({ findings: [{ id: 'PC-5', severity: 'blocker', correction: 'stop' }] }), priorClosed: true }).reason, 'blocker-present')
  const rejected = planCheckFindings({ findings: [{ id: 'PC-6', severity: 'minor', correction: 'ok' }, { id: 'PC-6', severity: 'minor', correction: 'duplicate' }] })
  assert.equal(planConvergence({ verdict: 'revise', round: 2, findings: rejected, priorClosed: true }).reason, 'findings-rejected')
  assert.equal(planConvergence({ verdict: 'revise', round: 2, findings: rejected, priorClosed: true }).blocker, true)
  assert.equal(planConvergence({ verdict: 'revise', round: 2, findings, priorClosed: false }).reason, 'prior-findings-open')
  assert.equal(planConvergence({ verdict: 'revise', round: 2, findings: planCheckFindings({ findings: [] }), priorClosed: true }).reason, 'findings-absent')
  assert.deepEqual(planConvergence({ verdict: 'revise', round: 2, findings, priorClosed: true }), {
    converged: true, reason: 'prior-findings-closed', blocker: false,
    carried: [{ id: 'PC-4', severity: 'minor', correction: 'do the thing', round: 2 }],
  })
})

test('plan-check text parser reads prescribed finding rows', () => {
  assert.deepEqual(planCheckFindingsFromText([
    'VERDICT: revise',
    '- PC-1 (major): close the branch',
    '* PC-2 (minor): narrow the scope',
    '- malformed row',
  ].join('\n')), [
    { id: 'PC-1', severity: 'major', correction: 'close the branch' },
    { id: 'PC-2', severity: 'minor', correction: 'narrow the scope' },
  ])
  assert.deepEqual(planCheckFindingsFromText(null), [])
})

test('carried findings resolve clears, restatements, and silence once', () => {
  const carried = [{ id: 'PC-1', severity: 'major', correction: 'close it', round: 2 }, { id: 'PC-2', severity: 'minor', correction: 'narrow it', round: 2 }]
  assert.deepEqual(carriedPreambleLines([]), [])
  assert.match(carriedPreambleLines(carried).join('\n'), /- PC-1 \(major\): close it/)
  assert.deepEqual(carriedResolution({ carried_cleared: ['PC-1', 2, 'nobody', 'PC-2'], findings: [{ id: 'PC-2', severity: 'consider', summary: 'still open' }] }, carried), {
    cleared: ['PC-1'], restated: ['PC-2'], silent: [],
  })
  assert.deepEqual(carriedResolution({ carried_cleared: ['PC-1'], findings: [{ id: 'PC-1', severity: 'consider', summary: 'still open' }] }, carried), {
    cleared: [], restated: ['PC-1'], silent: ['PC-2'],
  })
  const refusal = carriedSilenceDefect({}, carried)
  assert.equal(refusal.reason, 'carried-silent')
  assert.match(refusal.why, /PC-1, PC-2/)
  assert.equal(carriedSilenceDefect({ carried_cleared: ['PC-1', 'PC-2'] }, carried), null)
})

test('carried PR lines and lineage growth preserve measured meaning', () => {
  assert.deepEqual(carriedPrLines(null), [])
  assert.deepEqual(carriedPrLines([]), [])
  const lines = carriedPrLines([{ id: 'PC-1', severity: 'major', correction: 'close it' }, { id: 'PC-2', severity: 'minor', correction: 'narrow it' }])
  assert.equal(lines.filter((line) => line.includes('carried-to-review')).length, 2)
  assert.match(lines.join('\n'), /PC-1 \(major\).*close it/)
  const lineage = lineageFromJournal([
    '{bad json',
    JSON.stringify({ event: 'plan-adopted', archive: '/archive', combined_bytes: 199, lineage_baseline_bytes: 100, lineage_baseline_source: 'carried', lineage_reason: null }),
  ].join('\n'))
  assert.deepEqual(lineage, { archive: '/archive', combined_bytes: 199, baseline_bytes: 100, source: 'carried', reason: null, ratio: 1.99, divergent: false })
  assert.equal(lineageFromJournal(JSON.stringify({ event: 'other' })), null)
  const record = growthRecord(null, null, { round: 1, plan_bytes: 200, gate_bytes: 0 }, { baseline_bytes: 100, source: 'carried', reason: null })
  assert.equal(record.round1_combined_bytes, 100)
  assert.equal(record.ratio, 2)
  assert.equal(record.divergent, true)
  assert.equal(Object.hasOwn(record, 'baseline_source'), true)
})

test('a diverging plan round reaches the deciding seat one round early', () => {
  const { io, result } = divergentPlanScenario('escalate')
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 2)
})

test('the divergence consult names the measured ratio, not merely the fact', () => {
  const { io } = divergentPlanScenario('escalate')
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(decision, /DIVERGENCE/)
  assert.match(decision, /round 1's 20/)
  assert.match(decision, /40 bytes/)
  assert.match(decision, /ratio 2/)
})

test('an early divergence consult precedes the exhaustion consult, it does not replace it', () => {
  const { io, result } = divergeThenExhaustPlanScenario()
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.deepEqual(result.details.extra_rounds_granted, [{ where: 'plan-check', round: 3 }])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 4)
})

test('a round below the ratified factor surfaces nothing', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(19)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:3': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(Object.keys(io.calls.writes).some((path) => /decision-\d+b?\.md$/.test(path)), false)
})

test('a persistent divergence consults once before exhaustion and preserves its grant', () => {
  const { io, result } = persistentDivergenceScenario()
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.deepEqual(result.details.extra_rounds_granted, [{ where: 'plan-check', round: 5 }])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 6)
})

test('a plan-check grant leaves a review-exhaustion grant available', () => {
  const { result } = bothExhaustionPointsScenario()
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.extra_rounds_granted, [
    { where: 'plan-check', round: 2 }, { where: 'review', round: 3 },
  ])
})

test('divergenceConsultLines only describes a measured divergent record', () => {
  assert.deepEqual(divergenceConsultLines(null), [])
  assert.deepEqual(divergenceConsultLines({ divergent: false }), [])
  assert.deepEqual(divergenceConsultLines(42), [])
  const lines = divergenceConsultLines({ divergent: true, round: 2, combined_bytes: 40, round1_combined_bytes: 20, ratio: 2 })
  assert.match(lines.join('\n'), /round 2/)
  assert.match(lines.join('\n'), /40 bytes/)
  assert.match(lines.join('\n'), /20/)
  assert.match(lines.join('\n'), /ratio 2/)
})

test('divergent growth is evidence in both the round-2 check and revision briefs, never a verdict', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }),
      'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(30)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(30)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:3': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io)
  assert.equal(res.status, 'done')
  const check = io.calls.writes[`${TD}/check-brief-r2.md`]
  const bounce = io.calls.writes[`${TD}/plan-bounce-r2.md`]
  for (const brief of [check, bounce]) {
    assert.match(brief, /divergent=true/)
    assert.match(brief, /plan_bytes=30/)
    assert.match(brief, /gate_bytes=30/)
    assert.match(brief, /files_in_scope=2/)
  }
  assert.deepEqual(res.details.growth.map((record) => record.round), [1, 2, 3])
})

test('round-2 growth below two-times cumulative remains non-divergent', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.match(io.calls.writes[`${TD}/check-brief-r2.md`], /combined_bytes=30/)
  assert.match(io.calls.writes[`${TD}/check-brief-r2.md`], /divergent=false/)
})

test('missing plan and unreadable gate are null evidence with the same run outcome', () => {
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  const scenario = (files) => {
    const io = fakeIo({
      files,
      envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    return { io, result: driveTask(CTX_TL, io) }
  }
  const missing = scenario({})
  const present = scenario({ [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) })
  assert.equal(missing.result.status, 'done')
  assert.equal(present.result.status, 'done')
  assert.deepEqual(missing.result.details.stages, present.result.details.stages)
  assert.match(missing.io.calls.writes[`${TD}/check-brief-r1.md`], /plan_bytes=null.*gate_bytes=null/s)
})

test('a gate path outside the task dir is rejected and cannot alter the run', () => {
  const outside = '/tmp/outside-growth-gate.mjs'
  const details = { ...planEnv().details, gate_path: outside }
  const io = fakeIo({
    files: { [`${TD}/plan.md`]: 'x'.repeat(10), [outside]: 'x'.repeat(500) },
    envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.growth[0].gate_bytes, null)
  assert.ok(io.calls.logs.some((line) => line.gate_path_rejected === outside))
})

test('a wildly divergent run still reaches commit', () => {
  const files = { [`${TD}/plan.md`]: 'x', [`${TD}/gate.mjs`]: 'x' }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(1000)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(1000)
        return planEnv({ details: { ...planEnv().details, gate_path: `${TD}/gate.mjs`, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.growth[1].divergent, true)
})

test('a valid carve escalates with its sanitized slices and no lead consult', () => {
  const slices = [
    { summary: 'slice one', files_in_scope: ['a.mjs'] },
    { summary: 'slice two', files_in_scope: ['b.mjs'] },
  ]
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'carve', carve_slices: slices } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.deepEqual(result.details.carve.slices, slices)
  assert.equal(result.details.consults, undefined)
})

test('a malformed carve list escalates carrying a defect', () => {
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'carve', carve_slices: [] } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.ok(result.details.carve.defect)
})

test('a gate-repair lead dispatch is not mistaken for a plan revision carve check', () => {
  const repaired = planEnv({ role: 'lead', details: { ...planEnv().details, gate_cmd: 'gate-fixed' } })
  delete repaired.details.carve_verdict
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong gate' } },
      'lead:1': repaired, 'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: RED(3) }, 'gate-bad:2': { ok: false, output: 'fail one' },
      'gate-bad:3': { ok: false, output: 'fail two' }, 'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(!result.details.stages.includes('escalate:plan-carve'))
})

test('review convergence without the gh seam remains a review escalation', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, seam: false })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
  assert.ok(io.calls.assign.every(({ role }) => role !== 'converge'))
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
})

test('gateless review convergence parks instead of claiming a green acceptance gate', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, gateless: true })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
})

test('non-continuation keeps the ordinary assignment and review brief write set byte-identical', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []) },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, continuation: false }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.map(({ role, briefFile }) => ({ role, briefFile })), [
    { role: 'planner', briefFile: '/tmp/brief.md' },
    { role: 'builder', briefFile: `${TD}/plan.md` },
    { role: 'reviewer', briefFile: `${TD}/review-brief-1.md` },
  ])
  assert.deepEqual(Object.keys(io.calls.writes), [`${TD}/review-brief-1.md`])
  assert.equal(io.calls.writes[`${TD}/review-brief-1.md`], [
    '# Review (round 1)', '',
    `Plan of record: ${TD}/plan.md. Changes are uncommitted in /tmp/repo — read the diff with git.`,
    'Re-run the validation lane yourself: lane-cmd',
    'Write review.md in the task dir. details.verdict must be pass or changes-needed.',
  ].join('\n'))
})

test('a directed run with no validation lane escalates', () => {
  const io = fakeIo({ files: DIRECTED_FILES })
  const result = driveTask({ ...CTX_DIRECTED, lane: undefined }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'directed')
  assert.equal(io.calls.assign.length, 0)
})

test('a lead-seated full run still repairs its gate', () => {
  const full = Object.freeze({ ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'], seatedRoles: ['lead', 'planner', 'builder', 'reviewer'] })
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const cases = [
    {
      runs: { 'gate-cmd': { ok: true, output: green } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'lead:1': leadEnv('accept'),
      },
    },
    {
      runs: { 'gate-cmd': { ok: false, output: 'Error: boom\n' } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'lead:1': leadEnv('accept'),
      },
    },
    {
      runs: {
        'gate-cmd:1': { ok: false, output: red }, 'gate-cmd': { ok: true, output: green },
        'lane-cmd': { ok: true, output: '' },
      },
      cleanRuns: { 'gate-cmd': { ok: true, output: green } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'builder:1': buildEnv(), 'lead:1': leadEnv('accept'),
      },
      changed: ['a.mjs', 'a.test.mjs'],
    },
  ]
  for (const spec of cases) {
    const io = fakeIo(spec)
    driveTask(full, io)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  }
})

test('every escalation exit carries the full resume key set', () => {
  const exits = [
    driveTask(CTX, fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': leadEnv('escalate') } })),
    driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() }, changed: ['a.mjs', 'outside.mjs'] })),
    driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'lane-cmd': { ok: false, output: 'red lane' } }, changed: ['a.mjs'] })),
    driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red suite' } }, changed: ['a.mjs'] })),
  ]
  assert.deepEqual(exits.map((result) => result.status), ['escalation', 'escalation', 'escalation', 'escalation'])
  for (const result of exits) for (const key of resumeKeys) assert.ok(Object.hasOwn(result.details, key), `missing details.${key}`)
  assert.deepEqual(exits.map((result) => result.details.escalation.where), ['plan', 'scope', 'lane', 'suite'])
})

test('the escalation gate block is the done block', () => {
  const escalationIo = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') },
    runs: { 'gate-cmd': resumeRed(), 'lane-cmd': { ok: false, output: 'red lane' } }, changed: ['a.mjs'],
  })
  const escalated = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalationIo)
  const doneIo = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'gate-cmd:1': resumeRed(), 'gate-cmd:2': resumeGreen(), 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const done = driveTask(CTX, doneIo)
  assert.equal(escalated.details.gate.cmd, 'gate-cmd')
  for (const key of Object.keys(done.details.gate)) assert.ok(Object.hasOwn(escalated.details.gate, key), `missing gate key ${key}`)
})

test('the escalation gate block survives a repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
    },
    cleanRuns: { 'gate-bad': resumeGreen(), 'gate-fixed': resumeRed() },
    runs: { 'gate-bad:1': resumeRed(), 'gate-bad:2': resumeGreen(), 'gate-fixed': resumeGreen(), 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'suite red' } },
    changed: ['a.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.gate.cmd, 'gate-fixed')
  assert.equal(result.details.gate.repairs, 1)
  assert.deepEqual(result.details.gate.replaced, ['gate-bad'])
})

test('gate attempt high water counts every gate invocation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'gate-cmd': resumeRed(), 'lane-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  const invocations = io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length
  assert.equal(result.details.gate_attempt_high_water, invocations)
})

test('a widening bounces the planner while a plan round remains', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  assert.equal(result.status, 'done')
  const planners = io.calls.assign.filter((a) => a.role === 'planner')
  assert.equal(planners.length, 2)
  assert.equal(planners[1].briefFile, `${TD}/plan-bounce-r1.md`)
})

test('the widening bounce reasons its own assignment', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  assert.deepEqual(io.calls.assign.filter((a) => a.role === 'planner').map((a) => a.note),
    ['plan', 'plan-scope-widened'])
})

test('the scope note is spent on one assignment and does not leak', () => {
  // Three planner rounds: r1 widens and scope-bounces, r2 conforms but the tech-lead
  // says revise, r3 comes from that ORDINARY plan-check bounce and must read
  // plan-revision again. The source-text pin cannot see this — it only proves the
  // override exists, not that it is cleared.
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2),
    'planner:2': s843PlanEnv(S843_NARROWED),
    'planner:3': s843PlanEnv(S843_NARROWED),
    'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('approve'),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const ctx = s843Ctx({
    roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'],
    limits: { plan_rounds: 3, build_rounds: 2, review_rounds: 2 },
  })
  driveTask(ctx, io)
  assert.deepEqual(io.calls.assign.filter((a) => a.role === 'planner').map((a) => a.note),
    ['plan', 'plan-scope-widened', 'plan-revision'])
})

test('the widening bounce brief lists the dispatched surface and the additions', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.equal(typeof bounce, 'string')
  assert.deepEqual(s843Bullets(bounce, 'The dispatched write surface'), [...S843_DISPATCHED])
  assert.deepEqual(s843Bullets(bounce, 'Your files_in_scope added'), [...S843_ADDED])
  assert.match(bounce, /Narrowing it is legal and is recorded, not refused/)
})

test('a widening bounce is accounted as a planner failure upgrade', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  const upgrades = io.calls.logs
    .filter((row) => row && row.modifier && row.modifier.modifier === 'failure-upgrade')
    .map((row) => row.modifier.role)
  assert.deepEqual(upgrades, ['planner'])
})

test('a bounce never moves the dispatched baseline', () => {
  // Round 2 is measured against the DISPATCH, not against the plan just refused —
  // otherwise one bounce launders the swap the round exists to correct.
  const io = s843Io({ 'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_D2) }, [...S843_D2])
  const ctx = s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } })
  const result = driveTask(ctx, io)
  assert.equal(result.details.escalation.where, 'plan-scope-widened')
  assert.deepEqual(ctx.files_in_scope, [...S843_DISPATCHED])
})

// MUTATIONS A16 and A18 — node-test-ness is established before the fail-closed shape arm.
test('a lane that does not attempt a node --test run is opaque; one that does and cannot be parsed is unparsable', () => {
  for (const lane of ['lane-cmd', 'npm test', 'node build.mjs']) {
    const shaped = laneCommandShape(lane)
    assert.equal(shaped.shape, 'opaque')
    assert.ok(shaped.why.includes(lane.split(' ')[0]))
    assert.ok(LANE_COMMAND_SHAPES.includes(shaped.shape))
  }
  for (const lane of [
    'node --test a.mjs | cat',
    'node --test a.mjs && node --test b.mjs',
    'node --test a.mjs > out.txt',
    'env node --test a.mjs',
  ]) {
    const shaped = laneCommandShape(lane)
    assert.equal(shaped.shape, 'unparsable')
    assert.ok(LANE_COMMAND_SHAPES.includes(shaped.shape))
    let probes = 0
    const resolved = resolveValidationLane(lane, () => { probes += 1; return new Map() })
    assert.equal(resolved.rows.length, 1)
    assert.equal(resolved.refused.length, 1)
    assert.equal(probes, 0)
  }
  assert.equal(laneCommandShape('node --test a.mjs').shape, 'node-test')
})

// MUTATIONS A12, A17 and A19 — scalar values are consumed, path-bearing values are inputs,
// globs are refused, and -- starts positional parsing.
test('laneCommandInputs consumes scalar option values, keeps path option values as inputs in both spellings, separates globs, and treats every word after -- as a positional', () => {
  const scalar = laneCommandInputs("node --test --test-timeout 30000 --test-reporter=tap a.mjs '**/*.test.mjs' -- -b.mjs --c.mjs")
  assert.deepEqual(scalar.inputs, ['a.mjs', '-b.mjs', '--c.mjs'])
  assert.deepEqual(scalar.globs, ['**/*.test.mjs'])

  const paths = laneCommandInputs('node --test --import pre.mjs --require=hook.cjs -r other.cjs --loader=l.mjs --experimental-loader el.mjs --test-timeout 30000 a.test.mjs')
  assert.deepEqual(paths.inputs, ['pre.mjs', 'hook.cjs', 'other.cjs', 'l.mjs', 'el.mjs', 'a.test.mjs'])
  assert.deepEqual(paths.globs, [])
  assert.deepEqual(LANE_PATH_OPTIONS.filter((option) => LANE_VALUE_OPTIONS.includes(option)), [])
  assert.deepEqual(laneCommandInputs('node --test --import=').inputs, [])
})

// MUTATIONS A9, A11 and A15 — type is authoritative, and every unmeasured or non-file
// result is refused rather than inferred from a token.
test('resolveValidationLane classifies every input from the probe and refuses what it could not measure', () => {
  const cmd = 'node --test load.mjs dotted.jsonl other.mjs missing.mjs omitted.mjs'
  const probed = new Map([
    ['load.mjs', 'file'], ['dotted.jsonl', 'dir'], ['other.mjs', 'other'], ['missing.mjs', 'absent'],
  ])
  const resolved = resolveValidationLane(cmd, (inputs) => {
    assert.deepEqual(inputs, [...probed.keys(), 'omitted.mjs'])
    return probed
  })
  assert.deepEqual(resolved.rows.map((row) => row.verdict), [
    'loadable', 'loadable', 'unsupported-type', 'missing', 'unreadable',
  ])
  assert.deepEqual(resolved.refused.map((row) => row.input), ['other.mjs', 'missing.mjs', 'omitted.mjs'])
  assert.equal(resolved.counts.total, resolved.rows.length)
  assert.ok(resolved.rows.every((row) => LANE_INPUT_VERDICTS.includes(row.verdict)))
  assert.equal(resolved.counts.loadable, 2)
})

// MUTATIONS A1, A2, A4, A6 and A8 — an unloadable planner lane bounces with one closed
// reason and escalates only after the final plan round.
test("a planner lane naming a fixture bounces the planner with the closed reason, and the same lane on the final round escalates", () => {
  const bad = 'node --test crew/drive.test.mjs test/fixtures/cmux-events-input-sent.jsonl'
  const good = 'node --test crew/drive.test.mjs'
  const runs = {
    ...validationProbeRun(bad, {
      'crew/drive.test.mjs': 'file',
      'test/fixtures/cmux-events-input-sent.jsonl': 'file',
    }),
    ...validationProbeRun(good, { 'crew/drive.test.mjs': 'file' }),
    'suite-cmd': { ok: true, output: '' },
  }
  const io = fakeIo({
    envelopes: {
      'planner:1': validationPlan(bad), 'planner:2': validationPlan(good),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs, changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.filter(({ role }) => role === 'planner').map(({ note }) => note), [
    'plan', VALIDATION_LANE_UNLOADABLE,
  ])
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.match(bounce, new RegExp(VALIDATION_LANE_UNLOADABLE))
  assert.ok(bounce.includes('test/fixtures/cmux-events-input-sent.jsonl'))
  assert.ok(bounce.includes(bad))
  assert.ok(bounce.includes(CTX.briefFile))
  assert.equal(Object.isFrozen(ENVELOPE_REFUSAL_REASONS), true)
  assert.ok(ENVELOPE_REFUSAL_REASONS.includes(VALIDATION_LANE_UNLOADABLE))

  const finalIo = fakeIo({
    envelopes: { 'planner:1': validationPlan(bad), 'planner:2': validationPlan(bad) },
    runs: validationProbeRun(bad, {
      'crew/drive.test.mjs': 'file',
      'test/fixtures/cmux-events-input-sent.jsonl': 'file',
    }),
  })
  const final = driveTask(CTX, finalIo)
  assert.equal(final.status, 'escalation')
  assert.equal(final.details.escalation.where, 'plan')
  assert.match(final.details.escalation.why, new RegExp(VALIDATION_LANE_UNLOADABLE))
  assert.match(final.details.escalation.why, /no revision left to bounce it to/)
})

test('b376 A2 a returns json in the checkout is named a misdirected envelope', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'a.test.mjs', 'returns/d1.builder.json'] } }),
      'builder:1': buildEnv(),
    },
    changed: ['returns/d1.builder.json'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.equal(result.details.escalation.why, "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json")
  assert.doesNotMatch(result.details.escalation.why, /out-of-scope edits persisted/)
  const row = io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate
  assert.deepEqual(row, { round: 1, reason: 'envelope-in-checkout', envelopes: ['returns/d1.builder.json'], edits: [] })
})

test('turn-ceiling and adopted-plan helpers keep their closed contracts', () => {
  const absent = resolveTurnCeilings({})
  assert.deepEqual(Object.keys(absent), TURN_CEILING_ROLES)
  assert.ok(TURN_CEILING_ROLES.every((role) => absent[role] === NO_TURN_CEILING))
  assert.equal(turnCeilingsRecord(absent), null)
  const flagged = resolveTurnCeilings({ planner: '40', builder: 7 })
  assert.equal(flagged.planner, 40)
  assert.equal(flagged.builder, 7)
  assert.equal(flagged.reviewer, null)
  assert.deepEqual(turnCeilingsRecord(flagged), {
    planner: 40, 'tech-lead': null, builder: 7, reviewer: null, lead: null,
    source: { planner: 'flag', 'tech-lead': 'absent', builder: 'flag', reviewer: 'absent', lead: 'absent' },
  })
  for (const raw of [{ planner: 'abc' }, { planner: '0' }, { planner: '-1' }, { planner: '1e9' }, { planner: true }, { planner: 1001 }]) {
    assert.throws(() => resolveTurnCeilings(raw), (error) => TURN_CEILING_REFUSALS.includes(error.reason))
  }

  const adopted = `${ADOPTED_PLAN_HEADING}\n`
  assert.deepEqual(adoptionSignal({ briefText: null, planCheckText: 'VERDICT: approve\n' }), { adopted: false, predecessor_checked: null, reason: 'not-adopted' })
  assert.deepEqual(adoptionSignal({ briefText: adopted, planCheckText: 'VERDICT: approve\n' }), { adopted: true, predecessor_checked: true, reason: null })
  assert.equal(adoptionSignal({ briefText: `Notice: ${ADOPTED_PLAN_HEADING}\n`, planCheckText: 'VERDICT: approve\n' }).adopted, false)
  assert.deepEqual(adoptionSignal({ briefText: adopted, planCheckText: 'VERDICT: revise\n' }), { adopted: true, predecessor_checked: false, reason: null })
  for (const text of ['', 'VERDICT: banana\n', '# Plan check\nVERDICT: approve\n']) {
    assert.deepEqual(adoptionSignal({ briefText: adopted, planCheckText: text }), { adopted: true, predecessor_checked: null, reason: PLAN_CHECK_INVALID })
  }
  assert.deepEqual(adoptionSignal({ briefText: adopted, planCheckText: null }), { adopted: true, predecessor_checked: null, reason: PLAN_CHECK_ABSENT })
  assert.equal(planRoundCap({ limits: LIMITS, adopted: true, predecessorChecked: true }), 1)
  assert.equal(planRoundCap({ limits: LIMITS, adopted: true, predecessorChecked: false }), LIMITS.plan_rounds)
  assert.equal(planRoundCap({ limits: LIMITS, adopted: true, predecessorChecked: null }), LIMITS.plan_rounds)
  assert.equal(planRoundCap({ limits: LIMITS, adopted: true, predecessorChecked: true, extraPlanRounds: 1 }), 2)

  assert.equal(enforcementPreamble({ details: { turn_ceiling: { turns: 7, budget: 5 } } }).kind, 'turn-ceiling')
  const unavailable = enforcementPreamble({ details: { turn_ceiling: { turns: null, budget: 5, absent_reason: CENSUS_ROW_ABSENT } } })
  assert.equal(unavailable.kind, 'turn-ceiling-unmeasured')
  assert.match(unavailable.lines[0], /census-row-absent/)
  assert.doesNotMatch(unavailable.lines[0], /after null turns/)
  for (const env of [null, {}, { details: { turn_ceiling: { turns: '7' } } }, { details: { suite_refusal: { reason: 'x' } } }]) {
    assert.deepEqual(enforcementPreamble(env), { kind: null, lines: [] })
  }
})

test('post-return planner enforcement rejects an over-budget return and carries its count to the next brief', () => {
  const journal = `${TD}/journal.jsonl`
  const journalRows = [
    { event: 'run-start' },
    { headless_outcome: 'ok', seat_turn_census: { dispatch_id: 'planner1', role: 'planner', transport: 'headless-json', turns: 137, absent_reason: null } },
    { headless_outcome: 'ok', seat_turn_census: { dispatch_id: 'planner2', role: 'planner', transport: 'headless-json', turns: 1, absent_reason: null } },
  ]
  const io = fakeIo({
    files: { [journal]: `${journalRows.map((row) => JSON.stringify(row)).join('\n')}\n` },
    envelopes: { 'planner:1': planEnv(), 'lead:1': leadEnv('bounce', 'retry the bounded plan'), 'planner:2': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, io)
  assert.equal(result.status, 'done')
  const measured = io.calls.logs.filter((row) => row.seat_turn_ceiling)
  assert.deepEqual(measured[0].seat_turn_ceiling, { role: 'planner', dispatch: 'planner1', turns: 137, budget: 40, measured: true, enforced: true, absent_reason: null })
  const planner = io.calls.assign.filter((row) => row.role === 'planner')
  assert.equal(planner.length, 2)
  assert.match(planner[1].briefFile, new RegExp(`^${TD}/enforcement-planner-r\\d+\\.md$`))
  assert.match(io.calls.writes[planner[1].briefFile], /137 turns against a role budget of 40/)
  assert.deepEqual(result.details.enforcements[0], { role: 'planner', id: 'planner1', kind: 'turn-ceiling', lines: [
    'Your previous dispatch returned after 137 turns against a role budget of 40; its envelope was REJECTED.',
    'Batch your reads and leave the mechanical proof to the driver; the same assignment is asked again.',
  ] })
})

test('RV1-1 adopted plan cap drives every live plan-round site', () => {
  const inherited = (planCheck) => ({ [CTX.briefFile]: ADOPT_BLOCK, [`${TD}/plan-check.md`]: planCheck })
  const count = (io, role) => io.calls.assign.filter((entry) => entry.role === role).length
  const capRow = (io) => io.calls.logs.find((entry) => entry.plan_round_cap)?.plan_round_cap

  const approved = fakeIo({
    files: inherited('VERDICT: approve\n'),
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'), 'lead:1': leadEnv('escalate') },
  })
  const approvedResult = driveTask(CTX_TL, approved)
  assert.equal(approvedResult.status, 'escalation')
  assert.equal(approvedResult.details.escalation.where, 'plan-check')
  assert.deepEqual(capRow(approved), { adopted: true, predecessor_checked: true, reason: null, cap: 1 })
  assert.equal(count(approved, 'planner'), 1)
  assert.equal(count(approved, 'tech-lead'), 1)
  assert.equal(approvedResult.details.stages.includes('plan:r2'), false)
  assert.equal(approvedResult.details.stages.includes('check:r2'), false)

  const revised = fakeIo({
    files: inherited('VERDICT: revise\n'),
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': planEnv(), 'tech-lead:2': checkEnv('revise'), 'lead:1': leadEnv('escalate'),
    },
  })
  const revisedResult = driveTask(CTX_TL, revised)
  assert.equal(revisedResult.status, 'escalation')
  assert.equal(count(revised, 'planner'), 2)
  assert.equal(count(revised, 'tech-lead'), 2)
  assert.equal(revisedResult.details.stages.includes('check:r2'), true)

  const granted = fakeIo({
    files: inherited('VERDICT: approve\n'),
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'), 'lead:1': leadEnv('bounce'),
      'planner:2': planEnv(), 'tech-lead:2': checkEnv('revise'), 'lead:2': leadEnv('escalate'),
    },
  })
  const grantedResult = driveTask(CTX_TL, granted)
  assert.equal(grantedResult.status, 'escalation')
  assert.equal(count(granted, 'tech-lead'), 2)
  assert.equal(grantedResult.details.stages.includes('check:r2'), true)
  assert.equal(grantedResult.details.stages.includes('check:r3'), false)

  const widened = fakeIo({
    files: inherited('VERDICT: approve\n'),
    envelopes: { 'planner:1': planEnv() },
  })
  const widenedResult = driveTask({ ...CTX_TL, files_in_scope: ['a.mjs'] }, widened)
  assert.equal(widenedResult.status, 'escalation')
  assert.equal(widenedResult.details.escalation.where, 'plan-scope-widened')
  assert.equal(count(widened, 'planner'), 1)
  assert.equal(count(widened, 'tech-lead'), 0)

  const bounced = fakeIo({
    files: inherited('VERDICT: approve\n'),
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'retry the plan' }),
      'lead:1': leadEnv('bounce'),
    },
  })
  const bouncedResult = driveTask(CTX_TL, bounced)
  assert.equal(bouncedResult.status, 'escalation')
  assert.equal(bouncedResult.details.escalation.where, 'plan')
  assert.match(bouncedResult.details.escalation.why, /no accepted plan within 1 rounds/)
  assert.equal(count(bounced, 'planner'), 1)
  assert.equal(bouncedResult.details.stages.includes('plan:r2'), false)
})

test('RV1-2 unmeasured turn census is rejected at every driver seam', () => {
  const journal = `${TD}/journal.jsonl`
  const json = (dispatch_id, role, turns, headless_outcome = 'ok') => ({
    headless_outcome,
    seat_turn_census: { dispatch_id, role, transport: 'headless-json', turns, absent_reason: null },
  })
  const rpc = (dispatch_id, role, turns, rpc_outcome = 'ok') => [
    { rpc_outcome, id: dispatch_id, role },
    { seat_turn_census: { dispatch_id, role, transport: 'headless-rpc', turns, absent_reason: null } },
  ]
  const journalText = (rows) => `${[{ event: RUN_START_EVENT }, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`
  const greenRuns = { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }
  const ceilingRow = (io, dispatch) => io.calls.logs.find((entry) => entry.seat_turn_ceiling?.dispatch === dispatch)?.seat_turn_ceiling
  const delivery = (io, role, n = 2) => {
    const assignment = io.calls.assign.find((entry) => entry.role === role && entry.n === n)
    assert.ok(assignment, `missing ${role}:${n} assignment`)
    return io.calls.writes[assignment.briefFile]
  }
  const plannerIo = ({ rows = [], unreadable = false, lead2 = null } = {}) => {
    const io = fakeIo({
      files: { [journal]: journalText(rows) },
      envelopes: {
        'planner:1': planEnv(), 'lead:1': leadEnv('bounce', 'retry the bounded plan'),
        'planner:2': planEnv(), ...(lead2 ? { 'lead:2': lead2 } : {}),
        'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      },
      runs: greenRuns,
      changed: ['a.mjs', 'a.test.mjs'],
    })
    if (unreadable) {
      const readFile = io.readFile
      io.readFile = (path) => {
        if (path === journal) throw new Error('EACCES: turn census denied')
        return readFile(path)
      }
    }
    return io
  }

  const unmeasured = plannerIo({ rows: [json('planner1', 'planner', null), json('planner2', 'planner', 1)] })
  const unmeasuredResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, unmeasured)
  assert.equal(unmeasuredResult.status, 'done')
  assert.deepEqual(ceilingRow(unmeasured, 'planner1'), { role: 'planner', dispatch: 'planner1', turns: null, budget: 40, measured: false, enforced: false, absent_reason: CENSUS_TURNS_ABSENT })
  assert.equal(unmeasuredResult.details.enforcements[0].kind, 'turn-ceiling-unmeasured')
  const unmeasuredBrief = delivery(unmeasured, 'planner')
  assert.match(unmeasuredBrief, /census-turns-absent/)
  assert.doesNotMatch(unmeasuredBrief, /after null turns/)

  const exact = plannerIo({ rows: [json('planner1', 'planner', 40)] })
  const exactResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, exact)
  assert.equal(exactResult.status, 'done')
  assert.deepEqual(ceilingRow(exact, 'planner1'), { role: 'planner', dispatch: 'planner1', turns: 40, budget: 40, measured: true, enforced: false, absent_reason: null })
  assert.equal(exact.calls.assign.filter((entry) => entry.role === 'planner').length, 1)
  assert.deepEqual(exactResult.details.enforcements, [])

  for (const [label, rows] of [
    ['stale failed attempt', [json('planner1', 'planner', 137, 'budget-refused'), json('planner2', 'planner', 1)]],
    ['foreign role sharing dispatch', [json('planner1', 'reviewer', 137), json('planner2', 'planner', 1)]],
  ]) {
    const io = plannerIo({ rows })
    const result = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, io)
    assert.equal(result.status, 'done', label)
    assert.deepEqual(ceilingRow(io, 'planner1'), { role: 'planner', dispatch: 'planner1', turns: null, budget: 40, measured: false, enforced: false, absent_reason: CENSUS_ROW_ABSENT }, label)
    assert.match(delivery(io, 'planner'), /census-row-absent/, label)
    assert.doesNotMatch(delivery(io, 'planner'), /137/, label)
  }

  const unreadable = plannerIo({ unreadable: true, lead2: leadEnv('escalate') })
  const unreadableResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, unreadable)
  assert.equal(unreadableResult.status, 'escalation')
  assert.deepEqual(ceilingRow(unreadable, 'planner1'), { role: 'planner', dispatch: 'planner1', turns: null, budget: 40, measured: false, enforced: false, absent_reason: CENSUS_UNREADABLE })
  assert.match(delivery(unreadable, 'planner'), /census-unreadable/)

  const rpcMeasured = plannerIo({ rows: [...rpc('planner1', 'planner', 137), json('planner2', 'planner', 1)] })
  const rpcResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, rpcMeasured)
  assert.equal(rpcResult.status, 'done')
  assert.deepEqual(ceilingRow(rpcMeasured, 'planner1'), { role: 'planner', dispatch: 'planner1', turns: 137, budget: 40, measured: true, enforced: true, absent_reason: null })
  assert.match(delivery(rpcMeasured, 'planner'), /137 turns against a role budget of 40/)

  for (const [label, envelope] of [
    ['stale assignment', planEnv({ assignment_id: 'stale-planner' })],
    ['wrong role', planEnv({ role: 'builder' })],
    ['missing status', (() => { const env = planEnv(); delete env.status; return env })()],
    ['no envelope', null],
  ]) {
    const io = fakeIo({
      files: { [journal]: journalText([json('planner1', 'planner', 137)]) },
      envelopes: { 'planner:1': envelope }, runs: greenRuns, changed: ['a.mjs', 'a.test.mjs'],
    })
    let journalReads = 0
    const readFile = io.readFile
    io.readFile = (path) => {
      if (path === journal) journalReads += 1
      return readFile(path)
    }
    const result = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, io)
    assert.equal(result.status, 'escalation', label)
    assert.equal(result.details.escalation.where, 'planner', label)
    assert.equal(ceilingRow(io, 'planner1'), undefined, label)
    assert.equal(journalReads, 0, label)
    assert.equal(Object.keys(io.calls.writes).some((path) => path.includes('enforcement-planner-')), false, label)
  }

  const rpcNoEnvelope = fakeIo({
    files: { [journal]: journalText([{ rpc_outcome: 'no-envelope', id: 'planner1', role: 'planner' }]) },
    envelopes: {
      'planner:1': { assignment_id: 'planner1', role: 'planner', status: 'insufficient', summary: 'rpc returned no envelope', artifacts: [], details: { degraded: 'rpc-no-envelope' } },
      'lead:1': leadEnv('escalate'),
    },
    runs: greenRuns,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const rpcNoEnvelopeResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, rpcNoEnvelope)
  assert.equal(rpcNoEnvelopeResult.status, 'escalation')
  assert.equal(ceilingRow(rpcNoEnvelope, 'planner1'), undefined)
  assert.equal(Object.keys(rpcNoEnvelope.calls.writes).some((path) => path.includes('enforcement-planner-')), false)

  const unconfigured = fakeIo({
    files: { [journal]: journalText([json('planner1', 'planner', 137)]) },
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: greenRuns,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  let unconfiguredJournalReads = 0
  const unconfiguredRead = unconfigured.readFile
  unconfigured.readFile = (path) => {
    if (path === journal) unconfiguredJournalReads += 1
    return unconfiguredRead(path)
  }
  const unconfiguredResult = driveTask(CTX, unconfigured)
  assert.equal(unconfiguredResult.status, 'done')
  assert.equal(unconfiguredJournalReads, 0)
  assert.equal(unconfigured.calls.logs.some((entry) => entry.seat_turn_ceiling), false)
  assert.deepEqual(unconfiguredResult.details.enforcements, [])

  const builder = fakeIo({
    files: { [journal]: journalText([json('builder1', 'builder', 137), json('builder2', 'builder', 1)]) },
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'lead:1': leadEnv('bounce', 'retry the build'),
      'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: greenRuns,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const builderResult = driveTask({ ...CTX, turnCeilings: { builder: 40 } }, builder)
  assert.equal(builderResult.status, 'done')
  assert.deepEqual(ceilingRow(builder, 'builder1'), { role: 'builder', dispatch: 'builder1', turns: 137, budget: 40, measured: true, enforced: true, absent_reason: null })
  assert.match(delivery(builder, 'builder'), /137 turns against a role budget of 40/)

  const reviewer = fakeIo({
    files: { [journal]: journalText([json('reviewer1', 'reviewer', 137), json('reviewer2', 'reviewer', 1)]) },
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv('bounce', 'retry the review'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: greenRuns,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const reviewerResult = driveTask({ ...CTX, turnCeilings: { reviewer: 40 } }, reviewer)
  assert.equal(reviewerResult.status, 'done')
  assert.deepEqual(ceilingRow(reviewer, 'reviewer1'), { role: 'reviewer', dispatch: 'reviewer1', turns: 137, budget: 40, measured: true, enforced: true, absent_reason: null })
  assert.equal(reviewer.calls.assign.filter((entry) => entry.role === 'reviewer').length, 2)
  assert.match(delivery(reviewer, 'reviewer'), /137 turns against a role budget of 40/)

  const lead = fakeIo({
    files: { [journal]: journalText([json('lead1', 'lead', 137)]) },
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'needs a lead decision' }),
      'lead:1': leadEnv('bounce'),
    },
    runs: greenRuns,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const leadResult = driveTask({ ...CTX, turnCeilings: { lead: 40 } }, lead)
  assert.equal(leadResult.status, 'escalation')
  assert.match(leadResult.details.escalation.why, /lead returned insufficient/)
  assert.deepEqual(ceilingRow(lead, 'lead1'), { role: 'lead', dispatch: 'lead1', turns: 137, budget: 40, measured: true, enforced: true, absent_reason: null })
  assert.equal(lead.calls.assign.filter((entry) => entry.role === 'lead').length, 1)
  assert.equal(Object.keys(lead.calls.writes).some((path) => path.includes('enforcement-lead-')), false)
})

test('b433 driver validates the task-local gate path and keeps post-acceptance leads unfenced', () => {
  const run = (gatePath, builderEnvelope = buildEnv()) => {
    const plan = planEnv({ details: { ...planEnv().details, gate_path: gatePath } })
    const io = fakeIo({
      envelopes: { 'planner:1': plan, 'builder:1': builderEnvelope, 'lead:1': leadEnv('escalate'), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
    })
    return { io, result: driveTask(CTX, io) }
  }
  const outside = run(`${CTX.checkout}/gate.mjs`)
  assert.equal(outside.result.status, 'done')
  assert.equal(outside.io.calls.assign.find((entry) => entry.role === 'builder').policy.gatePath, `${TD}/gate.mjs`)
  assert.equal(outside.io.calls.logs.some((entry) => entry.gate_path_rejected), true)
  const traversal = run(`${TD}/../repo/gate.mjs`)
  assert.equal(traversal.io.calls.assign.find((entry) => entry.role === 'builder').policy.gatePath, `${TD}/gate.mjs`)
  const custom = run(`${TD}/custom-gate.mjs`)
  assert.equal(custom.io.calls.assign.find((entry) => entry.role === 'builder').policy.gatePath, `${TD}/custom-gate.mjs`)

  const consulted = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': { status: 'insufficient', role: 'builder', summary: 'stuck', artifacts: [], details: {} }, 'lead:1': leadEnv('escalate') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, consulted)
  assert.equal(result.status, 'escalation')
  assert.deepEqual(consulted.calls.assign.find((entry) => entry.role === 'lead').policy.fence, [])
})

test('b433 driver requires a correlated refusal and never records stale or partial evidence', () => {
  const positive = suiteRefusalEnv()
  assert.equal(enforcementPreamble(positive).kind, 'suite-run-not-owned')
  const malformed = [
    (env) => { delete env.assignment_id; return env },
    (env) => { delete env.role; return env },
    (env) => { delete env.details.suite_refusal.role; return env },
    (env) => { env.details.suite_refusal.reason = `not-suite-run-not-ownedness at ${TD}/gate.mjs`; return env },
    (env) => { env.assignment_id = ''; return env },
    (env) => { env.role = ''; return env },
    (env) => { env.details.suite_refusal.role = 'reviewer'; return env },
  ]
  for (const mutate of malformed) {
    const env = mutate(JSON.parse(JSON.stringify(positive)))
    assert.deepEqual(enforcementPreamble(env), { kind: null, lines: [] })
  }

  const journal = `${TD}/journal.jsonl`
  const run = (env) => fakeIo({
    files: { [journal]: '{"event":"run-start"}\n' }, envelopes: { 'planner:1': env },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  for (const mutate of malformed.slice(0, 4)) {
    const io = run(mutate(JSON.parse(JSON.stringify(positive))))
    const result = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, io)
    const kinds = result.details.enforcements.map((entry) => entry.kind)
    assert.equal(kinds.includes('suite-run-not-owned'), false)
    assert.equal(kinds.includes('turn-ceiling-unmeasured'), true)
    assert.equal(Object.keys(io.calls.writes).some((path) => path.includes('enforcement-planner-')), false)
  }

  const stale = run({ ...positive, assignment_id: 'other-dispatch' })
  const staleResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, stale)
  assert.equal(staleResult.status, 'escalation')
  assert.deepEqual(staleResult.details.enforcements, [])
  assert.equal(Object.keys(stale.calls.writes).some((path) => path.includes('enforcement-planner-')), false)

  const partial = planEnv({ details: { ...planEnv().details, suite_refusal: { command: 'npm test', gate_path: `${TD}/gate.mjs` } } })
  const partialIo = run(partial)
  const partialResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, partialIo)
  const partialKinds = partialResult.details.enforcements.map((entry) => entry.kind)
  assert.equal(partialKinds.includes('suite-run-not-owned'), false)
  assert.equal(partialKinds.includes('turn-ceiling-unmeasured'), true)
})
