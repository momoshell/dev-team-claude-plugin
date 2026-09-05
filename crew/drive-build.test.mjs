// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  B376_FILES, B376_FINDING, B376_GREEN, B376_HARDENED, B376_IMPL_FILE, B376_MUT_RED, B376_PRE_RED, B376_TEST_FILE, B384_CORRECTED_FIND, B384_CORRECTED_REPLACE, B384_GREEN, B384_MUTATION, B384_RED, B44_LEADLESS_CTX, CHECK_BUILT, CHECK_CLEAN, CHECK_ENVELOPES, CHECK_FILE, CHECK_MUTATION, CHECK_PLAN, CHECK_RUNS, CONVERGE_CTX, CONVERGE_GATE, CONVERGE_PLAN, CTX, CTX_DIRECTED, CTX_REPAIR, DIRECTED_FILES, D_ASK, D_AUTO, ENVELOPE_FIELD_KINDS, EXECUTIONS, FAILURE_UPGRADE, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER, GATE_SUMMARY_PREFIX, HARDENING_MARKS, HARDENING_OUTCOMES, HARDENING_REFUSALS, MODIFIER_OUTCOMES, MUTATIONS_MAX, MUTATION_BINDING_FAILURES, MUTATION_OUTCOMES, PARTIAL_REVIEWED, RED, SENSITIVITY_FLOOR, SHAPE_MAJOR_PHASES, SHAPE_ROUNDED_STAGES, TD, THREW, TRIAGE_FILES, TRIAGE_NOTE, UNIVERSAL_STAGE_HEADS, VALIDATION_LANE_UNLOADABLE, VARIANTS, VARIANT_NAMES, WRITE_SURFACES, applyMutationAnchor, applyPrescriptionLines, b127GatePaths, b127PidAlive, b318Builders, b318SiteA, b376Build, b376DiskProofIo, b376ProofIo, b376Review, b376StageStack, b384Io, b44AssertLeadlessGate, b44GatePlan, bindMutationAnchor, buildEnv, collapseStages, dispositionIo, driveTask, existsSync, fakeIo, gateReapCommand, gateReapFresh, gateReapOriginal, gateReapSweepCommand, gateReapVerdict, hardenCommand, hardenWitnessCommand, hardeningBounceLines, hardeningBriefLines, hardeningDebt, hardeningOf, join, laneFence, leadEnv, mutationChangesTokens, outOfScopeFiles, planEnv, protectedPlanEnv, readFileSync, resumeGreen, resumeRed, reviewConvergeRun, reviewEnv, reviewFindings, rmSync, s843Ctx, s843Io, s843PlanEnv, s843Rows, scopeMatcher, scopedPath, scratchDir, shapeDefect, spawnSync, stageShape, treeDigest, triageEnv, undeclaredStage, validateHardened, validateMutations, validationPlan, validationProbeRun, validationRows,
} from './drive-fixtures.mjs'

test('the scope-gate catches a build that crossed another lane fence', () => {
  const file = 'scripts/factory/intake.mjs'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() },
    changed: [file],
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: [file] }] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /intake-loop/)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === 'lane-cmd' || cmd === 'suite-cmd'), false)
  assert.equal(io.calls.commits.length, 0)
})

test('clean scope does not fire the sensitivity floor or alter the happy-path stages', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.equal(io.calls.reseat.length, 0)
  assert.deepEqual(res.details.modifiers, [])
  assert.deepEqual(io.calls.emits.filter(({ kind }) => kind === 'modifier'), [])
  assert.equal(res.details.stages.some((label) => label.startsWith('escalate')), false)
})

test('the sensitivity floor has its own budget and does not spend failure-upgrade', () => {
  const outcomes = [
    { applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' },
    { applied: true, from: { id: 'old' }, to: { id: 'new' }, rung: 'mechanical→build' },
  ]
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => outcomes.shift(),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ modifier, outcome }) => ({ modifier, outcome })), [
    { modifier: SENSITIVITY_FLOOR, outcome: 'applied' },
    { modifier: FAILURE_UPGRADE, outcome: 'applied' },
  ])
  assert.equal(io.calls.reseat.length, 2)
  assert.equal(io.calls.reseat[1].options.reason, 'lane-bounce')
})

test('red lane bounces the builder with the failure output, then green -> done', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'reviewer:1': reviewEnv('pass'),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
    },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL x' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const builderAssigns = io.calls.assign.filter((a) => a.role === 'builder')
  assert.equal(builderAssigns.length, 2)
  const bounceBrief = io.calls.writes[builderAssigns[1].briefFile]
  assert.match(bounceBrief, /RED/)
  assert.match(bounceBrief, /FAIL x/)
  assert.equal(res.details.consults, 0) // mechanical bounce, no lead needed
})

test('a lane bounce records an applied failure-upgrade on the envelope and journal', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    emit: true,
    reseat: () => ({ applied: true, from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers, [{
    modifier: FAILURE_UPGRADE, kind: 'lane', role: 'builder', outcome: 'applied',
    from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build',
  }])
  assert.equal(io.calls.reseat.length, 1)
  assert.ok(io.calls.logs.some((line) => line.modifier?.modifier === FAILURE_UPGRADE))
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [{
    kind: 'modifier', modifier: FAILURE_UPGRADE, bounce: 'lane', role: 'builder', outcome: 'applied',
    why: null, from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build',
  }])
})

test('a refused reseat emits one transport modifier attempt without a to cell', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'transport', why: 'headless seat cannot re-seat', from: { id: 'old', effort: 'max' } }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [{
    kind: 'modifier', modifier: FAILURE_UPGRADE, bounce: 'lane', role: 'builder', outcome: 'transport',
    why: 'headless seat cannot re-seat', from: { id: 'old', effort: 'max' }, to: null, rung: null,
  }])
})

test('throwing on modifier emission leaves stages, commit, and status unchanged', () => {
  const input = {
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'transport', why: 'refused' }),
  }
  const plain = driveTask(CTX, fakeIo(input))
  const noisy = driveTask(CTX, fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } }))
  assert.deepEqual({ stages: noisy.details.stages, commit: noisy.details.commit, status: noisy.status }, {
    stages: plain.details.stages, commit: plain.details.commit, status: plain.status,
  })
})

test('a second bounce records spent and never calls reseat again', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['applied', 'spent'])
  assert.equal(io.calls.reseat.length, 1)
})

// The budget is spent by an APPLIED upgrade, never by a refused attempt. The
// mutation this kills: moving `upgradeSpent = true` back above the io.reseat
// call, which is what the factory's own boot shape would have hit — builder and
// reviewer are headless-rpc seats that refuse, so a refused builder bounce would
// have burned the budget the planner's headless-json seat could still have used.
test('a refused reseat does not spend the budget, and a later bounce can still apply', () => {
  const outcomes = [
    { applied: false, reason: 'transport', why: 'a headless-rpc seat reads its cell once at worker spawn' },
    { applied: true, from: { id: 'old', effort: 'medium' }, to: { id: 'old', effort: 'max' }, rung: 'mechanical→build' },
  ]
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => outcomes.shift(),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['transport', 'applied'])
  assert.equal(io.calls.reseat.length, 2)
})

// An io with no reseat method cannot grow one mid-run, so that fact is recorded
// once rather than once per bounce. Mutation killed: dropping the spend on the
// no-method branch, which would repeat the same entry for every later bounce.
test('an io with no reseat records the fact once, not once per bounce', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  delete io.reseat
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['transport', 'spent'])
})

test('an io without reseat records transport without changing the bounce loop', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.modifiers.length, 1)
  assert.equal(res.details.modifiers[0].outcome, 'transport')
  assert.match(res.details.modifiers[0].why, /no reseat/)
})

test('a throwing reseat is recorded as transport and never escapes driveTask', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => { throw new Error('reseat exploded') },
  })
  let res
  assert.doesNotThrow(() => { res = driveTask(CTX, io) })
  assert.equal(res.status, 'done')
  assert.equal(res.details.modifiers[0].outcome, 'transport')
  assert.match(res.details.modifiers[0].why, /reseat exploded/)
})

test('failure-upgrade refusals preserve closed reasons and normalize unknown reasons', () => {
  const run = (result) => driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], reseat: () => result,
  }))
  for (const reason of ['exhausted', 'no-tier', 'agent-change']) {
    const res = run({ applied: false, reason, why: `${reason} refusal`, from: null })
    assert.equal(res.details.modifiers[0].outcome, reason)
  }
  const normalized = run({ applied: false, reason: 'banana', why: 'unknown', from: null })
  assert.equal(normalized.details.modifiers[0].outcome, 'transport')
  assert.ok(MODIFIER_OUTCOMES.includes(normalized.details.modifiers[0].outcome))
})

test('failure-upgrade is neutral to the task envelope apart from its record', () => {
  const run = (reseat) => driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], ...(reseat ? { reseat } : {}),
  }))
  const strip = (result) => {
    const out = JSON.parse(JSON.stringify(result))
    delete out.details.modifiers
    return out
  }
  const plain = run(null)
  const throwing = run(() => { throw new Error('boom') })
  const applying = run(() => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }))
  assert.deepEqual(strip(throwing), strip(plain))
  assert.deepEqual(strip(applying), strip(plain))
})

test('an escalation carries failure-upgrade modifiers', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'lead:1': leadEnv('escalate') },
    runs: { 'lane-cmd': { ok: false, output: 'FAIL forever' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.ok(res.details.modifiers.length >= 1)
  assert.equal(res.details.modifiers[0].modifier, FAILURE_UPGRADE)
})

test('bounced lane run commits the planner subject, round-2 builder body, and issue refs', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, commit_subject: 'fix(crew): three crew-runtime defects', issues: [112, 114, 117] } }),
      'builder:1': buildEnv({ details: { ...buildEnv().details, commit_message: 'wip: initial attempt' } }),
      'builder:2': buildEnv({ details: { ...buildEnv().details, commit_message: 'test: repair the lane assertion' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'RED' }, 'lane-cmd:2': { ok: true, output: '' },
      'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  const message = io.calls.commits[0].message
  assert.equal(message.split('\n')[0], 'fix(crew): three crew-runtime defects')
  assert.match(message, /test: repair the lane assertion/)
  assert.match(message, /#112/)
  assert.doesNotMatch(message, /wip: initial attempt/)
})

test('out-of-scope edits bounce mechanically naming the offending files', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'reviewer:1': reviewEnv('pass'),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['a.mjs', 'rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /OUTSIDE the plan/.test(w))
  assert.ok(bounce, 'expected a scope bounce brief')
  assert.match(bounce, /rogue\.mjs/)
})

test('review changes-needed bounces the builder, second review passes', () => {
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.match(Object.values(io.calls.writes).find((w) => /Review bounce/.test(w)), /review\.md/)
})

test('a re-review that surfaces NEW must-fixes is charged like any other', () => {
  const firstFindings = [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'the original defect', hardening: 'ungateable', hardening_why: 'legacy charging fixture' }]
  const secondFindings = [{ id: 'RV2-1', severity: 'must-fix', location: 'a.mjs:9', summary: 'a NEW defect the fix introduced', hardening: 'ungateable', hardening_why: 'legacy charging fixture' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', firstFindings),
      'reviewer:2': reviewEnv('changes-needed', secondFindings),
      'lead:1': leadEnv('accept'),
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const rounds = io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].accounting, 'counted')
  assert.equal(rounds[0].charged, 1)
  assert.equal(rounds[1].accounting, 'counted')
  assert.equal(rounds[1].charged, 2)
})

