// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  B44_LEADLESS_CTX, adversarialPlanEnv, CENSUS_ROW_ABSENT, CHECK_BUILT, CHECK_CLEAN, CHECK_ENVELOPES, CHECK_FILE, CHECK_MUTATION, CHECK_RUNS, CONVERGE_CTX, CONVERGE_GATE, CRASH_WHY, CTX, CTX_DIRECTED, CTX_REPAIR, CTX_TL, DEFAULT_VARIANT, DIRECTED_BRIEF_PATH, DIRECTED_BRIEF_TEXT, DIRECTED_FILES, DRIVE_JOURNAL_EXPECTED, D_ASK, D_AUTO, D_GREEN_GATE, D_PATCH_A, D_PATCH_B, D_PATCH_EMPTY_PATH, D_PATCH_MIXED_MODE, D_PATCH_MIXED_RENAME, D_RED_GATE, ENVELOPE_DEBRIS, GATE_CUSTODIAN, GATE_SUMMARY_PREFIX, HEALTHY_RESULT, JOURNAL_CHANNELS, JOURNAL_CHANNEL_NAMES, JUDGE_TIER, MAX_QUESTIONS, MODIFIER_OUTCOMES, PHASE_SLOT_WAIT_EVENT, PROTECTED_PATHS, RED, REPO_ROOT, REVIEWED_CORE_STAGES, S843_ADDED, S843_D2, S843_RUNS, SCOPE_REFUSALS, SEAT_REFUSAL_STAGE, SENSITIVITY_FLOOR, SHAPE_SOURCES, SKILL_NAMES, SUITE_SLOT_PHASES, SUITE_SLOT_PHASE_NAMES, TD, THREW, TRIAGE_FILES, TRIAGE_NOTE, TRIAGE_SOURCES, TRIAGE_STAGES, TRIAGE_STAGE_HEAD, VARIANTS, VARIANT_NAMES, WAITS_S, WAIT_FLAGS, WAIT_REFUSALS, WAIT_ROLES, WAIT_SECONDS_MAX, WAIT_SECONDS_MIN, ZERO_CAPACITY_LOGS, ZERO_CAPACITY_RESULT, answerBounceLines, assertSeats, b127GatePaths, b127InvokeGate, b318Builders, b318ReviewGrants, b318SiteA, b318SiteB, b44AssertLeadlessGate, b44GateFixIo, b44GatePlan, b44MidRunRepairIo, baselineGateDefect, bothExhaustionPointsScenario, buildEnv, carveRun, checkEnv, checkFailureLine, closeoutIo, convergeIo, convergeRun, crashIo, crashRun, dApplyCommand, dAutoRows, dBuilders, dGitApplies, dLeads, dReviewEnv, deliberateRun, directSlotRun, dispositionIo, divergentPlanScenario, driveJournalSites, driveTask, enforcementPreamble, envelopeDefect, envelopeFieldsPresent, escalationStageRows, exhaustionAcceptIo, existsSync, fakeIo, fenceBase, fenceDiff, fenceSpan, gateReapCommand, guardedWrite, join, laneFence, laneFenceHits, laneProbeCommand, laneProbeKinds, leadEnv, matchAnswers, mkdirSync, normaliseJournalTimes, operationalRow, osCpus, parseDirectedBrief, parseGateSummary, parseQuestions, parseSuiteCounts, patchTargets, phaseTrace, planEnv, postCommitCrashRun, protectedPlanEnv, protectedReseatRefusal, questionConsultLines, readFileSync, reconEnv, recordRow, refuseWait, replayResumeStages, resolveProtectedPaths, resolveWaits, resumeDoneRows, resumeKeys, resumeStageRows, reviewEnv, rmSync, runChild, runCmd, runCmdFixture, s843Ctx, s843Io, s843PathsIn, s843PlanEnv, scopeBounceBrief, scopeMatcher, scopeRefusal, scratchDir, shapeDefect, shellArg, shellWords, slotCtx, slotFactory, sourcesDefect, spawnSync, stageEnabled, suiteRefusalEnv, throwAutoFixWrites, throwingWaitRun, tmpdir, traceLabels, triageEnv, undeclaredStage, validateScopeEntries, waitsCtx, waitsRecord, writeFileSync,
} from './drive-fixtures.mjs'
import { envelopeFieldMetadataDefect as leafEnvelopeFieldMetadataDefect, EXECUTOR_TOPOLOGIES, SHAPE_DEFECT_CODES, shapeValidationDefect } from './shape-validator.mjs'
import { ADVERSARY_REFUSAL, ADVERSARY_REFUSALS, ADVERSARY_TRIGGERS, CENSUS_CARRIER_FILES as RUNTIME_CENSUS_CARRIER_FILES, SCOPE_ADMISSION_SOURCES, SCOPE_REQUEST_KINDS, fenceScopeOf, fenceScopesIntersect, parseUnifiedZeroHunks, resolveAdversaryTrigger, scopeAdmissionDecision, scopeRequestOf, siblingSpanIntersects, suiteRedTestFiles, RESUME_CHECKPOINT_VERSION, RESUME_CHECKPOINT_FAMILIES, resumeCheckpointDefect, resumeTask, resumeWorktreeSha256 } from './drive.mjs'
import { CENSUS_CARRIER_FILES as DISPATCH_CENSUS_CARRIER_FILES } from '../scripts/factory/dispatch-batch.mjs'
import { ANTI_REPLAY_REFUSAL_REASONS, envelopeFieldMetadataDefect } from './drive.mjs'

const A1_FULL_TRACE = Object.freeze(['plan', 'build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'suite'])
const A1_PUBLISH_DISABLED_TRACE = Object.freeze(['commit', 'document', 'suite', 'suite'])
const D1_ORDERED_PAIR = Object.freeze(['plan', 'build'])
const E1_FORBIDDEN_ITERATION = 'for (const declaredStage of shape.stages) execute(declaredStage)'

const d1ControlRow = () => ({ name: 'D1 control', executor: ['plan', 'build'], expected: D1_ORDERED_PAIR })
const assertExactTraceRows = (rows) => {
  for (const row of rows) {
    assert.deepEqual(row.executor, row.expected, `${row.name} emitted trace`)
  }
}

const normaliseStageHeads = (stages) => (Array.isArray(stages) ? stages : [])
  .map((label) => String(label).split(':')[0])
  .filter((head) => !['done', 'escalate'].includes(head))

test('a supplied wait budget reaches io.wait and names the seat overdue at that budget', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask({ ...CTX, waits: { planner: 42 } }, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope .* within 42s/)
  assert.deepEqual(io.calls.waits[0], { returnPath: 'planner:1', timeoutS: 42 })
})

test('an absent wait budget resolves to the recorded WAITS_S value', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope .* within 1800s/)
  assert.equal(io.calls.waits[0].timeoutS, WAITS_S.planner)
})

test('a malformed wait budget refuses at the boundary instead of defaulting', () => {
  for (const raw of [0, '0', -1, '2.5', 'abc', '1e3', 21601, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveWaits({ planner: raw }),
      (err) => err.reason === 'invalid-wait-planner',
    )
  }
  assert.throws(() => resolveWaits(true), (err) => err.reason === WAIT_REFUSALS[0])
  assert.throws(() => resolveWaits([]), (err) => err.reason === WAIT_REFUSALS[0])
  assert.deepEqual(resolveWaits({}), Object.fromEntries(WAIT_ROLES.map((role) => [role, null])))
  assert.equal(resolveWaits({ planner: '   ' }).planner, null)
})

test('the wait flag, refusal and record surfaces are derived from WAITS_S', () => {
  assert.deepEqual(WAIT_ROLES, Object.keys(WAITS_S))
  assert.deepEqual(WAIT_FLAGS, ['wait-planner', 'wait-tech-lead', 'wait-builder', 'wait-reviewer', 'wait-lead'])
  assert.deepEqual(WAIT_REFUSALS, ['invalid-wait-planner', 'invalid-wait-tech-lead', 'invalid-wait-builder', 'invalid-wait-reviewer', 'invalid-wait-lead'])
  assert.throws(() => refuseWait('nope', 'x'), /unknown wait refusal reason/)
  assert.equal(WAIT_SECONDS_MIN, 1)
  assert.equal(WAIT_SECONDS_MAX, 21600)
  assert.equal(waitsCtx(resolveWaits({})), null)
  assert.deepEqual(waitsCtx(resolveWaits({ reviewer: '600' })), { reviewer: 600 })
  assert.deepEqual(waitsRecord(resolveWaits({ planner: '2400' }), WAITS_S), {
    planner: 2400, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
    source: { planner: 'flag', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'default' },
  })
})

test('run refuses an invalid wait budget before reading crew state', () => {
  const home = scratchDir('crew-waits-refusal-home-')
  const previousHome = process.env.HOME
  let drove = 0
  process.env.HOME = home
  try {
    for (const role of ['planner', 'tech-lead', 'builder', 'reviewer', 'lead']) {
      const flag = `wait-${role}`
      assert.throws(
        () => runCmd({ task: 'invalid-wait-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), [flag]: '2.5' }, { drive: () => { drove += 1 } }),
        (err) => err.reason === `invalid-wait-${role}`,
      )
    }
    assert.equal(drove, 0)
    assert.equal(existsSync(join(home, '.crew')), false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('run plumbs flagged wait budgets to the driver and records defaults when absent', () => {
  const flagged = runCmdFixture({ 'wait-planner': '2700', 'wait-lead': '1200' })
  assert.deepEqual(flagged.ctx.waits, { planner: 2700, lead: 1200 })
  const flaggedRow = flagged.rows.find((row) => row.event === 'waits')
  assert.ok(flaggedRow)
  assert.equal(flaggedRow.planner, 2700)
  assert.equal(flaggedRow.lead, 1200)
  assert.deepEqual(flaggedRow.source, {
    planner: 'flag', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'flag',
  })

  const absent = runCmdFixture()
  assert.equal(Object.hasOwn(absent.ctx, 'waits'), false)
  const absentRow = absent.rows.find((row) => row.event === 'waits')
  assert.ok(absentRow)
  assert.deepEqual(absentRow.source, {
    planner: 'default', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'default',
  })
})

test('crew CLI usage documents the per-role seat wait budget flags', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.match(source, /--wait-planner/)
  assert.match(source, /--wait-tech-lead/)
  assert.match(source, /--wait-builder/)
  assert.match(source, /--wait-reviewer/)
  assert.match(source, /--wait-lead/)
})

test('parseQuestions normalizes survivors, reports malformed entries, and is total', () => {
  assert.equal(parseQuestions(null), null)
  assert.equal(parseQuestions(undefined), null)
  assert.equal(parseQuestions('not details'), null)
  assert.equal(parseQuestions({ questions: 'not an array' }), null)

  const parsed = parseQuestions({
    questions: [
      { id: ' q1 ', question: ' first? ' },
      { question: 'missing id' },
      { id: 'q2' },
      'not an object',
      ['nested array'],
      { id: ' q1 ', question: 'duplicate' },
      { id: 'q3', question: ' third? ' },
    ],
  })
  assert.deepEqual(parsed.questions, [
    { id: 'q1', question: 'first?' },
    { id: 'q3', question: 'third?' },
  ])
  assert.ok(parsed.rejected.some(({ why }) => why === 'missing id'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'missing question'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'not a plain object'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'duplicate id'))
  assert.ok(parsed.rejected.every(({ index, why }) => Number.isInteger(index) && typeof why === 'string' && why.length > 0))

  const overCap = parseQuestions({
    questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => ({ id: `q${index}`, question: `question ${index}` })),
  })
  assert.equal(overCap.questions.length, MAX_QUESTIONS)
  assert.deepEqual(overCap.rejected.at(-1), { index: MAX_QUESTIONS, why: `over the ${MAX_QUESTIONS}-question cap` })
  for (const garbage of [null, 'string', 42, [[]]]) assert.doesNotThrow(() => parseQuestions(garbage))

  const hostileLength = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return { [Symbol.toPrimitive]() { throw new Error('hostile length') } }
      return Reflect.get(target, property, receiver)
    },
  })
  assert.doesNotThrow(() => parseQuestions({ questions: hostileLength }))
  assert.doesNotThrow(() => matchAnswers(hostileLength, hostileLength))
  assert.doesNotThrow(() => questionConsultLines('planner', hostileLength))
  assert.doesNotThrow(() => answerBounceLines(hostileLength, { answered: hostileLength, rejected: hostileLength }))
})

test('matchAnswers matches keyed answers and never reads silence as assent', () => {
  const questions = [{ id: 'q1', question: 'one?' }, { id: 'q2', question: 'two?' }, { id: 'q3', question: 'three?' }]
  const matched = matchAnswers(questions, [
    { id: ' q1 ', answer: ' answer one ' },
    { id: 'q1', answer: 'duplicate' },
    { id: 'unknown', answer: 'not asked' },
    { id: 'q3', answer: '   ' },
  ])
  assert.deepEqual(matched.answered, [{ id: 'q1', answer: 'answer one' }])
  assert.deepEqual(matched.unanswered, ['q2', 'q3'])
  assert.deepEqual(matched.rejected, [
    { id: 'q1', why: 'duplicate id' },
    { id: 'unknown', why: 'unknown id' },
    { id: 'q3', why: 'empty answer' },
  ])
  assert.deepEqual(matchAnswers(questions.slice(0, 1), [
    { id: 'q1', answer: '   ' }, { id: 'q1', answer: ' usable ' },
  ]), {
    answered: [{ id: 'q1', answer: 'usable' }], unanswered: [],
    rejected: [{ id: 'q1', why: 'empty answer' }],
  })

  assert.deepEqual(matchAnswers(questions, undefined), {
    answered: [], unanswered: ['q1', 'q2', 'q3'],
    rejected: [{ id: null, why: 'answers must be an array' }],
  })
  assert.deepEqual(matchAnswers(questions, null), {
    answered: [], unanswered: ['q1', 'q2', 'q3'],
    rejected: [{ id: null, why: 'answers must be an array' }],
  })
})

test('question and answer composers are empty for an empty question set', () => {
  assert.deepEqual(questionConsultLines('planner', []), [])
  assert.deepEqual(answerBounceLines([], { answered: [], unanswered: [], rejected: [] }), [])
  const consult = questionConsultLines('planner', [{ id: 'q1', question: 'Which path?' }]).join('\n')
  assert.ok(consult.includes('## The planner returned 1 numbered question(s) — answer ALL of them'))
  assert.ok(consult.includes('details.answers: [{"id": "<question id>", "answer": "..."}]'))
  assert.match(consult, /id you leave out.*UNANSWERED/)
  const bounce = answerBounceLines(
    [{ id: 'q1', question: 'Which path?' }, { id: 'q2', question: 'Which test?' }],
    { answered: [{ id: 'q1', answer: 'crew/drive.mjs' }], rejected: [{ id: 'q9', why: 'unknown id' }] },
  ).join('\n')
  assert.ok(bounce.includes('q1: Which path?\n  ANSWER: crew/drive.mjs'))
  assert.ok(bounce.includes('q2: Which test?\n  UNANSWERED'))
  assert.match(bounce, /Dropped answer entries.*q9.*unknown id/)
})

test('skills are self-contained and verifiable on both vendors', () => {
  for (const name of SKILL_NAMES) {
    const dir = join(REPO_ROOT, '.agents', 'skills', name)
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(frontmatter, `${name} must have parseable frontmatter`)
    const fields = frontmatter[1]
    assert.equal(fields.match(/^name:\s*(\S+)\s*$/m)?.[1], name)
    const description = fields.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    assert.ok(description)
    assert.doesNotMatch(description, /\n/)
    const body = text.slice(frontmatter[0].length)
    const scripts = [...body.matchAll(/`[^`]*?([\w./-]*scripts\/[\w.-]+\.mjs)[^`]*`/g)].map((match) => match[1])
    assert.ok(scripts.length, `${name} must name a shipped scripts/*.mjs file`)
    for (const script of scripts) {
      const candidate = script.startsWith('.agents/') ? script : `.agents/skills/${name}/${script.replace(/^\.\//, '')}`
      assert.ok(existsSync(join(REPO_ROOT, candidate)), `missing ${candidate}`)
    }
    assert.ok(existsSync(join(dir, 'scripts')))
    const seat = body.slice(body.indexOf('## Verifying on a seat'))
    assert.match(seat, /\bpi\b/)
    assert.match(seat, /\bclaude\b/)
  }
})

test('the review-procedure loader prints repo guidelines without inlining judgment', () => {
  const loader = join(REPO_ROOT, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
  const guidelines = join(REPO_ROOT, 'crew/guidelines/review-do-not-flag.md')
  const result = spawnSync(process.execPath, [loader], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, readFileSync(guidelines, 'utf8'))
  const skill = readFileSync(join(REPO_ROOT, '.agents/skills/review-procedure/SKILL.md'), 'utf8')
  for (const smell of ['Defense:', 'Task-dir drift', 'Seeded from 49 archived runs']) assert.doesNotMatch(skill, new RegExp(smell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('happy path: plan -> build -> gates -> review pass -> suite -> commit, zero consults', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'] }, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.commit, 'abc1234')
  assert.equal(res.details.consults, 0)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'a.test.mjs'])
  assert.equal(io.calls.commits[0].message, 'crew(t1): planned\n\nfeat: the change')
  // suite ran exactly once, AFTER the lane
  assert.deepEqual(io.calls.run.map((r) => r.cmd), ['lane-cmd', 'suite-cmd'])
})

test('a red cold run escalates with its commit, paths, and cleanup diagnosis', () => {
  const io = closeoutIo({
    cold: { ok: false, output: 'cold failure\n', path: '/zz/coldpath', kept: '/zz/coldpath' },
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.match(result.details.escalation.why, /\/tmp\/repo/)
  assert.match(result.details.escalation.why, /\/zz\/coldpath/)
  assert.match(result.details.escalation.why, /git worktree remove --force/)
  assert.match(result.details.escalation.why, /which directory the suite ran in/)
})

test('a throwing cold runner escalates as unproven and preserves its reason', () => {
  const result = driveTask(CTX, closeoutIo({ cold: 'throw' }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.equal(result.details.cold_suite.verdict, 'unproven')
  assert.match(result.details.cold_suite.why, /injected cold runner failure/)
})

test('an io without a cold runner cannot reach done', () => {
  const result = driveTask(CTX, closeoutIo({ cold: null }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.deepEqual(result.details.cold_suite, {
    verdict: 'unavailable', why: 'this io provides no runCold, so no cold checkout could be cut',
  })
})

test('a green cold run is reported separately and named in the done summary', () => {
  const result = driveTask(CTX, closeoutIo())
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.cold_suite, { verdict: 'green', path: '/zz/aa11bb', counts: null })
  assert.match(result.summary, /cold-verified from \/zz\/aa11bb/)
})

test('the cold runner receives lane first and task names exactly once', () => {
  const ctx = { ...CTX, task: 'zqtask7', laneName: 'zqlane5' }
  const io = closeoutIo()
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.runCold, [{ cmd: ctx.suite, names: ['zqlane5', 'zqtask7'] }])

  const noLane = closeoutIo()
  driveTask({ ...CTX, laneName: undefined }, noLane)
  assert.deepEqual(noLane.calls.runCold, [{ cmd: CTX.suite, names: [CTX.task] }])
})

test('the cold run follows commit and records suite:cold between commit and done', () => {
  const io = closeoutIo()
  const { calls } = io
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(calls.order.indexOf('commit') < calls.order.indexOf('runCold'))
  assert.deepEqual(result.details.stages.slice(-3), ['suite', 'suite:cold', 'done'])
})

test('scope helpers match directory prefixes and validate only supported entries', () => {
  const match = scopeMatcher(['tasks/x/captures/', 'crew/drive.mjs'])
  assert.equal(match('tasks/x/captures/1.md'), true)
  assert.equal(match('tasks/x/captures/deep/2.md'), true)
  assert.equal(match('crew/drive.mjs'), true)
  assert.equal(match('crew/crew.mjs'), false)
  assert.equal(match('tasks/x/other.md'), false)
  assert.deepEqual(validateScopeEntries(['tasks/x/captures/', 'crew/drive.mjs']), [])
  for (const entry of ['crew/', 'tasks/', '.', './', '/', '', 'crew/*.mjs', '*', '../x.mjs', '/abs/x.mjs']) {
    const [error] = validateScopeEntries([entry])
    assert.equal(error.entry, entry)
    assert.ok(error.why)
  }
})

test('laneFenceHits names the owning lane and never inverts into an allow-list', () => {
  const fence = [{ lane: 'intake-loop', files: ['scripts/factory/', 'dir/owned.mjs'] }]
  assert.deepEqual(laneFenceHits([
    'scripts/factory/intake.mjs', 'dir/', 'dir/', 'unowned.mjs',
  ], fence), [
    { entry: 'scripts/factory/intake.mjs', lane: 'intake-loop' },
    { entry: 'dir/', lane: 'intake-loop' },
  ])
  assert.deepEqual(laneFenceHits(['unowned.mjs'], [{ lane: 'ignored', files: [] }]), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], undefined), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], []), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], [{ lane: 'ignored' }]), [])
})

test('an unfenced ctx.laneFence leaves the run exactly as today', () => {
  const input = {
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  }
  const fencedIo = fakeIo(input)
  const plainIo = fakeIo(input)
  const fenced = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }] }, fencedIo)
  const plain = driveTask(CTX, plainIo)
  assert.equal(fenced.status, plain.status)
  assert.deepEqual(fencedIo.calls.run, plainIo.calls.run)
  assert.deepEqual(fencedIo.calls.commits, plainIo.calls.commits)
})

test('C1b driver fence matching resolves spans through the leaf', () => {
  assert.deepEqual(fenceScopeOf('src/widget.mjs:4-6'), {
    kind: 'span', entry: 'src/widget.mjs:4-6', path: 'src/widget.mjs', start: 4, end: 6,
  })
  assert.deepEqual(laneFenceHits(['src/widget.mjs:6-8'], [
    { lane: 'sibling', files: ['src/widget.mjs:4-6'] },
  ]), [{ entry: 'src/widget.mjs:6-8', lane: 'sibling' }])
})

test('D1a sibling span denies an intersecting changed hunk', () => {
  const parsed = parseUnifiedZeroHunks(fenceDiff('src/widget.mjs', 8, 0, 8, 1), 'src/widget.mjs')
  assert.deepEqual(parsed.hunks, [{ kind: 'span', path: 'src/widget.mjs', start: 8, end: 8 }])
  assert.equal(siblingSpanIntersects(fenceScopeOf('src/widget.mjs:5-8'), parsed.hunks), true)
})

