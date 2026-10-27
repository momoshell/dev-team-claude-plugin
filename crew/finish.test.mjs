import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { createHash } from 'node:crypto'
import { FinishRefusal, decideFinish, finishLane, main } from './finish.mjs'
import { openPullRequest } from './checks.mjs'

const FINDING = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const PLANNER = {
  role: 'planner', id: 'lane9.planner.1', status: 'done', summary: 'planned',
  details: { subject: 'fix(crew): planned lane', plan_path: '/t/plan.md', gate_path: '/t/gate.mjs', acceptance: ['A1'], mutations: [MUTATION] },
}
const builderRow = { event: 'envelope', role: 'builder', id: 'lane9.builder.2', parsed: { status: 'done' }, defects: [], error: null }

// A temp crew root holding one stopped lane; nothing is spawned and the worktree is a temp directory.
function fixture({ stage = 'mutations', builder = true, worktree = true, review = 'changes-needed', rows = null } = {}) {
  const base = scratchDir('crew-finish-')
  const root = join(base, 'crew')
  const taskDir = join(root, 'dt-lane9', 'lane9', 'task')
  const cwd = join(base, 'worktree')
  mkdirSync(taskDir, { recursive: true })
  if (worktree) mkdirSync(cwd)
  const spec = { id: 'lane9', cwd, taskDir, tier: 'build', shape: 'standard', brief: 'x', acceptance: ['A1'], source: 's', branch: 'lane9', base: 'main', closes: [], suite: { command: 'npm', args: ['test'] } }
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(spec))
  writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify(PLANNER))
  const journal = rows ?? [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    ...(builder ? [builderRow, { event: 'envelope', role: 'reviewer', id: 'lane9.reviewer.3', parsed: { status: 'done' }, defects: [], error: null }] : []),
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: review, findings: [FINDING] },
    { event: 'verdict', stage, status: 'stopped', reason: STOP.reason, observation: STOP.observation },
  ]
  writeFileSync(join(taskDir, 'journal.jsonl'), `${journal.map((r) => JSON.stringify(r)).join('\n')}\n`)
  return { base, root, taskDir, cwd }
}
const run = (f, extra = {}) => {
  const spawned = []
  const deps = { spawnDetached: (file, args, opts) => { spawned.push({ file, args, opts }); return 4242 }, log: () => {}, ...extra }
  return { spawned, go: () => finishLane({ lane: 'lane9', root: f.root, deps }) }
}
const refusal = (f) => { try { run(f).go() } catch (e) { return e } return null }
const cleanup = (f) => rmSync(f.base, { recursive: true, force: true })

// MUTATION: skip the build check and a lane with no accepted builder envelope is finished anyway.
test('a lane with no accepted builder envelope is refused as finish-no-build, and a malformed or non-done one does not count', () => {
  const f = fixture({ builder: false })
  try {
    const error = refusal(f)
    assert.ok(error instanceof FinishRefusal)
    assert.equal(error.reason, 'finish-no-build')
  } finally { cleanup(f) }
  for (const row of [{ ...builderRow, defects: ['x'] }, { ...builderRow, parsed: { status: 'insufficient' } }, { ...builderRow, role: 'reviewer' }]) {
    const g = fixture({ rows: [{ event: 'run-start' }, row, { event: 'verdict', stage: 'review', status: 'stopped', reason: 'round-bound' }] })
    try { assert.equal(refusal(g)?.reason, 'finish-no-build') } finally { cleanup(g) }
  }
})

// MUTATION: drop the stage test and a lane that never built is re-entered.
test('a lane that stopped in the plan or baseline stage, or never stopped, is refused as finish-premise', () => {
  for (const stage of ['plan', 'baseline']) {
    const f = fixture({ stage })
    try { assert.equal(refusal(f)?.reason, 'finish-premise', stage) } finally { cleanup(f) }
  }
  const g = fixture({ rows: [{ event: 'run-start' }, builderRow] })
  try { assert.equal(refusal(g)?.reason, 'finish-premise') } finally { cleanup(g) }
})