test('the review bounce brief tells the builder to apply the review verbatim', () => {
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
  const brief = io.calls.writes[`${TD}/build-bounce-r1.md`]
  assert.ok(brief.startsWith('# Review bounce (round 1)'))
  assert.match(brief, /review\.md/)
  assert.match(brief, /Plan:/)
  assert.match(brief, /do not re-derive/)
  assert.equal(applyPrescriptionLines('the review')[0], '')
  assert.match(applyPrescriptionLines('the review').join('\n'), /the review PRESCRIBED, verbatim/)
})

test('builder questions make one consult and carry keyed answers into one build bounce', () => {
  const questions = [
    { id: 'b1', question: 'Which helper should change?' },
    { id: 'b2', question: 'Which test should cover it?' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'plan gap', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer the builder', { answers: [{ id: 'b2', answer: 'crew/drive.test.mjs' }] }),
      'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
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
  const bounce = io.calls.writes[`${TD}/build-bounce-r1.md`]
  assert.ok(bounce.includes('b2: Which test should cover it?'))
  assert.ok(bounce.includes('ANSWER: crew/drive.test.mjs'))
  assert.ok(bounce.includes('b1: Which helper should change?'))
  assert.ok(bounce.includes('UNANSWERED'))
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['b1'])
})

test('review rounds exhausted + lead escalates -> escalation envelope, NO commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

test('planner envelope without files_in_scope escalates — the scope gate cannot be skipped', () => {
  const env = planEnv(); delete env.details.files_in_scope
  const io = fakeIo({ envelopes: { 'planner:1': env } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /files_in_scope/)
})

test('a timed-out gate runner is bounded and the sweep reaps its leaked descendant', { timeout: 90_000 }, () => {
  const dir = scratchDir('b127-gate-timeout-')
  const paths = b127GatePaths(dir)
  const cmd = `nohup sleep 40 >/dev/null 2>&1 & echo "leaked $!"; sleep 60`
  const wrapped = gateReapCommand({ cmd, ...paths })
  const started = Date.now()
  const result = spawnSync('/bin/sh', ['-c', wrapped], { encoding: 'utf8', timeout: 4_000 })
  const elapsed = Date.now() - started
  const pid = /leaked (\d+)/.exec(String(result.stdout || ''))?.[1]
  try {
    assert.ok(pid, `expected the fixture to report its leaked descendant pid, found ${JSON.stringify(result.stdout)}`)
    assert.ok(elapsed < 15_000, `expected the runner timeout to bound the invocation, elapsed ${elapsed}ms`)
    assert.equal(result.error?.code, 'ETIMEDOUT')
    const sweep = spawnSync('/bin/sh', ['-c', gateReapSweepCommand(paths)], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(sweep.status, 0)
    const report = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : null
    const verdict = gateReapVerdict(report)
    assert.equal(verdict.outcome, 'proven')
    assert.equal(verdict.signals, 1)
    const deadline = Date.now() + 10_000
    while (b127PidAlive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.05'])
    assert.equal(b127PidAlive(pid), false, `leaked descendant ${pid} remained alive after the timeout sweep`)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    const pgid = existsSync(paths.pgidFile) ? readFileSync(paths.pgidFile, 'utf8').trim() : ''
    const ownPgid = String(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout || '').trim()
    if (/^\d+$/.test(pgid) && Number(pgid) > 1 && pgid !== ownPgid) spawnSync('kill', ['-9', `-${pgid}`])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGate sweeps each wrapped invocation without adding a sweep to calls.run', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.sweeps.length, 2)
  assert.ok(io.calls.sweeps.every((cmd) => String(cmd).includes(GATE_REAP_SWEEP_MARKER)))
  assert.ok(io.calls.run.every(({ cmd }) => !String(cmd).includes(GATE_REAP_SWEEP_MARKER)))
})

test('a gate reap that cannot be measured is reported unproven, never assumed dead', () => {
  for (const report of [null, '', '{"pgid":"7","outc', '{"outcome":"assumed"}']) {
    assert.equal(gateReapVerdict(report).outcome, 'unproven')
    assert.equal(gateReapVerdict(report).signals, 0)
  }
  const gate = `gate-cmd\n${GATE_REAP_CMD_EOF}`
  const reportPath = `${TD}/gate-reap.1.json`
  const io = fakeIo({
    emit: true, writeThrough: true,
    files: { [reportPath]: '{"pgid":"9","outcome":"proven","reason":"probe-dead","signals":1,"survivors":"9"}' },
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { [`${gate}:1`]: { ok: false, output: RED(3) }, [`${gate}:2`]: { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'gate')
  assert.equal(result.status, 'done')
  assert.equal(event.reap.outcome, 'unproven')
  assert.ok(io.calls.logs.some((entry) => entry.gate_reap?.outcome === 'unproven'))
})

test('a gate reap report that could not be cleared is never read', () => {
  const stale = '{"pgid":"999","outcome":"proven","reason":"probe-dead","signals":1,"survivors":"1"}'
  assert.equal(gateReapFresh(false, stale), null)
  assert.equal(gateReapFresh(true, stale), stale)
  const gate = `gate-cmd\n${GATE_REAP_CMD_EOF}`
  const reportPath = `${TD}/gate-reap.1.json`
  const io = fakeIo({
    emit: true, writeThrough: true, throwWrites: [reportPath],
    files: { [reportPath]: stale },
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { [`${gate}:1`]: { ok: false, output: RED(3) }, [`${gate}:2`]: { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'gate')
  assert.equal(result.status, 'done')
  assert.equal(event.reap.outcome, 'unproven')
  assert.ok(io.calls.logs.some((entry) => entry.gate_reap?.outcome === 'unproven'))
})

test('gate reap wrappers round-trip shell text and refuse a delimiter-bearing command', () => {
  const dir = scratchDir('b127-gate-text-')
  try {
    const paths = b127GatePaths(dir)
    const command = `printf "a'b\\\" $VAR"\n# newline\necho done`
    const wrapped = gateReapCommand({ cmd: command, ...paths })
    assert.equal(gateReapOriginal(wrapped), command)
    const bypass = `echo before\n${GATE_REAP_CMD_EOF}\necho after`
    assert.equal(gateReapCommand({ cmd: bypass, ...paths }), bypass)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate invocations tally already-dead reaps and do not journal clean outcomes', () => {
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
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.deepEqual(result.details.gate.reap, { invocations: 2, 'already-dead': 2, proven: 0, failed: 0, unproven: 0 })
  assert.equal(io.calls.logs.filter((entry) => entry.gate_reap).length, 0)
  const wrappedGates = io.calls.wrapped.filter(({ wrapped, cmd }) => wrapped !== cmd)
  assert.deepEqual(wrappedGates.map(({ cmd }) => cmd), ['gate-cmd', 'gate-cmd'])
  assert.ok(wrappedGates.every(({ clean }) => clean === false))
})

test('gate red after build feeds back verbatim and bounces without a lead consult', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: false, output: 'expected exportX, found nothing, at a.mjs:12' },
      'gate-cmd:3': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 0)
  const bounce = Object.values(io.calls.writes).find((w) => /ACCEPTANCE GATE is red/.test(w))
  assert.match(bounce, /expected exportX, found nothing/)
  assert.match(bounce, /immutable to you/)
})

test('repeated gate failures trigger reviewer triage; gate-defect diagnosis lets the lead repair once and re-runs without a builder round', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },   // baseline
      'gate-bad:2': { ok: false, output: 'bogus fail A' },   // build r1 -> bounce
      'gate-bad:3': { ok: false, output: 'bogus fail B' },   // build r2 -> triage fires (round >= 2)
      'gate-fixed': { ok: true, output: '' },                // repaired gate green immediately
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.repairs, 1)
  // builder ran exactly twice — the repair re-run consumed NO builder round
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  const gateNames = io.calls.emits.filter((event) => event.kind === 'gate').map((event) => event.name)
  assert.ok(gateNames.includes('gate-repair:1'))
  assert.ok(gateNames.includes('gate-reverify:1') === false)
  assert.equal(io.calls.emits.filter((event) => event.kind === 'attention').length, 1)
  const repair = Object.values(io.calls.writes).find((w) => /GATE DEFECT/.test(w))
  assert.match(repair, /may NOT weaken any legitimate check/)
})

test('a repaired gate proven red on the pristine tree proceeds — and the proof costs no builder round', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: 'red on pristine\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.reverified, true)
  assert.deepEqual(io.calls.runClean, [{ cmd: 'gate-fixed', n: 1 }])
  const gateNames = io.calls.emits.filter((event) => event.kind === 'gate').map((event) => event.name)
  assert.ok(gateNames.includes('gate-reverify:1'))
  assert.ok(gateNames.includes('gate-repair:1'))
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

// REGRESSION: seatIo.runClean is a shorthand METHOD that calls `this.run(cmd)`
// (crew/seat-io.mjs:241,245). #130 routed the reverify call through
// runGate(..., io.runClean), detaching it, and every real gate-reverify
// crashed with "Cannot read properties of undefined (reading 'run')" — caught
// only by a live run. The fakes above cannot catch it: their runClean is an
// arrow that never reads `this`. This one models the shipped shape.
test('an io whose runClean is a this-using method survives gate-reverify', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  // Exactly seatIo's shape: a method that reaches its sibling through `this`.
  const pristine = { ok: false, output: 'red on pristine\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' }
  let sawThis = false
  io.runClean = function runClean(cmd) {
    sawThis = true
    this.run(cmd) // the line that threw when the method was passed detached
    return pristine
  }
  const res = driveTask(CTX, io)
  assert.equal(sawThis, true, 'runClean must actually have been reached')
  assert.notEqual(res.details?.escalation?.where, 'driver', 'a detached runClean crashes the driver')
  assert.equal(res.details.gate.reverified, true)
})

test('a repaired gate GREEN on the pristine tree is vacuous — escalate, never commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /STILL green/)
  assert.equal(io.calls.commits.length, 0)
})

test('an io without runClean keeps the repair path exactly as it was', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.reverified, false)
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(io.calls.run.map((r) => r.cmd), ['gate-bad', 'lane-cmd', 'gate-bad', 'lane-cmd', 'gate-bad', 'gate-fixed', 'suite-cmd'])
})

test('first green records discrimination without adding a reverified field', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.reverified, undefined)
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 1)
  const gates = io.calls.emits.filter((event) => event.kind === 'gate')
  assert.ok(gates.every((event) => event.generation === 1 && typeof event.pristine === 'boolean'))
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'discrimination'), [{
    kind: 'discrimination', generation: 1, verdict: 'proven',
    summary: { total: 3, failed: 3, errored: 0 }, note: null,
  }])
})