test('D1b sibling span admits a wholly disjoint changed hunk', () => {
  const parsed = parseUnifiedZeroHunks(fenceDiff('src/widget.mjs', 0, 0, 1, 1), 'src/widget.mjs')
  assert.deepEqual(parsed.hunks, [{ kind: 'span', path: 'src/widget.mjs', start: 0, end: 0 }])
  assert.equal(siblingSpanIntersects(fenceScopeOf('src/widget.mjs:1-8'), parsed.hunks), false)
})

test('RV1-2 plan scope does not refuse sibling overlap', () => {
  const file = 'crew/a.mjs'
  const scopedPlan = () => planEnv({ details: { ...planEnv().details, files_in_scope: [file] } })
  const fenceBases = { [`base-sha:${file}`]: { ok: true, output: fenceBase(30) } }
  const scopedCtx = (laneFence) => ({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence })
  const run = (laneFence) => {
    const io = fakeIo({
      envelopes: { 'planner:1': scopedPlan(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: [file], fenceBases,
    })
    const result = driveTask(scopedCtx(laneFence), io)
    assert.equal(result.status, 'done')
    assert.equal(result.details.escalation, null)
    assert.deepEqual(io.calls.assign.map(({ role }) => role), ['planner', 'builder', 'reviewer'])
  }
  run([fenceSpan('own-lane', file, 15, 25), fenceSpan('lane-b', file, 10, 20)])
  run([fenceSpan('lane-b', file, 10, 20)])
})

test('F1a whole file fence keeps legacy denial', () => {
  assert.equal(fenceScopesIntersect(fenceScopeOf('src/widget.mjs'), fenceScopeOf('src/widget.mjs:40-41')), true)
  assert.deepEqual(laneFenceHits(['src/widget.mjs'], [{ lane: 'sibling', files: ['src/widget.mjs'] }]), [
    { entry: 'src/widget.mjs', lane: 'sibling' },
  ])
})

test('F1b whole file fence keeps legacy admission', () => {
  assert.equal(fenceScopesIntersect(fenceScopeOf('src/widget.mjs'), fenceScopeOf('other.mjs:40-41')), false)
  assert.deepEqual(laneFenceHits(['other.mjs'], [{ lane: 'sibling', files: ['src/widget.mjs'] }]), [])
})

test('G1a span past base EOF refuses by lane and span', () => {
  const entry = 'src/widget.mjs:2-3'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['src/widget.mjs'] } }) },
    fenceBases: { 'base-sha:src/widget.mjs': { ok: true, output: fenceBase(2) } },
  })
  const result = driveTask({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence: [fenceSpan('own-lane', 'src/widget.mjs', 2, 3)] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /own-lane/)
  assert.match(result.details.escalation.why, new RegExp(entry.replaceAll('.', '\\.')))
  assert.equal(io.calls.assign.some(({ role }) => role === 'builder'), false)
})

test('G1b reversed span refuses by lane and span', () => {
  const entry = 'src/widget.mjs:3-2'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['src/widget.mjs'] } }) },
    fenceBases: { 'base-sha:src/widget.mjs': { ok: true, output: fenceBase(3) } },
  })
  const result = driveTask({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence: [fenceSpan('own-lane', 'src/widget.mjs', 3, 2)] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /own-lane/)
  assert.match(result.details.escalation.why, new RegExp(entry.replaceAll('.', '\\.')))
  assert.equal(io.calls.assign.some(({ role }) => role === 'builder'), false)
})

test('G1c malformed fence shape refuses by lane and entry', () => {
  const entry = 'src/widget.mjs:2-3-4'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['src/widget.mjs'] } }) },
  })
  const result = driveTask({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence: [{ lane: 'own-lane', files: [entry] }] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /own-lane/)
  assert.match(result.details.escalation.why, new RegExp(entry.replaceAll('.', '\\.')))
  assert.equal(io.calls.fenceShows.length, 0)
})

test('H1 span validation reads the lane base rather than the working tree', () => {
  const entry = 'src/widget.mjs:1-3'
  const details = { ...planEnv().details, files_in_scope: ['src/widget.mjs'] }
  const run = (fenceBases, extra = {}) => {
    const io = fakeIo({
      envelopes: { 'planner:1': planEnv({ details }) },
      files: { '/tmp/repo/src/widget.mjs': fenceBase(20) },
      fenceBases,
    })
    const result = driveTask({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence: [fenceSpan('own-lane', 'src/widget.mjs', 1, 3)], ...extra }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scope')
    assert.match(result.details.escalation.why, /own-lane/)
    assert.match(result.details.escalation.why, new RegExp(entry.replaceAll('.', '\\.')))
    return io
  }
  const shorterBase = run({ 'base-sha:src/widget.mjs': { ok: true, output: fenceBase(2) } })
  assert.deepEqual(shorterBase.calls.fenceShows, ["git show 'base-sha:src/widget.mjs'"])
  const unreadableBase = run({ 'base-sha:src/widget.mjs': { ok: false, output: fenceBase(20) } })
  assert.equal(unreadableBase.calls.fenceShows.length, 1)
  const blankBase = run({}, { head: '   ' })
  assert.equal(blankBase.calls.fenceShows.length, 0)
  assert.equal(shorterBase.calls.fenceShows.some((command) => command.includes('main')), false)
})

test('I1 plan files in scope still reject span grammar', () => {
  assert.deepEqual(validateScopeEntries(['crew/drive.mjs:1-2']), [{
    entry: 'crew/drive.mjs:1-2',
    why: 'line spans are lane-fence entries, not files_in_scope paths',
  }])
})

test('the closed variant set lives in the import-free leaf and drive re-exports it', () => {
  const driveSource = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const variantsSource = readFileSync(new URL('./variants.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(driveSource, /export const VARIANTS/)
  assert.match(driveSource, /export \{ VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT \} from '\.\/variants\.mjs'/)
  assert.doesNotMatch(variantsSource, /^\s*import[\s(]/m)
  assert.deepEqual(Object.keys(VARIANTS), [...VARIANT_NAMES])
})

test('the protected-path floor lives in the import-free leaf and drive re-exports it', async () => {
  const driveSource = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const leafSource = readFileSync(new URL('./protected-paths.mjs', import.meta.url), 'utf8')
  const leaf = await import('./protected-paths.mjs')
  assert.doesNotMatch(leafSource, /^\s*import[\s(]/m)
  assert.doesNotMatch(driveSource, /export const PROTECTED_PATHS/)
  assert.match(driveSource, /export \{ PROTECTED_PATHS, resolveProtectedPaths \} from '\.\/protected-paths\.mjs'/)
  assert.equal(PROTECTED_PATHS, leaf.PROTECTED_PATHS)
})

test('a per-repo protected-path list adds to the floor and can never shrink it', () => {
  const additions = resolveProtectedPaths(['./db\\migrations\\', 'db/migrations/'])
  assert.ok(additions.includes('db/migrations/'))
  for (const path of PROTECTED_PATHS) assert.ok(additions.includes(path), `${path} was removed`)
  assert.equal(resolveProtectedPaths(), PROTECTED_PATHS)
  assert.throws(() => resolveProtectedPaths('db/migrations/'))
  assert.throws(() => resolveProtectedPaths(['  ']))
})

test('A1 adversary none skips every plan check stage', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.some(({ role }) => role === 'tech-lead'), false)
  assert.equal(result.details.stages.some((stage) => stage.startsWith('check:')), false)
})

test('B1 planner request runs the adversary plan check', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'tech-lead').length, 1)
  assert.ok(result.details.stages.includes('check:r1'))
})

// B2 was withdrawn by hand after review: the brief asked for an ABSENT
// declaration to be refused, which contradicts ADR-038 section 2 (the loop runs
// when the planner DECLARES) and reddened crew/daemon.test.mjs:2094 and
// crew/crew.test.mjs:6505, both of which build envelopes without the field.
// This check now pins the corrected rule, and it is the mutation guard for it:
// restoring the missing-declaration refusal turns this test red.
test('B2 an absent needs adversary declaration is not a refusal and seats no adversary', () => {
  const planner = planEnv()
  delete planner.details.needs_adversary
  const io = fakeIo({
    envelopes: { 'planner:1': planner, 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'tech-lead').length, 0)
  assert.equal(io.calls.logs.find((row) => Object.hasOwn(row, 'adversary_trigger')).adversary_trigger, 'none')
})

test('B3 nonboolean needs adversary declaration is refused', () => {
  const planner = planEnv({ details: { ...planEnv().details, needs_adversary: 'yes' } })
  const io = fakeIo({ envelopes: { 'planner:1': planner } })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.why, 'needs-adversary-type')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'tech-lead').length, 0)
})

test('B4 every revised planner envelope is validated', () => {
  const planner2 = planEnv({ details: { ...planEnv().details, needs_adversary: 'yes' } })
  const io = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('revise'), 'planner:2': planner2,
    },
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.why, 'needs-adversary-type')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'tech-lead').length, 1)
  assert.equal(io.calls.logs.filter((row) => Object.hasOwn(row, 'adversary_trigger')).length, 1)
})

// PC-05 (prescribed at plan-check, never written; added by hand at closeout).
// resolveAdversaryTrigger normalises `details` and `mutations` before reading
// them. validEnvelope does NOT require details, so a done envelope with null
// details is reachable — and without the normalisation this is a TypeError out
// of driveTask rather than a typed result, while all twelve gate checks still
// pass. MUTATION: delete either normalising line and this test throws.
test('PC-05 malformed planner details resolve to a typed trigger and never throw', () => {
  for (const details of [null, undefined, 'plan', 42, ['a'], {}]) {
    const resolved = resolveAdversaryTrigger(details, [])
    assert.equal(resolved.refusal, undefined, JSON.stringify(details))
    assert.equal(ADVERSARY_TRIGGERS.includes(resolved.trigger), true, JSON.stringify(details))
  }
  for (const mutations of [null, 'all', 7, { file: 'a.mjs' }, [null, 'a', { file: 5 }]]) {
    const resolved = resolveAdversaryTrigger({ needs_adversary: false, mutations }, ['crew/drive.mjs'])
    assert.equal(resolved.trigger, 'coverage-absent', JSON.stringify(mutations))
  }
  // A protected file IS proved only by a non-exempt mutation naming it.
  assert.equal(resolveAdversaryTrigger(
    { needs_adversary: false, mutations: [{ file: 'crew/drive.mjs' }] }, ['crew/drive.mjs'],
  ).trigger, 'none')
  assert.equal(resolveAdversaryTrigger(
    { needs_adversary: false, mutations: [{ file: 'crew/drive.mjs', exempt: true }] }, ['crew/drive.mjs'],
  ).trigger, 'coverage-absent')
})

// RV1-4 (review 'consider', closed by hand). Both enums are indexed
// positionally in drive.mjs, so a reordering is silent. Every other closed enum
// in this repo is pinned by a test; these were imported by none.
test('RV1-4 the adversary enums are closed and positionally stable', () => {
  assert.deepEqual(ADVERSARY_TRIGGERS, ['planner-request', 'coverage-absent', 'none'])
  assert.deepEqual(ADVERSARY_REFUSALS, ['needs-adversary-type', 'adversary-unavailable'])
  assert.deepEqual(ADVERSARY_REFUSAL, { type: 'needs-adversary-type', unavailable: 'adversary-unavailable' })
  assert.equal(Object.isFrozen(ADVERSARY_TRIGGERS), true)
  assert.equal(Object.isFrozen(ADVERSARY_REFUSALS), true)
  assert.equal(Object.isFrozen(ADVERSARY_REFUSAL), true)
  // 'needs-adversary-missing' was withdrawn with gate check B2: an absent
  // declaration is no longer a refusal, so the member is unreachable.
  assert.equal(ADVERSARY_REFUSALS.includes('needs-adversary-missing'), false)
  // ADR-038 Amendment 1: 'operator-force' is not an enum member, because no
  // caller can write it. Every member below is produced by resolveAdversaryTrigger
  // on some input, which is what makes this enum closed rather than aspirational.
  assert.equal(ADVERSARY_TRIGGERS.includes('operator-force'), false)
  const produced = new Set([
    resolveAdversaryTrigger({ needs_adversary: true }, []).trigger,
    resolveAdversaryTrigger({ needs_adversary: false }, ['crew/drive.mjs']).trigger,
    resolveAdversaryTrigger({ needs_adversary: false }, []).trigger,
  ])
  assert.deepEqual([...produced].sort(), [...ADVERSARY_TRIGGERS].sort())
})

test('C1 uncovered protected scope fails closed to the adversary', () => {
  const planner = planEnv({ details: { ...planEnv().details, files_in_scope: ['crew/drive.mjs'] } })
  const io = fakeIo({ envelopes: { 'planner:1': planner, 'tech-lead:1': checkEnv('approve') } })
  const result = driveTask(CTX_TL, io)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'tech-lead').length, 1)
  assert.equal(io.calls.logs.find((row) => Object.hasOwn(row, 'adversary_trigger')).adversary_trigger, 'coverage-absent')
  assert.equal(result.details.escalation.where, 'sensitivity-floor')
})

test('G1 judge reviewer floor remains unchanged', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved') },
    reseat: protectedReseatRefusal,
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'sensitivity-floor')
  assert.equal(io.calls.assign.some(({ role }) => role === 'reviewer'), false)
})

test('D1 idle tech lead remains seated and unconsulted', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.ok(CTX_TL.roles.includes('tech-lead'))
  assert.equal(io.calls.assign.some(({ role }) => role === 'tech-lead'), false)
})

test('E1 one journal row attributes the adversary trigger', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((row) => Object.hasOwn(row, 'adversary_trigger'))
  assert.deepEqual(rows.map((row) => row.adversary_trigger), ['planner-request'])
})

test('protected scope plus a refusing reseat escalates before assigning a builder', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved') },
    reseat: protectedReseatRefusal,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'sensitivity-floor')
  assert.match(res.details.escalation.why, /crew\/drive\.mjs/)
  assert.match(res.details.escalation.why, /sensitivity floor/i)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
  assert.equal(res.details.stages.some((label) => label.startsWith('review')), false)
})

test('every refusing sensitivity floor firing records and emits one closed modifier attempt', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved') },
    reseat: protectedReseatRefusal,
  })
  const res = driveTask(CTX, io)
  const rows = res.details.modifiers.filter(({ modifier }) => modifier === SENSITIVITY_FLOOR)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'reviewer')
  assert.ok(MODIFIER_OUTCOMES.includes(rows[0].outcome))
  assert.notEqual(rows[0].outcome, 'applied')
  assert.deepEqual(io.calls.emits.filter(({ kind, modifier }) => kind === 'modifier' && modifier === SENSITIVITY_FLOOR).length, 1)
})

test('protected scope plus an applied sensitivity floor proceeds with one judge request', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved'), 'builder:1': buildEnv({ details: { ...buildEnv().details, files_changed: ['crew/drive.mjs'] } }), 'reviewer:1': reviewEnv('pass') },
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    files: { [`${CTX.checkout}/crew/drive.mjs`]: 'true' },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.reseat, [{ role: 'reviewer', options: { reason: SENSITIVITY_FLOOR, tier: JUDGE_TIER } }])
  assert.deepEqual(res.details.modifiers.filter(({ modifier }) => modifier === SENSITIVITY_FLOOR).map(({ outcome }) => outcome), ['applied'])
})

test('an already seated judge reviewer satisfies the sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved'), 'builder:1': buildEnv({ details: { ...buildEnv().details, files_changed: ['crew/drive.mjs'] } }), 'reviewer:1': reviewEnv('pass') },
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    files: { [`${CTX.checkout}/crew/drive.mjs`]: 'true' },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, already: true, from: { id: 'judge' }, to: { id: 'judge' }, rung: 'judge→judge' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = res.details.modifiers.find(({ modifier }) => modifier === SENSITIVITY_FLOOR)
  assert.equal(row.outcome, 'applied')
  assert.match(row.why, /already the judge tier cell/)
})

test('sensitivity-floor recording remains non-load-bearing when modifier log and emit fail', () => {
  const input = {
    envelopes: { 'planner:1': protectedPlanEnv(undefined, 'proved') },
    reseat: protectedReseatRefusal,
  }
  const quietIo = fakeIo(input)
  const noisyIo = fakeIo(input)
  const quietLog = noisyIo.log
  noisyIo.log = (entry) => {
    if (entry.modifier) throw new Error('journal unavailable')
    quietLog(entry)
  }
  noisyIo.emit = () => { throw new Error('ledger unavailable') }
  const quiet = driveTask(CTX, quietIo)
  const noisy = driveTask(CTX, noisyIo)
  assert.deepEqual({ status: noisy.status, stages: noisy.details.stages, why: noisy.details.escalation.why }, {
    status: quiet.status, stages: quiet.details.stages, why: quiet.details.escalation.why,
  })
})

test('a run without a bounce emits no modifier attempts', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [])
})

test('lead answering outside the offered options is treated as escalate', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': leadEnv('proceed-anyway'), // not an offered option
    },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /treating as escalate/)
})

test('lead timeout (no envelope) on a consult throws toward escalation, never silent progress', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': null },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /lead: no valid envelope/)
})

test('a present stale or mis-addressed envelope emits one refusal and terminates at its dispatch', () => {
  const io = fakeIo({ emit: true, envelopes: { 'planner:1': planEnv({ assignment_id: 'stale-planner' }), 'lead:1': leadEnv('escalate') } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.match(res.details.escalation.why, /envelope-refusal: assignment-id-mismatch/)
  assert.doesNotMatch(res.details.escalation.why, /no valid envelope/)
  assert.doesNotMatch(res.summary, /the driver crashed/)
  const refusalRows = io.calls.logs.filter((row) => Object.hasOwn(row, 'envelope_refused'))
  assert.equal(refusalRows.length, 1)
  assert.deepEqual(refusalRows[0].envelope_refused, {
    role: 'planner', dispatch: 'planner1', reason: 'assignment-id-mismatch',
    field: 'assignment_id', expected: 'planner1', found: 'stale-planner',
    found_assignment_id: 'stale-planner', expected_assignment_id: 'planner1', path: 'planner:1',
  })
  assert.ok(io.calls.emits.some((event) => event.kind === 'cell-failure' && event.failure === 'unusable-envelope' && event.stage === 'envelope-refusal'))
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'envelope' && event.id === 'planner1'), [
    { kind: 'envelope', id: 'planner1', role: 'planner', status: 'insufficient' },
  ])

  for (const [label, envelope, reason] of [
    ['assignment mismatch wins over role mismatch', planEnv({ assignment_id: 'stale-planner', role: 'not-planner' }), 'assignment-id-mismatch'],
    ['role mismatch alone', planEnv({ role: 'not-planner' }), 'role-mismatch'],
    ['non-string status', planEnv({ status: null }), 'status-kind'],
  ]) {
    const caseIo = fakeIo({ emit: true, envelopes: { 'planner:1': envelope, 'lead:1': leadEnv('escalate') } })
    const result = driveTask(CTX, caseIo)
    assert.equal(result.status, 'escalation', label)
    assert.equal(result.details.escalation.where, 'plan', label)
    assert.match(result.details.escalation.why, new RegExp(`envelope-refusal: ${reason}`), label)
    assert.doesNotMatch(result.summary, /the driver crashed/, label)
    const rows = caseIo.calls.logs.filter((row) => Object.hasOwn(row, 'envelope_refused'))
    assert.equal(rows.length, 1, label)
    assert.equal(rows[0].envelope_refused.reason, reason, label)
  }
})

function identityFixture(envelope, { variant = 'scout', role = 'planner', runId = 'run-1', id = 'd1' } = {}) {
  const io = fakeIo({ emit: true })
  const assign = io.assign.bind(io)
  io.assign = function (spec) {
    const assigned = assign(spec)
    return { ...assigned, id, returnPath: `/tmp/returns/${runId}/${id}.${role}.json` }
  }
  io.wait = () => envelope
  return { io, ctx: { ...CTX, variant, run_id: runId, roles: [role], seatedRoles: [role] } }
}

function rpcNoEnvelope(detail, over = {}) {
  return {
    assignment_id: 'd1', role: 'planner', status: 'insufficient', summary: 'rpc fallback', artifacts: [],
    details: { degraded: 'rpc-no-envelope', ...detail }, ...over,
  }
}

test('A1 handled anti-replay refusal', () => {
  const cases = [
    ['plan', CTX, 'planner', () => fakeIo({
      emit: true, envelopes: { 'planner:1': planEnv({ assignment_id: 'stale-planner' }), 'lead:1': leadEnv('escalate') },
    })],
    ['build', CTX_DIRECTED, 'builder', () => fakeIo({
      emit: true, files: DIRECTED_FILES,
      envelopes: { 'builder:1': buildEnv({ assignment_id: 'stale-builder' }), 'lead:1': leadEnv('escalate') },
      runs: { 'directed-gate': { ok: false, output: RED() } },
    })],
    ['reviewer', CTX, 'reviewer', () => fakeIo({
      emit: true,
      envelopes: {
        'planner:1': planEnv(), 'builder:1': buildEnv(),
        'reviewer:1': { ...reviewEnv('pass'), assignment_id: 'stale-reviewer' }, 'reviewer:2': reviewEnv('pass'),
      },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'],
    })],
    ['review-only', { ...CTX, variant: 'review_only', roles: ['reviewer'], seatedRoles: ['reviewer'] }, 'reviewer', () => fakeIo({
      emit: true, envelopes: { 'reviewer:1': reviewEnv('pass') },
    })],
    ['verify-only', { ...CTX, variant: 'verify_only', roles: ['reviewer'], seatedRoles: ['reviewer'] }, 'reviewer', () => fakeIo({
      emit: true, envelopes: { 'reviewer:1': reviewEnv('pass') },
    })],
  ]
  for (const [label, ctx, role, makeIo] of cases) {
    const io = makeIo()
    const result = driveTask(ctx, io)
    const refusalRows = io.calls.logs.filter((row) => Object.hasOwn(row, 'envelope_refused'))
    assert.equal(refusalRows.length, 1, label)
    assert.equal(io.calls.emits.filter((event) => event.kind === 'cell-failure').length, 1, label)
    assert.equal(io.calls.emits.find((event) => event.kind === 'cell-failure').stage, 'envelope-refusal', label)
    assert.doesNotMatch(result.summary, /the driver crashed/, label)
    assert.doesNotMatch(result.details.escalation?.why || '', /the driver crashed/, label)
    if (result.details.escalation) assert.notEqual(result.details.escalation.where, role, label)
    const dispatch = io.calls.assign.find((entry) => entry.role === role)
    const terminal = io.calls.emits.filter((event) => event.kind === 'envelope' && event.id === `${role}1`)
    assert.deepEqual(terminal, [{ kind: 'envelope', id: `${role}1`, role, status: 'insufficient' }], label)
    assert.equal(Object.hasOwn(terminal[0], 'review'), false, label)
    assert.equal(dispatch?.role, role, label)
  }
})

