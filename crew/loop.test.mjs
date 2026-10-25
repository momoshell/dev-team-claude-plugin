import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CHECK_REASONS, proveMutations } from './checks.mjs'
import { DEFAULT_ROUNDS, LOOP_REASONS, runLoop } from './loop.mjs'

const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const finding = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const STAGES = ['plan', 'baseline', 'build', 'gate', 'mutations', 'review', 'suite', 'commit', 'fetch', 'rebase', 'publish']
const SUCCESS = ['seat:planner', 'baseline', 'seat:builder', 'gate', 'mutations', 'seat:reviewer', 'suite', 'commit', 'fetch', 'rebase', 'publish']

// Every effect is a recorded call; nothing touches a model, git, gh, the network or the disk.
// A seat "returns" by writing its envelope into a virtual file the loop then reads back.
function fakes(options = {}) {
  const calls = [], rows = [], requests = [], seen = {}, returns = new Map()
  let reviewTurns = 0
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard', brief: 'operator task',
    acceptance: ['A1'], mutations: [{ check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }],
    files: ['lib.mjs'], subject: 'feat: lane', branch: 'lane', base: 'main', body: 'why', closes: [12], refs: [13],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000, ...options.spec,
  }
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'planner' ? { plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs', acceptance: ['A1'] }
      : request.role === 'builder' ? { summary: 'built' }
      : request.role === 'lead' ? { decision: options.lead ?? 'escalate' }
      : { verdict: options.review && ++reviewTurns <= options.review ? 'changes-needed' : 'pass', findings: options.review && reviewTurns <= options.review ? [finding] : [] },
  })
  const measured = (name, result) => async (input) => {
    calls.push(name); seen[name] = structuredClone(input)
    if (options.throwCheck === name) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return typeof result === 'function' ? result(input) : structuredClone(result)
  }
  const roles = ['planner', 'builder', 'reviewer', 'lead'].filter((role) => !(options.unseated ?? []).includes(role))
  const deps = {
    resolveAgents: () => ({ seats: Object.fromEntries(roles.map((role) => [role, { agent: 'pi', provider: 'test', id: role, effort: 'high', ...(options.bounds?.[role] ? { rounds: options.bounds[role] } : {}) }])), advisor: null }),
    mkdir: async (path, opts) => { calls.push('mkdir'); seen.mkdir = [path, opts] },
    readFile: async (path) => {
      if (options.readError) throw Object.assign(new Error('denied'), { code: options.readError })
      return returns.get(path) ?? ''
    },
    journal: options.journal ?? (async (row) => { rows.push(structuredClone(row)) }),
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`); requests.push(structuredClone(request))
      if (requests.length > 24) throw new Error('fixture turn safety bound')
      if (options.seatThrows === request.role) throw new Error('seat crashed')
      if (options.seatRejects === request.role) return Promise.reject(new Error('seat rejected'))
      let value = envelope(request)
      if (options.edit) value = options.edit(value, request) ?? value
      returns.set(request.returnPath, typeof value === 'string' ? value : JSON.stringify(value))
    },
    checkBaseline: measured('baseline', 'baseline' in options ? options.baseline : { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] } }),
    runGate: measured('gate', options.gate ?? { ...green(), failingIds: [] }),
    proveMutations: measured('mutations', 'proof' in options ? options.proof : { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }] }),
    runSuite: measured('suite', options.suite ?? green()),
    commitChanges: measured('commit', options.commit ?? { status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }),
    run: measured('fetch', options.fetch ?? green()),
    rebaseBranch: measured('rebase', options.rebase ?? { status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: measured('publish', options.publish ?? { status: 'green', reason: null, pr: PR }),
    ...options.deps,
  }
  return { spec, deps, calls, rows, requests, seen, go: () => runLoop(spec, deps) }
}
const count = (f, role) => f.requests.filter((r) => r.role === role).length
const stopped = (reason) => ({ status: 'stopped', reason, pr: null })

// MUTATION: return pr null from the success result and the published PR is lost.
test('a green run walks every stage in order and returns the measured PR with each input forwarded', async () => {
  const f = fakes()
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.deepEqual(f.calls, ['mkdir', ...SUCCESS])
  assert.deepEqual(f.seen.mkdir, ['/virtual/task', { recursive: true }])
  assert.deepEqual(f.seen.baseline, { cwd: '/virtual/checkout', gatePath: '/virtual/task/gate.mjs', timeoutMs: 5000 })
  assert.deepEqual(f.seen.gate, f.seen.baseline)
  assert.deepEqual(f.seen.mutations, { cwd: '/virtual/checkout', gatePath: '/virtual/task/gate.mjs', checks: ['A1'], mutations: f.spec.mutations, timeoutMs: 5000 })
  assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.commit, { cwd: '/virtual/checkout', files: ['lib.mjs'], subject: 'feat: lane', body: 'why', closes: [12], refs: [13], timeoutMs: 5000 })
  assert.deepEqual(f.seen.fetch, { cwd: '/virtual/checkout', command: 'git', args: ['fetch', 'origin'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.rebase, { cwd: '/virtual/checkout', base: 'main', timeoutMs: 5000 })
  assert.deepEqual(f.seen.publish, { cwd: '/virtual/checkout', branch: 'lane', base: 'main', title: 'feat: lane', body: 'why', closes: [12], refs: [13], timeoutMs: 5000 })
  const planner = f.requests[0]
  assert.deepEqual(Object.keys(planner).sort(), ['brief', 'feedback', 'gatePath', 'id', 'planPath', 'returnPath', 'role', 'seat'])
  assert.deepEqual(f.requests[1], { ...f.requests[1], role: 'builder', planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', feedback: [] })
  assert.equal(new Set(f.requests.map((r) => r.id)).size, f.requests.length)
  assert.equal(new Set(f.requests.map((r) => r.returnPath)).size, f.requests.length)
})

// MUTATION: skip the baseline acceptance branch and a green baseline lets the builder start.
test('a green, unmeasured, malformed or contradictory baseline stops before the builder', async () => {
  const redRun = { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] }
  const cases = [
    [{ accepted: false, reason: 'baseline-green', result: { ...green(), failingIds: [] } }, 'baseline-green'],
    [{ accepted: false, reason: 'baseline-unmeasured', result: {} }, 'baseline-unmeasured'],
    [{ accepted: true, reason: 'gate-failed', result: { ...redRun, failingIds: [] } }, 'runner-threw'],
    [{ accepted: true, reason: 'gate-failed', result: { ...redRun, status: 'green', reason: null } }, 'runner-threw'],
    [{ accepted: true, reason: 'gate-no-fail', result: { ...redRun, reason: 'gate-no-fail' } }, 'runner-threw'],
    [{ accepted: true, reason: 'made-up', result: redRun }, 'runner-threw'],
    [{ reason: 'gate-failed' }, 'runner-threw'],
    ['red', 'runner-threw'],
    [null, 'runner-threw'],
  ]
  for (const [baseline, reason] of cases) {
    const f = fakes({ baseline })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(baseline))
    assert.equal(count(f, 'builder'), 0)
    assert.deepEqual(f.calls.slice(-2), ['seat:planner', 'baseline'])
  }
})

// MUTATION: treat every envelope as valid and a refused return advances the loop.
test('a refused, unreadable, empty or stale envelope stops the lane and a lead accept never launders it', async () => {
  const cases = {
    'unknown field': [{ edit: (v) => ({ ...v, forbidden: true }) }, 'envelope-refused'],
    'wrong id': [{ edit: (v) => ({ ...v, id: 'stale-return' }) }, 'envelope-refused'],
    'wrong role': [{ edit: (v) => ({ ...v, role: 'builder', details: { summary: 'x' } }) }, 'envelope-refused'],
    'null': [{ edit: () => 'null' }, 'envelope-refused'],
    'array': [{ edit: () => '[]' }, 'envelope-refused'],
    'malformed json': [{ edit: () => '{' }, 'envelope-refused'],
    'incomplete details': [{ edit: (v) => ({ ...v, details: { plan_path: 'p' } }) }, 'envelope-refused'],
    'empty file': [{ edit: () => '' }, 'seat-unmeasured'],
    'EPERM': [{ readError: 'EPERM' }, 'seat-unmeasured'],
    'ENOENT': [{ readError: 'ENOENT' }, 'seat-unmeasured'],
    'seat throws': [{ seatThrows: 'planner' }, 'seat-unmeasured'],
    'seat rejects': [{ seatRejects: 'planner' }, 'seat-unmeasured'],
  }
  for (const [name, [options, reason]] of Object.entries(cases)) {
    const f = fakes({ lead: 'accept', ...options })
    assert.deepEqual(await f.go(), stopped(reason), name)
    assert.equal(count(f, 'lead'), 0, name)
    assert.equal(f.calls.includes('baseline'), false, name)
    assert.equal(count(f, 'builder'), 0, name)
  }
  const stale = fakes({ edit: (v, r) => r.role === 'builder' ? { ...v, id: 'lane.planner.1' } : v })
  assert.deepEqual(await stale.go(), stopped('envelope-refused'))
  assert.equal(stale.calls.includes('gate'), false)
})

// MUTATION: let the planner's acceptance differ from the declared one and a proof check is silently dropped.
test('a planner acceptance that is not the declared set stops before the baseline', async () => {
  for (const acceptance of [['A2'], ['A1', 'A2']]) {
    const f = fakes({ edit: (v) => v.role === 'planner' ? { ...v, details: { ...v.details, acceptance } } : v })
    assert.deepEqual(await f.go(), stopped('envelope-refused'))
    assert.equal(f.calls.includes('baseline'), false)
  }
})

// MUTATION: drop the changes-needed branch and the findings never reach a second build.
test('changes-needed carries the exact findings to the next build and repeats gate, proof and review before the suite', async () => {
  const f = fakes({ review: 1 })
  assert.equal((await f.go()).status, 'done')
  const builders = f.requests.filter((r) => r.role === 'builder')
  assert.equal(builders.length, 2)
  assert.deepEqual(builders[0].feedback, [])
  assert.deepEqual(builders[1].feedback, [finding])
  assert.deepEqual(f.calls.slice(1, 12), ['seat:planner', 'baseline', 'seat:builder', 'gate', 'mutations', 'seat:reviewer', 'seat:builder', 'gate', 'mutations', 'seat:reviewer', 'suite'])
  assert.equal(f.calls.filter((c) => c === 'baseline').length, 1)
  assert.equal(count(f, 'planner'), 1)
})

// MUTATION: drop the per-role bound check and a seat is dispatched past its declared rounds.
test('a declared bound ends in the lead and the default bound is two', async () => {
  assert.equal(DEFAULT_ROUNDS, 2)
  const declared = fakes({ review: 10, bounds: { builder: 1 } })
  assert.deepEqual(await declared.go(), stopped('lead-escalated'))
  assert.equal(count(declared, 'builder'), 1)
  assert.equal(count(declared, 'lead'), 1)
  assert.equal(declared.calls.includes('commit'), false)
  const byDefault = fakes({ review: 10 })
  assert.deepEqual(await byDefault.go(), stopped('lead-escalated'))
  assert.equal(count(byDefault, 'builder'), 2)
  assert.equal(count(byDefault, 'reviewer'), 2)
})

// MUTATION: reset the obstructed seat's bound on a bounce and the retry becomes unlimited.
test('a lead bounce grants one retry, repeated bounces are bounded by the lead and an escalate ends the lane', async () => {
  const once = fakes({ review: 1, bounds: { builder: 1 }, lead: 'bounce' })
  assert.equal((await once.go()).status, 'done')
  assert.equal(count(once, 'lead'), 1)
  assert.equal(count(once, 'builder'), 2)
  const repeated = fakes({ review: 10, bounds: { builder: 1, reviewer: 10 }, lead: 'bounce' })
  assert.deepEqual(await repeated.go(), stopped('round-bound'))
  assert.equal(count(repeated, 'lead'), 2)
  assert.equal(count(repeated, 'builder'), 3)
  assert.equal(repeated.calls.includes('commit'), false)
  const retried = fakes({ lead: 'bounce', edit: (v, r) => r.role === 'planner' && r.id.endsWith('.1') ? { ...v, status: 'insufficient' } : v })
  assert.equal((await retried.go()).status, 'done')
  assert.equal(count(retried, 'planner'), 2)
})

// MUTATION: grant a whole extra round on every bounce and a seat with turns left outruns its bound unsupervised.
test('a lead bounce on a seat with turns left does not raise its bound, so the next exhausted bound is put to the lead again', async () => {
  const f = fakes({ review: 2, lead: 'bounce', edit: (v) => v.id === 'lane.builder.2' ? { ...v, status: 'insufficient' } : v })
  await f.go()
  assert.deepEqual(f.requests.map((r) => r.role).slice(0, 7), ['planner', 'builder', 'lead', 'builder', 'reviewer', 'lead', 'builder'])
})

// MUTATION: let accept pass with no valid envelope and a bound or lead decision stands in for a measurement.
test('a lead accept releases only a valid non-done envelope and never an exhausted bound', async () => {
  const escalated = fakes({ lead: 'accept', edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate' } : v })
  assert.equal((await escalated.go()).status, 'done')
  assert.equal(count(escalated, 'lead'), 1)
  assert.deepEqual(escalated.requests.find((r) => r.role === 'lead').feedback.map((x) => [x.role, x.reason, x.envelope.status]), [['planner', 'escalate', 'escalate']])
  const exhausted = fakes({ lead: 'accept', review: 10, bounds: { builder: 1 } })
  assert.deepEqual(await exhausted.go(), stopped('accept-unmeasured'))
  assert.equal(exhausted.calls.includes('commit'), false)
  const changes = fakes({ lead: 'accept', review: 10, edit: (v) => v.role === 'reviewer' ? { ...v, status: 'escalate' } : v })
  assert.notEqual((await changes.go()).status, 'done')
  assert.equal(changes.calls.includes('suite'), false)
  const gateStillRuns = fakes({ lead: 'accept', gate: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] }, edit: (v) => v.role === 'builder' ? { ...v, status: 'escalate' } : v })
  assert.deepEqual(await gateStillRuns.go(), stopped('gate-failed'))
})

// MUTATION: consult a missing lead anyway, or let a bad lead envelope decide.
test('an unseated, refusing or insufficient lead stops without recursion', async () => {
  const none = fakes({ unseated: ['lead'], edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate' } : v })
  assert.deepEqual(await none.go(), stopped('lead-unavailable'))
  assert.equal(count(none, 'lead'), 0)
  const bad = fakes({ edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate' } : v.role === 'lead' ? { ...v, extra: 1 } : v })
  assert.deepEqual(await bad.go(), stopped('lead-refused'))
  assert.equal(count(bad, 'lead'), 1)
  const insufficient = fakes({ edit: (v) => v.role === 'planner' || v.role === 'lead' ? { ...v, status: 'insufficient' } : v })
  assert.deepEqual(await insufficient.go(), stopped('lead-refused'))
  assert.equal(count(insufficient, 'lead'), 1)
  const crashed = fakes({ seatThrows: 'lead', edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate' } : v })
  assert.deepEqual(await crashed.go(), stopped('lead-refused'))
})

// MUTATION: drop the overall proof decision and a surviving or incomplete proof reaches review.
test('a surviving, unmeasured, missing, duplicate, wrong-check or thrown proof never reaches review or commit', async () => {
  const killed = { check: 'A1', outcome: 'killed', reason: null }
  const cases = [
    [{ status: 'red', reason: 'mutations-survived', rows: [{ check: 'A1', outcome: 'survived', reason: 'gate-green' }] }, 'mutations-survived'],
    [{ status: 'unmeasured', reason: 'mutation-unmeasured', rows: [{ check: 'A1', outcome: 'unmeasured', reason: 'timeout' }] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null, rows: [] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'unmeasured', reason: 'timeout' }] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null, rows: [killed, killed] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null, rows: [{ ...killed, check: 'A2' }] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: null, rows: [{ ...killed, reason: 'timeout' }] }, 'mutation-unmeasured'],
    [{ status: 'green', reason: 'gate-green', rows: [killed] }, 'runner-threw'],
    [{ status: 'purple', reason: null, rows: [killed] }, 'runner-threw'],
    [null, 'runner-threw'],
  ]
  for (const [proof, reason] of cases) {
    const f = fakes({ proof })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(proof))
    assert.equal(f.calls.includes('commit'), false)
    assert.equal(count(f, 'reviewer'), 0)
  }
  const thrown = fakes({ throwCheck: 'mutations' })
  assert.deepEqual(await thrown.go(), stopped('runner-threw'))
  assert.equal(count(thrown, 'reviewer'), 0)
  const empty = fakes({ spec: { mutations: [] }, deps: { proveMutations: (input) => proveMutations(input) } })
  assert.deepEqual(await empty.go(), stopped('invalid-mutations'))
  assert.equal(count(empty, 'reviewer'), 0)
})

// MUTATION: trust a non-green gate and the review and commit run on a build that does not pass.
test('a build that does not leave the gate green stops before proof, review and commit', async () => {
  const cases = [
    [{ ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] }, 'gate-failed'],
    [{ ...green(), status: 'unmeasured', code: null, reason: 'timeout' }, 'timeout'],
    [{ ...green(), code: 1, failingIds: [] }, 'runner-threw'],
    [{ ...green(), timedOut: true, failingIds: [] }, 'runner-threw'],
    [{ ...green(), reason: 'gate-failed', failingIds: [] }, 'runner-threw'],
  ]
  for (const [gate, reason] of cases) {
    const f = fakes({ gate })
    assert.deepEqual(await f.go(), stopped(reason))
    assert.equal(f.calls.includes('mutations'), false)
    assert.equal(count(f, 'reviewer'), 0)
  }
})

// MUTATION: skip the suite decision and a red or unmeasured suite still commits.
test('a red, unmeasured or malformed-green suite never commits', async () => {
  const cases = [
    [{ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }, 'exit-nonzero'],
    [{ ...green(), status: 'unmeasured', code: null, reason: 'timeout' }, 'timeout'],
    [{ ...green(), code: 1 }, 'runner-threw'],
    [{ ...green(), signal: 'SIGKILL' }, 'runner-threw'],
    [{ ...green(), timedOut: true }, 'runner-threw'],
    [{ ...green(), reason: 'timeout' }, 'runner-threw'],
    [{ status: 'green' }, 'runner-threw'],
  ]
  for (const [suite, reason] of cases) {
    const f = fakes({ suite })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(suite))
    assert.equal(f.calls.includes('commit'), false)
  }
})

// MUTATION: continue past a failed publication effect and a later effect runs on an unproven state.
test('a failed commit, fetch, rebase or publish stops every later effect and returns one enum reason', async () => {
  const bad = (reason) => ({ status: 'red', reason })
  const cases = [
    [{ commit: bad('nothing-to-commit') }, 'nothing-to-commit', 'commit'],
    [{ commit: { status: 'green', reason: null } }, 'runner-threw', 'commit'],
    [{ fetch: { ...green(), status: 'unmeasured', code: null, reason: 'timeout' } }, 'timeout', 'fetch'],
    [{ fetch: { ...green(), code: 128 } }, 'runner-threw', 'fetch'],
    [{ rebase: { status: 'red', reason: 'rebase-conflict', conflicts: ['x'] } }, 'rebase-conflict', 'rebase'],
    [{ rebase: { status: 'green', reason: null } }, 'runner-threw', 'rebase'],
    [{ publish: { status: 'unmeasured', reason: 'pr-unmeasured' } }, 'pr-unmeasured', 'publish'],
    [{ publish: { status: 'green', reason: null, pr: null } }, 'runner-threw', 'publish'],
    [{ publish: { status: 'green', reason: null } }, 'runner-threw', 'publish'],
    [{ publish: { status: 'red', reason: 'invented' } }, 'runner-threw', 'publish'],
  ]
  for (const [options, reason, failedAt] of cases) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped(reason), failedAt)
    const order = ['commit', 'fetch', 'rebase', 'publish']
    assert.deepEqual(f.calls.filter((c) => order.includes(c)), order.slice(0, order.indexOf(failedAt) + 1))
    assert.ok(LOOP_REASONS.includes(reason))
  }
  const thrown = fakes({ throwCheck: 'rebase' })
  assert.deepEqual(await thrown.go(), stopped('runner-threw'))
  assert.equal(thrown.calls.includes('publish'), false)
})

// MUTATION: drop the stage-end emit and a refused or thrown stage never closes in the journal.
test('every started stage ends on success and refusal, in order', async () => {
  const pairs = (rows) => rows.filter((r) => r.event === 'stage-start' || r.event === 'stage-end').map((r) => [r.event, r.stage])
  const ok = fakes()
  await ok.go()
  assert.deepEqual(pairs(ok.rows), STAGES.flatMap((s) => [['stage-start', s], ['stage-end', s]]))
  assert.ok(ok.rows.every((r) => r.lane === 'lane' && typeof r.event === 'string' && 'stage' in r))
  const refused = fakes({ suite: { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' } })
  await refused.go()
  assert.deepEqual(pairs(refused.rows), STAGES.slice(0, 7).flatMap((s) => [['stage-start', s], ['stage-end', s]]))
  const thrown = fakes({ deps: { mkdir: async () => {}, resolveAgents: undefined } })
  assert.deepEqual(await thrown.go(), stopped('invalid-input'))
  const lead = fakes({ edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate' } : v })
  await lead.go()
  assert.deepEqual(pairs(lead.rows), [['stage-start', 'plan'], ['stage-start', 'lead'], ['stage-end', 'lead'], ['stage-end', 'plan']])
  const crashing = fakes({ deps: { readFile: async () => { throw new Error('boom') } } })
  await crashing.go()
  assert.deepEqual(pairs(crashing.rows), [['stage-start', 'plan'], ['stage-end', 'plan']])
})

// MUTATION: close a stage only after its work succeeds and a stage that throws is left open in the journal.
test('a stage whose work throws still ends in the journal and the lane stops runner-threw', async () => {
  // a rejection with no string form makes describe() throw inside the seat turn, so the exception reaches the stage
  const f = fakes({ deps: { runSeat: async () => { throw Object.create(null) } } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  const ends = f.rows.filter((r) => r.event === 'stage-start' || r.event === 'stage-end')
  assert.deepEqual(ends.map((r) => [r.event, r.stage]), [['stage-start', 'plan'], ['stage-end', 'plan']])
  assert.equal(typeof ends[1].outcome.threw.message, 'string')
  assert.equal(f.calls.includes('baseline'), false)
})

// MUTATION: drop the journal call and the lane leaves no observation record.
test('the journal carries each envelope, verdict, check, commit and PR observation and a failing journal changes nothing', async () => {
  const f = fakes()
  const success = await f.go()
  const events = (name) => f.rows.filter((r) => r.event === name)
  assert.deepEqual(events('envelope').map((r) => [r.role, r.id, r.parsed.status, r.defects, r.error]), [
    ['planner', 'lane.planner.1', 'done', [], null], ['builder', 'lane.builder.2', 'done', [], null], ['reviewer', 'lane.reviewer.3', 'done', [], null],
  ])
  assert.deepEqual(events('check').map((r) => r.check), ['baseline', 'gate', 'mutations', 'suite', 'commit', 'fetch', 'rebase', 'publish'])
  assert.deepEqual(events('check')[0].result.result.failingIds, ['A1'])
  assert.deepEqual(events('verdict').map((r) => [r.status, r.verdict]), [['reviewed', 'pass']])
  assert.deepEqual(events('commit').map((r) => r.head), ['a'.repeat(40)])
  assert.deepEqual(events('pr').map((r) => r.pr), [PR])
  const stoppedRun = fakes({ proof: { status: 'red', reason: 'mutations-survived', rows: [{ check: 'A1', outcome: 'survived', reason: 'gate-green' }] } })
  await stoppedRun.go()
  const verdict = stoppedRun.rows.find((r) => r.event === 'verdict')
  assert.deepEqual([verdict.status, verdict.reason, verdict.observation.rows[0].outcome], ['stopped', 'mutations-survived', 'survived'])
  const malformed = fakes({ suite: { status: 'green', reason: 'timeout' } })
  await malformed.go()
  assert.equal(malformed.rows.find((r) => r.event === 'check' && r.check === 'suite').result.reason, 'timeout')
  for (const journal of [() => { throw new Error('sync full') }, async () => { throw new Error('async full') }, () => Promise.reject(new Error('rejected'))]) {
    assert.deepEqual(await fakes({ journal }).go(), success)
    assert.deepEqual(await fakes({ journal, suite: { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' } }).go(), stopped('exit-nonzero'))
  }
})

// MUTATION: skip input validation and an unsupported or malformed lane starts effects.
test('an unsupported shape, invalid input or unsound seam is refused before any effect', async () => {
  const cases = [
    [{ shape: 'stepped' }, 'unsupported-shape'], [{ shape: 'finish' }, 'unsupported-shape'], [{ shape: undefined }, 'unsupported-shape'],
    [{ tier: 'rigorous' }, 'invalid-input'], [{ id: '' }, 'invalid-input'], [{ cwd: 3 }, 'invalid-input'], [{ taskDir: undefined }, 'invalid-input'],
    [{ brief: '' }, 'invalid-input'], [{ acceptance: [] }, 'invalid-input'], [{ acceptance: ['A1', 'A1'] }, 'invalid-input'],
    [{ files: [] }, 'invalid-input'], [{ mutations: null }, 'invalid-input'], [{ suite: null }, 'invalid-input'], [{ suite: { command: '' } }, 'invalid-input'],
    [{ subject: '' }, 'invalid-input'], [{ branch: undefined }, 'invalid-input'], [{ base: undefined }, 'invalid-input'],
    [{ timeoutMs: 0 }, 'invalid-input'], [{ timeoutMs: -1 }, 'invalid-input'], [{ timeoutMs: 1.5 }, 'invalid-input'], [{ timeoutMs: Infinity }, 'invalid-input'],
    [{ closes: 12 }, 'invalid-input'], [{ title: 3 }, 'invalid-input'],
  ]
  for (const [spec, reason] of cases) {
    const f = fakes({ spec })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(spec))
    assert.deepEqual([f.calls, f.rows], [[], []])
  }
  for (const name of ['runSeat', 'journal', 'readFile', 'checkBaseline', 'openPullRequest', 'run']) {
    const f = fakes({ deps: { [name]: undefined } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), name)
    assert.deepEqual(f.calls, [])
  }
  assert.deepEqual(await runLoop(null, {}), stopped('invalid-input'))
  assert.deepEqual(await runLoop(fakes().spec), stopped('invalid-input'))
})

// MUTATION: treat a missing role, a failed lookup or a bad bound as usable and the lane starts with a hole.
test('a missing required seat, failed agent lookup or invalid declared bound is refused before any effect', async () => {
  for (const role of ['planner', 'builder', 'reviewer']) {
    const f = fakes({ unseated: [role] })
    assert.deepEqual(await f.go(), stopped('seat-unmeasured'), role)
    assert.deepEqual(f.calls, [])
  }
  const lookup = fakes({ deps: { resolveAgents: () => { throw new Error('agent definitions are refused') } } })
  assert.deepEqual(await lookup.go(), stopped('seat-unmeasured'))
  assert.deepEqual(lookup.calls, [])
  for (const rounds of [0, -1, 1.5, '2', null, Infinity]) {
    const f = fakes({ deps: { resolveAgents: () => ({ seats: { planner: { rounds }, builder: {}, reviewer: {}, lead: {} } }) } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), String(rounds))
    assert.deepEqual(f.calls, [])
  }
})

// MUTATION: let a mkdir failure continue and the seats write into a task directory that does not exist.
test('a task directory that cannot be made stops the lane before any seat', async () => {
  const f = fakes({ deps: { mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  assert.equal(count(f, 'planner'), 0)
})

// MUTATION: a reason outside the closed enum leaks into the result.
test('every stopped reason is a member of the closed enum', async () => {
  assert.ok(Object.isFrozen(LOOP_REASONS))
  for (const reason of CHECK_REASONS) assert.ok(LOOP_REASONS.includes(reason))
  for (const reason of ['unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'lead-escalated', 'lead-unavailable', 'lead-refused', 'accept-unmeasured', 'round-bound']) assert.ok(LOOP_REASONS.includes(reason))
  const f = fakes({ suite: { status: 'red', reason: 'free text the enum has never heard of' } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
})

// MUTATION: import an old runtime module, or wire the loop into one, and the isolated lane is no longer isolated.
test('the loop imports only builtins and the three contract modules, and no old-path module imports it', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const source = readFileSync(join(dir, 'loop.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/^(?:import|} from|export [^\n]* from)[^'\n]*'([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(specifiers, ['./agents.mjs', './checks.mjs', './protocols.mjs', 'node:fs/promises', 'node:path'])
  const importers = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && e.name !== 'loop.mjs')
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => /['"][^'"]*\/loop\.mjs['"]/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(importers, [])
})