// MUTATION: read the stage only from the stop row and a baseline stop, which the loop writes with stage null, is re-entered.
test('a baseline stop written after its stage closed is refused as finish-premise', () => {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'stage-start', stage: 'baseline' }, { event: 'stage-end', stage: 'baseline' },
    builderRow,
    { event: 'verdict', stage: null, status: 'stopped', reason: 'baseline-green' },
  ] })
  try { assert.equal(refusal(f)?.reason, 'finish-premise') } finally { cleanup(f) }
})

// MUTATION: drop the after-stop check and a second finish races the one already running.
test('a lane a run has re-entered since its stop is refused as finish-running', () => {
  const stop = { event: 'verdict', stage: null, status: 'stopped', reason: 'mutations-survived' }
  for (const after of [{ event: 'stage-start', stage: 'build' }, { event: 'finish-ready', stage: null }]) {
    const f = fixture({ rows: [{ event: 'run-start', stage: null }, { event: 'stage-start', stage: 'build' }, builderRow, stop, after] })
    try { assert.equal(refusal(f)?.reason, 'finish-running', after.event) } finally { cleanup(f) }
  }
})

// MUTATION: skip the worktree check and a lane whose checkout is gone is spawned.
test('a lane whose worktree is missing is refused as finish-worktree before any other check', () => {
  const f = fixture({ worktree: false, stage: 'plan', builder: false })
  try {
    const r = run(f)
    assert.throws(r.go, (e) => e instanceof FinishRefusal && e.reason === 'finish-worktree')
    assert.deepEqual(r.spawned, [])
  } finally { cleanup(f) }
})

// MUTATION: rewrite lean.json instead of finish.json and the stopped lane's own spec is lost.
test('a stopped lane with a build is finished: finish.json carries the stop, findings, plan and offset, and the run is spawned in the worktree', () => {
  const f = fixture()
  try {
    const r = run(f)
    const before = readFileSync(join(f.taskDir, 'lean.json'), 'utf8')
    const out = r.go()
    assert.equal(readFileSync(join(f.taskDir, 'lean.json'), 'utf8'), before)
    const spec = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8'))
    assert.equal(spec.shape, 'finish')
    assert.equal(spec.cwd, f.cwd)
    assert.deepEqual(spec.finish, {
      planPath: '/t/plan.md', gatePath: '/t/gate.mjs', subject: 'fix(crew): planned lane', mutations: [MUTATION],
      stop: STOP, findings: [FINDING], turnOffset: 3,
    })
    assert.equal(r.spawned.length, 1)
    assert.equal(r.spawned[0].file, process.execPath)
    assert.ok(r.spawned[0].args[0].endsWith('crew/lean.mjs'))
    assert.equal(r.spawned[0].args[1], join(f.taskDir, 'finish.json'))
    assert.equal(r.spawned[0].opts.cwd, f.cwd)
    assert.equal(r.spawned[0].opts.log, join(f.root, 'briefs', 'started', 'lane9.run.log'))
    assert.equal(r.spawned[0].opts.env.CREW_SUITE_SLOTS, '0')
    assert.deepEqual(out, { lane: 'lane9', worktree: f.cwd, specPath: join(f.taskDir, 'finish.json'), pid: 4242 })
  } finally { cleanup(f) }
})

// MUTATION: always carry the last review's findings and a passed review hands the builder stale ones.
test('only a changes-needed review leaves open findings', () => {
  const f = fixture({ review: 'pass' })
  try {
    run(f).go()
    assert.deepEqual(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.findings, [])
  } finally { cleanup(f) }
})

test('main routes usage to 2, a refusal to 1 with its reason on stderr, and success to 0', async () => {
  assert.equal(await main([]), 2)
  assert.equal(await main(['--x']), 2)
  assert.equal(await main(['a', 'b']), 2)
  const f = fixture({ stage: 'plan' })
  const written = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true }
  try {
    assert.equal(await main(['lane9'], { crewRoot: f.root }), 1)
  } finally { process.stderr.write = original; cleanup(f) }
  assert.match(written.join(''), /^crew finish: finish-premise: /)
  const g = fixture()
  try { assert.equal(await main(['lane9'], { crewRoot: g.root, spawnDetached: () => 1, log: () => {} }), 0) } finally { cleanup(g) }
})