test('B1 refusal record reports found operand', () => {
  const cases = [
    ['assignment_id', { assignment_id: 'd-old', role: 'planner', run_id: 'run-1', status: 'done' }, 'd-old'],
    ['role', { assignment_id: 'd1', role: 'reviewer', run_id: 'run-1', status: 'done' }, 'reviewer'],
    ['run_id', { assignment_id: 'd1', role: 'planner', run_id: 'run-old', status: 'done' }, 'run-old'],
    ['status', { assignment_id: 'd1', role: 'planner', run_id: 'run-1', status: null }, null],
  ]
  for (const [field, envelope, found] of cases) {
    const { io } = identityFixture(envelope)
    driveTask({ ...CTX, variant: 'scout', run_id: 'run-1', roles: ['planner'], seatedRoles: ['planner'] }, io)
    const row = io.calls.logs.find((entry) => entry.envelope_refused)?.envelope_refused
    assert.equal(row?.field, field, field)
    assert.deepEqual(row?.found, found, field)
  }
})

test('B2 refusal record reports expected operand', () => {
  const cases = [
    ['assignment_id', { assignment_id: 'd-old', role: 'planner', run_id: 'run-1', status: 'done' }, 'd1'],
    ['role', { assignment_id: 'd1', role: 'reviewer', run_id: 'run-1', status: 'done' }, 'planner'],
    ['run_id', { assignment_id: 'd1', role: 'planner', run_id: 'run-old', status: 'done' }, 'run-1'],
    ['status', { assignment_id: 'd1', role: 'planner', run_id: 'run-1', status: null }, 'string'],
  ]
  for (const [field, envelope, expected] of cases) {
    const { io } = identityFixture(envelope)
    driveTask({ ...CTX, variant: 'scout', run_id: 'run-1', roles: ['planner'], seatedRoles: ['planner'] }, io)
    const row = io.calls.logs.find((entry) => entry.envelope_refused)?.envelope_refused
    assert.equal(row?.field, field, field)
    assert.deepEqual(row?.expected, expected, field)
    assert.equal(row?.found_assignment_id, envelope.assignment_id, field)
    assert.equal(row?.expected_assignment_id, 'd1', field)
  }
})

test('C1 genuine replay remains refused as run-mismatch', () => {
  const foreign = {
    assignment_id: 'd1', role: 'reviewer', run_id: 'run-old', status: 'done', summary: 'foreign review',
    artifacts: ['/tmp/foreign-review.md'], details: {
      base: 'base', head: 'head', outcome: 'findings',
      findings: [{ id: 'foreign', severity: 'must-fix', location: 'a.mjs:1', summary: 'foreign finding', evidence: 'foreign evidence', disposition: 'ask-user' }],
    },
  }
  const { io, ctx } = identityFixture(foreign, { variant: 'review_only', role: 'reviewer' })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.logs.filter((row) => row.review_outcome).length, 0)
  assert.equal(io.calls.logs.filter((row) => row.review_findings_note).length, 0)
  assert.equal(result.details.accept_findings, null)
  assert.equal(io.calls.logs.filter((row) => row.envelope_refused).length, 1)
  assert.equal(io.calls.logs.find((row) => row.envelope_refused).envelope_refused.reason, 'run-mismatch')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'envelope'), [{ kind: 'envelope', id: 'd1', role: 'reviewer', status: 'insufficient' }])
})

test('D1 anti-replay refusal reasons remain a frozen closed four', () => {
  assert.equal(Object.isFrozen(ANTI_REPLAY_REFUSAL_REASONS), true)
  assert.deepEqual([...ANTI_REPLAY_REFUSAL_REASONS], ['assignment-id-mismatch', 'role-mismatch', 'run-mismatch', 'status-kind'])
})

test('E1 transposed run id is diagnosable from refusal output', () => {
  const { io, ctx } = identityFixture({ assignment_id: 'd1', role: 'planner', run_id: 'run-ba', status: 'done' }, { runId: 'run-ab' })
  const result = driveTask(ctx, io)
  const row = io.calls.logs.find((entry) => entry.envelope_refused)?.envelope_refused
  assert.equal(row.reason, 'run-mismatch')
  assert.equal(row.expected, 'run-ab')
  assert.equal(row.found, 'run-ba')
  assert.match(result.summary, /run-ab/)
  assert.match(result.summary, /run-ba/)
})

test('F1 complete transport rpc-no-envelope carrier is admitted', () => {
  for (const detail of [
    { reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null },
    { reason: 'no-envelope', turns: 4, tool_calls: 0, absent_reason: null },
    { reason: 'no-envelope', turns: null, tool_calls: null, absent_reason: 'census-unavailable' },
  ]) {
    const { io, ctx } = identityFixture(rpcNoEnvelope(detail))
    const result = driveTask(ctx, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scout')
    assert.equal(io.calls.logs.filter((row) => row.envelope_refused).length, 0)
    assert.match(result.details.escalation.why, /rpc fallback/)
  }
})

test('G1 matching top-level run id is admitted', () => {
  const { io, ctx } = identityFixture({ ...reconEnv(), assignment_id: 'd1', role: 'planner', run_id: 'run-1' })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.logs.filter((row) => row.envelope_refused).length, 0)
  assert.doesNotMatch(result.summary, /run-mismatch/)
})

test('H1 strict identity refusal precedes turn ceiling', () => {
  const envelope = { role: 'reviewer', run_id: 'run-1', status: 'done', summary: 'review', artifacts: [], details: {} }
  const { io, ctx } = identityFixture(envelope, { variant: 'review_only', role: 'reviewer' })
  const result = driveTask({ ...ctx, turnCeilings: { reviewer: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'envelope')
  assert.equal(io.calls.logs.filter((row) => row.envelope_refused).length, 1)
  assert.equal(io.calls.logs.filter((row) => row.seat_turn_ceiling).length, 0)
  assert.equal(io.calls.logs.find((row) => row.envelope_refused).envelope_refused.reason, 'assignment-id-mismatch')
})

test('I1 handled refusal emits a sanitized lifecycle close', () => {
  const { io, ctx } = identityFixture({ assignment_id: 'stale', role: 'planner', status: 'done', summary: 'stale', artifacts: [], details: {} })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'escalation')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'envelope'), [{ kind: 'envelope', id: 'd1', role: 'planner', status: 'insufficient' }])
  assert.equal(Object.hasOwn(io.calls.emits.find((event) => event.kind === 'envelope'), 'review'), false)
})

test('K1 malformed transport rpc-no-envelope lookalikes remain refused', () => {
  const cases = [
    ['done status', rpcNoEnvelope({ reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null }, { status: 'done' }), 'run-mismatch'],
    ['nonempty artifacts', rpcNoEnvelope({ reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null }, { artifacts: ['/tmp/not-empty'] }), 'run-mismatch'],
    ['malformed reason', rpcNoEnvelope({ reason: 'other', turns: 0, tool_calls: 0, absent_reason: null }), 'run-mismatch'],
    ['malformed census', rpcNoEnvelope({ reason: 'no-envelope', turns: '4', tool_calls: 0, absent_reason: null }), 'run-mismatch'],
    ['malformed absence', rpcNoEnvelope({ reason: 'no-envelope', turns: null, tool_calls: null, absent_reason: null }), 'run-mismatch'],
    ['assignment precedence', rpcNoEnvelope({ reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null }, { assignment_id: 'other' }), 'assignment-id-mismatch'],
    ['role precedence', rpcNoEnvelope({ reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null }, { role: 'other' }), 'role-mismatch'],
    ['foreign run', rpcNoEnvelope({ reason: 'zero-turn-non-start', turns: 0, tool_calls: 0, absent_reason: null }, { run_id: 'run-old' }), 'run-mismatch'],
  ]
  for (const [label, envelope, reason] of cases) {
    const { io, ctx } = identityFixture(envelope)
    const result = driveTask(ctx, io)
    const rows = io.calls.logs.filter((entry) => entry.envelope_refused)
    assert.equal(result.status, 'escalation', label)
    assert.equal(rows.length, 1, label)
    assert.equal(rows[0].envelope_refused.reason, reason, label)
  }
})

test('a null envelope is not double-counted by the driver', () => {
  const io = fakeIo({ emit: true, envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.why, 'planner: no valid envelope at planner:1 within 1800s')
  assert.equal(io.calls.emits.filter((event) => event.kind === 'cell-failure').length, 0)
  assert.equal(io.calls.logs.filter((row) => Object.hasOwn(row, 'envelope_refused')).length, 0)
})

test('empty refutation evidence fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-1', evidence: '   ' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*empty refutation evidence/)
})

test('red full suite after review pass escalates and preserves its commit', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'boom' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.commit, 'abc1234')
  assert.match(res.details.escalation.why, /suite red/i)
})

test('E1 suite red records test-file context and bounces once', () => {
  const failureIndexes = [2610, 2620, 4480]
  const suiteLines = []
  for (let index = 0; index < 4500; index += 1) {
    if (index === failureIndexes[0]) suiteLines.push('✖ EARLY_FAILURE expected alpha, found beta')
    else if (index === failureIndexes[1]) suiteLines.push('FAIL MID_FAILURE expected epsilon, found zeta')
    else if (index === failureIndexes[2]) suiteLines.push(`not ok LATE_FAILURE file://${CTX.checkout}/new.test.mjs:9:2 expected gamma, found delta`)
    else suiteLines.push(`✔ CONTEXT_${String(index).padStart(4, '0')} passing test ${'p'.repeat(92)}`)
  }
  const red = suiteLines.join('\n')
  const retained = new Set()
  for (const index of failureIndexes) {
    for (let candidate = Math.max(0, index - 2); candidate <= Math.min(suiteLines.length - 1, index + 2); candidate += 1) retained.add(candidate)
  }
  const retainedIndexes = [...retained].sort((a, b) => a - b)
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'builder:2': buildEnv({ details: { files_changed: ['new.test.mjs'], commit_message: 'repair' } }),
      'reviewer:1': reviewEnv('pass'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd:1': { ok: false, output: red }, 'suite-cmd:2': { ok: true, output: 'PASS new.test.mjs' } },
    changed: [['a.mjs', 'a.test.mjs'], ['new.test.mjs']],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(Buffer.byteLength(red) >= 450000, true)
  assert.equal(suiteLines.length, 4500)
  assert.equal(retainedIndexes.length, 15)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.equal(io.calls.logs.filter((row) => row.scope_admission?.source === 'suite-red').length, 1)
  const row = io.calls.logs.find((entry) => entry.scope_admission?.source === 'suite-red').scope_admission
  assert.deepEqual(row.files, ['new.test.mjs'])
  assert.deepEqual(row.evidence, { output: red, commit: 'abc1234', test_files: ['new.test.mjs'] })
  assert.ok(io.calls.assign.find(({ role, n, policy }) => role === 'builder' && n === 2 && policy.fence.includes('new.test.mjs')))
  const bounce = io.calls.writes[`${TD}/suite-red-bounce-r1.md`]
  assert.equal(Buffer.byteLength(bounce) < 20000, true)
  for (const index of retainedIndexes) assert.ok(bounce.includes(suiteLines[index]), `missing retained suite line ${index}`)
  assert.equal(bounce.includes(suiteLines[100]), false)
  assert.ok(bounce.includes('Failure excerpts (all failing lines with 2 lines of context):'))
  assert.ok(bounce.includes(`Elided 4485 of 4500 suite output lines; full output remains in ${TD}/journal.jsonl.`))
  assert.deepEqual(suiteRedTestFiles(red, CTX.checkout), ['new.test.mjs'])
})


test('D1 suite red with no safe admission escalates exact trailing output', () => {
  const output = `${'unparseable-suite-noise\n'.repeat(180)}unsafe-end`
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(Buffer.byteLength(output) > 3000, true)
  assert.equal(res.details.escalation.where, 'suite')
  const expected = `full suite red after acceptance — no safe test-file context record could be made: scope admission requires a non-empty files array\n${output.slice(-2000)}`
  assert.equal(res.details.escalation.why, expected)
  assert.equal(io.calls.logs.filter((entry) => entry.scope_admission).length, 0)
})

test('C1 repeated suite red uses remaining build rounds then exhausts the global budget', () => {
  const first = `FAIL ${CTX.checkout}/new.test.mjs:1\nfirst`
  const second = `FAIL ${CTX.checkout}/other.test.mjs:2\nsecond`
  const third = `FAIL ${CTX.checkout}/last.test.mjs:3\nthird`
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'builder:2': buildEnv({ details: { files_changed: ['new.test.mjs'], commit_message: 'repair new' } }),
      'builder:3': buildEnv({ details: { files_changed: ['other.test.mjs'], commit_message: 'repair other' } }),
      'reviewer:1': reviewEnv('pass'), 'reviewer:2': reviewEnv('pass'), 'reviewer:3': reviewEnv('pass'),
    },
    runs: {
      'lane-cmd': { ok: true, output: '' },
      'suite-cmd:1': { ok: false, output: first }, 'suite-cmd:2': { ok: false, output: second }, 'suite-cmd:3': { ok: false, output: third },
    },
    changed: [['a.mjs', 'a.test.mjs'], ['new.test.mjs'], ['other.test.mjs']],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'suite')
  assert.match(res.details.escalation.why, /global builder budget is exhausted after 3 attempt/)
  assert.deepEqual(io.calls.logs.filter((entry) => entry.scope_admission?.source === 'suite-red').map((entry) => entry.scope_admission.files), [
    ['new.test.mjs'], ['other.test.mjs'], ['last.test.mjs'],
  ])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 3)
  assert.equal(io.calls.assign.some(({ role, n }) => role === 'builder' && n === 4), false)
})



test('C1 census repair coupling is one declared existing-file unit', () => {
  assert.equal(Object.isFrozen(RUNTIME_CENSUS_CARRIER_FILES), true)
  assert.equal(Object.isFrozen(DISPATCH_CENSUS_CARRIER_FILES), true)
  assert.deepEqual([...RUNTIME_CENSUS_CARRIER_FILES].sort(), [...DISPATCH_CENSUS_CARRIER_FILES].sort())
  assert.equal(RUNTIME_CENSUS_CARRIER_FILES.length, 2)
  assert.equal(new Set(RUNTIME_CENSUS_CARRIER_FILES).size, 2)
  for (const file of RUNTIME_CENSUS_CARRIER_FILES) assert.equal(existsSync(join(REPO_ROOT, file)), true, file)
})

test('D1 builder scope request is admitted and journalled with role and stage', () => {
  const evidence = { kind: 'builder-request', output: 'generated.mjs is required' }
  const request = { scope_request: { kind: 'admit-files', files: ['generated.mjs'] }, evidence }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv({ details: { files_changed: ['generated.mjs'], commit_message: 'repair' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = io.calls.logs.filter((entry) => entry.scope_admission).map((entry) => entry.scope_admission)
  assert.equal(row.length, 1)
  assert.deepEqual(row[0], { source: 'seat-request', files: ['generated.mjs'], evidence, role: 'builder', stage: 'build:r1' })
  assert.ok(io.calls.assign.find(({ role, n, policy }) => role === 'builder' && n === 2 && policy.fence.includes('generated.mjs')))
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`], /generated\.mjs/)
})

test('E1 seat scope request for a held file is recorded and replayed', () => {
  const evidence = { kind: 'need', output: 'held.mjs' }
  const request = { scope_request: { kind: 'admit-files', files: ['held.mjs'] }, evidence }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv({ details: { files_changed: ['held.mjs'], commit_message: 'repair held file' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [['held.mjs']],
  })
  const res = driveTask({ ...CTX, laneFence: [{ lane: 'sibling', files: ['held.mjs'] }] }, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.logs.find((entry) => entry.scope_admission)?.scope_admission, {
    source: 'seat-request', files: ['held.mjs'], evidence, role: 'builder', stage: 'build:r1',
  })
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.ok(io.calls.assign.find(({ role, n, policy }) => role === 'builder' && n === 2 && policy.fence.includes('held.mjs')))
})

test('F1 scope request kind is a closed enum', () => {
  assert.deepEqual(SCOPE_REQUEST_KINDS, ['admit-files'])
  assert.ok(Object.isFrozen(SCOPE_REQUEST_KINDS))
  assert.deepEqual(SCOPE_ADMISSION_SOURCES, ['suite-red', 'seat-request'])
  assert.ok(Object.isFrozen(SCOPE_ADMISSION_SOURCES))
  for (const kind of SCOPE_REQUEST_KINDS) {
    assert.deepEqual(scopeRequestOf({ scope_request: { kind, files: ['requested.mjs'] } }), { kind, files: ['requested.mjs'] })
  }
  const unknown = scopeRequestOf({ scope_request: { kind: 'free-text', files: ['requested.mjs'] } })
  assert.equal(unknown.refusal, 'scope-request')
  for (const file of ['src/lib/', '*.mjs', '/tmp/requested.mjs', '../requested.mjs', 'requested.mjs:1-2', 42]) {
    assert.equal(scopeRequestOf({ scope_request: { kind: 'admit-files', files: [file] } }).refusal, 'scope-request')
  }
  assert.equal(scopeAdmissionDecision({ source: 'free-text', files: ['requested.mjs'], evidence: {} }).action, 'escalate')
  assert.equal(scopeRequestOf({ summary: 'scope_request { kind: admit-files, files: [requested.mjs] }', guidance: 'admit requested.mjs' }), null)
})

test('G1 scope admission requires and journals evidence', () => {
  assert.equal(scopeAdmissionDecision({ source: 'seat-request', files: ['requested.mjs'], evidence: null, laneFence: [] }).reason, 'evidence')
  assert.equal(scopeAdmissionDecision({ source: 'seat-request', files: ['requested.mjs'], evidence: [], laneFence: [] }).reason, 'evidence')
  const evidence = { kind: 'builder-request', output: 'requested.mjs' }
  const request = { scope_request: { kind: 'admit-files', files: ['requested.mjs'] }, evidence }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv({ details: { files_changed: ['requested.mjs'], commit_message: 'repair' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = io.calls.logs.find((entry) => entry.scope_admission)?.scope_admission
  assert.deepEqual(row.evidence, evidence)
  assert.equal(row.source, 'seat-request')
})

test('H1 scope gate records ordinary writes outside declared context', () => {
  const request = { scope_request: { kind: 'admit-files', files: ['admitted.mjs'] }, evidence: { kind: 'builder-request', output: 'admitted.mjs' } }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv({ details: { files_changed: ['admitted.mjs', 'rogue.mjs'], commit_message: 'repair' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [['admitted.mjs', 'rogue.mjs']],
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(res.status, 'done')
  const scopeGate = io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate
  assert.equal(scopeGate.reason, null)
  assert.deepEqual(scopeGate.edits, ['rogue.mjs'])
  assert.equal(io.calls.logs.filter((entry) => entry.scope_admission).length, 1)
})

test('I1 lead two-file widening replay admits both unheld files', () => {
  const request = { scope_request: { kind: 'admit-files', files: ['one.mjs', 'two.mjs'] }, evidence: { kind: 'lead-request', output: 'both files are needed' } }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'the build needs a wider test surface', details: {} }),
      'lead:1': { status: 'done', role: 'lead', summary: 'bounce builder', details: { decision: 'bounce', guidance: 'repair both files', ...request } },
      'builder:2': buildEnv({ details: { files_changed: ['one.mjs', 'two.mjs'], commit_message: 'repair' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  const next = io.calls.assign.find(({ role, n }) => role === 'builder' && n === 2)
  assert.ok(next)
  assert.ok(next.policy.fence.includes('one.mjs'))
  assert.ok(next.policy.fence.includes('two.mjs'))
  const row = io.calls.logs.find((entry) => entry.scope_admission)?.scope_admission
  assert.equal(row.role, 'lead')
  assert.deepEqual(row.files, ['one.mjs', 'two.mjs'])
})

test('RV1-1 stack-frame suite paths stay checkout-contained and are recorded as context', () => {
  const heldFrame = `  at x (${CTX.checkout}/crew/headless.test.mjs:88:5)`
  const heldFiles = suiteRedTestFiles(heldFrame, CTX.checkout)
  assert.deepEqual(heldFiles, ['crew/headless.test.mjs'])
  const held = scopeAdmissionDecision({
    source: 'suite-red', files: heldFiles, evidence: { output: heldFrame },
    laneFence: [{ lane: 'sibling', files: ['crew/headless.test.mjs'] }],
  })
  assert.deepEqual(held, { action: 'admit', source: 'suite-red', files: heldFiles, evidence: { output: heldFrame } })
  const outsideFrame = '  at x (/somewhere/else/crew/headless.test.mjs:1:1)'
  assert.deepEqual(suiteRedTestFiles(outsideFrame, CTX.checkout), [])
})

test('RV2-2 a protected scope request still requires the sensitivity floor', () => {
  const protectedFile = 'crew/roster.json'
  assert.ok(PROTECTED_PATHS.includes(protectedFile))
  const evidence = { kind: 'builder-request', output: `${protectedFile} is needed` }
  const request = { scope_request: { kind: 'admit-files', files: [protectedFile] }, evidence }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv({ details: { files_changed: [protectedFile], commit_message: 'repair protected file' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [[protectedFile]],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'sensitivity-floor')
  assert.match(res.details.escalation.why, /crew\/roster\.json/)
  assert.deepEqual(io.calls.logs.find((entry) => entry.scope_admission)?.scope_admission, {
    source: 'seat-request', files: [protectedFile], evidence, role: 'builder', stage: 'build:r1',
  })
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.ok(io.calls.assign.find(({ role, n, policy }) => role === 'builder' && n === 2 && policy.fence.includes(protectedFile)))
  assert.equal(io.calls.assign.some(({ role }) => role === 'reviewer'), false)
})

test('a seat request already in context is recorded without adding a path', () => {
  const evidence = { kind: 'builder-request', output: 'a.mjs is needed' }
  const request = { scope_request: { kind: 'admit-files', files: ['a.mjs'] }, evidence }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv({ details: { ...request, files_changed: [] } }),
      'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.logs.find((entry) => entry.scope_admission)?.scope_admission, {
    source: 'seat-request', files: [], evidence, role: 'builder', stage: 'build:r1',
  })
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
})

test('a non-done lead scope request cannot mutate effective scope', () => {
  const request = {
    scope_request: { kind: 'admit-files', files: ['lead-requested.mjs'] },
    evidence: { kind: 'lead-request', output: 'lead-requested.mjs is needed' },
  }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'need lead help', details: {} }),
      'lead:1': { status: 'insufficient', role: 'lead', summary: 'cannot decide', details: { decision: 'bounce', ...request } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'build')
  assert.match(res.details.escalation.why, /lead returned insufficient\/bounce/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(io.calls.logs.filter((entry) => entry.scope_admission).length, 0)
})

test('a composed gate wrapper installs no signal trap', () => {
  const dir = scratchDir('b127-gate-signal-free-')
  try {
    const wrapped = gateReapCommand({ cmd: 'true', ...b127GatePaths(dir) })
    assert.doesNotMatch(wrapped, /\btrap\b/)
    assert.doesNotMatch(wrapped, /__crew_forward_signal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the wrapped gate command sees the same shell contract as the bare runner', () => {
  const probe = 'echo "0=$0 #=$# 1=${1-UNSET}"'
  const bare = spawnSync('/bin/sh', ['-c', probe], { encoding: 'utf8' })
  for (const shell of ['/bin/bash', '/path/that/does/not/exist']) {
    const run = b127InvokeGate({ cmd: probe, overrides: { shell } })
    assert.equal(run.stdout, String(bare.stdout))
    assert.equal(run.status, bare.status)
    const bareReturn = spawnSync('/bin/sh', ['-c', 'return 0'], { encoding: 'utf8' })
    const wrappedReturn = b127InvokeGate({ cmd: 'return 0', overrides: { shell } })
    assert.equal(wrappedReturn.status, bareReturn.status)
  }
})

test('gate reap guards the driver group before any signal', () => {
  const dir = scratchDir('b127-gate-guard-')
  try {
    const lines = gateReapCommand({ cmd: 'true', ...b127GatePaths(dir) }).split('\n')
    const guardAt = lines.findIndex((line) => line.includes('"$__crew_self"') && line.includes(')'))
    const killAt = lines.findIndex((line) => /(^|\s)\$__crew_kill\s/.test(line))
    assert.ok(guardAt >= 0)
    assert.ok(killAt >= 0)
    assert.ok(guardAt < killAt)
    assert.match(lines[guardAt], /unproven/)
    assert.match(lines[guardAt], /root-unidentified/)
    assert.doesNotMatch(lines[guardAt], /\$__crew_kill\s/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a happy path without a gate does not measure runClean', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate, null)
  assert.equal(io.calls.runClean.length, 0)
})

test('B1 gate doctrine states both accepted FAIL label forms', () => {
  const source = readFileSync(new URL('../skills/qa-test-writing/references/gates.md', import.meta.url), 'utf8')
  assert.match(source, /A failing check must print `FAIL <label>` ending the line, or `FAIL <label>: <why>`\. Nothing else matches\./)
  assert.match(source, /strict separator prevents a shorter check label from falsely matching a longer prefix label/)
})

test('E1 checkFailureLine retains its strict delimiter behavior', () => {
  assert.equal(checkFailureLine(`FAIL check-one: why\n${RED()}`, 'check-one'), true)
  assert.equal(checkFailureLine('  FAIL check-one', 'check-one'), true)
  assert.equal(checkFailureLine('FAIL check-one:', 'check-one'), true)
  assert.equal(checkFailureLine('FAIL cache', 'cache'), true)
  assert.equal(checkFailureLine('FAIL cache-v2', 'cache'), false)
  assert.equal(checkFailureLine('FAIL cache:v2: why', 'cache'), false)
  assert.equal(checkFailureLine('FAIL cache:v2: why', 'cache:v2'), true)
  for (const output of ['FAIL check-one extra words', 'FAIL check-one — why', 'FAIL check-one why', 'FAIL check-one warm: reason', 'FAIL check-one:v2: reason', 'FAIL check-one-two: why', 'PASS check-one', 'prose check-one', '']) {
    assert.equal(checkFailureLine(output, 'check-one'), false, output)
  }
})

test('an apply failure before landing is unproven and leaves no checkout write', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, throwOn: 'apply', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.deepEqual(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).map(({ content }) => content), [CHECK_BUILT])
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination')[0].verdict, 'unproven')
})

test('a null io failure is still an unproven per-check pass, never a proven one', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  io.readFile = () => { throw null }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.match(res.details.gate.check_proof_note, /null/)
})

test('a longer sibling failure is not the intended check failure', () => {
  const output = `PASS cache\nFAIL cache:v2: reason\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":2,"errored":0}`
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([{ ...CHECK_MUTATION, check: 'cache' }], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }),
    runs: { ...CHECK_RUNS(output), 'gate-cmd:3': { ok: false, output } }, changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'check-discrimination')
  assert.equal(event?.checks?.[0]?.outcome, 'survived')
  assert.match(event?.checks?.[0]?.why, /printed no "FAIL cache" line/)
  assert.equal(res.status, 'escalation')
})

test('the whole-gate discrimination event retains its five-field shape beside per-check evidence', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'discrimination')
  assert.equal(Object.keys(event).sort().join(','), 'generation,kind,note,summary,verdict')
})