test("a failed first-green proof bounces the LEAD for a gate repair, never the builder", () => {
  const pristineOutput = 'green pristine output — the gate did not inspect the work'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: pristineOutput },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.ok(io.calls.writes[`${TD}/gate-discrimination-bounce.md`].includes(pristineOutput))
})

test('missing runClean records unproven without adding a proof stage or changing the run', () => {
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
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'unproven')
  assert.equal(io.calls.runClean.length, 0)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.stages.includes('gate-proof:1'), false)
  assert.equal(res.details.stages.filter((stage) => /bounce|escalate:/.test(stage)).length, 0)
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'discrimination'), [{
    kind: 'discrimination', generation: 1, verdict: 'unproven', summary: null, note: null,
  }])
})

test('mutation anchors bind exact or whitespace-normalized token spans', () => {
  const original = 'const one = true\nconst two = true\n'
  assert.deepEqual(bindMutationAnchor(original, 'true'), { mode: 'exact', spans: [] })
  assert.deepEqual(applyMutationAnchor(original, 'true', 'false'), {
    mode: 'exact', text: 'const one = false\nconst two = false\n',
  })

  const wrapped = 'const value = call(first,\n  second)\n'
  const bound = bindMutationAnchor(wrapped, 'call(first, second)')
  assert.equal(bound.mode, 'normalized')
  assert.equal(bound.spans.length, 1)
  assert.equal(wrapped.slice(bound.spans[0].start, bound.spans[0].end), 'call(first,\n  second)')

  const replacement = 'alpha(\n    "beta",   "gamma"\n)'
  const applied = applyMutationAnchor(wrapped, 'call(first, second)', replacement)
  assert.equal(applied.mode, 'normalized')
  assert.equal(applied.text, `const value = ${replacement}\n`)

  const commentCrossing = '// load-bearing\nexport const GUARD = true\n'
  const commentFind = '// load-bearing export const GUARD = true'
  assert.equal(bindMutationAnchor(commentCrossing, commentFind).mode, 'unsafe')
  assert.deepEqual(applyMutationAnchor(commentCrossing, commentFind, 'export const GUARD = false'), { mode: 'unsafe', text: null })
  assert.equal(bindMutationAnchor('export const GUARD =\ntrue // trailing\n', 'export const GUARD = true // trailing').mode, 'normalized')
  assert.equal(bindMutationAnchor('// before\nexport const GUARD = true\n', 'export const GUARD =\ntrue').mode, 'normalized')
  assert.equal(bindMutationAnchor('if (ready) {\n  try {', 'if (ready) { try {').mode, 'normalized')

  const standaloneCr = '// load-bearing\rexport const GUARD = true\n'
  assert.equal(bindMutationAnchor(standaloneCr, commentFind).mode, 'unsafe')
  assert.deepEqual(applyMutationAnchor(standaloneCr, commentFind, 'export const GUARD = false'), { mode: 'unsafe', text: null })

  assert.deepEqual(bindMutationAnchor('export const guard = true\n', 'export const guards = true'), { mode: 'absent', spans: [] })
  const twice = 'const a = pick(one,\n  two)\nconst b = pick(one, two)\n'
  const ambiguous = bindMutationAnchor(twice, 'pick(one, \n two)')
  assert.equal(ambiguous.mode, 'ambiguous')
  assert.equal(ambiguous.spans.length, 2)
  assert.deepEqual(applyMutationAnchor(twice, 'pick(one, \n two)', 'pick(one)'), { mode: 'ambiguous', text: null })

  for (const [originalInput, findInput] of [[null, 'x'], ['x', null], ['x', '']]) {
    assert.doesNotThrow(() => bindMutationAnchor(originalInput, findInput))
    assert.equal(bindMutationAnchor(originalInput, findInput).mode, 'absent')
  }
  assert.equal(applyMutationAnchor(null, 'x', 'y').mode, 'absent')
})

test('a re-wrapped built anchor binds and the per-check proof kills the check', () => {
  const built = 'export const laneId = (task) =>\n  slug(task.name,\n    task.id)\n'
  const mutation = { check: 'wrapped', file: 'a.mjs', find: 'slug(task.name, task.id)', replace: 'slug(task.id)' }
  const mutated = 'export const laneId = (task) =>\n  slug(task.id)\n'
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([mutation]),
    runs: CHECK_RUNS(`FAIL wrapped: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'killed')
  assert.deepEqual(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).map(({ content }) => content), [mutated, built])
})

test('b385 A1 the bind check reads every declaration before the first checkout write and journals their statuses', () => {
  const mutations = [
    { check: 'check-one', file: 'a.mjs', find: 'true', replace: 'false' },
    { check: 'ghost', file: 'a.mjs', find: 'true\nexport const other = false', replace: 'false\nexport const other = true' },
  ]
  const built = 'export const guard = true\n// interposed comment block\nexport const other = false\n'
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const firstWrite = io.calls.checkoutLog.findIndex(({ op }) => op === 'write')
  assert.ok(firstWrite >= 0)
  const declarationReads = io.calls.checkoutLog.slice(0, firstWrite).filter(({ op, path }) => op === 'read' && path === CHECK_FILE)
  assert.ok(declarationReads.length >= 2)
  assert.ok(io.calls.writeLog.some(({ path }) => path === CHECK_FILE))
  const bind = io.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  assert.deepEqual(bind?.checks, [
    { check: 'check-one', file: 'a.mjs', status: 'exact' },
    { check: 'ghost', file: 'a.mjs', status: 'absent' },
  ])
  assert.deepEqual({ declared: bind?.declared, exact: bind?.exact, normalized: bind?.normalized, absent: bind?.absent, corrected: bind?.corrected }, {
    declared: 2, exact: 1, normalized: 0, absent: 1, corrected: 0,
  })
})

test('a token-different anchor is absent and writes nothing', () => {
  const mutation = { ...CHECK_MUTATION, check: 'token-different', find: 'guards', replace: 'false' }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'anchor-absent')
  assert.match(row.why, /exactly or whitespace-normalized/)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('a two-span anchor is ambiguous and writes nothing', () => {
  const built = 'const a = pick(one,\n  two)\nconst b = pick(one, two)\n'
  const mutation = { check: 'two-spans', file: 'a.mjs', find: 'pick(one, \n two)', replace: 'pick(one)' }
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'anchor-ambiguous')
  assert.match(row.why, /more than one whitespace-normalized span/)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('a comment-crossing span is anchor-unsafe and writes nothing', () => {
  const built = '// load-bearing\nexport const GUARD = true\n'
  const mutation = {
    check: 'anchor-unsafe', file: 'a.mjs',
    find: '// load-bearing export const GUARD = true', replace: 'export const GUARD = false',
  }
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.deepEqual({ outcome: row.outcome, file: row.file, summary: row.summary }, { outcome: 'anchor-unsafe', file: 'a.mjs', summary: null })
  assert.equal(row.why, "the declared find's normalized match crosses a line that carries a // comment inside the span, so a verbatim replacement would land in the comment; declare a find that starts after the comment")
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.match(res.details.escalation.why, /did not BIND/)
  assert.doesNotMatch(res.details.escalation.why, /did not kill/)
})

test('a missing file and an unbindable find keep unapplied on the missing file only', () => {
  const mutations = [
    { check: 'missing-file', file: 'missing.mjs', find: 'anything', replace: 'other' },
    { check: 'unbindable', file: 'a.mjs', find: 'guards', replace: 'false' },
  ]
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'a.test.mjs', 'missing.mjs'], gate_cmd: 'gate-cmd', mutations } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'gate-fixed:1': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const rows = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks
  assert.deepEqual(rows.map(({ check, outcome }) => ({ check, outcome })), [
    { check: 'missing-file', outcome: 'unapplied' }, { check: 'unbindable', outcome: 'anchor-absent' },
  ])
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('binding-failure escalation says BIND while survived keeps did-not-kill wording', () => {
  const run = (mutation, files, mutationRun) => {
    const io = fakeIo({
      files, writeThrough: true,
      cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
      runs: { ...CHECK_RUNS(), 'gate-cmd:3': mutationRun, 'gate-fixed:1': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    return driveTask(CTX, io)
  }
  const binding = run({ ...CHECK_MUTATION, check: 'nobind', find: 'guards', replace: 'false' }, { [CHECK_FILE]: CHECK_BUILT }, { ok: true, output: '' })
  assert.match(binding.details.escalation.why, /did not BIND/)
  const survived = run(CHECK_MUTATION, { [CHECK_FILE]: CHECK_BUILT }, { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` })
  assert.match(survived.details.escalation.why, /did not kill/)
  assert.doesNotMatch(survived.details.escalation.why, /did not BIND/)
})

test('mutation binding failures are frozen and exclude gate outcomes', () => {
  assert.equal(Object.isFrozen(MUTATION_BINDING_FAILURES), true)
  assert.deepEqual([...MUTATION_BINDING_FAILURES].sort(), ['anchor-absent', 'anchor-ambiguous', 'anchor-unsafe', 'unapplied'])
  assert.ok(MUTATION_BINDING_FAILURES.length < MUTATION_OUTCOMES.length)
  for (const outcome of MUTATION_BINDING_FAILURES) assert.ok(MUTATION_OUTCOMES.includes(outcome))
  for (const outcome of ['killed', 'exempt', 'survived']) assert.equal(MUTATION_BINDING_FAILURES.includes(outcome), false)
  assert.deepEqual(MUTATION_OUTCOMES.filter((outcome) => !['killed', 'exempt'].includes(outcome) && !MUTATION_BINDING_FAILURES.includes(outcome)), ['survived'])
})