// MUTATION: drop the exclusive claim and two calls before the run's first row both spawn.
test('a second crew finish from the same stop is refused as finish-running before it spawns', () => {
  const f = fixture()
  try {
    const first = run(f)
    first.go()
    assert.equal(first.spawned.length, 1)
    const second = run(f)
    assert.throws(() => second.go(), (e) => e instanceof FinishRefusal && e.reason === 'finish-running')
    assert.equal(second.spawned.length, 0)
  } finally { cleanup(f) }
})

// MUTATION: drop the published and committed checks and a lane with nothing uncommitted is re-entered.
test('a lane with a recorded PR or a committed build is refused', () => {
  const stop = { event: 'verdict', stage: null, status: 'stopped', reason: 'rebase-conflict' }
  for (const [row, reason] of [[{ event: 'pr', stage: 'operator', pr: { number: 1 } }, 'finish-published'], [{ event: 'commit', stage: 'commit', head: 'a'.repeat(40) }, 'finish-committed']]) {
    const f = fixture({ rows: [{ event: 'run-start', stage: null }, { event: 'stage-start', stage: 'build' }, builderRow, row, stop] })
    try { assert.equal(refusal(f)?.reason, reason) } finally { cleanup(f) }
  }
})

// MUTATION: keep the claim when the launch fails and a retry after the fix is refused as finish-running.
test('a launch that fails releases its claim, so a retry after the fix spawns', () => {
  const f = fixture()
  try {
    const failing = run(f, { spawnDetached: () => { throw Object.assign(new Error('spawn failed'), { code: 'EAGAIN' }) } })
    assert.throws(() => failing.go(), /spawn failed/)
    const retry = run(f)
    retry.go()
    assert.equal(retry.spawned.length, 1)
  } finally { cleanup(f) }
})

// ---- decisions on a ready lane ----
const PR = { number: 73, url: 'https://github.com/o/r/pull/73' }
function ready(extra = [], { before = [], legacy = false } = {}) {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    builderRow,
    { event: 'verdict', stage: 'mutations', status: 'stopped', reason: STOP.reason, observation: STOP.observation },
    { event: 'commit', stage: 'commit', head: 'a'.repeat(40) },
    ...before,
    legacy
      ? { event: 'finish-ready', stage: null, status: 'ready-for-operator', head: 'b'.repeat(40) }
      : { event: 'finish-ready', stage: null, status: 'ready-for-operator', head: 'b'.repeat(40), subject: 'fix(crew): planned lane', body: 'MEASURED BODY', reviewRounds: 2 },
    ...extra,
  ] })
  const published = [], spawned = []
  const deps = {
    openPullRequest: async (input) => { published.push(input); return { status: 'green', reason: null, pr: PR } },
    spawnDetached: (file, args, opts) => { spawned.push({ file, args, opts }); return 4242 }, log: () => {},
    run: async () => ({ status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout: `${'b'.repeat(40)}\n`, stderr: '' }),
  }
  const rowsOf = () => readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const decide = (choice, file) => decideFinish({ lane: 'lane9', root: f.root, choice, file, deps })
  return { f, published, spawned, rowsOf, decide, deps }
}
const reasonOf = async (promise) => { try { await promise } catch (e) { return e.reason } return null }