test('the per-check repair brief names the surviving check and keeps identifiers stable', () => {
  const output = `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }),
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: output }, 'gate-cmd:3': { ok: true, output }, 'gate-cmd:4': { ok: true, output }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const brief = io.calls.writes[`${TD}/gate-discrimination-bounce.md`]
  assert.match(brief, /CHECK IDENTIFIERS STABLE/)
  assert.match(brief, /check-one/)
})

test('parseGateSummary: last line wins, and anything malformed reads as ABSENT', () => {
  assert.deepEqual(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":0}`), { total: 3, failed: 3, errored: 0 })
  // A gate that prints twice (an internal re-run): the final line describes the run.
  assert.deepEqual(
    parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":1,"failed":1,"errored":0}\n${GATE_SUMMARY_PREFIX} {"total":9,"failed":2,"errored":1}`),
    { total: 9, failed: 2, errored: 1 },
  )
  assert.equal(parseGateSummary('nothing here'), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} not-json`), null)
  // Absent, NEVER a zero-errored pass: an unparseable summary is not evidence.
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3}`), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":-1}`), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":1.5,"failed":1,"errored":0}`), null)
})

test('baselineGateDefect: names the three ways a non-zero exit is not proof of red', () => {
  assert.equal(baselineGateDefect(RED()), null)
  assert.match(baselineGateDefect('red, no summary'), /printed no GATE-SUMMARY/)
  assert.match(baselineGateDefect(THREW), /1 of 47 checks THREW/)
  assert.match(baselineGateDefect(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`), /contradicts the non-zero exit/)
})

test('no gate_cmd in the plan -> the loop runs exactly as before (gate stage never appears)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate, null)
  assert.ok(!res.details.stages.some((s) => /^gate/.test(s)))
})

test('every stage transition reaches io.status in order (the live pill feed)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.status, res.details.stages)
})

// --- plan viewer (io.showDoc) -------------------------------------------------

test('an io without showDoc drives an identical loop (the additive pin)', () => {
  const mk = (showDoc) => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc,
  })
  const withoutDoc = driveTask(CTX, mk(false))
  const withDoc = driveTask(CTX, mk(true))
  assert.equal(withoutDoc.status, 'done')
  assert.equal(withDoc.status, 'done')
  assert.deepEqual(withoutDoc.details.stages, withDoc.details.stages)
})

// --- loop-boundary regressions (the "final-round bounce commits" class) ------
// A granted bounce must always land in a REAL round; the finish block runs
// only via review:pass or an explicit lead accept. These pin the fix for the
// class where lane-red/gate-red/builder-insufficient work reached commit.

test('an envelope with a MISMATCHED assignment_id is rejected (stale-file replay guard)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ assignment_id: 'd9-from-a-previous-run' }), 'lead:1': leadEnv('escalate') },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.match(res.details.escalation.why, /envelope-refusal: assignment-id-mismatch/)
})

test('escalation artifacts and exhaustion briefs cite the REAL journal path from ctx', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': leadEnv('escalate') },
  })
  const res = driveTask({ ...CTX, journal: '/real/crew/journal.jsonl' }, io)
  assert.equal(res.status, 'escalation')
  assert.ok(res.artifacts.includes('/real/crew/journal.jsonl'))
  assert.ok(!res.artifacts.some((a) => a === `${TD}/journal.jsonl`))
})

test('lead-less: a planner insufficient escalates naming "no lead seated" and the original question, with zero lead assigns', () => {
  const ctx = { ...CTX, roles: ['planner', 'builder', 'reviewer'] }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }) },
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /no lead seated/)
  assert.match(res.details.escalation.why, /brief ambiguous/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  // an escalation envelope carries no consult count by design (drive.mjs:204-212)
  assert.equal(res.details.consults, undefined)
})

test('lead-less happy path: plan -> build -> gates -> review pass -> suite -> commit, zero lead assigns, consults === 0', () => {
  const ctx = { ...CTX, roles: ['planner', 'builder', 'reviewer'] }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  assert.equal(res.details.consults, 0)
  assert.equal(io.calls.commits.length, 1)
})

test('emit mirrors every stage transition in order', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.deepEqual(io.calls.emits.filter((e) => e.kind === 'stage').map((e) => e.label), res.details.stages)
})

test('a bounce at a diverging round is funded by the rounds that remain, not by a grant', () => {
  const { io, result } = divergentPlanScenario('bounce')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 3)
  assert.deepEqual(result.details.extra_rounds_granted, [])
})

test('the per-point bound still holds at each point', () => {
  const { io, result } = bothExhaustionPointsScenario('bounce')
  assert.equal(result.status, 'escalation')
  assert.deepEqual(result.details.extra_rounds_granted, [
    { where: 'plan-check', round: 2 }, { where: 'review', round: 3 },
  ])
  assert.doesNotMatch(io.calls.writes[`${TD}/decision-3.md`], /^- bounce$/m)
})

test('a run that exhausts nothing and diverges on nothing is unchanged', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.deepEqual(result, HEALTHY_RESULT)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(io.calls.commits.length, 1)
})

test('an omitted gate_path journals an explicit null rejection value', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': adversarialPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX_TL, io).status, 'done')
  const rejection = io.calls.logs.find((line) => Object.hasOwn(line, 'gate_path_rejected'))
  assert.ok(rejection)
  assert.equal(rejection.gate_path_rejected, null)
  assert.deepEqual(JSON.parse(JSON.stringify(rejection)), { at: 0, gate_path_rejected: null, channel: 'record' })
})

test('b382 A2 the release-gate full suite takes and gives back a suite slot', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'suite-warm', 'run:suite-cmd')
})

test('b382 A3 the cold verification suite takes and gives back a suite slot', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'suite-cold', 'runCold:suite-cmd')
})

test('b382 A4 the converge full suite takes and gives back a suite slot', () => {
  const { io, result } = convergeRun({
    ctx: slotCtx({ ...CONVERGE_CTX, env: { CREW_SUITE_SLOTS: '4' } }),
    slots: slotFactory(),
  })
  assert.equal(result.status, 'converge')
  phaseTrace(io.calls, 'suite-warm', 'run:suite-cmd')
})

test('b382 B1 a cold suite that throws releases its slot before escalating', () => {
  const io = closeoutIo({ cold: 'throw', slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.details.escalation.where, 'cold-suite')
  const event = phaseTrace(io.calls, 'suite-cold', 'runCold:suite-cmd')
  assert.ok(event.releaseIndex < io.calls.trace.length)
})

test('b382 B2 a wait-row failure releases the acquired slot before the driver escalates', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const originalLog = io.log
  let rowFailure = false
  io.log = function (row) {
    if (!rowFailure && row?.event === PHASE_SLOT_WAIT_EVENT) {
      rowFailure = true
      throw new Error('phase-slot wait journal write failed')
    }
    return originalLog.call(this, row)
  }
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'driver')
  assert.match(result.details.escalation.why, /phase-slot wait journal write failed/)
  const acquire = io.calls.trace.find((entry) => entry?.label === 'acquire:suite-warm' && entry.handle)
  assert.ok(acquire)
  assert.ok(io.calls.trace.some((entry) => entry?.label === `release:${acquire.handle.slot}`))
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('b382 C1 the admission row names the phase that waited', () => {
  for (const phase of SUITE_SLOT_PHASE_NAMES) {
    const { rows } = directSlotRun({ phase })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, phase)
  }
})

test('b382 C2 the admission row carries the occupancy the last scan measured', () => {
  const measured = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [3] })
  assert.equal(measured.rows[0].queue_depth, 3)
  const unknown = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [null] })
  assert.equal(unknown.rows[0].queue_depth, null)
  assert.notEqual(unknown.rows[0].queue_depth, 0)
})

test('b382 C3 the admission row carries the measured waited_ms', () => {
  let clock = 0
  const { rows } = directSlotRun({
    phase: SUITE_SLOT_PHASES.warm, refusals: [3],
    now: () => { clock += 2000; return clock },
  })
  assert.equal(rows[0].waited_ms, 8000)
})

test('b382 D1 a queued phase keeps emitting liveness heartbeats while it waits', () => {
  const beats = []
  const { rows } = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [1, 2], emit: (event) => beats.push(event) })
  assert.equal(rows.length, 1)
  assert.equal(beats.length, 2)
  assert.ok(beats.every((event) => event.kind === 'heartbeat' && Number.isFinite(event.at)))
})

test('b382 E1 an unconfigured capacity still queues at the core-derived capacity', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: {} }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 1)
  assert.equal(io.calls.slotFactories[0].capacity, Math.max(2, Math.floor(osCpus().length / 6)))
  assert.equal(io.calls.slotFactories[0].kind, 'suite')
  assert.ok(io.calls.trace.some((entry) => entry?.label?.startsWith('acquire:')))
})

test('b382 E2 a zero capacity run behaves exactly as the pre-feature driver', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: '0' } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 0)
  assert.equal(io.calls.logs.some((row) => row.event === PHASE_SLOT_WAIT_EVENT), false)
  assert.deepEqual(result, ZERO_CAPACITY_RESULT)
  const logs = normaliseJournalTimes(io.calls.logs)
  assert.deepEqual(logs.filter((row) => !row.scope_gate), ZERO_CAPACITY_LOGS)
  assert.equal(logs.some((row) => row.scope_gate), false)
  assert.deepEqual(io.calls.trace, ['run:lane-cmd', 'run:suite-cmd', 'runCold:suite-cmd'])
})

test('b382 R1 the driver leases from the dispatcher\'s relocated factory root', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: '4', DEVTEAM_LEDGER_DIR: '/tmp/b382-relocated-factory' } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 1)
  assert.equal(io.calls.slotFactories[0].dir, '/tmp/b382-relocated-factory')
})

test('b382 S1 an acquire that cannot answer never runs the phase', () => {
  const failure = Object.assign(new Error('slot claim unavailable'), { stage: 'slot-claim-unresolvable' })
  const io = closeoutIo({ slots: slotFactory({ throwOnAcquire: failure }) })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'slot-claim-unresolvable')
  assert.match(result.details.escalation.why, /slot claim unavailable/)
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('b382 F1 a run that only takes model turns acquires no suite slot', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null }, slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.slotFactories.length, 0)
  assert.equal(io.calls.trace.filter((entry) => entry?.label?.startsWith('acquire:')).length, 0)
})

test('slot pool construction that throws never runs the phase', () => {
  const failure = new Error('slot pool construction failed')
  const io = closeoutIo({ slots: () => { throw failure } })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /slot pool construction failed/)
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('a malformed CREW_SUITE_SLOTS becomes the driver\'s own escalation', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: 'abc' } }, io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /CREW_SUITE_SLOTS/)
  assert.equal(io.calls.slotFactories.length, 0)
})

test('without the seam the old gate escalation is byte-identical and never runs the suite', () => {
  const { io, result } = convergeRun({ seam: false })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
  assert.deepEqual(io.calls.run.map((run) => run.cmd), ['gate-cmd', 'lane-cmd', 'gate-cmd'])
})

test('a final gate with no summary parks before the seam', () => {
  const io = convergeIo()
  io.run = (cmd) => {
    const count = (io.calls.run.filter((run) => run.cmd === cmd).length || 0) + 1
    io.calls.run.push({ cmd, n: count })
    if (cmd === 'gate-cmd' && count === 2) return { ok: false, output: 'Error: gate crashed' }
    if (cmd === 'gate-cmd') return { ok: false, output: CONVERGE_GATE }
    return cmd === 'lane-cmd' ? { ok: true, output: '' } : { ok: true, output: '' }
  }
  const result = driveTask(CONVERGE_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
})

test('issue filing failure parks before commit', () => {
  const { io, result } = convergeRun({ issueThrows: 'issue filing failed' })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 0)
})

test('repair refuses absent declared sources before assigning a seat', () => {
  const cases = [
    { files_in_scope: undefined },
    { files_in_scope: [] },
    { lane: null },
  ]
  for (const over of cases) {
    const io = fakeIo()
    const result = driveTask({ ...CTX_REPAIR, ...over }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'triage')
    assert.match(result.details.escalation.why, over.lane === null ? /lane/ : /files_in_scope/)
    assert.equal(io.calls.assign.length, 0)
    assert.deepEqual(result.details.stages, ['escalate:triage'])
  }
})

test('repair refuses an unusable inherited scope before assigning a seat', () => {
  const io = fakeIo()
  const result = driveTask({ ...CTX_REPAIR, files_in_scope: ['../x', 'src/*'] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /\.\.\/x/)
  assert.match(result.details.escalation.why, /src\/\*/)
  assert.equal(io.calls.assign.length, 0)
})

test('repair validates the triage product before assigning a builder', () => {
  const cases = [
    triageEnv({ details: {} }),
    triageEnv({ artifacts: ['/tmp/elsewhere/triage.md'], details: { plan_path: '/tmp/elsewhere/triage.md' } }),
    triageEnv({ artifacts: [], details: { plan_path: TRIAGE_NOTE } }),
    triageEnv({ artifacts: [`${TD}/missing.md`], details: { plan_path: `${TD}/missing.md` } }),
    triageEnv({ summary: '   ' }),
    triageEnv({ artifacts: 'not-an-array' }),
  ]
  for (const planner of cases) {
    const io = fakeIo({ envelopes: { 'planner:1': planner }, changed: ['a.mjs'], files: TRIAGE_FILES })
    const result = driveTask(CTX_REPAIR, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'triage')
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
  }
})

test('repair refuses a self-authored acceptance gate', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, gate_cmd: 'node gate.mjs' } }) },
    files: TRIAGE_FILES, changed: ['a.mjs'],
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /gate/)
  assert.deepEqual(io.calls.run, [])
  assert.equal(result.details.stages.some((label) => label.startsWith('gate')), false)
})

test('repair triage is bounded to one planner assignment', () => {
  const io = fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'need more', artifacts: [], details: {} } }, files: TRIAGE_FILES })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.deepEqual(io.calls.assign.map(({ role }) => role), ['planner'])
})

test('repair never reaches gate or converge stages on review exhaustion', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('changes-needed'),
      'lead:1': leadEnv('escalate'),
    },
    changed: ['a.mjs'], files: TRIAGE_FILES, gh: true,
  })
  const result = driveTask({ ...CTX_REPAIR, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.stages.some((label) => label.startsWith('gate') || label.startsWith('converge')), false)
})

test('repair protected scope still fires the sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv() }, files: { [TRIAGE_NOTE]: '# Triage\n' },
    changed: [], reseat: () => ({ reason: 'no-tier' }),
  })
  const result = driveTask({ ...CTX_REPAIR, files_in_scope: ['crew/drive.mjs'] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'sensitivity-floor')
})

test('directed declares no plan, check, gate-repair or gate-reverify stage', () => {
  for (const label of ['plan:r1', 'check:r1', 'gate-repair:1', 'gate-reverify:1']) {
    assert.match(undeclaredStage(VARIANTS.directed, label), /not declared/)
  }
  for (const label of ['directed:r1', 'gate-baseline', 'gate:r1', 'gate-proof:1', 'converge:suite', 'done']) {
    assert.equal(undeclaredStage(VARIANTS.directed, label), null, label)
  }
})

test("the brief's files_in_scope is authoritative over a conflicting ctx scope", () => {
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'directed-gate:1': { ok: false, output: red }, 'directed-gate': { ok: true, output: green },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs', 'rogue.mjs'],
  })
  const result = driveTask({ ...CTX_DIRECTED, files_in_scope: ['a.mjs', 'a.test.mjs', 'rogue.mjs'] }, io)
  assert.equal(result.status, 'done')
  const scopeGate = io.calls.logs.find((line) => line.scope_gate)?.scope_gate
  assert.equal(scopeGate.reason, null)
  assert.deepEqual(scopeGate.edits, ['rogue.mjs'])
  const directed = io.calls.logs.find((line) => line.directed)?.directed
  assert.equal(directed.scope_source, 'brief')
  assert.equal(directed.gate_source, 'brief')
})

test('a directed brief that is not a plan escalates before any seat', () => {
  const block = (value) => ['```directed', value, '```'].join('\n')
  const valid = JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['a.mjs'] })
  const cases = [
    '# no block',
    `${block(valid)}\n${block(valid)}`,
    '```directed\n' + valid,
    block('{ not json'),
    block('[]'),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['a.mjs'], extra: true })),
    block(JSON.stringify({ files_in_scope: ['a.mjs'] })),
    block(JSON.stringify({ gate_cmd: '   ', files_in_scope: ['a.mjs'] })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: [] })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: 'a.mjs' })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['src/*.mjs'] })),
  ]
  for (const text of cases) {
    assert.ok(parseDirectedBrief(text).defect, text)
    const io = fakeIo({ files: { [DIRECTED_BRIEF_PATH]: text } })
    const result = driveTask(CTX_DIRECTED, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'directed')
    assert.equal(io.calls.assign.length, 0)
  }
})