// --- b37: per-check gate discrimination -------------------------------------
test('validateMutations accepts a mutation and exemption and rejects malformed declarations', () => {
  const inScope = scopeMatcher(['a.mjs', 'a.test.mjs'])
  assert.deepEqual(validateMutations([CHECK_MUTATION, { check: 'skip', exempt: 'not applicable' }], inScope), [])
  const cases = [
    null, 42, [{ file: 'a.mjs', find: 'a', replace: 'b' }], [CHECK_MUTATION, CHECK_MUTATION],
    [{ ...CHECK_MUTATION, file: 'crew/drive.mjs' }], [{ ...CHECK_MUTATION, file: 'a/' }],
    [{ ...CHECK_MUTATION, file: '/tmp/a.mjs' }], [{ ...CHECK_MUTATION, find: '' }],
    [{ ...CHECK_MUTATION, find: 'true', replace: 'true' }],
    [{ check: 'x', exempt: 'why', file: 'a.mjs' }], [{ check: 'x', exempt: '' }],
    [{ ...CHECK_MUTATION, check: '' }], [{ ...CHECK_MUTATION, check: 'bad\nlabel' }],
    [{ ...CHECK_MUTATION, check: 'bad\rlabel' }], [{ ...CHECK_MUTATION, check: '   ' }],
    [{ ...CHECK_MUTATION, check: ' check-one ' }], [{ ...CHECK_MUTATION, check: '-cache' }],
    [{ ...CHECK_MUTATION, check: 'cache/v2' }], [{ ...CHECK_MUTATION, check: 'bad label' }], [{ ...CHECK_MUTATION, check: 'bad:label' }],
    Array.from({ length: MUTATIONS_MAX + 1 }, (_, i) => ({ ...CHECK_MUTATION, check: `c${i}` })),
  ]
  for (const entries of cases) {
    const errors = validateMutations(entries, inScope)
    assert.ok(errors.length > 0, JSON.stringify(entries))
    assert.ok(errors.every((error) => error.why), JSON.stringify(entries))
  }

  const whitespaceReason = 'find and replace differ only in whitespace — that mutates no token'
  const whitespaceOnly = { ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,\tb)' }
  assert.deepEqual(validateMutations([whitespaceOnly], inScope), [{ entry: whitespaceOnly, why: whitespaceReason }])
  const identical = { ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,  b)' }
  assert.deepEqual(validateMutations([identical], inScope), [{ entry: identical, why: 'find and replace are identical — that mutates nothing' }])
  assert.deepEqual(validateMutations([{ ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,  c)' }], inScope), [])

  const normalizedPairs = [
    { find: 'fn(a,  b)', replace: 'fn(a,\tb)', built: 'prefix fn(a,\t b) suffix' },
    { find: 'fn(a,\r\n b)', replace: 'fn(a, b)', built: 'prefix fn(a,\n  b) suffix' },
    { find: 'fn(a, \r\n\tb)', replace: 'fn(a,\tb)', built: 'prefix fn(a,\r\n b) suffix' },
  ]
  for (const pair of normalizedPairs) {
    assert.equal(bindMutationAnchor(pair.built, pair.find).mode, 'normalized')
    assert.equal(validateMutations([{ ...CHECK_MUTATION, find: pair.find, replace: pair.replace }], inScope).length, 1)
  }
  for (const [find, replace] of [['fn(a,\fb)', 'fn(a, b)'], ['fn(a, b)', 'fn(a, b)']]) {
    assert.deepEqual(validateMutations([{ ...CHECK_MUTATION, find, replace }], inScope), [])
  }
})

test('a present-but-misdelimited FAIL label is diagnosed as a delimiter, not an absent print', () => {
  for (const [label, output] of [['C1', 'FAIL C1 — why'], ['check-one', 'FAIL check-one why']]) {
    const mutation = { ...CHECK_MUTATION, check: label }
    const io = fakeIo({
      files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
      cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
      runs: {
        ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
        'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
        'gate-fixed:2': { ok: false, output: `FAIL ${label}: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'done')
    const event = io.calls.emits.find((entry) => entry.kind === 'check-discrimination')
    const row = event.checks[0]
    assert.equal(row.outcome, 'survived')
    assert.match(row.why, new RegExp(`DID print "FAIL ${label}"`))
    assert.match(row.why, /must END THE LINE or be followed by a colon/)
    assert.doesNotMatch(row.why, new RegExp(`printed no "FAIL ${label}" line`))
    assert.equal(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0].why, row.why)
  }
})

test('a genuinely absent FAIL label keeps the absent-line diagnosis', () => {
  const label = 'check-one'
  const output = 'PASS check-one'
  const mutation = { ...CHECK_MUTATION, check: label }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: {
      ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
      'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:2': { ok: false, output: `FAIL ${label}: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
    },
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const journal = io.calls.logs.find((line) => line.gate_check_discriminations)
  const row = journal.gate_check_discriminations[0]
  assert.match(row.why, /printed no "FAIL check-one" line/)
  assert.match(row.why, /not the one under proof/)
  assert.doesNotMatch(row.why, /DID print/)
})

test('the delimiter diagnosis reaches the escalation record', () => {
  const label = 'C1'
  const output = 'FAIL C1 — why'
  const mutation = { ...CHECK_MUTATION, check: label }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: {
      ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
      'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:2': { ok: false, output: `${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
    },
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /DID print "FAIL C1"/)
})

test('per-check mutation records an additive killed row and event', () => {
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'check-one', outcome: 'killed', file: 'a.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null })
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination').length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 3)
})

test('per-check mutations restore each file byte-identically', () => {
  const mutations = [CHECK_MUTATION, { check: 'check-two', file: 'a.mjs', find: 'guard', replace: 'fence' }]
  const runs = { ...CHECK_RUNS('FAIL check-one: caught\nGATE-SUMMARY {"total":3,"failed":1,"errored":0}'),
    'gate-cmd:4': { ok: false, output: 'FAIL check-two: caught\nGATE-SUMMARY {"total":3,"failed":1,"errored":0}' } }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const writes = io.calls.writeLog.filter(({ path }) => path === CHECK_FILE)
  assert.deepEqual(writes.map(({ content }) => content), [
    'export const guard = false\n', CHECK_BUILT, 'export const fence = true\n', CHECK_BUILT,
  ])
  assert.equal(io.calls.files[CHECK_FILE], CHECK_BUILT)
})

test('an exemption is recorded with its reason and runs no mutation gate', () => {
  const mutations = [{ check: 'skip', exempt: 'not applicable' }, CHECK_MUTATION]
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'skip', outcome: 'exempt', why: 'not applicable', file: null, summary: null })
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 3)
})

test('no mutation declaration leaves whole-gate proof output unchanged', () => {
  const io = fakeIo({ cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(undefined), runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(Object.hasOwn(res.details.gate, 'check_discrimination'), false)
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination').length, 0)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 2)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.equal(res.details.stages.some((stage) => stage.endsWith(':checks')), false)
})

test('a malformed mutation declaration escalates at plan before assigning a builder', () => {
  const io = fakeIo({ envelopes: { 'planner:1': CHECK_PLAN([{ check: 'missing-file' }]) } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('an anchor-absent mutation is not accepted as proof', () => {
  const mutation = { ...CHECK_MUTATION, check: 'ghost', find: 'missing text' }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'anchor-absent')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(res.details.gate.repairs, 0)
  assert.equal(res.details.escalation.why.includes('ghost'), true)
  assert.deepEqual(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0], { check: 'ghost', outcome: 'anchor-absent', file: 'a.mjs', summary: null, why: 'the declared find text is nowhere in the built a.mjs, exactly or whitespace-normalized' })
  assert.equal(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).length, 0)
})

test('an interrupted read records unproven per-check evidence without losing the build', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, throwOn: 'read', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.equal(res.details.gate.check_discriminations.length, 0)
  assert.equal(io.calls.commits.length, 1)
  assert.ok(io.calls.logs.some((line) => line.gate_check_proof_unproven))
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_bind).length, 0)
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})

test('a failed restore escalates rather than committing the driver mutation', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, throwOn: 'restore', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.equal(io.calls.commits.length, 0)
  assert.match(res.details.escalation.why, /a\.mjs/)
})

test('a thrown mutation gate with a successful restore remains contained', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const run = io.run
  io.run = function (cmd) {
    const original = gateReapOriginal(cmd)
    if (original === 'gate-cmd' && this.calls.run.filter(({ cmd: name }) => name === original).length >= 2) throw new Error('mutation gate exploded')
    return run.call(this, cmd)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.equal(io.calls.files[CHECK_FILE], CHECK_BUILT)
  assert.equal(io.calls.commits.length, 1)
})

test('a surviving mutation enters the existing lead gate repair path', () => {
  const fixedRuns = {
    ...CHECK_RUNS(),
    'gate-cmd:3': { ok: true, output: `still green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
    'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
    'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
  }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: fixedRuns, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0].why, 'the gate stayed GREEN under the mutation')
})

test('b385 B1 an unresolved anchor escalates at anchor-absent and never reaches gate custody', () => {
  const first = b384Io()
  const firstRes = driveTask(CTX, first)
  assert.equal(firstRes.status, 'escalation')
  assert.equal(firstRes.details.escalation.where, 'anchor-absent')
  assert.match(firstRes.details.escalation.why, /\banchor-absent\b/)
  assert.equal(first.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
  assert.equal(firstRes.details.gate.repairs, 0)

  const interrupted = b384Io({
    mutations: [CHECK_MUTATION, B384_MUTATION], scope: ['a.mjs', 'crew/drive.mjs'],
    files: { [CHECK_FILE]: CHECK_BUILT }, throwMutation: true,
  })
  const interruptedRes = driveTask(CTX, interrupted)
  assert.equal(interruptedRes.status, 'escalation')
  assert.equal(interruptedRes.details.escalation.where, 'anchor-absent')
  assert.match(interruptedRes.details.escalation.why, /B2/)
  assert.equal(interruptedRes.details.gate.repairs, 0)
  assert.equal(interrupted.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)

  const mixed = b384Io({
    mutations: [CHECK_MUTATION, B384_MUTATION], scope: ['a.mjs', 'crew/drive.mjs'],
    files: { [CHECK_FILE]: CHECK_BUILT }, runs: { 'gate-cmd:3': { ok: true, output: B384_GREEN } },
  })
  const mixedRes = driveTask(CTX, mixed)
  assert.equal(mixedRes.status, 'escalation')
  assert.equal(mixedRes.details.escalation.where, 'anchor-absent')
  assert.equal(mixedRes.details.gate.repairs, 0)
  assert.equal(mixed.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
  assert.equal(mixedRes.details.gate.check_discrimination, 'failed')
})

test('b385 B2 an unresolved anchor leaves the whole-gate proof proven and the check verdict unbound', () => {
  const io = b384Io()
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.check_discrimination, 'unbound')
  assert.equal(res.details.gate.mutation_bind.absent, 1)
  assert.match(res.details.escalation.why, /not a gate defect/)
})

test('b385 C1 a builder correction that binds once and leaves its check failing is accepted', () => {
  const builder = buildEnv({ details: {
    ...buildEnv().details,
    mutation_corrections: [{ check: 'B2', find: B384_CORRECTED_FIND, replace: B384_CORRECTED_REPLACE }],
  } })
  const io = b384Io({ builder, runs: { 'gate-cmd:3': { ok: false, output: B384_RED } } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  const proof = io.calls.emits.find((event) => event.kind === 'check-discrimination')?.checks?.[0]
  assert.deepEqual(proof, { check: 'B2', outcome: 'killed', file: 'crew/drive.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null, correction: 'accepted' })
  const bind = io.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  assert.equal(bind.corrected, 1)
  const absence = io.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: absence.correction, refusal: absence.refusal }, { correction: 'accepted', refusal: null })
})

test('b385 D3 a correction that survives or never adjudicates is refused and escalates', () => {
  const correction = { mutation_corrections: [{ check: 'B2', find: B384_CORRECTED_FIND, replace: B384_CORRECTED_REPLACE }] }
  const greenBuilder = buildEnv({ details: { ...buildEnv().details, ...correction } })
  const greenIo = b384Io({ builder: greenBuilder, runs: { 'gate-cmd:3': { ok: true, output: B384_GREEN } } })
  const green = driveTask(CTX, greenIo)
  assert.equal(green.status, 'escalation')
  assert.equal(green.details.escalation.where, 'anchor-absent')
  assert.match(green.details.escalation.why, /correction-green/)
  assert.equal(green.details.gate.mutation_bind.corrected, 0)
  const greenBind = greenIo.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  const greenAbsence = greenIo.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: green.details.gate.mutation_binds[0].correction, refusal: green.details.gate.mutation_binds[0].correction_refusal }, { correction: 'refused', refusal: 'correction-green' })
  assert.deepEqual({ correction: greenAbsence.correction, refusal: greenAbsence.refusal }, { correction: 'refused', refusal: 'correction-green' })
  assert.equal(greenBind.corrected, 0)
  assert.equal(green.details.gate.repairs, 0)
  assert.equal(greenIo.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)

  const throwBuilder = buildEnv({ details: { ...buildEnv().details, ...correction } })
  const throwIo = b384Io({ builder: throwBuilder, throwMutation: true })
  const thrown = driveTask(CTX, throwIo)
  assert.equal(thrown.status, 'escalation')
  assert.equal(thrown.details.escalation.where, 'anchor-absent')
  assert.match(thrown.details.escalation.why, /correction-unproven/)
  assert.equal(thrown.details.gate.mutation_bind.corrected, 0)
  const throwBind = throwIo.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  const throwAbsence = throwIo.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: thrown.details.gate.mutation_binds[0].correction, refusal: thrown.details.gate.mutation_binds[0].correction_refusal }, { correction: 'refused', refusal: 'correction-unproven' })
  assert.deepEqual({ correction: throwAbsence.correction, refusal: throwAbsence.refusal }, { correction: 'refused', refusal: 'correction-unproven' })
  assert.equal(throwBind.corrected, 0)
  assert.equal(thrown.details.gate.repairs, 0)
  assert.equal(throwIo.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
})

test('b385 G1 an all-bind lane pins its legacy proof row byte-identically beside one additive bind row', () => {
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'check-one', outcome: 'killed', file: 'a.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null })
  assert.equal(Object.hasOwn(res.details.gate, 'mutation_bind'), false)
  const binds = io.calls.logs.filter((line) => line.mutation_anchor_bind).map((line) => line.mutation_anchor_bind)
  assert.deepEqual(binds, [{ generation: 1, declared: 1, exact: 1, normalized: 0, absent: 0, corrected: 0, checks: [{ check: 'check-one', file: 'a.mjs', status: 'exact' }] }])
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})

test('a known survivor outranks a later interrupted mutation pass', () => {
  const mutations = [
    CHECK_MUTATION,
    { check: 'second-check', file: 'b.mjs', find: 'true', replace: 'false' },
  ]
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'b.mjs'], gate_cmd: 'gate-cmd', mutations } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT, [`${CTX.checkout}/b.mjs`]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-cmd:3': { ok: true, output: `still green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:1': { ok: true, output: '' },
      'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'b.mjs'], emit: true,
  })
  const originalRead = io.readFile
  let bReads = 0
  io.readFile = function (path) {
    // #874 — the FIRST read of b.mjs is the bind preflight and must succeed, so this fixture
    // still reaches the proof loop with both anchors bound. Every read AFTER it throws, exactly
    // as before: generation 1 interrupts on the proof-loop read, after check-one has already
    // survived, and generation 2's own preflight interrupts the same way, leaving it `unproven`
    // with no survivor — which is what generation 2 recorded before this change too.
    if (path === `${CTX.checkout}/b.mjs`) {
      bReads += 1
      if (bReads > 1) throw new Error('second read failed')
    }
    return originalRead.call(this, path)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 2)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
  assert.equal(first.generation, 1)
  assert.equal(first.verdict, 'failed')
  assert.equal(first.checks[0].outcome, 'survived')
})

test('a mutated gate that errors or omits its summary survives instead of claiming a kill', () => {
  for (const output of [THREW, 'FAIL check-one: red without a summary']) {
    const io = fakeIo({
      files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
      cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: {
        'planner:1': CHECK_PLAN([CHECK_MUTATION]),
        'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
        'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      },
      runs: {
        ...CHECK_RUNS(output),
        'gate-fixed:1': { ok: true, output: '' },
        'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'done')
    const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
    assert.equal(first.checks[0].outcome, 'survived')
    assert.match(first.checks[0].why, output === THREW ? /THREW/ : /GATE-SUMMARY/)
  }
})

test('the missing-file unapplied branch records its distinct reason and writes nothing', () => {
  const mutation = { ...CHECK_MUTATION, check: 'missing-file', file: 'missing.mjs' }
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'missing.mjs'], gate_cmd: 'gate-cmd', mutations: [mutation] } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:1': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
  assert.equal(first.checks[0].outcome, 'unapplied')
  assert.match(first.checks[0].why, /does not exist/)
  assert.deepEqual(first.checks[0], { check: 'missing-file', outcome: 'unapplied', file: 'missing.mjs', summary: null, why: 'missing.mjs does not exist in the built tree' })
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('the two pre-build replacement briefs carry fixed identifiers, but an undeclared plan does not', () => {
  const mutations = [CHECK_MUTATION]
  const runBrief = (gate, baseline, declared) => {
    const io = fakeIo({
      cleanRuns: { 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate, ...(declared ? { mutations } : {}) } }),
        'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
        'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      },
      runs: {
        [gate]: baseline, 'gate-fixed': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
        'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
      },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    try { driveTask(CTX, io) } catch { /* the brief is the assertion */ }
    return io.calls.writes[`${TD}/${gate === 'gate-cmd' ? 'gate-vacuous-bounce' : 'gate-defect-bounce'}.md`]
  }
  const vacuous = runBrief('gate-cmd', { ok: true, output: 'green' }, true)
  const defective = runBrief('gate-bad', { ok: false, output: 'no summary' }, true)
  const plain = runBrief('gate-cmd', { ok: true, output: 'green' }, false)
  assert.match(vacuous, /CHECK IDENTIFIERS STABLE/)
  assert.match(vacuous, /check-one/)
  assert.match(defective, /CHECK IDENTIFIERS STABLE/)
  assert.match(defective, /check-one/)
  assert.doesNotMatch(plain, /CHECK IDENTIFIERS STABLE/)
})

test('a whole-proof repair brief stays byte-stable when no mutations are declared', () => {
  const io = fakeIo({
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green pristine' }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const brief = io.calls.writes[`${TD}/gate-discrimination-bounce.md`]
  assert.equal(typeof brief, 'string')
  assert.doesNotMatch(brief, /CHECK IDENTIFIERS STABLE/)
  assert.doesNotMatch(brief, /Per-check rows:/)
})

test('mutation outcomes are frozen and every observed row uses the closed vocabulary', () => {
  assert.equal(Object.isFrozen(MUTATION_OUTCOMES), true)
  assert.deepEqual([...MUTATION_OUTCOMES].sort(), ['anchor-absent', 'anchor-ambiguous', 'anchor-unsafe', 'exempt', 'killed', 'survived', 'unapplied'])
})

test('the per-check proof stage is declared by the full variant', () => {
  assert.equal(undeclaredStage(VARIANTS.full, 'gate-proof:1:checks'), null)
  assert.deepEqual(VARIANTS.full.stages, ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review', 'commit', 'rebase', 'suite', 'publish', 'converge'])
})

test('a per-check pass is only owed after the generation has a whole-gate proof', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  const stages = res.details.stages
  assert.ok(stages.indexOf('gate-proof:1') < stages.indexOf('gate-proof:1:checks'))
})

test('a declared gate without a gate command is a plan defect', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, mutations: [CHECK_MUTATION] } }) } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('final-round lane red + lead grants bounce -> a REAL extra round runs; commit only after review pass', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'lead:1': leadEnv('bounce', 'the lane fails on X; fix X'),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'red' }, 'lane-cmd:2': { ok: false, output: 'red' },
      'lane-cmd:3': { ok: false, output: 'red' }, 'lane-cmd:4': { ok: true, output: '' },
      'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4) // the granted bounce GOT its round
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 1) // and review still happened
  assert.equal(res.details.accepted_via, 'review pass')
})

test('final-round lane red, granted bounce STILL red, lead then escalates -> escalation, NO commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: false, output: 'red forever' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

test('builder insufficient on the FINAL round + granted bounce -> re-assigned, never a stale-envelope commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), // good round 1
      'builder:2': buildEnv({ status: 'insufficient' }), 'builder:3': buildEnv({ status: 'insufficient' }),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'), 'lead:3': leadEnv('bounce'),
      'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  // round 1 built+reviewed(changes-needed) -> r2/r3 insufficient (r3 is final: bounce extends) -> r4 builds -> review pass
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(res.details.accepted_via, 'review pass')
})

test('a gate repair records the replaced command in the gate audit trail', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong target' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'fail A' }, 'gate-bad:3': { ok: false, output: 'fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.gate.replaced, ['gate-bad'])
})