// MUTATION: publish another title or body than the measured one, or drop the notes heading, and the PR text is not what was measured.
test('--accept publishes the measured subject and body, notes under their own heading, then records the pr and the decision (FD3, FD4, FD5)', async () => {
  const r = ready()
  try {
    await r.decide('accept')
    assert.equal(r.published.length, 1)
    assert.deepEqual([r.published[0].title, r.published[0].body, r.published[0].branch], ['fix(crew): planned lane', 'MEASURED BODY', 'lane9'])
    const rows = r.rowsOf()
    assert.deepEqual(rows.slice(-2), [{ event: 'pr', lane: 'lane9', stage: 'publish', pr: PR }, { event: 'finish-decision', lane: 'lane9', choice: 'accept', notesSha256: null }])
  } finally { cleanup(r.f) }
  const n = ready()
  try {
    const notes = join(n.f.base, 'notes.md')
    writeFileSync(notes, 'seen X')
    await n.decide('accept', notes)
    assert.equal(n.published[0].body, 'MEASURED BODY\n\n## Operator notes\n\nseen X')
    assert.equal(n.rowsOf().at(-1).notesSha256, createHash('sha256').update('seen X').digest('hex'))
  } finally { cleanup(n.f) }
})

// MUTATION: record the decision when the PR failed to open and the lane can no longer be accepted.
test('a PR that does not open is refused as finish-publish and records nothing', async () => {
  const r = ready()
  try {
    const before = r.rowsOf().length
    const reason = await reasonOf(decideFinish({ lane: 'lane9', root: r.f.root, choice: 'accept', deps: { log: () => {}, run: r.deps.run, openPullRequest: async () => ({ status: 'unmeasured', reason: 'runner-threw' }) } }))
    assert.equal(reason, 'finish-publish')
    assert.equal(r.rowsOf().length, before)
  } finally { cleanup(r.f) }
})

// MUTATION: publish or spawn on abandon and a lane the operator ended is still pushed.
test('--abandon records only the decision (FD6)', async () => {
  const r = ready()
  try {
    await r.decide('abandon')
    assert.deepEqual(r.rowsOf().at(-1), { event: 'finish-decision', lane: 'lane9', choice: 'abandon', notesSha256: null })
    assert.deepEqual([r.published.length, r.spawned.length], [0, 0])
  } finally { cleanup(r.f) }
})

// MUTATION: omit the guidance or the spent rounds from the spec and the pass reads no guidance and grants three new reviews.
test('--return spawns a finish run whose spec carries the guidance and the spent review rounds (FD7)', async () => {
  const r = ready()
  try {
    const file = join(r.f.base, 'return.md')
    writeFileSync(file, 'Fix the widget first')
    const report = join(r.f.taskDir, 'finish-report.json')
    writeFileSync(report, '{}')
    // MUTATION: retire the report after the launch, or not at all, and the new pass's report can be the one removed.
    const spawn = r.deps.spawnDetached
    let reportAtSpawn = null
    r.deps.spawnDetached = (...args) => { reportAtSpawn = existsSync(report); return spawn(...args) }
    await r.decide('return', file)
    assert.equal(r.spawned.length, 1)
    assert.equal(reportAtSpawn, false, 'the ready pass report was still there when the new pass started')
    assert.equal(existsSync(report), false, 'the ready pass report outlived the return')
    const spec = JSON.parse(readFileSync(join(r.f.taskDir, 'finish.json'), 'utf8'))
    assert.deepEqual([spec.shape, spec.finish.guidance, spec.finish.priorReviewRounds, spec.finish.stop.reason, spec.finish.turnOffset], ['finish', 'Fix the widget first', 2, STOP.reason, 2])
    assert.equal(r.rowsOf().at(-1).choice, 'return')
  } finally { cleanup(r.f) }
  const bare = ready()
  try { assert.equal(await reasonOf(bare.decide('return')), 'finish-unreadable') } finally { cleanup(bare.f) }
  // MUTATION: drop the restore and a failed launch leaves a ready lane with no report.
  const failed = ready()
  try {
    const file = join(failed.f.base, 'return.md')
    writeFileSync(file, 'again')
    writeFileSync(join(failed.f.taskDir, 'finish-report.json'), '{"kept":1}')
    failed.deps.spawnDetached = () => { throw Object.assign(new Error('spawn failed'), { code: 'EAGAIN' }) }
    await assert.rejects(failed.decide('return', file))
    assert.equal(readFileSync(join(failed.f.taskDir, 'finish-report.json'), 'utf8'), '{"kept":1}')
  } finally { cleanup(failed.f) }
})