test("a green-at-baseline directed gate escalates and assigns nobody to repair it", () => {
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({ files: DIRECTED_FILES, runs: { 'directed-gate': { ok: true, output: green } } })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.includes('gate-baseline:green-bounce'), false)
  assert.match(result.details.escalation.why, /authored outside the crew by the orchestrator/)
})

test('a directed gate that did not RUN at baseline escalates', () => {
  const io = fakeIo({ files: DIRECTED_FILES, runs: { 'directed-gate': { ok: false, output: 'Error: boom\n' } } })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.includes('gate-baseline:defect-bounce'), false)
})

test('a directed gate that fails its discrimination proof escalates', () => {
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv() },
    runs: {
      'directed-gate:1': { ok: false, output: red }, 'directed-gate': { ok: true, output: green },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'directed-gate': { ok: true, output: green } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.some((label) => label.startsWith('gate-repair') || label.startsWith('gate-reverify')), false)
})

test('the variant-aware attended seat guard accepts a planner-less directed crew', () => {
  assert.deepEqual(VARIANTS.directed.required_seats, ['builder', 'reviewer'])
  assert.doesNotThrow(() => assertSeats({ roles: ['builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'directed'))
  assert.throws(
    () => assertSeats({ roles: ['builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'full'),
    /requires a planner seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['reviewer'], members: { reviewer: {} } }, 'directed'),
    /requires a builder seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['builder'], members: { builder: {} } }, 'directed'),
    /requires a reviewer seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['lead', 'builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'directed'),
    /requires a lead seat/,
  )
})

test('the daemon child preflight accepts the same planner-less directed crew', () => {
  const makeFixture = (roles) => {
    const dir = scratchDir('directed-child-')
    const crewDir = join(dir, 'crew')
    const taskDir = join(crewDir, 'task')
    const returnsDir = join(crewDir, 'returns')
    mkdirSync(taskDir, { recursive: true })
    mkdirSync(returnsDir, { recursive: true })
    const taskReturn = join(returnsDir, 'task.json')
    const briefFile = join(dir, 'brief.md')
    const members = Object.fromEntries(roles.map((role) => [role, { model: 'x', transport: 'headless-json' }]))
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      task: 'x', checkout: dir, roles, members, task_return: taskReturn,
    }))
    writeFileSync(join(crewDir, 'journal.jsonl'), '')
    writeFileSync(briefFile, DIRECTED_BRIEF_TEXT)
    return { dir, crewDir, briefFile, taskReturn }
  }
  const run = (fixture) => runChild({
    crew_dir: fixture.crewDir, task: 'x', brief_file: fixture.briefFile,
    variant: 'directed', validation_lane: 'lane-cmd',
  }, {
    execSync: () => '',
    env: { DEVTEAM_LEDGER_DB: join(fixture.dir, 'ledger.db') },
    seatIo: () => ({ log() {} }),
    driveTask: () => ({ status: 'done', summary: 'ok', artifacts: [], details: { stages: [] } }),
  })

  const complete = makeFixture(['builder', 'reviewer'])
  try {
    const result = run(complete)
    assert.equal(result.status, 'done')
    assert.equal(JSON.parse(readFileSync(complete.taskReturn, 'utf8')).status, 'done')
  } finally {
    rmSync(complete.dir, { recursive: true, force: true })
  }

  for (const missing of [['reviewer'], ['builder']]) {
    const fixture = makeFixture(missing)
    try {
      assert.throws(() => run(fixture), /requires a (builder|reviewer) seat/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  }
})

test('coded shape topology is measured against every successful executor family', () => {
  const expectedTraces = {
    full: ['plan', 'build', 'scope-gate', 'lane', 'review', 'review', 'commit', 'document', 'suite', 'suite'],
    scout: ['scout', 'scope-gate', 'envelope-accept'],
    review_only: ['review_only', 'scope-gate', 'envelope-accept'],
    review_panel: ['review_panel', 'scope-gate', 'envelope-accept'],
    repair: ['repair', 'build', 'scope-gate', 'lane', 'review', 'review', 'commit', 'document', 'suite', 'suite'],
    directed: ['directed', 'gate-baseline', 'build', 'scope-gate', 'lane', 'gate', 'gate-proof', 'review', 'review', 'commit', 'document', 'suite', 'suite'],
    verify_only: ['verify_only', 'scope-gate', 'envelope-accept'],
  }
  const emittedHeads = (result) => normaliseStageHeads(result.details.stages)
  const strictEnvelopeIo = (envelope, role, runId) => {
    const io = fakeIo({ changed: [] })
    const assign = io.assign.bind(io)
    io.assign = (spec) => ({ ...assign(spec), id: 'd1', returnPath: `${role}:1` })
    io.wait = () => ({ ...envelope, assignment_id: 'd1', run_id: runId, role })
    return io
  }
  const reviewPanelEnvelopes = {
    reviewer: { status: 'done', role: 'reviewer', summary: 'review complete', artifacts: [`${TD}/panel-review.md`], details: { base: 'a'.repeat(40), head: 'b'.repeat(40), outcome: 'no-findings', findings: [], reviewed_files: [], unreviewable_files: [] } },
    'tech-lead': { status: 'done', role: 'tech-lead', summary: 'partner review complete', artifacts: [`${TD}/panel-partner.md`], details: { base: 'a'.repeat(40), head: 'b'.repeat(40), outcome: 'no-findings', findings: [], reviewed_files: [], unreviewable_files: [] } },
    lead: { status: 'done', role: 'lead', summary: 'panel adjudicated', artifacts: [`${TD}/panel-adjudication.md`], details: { base: 'a'.repeat(40), head: 'b'.repeat(40), adjudications: [], reviewed_files: [], unreviewable_files: [] } },
  }
  const strictPanelIo = (runId) => {
    const io = fakeIo({ changed: [] })
    const assign = io.assign.bind(io)
    io.assign = (spec) => ({ ...assign(spec), id: 'd1', returnPath: `${spec.role}:1` })
    io.wait = (returnPath) => ({ ...reviewPanelEnvelopes[returnPath.split(':')[0]], assignment_id: 'd1', run_id: runId, role: returnPath.split(':')[0] })
    return io
  }
  const reviewOnlyEnvelope = {
    status: 'done', role: 'reviewer', summary: 'review complete', artifacts: [`${TD}/review.md`],
    details: { base: 'base-sha', head: 'head-sha', outcome: 'no-findings', findings: [], reviewed_files: [], unreviewable_files: [] },
  }
  const verifyOnlyEnvelope = {
    status: 'done', role: 'reviewer', summary: 'verification complete', artifacts: [`${TD}/verification.md`],
    details: {
      verification_targets: [{ id: 'target-1', target: 'the declared behavior' }],
      environment_assumptions: [{ name: 'runtime', assumption: 'the supported runtime is available' }],
      product_verdict: 'passing',
      check_matrix: [{ id: 'target-1', status: 'passed', command: 'node --test', result: 'ok', evidence: 'captured output' }],
      environment: [{ name: 'runtime', observed: 'node test runtime' }],
      environmental_blockers: [],
    },
  }
  const red = `red\n${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const fixtures = {
    full: () => {
      const io = fakeIo({
        envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
        runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
        changed: ['a.mjs', 'a.test.mjs'],
      })
      return driveTask(CTX, io)
    },
    scout: () => driveTask({ ...CTX, variant: 'scout' }, fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })),
    review_only: () => driveTask(
      { ...CTX, variant: 'review_only', run_id: 'run-review-783', roles: ['reviewer'], seatedRoles: ['reviewer'] },
      strictEnvelopeIo(reviewOnlyEnvelope, 'reviewer', 'run-review-783'),
    ),
    review_panel: () => driveTask(
      { ...CTX, variant: 'review_panel', run_id: 'run-review-panel-783', roles: ['reviewer', 'tech-lead', 'lead'], seatedRoles: ['reviewer', 'tech-lead', 'lead'], review_identity: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) } },
      strictPanelIo('run-review-panel-783'),
    ),
    repair: () => {
      const io = fakeIo({
        envelopes: { 'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
        runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
        changed: ['a.mjs'], files: TRIAGE_FILES,
      })
      return driveTask(CTX_REPAIR, io)
    },
    directed: () => {
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
      return driveTask(CTX_DIRECTED, io)
    },
    verify_only: () => driveTask(
      { ...CTX, variant: 'verify_only', run_id: 'run-verify-783', roles: ['reviewer'], seatedRoles: ['reviewer'] },
      strictEnvelopeIo(verifyOnlyEnvelope, 'reviewer', 'run-verify-783'),
    ),
  }
  const measured = Object.entries(VARIANTS).map(([name, shape]) => {
    const result = fixtures[name]()
    assert.equal(result.status, 'done', name)
    const row = {
      name,
      coded: shapeValidationDefect(shape, name),
      executor: emittedHeads(result),
      expected: expectedTraces[name],
      canonical: [...EXECUTOR_TOPOLOGIES[name].stages],
      raw: [...result.details.stages],
      operations: {},
    }
    assert.deepEqual(row.coded, { defect: null, detail: null }, name)
    return row
  })
  assert.deepEqual(measured.map(({ name }) => name), Object.keys(VARIANTS))
  assert.equal(measured.length, 7)

  const allHeads = [...new Set(Object.values(VARIANTS).flatMap(({ stages }) => stages))]
  for (const row of measured) {
    const shape = VARIANTS[row.name]
    const expected = EXECUTOR_TOPOLOGIES[row.name].stages
    row.operations.extra = (() => {
      const extra = allHeads.find((candidate) => !shape.stages.includes(candidate))
      const coded = shapeValidationDefect({ ...shape, stages: [...shape.stages, extra] }, row.name)
      assert.equal(coded.defect, 'stage-extra', `${row.name} known extra`)
      return { coded, executor: row.executor }
    })()
    for (const removed of [shape.stages[0], 'scope-gate']) {
      const coded = shapeValidationDefect({ ...shape, stages: shape.stages.filter((stage) => stage !== removed) }, row.name)
      assert.equal(coded.defect, 'stage-missing', `${row.name} missing ${removed}`)
      row.operations[removed === 'scope-gate' ? 'scope-gate' : 'required'] = { coded, executor: row.executor }
    }
    if (expected.length > 1) {
      row.operations.swap = []
      for (let left = 0; left < expected.length - 1; left += 1) {
        for (let right = left + 1; right < expected.length; right += 1) {
          const stages = [...shape.stages]
          ;[stages[left], stages[right]] = [stages[right], stages[left]]
          const coded = shapeValidationDefect({ ...shape, stages }, row.name)
          const expectedDefect = 'stage-reordered'
          assert.equal(coded.defect, expectedDefect, `${row.name} swap ${left}/${right}`)
          row.operations.swap.push({ coded, executor: row.executor })
        }
      }
    }
  }
  measured.push(d1ControlRow())
  assertExactTraceRows(measured)
  for (const row of measured) {
    if (!row.canonical) continue
    const projection = row.raw
      .filter((label) => label !== 'review:pass' && label !== 'suite:cold')
      .filter((label) => !['done', 'escalate'].includes(String(label).split(':')[0]))
      .filter((label) => !(row.name === 'directed' && String(label).split(':')[0] === 'gate-baseline'))
      .map((label) => String(label).split(':')[0])
    let cursor = 0
    for (const stage of projection) {
      const position = row.canonical.indexOf(stage, cursor)
      assert.notEqual(position, -1, `${row.name} monotone projection missing ${stage}`)
      cursor = position + 1
    }
  }
  assert.equal(shapeValidationDefect({ ...VARIANTS.full, stages: [...VARIANTS.full.stages].reverse() }, 'full').defect, 'stage-reordered')
  assert.deepEqual([
    ['scope-gate', 'review_only', 'envelope-accept'],
    ['review_only', 'envelope-accept', 'scope-gate'],
    ['review_only', 'scope-gate', 'gate', 'envelope-accept'],
  ].map((stages) => shapeValidationDefect({ ...VARIANTS.review_only, stages }, 'review_only').defect), [
    'stage-reordered', 'stage-reordered', 'stage-extra',
  ])
  assert.equal(shapeValidationDefect({ ...VARIANTS.full, stages: [...VARIANTS.full.stages, 'not-implemented'] }, 'full').defect, 'stage-unimplemented')
  assert.equal(shapeValidationDefect(VARIANTS.full, 'not-a-variant').defect, 'stage-unimplemented')
  assert.equal(shapeValidationDefect({ ...VARIANTS.scout, required_seats: ['reviewer'] }, 'scout').defect, 'seats-mismatch')
  assert.equal(shapeValidationDefect({ ...VARIANTS.repair, sources: { ...VARIANTS.repair.sources, gate: 'brief' } }, 'repair').defect, 'sources-invalid')
  assert.equal(shapeValidationDefect({ ...VARIANTS.directed, required_seats: ['reviewer', 'builder'] }, 'directed').defect, 'seats-mismatch')
})

test('G1 review_panel topology rejects reordered extra and missing stages', () => {
  const shape = VARIANTS.review_panel
  const reordered = [...shape.stages]
  ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
  assert.equal(shapeValidationDefect({ ...shape, stages: reordered }, 'review_panel').defect, 'stage-reordered')
  const extra = shapeValidationDefect({ ...shape, stages: [...shape.stages, 'gate'] }, 'review_panel')
  assert.equal(extra.defect, 'stage-extra')
  const missing = shapeValidationDefect({ ...shape, stages: shape.stages.filter((stage) => stage !== 'scope-gate') }, 'review_panel')
  assert.equal(missing.defect, 'stage-missing')
})

test('A1 full reordered declaration is refused', () => {
  const stages = [...VARIANTS.full.stages]
  const last = stages.length - 1
  ;[stages[0], stages[last]] = [stages[last], stages[0]]
  assert.equal(shapeValidationDefect({ ...VARIANTS.full, stages }, 'full').defect, 'stage-reordered')
})

test('B1 canonical full declaration validates', () => {
  assert.deepEqual(shapeValidationDefect(VARIANTS.full, 'full'), { defect: null, detail: null })
})

test('C1 full extras and missing heads retain distinct codes', () => {
  const extra = shapeValidationDefect({ ...VARIANTS.full, stages: [...VARIANTS.full.stages, 'scout'] }, 'full')
  const missing = shapeValidationDefect({ ...VARIANTS.full, stages: VARIANTS.full.stages.filter((stage) => stage !== 'check') }, 'full')
  assert.equal(extra.defect, 'stage-extra')
  assert.equal(missing.defect, 'stage-missing')
})

test('D1 full stage order rejects a permutation', () => {
  const stages = [...VARIANTS.full.stages]
  ;[stages[0], stages[1]] = [stages[1], stages[0]]
  assert.equal(shapeValidationDefect({ ...VARIANTS.full, stages }, 'full').defect, 'stage-reordered')
})

test('A1-full: full emits its ordered main-flow projection', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(normaliseStageHeads(result.details.stages), [
    'plan', 'build', 'scope-gate', 'lane', 'review', 'review', 'commit', 'document', 'suite', 'suite',
  ])
  const projection = result.details.stages
    .filter((label) => label !== 'review:pass' && label !== 'suite:cold')
    .filter((label) => !['done', 'escalate'].includes(String(label).split(':')[0]))
    .map((label) => String(label).split(':')[0])
  assert.deepEqual(projection, A1_FULL_TRACE)
})

test('A1-publish-off: default-unarmed publish-disabled path retains the mechanical tail', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  const complete = normaliseStageHeads(result.details.stages)
  assert.deepEqual(complete, [
    'plan', 'build', 'scope-gate', 'lane', 'review', 'review', 'commit', 'document', 'suite', 'suite',
  ])
  assert.deepEqual(complete.slice(complete.indexOf('commit')), A1_PUBLISH_DISABLED_TRACE)
})

test('D1-ordered: the control row reaches the exact matrix equality', () => {
  assertExactTraceRows([d1ControlRow()])
})

test('E1-no-interpreter: the detector rejects declared-stage iteration', () => {
  const detectsInterpreter = (source) => typeof source === 'string' && source.includes('for (const declaredStage of shape.stages) execute(declaredStage)')
  assert.equal(detectsInterpreter(E1_FORBIDDEN_ITERATION), true)
  let driveSource
  try {
    driveSource = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  } catch (error) {
    assert.fail(`drive source unreadable: ${error?.code || error?.message || 'unknown'}`)
  }
  assert.equal(typeof driveSource, 'string')
  assert.ok(driveSource.length > 0, 'drive source must not be empty')
  assert.equal(detectsInterpreter(driveSource), false)
})

test('shape validator exposes a frozen closed vocabulary, preserves legacy details, and is server-loadable', () => {
  assert.equal(Object.isFrozen(SHAPE_DEFECT_CODES), true)
  assert.deepEqual(SHAPE_DEFECT_CODES, [
    'stage-reordered', 'stage-extra', 'stage-missing', 'stage-unimplemented', 'seats-mismatch',
    'declaration-missing', 'execution-invalid', 'writes-invalid', 'accepted-by-invalid',
    'stages-invalid', 'envelope-fields-invalid', 'boolean-field-invalid',
    'envelope-field-kind-invalid', 'envelope-field-name-invalid', 'envelope-field-metadata-invalid',
    'sources-invalid',
  ])
  const deeplyFrozen = (value) => {
    if (!value || typeof value !== 'object') return true
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) deeplyFrozen(child)
    return true
  }
  deeplyFrozen(EXECUTOR_TOPOLOGIES)
  for (const [name, shape] of Object.entries(VARIANTS)) assert.deepEqual(shapeValidationDefect(shape, name), { defect: null, detail: null })
  const legacy = [
    [null, undefined, 'no declaration'],
    [{ ...VARIANTS.full, execution: 'unknown' }, 'full', 'execution must be one of reviewed, envelope'],
    [{ ...VARIANTS.full, writes: 'unknown' }, 'full', 'writes must be one of planned, none'],
    [{ ...VARIANTS.full, accepted_by: '' }, 'full', 'accepted_by must say what accepts this shape'],
    [{ ...VARIANTS.full, stages: [] }, 'full', 'stages must declare the heads this shape emits'],
    [{ ...VARIANTS.full, envelope_fields: null }, 'full', 'envelope_fields must be an array'],
    [{ ...VARIANTS.full, strict_identity: 'yes' }, 'full', 'strict_identity must be boolean'],
    [{ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'unknown' }] }, 'scout', 'envelope field "findings" must declare a kind in text, records, paths, object'],
    [{ ...VARIANTS.scout, envelope_fields: [{ name: 'paths', kind: 'paths', item_fields: ['path'] }] }, 'scout', 'envelope field "paths" may declare item_fields only on records'],
    [{ ...VARIANTS.scout, envelope_fields: [{ name: '', kind: 'records' }] }, 'scout', 'envelope fields must have unique non-empty names'],
    [{ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'records', item_fields: ['summary'], optional_item_fields: ['summary'] }] }, 'scout', 'envelope field "findings".optional_item_fields must be disjoint from item_fields'],
    [{ ...VARIANTS.scout, stages: ['scout', 'scope-gate'] }, 'scout', 'an envelope shape must declare its envelope-accept stage'],
    [{ ...VARIANTS.scout, writes: 'planned' }, 'scout', 'an envelope shape has no plan to source a write surface from; writes must be "none"'],
    [{ ...VARIANTS.scout, stages: ['scout', 'envelope-accept'] }, 'scout', 'a shape that claims to write nothing must declare the scope-gate stage that proves it'],
    [{ ...VARIANTS.directed, required_seats: ['builder'] }, 'directed', 'the directed shape runs exactly builder, reviewer; required_seats must be that list'],
    [{ ...VARIANTS.repair, sources: undefined }, 'repair', 'the reviewed executor implements exactly the full stage set; this declaration omits plan, check, gate, gate-baseline, gate-repair, gate-reverify, gate-proof, converge, and a partial reviewed shape needs declared sources for scope, lane and gate before it can be run: no sources declared'],
    [{ ...VARIANTS.repair }, 'quality', 'the partial reviewed shapes this driver implements are repair and directed; a declaration registered as "quality" would open "quality:r1", a stage it does not declare'],
    [{ ...VARIANTS.repair, sources: { ...VARIANTS.repair.sources, gate: 'brief' } }, 'repair', 'the repair shape sources scope=inherited, lane=ctx, gate=none; this declaration sources scope=inherited, lane=ctx, gate=brief'],
    [{ ...VARIANTS.repair, stages: [...VARIANTS.repair.stages].reverse() }, 'repair', 'a repair shape runs exactly repair, build, scope-gate, lane, review, commit, document, rebase, suite, publish; this declaration runs publish, suite, rebase, document, commit, review, lane, scope-gate, build, repair'],
    [{ ...VARIANTS.full, required_seats: ['planner'] }, undefined, 'a reviewed shape is seated by the tier; required_seats must be "tier"'],
  ]
  for (const [shape, name, expected] of legacy) assert.equal(shapeDefect(shape, name), expected, expected)
  const source = readFileSync(new URL('./shape-validator.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\b/m)
  assert.doesNotMatch(source, /(?:drive\.mjs|scripts\/)/)
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', "const leaf = await import('./crew/shape-validator.mjs'); if (!leaf.shapeValidationDefect) process.exit(2)"], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout)
})

test('drive re-exports the leaf envelope field metadata validator', () => {
  assert.strictEqual(envelopeFieldMetadataDefect, leafEnvelopeFieldMetadataDefect)
  for (const [name, shape] of Object.entries(VARIANTS)) {
    for (const field of shape.envelope_fields) {
      assert.equal(envelopeFieldMetadataDefect(field, shape.envelope_fields), null, `${name}.${field.name}`)
    }
  }
  assert.notEqual(envelopeFieldMetadataDefect({ name: 'paths', kind: 'paths', item_values: {} }), null)
})

test('shape sources and the repair declaration are pinned', () => {
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
  assert.equal(sourcesDefect(undefined) !== null, true)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, scope: 'bad' }), /scope/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, lane: 'bad' }), /lane/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, gate: 'bad' }), /gate/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, proof: 'self' }), /proof/)
  assert.equal(sourcesDefect(VARIANTS.repair.sources), null)
  assert.deepEqual(SHAPE_SOURCES.scope, ['plan', 'inherited', 'brief'])
  assert.deepEqual(SHAPE_SOURCES.lane, ['plan', 'ctx'])
  assert.deepEqual(SHAPE_SOURCES.gate, ['plan', 'none', 'brief'])
  assert.deepEqual(REVIEWED_CORE_STAGES, ['build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'])
  assert.equal(TRIAGE_STAGE_HEAD, 'repair')
  assert.deepEqual(TRIAGE_STAGES, ['repair', ...REVIEWED_CORE_STAGES])
})

test('shapeDefect admits only the implemented partial topology under repair', () => {
  const withSources = (stages, sources) => ({ ...VARIANTS.full, stages, sources })
  const planSources = { scope: 'plan', lane: 'plan', gate: 'plan' }
  const cases = [
    [VARIANTS.full.stages.filter((head) => head !== 'check'), planSources, 'full'],
    [VARIANTS.full.stages.filter((head) => head !== 'gate-baseline'), planSources, 'full'],
    [VARIANTS.full.stages.filter((head) => head !== 'converge'), planSources, 'full'],
    [VARIANTS.repair.stages, VARIANTS.repair.sources, 'quality'],
    [[...VARIANTS.repair.stages], { ...TRIAGE_SOURCES, proof: 'self' }, 'repair'],
    [[...VARIANTS.repair.stages, 'gate'], TRIAGE_SOURCES, 'repair'],
    [VARIANTS.repair.stages.filter((head) => head !== 'lane'), TRIAGE_SOURCES, 'repair'],
    [['plan', ...VARIANTS.repair.stages], TRIAGE_SOURCES, 'repair'],
  ]
  for (const [stages, sources, name] of cases) assert.ok(shapeDefect(withSources(stages, sources), name))
  assert.match(shapeDefect(VARIANTS.repair, 'quality'), /quality/)
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
})

test('undeclaredStage still bounds repair heads', () => {
  for (const label of ['plan:r1', 'check:r1', 'gate:r1', 'gate-baseline', 'converge:suite']) {
    assert.match(undeclaredStage(VARIANTS.repair, label), /not declared/)
  }
  for (const label of ['repair:r1', 'escalate:triage', 'done']) assert.equal(undeclaredStage(VARIANTS.repair, label), null)
})

test('omitting the variant is equivalent to explicitly selecting full', () => {
  const make = () => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const a = make(); const b = make()
  assert.deepEqual(driveTask(CTX, a), driveTask({ ...CTX, variant: DEFAULT_VARIANT }, b))
  assert.deepEqual(a.calls, b.calls)
})

test('an unknown variant refuses before assignments or journal lines', () => {
  const io = fakeIo()
  assert.throws(() => driveTask({ ...CTX, variant: 'unknown-shape' }, io), (err) => {
    assert.equal(err.stage, 'variant')
    assert.match(err.message, /full/)
    assert.match(err.message, /scout/)
    return true
  })
  assert.equal(io.calls.assign.length, 0)
  assert.equal(io.calls.logs.length, 0)
})

test('shapeDefect refuses declarations the driver cannot honour', () => {
  assert.equal(shapeDefect(VARIANTS.full), null)
  assert.equal(shapeDefect(VARIANTS.scout), null)
  const subset = { ...VARIANTS.full, stages: ['build', 'review', 'commit', 'rebase', 'suite', 'publish'] }
  assert.match(shapeDefect(subset), /plan/)
  assert.match(shapeDefect(subset), /declared sources/)
  assert.match(shapeDefect({ ...VARIANTS.scout, stages: ['scout', 'envelope-accept'] }), /scope-gate/)
  assert.match(shapeDefect({ ...VARIANTS.full, required_seats: ['planner'] }), /required_seats/)
  assert.match(shapeDefect({ ...VARIANTS.full, execution: 'unknown' }), /execution/)
  assert.match(shapeDefect({ ...VARIANTS.full, writes: 'unknown' }), /writes/)
  assert.match(shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'unknown' }] }), /kind/)
})

test('stageEnabled answers synthetic and shipped declarations from their stages', () => {
  const subset = { stages: ['build', 'quality'] }
  const envelope = { stages: ['prompt', 'envelope-accept'] }
  assert.equal(stageEnabled(subset, 'build'), true)
  assert.equal(stageEnabled(subset, 'plan'), false)
  assert.equal(stageEnabled(envelope, 'prompt'), true)
  assert.equal(stageEnabled(envelope, 'scope-gate'), false)
  assert.equal(stageEnabled(VARIANTS.full, 'plan'), true)
  assert.equal(stageEnabled(VARIANTS.scout, 'plan'), false)
  assert.equal(stageEnabled(VARIANTS.scout, 'scout'), true)
})

test('undeclaredStage bounds declared heads while exempting universal terminals', () => {
  for (const label of ['plan:r1', 'gate-baseline:green-bounce', 'gate-proof:1', 'converge:pr', 'review:panel-r2', 'escalate:lane', 'done']) {
    assert.equal(undeclaredStage(VARIANTS.full, label), null, label)
  }
  assert.equal(undeclaredStage(VARIANTS.scout, 'escalate:scope'), null)
  assert.equal(undeclaredStage(VARIANTS.scout, 'done'), null)
  assert.match(undeclaredStage(VARIANTS.scout, 'commit'), /not declared/)
})

test('scout seats its declared planner only and never commits', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.deepEqual(io.calls.assign.map(({ role }) => role), [VARIANTS.scout.required_seats[0]])
  assert.equal(io.calls.commits.length, 0)
  assert.equal(result.details.commit, null)
  assert.deepEqual(result.details.files_committed, [])
})

test('scout dispatches a written brief containing its complete envelope contract', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  driveTask({ ...CTX, variant: 'scout' }, io)
  const briefPath = `${TD}/scout-brief.md`
  assert.equal(io.calls.assign[0].briefFile, briefPath)
  const brief = io.calls.writes[briefPath]
  assert.ok(brief.startsWith('# scout assignment\n'))
  assert.doesNotMatch(brief, /\\n/)
  for (const needle of [CTX.briefFile, CTX.taskDir, 'changed zero files', 'details.findings', 'summary', 'evidence', 'artifacts']) assert.ok(brief.includes(needle), needle)
  assert.doesNotMatch(brief, /plan\.md/)
  assert.doesNotMatch(brief, /review/i)
})

test('a declared field of the wrong kind is refused, and the reason says which kind of wrong', () => {
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
  const record = { summary: 's', evidence: 'e' }
  const cases = [
    [{ alpha: 'a', beta: 'not an array' }, 'field-kind'],
    [{ alpha: 'a', beta: { ...record } }, 'field-kind'],
    [{ alpha: 'a', beta: [] }, 'field-kind'],
    [{ alpha: 7, beta: [record] }, 'field-kind'],
    [{ alpha: '   ', beta: [record] }, 'field-kind'],
    [{ alpha: 'a', beta: [null] }, 'field-item'],
    [{ alpha: 'a', beta: [[]] }, 'field-item'],
    [{ alpha: 'a', beta: [{ summary: 's' }] }, 'field-item'],
    [{ alpha: 'a', beta: [{ summary: ' ', evidence: 'e' }] }, 'field-item'],
  ]
  for (const [details, reason] of cases) {
    const defect = envelopeDefect(envelope(details), shape, { taskDir: TD })
    assert.equal(defect.reason, reason)
    assert.ok(defect.why)
  }
})

test("envelopeFieldsPresent reports the envelope's fields, not the declaration's", () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const observed = (details) => envelopeFieldsPresent({ details }, shape)
  assert.deepEqual(observed({ beta: [{ summary: 's', evidence: 'e' }] }), ['beta'])
  assert.deepEqual(observed({ alpha: 'a sentence' }), ['alpha'])
  assert.deepEqual(observed({}), [])
  assert.deepEqual(observed({ alpha: 'a sentence', beta: [{ summary: 's', evidence: 'e' }] }), ['alpha', 'beta'])
  assert.deepEqual(observed({ alpha: undefined, beta: [{ summary: 's', evidence: 'e' }] }), ['beta'])
  assert.deepEqual(envelopeFieldsPresent({ details: null }, shape), [])
  assert.deepEqual(envelopeFieldsPresent({ details: [] }, shape), [])
})

test('scout write proof escalates at scope, including a files_in_scope claim', () => {
  for (const env of [reconEnv(), reconEnv({ details: { findings: [{ summary: 's', evidence: 'e' }], files_in_scope: ['a.mjs'] } })]) {
    const io = fakeIo({ envelopes: { 'planner:1': env }, changed: ['a.mjs'] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.details.escalation.where, 'scope')
    assert.equal(result.details.stages.at(-1), 'escalate:scope')
    assert.equal(io.calls.commits.length, 0)
  }
})

test('D1 writes-none variants still refuse writes', () => {
  const rogue = 'writes-none-rogue.mjs'
  const scoutIo = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [rogue] })
  const scout = driveTask({ ...CTX, variant: 'scout' }, scoutIo)
  assert.equal(scout.status, 'escalation')
  assert.equal(scout.details.escalation.where, 'scope')
  assert.equal(scoutIo.calls.commits.length, 0)

  const reviewEnvelope = {
    assignment_id: 'd1', role: 'reviewer', run_id: 'run-review-writes-none', status: 'done',
    summary: 'review complete', artifacts: [`${TD}/review.md`],
    details: { base: 'base-sha', head: 'head-sha', outcome: 'no-findings', findings: [] },
  }
  const { io: reviewIo } = identityFixture(reviewEnvelope, {
    variant: 'review_only', role: 'reviewer', runId: 'run-review-writes-none', id: 'd1',
  })
  reviewIo.changedFiles = () => [rogue]
  const review = driveTask({ ...CTX, variant: 'review_only', run_id: 'run-review-writes-none', roles: ['reviewer'], seatedRoles: ['reviewer'] }, reviewIo)
  assert.equal(review.status, 'escalation')
  assert.equal(review.details.escalation.where, 'scope')
  assert.equal(reviewIo.calls.commits.length, 0)
  assert.equal([scout, review].filter(({ status }) => status === 'escalation').length, 2)
})

test('scout still proves a clean tree after a dead or unusable seat', () => {
  const dead = fakeIo({ envelopes: { 'planner:1': null }, changed: [] })
  const deadResult = driveTask({ ...CTX, variant: 'scout' }, dead)
  assert.deepEqual(deadResult.details.stages, ['scout:r1', 'scope-gate:r1', 'escalate:scout'])
  assert.match(deadResult.details.escalation.why, /no valid envelope/)
  const dirty = fakeIo({ envelopes: { 'planner:1': null }, changed: ['a.mjs'] })
  const dirtyResult = driveTask({ ...CTX, variant: 'scout' }, dirty)
  assert.equal(dirtyResult.details.escalation.where, 'scope')
  const malformed = fakeIo({ envelopes: { 'planner:1': {} }, changed: [] })
  const malformedResult = driveTask({ ...CTX, variant: 'scout' }, malformed)
  assert.equal(malformedResult.details.escalation.where, 'scout')
})

test('scout reports a non-done but well-formed envelope as a seat escalation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv({ status: 'insufficient', summary: 'need more checkout evidence' }) }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.details.escalation.where, 'scout')
  assert.match(result.details.escalation.why, /need more checkout evidence/)
})

test('read-only scout shapes do not fire the protected-path sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': reconEnv({ details: { findings: [{ summary: 's', evidence: 'crew/drive.mjs:50' }], files_in_scope: ['crew/drive.mjs'] } }) },
    changed: [], reseat: () => ({ applied: true }),
  })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.reseat.length, 0)
  assert.deepEqual(result.details.modifiers, [])
})

test('the planner is confined to its own stages — no post-acceptance path assigns it', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const hits = source.split('\n').filter((line) => /assignAndWait\(\s*'planner'\s*,/.test(line))
  assert.equal(hits.length, 2)
  assert.match(hits[0], /'triage'/)
  assert.match(hits[1], /round === 1 \? 'plan' : 'plan-revision'/)
  // #843: the widening bounce carries its own note, so the site reads a consumed-once
  // override in FRONT of the ternary — the two ordinary notes are still the fallback.
  assert.match(hits[1], /planNote \?\? \(round === 1/)
  assert.equal(hits.some((line) => /gate-(repair|fix)/.test(line)), false)
  const io = b44MidRunRepairIo()
  driveTask(CTX, io)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 1)
})

test('every gate site assigns the lead, and the repaired gate is still re-proven', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const sites = [...source.matchAll(/assignAndWait\(\s*([^,]+?)\s*,[^,]+,\s*'(gate-repair|gate-fix)'\s*\)/g)]
  assert.equal(sites.length, 5)
  assert.ok(sites.every(([, role]) => role === 'GATE_CUSTODIAN'))
  const io = b44MidRunRepairIo()
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.filter(({ role, note }) => role === 'lead' && note === 'gate-repair').map(({ role, note }) => ({ role, note })), [{ role: 'lead', note: 'gate-repair' }])
  assert.equal(result.details.gate.reverified, true)
  assert.ok(result.details.stages.includes('gate-reverify:1'))
})

test('lead-less: a baseline-green gate escalates with its diagnosis, assigning nobody', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan() },
    runs: { 'gate-cmd': { ok: true, output: 'GREEN at baseline' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /GREEN at baseline/)
})

test('lead-less: a gate that did not RUN at baseline escalates with its diagnosis', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan() },
    runs: { 'gate-cmd': { ok: false, output: 'gate crashed before running' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /the gate did not RUN at baseline.*printed no GATE-SUMMARY/)
})

test('lead-less: a failed discrimination proof escalates with its diagnosis', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'gate-cmd:1': { ok: false, output: RED() }, 'gate-cmd:2': { ok: true, output: 'green on built tree' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green on pristine tree' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /acceptance gate|discriminat/i)
})

test('a child-shaped ctx (lead only in seatedRoles) takes the gate repair on the lead', () => {
  const childCtx = { ...CTX, roles: ['planner', 'builder', 'reviewer'], seatedRoles: ['lead', 'planner', 'builder', 'reviewer'] }
  const io = b44GateFixIo()
  const result = driveTask(childCtx, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.filter(({ role, note }) => note === 'gate-fix').map(({ role, note }) => ({ role, note })), [{ role: 'lead', note: 'gate-fix' }])
  assert.equal(result.details.escalation, null)

  const attendedIo = b44GateFixIo()
  const attended = driveTask(CTX, attendedIo)
  assert.equal(attended.status, 'done')
  assert.equal(attendedIo.calls.assign.filter(({ role, note }) => role === 'lead' && note === 'gate-fix').length, 1)
})

test('a missing envelope escalation carries stale, refused and working diagnoses', () => {
  for (const text of [
    'the seat is STALE: planner produced its last transcript frame 5000s ago',
    'the seat REFUSED: planner — the provider says: Overloaded (transient)',
    'the seat is WORKING: planner produced a transcript frame 3s ago and simply exceeded its 1800s budget',
  ]) {
    const io = fakeIo({ envelopes: { 'planner:1': null } })
    io.waitDiagnosis = () => ({ state: text.includes('STALE') ? 'stale' : text.includes('REFUSED') ? 'refused' : 'working', text })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'escalation')
    assert.match(res.details.escalation.why, new RegExp(`planner: no valid envelope at planner:1 within 1800s — ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

test('an io without waitDiagnosis preserves the plain missing-envelope escalation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope at planner:1 within 1800s$/)
})

test('waitDiagnosis is not consulted when an envelope is present but shape-invalid', () => {
  const io = fakeIo({ envelopes: { 'planner:1': {}, 'lead:1': leadEnv('escalate') } })
  let consulted = 0
  io.waitDiagnosis = () => { consulted += 1; return { state: 'stale', text: 'should not appear' } }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.match(res.details.escalation.why, /envelope-refusal: status-kind/)
  assert.equal(consulted, 0)
})

test('T1 — one shape, both exits', () => {
  const crash = crashRun().envelope
  const deliberate = deliberateRun().envelope
  assert.equal(crash.status, 'escalation')
  assert.deepEqual(Object.keys(crash.details).sort(), Object.keys(deliberate.details).sort())
  assert.deepEqual(Object.keys(crash.details).sort(), resumeKeys.slice().sort())
})

test('T2 — gate payload and attempt count', () => {
  const { envelope } = crashRun()
  assert.equal(envelope.details.gate.cmd, 'gate-cmd')
  assert.equal(envelope.details.gate_attempt_high_water, 3)
})

test('T4 — the preserved crash values', () => {
  const { envelope } = crashRun()
  assert.deepEqual(envelope.details.escalation, {
    where: 'builder',
    why: CRASH_WHY,
    question: {
      type: 'free-text',
      prompt: 'What should happen next after this driver crash?',
      reason: 'A crash stage is open-ended and does not map to the deliberate escalation catalog.',
      slots: { stage: 'builder', return_path: 'builder:3' },
    },
  })
  assert.equal(envelope.summary, `Task t1 needs a human: the driver crashed (${CRASH_WHY})`)
})

test('T5 — the empty-message edge', () => {
  const { envelope, thrown } = throwingWaitRun(new Error(''))
  assert.equal(thrown, null)
  assert.equal(envelope.details.escalation.why, '')
  assert.equal(envelope.summary, 'Task t1 needs a human: the driver crashed ()')
})

test('T6 — a post-commit crash retains the measured commit', () => {
  const run = postCommitCrashRun()
  assert.equal(run.committed, true)
  assert.equal(run.thrown, null)
  assert.equal(run.envelope.details.commit, 'abc1234')
  assert.deepEqual(Object.keys(run.envelope.details).sort(), resumeKeys.slice().sort())
})

test('T7 — head is acquired, not injected', () => {
  const previousExitCode = process.exitCode
  let expectedHead = null
  try {
    const run = runCmdFixture({}, (ctx) => {
      expectedHead = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.checkout, encoding: 'utf8' }).stdout).trim()
      return driveTask(ctx, crashIo())
    })
    const start = run.rows.find((row) => row.event === 'run-start')
    assert.match(run.ctx.head, /^[0-9a-f]{40}$/)
    assert.equal(run.ctx.head, expectedHead)
    assert.equal(start.head, expectedHead)
  } finally { process.exitCode = previousExitCode }
})

test('T8 — journal stage rows', () => {
  const crash = crashRun()
  assert.deepEqual(escalationStageRows(crash.io), [])
  const deliberate = deliberateRun()
  assert.deepEqual(escalationStageRows(deliberate.io), ['stage:escalate:plan', 'stage_done:escalate:plan'])
})

test('T9 — the deliberate exit is unchanged', () => {
  const { envelope, io } = deliberateRun()
  assert.deepEqual(envelope.details.escalation, {
    where: 'plan',
    why: 'no accepted plan within 2 rounds',
    question: {
      type: 'free-text',
      prompt: 'What should happen next when plan preparation cannot proceed?',
      reason: 'heterogeneous failures at plan do not map to an existing closed recovery verb.',
      slots: {},
    },
  })
  assert.equal(envelope.summary, 'Task t1 needs a human: no accepted plan within 2 rounds')
  assert.deepEqual(Object.keys(envelope.details).sort(), resumeKeys.slice().sort())
  assert.deepEqual(envelope.details.stages, ['plan:r1', 'plan:r2', 'escalate:plan'])
  assert.deepEqual(envelope.details.cursor, { plan_round: 2, build_round: null, review_round: null })
  assert.equal(envelope.details.seq_high_water, 4)
  assert.equal(envelope.details.consults_spent, 2)
  assert.equal(envelope.details.commit, null)
  assert.equal(envelope.details.gate, null)
  assert.equal(envelope.details.head, 'deadbeefcafe')
  assert.deepEqual(io.calls.run, [])
})

test('T10 — extraDetails still reach the envelope and still land last', () => {
  const { envelope } = carveRun()
  assert.equal(envelope.details.escalation.where, 'plan-carve')
  assert.deepEqual(envelope.details.carve, { verdict: 'carve', slices: [{ summary: 'slice one', files_in_scope: ['a.mjs'] }], defect: null })
})

test('T11 — a pre-arming throw still throws', () => {
  const unknownIo = fakeIo()
  assert.throws(() => driveTask({ ...CTX, variant: 'unknown-shape' }, unknownIo))
  assert.equal(unknownIo.calls.assign.length, 0)
  assert.equal(unknownIo.calls.logs.length, 0)
  const badCtx = new Proxy({ ...CTX, variant: 'full' }, {
    get(target, property, receiver) {
      if (property === 'limits') return new Proxy({}, { ownKeys() { throw new Error('unexecutable shape') } })
      return Reflect.get(target, property, receiver)
    },
  })
  const badIo = fakeIo()
  assert.throws(() => driveTask(badCtx, badIo), /unexecutable shape/)
  assert.equal(badIo.calls.assign.length, 0)
  assert.equal(badIo.calls.logs.length, 0)
})

test('T12 — the escape is exactly the seat-refusal class', () => {
  const refusal = Object.assign(new Error('the provider says: not supported on this model'), { stage: SEAT_REFUSAL_STAGE, role: 'builder' })
  const escaped = throwingWaitRun(refusal)
  assert.equal(escaped.envelope, null)
  assert.equal(escaped.thrown, refusal)
  const builderError = Object.assign(new Error('builder failed'), { stage: 'builder' })
  const converted = throwingWaitRun(builderError)
  assert.equal(converted.thrown, null)
  assert.equal(converted.envelope.status, 'escalation')
  assert.equal(converted.envelope.details.escalation.where, 'builder')
})

test('there is exactly one escalation composer', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  assert.equal((source.match(/status: 'escalation'/g) || []).length, 1)
})