// --- lead-optional driver (mechanical tier) -----------------------------------

test('an absent emitter leaves the envelope and gate proof calls unchanged', () => {
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
  const absentIo = fakeIo(input)
  const throwingIo = fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } })
  const absent = driveTask(CTX, absentIo)
  const throwing = driveTask(CTX, throwingIo)
  assert.deepEqual(absent, throwing)
  assert.deepEqual(absentIo.calls.run, throwingIo.calls.run)
  assert.deepEqual(absentIo.calls.runClean, throwingIo.calls.runClean)
})

test('review exhaustion at a non-final build round grants a real round and review', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 4 } }, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 3)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'review', round: 3 }])
})

test('review grant bounce brief is code-composed from the review path', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('pass'),
      'lead:1': leadEnv('bounce', 'misleading guidance that must not become the brief'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const brief = Object.entries(io.calls.writes).find(([path]) => /build-bounce-r3\.md$/.test(path))?.[1]
  assert.match(brief, new RegExp(`${TD}/review\\.md`))
  assert.doesNotMatch(brief, /misleading guidance/)
})

test('final build-round review revise can buy one round and its review decides', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'red' }, 'lane-cmd:2': { ok: false, output: 'red' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.equal(res.details.accepted_via, 'review pass')
})

test('review grant cap refuses a second bounce and escalates without commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('changes-needed'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  const decisions = Object.entries(io.calls.writes).filter(([path]) => /decision-\d+b?\.md$/.test(path)).map(([, body]) => body)
  assert.equal(decisions.filter((body) => /^- bounce-builder$/m.test(body)).length, 1)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'review', round: 3 }])
})

