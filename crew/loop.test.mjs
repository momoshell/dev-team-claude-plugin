import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CHECK_REASONS } from './checks.mjs'
import { DEFAULT_ROUNDS, LOOP_REASONS, runLoop } from './loop.mjs'

const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const finding = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const STAGES = ['plan', 'baseline', 'build', 'gate', 'mutations', 'review-paths', 'review', 'suite', 'paths', 'commit', 'fetch', 'rebase', 'publish']
const SUCCESS = ['seat:planner', 'baseline', 'seat:builder', 'gate', 'mutations', 'review-paths', 'seat:reviewer', 'suite', 'paths', 'commit', 'fetch', 'rebase', 'publish']
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }

// Every effect is a recorded call; nothing touches a model, git, gh, the network or the disk.
// A seat "returns" by writing its envelope into a virtual file the loop then reads back.
function fakes(options = {}) {
  const calls = [], rows = [], requests = [], seen = {}, returns = new Map(), writes = new Map()
  let reviewTurns = 0, reviewReads = 0
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard', brief: 'operator task',
    acceptance: ['A1'], source: 'issue 12', branch: 'lane', base: 'main', closes: [12], refs: [13],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000, ...options.spec,
  }
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'planner' ? { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs', acceptance: ['A1'], mutations: [MUTATION] }
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
    writeFile: async (path, content) => { if (options.writeError) throw Object.assign(new Error('denied'), { code: options.writeError }); writes.set(path, String(content)) },
    journal: options.journal ?? (async (row) => { rows.push(structuredClone(row)) }),
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`); requests.push(structuredClone(request))
      if (requests.length > 24) throw new Error('fixture turn safety bound')
      if (options.seatThrows === request.role) throw new Error('seat crashed')
      if (options.seatRejects === request.role) return Promise.reject(new Error('seat rejected'))
      let value = envelope(request)
      if (options.edit) value = options.edit(value, request) ?? value
      returns.set(request.returnPath, typeof value === 'string' ? value : JSON.stringify(value))
      const recorded = options.recording?.(request)
      if (!recorded) return undefined
      return { definition: recorded.definition, recorded: recorded.rows ? recorded.rows.map((r) => JSON.stringify(r)).join('\n') : null }
    },
    checkBaseline: measured('baseline', 'baseline' in options ? options.baseline : { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] } }),
    runGate: measured('gate', options.gate ?? { ...green(), failingIds: [] }),
    proveMutations: measured('mutations', 'proof' in options ? options.proof : { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }] }),
    runSuite: measured('suite', options.suite ?? green()),
    commitChanges: measured('commit', options.commit ?? { status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }),
    // the status probe right after a suite measures the commit's paths, any other measures the reviewer's
    run: (input) => input.args.includes('status')
      ? (calls.at(-1) === 'suite'
        ? measured('paths', options.pathsResult ?? (() => ({ ...green(), stdout: options.paths ?? ' M lib.mjs\0' })))
        : measured('review-paths', options.reviewResult ?? (() => ({ ...green(), stdout: [options.reviewPaths].flat()[Math.min(reviewReads++, [options.reviewPaths].flat().length - 1)] ?? ' M lib.mjs\0' }))))(input)
      : measured('fetch', options.fetch ?? green())(input),
    rebaseBranch: measured('rebase', options.rebase ?? { status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: measured('publish', options.publish ?? { status: 'green', reason: null, pr: PR }),
    ...options.deps,
  }
  return { spec, deps, calls, rows, requests, seen, writes, go: () => runLoop(spec, deps) }
}
const BODY = ['Source: "issue 12"', '', '## Acceptance', '- A1', '', '## Measurements', '- Baseline gate: red; failing ids: A1.', '- Gate: green.', '- Mutations: 1/1 killed (A1: killed).', '- Suite: green; exit 0.'].join('\n')
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
  assert.deepEqual(f.seen.mutations, { cwd: '/virtual/checkout', gatePath: '/virtual/task/gate.mjs', checks: ['A1'], mutations: [MUTATION], timeoutMs: 5000 })
  assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 5000 })
  assert.deepEqual(f.seen['review-paths'], f.seen.paths)
  assert.deepEqual(f.seen.paths, { cwd: '/virtual/checkout', command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.commit, { cwd: '/virtual/checkout', files: ['lib.mjs'], subject: 'fix(crew): planned lane', body: BODY, closes: [12], refs: [13], timeoutMs: 5000 })
  assert.deepEqual(f.seen.fetch, { cwd: '/virtual/checkout', command: 'git', args: ['fetch', 'origin'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.rebase, { cwd: '/virtual/checkout', base: 'main', timeoutMs: 5000 })
  assert.deepEqual(f.seen.publish, { cwd: '/virtual/checkout', branch: 'lane', base: 'main', title: 'fix(crew): planned lane', body: BODY, closes: [12], refs: [13], timeoutMs: 5000 })
  const planner = f.requests[0]
  assert.deepEqual(Object.keys(planner).sort(), ['brief', 'feedback', 'gatePath', 'id', 'planPath', 'returnPath', 'role', 'seat'])
  assert.deepEqual(Object.keys(f.requests[1]).sort(), Object.keys(planner).sort())
  assert.deepEqual(Object.keys(f.requests[2]).sort(), [...Object.keys(planner), 'changedPaths'].sort())
  assert.deepEqual(f.requests[1], { ...f.requests[1], role: 'builder', planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', feedback: [] })
  assert.equal(new Set(f.requests.map((r) => r.id)).size, f.requests.length)
  assert.equal(new Set(f.requests.map((r) => r.returnPath)).size, f.requests.length)
})

// MUTATION: forward the general timeout to the suite and the suite override never reaches the runner.
test('a suite timeout override reaches only the suite and absent overrides inherit the general timeout', async () => {
  for (const timeoutMs of [1, 1800000, Number.MAX_SAFE_INTEGER]) {
    const f = fakes({ spec: { suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs } } })
    assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
    assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs })
    for (const stage of ['baseline', 'gate', 'mutations', 'review-paths', 'paths', 'commit', 'fetch', 'rebase', 'publish']) assert.equal(f.seen[stage].timeoutMs, 5000, stage)
  }
  const inherit = fakes({ spec: { suite: { command: 'node', timeoutMs: undefined } } })
  await inherit.go()
  assert.equal(inherit.seen.suite.timeoutMs, 5000)
  const neither = fakes({ spec: { timeoutMs: undefined, suite: { command: 'node' } } })
  await neither.go()
  assert.equal(neither.seen.suite.timeoutMs, undefined)
})

// MUTATION: drop the suite timeout validation and an unsound override starts the lane.
test('an invalid suite timeout override is refused before any dependency or journal effect', async () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1800000', null, true, {}, []]
  for (const timeoutMs of invalid) {
    const f = fakes({ spec: { suite: { command: 'node', timeoutMs } } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), String(timeoutMs))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, [])
    assert.equal(f.requests.length, 0)
  }
})

// MUTATION: let a suite override swallow the timeout stop and a timed-out suite publishes.
test('a measured suite timeout under an override stops the lane with no commit, fetch, rebase or publish', async () => {
  const f = fakes({ spec: { suite: { command: 'node', timeoutMs: 1800000 } }, suite: { ...green(), status: 'unmeasured', reason: 'timeout', timedOut: true } })
  assert.deepEqual(await f.go(), stopped('timeout'))
  assert.equal(f.seen.suite.timeoutMs, 1800000)
  for (const effect of ['paths', 'commit', 'fetch', 'rebase', 'publish']) assert.equal(f.calls.includes(effect), false, effect)
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

const gaps = (v) => ({ ...v, details: { ...v.details, gaps: [] } })
const nth = (role, turn, edit) => (v, r) => (r.role === role && Number(r.id.split('.').at(-1)) === turn ? edit(v) : v)

// MUTATION: allow no repair turn and the b1385 builder envelope with one extra field ends the lane.
test('a schema-refused envelope gets one repair turn on the same id and path, and the lane continues without a lost round', async () => {
  for (const role of ['planner', 'builder', 'reviewer']) {
    const f = fakes({ bounds: { [role]: 1 }, edit: (v, r) => (r.role === role && !r.repair ? gaps(v) : v) })
    assert.equal((await f.go()).status, 'done', role)
    const [first, repair] = f.requests.filter((r) => r.role === role)
    assert.equal(f.requests.filter((r) => r.role === role).length, 2, role)
    assert.deepEqual(repair.repair, { defects: [`details.gaps is not a field of ${role} details`] }, role)
    assert.equal(first.repair, undefined)
    assert.equal(repair.id, first.id)
    assert.equal(repair.returnPath, first.returnPath)
    const seen = f.rows.filter((r) => r.event === 'envelope' && r.role === role)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].defects.length, 1)
    assert.deepEqual(seen[1].defects, [])
    assert.equal(count(f, 'lead'), 0)
  }
  // the repair costs no round: a builder bound of two still serves the build that review sends back
  const f = fakes({ review: 1, bounds: { builder: 2 }, edit: (v, r) => (r.role === 'builder' && !r.repair && r.feedback.length === 0 ? gaps(v) : v) })
  assert.equal((await f.go()).status, 'done')
  assert.equal(count(f, 'builder'), 3)
  assert.deepEqual(f.requests.filter((r) => r.role === 'builder').at(-1).feedback, [finding])
  for (const raw of ['null', '[]', '42']) {
    const parsedRoot = fakes({ edit: (v, r) => (r.role === 'builder' && !r.repair ? raw : v) })
    assert.equal((await parsedRoot.go()).status, 'done', raw)
    assert.equal(count(parsedRoot, 'builder'), 2, raw)
  }
})

// MUTATION: skip the second validation and a repaired envelope that is still bad advances.
test('a repaired envelope that is refused again stops the lane with no third turn', async () => {
  const cases = {
    'same defect': (v) => gaps(v),
    'different defect': (v) => ({ ...v, summary: '' }),
    'stale id': (v) => ({ ...v, id: 'stale-return' }),
    'not JSON': () => '{',
  }
  for (const [name, edit] of Object.entries(cases)) {
    const f = fakes({ edit: (v, r) => (r.role === 'builder' ? (r.repair ? edit(v) : gaps(v)) : v) })
    assert.deepEqual(await f.go(), stopped('envelope-refused'), name)
    assert.equal(count(f, 'builder'), 2, name)
    assert.equal(f.calls.includes('gate'), false, name)
    assert.equal(count(f, 'lead'), 0, name)
  }
  for (const [name, options, reason] of [
    ['empty', { edit: (v, r) => (r.role === 'builder' ? (r.repair ? '' : gaps(v)) : v) }, 'seat-unmeasured'],
    ['seat failure', { edit: (v, r) => (r.role === 'builder' ? gaps(v) : v) }, 'seat-unmeasured'],
  ]) {
    const f = fakes(options)
    let dispatched = 0
    if (name === 'seat failure') {
      const run = f.deps.runSeat
      f.deps.runSeat = async (request) => { if (request.role === 'builder') dispatched += 1; if (request.repair) throw new Error('repair crashed'); return run(request) }
    }
    assert.deepEqual(await f.go(), stopped(reason), name)
    assert.equal(name === 'seat failure' ? dispatched : count(f, 'builder'), 2, name)
    assert.equal(f.calls.includes('gate'), false, name)
  }
  // a refused repair of the lead is a lead refusal
  const lead = fakes({ edit: (v) => (v.role === 'planner' ? { ...v, status: 'escalate' } : v.role === 'lead' ? gaps(v) : v) })
  assert.deepEqual(await lead.go(), stopped('lead-refused'))
  assert.equal(count(lead, 'lead'), 2)
})

// MUTATION: repair a file that was never JSON, or one refused only for its id or skill proof.
test('a non-JSON, empty, unreadable, id-only or proof-only refusal gets no repair turn', async () => {
  for (const [options, reason] of [
    [{ edit: () => '{' }, 'envelope-refused'],
    [{ edit: () => 'not JSON' }, 'envelope-refused'],
    [{ edit: () => '' }, 'seat-unmeasured'],
    [{ readError: 'EPERM' }, 'seat-unmeasured'],
    [{ seatThrows: 'planner' }, 'seat-unmeasured'],
    [{ edit: (v) => ({ ...v, id: 'stale-return' }) }, 'envelope-refused'],
    [required([]), 'envelope-refused'],
  ]) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped(reason))
    assert.equal(count(f, 'planner'), 1)
    assert.equal(f.requests.some((r) => r.repair), false)
  }
})

// MUTATION: prove only the repair turn's recording and unproven work is laundered by a fresh repair.
test('a repair does not launder an unproven original and must itself prove its required skills', async () => {
  for (const unproven of [1, 2]) {
    const f = fakes({
      edit: (v, r) => (r.role === 'builder' && !r.repair ? gaps(v) : v),
      recording: (r) => (r.role === 'builder' ? { definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows: (r.repair ? 2 : 1) === unproven ? [] : [LOAD, DONE] } : null),
    })
    assert.deepEqual(await f.go(), stopped('envelope-refused'), `turn ${unproven}`)
    assert.equal(count(f, 'builder'), 2)
    assert.equal(f.calls.includes('gate'), false)
  }
  const both = fakes({
    edit: (v, r) => (r.role === 'builder' && !r.repair ? gaps(v) : v),
    recording: (r) => (r.role === 'builder' ? { definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows: [LOAD, DONE] } : null),
  })
  assert.equal((await both.go()).status, 'done')
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
  assert.deepEqual(f.calls.slice(1, 14), ['seat:planner', 'baseline', 'seat:builder', 'gate', 'mutations', 'review-paths', 'seat:reviewer', 'seat:builder', 'gate', 'mutations', 'review-paths', 'seat:reviewer', 'suite'])
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
  assert.equal(count(bad, 'lead'), 2)
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

const redRun = (code = 1, reason = 'exit-nonzero') => ({ ...green(), status: 'red', code, reason })
const timeoutRun = () => ({ ...green(), status: 'unmeasured', code: null, reason: 'timeout', timedOut: true })
// A suite seam that answers from a sequence and counts every invocation; an exhausted sequence throws.
function sequenced(sequence, options = {}) {
  const inputs = []
  const f = fakes(options)
  f.deps.runSuite = async (input) => {
    f.calls.push('suite'); inputs.push(structuredClone(input))
    const next = sequence[inputs.length - 1]
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('unexpected extra suite run')
    return structuredClone(next)
  }
  return Object.assign(f, { inputs })
}
const EFFECTS = ['paths', 'commit', 'fetch', 'rebase', 'publish']

// MUTATION: never re-run a red suite and a flaky first red stops the lane.
test('a red suite is run once more and a green re-run reaches commit with both runs in the PR measurements', async () => {
  const f = sequenced([redRun(7), green(), redRun(9)], { spec: { suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000 } } })
  const { inputs } = f
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(inputs.length, 2)
  assert.deepEqual(inputs[1], inputs[0])
  assert.deepEqual(inputs[0], { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000 })
  assert.deepEqual(f.calls.filter((c) => ['suite', ...EFFECTS].includes(c)), ['suite', 'suite', ...EFFECTS])
  const body = BODY.replace('- Suite: green; exit 0.', '- Suite: red; exit 7.\n- Suite re-run: green; exit 0.')
  assert.equal(f.seen.commit.body, body)
  assert.equal(f.seen.publish.body, body)
  assert.deepEqual(f.rows.filter((r) => r.event === 'check' && r.check === 'suite').map((r) => r.result.status), ['red', 'green'])
})

const SPEC_OUT = ['ℹ failing tests:', 'test at skills/qa-test-writing/exhibits.test.mjs:42:1', '✖ anchor spans remain current (2ms)', '  AssertionError: stale'].join('\n')
const TAP_OUT = ['not ok 1 - exhibit census remains current', '  ---', "  location: '/virtual/checkout/skills/ux/exhibits.test.mjs:73:1'", '  ...'].join('\n')
const redOut = (stdout) => ({ ...redRun(1), stdout })
const builderTurns = (f) => f.requests.filter((r) => r.role === 'builder')
// gate answers green until the suite has been red twice, then answers `after`
const repairing = (sequence, options = {}) => {
  const f = sequenced(sequence, options)
  const base = f.deps.runGate
  f.deps.runGate = async (input) => options.afterGate && f.inputs.length >= 2 ? (f.calls.push('gate'), structuredClone(options.afterGate)) : base(input)
  return f
}

// MUTATION: drop the feedback at the repair call, or skip the repair turn, and a double red stops without a builder.
test('a suite red on both runs gives the builder one repair turn whose feedback names the failing tests and files', async () => {
  const f = sequenced([redOut(SPEC_OUT), redOut(TAP_OUT), green()])
  assert.deepEqual((await f.go()).status, 'done')
  assert.equal(builderTurns(f).length, 2)
  assert.deepEqual(builderTurns(f)[0].feedback, [])
  const feedback = JSON.stringify(builderTurns(f)[1].feedback)
  for (const needle of ['skills/qa-test-writing/exhibits.test.mjs', 'skills/ux/exhibits.test.mjs', 'anchor spans remain current', 'exhibit census remains current']) assert.ok(feedback.includes(needle), needle)
  assert.ok(feedback.includes('anchor-pin.mjs --repair-all'))
  // parsed names never drop the diagnostics: both runs' output tails ride along
  assert.deepEqual(builderTurns(f)[1].feedback[0].outputTail, [SPEC_OUT, TAP_OUT])
  const empty = sequenced([redRun(1), redRun(1), green()])
  assert.equal((await empty.go()).status, 'done')
  assert.equal(builderTurns(empty).length, 2)
  // the repair turn and its review are granted even when review fixes spent both rounds, and need no lead
  const spent = sequenced([redOut(SPEC_OUT), redOut(TAP_OUT), green()], { review: 1, bounds: { builder: 2, reviewer: 2 } })
  assert.equal((await spent.go()).status, 'done')
  assert.equal(builderTurns(spent).length, 3)
  assert.equal(count(spent, 'lead'), 0)
})

// MUTATION: skip the fresh gate, proof, review or suite after the repair and an unproven green is published.
test('after a suite repair the gate, proof, review and suite run again, then the lane commits and opens its PR with every measurement', async () => {
  const f = sequenced([redRun(1), redRun(2), green()])
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  const at = f.calls.lastIndexOf('seat:builder')
  assert.deepEqual(f.calls.slice(at), ['seat:builder', 'gate', 'mutations', 'review-paths', 'seat:reviewer', 'suite', ...EFFECTS])
  assert.equal(f.inputs.length, 3)
  assert.deepEqual(f.inputs[2], f.inputs[0])
  const body = BODY.replace('- Suite: green; exit 0.', '- Suite: red; exit 1.\n- Suite re-run: red; exit 2.\n- Gate: green.\n- Mutations: 1/1 killed (A1: killed).\n- Suite: green; exit 0.')
  assert.equal(f.seen.commit.body, body)
  assert.equal(f.seen.publish.body, body)
  const bad = [{ ...green(), status: 'red', code: 1, reason: 'gate-failed' }, { ...green(), status: 'unmeasured', code: null, reason: 'timeout', timedOut: true }, { ...green(), code: 3 }]
  for (const afterGate of bad) {
    const r = repairing([redRun(), redRun(), green()], { afterGate })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(r.inputs.length, 2)
    for (const effect of EFFECTS) assert.equal(r.calls.includes(effect), false, effect)
  }
})

// MUTATION: accept a red repaired suite, retry it, or let a non-done repair bounce into more builders.
test('a suite still red after the repair turn stops with no second repair turn and no publication', async () => {
  // the repaired suite gets the same single re-run as any red suite, and two more reds stop the lane
  const f = sequenced([redRun(1), redRun(2), redRun(3), redRun(4), green()])
  assert.deepEqual(await f.go(), stopped('exit-nonzero'))
  assert.equal(builderTurns(f).length, 2)
  assert.equal(f.inputs.length, 4)
  for (const effect of EFFECTS) assert.equal(f.calls.includes(effect), false, effect)
  for (const post of [timeoutRun(), new Error('crashed'), { ...green(), code: 4 }]) {
    const r = sequenced([redRun(), redRun(), post, green()])
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(r.inputs.length, 3)
    for (const effect of EFFECTS) assert.equal(r.calls.includes(effect), false, effect)
  }
  // a review asking for changes after the repair stops the lane, even with builder rounds to spare
  const bounced = sequenced([redRun(), redRun(), green()], { bounds: { builder: 3, reviewer: 3 }, edit: (v, req) => req.role === 'reviewer' && count(bounced, 'builder') === 2 ? { ...v, details: { verdict: 'changes-needed', findings: [finding] } } : v })
  assert.deepEqual(await bounced.go(), stopped('round-bound'))
  assert.equal(builderTurns(bounced).length, 2)
  for (const effect of EFFECTS) assert.equal(bounced.calls.includes(effect), false, effect)
  for (const status of ['insufficient', 'escalate']) {
    const r = sequenced([redRun(), redRun(), green()], { lead: 'bounce', edit: (v, req) => req.role === 'builder' && req.feedback.length ? { ...v, status } : v })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(count(r, 'lead'), 0)
    for (const effect of EFFECTS) assert.equal(r.calls.includes(effect), false, effect)
  }
})

// MUTATION: let a re-run turn an unmeasured result into green, or re-run an unmeasured first result.
test('an unmeasured suite is never re-run and never turned green by a re-run', async () => {
  const unknowns = [[timeoutRun(), 'timeout'], [new Error('crashed'), 'runner-threw'], [{ ...green(), code: 4 }, 'runner-threw'], [{ status: 'green' }, 'runner-threw']]
  for (const [unknown, reason] of unknowns) {
    const initial = sequenced([unknown, green()])
    assert.deepEqual(await initial.go(), stopped(reason))
    assert.equal(initial.inputs.length, 1)
    const rerun = sequenced([redRun(), unknown, green()])
    assert.deepEqual(await rerun.go(), stopped(reason))
    assert.equal(rerun.inputs.length, 2)
    for (const f of [initial, rerun]) for (const effect of EFFECTS) assert.equal(f.calls.includes(effect), false, effect)
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
  // a red suite is run once more, then repaired once: the builder, gate, proof, review and both suite runs follow
  assert.deepEqual(pairs(refused.rows), [...STAGES.slice(0, 8), 'suite', 'suite-repair', ...STAGES.slice(3, 8), 'suite'].flatMap((s) => [['stage-start', s], ['stage-end', s]]))
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
  assert.deepEqual(events('check').map((r) => r.check), ['baseline', 'gate', 'mutations', 'review-paths', 'suite', 'paths', 'commit', 'fetch', 'rebase', 'publish'])
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
    [{ shape: 'stepped' }, 'unsupported-shape'], [{ shape: 'finish' }, 'invalid-input'], [{ shape: undefined }, 'unsupported-shape'],
    [{ tier: 'rigorous' }, 'invalid-input'], [{ id: '' }, 'invalid-input'], [{ cwd: 3 }, 'invalid-input'], [{ taskDir: undefined }, 'invalid-input'],
    [{ brief: '' }, 'invalid-input'], [{ acceptance: [] }, 'invalid-input'], [{ acceptance: ['A1', 'A1'] }, 'invalid-input'],
    [{ suite: null }, 'invalid-input'], [{ suite: { command: '' } }, 'invalid-input'],
    [{ source: '' }, 'invalid-input'], [{ source: undefined }, 'invalid-input'], [{ source: 7 }, 'invalid-input'], [{ branch: undefined }, 'invalid-input'], [{ base: undefined }, 'invalid-input'],
    [{ timeoutMs: 0 }, 'invalid-input'], [{ timeoutMs: -1 }, 'invalid-input'], [{ timeoutMs: 1.5 }, 'invalid-input'], [{ timeoutMs: Infinity }, 'invalid-input'],
    [{ closes: 12 }, 'invalid-input'],
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
  for (const reason of ['unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'lead-escalated', 'lead-unavailable', 'lead-refused', 'accept-unmeasured', 'round-bound', 'paths-unmeasured']) assert.ok(LOOP_REASONS.includes(reason))
  const f = fakes({ suite: { status: 'red', reason: 'free text the enum has never heard of' } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
})

// MUTATION: forward spec.mutations to the proof and a caller-written declaration replaces the planner's.
test('the proof receives the planner declarations and a caller-supplied files or mutations list is ignored', async () => {
  const planned = { ...MUTATION, find: 'planned-find' }
  const f = fakes({
    spec: { files: ['caller-lie.mjs'], mutations: [{ ...MUTATION, find: 'caller-lie' }] },
    edit: (v) => v.role === 'planner' ? { ...v, details: { ...v.details, mutations: [planned] } } : v,
  })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.seen.mutations.mutations, [planned])
  assert.deepEqual(f.seen.commit.files, ['lib.mjs'])
  const refused = fakes({ edit: (v) => v.role === 'planner' ? { ...v, details: { ...v.details, mutations: [] } } : v })
  assert.deepEqual(await refused.go(), stopped('envelope-refused'))
  assert.equal(refused.calls.includes('baseline'), false)
})

// MUTATION: send the caller's list or an unparsed line to commit and a rename end, an odd name or a deletion is left out.
test('the commit receives the paths git reports after the suite, both rename ends included', async () => {
  const cases = [
    [' M src/a.mjs\0?? new file.txt\0R  renamed.mjs\0old.mjs\0 D deleted.mjs\0', ['src/a.mjs', 'new file.txt', 'renamed.mjs', 'old.mjs', 'deleted.mjs']],
    ['C  copy.mjs\0src.mjs\0', ['copy.mjs', 'src.mjs']],
    [' R renamed-in-tree.mjs\0before.mjs\0', ['renamed-in-tree.mjs', 'before.mjs']],
    ['MM both.mjs\0A  both.mjs\0', ['both.mjs']],
    ['?? line\nbreak.txt\0?? "quoted".txt\0', ['line\nbreak.txt', '"quoted".txt']],
    ['', []],
  ]
  for (const [paths, files] of cases) {
    const f = fakes({ paths })
    assert.equal((await f.go()).status, 'done', paths)
    assert.deepEqual(f.seen.commit.files, files, paths)
    const order = f.calls.filter((c) => ['suite', 'paths', 'commit'].includes(c))
    assert.deepEqual(order, ['suite', 'paths', 'commit'])
  }
})

// MUTATION: reuse the first measurement, the caller's list or an unparsed line and a reviewer sees a stale, partial or lost path set.
test('every reviewer turn receives the paths git reports at that round, both rename ends and odd names included', async () => {
  const cases = [
    [' M src/a.mjs\0?? new file.txt\0R  renamed.mjs\0old.mjs\0 D deleted.mjs\0', ['src/a.mjs', 'new file.txt', 'renamed.mjs', 'old.mjs', 'deleted.mjs']],
    ['C  copy.mjs\0src.mjs\0', ['copy.mjs', 'src.mjs']],
    ['MM both.mjs\0A  both.mjs\0', ['both.mjs']],
    ['?? line\nbreak.txt\0?? "quoted".txt\0', ['line\nbreak.txt', '"quoted".txt']],
    ['', []],
  ]
  for (const [reviewPaths, expected] of cases) {
    const f = fakes({ reviewPaths })
    assert.equal((await f.go()).status, 'done', reviewPaths)
    assert.deepEqual(f.requests.filter((r) => r.role === 'reviewer').map((r) => r.changedPaths), [expected], reviewPaths)
  }
  const rounds = fakes({ review: 1, spec: { files: ['caller-lie.mjs'] }, reviewPaths: [' M first.mjs\0', ' M second.mjs\0?? third.txt\0'], paths: ' M commit-only.mjs\0' })
  assert.equal((await rounds.go()).status, 'done')
  assert.deepEqual(rounds.requests.filter((r) => r.role === 'reviewer').map((r) => r.changedPaths), [['first.mjs'], ['second.mjs', 'third.txt']])
  assert.deepEqual(rounds.seen.commit.files, ['commit-only.mjs'])
  assert.deepEqual(rounds.calls.filter((c) => c.endsWith('paths')), ['review-paths', 'review-paths', 'paths'])
  assert.equal(rounds.requests.filter((r) => r.role !== 'reviewer').some((r) => 'changedPaths' in r), false)
})

// MUTATION: dispatch the reviewer anyway when the status read is unusable and the review runs on an unmeasured path set.
test('a reviewer path read that is denied, interrupted, non-green or malformed stops before the reviewer, suite and commit', async () => {
  const bad = (fields) => ({ reviewResult: { ...green(), stdout: ' M a.mjs\0', ...fields } })
  const cases = {
    'EPERM': { deps: { run: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } },
    'ENOENT': bad({ status: 'unmeasured', reason: 'spawn-failed', code: null, stdout: '' }),
    'EINTR': bad({ status: 'unmeasured', reason: 'interrupted', code: null, signal: 'SIGINT' }),
    'red': bad({ status: 'red', reason: 'exit-nonzero', code: 128 }),
    'signal': bad({ signal: 'SIGKILL' }),
    'timeout': bad({ timedOut: true }),
    'nonzero green': bad({ code: 1 }),
    'no stdout': bad({ stdout: undefined }),
    'truncated': bad({ stdout: ' M a.mjs' }),
    'dangling rename': bad({ stdout: 'R  new.mjs\0' }),
    'unsafe': bad({ stdout: '?? ../escape\0' }),
    'git dir': bad({ stdout: ' M .git/config\0' }),
  }
  for (const [name, options] of Object.entries(cases)) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped('paths-unmeasured'), name)
    assert.equal(count(f, 'reviewer'), 0, name)
    for (const effect of ['suite', 'paths', 'commit', 'fetch', 'rebase', 'publish']) assert.equal(f.calls.includes(effect), false, `${name} ${effect}`)
    assert.equal(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').reason, 'paths-unmeasured', name)
  }
  const second = fakes({ review: 1, deps: { run: (() => { let reads = 0; return async (input) => ++reads === 1 ? { ...green(), stdout: ' M a.mjs\0' } : { ...green(), stdout: ' M a.mjs' } })() } })
  assert.deepEqual(await second.go(), stopped('paths-unmeasured'))
  assert.equal(count(second, 'reviewer'), 1)
  assert.equal(second.calls.includes('suite'), false)
})

// MUTATION: commit anyway when the status read is unusable and unmeasured paths are committed as an empty list.
test('a changed-path read that is denied, interrupted, non-green or malformed stops before the commit', async () => {
  const bad = (fields) => ({ pathsResult: { ...green(), stdout: ' M a.mjs\0', ...fields } })
  const cases = {
    'EPERM': { throwCheck: 'paths' },
    'ENOENT': bad({ status: 'unmeasured', reason: 'spawn-failed', code: null, stdout: '' }),
    'EINTR': bad({ status: 'unmeasured', reason: 'interrupted', code: null, signal: 'SIGINT' }),
    'red': bad({ status: 'red', reason: 'exit-nonzero', code: 128 }),
    'signal': bad({ signal: 'SIGKILL' }),
    'timeout': bad({ timedOut: true }),
    'nonzero green': bad({ code: 1 }),
    'no stdout': bad({ stdout: undefined }),
    'truncated': { paths: ' M a.mjs' },
    'dangling rename': { paths: 'R  new.mjs\0' },
    'empty source': { paths: 'R  new.mjs\0\0' },
    'short record': { paths: ' M\0' },
    'bad status': { paths: 'xx a.mjs\0' },
    'quoted line': { paths: ' M "a b.mjs"\n' },
    'absolute': { paths: ' M /etc/passwd\0' },
    'parent': { paths: ' M ../a.mjs\0' },
    'git dir': { paths: ' M .git/config\0' },
    'directory': { paths: '?? dir/\0' },
  }
  for (const [name, options] of Object.entries(cases)) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped('paths-unmeasured'), name)
    assert.equal(f.calls.includes('commit'), false, name)
    assert.equal(f.calls.includes('fetch'), false, name)
    assert.equal(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').reason, 'paths-unmeasured', name)
  }
})

// MUTATION: import an old runtime module, or wire the loop into one, and the isolated lane is no longer isolated.
test('the loop imports only builtins, the three contract modules and the skill proof, and only the lean bridge imports it', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const source = readFileSync(join(dir, 'loop.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/^(?:import|} from|export [^\n]* from)[^'\n]*'([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(specifiers, ['./agents.mjs', './checks.mjs', './protocols.mjs', './skills-proof.mjs', 'node:fs/promises', 'node:path'])
  const importers = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && e.name !== 'loop.mjs')
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => /['"][^'"]*\/loop\.mjs['"]/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(importers, [join(dir, 'lean.mjs')])
})

// MUTATION: bind subject, title or body from the caller spec and hostile caller prose reaches the commit and the PR.
test('the commit and PR carry the planner subject and the generated body, never caller prose', async () => {
  const f = fakes({ spec: { subject: 'feat: caller lie', title: 'feat: caller title', body: 'Imaginary checks: all pass' } })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(f.seen.commit.subject, 'fix(crew): planned lane')
  assert.equal(f.seen.publish.title, 'fix(crew): planned lane')
  assert.equal(f.seen.commit.body, BODY)
  assert.equal(f.seen.publish.body, BODY)
})

// MUTATION: interpolate the source raw and an embedded newline forges a measurement row.
test('the body quotes the source, lists every acceptance id and records each review round and the baseline failing ids', async () => {
  const forged = 'x\n- Suite: green; exit 0.'
  const f = fakes({
    spec: { source: forged, acceptance: ['A1', 'A2'] }, review: 1,
    baseline: { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1', 'A2'] } },
    proof: { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }, { check: 'A2', outcome: 'killed', reason: null }] },
    edit: (value) => value.role === 'planner' ? { ...value, details: { ...value.details, acceptance: ['A1', 'A2'], mutations: [MUTATION, { ...MUTATION, check: 'A2' }] } } : value,
  })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  const round = ['- Gate: green.', '- Mutations: 2/2 killed (A1: killed, A2: killed).']
  assert.equal(f.seen.publish.body, [`Source: ${JSON.stringify(forged)}`, '', '## Acceptance', '- A1', '- A2', '', '## Measurements', '- Baseline gate: red; failing ids: A1, A2.', ...round, ...round, '- Suite: green; exit 0.'].join('\n'))
  assert.equal(f.seen.commit.body, f.seen.publish.body)
  assert.equal(f.seen.publish.body.split('\n').filter((line) => line.startsWith('- Suite:')).length, 1)
})

// MUTATION: publish after a refused suite or proof and a lane that never measured green carries a green body.
test('an unmeasured suite or incomplete proof stops before any commit or publication', async () => {
  const suites = [{ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }, { ...green(), status: 'unmeasured', code: null, reason: 'timeout', timedOut: true }, { status: 'green', reason: 'timeout' }, { ...green(), code: 3 }]
  for (const suite of suites) {
    const f = fakes({ suite })
    assert.equal((await f.go()).status, 'stopped', JSON.stringify(suite))
    assert.deepEqual([f.seen.commit, f.seen.publish], [undefined, undefined], JSON.stringify(suite))
  }
  const f = fakes({ proof: { status: 'green', reason: null, rows: [] } })
  assert.equal((await f.go()).status, 'stopped')
  assert.deepEqual([f.calls.includes('suite'), f.seen.commit, f.seen.publish], [false, undefined, undefined])
})

const callRow = (id, title, kind, rawInput) => ({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'in_progress', rawInput } })
// The proof binds a load to the granted path, <checkout>/skills/<name>/SKILL.md (crew/acp/seat.mjs SKILLS_ROOT).
const GRANTED_ALPHA = fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url))
const LOAD = callRow('r1', 'read', 'read', { path: GRANTED_ALPHA })
const DONE = { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } }
const WRITE = callRow('w1', 'write', 'edit', { path: '/c/a.mjs' })
const required = (rows) => ({ recording: () => ({ definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows }) })

// MUTATION: skip the proof in seatTurn and a seat that never loaded its required skill advances.
test('a seat whose recording shows every required skill before its first write is accepted', async () => {
  const f = fakes(required([LOAD, DONE, WRITE]))
  assert.equal((await f.go()).status, 'done')
})

// MUTATION: accept a late load and a write before the skill passes.
test('a required skill loaded after the first write, or never, refuses the envelope and nothing advances', async () => {
  for (const rows of [[WRITE, LOAD, DONE], [LOAD, WRITE], [WRITE], [], [{ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } }]]) {
    const f = fakes(required(rows))
    assert.deepEqual(await f.go(), stopped('envelope-refused'))
    assert.deepEqual(f.rows.find((r) => r.event === 'envelope').defects, ['required-skills-unproven'])
    assert.deepEqual(f.calls.filter((c) => c !== 'mkdir'), ['seat:planner'])
  }
})

// MUTATION: treat a missing recording as proof.
test('a missing recording refuses when a skill is required and is ignored when none is', async () => {
  const f = fakes({ recording: () => ({ definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' } }) })
  assert.deepEqual(await f.go(), stopped('envelope-refused'))
  assert.deepEqual(f.rows.find((r) => r.event === 'envelope').defects, ['required-skills-unproven'])
  const none = fakes({ recording: () => ({ definition: { requires: [], writes: 'repo' } }) })
  assert.equal((await none.go()).status, 'done')
})

// MUTATION: let a refused lead envelope through the proof.
test('a lead whose recording does not show its required skill is refused', async () => {
  const f = fakes({ spec: {}, lead: 'bounce', edit: (value) => (value.role === 'planner' ? { ...value, status: 'insufficient' } : value), recording: (r) => (r.role === 'lead' ? { definition: { requires: ['alpha'], writes: 'task-dir' }, rows: [] } : null) })
  assert.deepEqual(await f.go(), stopped('lead-refused'))
})

test('the lane writes one run-start with its identity before the first seat, and repairs, bounces and retries never write another', async () => {
  const f = fakes({ review: 1, edit: (value, request) => (request.role === 'builder' && !request.repair && !f.repaired ? ((f.repaired = true), { ...value, status: 'bogus' }) : value) })
  const before = Date.now()
  const result = await f.go()
  assert.equal(result.status, 'done')
  const starts = f.rows.filter((row) => row.event === 'run-start')
  assert.equal(starts.length, 1)
  assert.equal(f.rows.indexOf(starts[0]), 0, 'the anchor precedes every other row, so before the first seat')
  assert.equal(starts[0].lane, 'lane')
  assert.equal(starts[0].run_id, 'lane')
  assert.ok(starts[0].at >= before && starts[0].at <= Date.now(), 'a wall-clock lane start')
  assert.ok(count(f, 'builder') >= 2, 'the build was repeated or repaired')
})

test('a task dir that cannot be made writes no run-start', async () => {
  const f = fakes({ deps: { mkdir: async () => { throw new Error('denied') } } })
  assert.equal((await f.go()).reason, 'runner-threw')
  assert.equal(f.rows.some((row) => row.event === 'run-start'), false)
})

// ---- finish shape (lean plan 3.5): a stopped lane re-entered by its builder ----
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const REPLACEMENT = { check: 'A1', file: 'lib.mjs', find: 're-aimed', replace: 'new2' }
const finishSpec = (over = {}) => ({
  shape: 'finish',
  finish: { planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', subject: 'fix(crew): planned lane', mutations: [MUTATION], stop: STOP, findings: [finding], turnOffset: 3, ...over },
})
const FINISH_SUCCESS = ['seat:builder', 'gate', 'mutations', 'review-paths', 'seat:reviewer', 'suite', 'paths', 'commit', 'fetch', 'rebase']

// MUTATION: run the plan or baseline stage on a finish run and the planner request or baseline call appears.
test('a finish run issues no planner turn and no baseline, and ends after rebase without a PR (FN1, FN2, FN6)', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'] })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: null })
  assert.deepEqual(f.calls, ['mkdir', ...FINISH_SUCCESS])
  assert.equal(f.rows.filter((r) => r.event === 'run-start').length, 0)
  assert.equal(f.rows.some((r) => r.event === 'pr'), false)
  const ready = f.rows.at(-1)
  assert.equal(ready.event, 'finish-ready')
  assert.equal(ready.status, 'ready-for-operator')
  assert.equal(ready.head, 'b'.repeat(40))
  assert.equal(f.rows.findIndex((r) => r.event === 'finish-ready') > f.rows.findLastIndex((r) => r.stage === 'rebase'), true)
})

// MUTATION: start the first builder feedback empty and the stop reason and findings never reach it.
test('the finish builder first hears the stop reason with its observation, then the open findings; seat ids start past the stopped lane', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'] })
  await f.go()
  assert.deepEqual(f.requests[0].feedback, [{ id: 'finish-stop', reason: STOP.reason, observation: STOP.observation }, finding])
  assert.equal(f.requests[0].planPath, '/virtual/task/plan.md')
  assert.equal(f.requests[0].gatePath, '/virtual/task/gate.mjs')
  assert.equal(f.requests[0].id, 'lane.builder.4')
  assert.equal(f.requests[0].role, 'builder')
})

// MUTATION: ignore details.mutations from the builder and the proof runs the planner's stale declaration.
test('a builder replacement mutation is the declaration the proof runs; one outside the acceptance stops the lane (FN5)', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], edit: (v) => (v.role === 'builder' ? { ...v, details: { summary: 'built', mutations: [REPLACEMENT] } } : v) })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.seen.mutations.mutations, [REPLACEMENT])
  assert.deepEqual(f.rows.at(-1).mutations, [REPLACEMENT])
  const out = fakes({ spec: finishSpec(), unseated: ['planner'], edit: (v) => (v.role === 'builder' ? { ...v, details: { summary: 'built', mutations: [{ ...REPLACEMENT, check: 'ZZ' }] } } : v) })
  assert.deepEqual(await out.go(), stopped('envelope-refused'))
  assert.equal(out.calls.includes('gate'), false)
  // the standard shape never takes a builder's declarations
  const std = fakes({ edit: (v) => (v.role === 'builder' ? { ...v, details: { summary: 'built', mutations: [REPLACEMENT] } } : v) })
  assert.deepEqual(await std.go(), stopped('envelope-refused'))
})

// MUTATION: leave the reviewer at two rounds and the third finish review bounds out.
test('a finish run gives the reviewer three rounds and refuses an unsound finish spec', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 2, bounds: { builder: 3 } })
  assert.equal((await f.go()).status, 'done')
  assert.equal(count(f, 'reviewer'), 3)
  for (const bad of [undefined, finishSpec({ planPath: '' }).finish, finishSpec({ stop: {} }).finish, finishSpec({ turnOffset: -1 }).finish, finishSpec({ findings: null }).finish]) {
    const g = fakes({ spec: { shape: 'finish', finish: bad }, unseated: ['planner'] })
    assert.deepEqual(await g.go(), stopped('invalid-input'))
    assert.deepEqual(g.calls, [])
  }
})

// MUTATION: let the lead bounce a spent finish reviewer and a fourth review runs.
test('a finish review that still asks for changes after three rounds stops the run without consulting the lead', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 3, bounds: { builder: 4 } })
  assert.deepEqual(await f.go(), stopped('round-bound'))
  assert.equal(count(f, 'reviewer'), 3)
  assert.equal(f.calls.includes('seat:lead'), false)
  assert.equal(f.calls.includes('commit'), false)
})

// A standard proof whose only non-killed rows are bind-fail earns the builder one re-aim turn.
const BIND_FAIL = (check) => ({ check, outcome: 'unmeasured', reason: 'bind-fail', occurrences: 0 })
const KILLED = (check) => ({ check, outcome: 'killed', reason: null })
const REAIM = { check: 'A1', file: 'lib.mjs', find: 're-aimed', replace: 'new' }
const sequence = (...proofs) => { let n = 0; return () => proofs[Math.min(n++, proofs.length - 1)] }
const unbound = (...rows) => ({ status: 'unmeasured', reason: 'mutation-unmeasured', rows })
const killedProof = (...ids) => ({ status: 'green', reason: null, rows: ids.map(KILLED) })
const twoIds = (value) => value.role === 'planner' ? { ...value, details: { ...value.details, acceptance: ['A1', 'A2'], mutations: [MUTATION, { ...MUTATION, check: 'A2' }] } } : value
const twoBaseline = { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1', 'A2'] } }

// MUTATION: stop a bind-fail proof at once, or never raise the builder bound, and the lane dies without a re-aim turn.
test('a bind-fail proof gives the builder one more turn whose feedback names the failed acceptance id (RA1)', async () => {
  const f = fakes({ bounds: { builder: 1 }, proof: sequence(unbound(BIND_FAIL('A1')), killedProof('A1')) })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  const builders = f.requests.filter((r) => r.role === 'builder')
  assert.equal(builders.length, 2)
  assert.equal(builders[1].feedback.find((entry) => entry.id === 'A1')?.check, 'A1')
})

// MUTATION: drop the builder's replacement and the next proof runs the stale declaration.
test('the replacement the re-aim turn returns is the declaration the next proof runs (RA2)', async () => {
  const f = fakes({ proof: sequence(unbound(BIND_FAIL('A1')), killedProof('A1')), edit: (v, request) => (v.role === 'builder' && request.id.endsWith('.3') ? { ...v, details: { summary: 'built', mutations: [REAIM] } } : v) })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.deepEqual(f.seen.mutations.mutations, [REAIM])
})

// MUTATION: allow any acceptance id in the re-aim turn and a builder swaps a declaration that already bound.
test('a re-aim replacement for an id whose declaration bound stops the lane (RA3)', async () => {
  const f = fakes({
    spec: { acceptance: ['A1', 'A2'] }, baseline: twoBaseline, edit: (v, request) => (v.role === 'builder' && request.id.endsWith('.3') ? { ...v, details: { summary: 'built', mutations: [{ ...REAIM, check: 'A2' }] } } : twoIds(v)),
    proof: sequence(unbound(BIND_FAIL('A1'), KILLED('A2')), killedProof('A1', 'A2')),
  })
  assert.deepEqual(await f.go(), stopped('envelope-refused'))
  assert.equal(f.calls.filter((c) => c === 'mutations').length, 1)
})

// MUTATION: allow a second re-aim turn and a still-unbound proof never stops.
test('a proof still bind-fail after the re-aim turn stops as mutation-unmeasured (RA4)', async () => {
  const f = fakes({ proof: unbound(BIND_FAIL('A1')) })
  assert.deepEqual(await f.go(), stopped('mutation-unmeasured'))
  assert.equal(count(f, 'builder'), 2)
  assert.equal(f.calls.filter((c) => c === 'mutations').length, 2)
})

// MUTATION: re-aim whenever any row is bind-fail and a survived mutation earns the builder an easier target.
test('a proof with a survived row stops without another builder turn (RA5)', async () => {
  const f = fakes({
    spec: { acceptance: ['A1', 'A2'] }, baseline: twoBaseline, edit: twoIds,
    proof: { status: 'red', reason: 'mutations-survived', rows: [{ check: 'A1', outcome: 'survived', reason: 'gate-green' }, BIND_FAIL('A2')] },
  })
  assert.deepEqual(await f.go(), stopped('mutations-survived'))
  assert.equal(count(f, 'builder'), 1)
})

// MUTATION: drop the report write, the guidance entry or the prior-rounds deduction and the matching assertion fails.
test('a green finish run writes a fused report and a finish-ready row with the measured subject and body; a return pass keeps the cap (FD1, FD2, FD7)', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 1, bounds: { builder: 3 } })
  assert.equal((await f.go()).status, 'done')
  const report = JSON.parse(f.writes.get('/virtual/task/finish-report.json'))
  assert.equal(report.stop.reason, STOP.reason)
  assert.deepEqual(report.reviews, [{ verdict: 'changes-needed', findings: [finding] }, { verdict: 'pass', findings: [] }])
  assert.equal(report.measurements.some((m) => m.startsWith('- Suite')), true)
  const ready = f.rows.at(-1)
  assert.deepEqual([ready.subject, ready.reviewRounds, ready.body.includes('## Measurements')], ['fix(crew): planned lane', 2, true])
  assert.equal(ready.body, report.body)
  assert.deepEqual(ready.mutations, [MUTATION])

  const g = fakes({ spec: finishSpec({ guidance: 'Fix it first', priorReviewRounds: 2 }), unseated: ['planner'], review: 2, bounds: { builder: 3 } })
  assert.deepEqual(await g.go(), stopped('round-bound'))
  assert.deepEqual(g.requests[0].feedback.slice(0, 2), [{ id: 'finish-stop', reason: STOP.reason, observation: STOP.observation }, { id: 'finish-return', guidance: 'Fix it first' }])
  assert.equal(count(g, 'reviewer'), 1)
  for (const bad of [{ guidance: 5 }, { priorReviewRounds: -1 }, { priorReviewRounds: 1.5 }]) {
    assert.deepEqual(await fakes({ spec: finishSpec(bad), unseated: ['planner'] }).go(), stopped('invalid-input'))
  }
})

// MUTATION: ignore a failed report write and the lane is announced ready without its report.
test('a finish run that cannot write its report emits no finish-ready, and the standard shape writes none', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], writeError: 'EACCES' })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  assert.equal(f.rows.some((r) => r.event === 'finish-ready'), false)
  const std = fakes()
  await std.go()
  assert.equal(std.writes.size, 0)
})