test('a pre-gate escalation reads gate null and does not throw', () => {
  const result = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': leadEnv('escalate') } }))
  assert.equal(result.details.gate, null)
  assert.equal(result.details.escalation.where, 'plan')
})

test('seq high water records d ids and ignores legacy fake ids', () => {
  const options = { envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }
  const seqIo = fakeIo({ ...options, seqIds: true })
  const legacyIo = fakeIo(options)
  assert.equal(driveTask(CTX, seqIo).details.seq_high_water, seqIo.calls.assign.length)
  assert.equal(driveTask(CTX, legacyIo).details.seq_high_water, 0)
})

test('normal terminal journals replay as a balanced nested stack', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'] })
  const result = driveTask(CTX, io)
  assert.deepEqual(resumeStageRows(io), result.details.stages)
  assert.deepEqual(replayResumeStages(io), [])
  assert.equal(new Set(resumeDoneRows(io)).size, resumeDoneRows(io).length)
})

test('stage records entry only and opens nested occurrences', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const stage = (label) => {')
  const rest = source.slice(start)
  const end = rest.indexOf('\n  }\n')
  const body = rest.slice(0, end)
  assert.doesNotMatch(body, /stageComplete\(\)|stage_done/)
  assert.match(body, /openStages\.push\(label\)/)
})