test('reviewer findings become stable residuals and only must-fix findings file issues', () => {
  const findings = [
    { id: 'RV-2', severity: 'should-fix', location: 'a.mjs:2', summary: 'follow-up wording' },
    { id: 'RV-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'close the defect' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': CONVERGE_PLAN(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': {
        status: 'done', role: 'reviewer',
        details: { verdict: 'changes-needed', defect: 'build', findings, must_fix: 1, should_fix: 1, consider: 0 },
      },
      'lead:1': leadEnv('escalate', 'the gate names its red checks'),
    },
    runs: {
      'gate-cmd': { ok: false, output: CONVERGE_GATE },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'],
    gh: true,
  })
  const result = driveTask({ ...CONVERGE_CTX, limits: { plan_rounds: 1, build_rounds: 3, review_rounds: 1 } }, io)
  assert.equal(result.status, 'converge')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['gate-red', 'RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 2)
  const body = io.calls.gh.find((call) => call.method === 'createDraftPr').args.body
  assert.ok(body.indexOf('RV-1') < body.indexOf('RV-2'))
  assert.match(body, /follow-up: #/)
})

test('build-round exhaustion with a revise verdict converges with review residuals', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1 })
  assert.equal(result.status, 'converge')
  assert.equal(result.details.escalation.where, 'review')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.commits.length, 1)
  const body = io.calls.gh.find((call) => call.method === 'createDraftPr').args.body
  assert.doesNotMatch(body, /gate is red/)
  assert.match(body, /RV-1/)
})

test('a red suite at build-round review exhaustion still parks without side effects', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, suite: { ok: false, output: 'suite red' } })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('repair treats inherited scope as its scope gate', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv(), 'builder:1': buildEnv() },
    changed: ['a.mjs', 'other.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.equal(io.calls.commits.length, 0)
})