// MUTATION: skip the ready test and a decision publishes a lane that never finished.
test('a decision on a lane whose last run did not end finish-ready is refused as finish-not-ready (FD8)', async () => {
  const stoppedAfter = { event: 'verdict', stage: null, status: 'stopped', reason: 'round-bound' }
  for (const choice of ['accept', 'abandon']) {
    const none = fixture()
    try {
      const published = []
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: none.root, choice, deps: { openPullRequest: async (i) => { published.push(i) }, log: () => {} } })), 'finish-not-ready')
      assert.equal(published.length, 0)
    } finally { cleanup(none) }
    for (const extra of [[stoppedAfter], [{ event: 'stage-start', stage: 'build' }]]) {
      const r = ready(extra)
      try {
        assert.equal(await reasonOf(r.decide(choice)), 'finish-not-ready')
        assert.deepEqual([r.published.length, r.spawned.length], [0, 0])
      } finally { cleanup(r.f) }
    }
  }
})

// MUTATION: skip the decided test and a second decision publishes or spawns again.
test('a second decision on the same ready lane is refused as finish-decided (FD9)', async () => {
  const r = ready()
  try {
    await r.decide('abandon')
    for (const choice of ['accept', 'abandon', 'return']) assert.equal(await reasonOf(r.decide(choice, '/none')), 'finish-decided')
    assert.deepEqual([r.published.length, r.spawned.length], [0, 0])
  } finally { cleanup(r.f) }
})

// MUTATION: claim only --return and an accept in flight is raced by an abandon (or the reverse) that also records a decision.
test('overlapping decisions on one ready lane: the first claims it, the others are refused as finish-decided, and a failure releases the claim', async () => {
  for (const [first, second] of [['accept', 'abandon'], ['accept', 'return'], ['accept', 'accept'], ['abandon', 'accept']]) {
    const r = ready()
    try {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const deps = {
        openPullRequest: async (input) => { r.published.push(input); await gate; return { status: 'green', reason: null, pr: PR } },
        spawnDetached: () => 1, log: () => {}, run: r.deps.run,
      }
      const go = (choice) => decideFinish({ lane: 'lane9', root: r.f.root, choice, file: choice === 'return' ? '/none' : undefined, deps })
      const pending = go(first)
      assert.equal(await reasonOf(go(second)), 'finish-decided', `${first} then ${second}`)
      release()
      await pending
      assert.equal(r.rowsOf().filter((row) => row.event === 'finish-decision').length, 1)
      assert.equal(r.published.length, first === 'accept' ? 1 : 0)
      assert.equal(r.rowsOf().filter((row) => row.event === 'pr').length, first === 'accept' ? 1 : 0)
    } finally { cleanup(r.f) }
  }
  const failed = ready()
  try {
    let fail = true
    const deps = { log: () => {}, run: failed.deps.run, openPullRequest: async () => (fail ? { status: 'unmeasured', reason: 'runner-threw' } : { status: 'green', reason: null, pr: PR }) }
    const go = () => decideFinish({ lane: 'lane9', root: failed.f.root, choice: 'accept', deps })
    assert.equal(await reasonOf(go()), 'finish-publish')
    fail = false
    assert.equal((await go()).pr, PR)
  } finally { cleanup(failed.f) }
})

