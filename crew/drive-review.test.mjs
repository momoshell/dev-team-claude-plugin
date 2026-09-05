// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCEPT_FINDINGS, ACCEPT_FINDINGS_SOFT, ACCEPT_REASKS, ACCEPT_REFUSALS, B318_GATED_RUNS, B376_FILES, B376_FINDING, B376_GREEN, B376_HARDENED, B376_MUT_RED, B376_PRE_RED, B376_TEST_FILE, CENSUS_ABSENT_REASONS, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE, CLOBBER_R2, CONVERGE_GATE, CONVERGE_PLAN, CRASH_FINDINGS, CRASH_STAGES, CTX, CTX_REPAIR, CTX_TL, DECISIONS, D_ASK, D_AUTO, D_COLLISION_CTX, D_PANEL_CTX, D_PATCH_A, D_PATCH_B, ENVELOPE_REFUSAL_REASONS, FINDING_DISPOSITIONS, LIMITS, MUST_FIX_REFUTATION_FINDINGS, NAME_VERDICTS, PANEL_ADJUDICATORS, PANEL_PARTNERS, PERSPECTIVE_TARGETS, PLAN_CHECK_FINDINGS, PLAN_RESIDUAL, PLAN_SCOPE, PLAN_SCOPE_VERDICTS, RED, REFUTATION_CLAIM, REFUTATION_CONVERGE_PLAN, REFUTATION_CONVERGE_RUNS, REFUTATION_EVIDENCE_MAX, RESIDUAL_TYPES, REVIEW_FINDINGS, REVIEW_GATE_PASS, S843_ADDED, S843_D2, S843_DISPATCHED, S843_DROPPED, S843_NARROWED, S843_RUNS, SECOND_OPINION, TD, THREW, TRIAGE_FILES, TRIAGE_NOTE, VARIANTS, acceptBounceLines, acceptContractLines, acceptedRawById, assertDriverIdRefusal, b127GroupCommand, b127InvokeGate, b127Lines, b127PidAlive, b127Spy, b318Builders, b318GatedPlan, b318Options, b318ReviewGrants, b318SiteA, b318SiteB, b376ProofIo, bounceTargetOf, buildEnv, checkEnv, classCollisionIo, closeoutIo, crashRun, dAdjEnv, dAutoRows, dBuilders, dDecisionBrief, dGitApplies, dLeads, dOffers, dPanelOutcomes, dPartnerEnv, dPatchWrite, dPlanEnv, dRemintRows, dReviewEnv, dispositionIo, dispositionOf, dispositionPanelIo, dispositionPlan, divergentCollisionIo, divergentPlanScenario, driveTask, envelopeDefect, envelopeFieldsPresent, exhaustionAcceptIo, fakeIo, findingIdDefect, gateReapSweepCommand, gateReapVerdict, hardenCommand, hardenWitnessCommand, join, leadEnv, legacyReviewerExemptions, nameVerdict, observeTurnCensus, panelSeats, phaseTrace, planAcceptContractLines, planCheckAcceptIo, planEnv, planRevisionRun, planScopeVerdict, planThenReviewIo, protectedPlanEnv, protectedReseatRefusal, publicationIo, readFileSync, reconEnv, regrantVerdict, resolveValidationLane, reviewConvergeRun, reviewEnv, reviewFindings, reviewOutcome, reviewShapeDefect, rmSync, roundCursor, s843Ctx, s843Io, s843PlanEnv, s843Rows, scratchDir, shapeDefect, slotCtx, slotFactory, spawnSync, staleVerdictLines, triageEnv, turnCeilingBreached, twoRoundReviewIo, validateAcceptDecision, validateCarve, validatePlanResiduals, validateScopeEntries, validationPlan, validationProbeRun, validationRows, verdictFindingsDefect, writeFileSync,
} from './drive-fixtures.mjs'

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
  const optionsBlock = brief.match(/## Your options[\s\S]*?\n\n## Context files/)[0]
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
      'planner:1': CONVERGE_PLAN(), 'planner:2': CONVERGE_PLAN(),
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
      envelopes: { 'planner:1': protectedPlanEnv([path]) },
      reseat: protectedReseatRefusal,
    })
    const refusal = driveTask(CTX, refusingIo)
    assert.equal(refusal.status, 'escalation')
    assert.equal(refusal.details.escalation.where, 'sensitivity-floor')
    assert.ok(refusal.details.escalation.why.includes(path))
    assert.equal(refusingIo.calls.assign.filter(({ role }) => role === 'builder').length, 0)

    const applyingIo = fakeIo({
      envelopes: { 'planner:1': protectedPlanEnv([path]), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
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
  assert.deepEqual(res.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
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
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.deepEqual(Object.keys(result.details).sort(), [
    'accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'enforcements', 'escalation', 'extra_rounds_granted',
    'files_committed', 'gate', 'growth', 'modifiers', 'stages',
  ])
  assert.deepEqual(result.details.stages, ['plan:r1', 'check:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
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
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: undefined } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.ok(!result.details.stages.includes('check:r2'))
})

test('a proceed verdict continues to check:r2', () => {
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'proceed' } }))
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('check:r2'))
})