test('repair honors a narrowed triage scope and escalates a widened one', () => {
  const narrowIo = fakeIo({
    envelopes: {
      'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['a.mjs'] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    }, changed: ['a.mjs'], files: TRIAGE_FILES,
  })
  const narrow = driveTask(CTX_REPAIR, narrowIo)
  assert.equal(narrow.status, 'done')
  assert.deepEqual(narrowIo.calls.commits[0].files, ['a.mjs'])

  const narrowedChangedIo = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['a.mjs'] } }), 'builder:1': buildEnv() },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const narrowedChanged = driveTask(CTX_REPAIR, narrowedChangedIo)
  assert.equal(narrowedChanged.status, 'escalation')
  assert.equal(narrowedChanged.details.escalation.where, 'scope')
  assert.equal(narrowedChangedIo.calls.commits.length, 0)

  const wideIo = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['b.mjs'] } }) },
    changed: ['a.mjs'], files: TRIAGE_FILES,
  })
  const wide = driveTask(CTX_REPAIR, wideIo)
  assert.equal(wide.status, 'escalation')
  assert.equal(wide.details.escalation.where, 'triage-scope')
  assert.match(wide.details.escalation.why, /widen/)
  assert.equal(wideIo.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('directed declaration is pinned and honourable', () => {
  const DIRECTED_SNAPSHOT = {
    execution: 'reviewed', required_seats: ['builder', 'reviewer'],
    stages: ['directed', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-proof',
      'review', 'commit', 'rebase', 'suite', 'publish', 'converge'],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [], assignment: null,
    sources: { scope: 'brief', lane: 'ctx', gate: 'brief' },
  }
  assert.deepEqual(VARIANTS.directed, DIRECTED_SNAPSHOT)
  assert.equal(shapeDefect(VARIANTS.directed, 'directed'), null)
  assert.ok(shapeDefect(VARIANTS.directed, 'quality'))
  assert.deepEqual(Object.keys(PARTIAL_REVIEWED), ['repair', 'directed'])
})

test('a directed run seats no planner, opens with directed:r1, and proves its gate discriminates', () => {
  const red = `red\n${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'directed-gate:1': { ok: false, output: red }, 'directed-gate': { ok: true, output: green },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'directed-gate': { ok: false, output: red } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 0)
  assert.equal(result.details.stages[0], 'directed:r1')
  assert.equal(result.details.stages.some((label) => label.startsWith('plan') || label.startsWith('check')), false)
  assert.ok(io.calls.run.some(({ cmd }) => cmd === 'directed-gate'))
  assert.equal(io.calls.runClean.length, 1)
  assert.ok(result.details.stages.some((label) => label.startsWith('gate-proof')))
  assert.equal(result.details.gate.discrimination, 'proven')
  assert.equal(result.details.variant, 'directed')
  assert.equal(result.details.commit, 'abc1234')
})

test('declarations remain frozen and observed behaviour stays within their closed vocabulary', () => {
  assert.equal(Object.isFrozen(VARIANTS), true)
  assert.deepEqual(VARIANT_NAMES, ['full', 'scout', 'repair', 'directed'])
  assert.equal(VARIANTS.full.required_seats, 'tier')
  assert.match(VARIANTS.full.accepted_by, /review.*pass/)
  assert.match(VARIANTS.full.accepted_by, /lead accept/)
  for (const shape of Object.values(VARIANTS)) {
    assert.ok(EXECUTIONS.includes(shape.execution))
    assert.ok(WRITE_SURFACES.includes(shape.writes))
    for (const field of shape.envelope_fields) assert.ok(ENVELOPE_FIELD_KINDS.includes(field.kind))
  }
  assert.deepEqual(UNIVERSAL_STAGE_HEADS, ['escalate', 'done'])
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
  assert.deepEqual(outOfScopeFiles(['a.mjs', 'b.mjs'], scopeMatcher([])), ['a.mjs', 'b.mjs'])
  assert.deepEqual(outOfScopeFiles('not-an-array', scopeMatcher(['a.mjs'])), [])
})

test('lead-less: a reviewer-triaged gate defect escalates with the diagnosis attached', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': b44GatePlan(), 'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'the gate checks the wrong acceptance target' } },
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED() },
      'gate-cmd:2': { ok: false, output: 'build failure A' }, 'gate-cmd:3': { ok: false, output: 'build failure B' },
      'lane-cmd': { ok: true, output: '' },
    },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /the reviewer triaged.*the gate checks the wrong acceptance target/)
  assert.equal(result.details.stages.some((stage) => stage.startsWith('gate-repair')), false)
})

test('T13 — entered vs journal-recorded: a failed stage entry row is never completed', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    cleanRuns: { 'gate-cmd': resumeRed() }, runs: { 'gate-cmd:1': resumeRed(), 'gate-cmd:2': resumeGreen(), 'lane-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const originalLog = io.log
  let failed = false
  io.log = (row) => {
    if (!failed && row?.stage === 'gate-proof:1') { failed = true; throw new Error('journal write failed') }
    originalLog(row)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /journal write failed/)
  assert.equal(res.details.stages.at(-1), 'gate-proof:1')
  assert.equal(io.calls.logs.some((row) => row.stage === 'gate-proof:1'), false)
  assert.equal(io.calls.logs.some((row) => row.stage_done === 'gate-proof:1'), false)
})

test('bounce-reviewer at review exhaustion re-reviews the same tree', () => {
  const { io, result } = b318SiteA('bounce-reviewer', {
    reseat: (role) => role === 'reviewer' ? { applied: true } : { applied: false, reason: 'transport' },
  })
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1',
    'build:r2', 'scope-gate:r2', 'lane:r2', 'gate:r2', 'review:r2', 'review:pass',
    'commit', 'suite', 'suite:cold', 'done',
  ])
  assert.equal(b318Builders(io).length, 2)
  const roles = io.calls.assign.map(({ role }) => role)
  assert.equal(roles[roles.indexOf('lead') + 1], 'reviewer')
  assert.deepEqual(io.calls.reseat, [
    { role: 'builder', options: { reason: 'review-bounce' } },
    { role: 'reviewer', options: { reason: 'review-bounce' } },
  ])
})

test('stageShape keeps only major phases and counts distinct rounds', () => {
  // A faithful judge-run publish-time list: the instrumentation a judge run really
  // journals, both rounds, suite + suite:cold, publish — and no `done`, because the
  // body record is built during publish and stage('done') happens afterwards.
  const stages = ['plan:r1', 'check:r1', 'gate-baseline', 'gate-proof:1', 'gate-proof:1:checks',
    'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1', 'review:r1',
    'build:r2', 'scope-gate:r2', 'lane:r2', 'gate:r2', 'review:r2', 'review:pass',
    'commit', 'rebase', 'suite', 'suite:cold', 'publish']
  assert.equal(stageShape(stages), 'plan → build ×2 → review ×2 → commit → rebase → suite → publish')
  for (const noisy of ['check', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'scope-gate', 'lane', 'gate', 'done']) {
    assert.equal(stageShape(stages).includes(noisy), false, noisy)
    assert.equal(SHAPE_MAJOR_PHASES.includes(noisy), false, noisy)
  }
  // the allow-list is closed and every full-variant head is either a phase or omitted
  assert.deepEqual([...SHAPE_MAJOR_PHASES], ['plan', 'build', 'review', 'commit', 'rebase', 'suite', 'publish'])
  assert.equal(Object.isFrozen(SHAPE_MAJOR_PHASES), true)
  // suite:cold folds into suite because its head does
  assert.equal(stageShape(['suite', 'suite:cold']), 'suite')
  // review:pass is a verdict, never a round
  assert.equal(stageShape(['review:r1', 'review:pass']), 'review')
  assert.deepEqual([...SHAPE_ROUNDED_STAGES], ['plan', 'build', 'review'])
  assert.equal(stageShape([]), '')
  assert.equal(stageShape('not-an-array'), '')
  // the exact adjacent repetition stays collapseStages' business
  assert.deepEqual(collapseStages(['review:r1', 'review:r1', 'commit']), [{ token: 'review:r1', count: 2 }, { token: 'commit', count: 1 }])
})

test('a malformed planner scope reaches the existing refusal, not a crash', () => {
  // The DISPATCHED side is validated by every dispatch path before driveTask sees it;
  // the planner envelope is not validated until after the plan loop. scopeMatcher
  // dereferences both sides unconditionally, so an unguarded comparison would throw on
  // files_in_scope: [null] and never reach the typed escalate('plan', …) below.
  assert.throws(() => outOfScopeFiles(['crew/drive.mjs'], scopeMatcher([null])), TypeError)
  const io = s843Io({ 'planner:1': s843PlanEnv([null]) }, [])
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan')
  assert.match(result.details.escalation.why, /null \(empty or non-string entry\)/)
  // Never classified: a scope that was never compared gets no verdict at all.
  assert.deepEqual(s843Rows(io), [])
})

// MUTATIONS A16, A17 and A18 — attempted but unparseable node-test lanes bounce before the
// verbatim shell runner, while -- still exposes its dash-leading positional.
test('an attempted node --test lane this driver cannot parse is bounced, never handed to /bin/sh', () => {
  const good = 'node --test crew/drive.test.mjs'
  const piped = 'node --test test/fixtures/cmux-events-input-sent.jsonl | cat'
  const pipedIo = fakeIo({
    envelopes: { 'planner:1': validationPlan(piped), 'planner:2': validationPlan(good), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { ...validationProbeRun(good, { 'crew/drive.test.mjs': 'file' }), 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const pipedResult = driveTask(CTX, pipedIo)
  assert.equal(pipedResult.status, 'done')
  assert.equal(validationRows(pipedIo)[0]?.validation_lane_resolved.shape, 'unparsable')
  assert.match(pipedIo.calls.writes[`${TD}/plan-bounce-r1.md`], new RegExp(VALIDATION_LANE_UNLOADABLE))
  assert.equal(pipedIo.calls.run.some(({ cmd }) => cmd === piped), false)

  const dash = 'node --test -- -fixture.jsonl'
  const dashIo = fakeIo({
    envelopes: { 'planner:1': validationPlan(dash), 'planner:2': validationPlan(good), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { ...validationProbeRun(dash, { '-fixture.jsonl': 'file' }), ...validationProbeRun(good, { 'crew/drive.test.mjs': 'file' }), 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, dashIo)
  const dashPayload = validationRows(dashIo)[0]?.validation_lane_resolved
  assert.equal(dashPayload?.total, 1)
  assert.deepEqual(dashPayload?.refused, ['-fixture.jsonl'])
  assert.ok(dashIo.calls.writes[`${TD}/plan-bounce-r1.md`].includes('-fixture.jsonl'))

  const launched = 'env node --test crew/drive.test.mjs'
  const launchedIo = fakeIo({
    envelopes: { 'planner:1': validationPlan(launched), 'planner:2': validationPlan(good), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { ...validationProbeRun(good, { 'crew/drive.test.mjs': 'file' }), 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, launchedIo)
  assert.equal(validationRows(launchedIo)[0]?.validation_lane_resolved.shape, 'unparsable')
  assert.match(launchedIo.calls.writes[`${TD}/plan-bounce-r1.md`], new RegExp(VALIDATION_LANE_UNLOADABLE))
})

test('b376 A1 a bounced build round runs its scope gate with rounds remaining', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': { status: 'insufficient', role: 'builder', summary: 'steer', artifacts: [], details: {} },
      'lead:1': leadEnv('bounce'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['returns/d2.builder.json', 'rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'scope-fix').length, 1)
  assert.deepEqual(io.calls.logs.filter((row) => row.scope_gate).map((row) => row.scope_gate.reason), ['envelope-and-edits'])
  assert.equal(io.calls.logs.some((row) => row.member_questions), false)
  assert.equal(io.calls.logs.some((row) => row.decision), false)
  assert.deepEqual(b376StageStack(io), [])
})

test('b376 A3 a genuine out-of-scope source edit reports exactly as today', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const scopeBrief = Object.entries(io.calls.writes).find(([path]) => path.endsWith('build-bounce-r1.md'))?.[1] || ''
  assert.equal(io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate.reason, 'out-of-scope-edits')
  assert.match(scopeBrief, /OUTSIDE the plan's scope/)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('scope-gate')), ['scope-gate:r1', 'scope-gate:r2'])
})

test('b376 B5a a proven hardening is accepted and clears the debt', () => {
  const io = b376ProofIo()
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'harden-fix').length, 0)
  assert.equal(result.details.stages.includes('lane:harden:r2'), true)
  assert.equal(result.details.stages.includes('review:r2'), true)
})

test('b376 B5b the finding-hardened row carries the finding id and the check name', () => {
  const io = b376ProofIo()
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.deepEqual(row, { round: 2, finding: 'F1', test: 'a.test.mjs', check: 'F1 guard', outcome: 'killed', why: null })
})

test('b376 B5c an existing named test is not gate growth', () => {
  const nestedSkipped = [
    "const label = 'F1'",
    "test('outer', async (t) => { await t.test(`${label} guard`, { skip: true }, () => {}) })",
  ].join('\n')
  const files = { ...B376_FILES, [`${CTX.checkout}/${B376_TEST_FILE}`]: nestedSkipped }
  const witnessOutput = { ok: true, output: 'ok 1 - outer\n    ok 1 - F1 guard # SKIP\n# pass 1\n# fail 0\n# skipped 1' }
  const io = b376ProofIo({ files, witnessOutput, limits: { build_rounds: 2 } })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(row.outcome, 'name-not-new')
  assert.match(row.why, /skipped/)

  const unprovenIo = b376ProofIo({
    witnessOutput: { ok: false, output: 'not ok 1 - unrelated\n# pass 0\n# fail 1' },
    limits: { build_rounds: 2 },
  })
  const unprovenResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, unprovenIo)
  const unproven = unprovenIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(unprovenResult.status, 'escalation')
  assert.equal(unproven.outcome, 'unproven')
})

test('b376 B5d hardening must fail on the witnessed pre-repair surface', () => {
  const io = b376ProofIo({ proofOutputs: [B376_GREEN, B376_GREEN, B376_MUT_RED] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(row.outcome, 'pre-repair-green')
  assert.match(row.why, /witnessed pre-repair/)
})

test('b376 B5e must-fix debt survives auto-fix and ask-user routing', () => {
  const dGuard = { ...B376_HARDENED, finding: 'RV1-1', name: 'RV1 guard' }
  const dFiles = { ...B376_FILES, [`${CTX.checkout}/${B376_IMPL_FILE}`]: 'const guard = false\n' }
  const dProof = (findings, leadDecision = 'escalate') => {
    const io = dispositionIo(findings, {
      leadDecision,
      builder2: buildEnv({ details: { ...buildEnv().details, hardened: [dGuard] } }),
      files: dFiles, writeThrough: true,
    })
    const baseRun = io.run
    io.run = function (cmd) {
      const result = baseRun.call(this, cmd)
      if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
      if (cmd === hardenCommand(B376_TEST_FILE, 'RV1 guard')) {
        const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
        const output = [B376_GREEN, B376_PRE_RED, B376_MUT_RED][count - 1] || B376_MUT_RED
        return { ...output, output: output.output.replaceAll('F1 guard', 'RV1 guard') }
      }
      return result
    }
    return io
  }
  assert.equal(hardeningDebt({ findings: [{ ...D_AUTO, hardening: undefined, hardening_why: undefined }] }).owed.length, 1)
  assert.equal(hardeningDebt({ findings: [{ ...D_ASK, hardening: undefined, hardening_why: undefined }] }).owed.length, 1)
  for (const [finding, leadDecision] of [[D_AUTO, 'escalate'], [D_ASK, 'bounce']]) {
    const unmarked = { ...finding, hardening: undefined, hardening_why: undefined }
    const io = dProof(unmarked, leadDecision)
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'done')
    assert.equal(io.calls.logs.some((entry) => entry.finding_hardened?.finding === 'RV1-1' && entry.finding_hardened.outcome === 'killed'), true)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  }
})

test('b376 B6 an unhardened must-fix repair bounces naming the finding', () => {
  const io = b376ProofIo({ hardened: [] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /F1/)
  assert.match(result.details.escalation.why, /no-declaration/)
  assert.doesNotMatch(result.details.escalation.why, /insufficient\\b/)
  assert.equal(io.calls.logs.some((entry) => entry.finding_hardened), false)
})

test('b376 B7a a reviewer ungateable mark exempts the finding', () => {
  const marked = { ...B376_FINDING, hardening: 'ungateable', hardening_why: 'the reviewer supplied no safe anchor' }
  const io = b376ProofIo({
    reviewer1: b376Review('changes-needed', [marked]),
    reviewer2: b376Review('pass', []),
    hardened: [],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.deepEqual(row, { round: 1, finding: 'F1', test: null, check: null, outcome: 'ungateable', why: 'the reviewer supplied no safe anchor' })

  const repeated = b376ProofIo({
    reviewer1: b376Review('changes-needed', [marked]), reviewer2: b376Review('changes-needed', [marked]), reviewer3: b376Review('pass', []),
    hardened: [], limits: { build_rounds: 3 },
  })
  const repeatedResult = driveTask({ ...CTX, limits: { build_rounds: 3, review_rounds: 3 } }, repeated)
  assert.equal(repeatedResult.status, 'done')
  assert.equal(repeated.calls.logs.filter((entry) => entry.finding_hardened?.outcome === 'ungateable').length, 2)
})

test('b376 B7b a builder-claimed exemption is refused', () => {
  for (const exemption of [
    { exempt: 'the builder cannot waive a reviewer obligation' },
    { ungateable: true },
  ]) {
    const io = b376ProofIo({ hardened: [{ ...B376_HARDENED, ...exemption }] })
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'harden')
    assert.match(result.details.escalation.why, /builder-exemption|only the reviewer may/)
    assert.equal(io.calls.logs.some((entry) => entry.finding_hardened?.outcome === 'killed'), false)
  }
})

test('b376 B8 the hardening proof adds no gate result', () => {
  const markedReviewer2 = b376Review('changes-needed', [B376_FINDING])
  const io = b376ProofIo({
    reviewer2: markedReviewer2, reviewer3: b376Review('pass', []), limits: { build_rounds: 3 },
    proofOutputs: [B376_GREEN, B376_PRE_RED, B376_MUT_RED, B376_GREEN, B376_PRE_RED, B376_MUT_RED],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 3, review_rounds: 3 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === hardenWitnessCommand(B376_TEST_FILE)).length, 2)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === hardenCommand(B376_TEST_FILE, 'F1 guard')).length, 6)
  const hardeningCommands = new Set([hardenWitnessCommand(B376_TEST_FILE), hardenCommand(B376_TEST_FILE, 'F1 guard')])
  assert.equal(io.calls.emits.some(({ kind, cmd }) => kind === 'gate' && hardeningCommands.has(cmd)), false)
})

test('b376 B9 a surviving hardening mutation is refused', () => {
  for (const mutant of [
    { ok: false, output: 'not ok 1 - unrelated\n# pass 0\n# fail 1' },
    { ok: true, output: 'ok 1 - unrelated\n# pass 1\n# fail 0' },
  ]) {
    const io = b376ProofIo({ proofOutputs: [B376_GREEN, B376_PRE_RED, mutant] })
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'harden')
    const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
    assert.equal(row.outcome, 'survived')
    assert.match(row.why, /unrelated|absent/)
  }
})

test('b376 B10 hardening paths cannot escape a directory scope', () => {
  const proveRefusal = (entry, escaped, reason) => {
    const io = b376ProofIo({
      hardened: [entry], changed: [], limits: { build_rounds: 3 },
      plan: { files_in_scope: ['crew/tests/'] },
    })
    const baseRead = io.readFile
    io.calls.read = []
    io.readFile = function (path) {
      this.calls.read.push(path)
      return baseRead.call(this, path)
    }
    const result = driveTask({ ...CTX, limits: { build_rounds: 3 } }, io)
    const bounce = io.calls.writes[`${TD}/build-bounce-r2.md`]
    const escapedAbsolute = `${CTX.checkout}/${escaped}`
    assert.equal(result.status, 'escalation')
    assert.match(bounce, new RegExp(`F1: ${reason}`))
    assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'harden-fix').length, 1)
    assert.equal(io.calls.read.includes(escapedAbsolute), false)
    assert.equal(io.calls.writeLog.some(({ path }) => path === escapedAbsolute), false)
    assert.equal(io.calls.run.some(({ cmd }) => cmd.includes(escaped)), false)
  }
  const escapedTest = 'crew/tests/../../outside.test.mjs'
  proveRefusal({ ...B376_HARDENED, test: escapedTest, file: 'crew/tests/inside.mjs' }, escapedTest, 'test-not-in-scope')
  const escapedFile = 'crew/tests/../../outside.mjs'
  proveRefusal({ ...B376_HARDENED, test: 'crew/tests/inside.test.mjs', file: escapedFile }, escapedFile, 'file-not-in-scope')
})

test('b376 B11 a hardening restore failure stops the run with the mutation in flight', () => {
  const io = b376ProofIo({ builder3: b376Build([]) })
  const baseRead = io.readFile
  let implementationReads = 0
  io.readFile = function (path) {
    if (path === `${CTX.checkout}/${B376_IMPL_FILE}` && implementationReads++ === 0) return 'const guard = true\n'
    return baseRead.call(this, path)
  }
  const baseWrite = io.writeFile
  let implementationWrites = 0
  io.writeFile = function (path, content) {
    if (path === `${CTX.checkout}/${B376_IMPL_FILE}`) {
      implementationWrites += 1
      if (implementationWrites === 2) throw new Error('writeFile: the restore write failed')
    }
    return baseWrite.call(this, path, content)
  }
  const result = driveTask({ ...CTX, limits: { build_rounds: 3 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /could not restore|run stops/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  const hardenRow = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(hardenRow.outcome, 'unproven')
})

test('b376 B12 a test-file wrapper cannot satisfy a named hardening check', () => {
  const entry = { ...B376_HARDENED, name: B376_TEST_FILE }
  const io = b376ProofIo({ hardened: [entry] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /name-file-wrapper/)
  assert.equal(io.calls.run.some(({ cmd }) => cmd.includes('--test-name-pattern')), false)
})

test('b376 B13 hardening refuses a mutation that changes only whitespace', () => {
  const entry = { ...B376_HARDENED, find: 'const guard = false', replace: 'const  guard = false' }
  const hardening = validateHardened({ hardened: [entry] }, [{ id: 'F1' }], scopeMatcher(['a.mjs', 'a.test.mjs']))
  assert.equal(mutationChangesTokens(entry.find, entry.replace), false)
  assert.equal(hardening.entries.length, 0)
  assert.equal(hardening.refusals[0].reason, 'replace-identical')
  const plan = validateMutations([{ check: 'F1', file: 'a.mjs', find: entry.find, replace: entry.replace }], scopeMatcher(['a.mjs', 'a.test.mjs']))
  assert.equal(plan[0]?.why, 'find and replace differ only in whitespace — that mutates no token')
})

test('#839 hardening commands escape exact names and keep witnesses unfiltered', () => {
  const file = "o'hare.test.mjs"
  const name = 'guard (.$)'
  const quotedFile = `'o'"'"'hare.test.mjs'`
  assert.equal(hardenCommand(file, name), `node --test --test-reporter=tap --test-name-pattern='guard \\(\\.\\$\\)' ${quotedFile}`)
  assert.equal(hardenWitnessCommand(file), `node --test --test-reporter=tap ${quotedFile}`)
  assert.doesNotMatch(hardenWitnessCommand(file), /--test-name-pattern/)
  assert.match(hardenCommand(file, name), /--test-name-pattern=/)
})

test('#839 reviewer hardening marks preserve the five-key finding shape unless valid', () => {
  const base = { id: 'F1', severity: 'must-fix', location: 'a.mjs:1', summary: 'guard the defect' }
  const fiveKeys = { ...base, disposition: null }
  assert.deepEqual(HARDENING_MARKS, ['ungateable'])
  assert.deepEqual(HARDENING_REFUSALS, [
    'no-declaration', 'not-an-array', 'unknown-finding', 'duplicate-finding',
    'test-not-in-scope', 'file-not-in-scope', 'name-missing', 'name-file-wrapper', 'find-missing',
    'replace-identical', 'builder-exemption',
  ])
  assert.deepEqual(HARDENING_OUTCOMES, [
    'killed', 'survived', 'ungateable',
    'name-not-new', 'name-absent', 'name-ambiguous', 'control-red', 'control-skipped',
    'pre-repair-green', 'witness-missing', 'witness-absent', 'witness-unreadable',
    'unproven', 'unapplied', 'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe',
  ])
  const marked = { ...base, hardening: 'ungateable', hardening_why: ' documented exception ' }
  assert.equal(hardeningOf(marked), 'ungateable')
  assert.deepEqual(reviewFindings({ findings: [marked] }).findings, [{ ...fiveKeys, hardening: 'ungateable', hardening_why: 'documented exception' }])
  assert.deepEqual(hardeningDebt({ findings: [marked] }), { owed: [], exempt: [{ id: 'F1', why: 'documented exception' }] })
  for (const [label, candidate] of [
    ['unknown mark', { ...base, hardening: 'ungatable', hardening_why: 'typo' }],
    ['missing why', { ...base, hardening: 'ungateable' }],
    ['empty why', { ...base, hardening: 'ungateable', hardening_why: '   ' }],
  ]) {
    assert.equal(hardeningOf(candidate), null, label)
    assert.deepEqual(reviewFindings({ findings: [candidate] }).findings, [fiveKeys], label)
    assert.deepEqual(hardeningDebt({ findings: [candidate] }), { owed: [{ id: 'F1', location: 'a.mjs:1', summary: 'guard the defect' }], exempt: [] }, label)
  }
})

test('#839 scoped hardening paths reject traversal, directories, and non-strings', () => {
  const directoryScope = scopeMatcher(['crew/tests/'])
  assert.equal(scopedPath('crew/tests/a.test.mjs', directoryScope), true)
  assert.equal(scopedPath('crew/tests/../../outside.mjs', directoryScope), false)
  assert.equal(scopedPath('crew/tests/', directoryScope), false)
  assert.equal(scopedPath(null, directoryScope), false)
  assert.equal(scopedPath('crew/drive.mjs', scopeMatcher(['crew/drive.mjs'])), true)
})

test('#839 witness cells distinguish read, absent, and unreadable review-time paths', () => {
  const freshFiles = () => ({
    [`${CTX.checkout}/${B376_TEST_FILE}`]: 'export const repaired = true\n',
    [`${CTX.checkout}/${B376_IMPL_FILE}`]: 'const guard = false\n',
  })
  const readIo = b376ProofIo({ files: freshFiles() })
  const readResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, readIo)
  assert.equal(readResult.status, 'done')
  assert.equal(readIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened.outcome, 'killed')

  const absentFiles = freshFiles()
  delete absentFiles[`${CTX.checkout}/${B376_IMPL_FILE}`]
  const absentIo = b376ProofIo({ files: absentFiles })
  const absentResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, absentIo)
  const absentRow = absentIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(absentResult.details.escalation.where, 'harden')
  assert.equal(absentRow.outcome, 'witness-absent')
  assert.match(absentRow.why, /did not exist/)

  const unreadableIo = b376ProofIo({ files: freshFiles() })
  const baseRead = unreadableIo.readFile
  let denied = false
  unreadableIo.readFile = function (path) {
    if (!denied && path === `${CTX.checkout}/${B376_IMPL_FILE}`) {
      denied = true
      throw new Error('EACCES: witness read denied')
    }
    return baseRead.call(this, path)
  }
  const unreadableResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, unreadableIo)
  const unreadableRow = unreadableIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(unreadableResult.details.escalation.where, 'harden')
  assert.equal(unreadableRow.outcome, 'witness-unreadable')
  assert.match(unreadableRow.why, /EACCES/)
  assert.doesNotMatch(unreadableRow.why, /did not exist/)
})

test('#839 hardening briefs and bounces retain specific findings', () => {
  const brief = hardeningBriefLines([{ id: 'F1', location: 'a.mjs:1', summary: 'guard it' }], [{ id: 'F2' }])
  assert.match(brief.join('\n'), /F1 \(a\.mjs:1\) — guard it/)
  assert.match(brief.join('\n'), /Reviewer exemption recorded for F2/)
  assert.deepEqual(hardeningBriefLines([], []), [])
  const bounce = hardeningBounceLines(2, [{ finding: 'F1', reason: 'no-declaration', why: 'missing declaration' }], [
    { finding: 'F2', outcome: 'survived', why: 'the mutation passed' },
    { finding: 'F3', outcome: 'killed', why: null },
  ])
  assert.match(bounce.join('\n'), /F1: no-declaration — missing declaration/)
  assert.match(bounce.join('\n'), /F2: survived — the mutation passed/)
  assert.doesNotMatch(bounce.join('\n'), /F3: killed/)
})

test('#839 hardening proof restores the dirty built tree after success and each contained run failure', () => {
  for (const [label, throwAtProofRun, outcome] of [
    ['success', null, 'killed'],
    ['witness', 1, 'unproven'],
    ['control', 2, 'unproven'],
    ['pre-repair', 3, 'unproven'],
    ['mutation', 4, 'unproven'],
  ]) {
    const fixture = b376DiskProofIo({ throwAtProofRun })
    const result = driveTask({ ...CTX, checkout: fixture.checkout, limits: { build_rounds: 2 } }, fixture.io)
    const row = fixture.io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
    assert.equal(typeof fixture.builtDigest(), 'string', label)
    assert.equal(treeDigest(fixture.checkout), fixture.builtDigest(), label)
    assert.equal(readFileSync(fixture.testPath, 'utf8'), fixture.repairedTest, label)
    assert.equal(readFileSync(fixture.implementationPath, 'utf8'), fixture.repairedImplementation, label)
    assert.notEqual(readFileSync(fixture.testPath, 'utf8'), fixture.witnessedTest, label)
    assert.notEqual(readFileSync(fixture.implementationPath, 'utf8'), fixture.witnessedImplementation, label)
    assert.equal(row.outcome, outcome, label)
    if (throwAtProofRun === null) {
      assert.equal(result.status, 'done', label)
    } else {
      assert.equal(result.details.escalation.where, 'harden', label)
      assert.doesNotMatch(result.details.escalation.why, /could not restore the built tree/, label)
    }
  }
})

test('RV1-1 an all-exempt declaration set journals a completed bind check', () => {
  const mutations = [{ check: 'all-exempt', exempt: 'no source anchor is required' }]
  const io = fakeIo({ cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations, [
    { check: 'all-exempt', outcome: 'exempt', why: 'no source anchor is required', file: null, summary: null },
  ])
  assert.deepEqual(io.calls.logs.filter((line) => line.mutation_anchor_bind).map((line) => line.mutation_anchor_bind), [
    { generation: 1, declared: 0, exact: 0, normalized: 0, absent: 0, corrected: 0, checks: [] },
  ])
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})
