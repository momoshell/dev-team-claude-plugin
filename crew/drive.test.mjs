// crew/drive.test.mjs — the mechanical loop as TESTED CODE (the point of v3).
// Every path through driveTask is exercised with a fake io: happy path,
// red-lane bounce, scope bounce, review bounce, insufficient->lead consult,
// bounce exhaustion->accept/escalate, out-of-set lead answers, commit gating.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  driveTask, LIMITS, DECISIONS, SECOND_OPINION, PERSPECTIVE_TARGETS,
  validateScopeEntries, scopeMatcher, composeCommitMessage,
  parseGateSummary, baselineGateDefect, GATE_SUMMARY_PREFIX,
  FINDING_SEVERITIES, reviewFindings, reviewOutcome,
  CARVE_VERDICTS, validateCarve, GROWTH_DIVERGENCE_FACTOR, growthRecord, growthLines,
} from './drive.mjs'

const TD = '/tmp/fake-task'
const CTX = Object.freeze({
  task: 't1', briefFile: '/tmp/brief.md', taskDir: TD, checkout: '/tmp/repo',
  roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
})

// Scripted fake io: `script` maps `${role}:${n-th call}` -> envelope; runs and
// git are scripted per call. Everything is recorded for assertions.
function fakeIo({ envelopes = {}, runs = {}, changed = [], cleanRuns = null, cleanThrows = false, showDoc = false, emit = false, files = {} } = {}) {
  const calls = { assign: [], run: [], runClean: [], commits: [], writes: {}, logs: [], showDoc: [], emits: [], files }
  const counts = {}
  const changedQueue = Array.isArray(changed[0]) ? [...changed] : [changed]
  const io = {
    calls,
    assign({ role, briefFile }) {
      counts[role] = (counts[role] || 0) + 1
      calls.assign.push({ role, briefFile, n: counts[role] })
      return { id: `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
    },
    wait(returnPath) {
      const env = envelopes[returnPath]
      return typeof env === 'function' ? env() : env ?? null
    },
    writeFile(path, content) { calls.writes[path] = content },
    readFile(p) { return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null },
    run(cmd) {
      counts[cmd] = (counts[cmd] || 0) + 1
      calls.run.push({ cmd, n: counts[cmd] })
      const r = runs[`${cmd}:${counts[cmd]}`] ?? runs[cmd] ?? { ok: true, output: '' }
      return r
    },
    changedFiles() { return changedQueue.length > 1 ? changedQueue.shift() : changedQueue[0] },
    commit(files, message) { calls.commits.push({ files, message }); return 'abc1234' },
    status(label) { (calls.status ||= []).push(label) },
    log(obj) { calls.logs.push(obj) },
    now() { return 0 },
  }
  if (cleanRuns || cleanThrows) {
    io.runClean = (cmd) => {
      counts[`clean:${cmd}`] = (counts[`clean:${cmd}`] || 0) + 1
      calls.runClean.push({ cmd, n: counts[`clean:${cmd}`] })
      if (cleanThrows) throw new Error("runClean: git stash pop FAILED — the checkout is half-restored and the builder's work is in the stash")
      return cleanRuns[`${cmd}:${counts[`clean:${cmd}`]}`] ?? cleanRuns[cmd] ?? { ok: false, output: '' }
    }
  }
  if (showDoc) io.showDoc = (p) => { calls.showDoc.push(p) }
  if (emit) io.emit = emit === true ? (event) => { calls.emits.push(event) } : emit
  return io
}

const planEnv = (over = {}) => ({
  status: 'done', role: 'planner', summary: 'planned',
  artifacts: [`${TD}/plan.md`],
  details: { plan_path: `${TD}/plan.md`, files_in_scope: ['a.mjs', 'a.test.mjs'], validation_lane: 'lane-cmd', consult_questions: [], carve_verdict: 'proceed' },
  ...over,
})
const buildEnv = (over = {}) => ({
  status: 'done', role: 'builder', summary: 'built',
  details: { files_changed: ['a.mjs', 'a.test.mjs'], commit_message: 'feat: the change' }, ...over,
})
const reviewEnv = (verdict, findings) => ({
  status: 'done', role: 'reviewer', summary: 'reviewed',
  details: {
    verdict, review_path: `${TD}/review.md`, must_fix: verdict === 'pass' ? 0 : 1,
    ...(findings === undefined ? {} : { findings }),
  },
})
const checkEnv = (verdict) => ({
  status: 'done', role: 'tech-lead', summary: 'checked',
  details: { verdict, check_path: `${TD}/plan-check.md` },
})
const CTX_TL = Object.freeze({ ...CTX, roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'] })
const leadEnv = (decision, guidance = 'do X then Y in a.mjs') => ({
  status: 'done', role: 'lead', details: { decision, reason: 'because', guidance },
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
    { id: 'RV1-2', severity: 'should-fix', location: 'a.mjs:12', summary: 'second' },
    { id: 'RV1-1', severity: 'must-fix', location: 'b.mjs:3', summary: 'first' },
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
  assert.deepEqual(out.findings, [{ id: 'ok-1', severity: 'must-fix', location: null, summary: null }])
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
    { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'failure scenario' },
  ]))
  assert.deepEqual(withFindings.result, without.result)
  assert.ok(withFindings.io.calls.logs.some((line) => line.review_outcome?.findings?.some((f) => f.id === 'RV1-1')))
  const note = withFindings.io.calls.logs.find((line) => line.review_findings_note)?.review_findings_note
  assert.deepEqual(note?.count_mismatch, ['must_fix'])
})

test('the shared charter and validator agree on the findings contract', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = charter.indexOf('## Envelope details fields')
  const end = charter.indexOf('## Gate triage', start)
  assert.ok(start >= 0 && end > start)
  const block = charter.slice(start, end)
  for (const token of ['"findings"', '"id"', '"severity"']) assert.ok(block.includes(token))
  const severityField = block.match(/"severity":\s*([^\n]+)/)?.[1]
  assert.ok(severityField)
  const documented = [...severityField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(documented, [...FINDING_SEVERITIES])
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
  assert.throws(() => driveTask(CTX, io), /lead: no valid envelope/)
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

test('red full suite after review pass escalates and never commits', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'boom' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  assert.match(res.details.escalation.why, /suite red/i)
})

test('planner envelope without files_in_scope escalates — the scope gate cannot be skipped', () => {
  const env = planEnv(); delete env.details.files_in_scope
  const io = fakeIo({ envelopes: { 'planner:1': env } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /files_in_scope/)
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
  assert.deepEqual(res.details.dissents[0], { from: 'reviewer', recommendation: 'bounce', lead_decision: 'accept', consult: 1 })
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

test('gate-first: green baseline bounces the planner; repaired gate red at baseline proceeds; gate green after build -> done', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-v1' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-v2' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-v2' } },
    },
    runs: { 'gate-v1': { ok: true, output: '' }, 'gate-v2': { ok: true, output: '' } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /STILL green at baseline/)
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

test('repeated gate failures trigger reviewer triage; gate-defect diagnosis lets the planner repair once and re-runs without a builder round', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

// REGRESSION: realIo.runClean is a shorthand METHOD that calls `this.run(cmd)`
// (crew/realio.mjs:241,245). #130 routed the reverify call through
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  // Exactly realIo's shape: a method that reaches its sibling through `this`.
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

test("a failed first-green proof bounces the PLANNER for a gate repair, never the builder", () => {
  const pristineOutput = 'green pristine output — the gate did not inspect the work'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.ok(io.calls.writes[`${TD}/gate-discrimination-bounce.md`].includes(pristineOutput))
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

test('a no-summary failed proof routes through the planner repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /printed no GATE-SUMMARY/)
})

test('a THREW failed proof routes through the planner repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /THREW/)
})

test('a second failed proof escalates after the single gate repair is spent', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.runClean.length, 2)
})

test('a triage repair with a failed no-summary re-proof escalates without a second planner repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('a failed proof repaired to a red built-tree gate bounces the builder, then proceeds', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

test('a failed proof whose planner repair omits gate_cmd escalates without a commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'planner:2': { status: 'done', role: 'planner', summary: 'no gate returned', details: {} },
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
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 0)
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-cmd' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

// --- #153: baseline-red must mean the gate RAN, not merely that it exited ----
const RED = (n = 3) => `some failure\n${GATE_SUMMARY_PREFIX} {"total":${n},"failed":${n},"errored":0}`
const THREW = `FAIL x: expected the check to run, found it threw: linkSync is not defined\n${GATE_SUMMARY_PREFIX} {"total":47,"failed":1,"errored":1}`

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

test('#153: a baseline whose checks THREW bounces the planner and does NOT spend the gate repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

test('#153: a baseline with no summary line at all is treated as a defective gate', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-silent' } }),
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-still-broken' } },
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
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-vacuous' } },
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

test('an envelope with a MISMATCHED assignment_id is rejected (stale-file replay guard)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ assignment_id: 'd9-from-a-previous-run' }) },
  })
  assert.throws(() => driveTask(CTX, io), /planner: no valid envelope/)
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

test('escalation artifacts and exhaustion briefs cite the REAL journal path from ctx', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': leadEnv('escalate') },
  })
  const res = driveTask({ ...CTX, journal: '/real/crew/journal.jsonl' }, io)
  assert.equal(res.status, 'escalation')
  assert.ok(res.artifacts.includes('/real/crew/journal.jsonl'))
  assert.ok(!res.artifacts.some((a) => a === `${TD}/journal.jsonl`))
})

test('a gate repair records the replaced command in the gate audit trail', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong target' } },
      'planner:2': { status: 'done', role: 'planner', details: { gate_cmd: 'gate-fixed' } },
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

test('DECISIONS and LIMITS are the frozen public contract', () => {
  assert.ok(Object.isFrozen(DECISIONS) && Object.isFrozen(LIMITS))
  assert.deepEqual([...DECISIONS], ['bounce', 'accept', 'escalate'])
  assert.equal(SECOND_OPINION, 'second-opinion')
  assert.ok(Object.isFrozen(PERSPECTIVE_TARGETS))
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
  assert.equal(decisions.filter((body) => /^- bounce$/m.test(body)).length, 1)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'review', round: 3 }])
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

test('an omitted gate_path journals an explicit null rejection value', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX_TL, io).status, 'done')
  const rejection = io.calls.logs.find((line) => Object.hasOwn(line, 'gate_path_rejected'))
  assert.ok(rejection)
  assert.equal(rejection.gate_path_rejected, null)
  assert.deepEqual(JSON.parse(JSON.stringify(rejection)), { at: 0, gate_path_rejected: null })
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

const planRevisionRun = (revision, over = {}) => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': revision, 'tech-lead:2': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], ...over,
  })
  return { io, result: driveTask(CTX_TL, io) }
}

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

test('a gate-repair planner dispatch is not mistaken for a plan revision carve check', () => {
  const repaired = planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-fixed' } })
  delete repaired.details.carve_verdict
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong gate' } },
      'planner:2': repaired, 'reviewer:2': reviewEnv('pass'),
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