// A scripted git remote and gh for the real openPullRequest: what gh create and gh pr edit are sent is what the PR carries.
function ghLane({ open = null } = {}) {
  const calls = []
  const sha = 'b'.repeat(40)
  const record = { number: 18, url: 'https://github.com/o/r/pull/18', state: 'OPEN', headRefName: 'lane9', baseRefName: 'main', isCrossRepository: false }
  const prs = open ? [record] : []
  const ok = (stdout = '') => ({ status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout, stderr: '' })
  const run = async (spec) => {
    calls.push(spec)
    const { command, args } = spec
    if (command === 'git') {
      if (args[0] === 'rev-parse') return ok(`${sha}\n`)
      if (args[0] === 'symbolic-ref') return ok('lane9\n')
      if (args[0] === 'ls-remote') return ok(`${sha}\trefs/heads/lane9\n`)
      return ok()
    }
    if (args[1] === 'list') return ok(JSON.stringify(prs))
    if (args[1] === 'create') { prs.push(record); return ok() }
    if (args[1] === 'edit') return ok()
    throw new Error(`unexpected ${JSON.stringify(spec)}`)
  }
  return { calls, run, gh: (word) => calls.find((c) => c.command === 'gh' && c.args[1] === word)?.args }
}
const argOf = (args, flag) => args[args.indexOf(flag) + 1]

// MUTATION: skip the restoring edit and gh keeps the rewritten title and body, not the measured text.
test('--accept leaves the PR with the measured subject and notes literally, also when it was already open (FD3, FD4)', async () => {
  const subject = 'fix: repair #42'
  const rows = (r) => r.rowsOf()
  const lane = (open) => {
    const r = ready()
    const specPath = join(r.f.taskDir, 'lean.json')
    writeFileSync(specPath, JSON.stringify({ ...JSON.parse(readFileSync(specPath, 'utf8')), closes: [91], refs: [92] }))
    writeFileSync(join(r.f.taskDir, 'journal.jsonl'), `${rows(r).map((row) => JSON.stringify(row.event === 'finish-ready' ? { ...row, subject, body: 'Fixes #42.' } : row)).join('\n')}\n`)
    const g = ghLane({ open })
    return { r, g, deps: { run: g.run, log: () => {}, openPullRequest: (input) => openPullRequest(input, { run: g.run }) } }
  }
  const created = lane(false)
  try {
    const notes = join(created.r.f.base, 'notes.md')
    writeFileSync(notes, 'see #42')
    await decideFinish({ lane: 'lane9', root: created.r.f.root, choice: 'accept', file: notes, deps: created.deps })
    const edit = created.g.gh('edit')
    assert.deepEqual(edit.slice(0, 3), ['pr', 'edit', '18'])
    assert.equal(argOf(edit, '--title'), subject)
    assert.equal(argOf(edit, '--body'), 'Fixes #42.\n\n## Operator notes\n\nsee #42\n\nCloses: #91\nRefs: #92')
    assert.equal(rows(created.r).at(-2).event, 'pr')
  } finally { cleanup(created.r.f) }

  // An earlier accept opened the PR but was not recorded; the retry's changed notes must reach it.
  const reused = lane(true)
  try {
    const notes = join(reused.r.f.base, 'notes.md')
    writeFileSync(notes, 'new notes #42')
    await decideFinish({ lane: 'lane9', root: reused.r.f.root, choice: 'accept', file: notes, deps: reused.deps })
    assert.equal(reused.g.gh('create'), undefined)
    const edit = reused.g.gh('edit')
    assert.deepEqual(edit.slice(0, 3), ['pr', 'edit', '18'])
    assert.equal(argOf(edit, '--title'), subject)
    assert.equal(argOf(edit, '--body'), 'Fixes #42.\n\n## Operator notes\n\nnew notes #42\n\nCloses: #91\nRefs: #92')
    assert.equal(rows(reused.r).at(-1).notesSha256, createHash('sha256').update('new notes #42').digest('hex'))
  } finally { cleanup(reused.r.f) }

  // A PR it did not create (opened by someone else between its lookup and its create) reads as fresh: it is edited too.
  const plain = lane(false)
  try {
    writeFileSync(join(plain.r.f.taskDir, 'journal.jsonl'), `${rows(plain.r).map((row) => JSON.stringify(row.event === 'finish-ready' ? { ...row, subject: 'fix: plain', body: 'plain body' } : row)).join('\n')}\n`)
    await decideFinish({ lane: 'lane9', root: plain.r.f.root, choice: 'accept', deps: plain.deps })
    assert.equal(argOf(plain.g.gh('edit'), '--body'), 'plain body\n\nCloses: #91\nRefs: #92')
  } finally { cleanup(plain.r.f) }

  // A reused PR that cannot be updated records nothing and leaves the lane retryable.
  const stuck = lane(true)
  try {
    const before = rows(stuck.r).length
    const run = async (spec) => (spec.args?.[1] === 'edit' ? { status: 'red', code: 1, reason: 'exit', signal: null, timedOut: false, stdout: '', stderr: 'no' } : stuck.g.run(spec))
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: stuck.r.f.root, choice: 'accept', deps: { ...stuck.deps, run } })), 'finish-publish')
    assert.equal(rows(stuck.r).length, before)
  } finally { cleanup(stuck.r.f) }
})