test('a stage that outlives its first blocker is not completed early', () => {
  const run = (lead) => {
    const io = fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': lead, 'planner:2': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] })
    return { io, result: (() => { try { return driveTask(CTX, io) } catch (err) { return err } })() }
  }
  const control = run(leadEnv('bounce'))
  assert.ok(control.io.calls.logs.some((row) => row.stage_done === 'plan:r1'))
  const subject = run(null)
  assert.equal(subject.result.status, 'escalation')
  assert.equal(subject.io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(subject.io.calls.logs.some((row) => row.stage_done === 'plan:r1'), false)
})

test('runCmd carries the start HEAD and fills a crashed run stage list', () => {
  const previousExitCode = process.exitCode
  try {
    const run = runCmdFixture({}, (ctx) => {
      writeFileSync(ctx.journal, `${JSON.stringify({ at: new Date().toISOString(), stage: 'plan:r1' })}\n`, { flag: 'a' })
      writeFileSync(ctx.journal, `${JSON.stringify({ at: new Date().toISOString(), stage: 'build:r1' })}\n`, { flag: 'a' })
      throw new Error('driver boom')
    })
    const start = run.rows.find((row) => row.event === 'run-start')
    assert.ok(run.ctx.head)
    assert.equal(start.event, 'run-start')
    assert.equal(start.head, run.ctx.head)
    assert.deepEqual(run.rows.filter((row) => row.stage).map((row) => row.stage), ['plan:r1', 'build:r1'])
  } finally { process.exitCode = previousExitCode }
})

test('the journal channel vocabulary is closed, exported and additive', () => {
  assert.equal(Object.isFrozen(JOURNAL_CHANNELS), true)
  assert.deepEqual(JOURNAL_CHANNELS, { record: 'record', operational: 'operational' })
  assert.deepEqual([...JOURNAL_CHANNEL_NAMES], ['record', 'operational'])
  assert.equal(Object.isFrozen(JOURNAL_CHANNEL_NAMES), true)
  assert.deepEqual(recordRow({ at: 't', stage: 'plan' }), { at: 't', stage: 'plan', channel: 'record' })
  assert.deepEqual(operationalRow({ at: 't', event: 'descendant-capture', records: 3 }), {
    at: 't', event: 'descendant-capture', records: 3, channel: 'operational',
  })
  assert.equal(operationalRow({ channel: 'record' }).channel, 'operational')
})

test('every journal emit site in the driver is inventoried, wrapped and on the right channel', () => {
  const text = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const sites = driveJournalSites(text)
  const admissionSites = sites.filter(({ keys }) => keys.split(' ').includes('scope_admission'))
  assert.equal(admissionSites.length, 1)
  const refusalSites = sites.filter(({ keys }) => keys.split(' ').includes('envelope_refused'))
  assert.equal(refusalSites.length, 1)
  assert.equal(refusalSites[0].wrapper, 'recordRow')
  const reviewIdentityRefusalSites = sites.filter(({ keys }) => keys.split(' ').includes('review_identity_refused'))
  assert.equal(reviewIdentityRefusalSites.length, 1)
  assert.equal(reviewIdentityRefusalSites[0].wrapper, 'recordRow')
  const prescriptionSites = sites.filter(({ keys }) => keys.split(' ').includes('plan_prescription_applied'))
  assert.equal(prescriptionSites.length, 1)
  assert.equal(prescriptionSites[0].wrapper, 'recordRow')
  const legacySites = sites.filter(({ keys }) => !keys.split(' ').includes('scope_admission') && !keys.split(' ').includes('envelope_refused') && !keys.split(' ').includes('review_identity_refused') && !keys.split(' ').includes('plan_prescription_applied'))
  const expectedLegacySites = DRIVE_JOURNAL_EXPECTED.filter(([, , keys]) => keys !== 'at rebase_restore_diagnosis')
  assert.equal(legacySites.length, expectedLegacySites.length)
  assert.deepEqual(legacySites.map(({ wrapper, events, keys }) => [wrapper, events, keys]), expectedLegacySites)
  assert.ok(sites.every(({ wrapper }) => wrapper === 'recordRow' || wrapper === 'operationalRow'))
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'operationalRow').length, 2)
  assert.deepEqual(sites.filter(({ wrapper }) => wrapper === 'operationalRow').map(({ events, keys }) => [events, keys]), [
    ['', 'at gate_reap'], ['', 'at event kind queue_depth waited_ms slotted'],
  ])
})

test('a full drive writes no journal row without a channel', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.length > 0)
  for (const row of io.calls.logs) {
    assert.ok(JOURNAL_CHANNEL_NAMES.includes(row.channel), `${JSON.stringify(row)} carries no channel`)
  }
})

test("bounce-builder at review exhaustion is today's bounce", () => {
  const { io, result } = b318SiteA('bounce-builder')
  assert.equal(result.status, 'done')
  for (const label of ['build:r3', 'scope-gate:r3', 'lane:r3', 'gate:r3']) {
    assert.ok(result.details.stages.includes(label), `expected stage ${label}`)
  }
  const builders = b318Builders(io)
  assert.equal(builders.length, 3)
  assert.equal(builders[2].note, 'review-fix')
  assert.match(io.calls.writes[`${TD}/build-bounce-r2.md`], /Close every must-fix/)
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('bounce-builder at build exhaustion also spends exactly one review grant', () => {
  const { result } = b318SiteB('bounce-builder')
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('a bare bounce at a review exhaustion is read as bounce-builder and journalled', () => {
  const { io, result } = b318SiteA('bounce')
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('build:r3'))
  assert.equal(io.calls.logs.find((row) => typeof row.decision === 'string').decision, 'bounce-builder')
  assert.deepEqual(
    io.calls.logs.find((row) => row.bounce_target_mapped).bounce_target_mapped,
    { answered: 'bounce', treated_as: 'bounce-builder', consult: 1, round: 1 },
  )
})

test('shellArg round-trips through a real /bin/sh without executing payload metacharacters', () => {
  const sentinel = join(tmpdir(), `crew-shellarg-${process.pid}-${Date.now()}`)
  const payload = [`a'b; touch`, sentinel, '; $HOME `printf injected` with whitespace'].join(' ')
  try {
    const script = `set -- ${shellArg(payload)}; printf '%s\n' "$#"; printf '%s' "$1"`
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const [argc, value] = result.stdout.split('\n')
    assert.equal(argc, '1')
    assert.equal(value, payload)
    assert.equal(existsSync(sentinel), false)
  } finally { rmSync(sentinel, { force: true }) }
})

test('parseSuiteCounts handles TAP, default reporter, ANSI, and last-summary precedence', () => {
  assert.deepEqual(parseSuiteCounts('# pass 2\n# fail 1\n# skipped 3\n'), { pass: 2, fail: 1, skipped: 3 })
  assert.deepEqual(parseSuiteCounts('ℹ pass 4\nℹ fail 0\nℹ skipped 1\n'), { pass: 4, fail: 0, skipped: 1 })
  assert.deepEqual(parseSuiteCounts('\x1b[32m# pass 5\x1b[0m\n\x1b[31m# fail 0\x1b[0m\n'), { pass: 5, fail: 0, skipped: 0 })
  assert.deepEqual(parseSuiteCounts('# pass 1\n# fail 9\n# pass 2910\n# fail 0\n# skipped 4\n'), { pass: 2910, fail: 0, skipped: 4 })
  assert.equal(parseSuiteCounts('# pass 1\n'), null)
})

test('an unarmed context retains the legacy local finish without rebase or publication stages', () => {
  const io = closeoutIo()
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.stages.includes('rebase'), false)
  assert.equal(result.details.stages.includes('publish'), false)
  assert.deepEqual(io.calls.run.map(({ cmd }) => cmd), ['lane-cmd', 'suite-cmd'])
})

test('#800 §7b 4 — a refused pass must-fix escalates at review when the lead declines a re-ask', () => {
  const io = dispositionIo([{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 13 — patchTargets fails closed for every unreadable section form', () => {
  assert.deepEqual(patchTargets(D_PATCH_A), { targets: ['a.mjs'], refusal: null })
  const created = patchTargets(['diff --git a/new.mjs b/new.mjs', '--- /dev/null', '+++ b/new.mjs', '@@ -0,0 +1 @@', '+x', ''].join('\n'))
  assert.deepEqual(created, { targets: ['new.mjs'], refusal: null })
  const deleted = patchTargets(['diff --git a/old.mjs b/old.mjs', '--- a/old.mjs', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n'))
  assert.deepEqual(deleted, { targets: ['old.mjs'], refusal: null })
  const cases = [
    'diff --git a/x b/x\n--- /dev/null\n+++ /dev/null\n',
    `diff --git a/x b/y\nrename from x\nrename to y\n--- a/x\n+++ b/y\n`,
    `diff --git a/x b/y\ncopy from x\ncopy to y\n--- a/x\n+++ b/y\n`,
    'diff --git a/x b/x\nGIT binary patch\n',
    'diff --git a/x b/x\n--- "a/x"\n+++ "b/x"\n',
    'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n',
    D_PATCH_EMPTY_PATH,
    D_PATCH_MIXED_MODE,
    `noise before diff\n${D_PATCH_A}`,
  ]
  for (const patch of cases) {
    const parsed = patchTargets(patch)
    assert.ok(parsed.refusal, patch)
    assert.deepEqual(parsed.targets, [], patch)
  }
})

test('#800 §7b 14 — one safe auto-fix applies with no second builder seat', () => {
  const io = dispositionIo(D_AUTO)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(dBuilders(io).length, 1)
  assert.equal(io.calls.assign.length, 4)
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(dAutoRows(io)[0], { round: 1, total: 1, applied: ['RV1-1'], refused: [] })
})

test('#800 §7b 15 — an auto-fix outside recorded plan context applies and is recorded', () => {
  const io = dispositionIo({ ...D_AUTO, location: 'b.mjs:1', patch: D_PATCH_B }, { changed: ['a.mjs', 'b.mjs'] })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.deepEqual(dAutoRows(io)[0], { round: 1, total: 1, applied: ['RV1-1'], refused: [] })
  assert.equal(dBuilders(io).length, 1)
  assert.deepEqual(io.calls.logs.find((row) => row.scope_gate)?.scope_gate.edits, ['b.mjs'])
})

test('#800 §7b 16 — one unreadable section refuses a mixed patch as a whole', () => {
  for (const patch of [D_PATCH_MIXED_RENAME, D_PATCH_MIXED_MODE]) {
    const io = dispositionIo({ ...D_AUTO, patch })
    const result = driveTask(CTX, io)
    assert.equal(result.status, 'done')
    assert.equal(dGitApplies(io).length, 0)
    assert.equal(dAutoRows(io)[0]?.applied.length, 0)
    assert.equal(dAutoRows(io)[0]?.refused.length, 1)
  }
})

test('#800 §7b 17 — git apply refusal is journalled and falls back to a builder', () => {
  const io = dispositionIo(D_AUTO, { runs: { [dApplyCommand('RV1-1')]: { ok: false, output: 'APPLY-RED-MARKER' } } })
  const result = driveTask(CTX, io)
  const refused = dAutoRows(io)[0]?.refused.find(({ id }) => id === 'RV1-1')
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.match(refused?.why || '', /APPLY-RED-MARKER/)
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 18 — post-apply lane red is re-run verbatim and cannot commit that round', () => {
  const io = dispositionIo(D_AUTO, {
    runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } },
    reviewer2: dReviewEnv('changes-needed'),
  })
  const result = driveTask(CTX, io)
  const laneCalls = io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd')
  assert.equal(result.status, 'escalation')
  assert.ok(laneCalls.length >= 2)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /LANE-RED-MARKER/)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 19 — post-apply acceptance-gate red bounces without re-proving pristine discrimination', () => {
  const gate = 'disposition-gate-cmd'
  const io = dispositionIo(D_AUTO, {
    plan: { gate_cmd: gate },
    runs: {
      [`${gate}:1`]: { ok: false, output: D_RED_GATE('baseline red') },
      [gate]: { ok: true, output: D_GREEN_GATE },
      [`${gate}:3`]: { ok: false, output: D_RED_GATE('GATE-RED-MARKER') },
    },
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 1, gate_fails_to_triage: 9 } }, io)
  assert.equal(result.status, 'escalation')
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /GATE-RED-MARKER/)
  assert.equal(io.calls.commits.length, 0)
  // baseline, built tree, post-apply revalidation, then the rebound build: no
  // extra pristine/discrimination invocation is introduced after the patch.
  assert.deepEqual(io.calls.run.filter(({ cmd }) => cmd === gate).map(({ n }) => n), [1, 2, 3, 4])
})

test('#800 §7b 20 — post-apply ordinary context is recorded before review routing', () => {
  const io = dispositionIo(D_AUTO, {
    changed: [['a.mjs', 'a.test.mjs'], ['a.mjs', 'b.mjs'], ['a.mjs', 'a.test.mjs']],
    reviewer2: dReviewEnv('changes-needed'),
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.deepEqual(io.calls.logs.filter((row) => row.scope_gate).at(-1)?.scope_gate, {
    round: 2, reason: null, envelopes: [], edits: ['b.mjs'],
  })
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /Close every must-fix/)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 21 — green scope, lane, and gate revalidation commits with one builder', () => {
  const gate = 'disposition-green-gate'
  const io = dispositionIo(D_AUTO, {
    plan: { gate_cmd: gate },
    runs: {
      [`${gate}:1`]: { ok: false, output: D_RED_GATE('baseline red') },
      [gate]: { ok: true, output: D_GREEN_GATE },
    },
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, gate_fails_to_triage: 9 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(dBuilders(io).length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd').length, 2)
})

test('#800 §7b 22 — final post-apply failures either fund one real builder round or escalate by failed check', () => {
  const bounced = dispositionIo(D_AUTO, {
    runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } },
    leadDecision: 'bounce-builder',
  })
  const bouncedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, bounced)
  assert.equal(bouncedResult.status, 'done')
  assert.deepEqual(bouncedResult.details.extra_rounds_granted, [{ where: 'review', round: 1 }])
  assert.equal(dBuilders(bounced).length, 2)

  const escalated = dispositionIo(D_AUTO, { runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } } })
  const escalatedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalated)
  assert.equal(escalatedResult.status, 'escalation')
  assert.equal(escalatedResult.details.escalation.where, 'lane')
  assert.equal(dLeads(escalated).length, 1)
  assert.equal(dBuilders(escalated).length, 1)
  assert.equal(escalated.calls.commits.length, 0)
})

test('#800 §7b 25 — a lead bounce carries ask-user guidance verbatim', () => {
  const guidance = 'keep the observable default and update its docs'
  const io = dispositionIo(D_ASK, { leadDecision: 'bounce-builder' })
  io.wait = ((wait) => (path, timeout) => {
    const env = wait(path, timeout)
    if (path === 'lead:1') return leadEnv('bounce-builder', guidance)
    return env
  })(io.wait)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dLeads(io).length, 1)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', new RegExp(guidance))
})

test('#800 §7b 26 — mixed dispositions apply the safe patch and send guidance to a builder', () => {
  const guidance = 'preserve compatibility for the observable option'
  const io = dispositionIo([D_AUTO, { ...D_ASK, id: 'RV1-2' }], { leadDecision: 'bounce-builder' })
  io.wait = ((wait) => (path, timeout) => {
    const env = wait(path, timeout)
    if (path === 'lead:1') return leadEnv('bounce-builder', guidance)
    return env
  })(io.wait)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(dLeads(io).length, 1)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', new RegExp(guidance))
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 27 — a mixed-disposition lead escalation applies nothing', () => {
  const io = dispositionIo([D_AUTO, { ...D_ASK, id: 'RV1-2' }])
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 28 — a final ask-user round has one funded bounce or one unresolved escalation', () => {
  const bounced = dispositionIo(D_ASK, { leadDecision: 'bounce-builder' })
  const bouncedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, bounced)
  assert.equal(bouncedResult.status, 'done')
  assert.deepEqual(bouncedResult.details.extra_rounds_granted, [{ where: 'review', round: 1 }])
  assert.equal(dLeads(bounced).length, 1)
  assert.equal(dBuilders(bounced).length, 2)

  const escalated = dispositionIo(D_ASK)
  const escalatedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalated)
  assert.equal(escalatedResult.status, 'escalation')
  assert.equal(escalatedResult.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(escalated).length, 1)
  assert.equal(dBuilders(escalated).length, 1)
})

test('#800 §7b 40 — guardedWrite returns write failures and preserves successful bytes', () => {
  const denied = { writeFile() { throw new Error('EPERM: read-only') } }
  assert.equal(guardedWrite(denied, '/x', 'y'), 'EPERM: read-only')
  const blank = { writeFile() { throw new Error('') } }
  assert.equal(guardedWrite(blank, '/x', 'y'), 'the write threw with no message')
  let received = null
  const ok = { writeFile(path, contents) { received = { path, contents } } }
  assert.equal(guardedWrite(ok, '/x', 'exact bytes'), null)
  assert.deepEqual(received, { path: '/x', contents: 'exact bytes' })
})

test('#800 §7b 41 — a failed patch-artifact write is refused and the driver continues', () => {
  const io = throwAutoFixWrites(dispositionIo(D_AUTO))
  let result
  assert.doesNotThrow(() => { result = driveTask(CTX, io) })
  const row = dAutoRows(io)[0]
  assert.ok(result?.status)
  assert.equal(dGitApplies(io).length, 0)
  assert.deepEqual(row.applied, [])
  assert.match(row.refused.find(({ id }) => id === 'RV1-1')?.why || '', /could not be written/)
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 42 — a failed artifact write cannot take the seat-free revalidation shortcut', () => {
  const io = throwAutoFixWrites(dispositionIo(D_AUTO))
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd').length, 1)
  assert.equal(io.calls.logs.some((row) => row.auto_fix_revalidation), false)
  assert.equal(dBuilders(io).length, 1)
})

test('#800 §7b 47 — guardedWrite empty-message errors never stringify as Error', () => {
  const blank = { writeFile() { throw new Error('') } }
  assert.equal(guardedWrite(blank, '/x', 'y'), 'the write threw with no message')
})

test('repair triage context is recorded rather than refused', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv({ details: { plan_path: `${TD}/triage.md`, files_in_scope: ['b.mjs'] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: S843_RUNS, changed: ['a.mjs'],
    files: { [`${TD}/triage.md`]: '# Triage\n\nfix the off-by-one in a.mjs\n' },
  })
  const result = driveTask({ ...CTX, variant: 'repair', lane: 'lane-cmd', files_in_scope: ['a.mjs', 'a.test.mjs'] }, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.escalation, null)
  assert.deepEqual(io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate.edits, ['a.mjs'])
  assert.ok(io.calls.assign.find(({ role, policy }) => role === 'builder' && policy.fence.includes('b.mjs')))
})

// MUTATION A13 — shell-word tokenization keeps quoted paths as one input.
test("shellWords honours quotes, escapes and adjacent quote runs, and refuses an unterminated one", () => {
  assert.deepEqual(shellWords("node --test 'a b.mjs'"), {
    words: ['node', '--test', 'a b.mjs'], defect: null,
  })
  assert.deepEqual(shellWords(`node --test 'o'"'"'hare.test.mjs'`).words, [
    'node', '--test', "o'hare.test.mjs",
  ])
  assert.deepEqual(shellWords('node --test a\\ b.mjs').words, ['node', '--test', 'a b.mjs'])
  assert.deepEqual(shellWords('node --test "a \\"b\\".mjs"').words, ['node', '--test', 'a "b".mjs'])
  const unterminated = shellWords("node --test 'a")
  assert.deepEqual(unterminated.words, [])
  assert.match(unterminated.defect, /unterminated single quote/)
})

// MUTATION A13 — probe command quoting preserves a path containing an apostrophe.
test('laneProbeCommand quotes every input and laneProbeKinds reads only the closed kinds', () => {
  const quoted = "o'hare.test.mjs"
  const command = laneProbeCommand([quoted, 'crew'])
  assert.ok(command.includes(shellArg(quoted)))
  const kinds = laneProbeKinds(`file ${quoted}\nmystery ${quoted}\ndir crew\nnoise-without-a-kind`)
  assert.equal(kinds.get(quoted), 'file')
  assert.equal(kinds.get('crew'), 'dir')
  assert.equal(kinds.has('noise-without-a-kind'), false)
})