test('round 1 does not require a carve verdict', () => {
  const details = { ...planEnv().details }
  delete details.carve_verdict
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
  assert.deepEqual(omitted.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
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
  assert.deepEqual(result.details.stages, ['repair:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
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

test('full, scout and repair declarations remain byte-identical snapshots', () => {
  const FULL_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'rebase', 'suite', 'publish', 'converge'],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [], assignment: null,
  }
  const SCOUT_SNAPSHOT = {
    execution: 'envelope', required_seats: ['planner'],
    stages: ['scout', 'scope-gate', 'envelope-accept'], writes: 'none',
    accepted_by: 'envelope shape',
    envelope_fields: [{ name: 'findings', kind: 'records', item_fields: ['summary', 'evidence'] }],
    assignment: 'Read-only recon. Answer the brief from the code and the checkout, write your notes into the task dir, and change nothing.',
  }
  const REPAIR_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'rebase', 'suite', 'publish'],
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
    const io = fakeIo({ envelopes: { 'planner:1': reconEnv(over) }, changed: [] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
  }
  assert.equal(envelopeDefect(reconEnv(), VARIANTS.scout, { taskDir: TD }), null)
  assert.equal(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).reason, 'no-envelope')
  assert.match(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).why, /no envelope/)
})

test('the envelope refusal reason set is closed and frozen', () => {
  assert.equal(Object.isFrozen(ENVELOPE_REFUSAL_REASONS), true)
  assert.deepEqual([...ENVELOPE_REFUSAL_REASONS], ['no-envelope', 'summary', 'artifacts', 'details', 'field-missing', 'field-kind', 'field-item', 'verdict-findings', 'finding-id', 'carried-silent', 'validation-lane-unloadable'])
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
    const io = fakeIo({ envelopes: { 'planner:1': env }, changed: [] })
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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
    'review:r2', 'review:pass', 'commit', 'suite', 'suite:cold', 'done',
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
    'planner:1': planEnv(), 'planner:2': planEnv(),
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
      'planner:1': dPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
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

test('#800 §7b 44 — divergent collisions preserve reviewer A ids and route its patch', () => {
  const io = divergentCollisionIo()
  const result = driveTask(D_COLLISION_CTX, io)
  const first = dPanelOutcomes(io)[0]
  const adjudication = io.calls.writes[`${TD}/panel-adjudication-1.md`] || ''
  const patch = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'RV1-1' && reviewer === 'reviewer'))
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'panel-remint-1' && reviewer === 'tech-lead'))
  assert.match(adjudication, /panel-remint-1/)
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(patch.includes('a/a.mjs'), true)
})

test('#800 §7b 45 — each reminted final id has one auditable remint join', () => {
  const cases = [
    [classCollisionIo(), 'panel-class-1'],
    [divergentCollisionIo(), 'RV1-1'],
  ]
  for (const [io, original] of cases) {
    const result = driveTask(D_COLLISION_CTX, io)
    assert.equal(result.status, 'done')
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

test('planScopeVerdict is pure and names all four states', () => {
  assert.equal(Object.isFrozen(PLAN_SCOPE), true)
  assert.deepEqual(PLAN_SCOPE_VERDICTS, [
    'plan-scope-undispatched', 'plan-scope-same', 'plan-scope-narrowed', 'plan-scope-widened',
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
    'planner:1': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx(), io)
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
    'planner:1': s843PlanEnv(S843_DISPATCHED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass',
    'commit', 'suite', 'suite:cold', 'done',
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
    'commit', 'suite', 'suite:cold', 'done',
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
