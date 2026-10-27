import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { FinishRefusal, finishLane, main } from './finish.mjs'

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