// MUTATION: skip the head check and a commit added after finish-ready is pushed under the earlier run's measurements.
test('--accept refuses a checkout that moved off the finish run head, publishing and recording nothing (R3)', async () => {
  const r = ready()
  try {
    const before = r.rowsOf().length
    const run = async (spec) => ({ status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout: `${'c'.repeat(40)}\n`, stderr: '' })
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: r.f.root, choice: 'accept', deps: { ...r.deps, run } })), 'finish-head-moved')
    assert.deepEqual([r.published.length, r.rowsOf().length], [0, before])
  } finally { cleanup(r.f) }
})

// MUTATION: treat a failed HEAD probe as a match and a moved checkout is published under the earlier measurements.
test('--accept refuses when the HEAD probe is red or unmeasured, publishing and recording nothing (R1)', async () => {
  for (const probe of [{ status: 'red', code: 1, reason: 'exit', stdout: '' }, { status: 'unmeasured', reason: 'spawn', stdout: '' }, undefined]) {
    const r = ready()
    try {
      const before = r.rowsOf().length
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: r.f.root, choice: 'accept', deps: { ...r.deps, run: async () => probe } })), 'finish-head-moved')
      assert.deepEqual([r.published.length, r.rowsOf().length], [0, before])
    } finally { cleanup(r.f) }
  }
})

// MUTATION: default a missing reviewRounds to zero and a legacy ready row regains three review rounds.
test('--return on a legacy ready row counts the finish reviews already in the journal (R2)', async () => {
  const review = (n) => [{ event: 'envelope', role: 'reviewer', id: `lane9.reviewer.${n}`, parsed: {}, defects: [], error: null }, { event: 'verdict', status: 'reviewed', verdict: 'changes-needed', findings: [] }]
  const r = ready([], { legacy: true, before: [1, 2, 3].flatMap(review) })
  try {
    const file = join(r.f.base, 'return.md')
    writeFileSync(file, 'More')
    await r.decide('return', file)
    const spec = JSON.parse(readFileSync(join(r.f.taskDir, 'finish.json'), 'utf8'))
    assert.equal(spec.finish.priorReviewRounds, 3)
  } finally { cleanup(r.f) }
})

// MUTATION: reload the planner's declarations on return and a replacement the ready run proved is lost.
test('--return carries the mutation declarations the ready run proved (R2)', async () => {
  const proven = [{ ...MUTATION, find: 'older' }]
  const r = ready()
  try {
    const rows = r.rowsOf().map((row) => (row.event === 'finish-ready' ? { ...row, mutations: proven } : row))
    writeFileSync(join(r.f.taskDir, 'journal.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const file = join(r.f.base, 'return.md')
    writeFileSync(file, 'go')
    await r.decide('return', file)
    assert.deepEqual(JSON.parse(readFileSync(join(r.f.taskDir, 'finish.json'), 'utf8')).finish.mutations, proven)
  } finally { cleanup(r.f) }
})

test('main parses the decision flags and returns 2 for any other shape', async () => {
  for (const argv of [['lane9', '--accept', '--notes'], ['lane9', '--return'], ['lane9', '--abandon', 'x'], ['lane9', '--bogus'], ['lane9', '--notes', 'f'], ['--accept']]) {
    assert.equal(await main(argv, {}), 2, argv.join(' '))
  }
})