test('b376 A4 an in-scope bounced round keeps its byte-identical build bounce', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': { status: 'insufficient', role: 'builder', summary: 'thin', artifacts: [], details: {} },
      'lead:1': leadEnv('bounce', 'steer'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [['a.mjs', 'a.test.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.writes[`${TD}/build-bounce-r1.md`], `# Build bounce (round 1)\n\nsteer\n\nPlan: ${TD}/plan.md`)
  assert.equal(io.calls.logs.some((row) => row.scope_gate), false)
  assert.equal(io.calls.logs.filter((row) => row.modifier?.kind === 'build').length, 1)
})

test('#846 scope refusals distinguish envelope debris from ordinary edits', () => {
  assert.deepEqual(SCOPE_REFUSALS, ['out-of-scope-edits', 'envelope-in-checkout', 'envelope-and-edits'])
  const cases = [
    [[], { reason: null, envelopes: [], edits: [], why: null }],
    [['rogue.mjs'], { reason: 'out-of-scope-edits', envelopes: [], edits: ['rogue.mjs'], why: 'out-of-scope edits persisted: rogue.mjs' }],
    [['returns/d1.builder.json'], { reason: 'envelope-in-checkout', envelopes: ['returns/d1.builder.json'], edits: [], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json" }],
    [['returns/d1.builder.json', 'rogue.mjs'], { reason: 'envelope-and-edits', envelopes: ['returns/d1.builder.json'], edits: ['rogue.mjs'], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json; out-of-scope edits persisted: rogue.mjs" }],
    [['x/returns/d1.builder.json'], { reason: 'envelope-in-checkout', envelopes: ['x/returns/d1.builder.json'], edits: [], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: x/returns/d1.builder.json" }],
    [['returns/notes.md'], { reason: 'out-of-scope-edits', envelopes: [], edits: ['returns/notes.md'], why: 'out-of-scope edits persisted: returns/notes.md' }],
  ]
  for (const [files, expected] of cases) assert.deepEqual(scopeRefusal(files), expected)
  assert.equal(ENVELOPE_DEBRIS.test('x/returns/d1.builder.json'), true)
  assert.equal(ENVELOPE_DEBRIS.test('returns/notes.md'), false)
  const mixed = scopeRefusal(['returns/d1.builder.json', 'rogue.mjs'])
  const brief = scopeBounceBrief(2, mixed, ['a.mjs'], `${TD}/plan.md`)
  assert.match(brief, /ENVELOPE was written into the CHECKOUT/)
  assert.match(brief, /OUTSIDE the plan's scope/)
})

test('b433 suite refusal reaches the next brief and survives a configured ceiling', () => {
  const baseEnvelopes = {
    'planner:1': suiteRefusalEnv(), 'lead:1': leadEnv('bounce'), 'planner:2': planEnv(),
    'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  }
  const io = fakeIo({
    envelopes: baseEnvelopes,
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done', JSON.stringify({ result, assigns: io.calls.assign, writes: io.calls.writes, logs: io.calls.logs }))
  const second = io.calls.assign.find((entry) => entry.role === 'planner' && entry.n === 2)
  assert.match(second.briefFile, new RegExp(`^${TD}/enforcement-planner-r\\d+\\.md$`))
  assert.match(io.calls.writes[second.briefFile], /suite-run-not-owned/)
  assert.equal(io.calls.writes[second.briefFile].includes(`${TD}/gate.mjs`), true)
  assert.equal(result.details.enforcements[0].kind, 'suite-run-not-owned')
  assert.equal(io.calls.logs.find((row) => row.seat_enforcement?.applied)?.seat_enforcement.dispatch, 'planner2')
  assert.equal(enforcementPreamble({ details: { turn_ceiling: { turns: 7, budget: 5 } } }).kind, 'turn-ceiling')
  assert.equal(enforcementPreamble({ details: { turn_ceiling: { turns: null, budget: 5, absent_reason: CENSUS_ROW_ABSENT } } }).kind, 'turn-ceiling-unmeasured')

  const journal = `${TD}/journal.jsonl`
  const ceiling = fakeIo({
    files: { [journal]: '{"event":"run-start"}\n' }, envelopes: baseEnvelopes,
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  })
  const ceilingResult = driveTask({ ...CTX, turnCeilings: { planner: 40 } }, ceiling)
  assert.equal(ceilingResult.status, 'escalation', JSON.stringify({ ceilingResult, assigns: ceiling.calls.assign, writes: ceiling.calls.writes, logs: ceiling.calls.logs }))
  assert.equal(ceilingResult.details.enforcements.some((entry) => entry.kind === 'suite-run-not-owned'), true)
  assert.equal(ceilingResult.details.enforcements.some((entry) => entry.kind === 'turn-ceiling-unmeasured'), true)
  assert.match(ceiling.calls.writes[ceiling.calls.assign.find((entry) => entry.role === 'planner' && entry.n === 2).briefFile], /suite-run-not-owned/)
})

const CHOICE_OPTIONS = Object.freeze({
  scope: ['widen-fence-to', 'split-lane', 'park'],
  'plan-check': ['adopt-and-continue', 're-dispatch', 'park'],
  'review-unresolved': ['adopt-and-continue', 're-dispatch', 'park'],
  rebase: ['resolve-and-continue', 'park'],
})

function assertChoiceEscalation(result, where, slots, label = where) {
  assert.equal(result.status, 'escalation', `${label} must reach an escalation envelope`)
  assert.equal(result.details.escalation.where, where, `${label} must preserve its where`)
  const question = result.details.escalation.question
  assert.ok(question, `${label} must materialize a question`)
  assert.equal(question.type, 'single-choice', `${label} must retain its question type`)
  assert.deepEqual(question.options, CHOICE_OPTIONS[where], `${label} must retain its closed options`)
  assert.deepEqual(question.slots, slots, `${label} must carry its producer-known slots`)
  assert.equal(Object.isFrozen(question), true, `${label} question must be frozen`)
  assert.equal(Object.isFrozen(question.slots), true, `${label} slots must be frozen`)
}

function rebaseSlotFixture(runs) {
  return driveTask({ ...CTX, publish: { branch: 'feature/slot-coverage' } }, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs,
    changed: ['a.mjs', 'a.test.mjs'],
  }))
}

function scopeSlotFixtures() {
  const debrisFile = 'returns/d1.builder.json'
  return [{
    producer: 'envelope-debris', files: [debrisFile],
    run: () => driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({
      envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() }, changed: [debrisFile],
    })),
  }]
}

test('C1', () => {
  const [scope] = scopeSlotFixtures()
  assert.ok(scope)
  const planCheckIo = fakeIo({
    envelopes: {
      'planner:1': adversarialPlanEnv(),
      'tech-lead:1': { status: 'done', role: 'tech-lead', details: {
        verdict: 'revise', check_path: `${TD}/plan-check.md`,
        findings: [{ id: 'PC-1', severity: 'major', correction: 'make the check executable' }],
      } },
      'lead:1': leadEnv('escalate'),
    },
  })
  const planCheck = driveTask({ ...CTX_TL, limits: { ...CTX_TL.limits, plan_rounds: 1 } }, planCheckIo)

  const reviewIo = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'RV-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'human decision', disposition: 'ask-user', hardening: 'ungateable', hardening_why: 'not mechanically expressible' }]),
      'lead:1': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const unresolved = driveTask({ ...CTX, limits: { ...CTX.limits, build_rounds: 1, review_rounds: 1 } }, reviewIo)

  const rebase = rebaseSlotFixture({ 'git fetch origin main': { ok: false, output: 'fetch failed' } })
  for (const [label, result, where, slots] of [
    [scope.producer, scope.run(), 'scope', { files: scope.files }],
    ['plan-check', planCheck, 'plan-check', { finding_ids: ['PC-1'] }],
    ['review-unresolved', unresolved, 'review-unresolved', { finding_ids: ['RV-1'] }],
    ['rebase-fetch', rebase, 'rebase', { files: [], base: 'origin/main', commit: 'abc1234' }],
  ]) assertChoiceEscalation(result, where, slots, label)

  const crash = crashRun().envelope
  assert.equal(crash.details.escalation.question.type, 'free-text')
  assert.deepEqual(crash.details.escalation.question.slots, { stage: 'builder', return_path: 'builder:3' })
})

test('RV1-1 producer slots survive every envelope route', () => {
  const rebaseBase = {
    'git fetch origin main': { ok: true, output: '' },
    'git rev-parse origin/main': { ok: true, output: 'base111\n' },
    'git merge-base HEAD origin/main': { ok: true, output: 'older000\n' },
  }
  const commonSlots = { files: [], base: 'origin/main', commit: 'abc1234' }
  const recoveryOid = 'a'.repeat(40)
  const recoveryRef = `refs/crew/recovery/${recoveryOid}`
  const recoveryProof = {
    ["git rev-parse --verify 'abc1234^{commit}'"]: { ok: true, output: `${recoveryOid}\n` },
    [`git update-ref '${recoveryRef}' '${recoveryOid}'`]: { ok: true, output: '' },
    [`git rev-parse --verify '${recoveryRef}^{commit}'`]: { ok: true, output: `${recoveryOid}\n` },
  }
  const rebaseCases = [
    ['fetch', { 'git fetch origin main': { ok: false, output: 'fetch failed' } }, commonSlots],
    ['base-probe', { ...rebaseBase, 'git rev-parse origin/main': { ok: false, output: '' } }, commonSlots],
    ['merge-base-probe', { ...rebaseBase, 'git merge-base HEAD origin/main': { ok: false, output: '' } }, commonSlots],
    ['conflict', {
      ...rebaseBase, ...recoveryProof,
      'git rebase origin/main': { ok: false, output: 'conflict' },
      'git diff --name-only --diff-filter=U': { ok: true, output: 'conflict.mjs\n' },
    }, { files: ['conflict.mjs'], base: 'origin/main', commit: 'abc1234' }, /conflict evidence was empty or unmeasurable/],
    ['recovery-ref', {
      ...rebaseBase,
      'git rebase origin/main': { ok: false, output: 'conflict' },
      'git diff --name-only --diff-filter=U': { ok: true, output: 'conflict.mjs\n' },
    }, { files: ['conflict.mjs'], base: 'origin/main', commit: 'abc1234' }, /accepted commit recovery ref was not proved/],
    ['post-rebase-head', {
      ...rebaseBase, 'git rebase origin/main': { ok: true, output: '' },
      'git rev-parse HEAD': { ok: false, output: '' },
    }, commonSlots],
  ]
  for (const [producer, runs, slots, expectedWhy] of rebaseCases) {
    const result = rebaseSlotFixture(runs)
    assertChoiceEscalation(result, 'rebase', slots, `rebase:${producer}`)
    if (expectedWhy) assert.match(result.details.escalation.why, expectedWhy, `rebase:${producer} must preserve its direct retained-state diagnosis`)
    if (producer === 'conflict') assert.equal(result.details.recovery_ref, recoveryRef)
    if (producer === 'recovery-ref') assert.equal(result.details.recovery_ref, undefined)
  }
  for (const { producer, files, run } of scopeSlotFixtures()) {
    assertChoiceEscalation(run(), 'scope', { files }, producer)
  }
})

const RESUME_TEST_FILE = Object.freeze({ path: 'a.mjs', state: 'present', bytes: `file:-:${'a'.repeat(64)}` })
const RESUME_TEST_TREE = Object.freeze({ files: [RESUME_TEST_FILE], worktree_sha256: resumeWorktreeSha256([RESUME_TEST_FILE]) })

function resumeCheckpointForTest(overrides = {}) {
  const kind = overrides.kind || 'suite'
  const base = {
    version: RESUME_CHECKPOINT_VERSION, kind, frozen_where: overrides.frozen_where || kind, head_oid: 'abc1234',
    tree: { index_oid: 'tree1234', ...RESUME_TEST_TREE }, accepted_scope: ['a.mjs'],
    returns: {
      planner: { status: 'done', role: 'planner', artifacts: [], details: {} },
      builder: { status: 'done', role: 'builder', artifacts: [], details: {} },
      reviewer: { status: 'done', role: 'reviewer', artifacts: [], details: {} },
    },
    decision: { accepted_via: 'review pass', verdict: 'pass', residuals: [], carried_findings: [], accept_findings: [], accept_decision: { where: 'review', outcome: 'accepted', residuals: [] }, panel_contributors: ['reviewer'] },
    commit: { oid: 'abc1234', pending: false, files: ['a.mjs'], message: 'feat: resume\n\nCloses #42', subject: 'feat: resume' },
    proof: { gate_cmd: 'gate-cmd', gate_path: `${TD}/gate.mjs`, summary: { total: 1, failed: 0, errored: 0 }, discrimination: 'proven', generation: 1, repairs: 0 },
    suite: { cmd: 'custom-suite', warm: null, cold: null }, publish: { branch: null, base: null }, prior_stages: ['review:r1', 'commit'],
  }
  return {
    ...base, ...overrides,
    tree: { ...base.tree, ...(overrides.tree || {}) },
    returns: overrides.returns || base.returns,
    decision: { ...base.decision, ...(overrides.decision || {}) },
    commit: { ...base.commit, ...(overrides.commit || {}) },
    proof: { ...base.proof, ...(overrides.proof || {}) },
    suite: { ...base.suite, ...(overrides.suite || {}) },
    publish: { ...base.publish, ...(overrides.publish || {}) },
  }
}

const RESUME_CHECKPOINT_KEYS = ['version', 'kind', 'frozen_where', 'head_oid', 'tree', 'accepted_scope', 'returns', 'decision', 'commit', 'proof', 'suite', 'publish', 'prior_stages']

test('resume checkpoint schema is complete for every supported terminal family', () => {
  assert.deepEqual(RESUME_CHECKPOINT_FAMILIES, ['gate', 'rebase', 'suite', 'publish'])
  for (const [kind, frozenWhere] of [['gate', 'gate'], ['rebase', 'rebase'], ['suite', 'suite'], ['suite', 'cold-suite'], ['publish', 'publish']]) {
    const checkpoint = resumeCheckpointForTest({ kind, frozen_where: frozenWhere, suite: { cmd: 'node --test custom-suite.mjs' } })
    assert.deepEqual(Object.keys(checkpoint), RESUME_CHECKPOINT_KEYS)
    assert.deepEqual(Object.keys(checkpoint.tree), ['index_oid', 'files', 'worktree_sha256'])
    assert.deepEqual(Object.keys(checkpoint.decision), ['accepted_via', 'verdict', 'residuals', 'carried_findings', 'accept_findings', 'accept_decision', 'panel_contributors'])
    assert.deepEqual(Object.keys(checkpoint.proof), ['gate_cmd', 'gate_path', 'summary', 'discrimination', 'generation', 'repairs'])
    assert.equal(resumeCheckpointDefect(checkpoint), null, `${kind}/${frozenWhere}`)
  }
  const incompleteDecision = resumeCheckpointForTest()
  incompleteDecision.decision = {}
  assert.match(resumeCheckpointDefect(incompleteDecision), /decision is incomplete/)
  assert.match(resumeCheckpointDefect(resumeCheckpointForTest({ tree: { index_oid: 'tree1234', files: [], worktree_sha256: RESUME_TEST_TREE.worktree_sha256 } })), /tree files do not match accepted scope/)
})

test('resume checkpoint records a committed file outside the original plan context', () => {
  const checkpoint = resumeCheckpointForTest()
  const source = `file:-:${'b'.repeat(64)}`
  const outside = { path: 'outside-context.mjs', state: 'present', bytes: source }
  const files = [...checkpoint.tree.files, outside].sort((left, right) => left.path.localeCompare(right.path))
  checkpoint.accepted_scope = files.map(({ path }) => path)
  checkpoint.tree = { ...checkpoint.tree, files, worktree_sha256: resumeWorktreeSha256(files) }
  checkpoint.commit = { ...checkpoint.commit, files: files.map(({ path }) => path) }
  assert.equal(resumeCheckpointDefect(checkpoint), null)
  checkpoint.commit.files = ['unwitnessed-context.mjs']
  assert.match(resumeCheckpointDefect(checkpoint), /commit files are not witnessed by accepted scope and tree/)
  checkpoint.commit.files = ['../outside-context.mjs']
  assert.match(resumeCheckpointDefect(checkpoint), /commit files are invalid/)
  checkpoint.commit.files = ['a.mjs', 'a.mjs']
  assert.match(resumeCheckpointDefect(checkpoint), /commit files are invalid/)
  checkpoint.commit.files = ['C:\\outside-context.mjs']
  assert.match(resumeCheckpointDefect(checkpoint), /commit files are invalid/)
})

test('a cold-suite escalation persists the measured checkpoint and its custom suite', () => {
  const plan = planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } })
  const io = fakeIo({
    envelopes: { 'planner:1': plan, 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd': { ok: true, output: '' },
      'gate-cmd:1': { ok: false, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":1,"errored":0}` },
      'gate-cmd:2': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":0,"errored":0}` },
      'gate-cmd': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":0,"errored":0}` },
      'custom-suite': { ok: true, output: '# pass 1\n# fail 0\n' },
      'git write-tree': { ok: true, output: 'tree1234\n' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":1,"errored":0}` } },
    cold: { ok: false, path: '/cold/resume', kept: '/cold/resume', output: 'cold red' },
    changed: ['a.mjs', 'a.test.mjs', 'outside-context.mjs'],
  })
  io.fingerprintTree = () => ({ measured: true, entries: {
    'a.mjs': RESUME_TEST_FILE.bytes,
    'a.test.mjs': `file:-:${'b'.repeat(64)}`,
    'outside-context.mjs': `file:-:${'c'.repeat(64)}`,
  } })
  const result = driveTask({ ...CTX, suite: 'custom-suite', head: 'abc1234' }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  const checkpoint = result.details.resume_checkpoint
  assert.ok(checkpoint)
  assert.equal(checkpoint.kind, 'suite')
  assert.equal(checkpoint.frozen_where, 'cold-suite')
  assert.equal(checkpoint.suite.cmd, 'custom-suite')
  assert.equal(checkpoint.accepted_scope.includes('outside-context.mjs'), true)
  assert.equal(checkpoint.commit.files.includes('outside-context.mjs'), true)
  assert.equal(checkpoint.tree.files.some(({ path }) => path === 'outside-context.mjs'), true)
  assert.equal(checkpoint.tree.worktree_sha256, resumeWorktreeSha256(checkpoint.tree.files))
  assert.equal(resumeCheckpointDefect(checkpoint), null)
})

test('resume reruns canonical gate, warm and cold slots without assigning seats', () => {
  const checkpoint = resumeCheckpointForTest({ frozen_where: 'cold-suite' })
  const io = fakeIo({
    runs: { 'gate-cmd': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}` }, 'custom-suite': { ok: true, output: '# pass 2\n# fail 0\n' } },
    slots: slotFactory({ refusals: [1, 1, 1] }),
  })
  const result = resumeTask({ ...CTX, task: 'resume-slots', suite: 'ignored-suite', files_in_scope: ['a.mjs'], env: { CREW_SUITE_SLOTS: '1' } }, io, checkpoint)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.length, 0)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === 'gate-cmd'), true)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === 'custom-suite'), true)
  assert.deepEqual(io.calls.runCold.map(({ cmd }) => cmd), ['custom-suite'])
  const waits = io.calls.logs.filter((row) => row.event === PHASE_SLOT_WAIT_EVENT)
  assert.deepEqual(waits.map((row) => row.kind).sort(), [SUITE_SLOT_PHASES.gate, SUITE_SLOT_PHASES.warm, SUITE_SLOT_PHASES.cold].sort())
})

test('cold resume failures retain a suite checkpoint and never restart seats', () => {
  for (const [label, cold] of [['red', { ok: false, path: '/cold', kept: '/cold', output: 'red' }], ['unavailable', null]]) {
    const checkpoint = resumeCheckpointForTest({ frozen_where: 'cold-suite' })
    const io = fakeIo({ runs: { 'gate-cmd': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":0,"errored":0}` }, 'custom-suite': { ok: true, output: '# pass 1\n# fail 0\n' } }, cold })
    const result = resumeTask({ ...CTX, task: `resume-cold-${label}`, files_in_scope: ['a.mjs'] }, io, checkpoint)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'cold-suite')
    assert.equal(result.details.resume_checkpoint, checkpoint)
    assert.equal(io.calls.assign.length, 0)
    assert.equal(io.calls.run.some(({ cmd }) => cmd === 'gate-cmd'), true)
    assert.equal(io.calls.run.some(({ cmd }) => cmd === 'custom-suite'), true)
  }
})

test('resumed census failure uses the ordinary escalation carrier before suite or publication', () => {
  const checkpoint = resumeCheckpointForTest({ kind: 'publish', frozen_where: 'publish', publish: { branch: 'feature/resume', base: 'main' } })
  const io = fakeIo({
    runs: {
      'gate-cmd': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":0,"errored":0}` },
      'node crew/census-exhibits.mjs': { ok: true, output: '{"action":"repair","verdict":"red","failures":["a.mjs"],"reason":"repair required"}\n' },
    },
  })
  const ordinary = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': null } }))
  const result = resumeTask({ ...CTX, task: 'resume-census', files_in_scope: ['a.mjs'] }, io, checkpoint)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'census-exhibits')
  for (const key of ['stages', 'dissents', 'extra_rounds_granted', 'growth', 'modifiers', 'enforcements', 'gate', 'cursor', 'head']) assert.ok(Object.hasOwn(result.details, key))
  assert.ok(Object.keys(result.details).length >= Object.keys(ordinary.details).length)
  assert.equal(result.details.resume_checkpoint, checkpoint)
  assert.equal(io.calls.assign.length, 0)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === 'custom-suite' || cmd.startsWith('git push ')), false)
  assert.equal(io.calls.runCold.length, 0)
})

test('E1', () => {
  const file = 'crew/a.mjs'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [file] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [file],
    fenceBases: { [`base-sha:${file}`]: { ok: true, output: fenceBase(30) } },
  })
  const result = driveTask({ ...CTX, head: 'base-sha', laneName: 'own-lane', laneFence: [fenceSpan('own-lane', file, 15, 25), fenceSpan('lane-b', file, 10, 20)] }, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.escalation, null)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.logs.find((entry) => entry.plan_scope)?.plan_scope.verdict, 'plan-scope-undispatched')
})

function scopedIdentityFixture(envelope) {
  const io = fakeIo({})
  io.assign = () => ({ id: 'd1', returnPath: '/tmp/returns/run-1/d1.planner.json' })
  io.wait = () => envelope
  return { io, ctx: { ...CTX, variant: 'scout', run_id: 'run-1' } }
}

test('A2 mismatched run id remains refused', () => {
  const { io, ctx } = scopedIdentityFixture({ ...reconEnv(), assignment_id: 'd1', run_id: 'run-old' })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /run-mismatch/)
  const refusal = io.calls.logs.find((row) => row.envelope_refused)
  assert.equal(refusal.envelope_refused.reason, 'run-mismatch')
  assert.equal(refusal.envelope_refused.found_run_id, 'run-old')
  assert.equal(refusal.envelope_refused.expected_run_id, 'run-1')
})

test('A3 missing run id remains refused for scoped runs', () => {
  const { io, ctx } = scopedIdentityFixture({ ...reconEnv(), assignment_id: 'd1' })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /run-mismatch/)
  const refusal = io.calls.logs.find((row) => row.envelope_refused)
  assert.equal(refusal.envelope_refused.reason, 'run-mismatch')
  assert.equal(refusal.envelope_refused.found_run_id, null)
  assert.equal(refusal.envelope_refused.expected_run_id, 'run-1')
})

test('C1 mismatched assignment id remains refused', () => {
  const { io, ctx } = scopedIdentityFixture({ ...reconEnv(), assignment_id: 'd-old', run_id: 'run-1' })
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /assignment-id-mismatch/)
  const refusal = io.calls.logs.find((row) => row.envelope_refused)
  assert.equal(refusal.envelope_refused.reason, 'assignment-id-mismatch')
})

test('D1 missing assignment id remains tolerated', () => {
  const { io, ctx } = scopedIdentityFixture({ ...reconEnv(), run_id: 'run-1' })
  assert.doesNotThrow(() => driveTask(ctx, io))
  assert.equal(io.calls.logs.some((row) => row.envelope_refused), false)
})
