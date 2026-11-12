import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir, trackProcessGroupFile } from '../test/helpers.mjs'
import { createHash } from 'node:crypto'
import * as finishModule from './finish.mjs'
import { FinishRefusal, decideFinish, finishLane, main } from './finish.mjs'
import { openPullRequest } from './checks.mjs'
import { LOOP_REASONS } from './loop.mjs'
import { validateEnvelope } from './protocols.mjs'
import { recordPr } from './record-pr.mjs'
import { projectHash } from './onboard.mjs'
import { laneRows } from './lanes.mjs'
import { probeAlive } from './run-pid.mjs'

const FINDING = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }
const STOP = { reason: 'round-bound', observation: { stage: 'review', detail: 'three review rounds spent' } }
const PLANNER = {
  role: 'planner', id: 'lane9.planner.1', status: 'done', summary: 'planned',
  details: { subject: 'fix(crew): planned lane', plan_path: '/t/plan.md', tests: [{ file: 'src/widget.test.mjs', title: 'widget renders' }], files_in_scope: ['src/widget.svelte'], validation_lane: 'node --test src/widget.test.mjs' },
}
const ARCHIVED_PLANNER = {
  ...PLANNER,
  details: { subject: 'fix(crew): planned lane', plan_path: '/t/plan-archived.md', gate_path: '/t/gate.mjs', acceptance: ['A1'], mutations: [MUTATION], files_in_scope: ['src/widget.svelte'] },
}
const BUILDER = { role: 'builder', id: 'lane9.builder.2', status: 'done', summary: 'built', details: { summary: 'built the change' } }
const builderRow = { event: 'envelope', role: 'builder', id: BUILDER.id, parsed: BUILDER, defects: [], error: null }

// A temp crew root holding one stopped lane; nothing is spawned and the worktree is a temp directory.
function fixture({ stage = 'review', builder = true, worktree = true, review = 'changes-needed', rows = null, planRecorded = true } = {}) {
  const base = scratchDir('crew-finish-')
  const root = join(base, 'crew')
  const taskDir = join(root, 'dt-lane9', 'lane9', 'task')
  const cwd = join(base, 'worktree')
  mkdirSync(taskDir, { recursive: true })
  if (worktree) mkdirSync(cwd)
  const spec = { id: 'lane9', cwd, taskDir, tier: 'build', shape: 'standard', brief: 'x', source: 's', branch: 'lane9', base: 'main', closes: [], suite: { command: 'npm', args: ['test'] } }
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(spec))
  writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify(PLANNER))
  const journal = rows ? [...rows] : [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    ...(builder ? [builderRow, { event: 'envelope', role: 'reviewer', id: 'lane9.reviewer.3', parsed: { status: 'done' }, defects: [], error: null }] : []),
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: review, findings: [FINDING] },
    { event: 'verdict', stage, status: 'stopped', reason: STOP.reason, observation: STOP.observation },
  ]
  if (rows && planRecorded && !journal.some((row) => row.event === 'envelope' && row.role === 'planner')) journal.unshift({ event: 'envelope', role: 'planner', id: PLANNER.id, parsed: PLANNER, defects: [], error: null })
  writeFileSync(join(taskDir, 'journal.jsonl'), `${journal.map((r) => JSON.stringify(r)).join('\n')}\n`)
  return { base, root, taskDir, cwd }
}
const run = (f, extra = {}) => {
  const spawned = []
  const deps = { alive: () => true, spawnDetached: (file, args, opts) => { spawned.push({ file, args, opts }); return 4242 }, log: () => {}, ...extra }
  return { spawned, go: () => finishLane({ lane: 'lane9', root: f.root, deps }) }
}
const refusal = (f) => { try { run(f).go() } catch (e) { return e } return null }
const cleanup = (f) => rmSync(f.base, { recursive: true, force: true })

test('finish skips scalar journal rows and refuses malformed rows (#2324)', () => {
  for (const [text, malformed] of [['3\n', false], ['{torn\n', true]]) {
    const f = fixture()
    try {
      appendFileSync(join(f.taskDir, 'journal.jsonl'), text)
      if (malformed) assert.throws(run(f).go, { reason: 'finish-unreadable', message: 'the lane journal has a malformed row' })
      else assert.doesNotThrow(run(f).go)
    } finally { cleanup(f) }
  }
})

test('review rounds count one per reviewer turn, not one per repaired return (S3-5)', async () => {
  const review = [0, 1, 2].map((n) => ({ event: 'envelope', role: 'reviewer', id: 'lane9.reviewer.5', defects: n < 2 ? ['bad'] : [] }))
  review.push({ event: 'verdict', status: 'reviewed' })
  const stop = { event: 'verdict', status: 'stopped', stage: 'review', reason: 'seat-escalated' }
  for (const path of ['stop', 'ready']) {
    const r = path === 'ready' ? ready([], { before: review, legacy: true }) : null
    const f = r?.f ?? fixture({ rows: [{ event: 'run-start' }, builderRow, stop, { event: 'finish-decision', choice: 'return' }, ...review, stop] })
    try {
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'continue')
      await assert.doesNotReject(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: r?.deps ?? { log: () => {}, spawnDetached: () => 4242 } }))
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.priorReviewRounds, 1, path)
    } finally { cleanup(f) }
  }
})

test('bare crew finish reports a published lane as published and an abandoned lane as abandoned (S3-7)', async () => {
  for (const kind of ['published', 'abandoned stop', 'abandoned ready']) {
    const r = kind === 'abandoned stop' ? null : ready(kind === 'published' ? [{ event: 'finish-decision', choice: 'accept' }, { event: 'pr', pr: PR }] : [{ event: 'finish-decision', choice: 'abandon' }])
    const f = r?.f ?? fixture({ rows: [{ event: 'verdict', status: 'stopped', reason: 'x' }, { event: 'finish-decision', choice: 'abandon' }] })
    try {
      const logs = [], errors = [], stderr = process.stderr.write
      process.stderr.write = (chunk) => { errors.push(String(chunk)); return true }
      try { assert.equal(await main(['lane9'], { crewRoot: f.root, log: (line) => logs.push(line) }), 0, kind) } finally { process.stderr.write = stderr }
      assert.ok(logs.includes(kind === 'published' ? `crew finish: lane=lane9 published ${PR.url}` : 'crew finish: lane=lane9 abandoned'))
      assert.doesNotMatch(errors.join(''), /finish-running/)
    } finally { cleanup(f) }
  }
})

test('every row finish writes carries the clock it was given (S6-9)', async () => {
  const at = 1_700_000_000_000
  for (const mode of ['stop abandon', 'stop return', 'ready abandon', 'ready return', 'accept', 'uncommit']) {
    const r = mode.startsWith('ready') || mode === 'accept' ? ready() : null
    const head = 'a'.repeat(40)
    const f = r?.f ?? fixture(mode === 'uncommit' ? { rows: [{ event: 'run-start' }, builderRow, { event: 'commit', head }, { event: 'verdict', status: 'stopped', stage: 'rebase', reason: 'x' }] } : {})
    try {
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'continue')
      const deps = { ...r?.deps, now: () => at, log: () => {}, spawnDetached: () => 4242, git: (_cwd, args) => ({ status: 'green', stdout: args[0] === 'rev-parse' ? head : args[0] === 'symbolic-ref' ? 'lane9' : '' }) }
      if (mode === 'uncommit') finishLane({ lane: 'lane9', root: f.root, deps })
      else await decideFinish({ lane: 'lane9', root: f.root, choice: mode === 'accept' ? 'accept' : mode.endsWith('return') ? 'return' : 'abandon', file, deps })
      const rows = readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const written = rows.filter((row) => row.event === 'finish-decision' || row.event === 'finish-uncommit' || row.event === 'pr')
      assert.equal(written.length, mode === 'accept' ? 2 : 1, mode)
      assert.ok(written.every((row) => row.at === at), mode)
    } finally { cleanup(f) }
  }
})

test('a finish launch records the run start time beside the pid in run.pid and its claim (S3-4)', () => {
  const f = fixture()
  try {
    run(f, { now: () => 1_700_000_000_000 }).go()
    for (const name of ['run.pid', 'finish-5.claim']) assert.equal(readFileSync(join(f.taskDir, name), 'utf8'), '4242 1700000000000\n')
  } finally { cleanup(f) }
})

test('probeAlive compares process start in UTC across the repeated DST hour', () => {
  const calls = []
  const ps = (cmd, args, options) => { calls.push({ cmd, args, options }); return { status: 0, stdout: 'Sun Oct 25 01:30:00 2026\n' } }
  const start = Date.UTC(2026, 9, 25, 1, 30)
  assert.equal(probeAlive(process.pid, start, ps), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.env.TZ, 'UTC0')
  assert.equal(calls[0].options.env.LC_ALL, 'C')
  assert.equal(probeAlive(process.pid, start + 3_600_000, ps), false)
})

test('a claim whose pid now names a later process is taken over (S3-4)', () => {
  for (const [startedAt, dead] of [[Date.now() - 86_400_000, true], [Math.round(performance.timeOrigin), false]]) {
    const f = fixture()
    try {
      writeFileSync(join(f.taskDir, 'finish-5.claim'), `${process.pid} ${startedAt}\n`)
      const attempt = run(f, { alive: probeAlive })
      if (dead) { assert.doesNotThrow(attempt.go); assert.equal(attempt.spawned.length, 1) }
      else { assert.throws(attempt.go, { reason: 'finish-running' }); assert.equal(attempt.spawned.length, 0) }
    } finally { cleanup(f) }
  }
})

test('a review stop followed by the in-flight suite\'s rows is finished on that stop, not run-died (#2304)', () => {
  const f = fixture({ rows: [
    { event: 'stage-start', stage: 'build' }, builderRow,
    { event: 'stage-start', stage: 'suite' }, { event: 'stage-start', stage: 'review' },
    { event: 'verdict', stage: 'review', status: 'stopped', reason: 'round-bound' },
    { event: 'stage-end', stage: 'review' }, { event: 'check', stage: 'suite', check: 'suite', result: { status: 'green', code: 0 } },
    { event: 'stage-end', stage: 'suite' },
  ] })
  try {
    writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
    run(f, { alive: (pid) => pid !== 123 }).go()
    assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop.reason, 'round-bound')
  } finally { cleanup(f) }
})

test('a finish launch replaces run.pid with the finish run pid', () => {
  for (const fail of [false, true]) {
    const f = fixture()
    try {
      const path = join(f.taskDir, 'run.pid')
      writeFileSync(path, '111\n')
      run(f, { writeFileSync: (file, ...args) => { if (fail && file === path) throw new Error('disk'); writeFileSync(file, ...args) } }).go()
      if (fail) assert.equal(existsSync(path), false)
      else assert.match(readFileSync(path, 'utf8'), /^4242 \d+\n$/)
    } finally { cleanup(f) }
  }
  const f = fixture()
  try {
    const path = join(f.taskDir, 'run.pid')
    writeFileSync(path, '111\n')
    const r = run(f, { rmSync: (file, ...args) => { if (file === path) throw new Error('denied'); rmSync(file, ...args) } })
    assert.throws(r.go, /denied/)
    assert.equal(r.spawned.length, 0)
    assert.equal(readFileSync(path, 'utf8'), '111\n')
  } finally { cleanup(f) }
})

test('a lane whose run died with no terminal row is finished as run-died', () => {
  for (const tail of [[{ event: 'verdict', status: 'reviewed' }], [{ event: 'verdict', status: 'stopped', stage: 'build', reason: 'x' }, { event: 'stage-start', stage: 'review' }]]) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, ...tail] })
    try {
      writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      assert.doesNotThrow(run(f, { alive: (pid) => pid !== 123 }).go)
      assert.deepEqual(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop, { reason: 'run-died', observation: { pid: 123 } })
    } finally { cleanup(f) }
  }
})

test('finish of a dead run stops a proven live seat process group before launching and logs it', () => {
  const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
  let pgid
  try {
    writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
    const file = join(f.taskDir, '..', 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid')
    mkdirSync(join(file, '..'), { recursive: true })
    const tracked = trackProcessGroupFile(join(f.base, 'seat-pgid')), startedAt = Date.now()
    const spawned = spawnSync(process.execPath, ['-e', `const {spawn} = require('node:child_process'); const {writeFileSync} = require('node:fs'); const child = spawn('sleep', ['300'], {detached:true, stdio:'ignore'}); writeFileSync(process.argv[1], String(child.pid)); child.unref()`, tracked], { encoding: 'utf8' })
    assert.equal(spawned.status, 0, spawned.stderr)
    pgid = Number(readFileSync(tracked, 'utf8'))
    writeFileSync(file, String(pgid))
    writeFileSync(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: join(file, '..'), startedAt, owner: { pid: 123, startedAt }, at: Date.now(), pid: pgid, evidence: { kind: 'pgid', file } }))
    const date = new Date(startedAt).toString().split(' '), logs = []
    const r = run(f, { alive: (pid) => pid !== 123, log: (line) => logs.push(line), spawnSync: () => ({ status: 0, stdout: `${pgid} ${pgid} ${date[0]} ${date[1]} ${date[2]} ${date[4]} ${date[3]} sh -c pgid=${file}\n` }), spawnDetached: () => {
      assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' })
      r.spawned.push(true)
      return 4242
    } })
    r.go()
    assert.equal(r.spawned.length, 1)
    assert.ok(logs.some((line) => line.includes(`stopped seat planner pgid ${pgid}`)))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; cleanup(f) }
})

test('--abandon of a dead run stops its proven seat process groups and logs unproven ones; an abandon of a live-run stop signals nothing', async () => {
  const stopped = fixture()
  try {
    const file = join(stopped.taskDir, '..', 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '999999')
    const startedAt = Date.now()
    writeFileSync(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: join(file, '..'), startedAt, owner: { pid: 123, startedAt }, at: startedAt, pid: 999999, evidence: { kind: 'pgid', file } }))
    const signals = [], logs = []
    assert.deepEqual(await decideFinish({ lane: 'lane9', root: stopped.root, choice: 'abandon', deps: { alive: () => true, kill: (...args) => signals.push(args), log: (line) => logs.push(line) } }), { lane: 'lane9', choice: 'abandon' })
    assert.deepEqual(signals, [])
    assert.ok(!logs.some((line) => line.includes('seat ')))
  } finally { cleanup(stopped) }

  const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
  let pgid
  try {
    writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
    const file = join(f.taskDir, '..', 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid')
    mkdirSync(join(file, '..'), { recursive: true })
    const tracked = trackProcessGroupFile(join(f.base, 'seat-pgid')), startedAt = Date.now()
    const spawned = spawnSync(process.execPath, ['-e', `const {spawn} = require('node:child_process'); const {writeFileSync} = require('node:fs'); const child = spawn('sleep', ['300'], {detached:true, stdio:'ignore'}); writeFileSync(process.argv[1], String(child.pid)); child.unref()`, tracked], { encoding: 'utf8' })
    assert.equal(spawned.status, 0, spawned.stderr)
    pgid = Number(readFileSync(tracked, 'utf8'))
    writeFileSync(file, String(pgid))
    writeFileSync(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: join(file, '..'), startedAt, owner: { pid: 123, startedAt }, at: Date.now(), pid: pgid, evidence: { kind: 'pgid', file } }))
    const reviewer = join(file, '..', '..', 'reviewer', 'pgid')
    mkdirSync(join(reviewer, '..'), { recursive: true })
    writeFileSync(reviewer, '999999')
    const date = new Date(startedAt).toString().split(' '), logs = []
    const result = await decideFinish({ lane: 'lane9', root: f.root, choice: 'abandon', deps: { alive: (pid) => pid !== 123, log: (line) => logs.push(line), spawnSync: () => ({ status: 0, stdout: `${pgid} ${pgid} ${date[0]} ${date[1]} ${date[2]} ${date[4]} ${date[3]} sh -c pgid=${file}\n` }) } })
    assert.deepEqual(result, { lane: 'lane9', choice: 'abandon' })
    assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' })
    assert.ok(logs.includes(`stopped seat planner pgid ${pgid}`))
    assert.ok(logs.includes('seat reviewer pgid 999999: not proven stopped'))
    const last = JSON.parse(readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').at(-1))
    assert.ok(Number.isFinite(last.at))
    assert.deepEqual({ ...last, at: 0 }, { event: 'finish-decision', lane: 'lane9', choice: 'abandon', at: 0, notesSha256: null })
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; cleanup(f) }
})

// MUTATION: replace the dead-run re-check under the claim with false and the abandon is recorded for a run that is alive again.
test('--abandon refuses finish-running, appends nothing and releases the claim when the dead run is no longer proven dead under the claim', async () => {
  for (const change of ['alive', 'journal']) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
    try {
      writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      // A recorded seat whose owner (123) stays dead in the journal case, so a reap before the re-check would probe it.
      const file = join(f.taskDir, '..', 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid'), startedAt = Date.now()
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '999999')
      writeFileSync(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: join(file, '..'), startedAt, owner: { pid: 123, startedAt }, at: startedAt, pid: 999999, evidence: { kind: 'pgid', file } }))
      const journal = join(f.taskDir, 'journal.jsonl'), before = readFileSync(journal, 'utf8')
      const added = `${JSON.stringify({ event: 'verdict', status: 'reviewed' })}\n`
      let revived = false
      const signals = []
      const deps = {
        alive: (pid) => pid !== 123 || revived,
        kill: (...args) => signals.push(args), log: () => {},
        writeFileSync: (path, ...args) => {
          writeFileSync(path, ...args)
          if (path.endsWith('.claim')) {
            if (change === 'alive') revived = true
            else appendFileSync(journal, added)
          }
        },
      }
      await assert.rejects(decideFinish({ lane: 'lane9', root: f.root, choice: 'abandon', deps }), { reason: 'finish-running' }, change)
      assert.equal(readFileSync(journal, 'utf8'), before + (change === 'journal' ? added : ''), change)
      assert.ok(!readdirSync(f.taskDir).some((name) => /^finish-decision-.*\.claim$/.test(name)), change)
      assert.deepEqual(signals, [], change)
    } finally { cleanup(f) }
  }
})

test('a dead open tail remains recoverable after finish spawning fails', () => {
  for (const recovery of ['finish', 'record-pr']) for (const failure of ['throw', 'no-pid']) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
    try {
      const path = join(f.taskDir, 'run.pid')
      const alive = (pid) => pid !== 123
      writeFileSync(path, '123\n')
      assert.throws(run(f, { alive, spawnDetached: () => { if (failure === 'throw') throw new Error('EAGAIN'); return undefined } }).go, failure === 'throw' ? /EAGAIN/ : /no valid pid/)
      assert.equal(existsSync(path), true)
      assert.equal(readFileSync(path, 'utf8'), '123\n')
      if (recovery === 'finish') {
        run(f, { alive }).go()
        assert.deepEqual(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop, { reason: 'run-died', observation: { pid: 123 } })
      } else {
        writeFileSync(join(f.root, 'dt-lane9', 'lane9', 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
        recordPr({ lane: 'lane9', root: f.root, url: 'https://github.com/owner/repo/pull/1', alive })
        assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').at(-1)).event, 'pr')
      }
    } finally { cleanup(f) }
  }
})

test('a recovered dead run can return from finish-ready without resetting review rounds', async () => {
  for (const reviews of [1, 3]) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
    try {
      writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      assert.doesNotThrow(run(f, { alive: (pid) => pid !== 123 }).go)
      const journal = join(f.taskDir, 'journal.jsonl')
      const after = [...Array.from({ length: reviews }, () => ({ event: 'verdict', status: 'reviewed' })), { event: 'finish-ready', reviewRounds: 0 }]
      writeFileSync(journal, readFileSync(journal, 'utf8') + after.map((row) => `${JSON.stringify(row)}\n`).join(''))
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'fix it')
      const decide = () => decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { spawnDetached: () => 4242, log: () => {} } })
      if (reviews === 3) await assert.rejects(decide(), { reason: 'finish-rounds-spent' })
      else {
        await assert.doesNotReject(decide())
        const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
        assert.deepEqual(finish.stop, { reason: 'run-died', observation: { pid: 123 } })
        assert.equal(finish.priorReviewRounds, 1)
        assert.equal(finish.guidance, 'fix it')
      }
    } finally { cleanup(f) }
  }
})

test('an open tail with a live, unknown or unrecorded run pid is still refused', () => {
  for (const prior of [false, true]) for (const alive of [true, null, 'missing', false]) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, ...(prior ? [{ event: 'verdict', status: 'stopped', stage: 'build' }] : []), { event: 'stage-start', stage: 'review' }] })
    try {
      if (alive !== 'missing') writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      const go = run(f, { alive: () => alive }).go
      if (alive === false) { assert.doesNotThrow(go); assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop.reason, 'run-died') }
      else assert.throws(go, (e) => e.reason === (prior ? 'finish-running' : 'finish-premise'))
    } finally { cleanup(f) }
  }
  const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, { event: 'verdict', status: 'reviewed' }] })
  try {
    writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
    writeFileSync(join(f.root, 'dt-lane9', 'lane9', 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
    const alive = (pid) => pid !== 123
    assert.throws(run(f, { alive, spawnDetached: () => {
      assert.throws(run(f, { alive }).go, { reason: 'finish-premise' })
      assert.throws(() => recordPr({ lane: 'lane9', root: f.root, url: 'https://github.com/owner/repo/pull/1', alive }), /not stopped/)
      throw new Error('EAGAIN')
    } }).go, /EAGAIN/)
  } finally { cleanup(f) }
})

// MUTATION: drop the mechanical fallback or apply it to build lanes.
test('a mechanical lane with no planner return is finished on its brief under its builder subject; a build lane without one is still refused', async () => {
  for (const tier of ['mechanical', 'build']) {
    const row = { ...builderRow, parsed: { ...BUILDER, details: { ...BUILDER.details, subject: 'fix: mechanical' } } }
    const f = fixture({ planRecorded: false, rows: [{ event: 'run-start' }, row, { event: 'tier-raised', to: 'judge' }, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'round-bound' }] })
    try {
      const path = join(f.taskDir, 'lean.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), tier }))
      rmSync(join(f.taskDir, 'planner-1.json'))
      if (tier === 'build') { assert.equal(refusal(f)?.reason, 'finish-premise'); continue }
      assert.doesNotThrow(() => run(f).go())
      const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
      assert.deepEqual([finish.planPath, finish.subject, finish.filesInScope, finish.testsRequired], [null, 'fix: mechanical', null, false])
      const journal = join(f.taskDir, 'journal.jsonl')
      writeFileSync(journal, `${readFileSync(journal, 'utf8')}${JSON.stringify({ event: 'finish-ready', reviewRounds: 1 })}\n`)
      const guidance = join(f.taskDir, 'guidance.txt')
      writeFileSync(guidance, 'fix it')
      await decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file: guidance, deps: { spawnDetached: () => 4242, log: () => {} } })
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.subject, 'fix: mechanical')
    } finally { cleanup(f) }
  }
})

test('finishing a mechanical lane after a resolved conflict keeps the build subject', () => {
  const head = 'a'.repeat(40), moved = 'b'.repeat(40), onto = 'c'.repeat(40)
  const build = { ...builderRow, stage: 'build', parsed: { ...BUILDER, details: { ...BUILDER.details, subject: 'fix: original build' } } }
  const conflict = { ...builderRow, stage: 'conflict', id: 'lane9.builder.3', parsed: { ...BUILDER, id: 'lane9.builder.3', details: { ...BUILDER.details, subject: 'fix: conflict only' } } }
  for (const stage of ['proof', 'suite']) {
    const f = fixture({ planRecorded: false, rows: [
      { event: 'run-start' }, build, { event: 'commit', head }, conflict,
      { event: 'stage-end', stage: 'rebase', outcome: { status: 'green', head: moved, onto } },
      { event: 'stage-start', stage }, { event: 'verdict', stage: null, status: 'stopped', reason: 'runner-threw' },
    ] })
    try {
      const path = join(f.taskDir, 'lean.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), tier: 'mechanical' }))
      rmSync(join(f.taskDir, 'planner-1.json'))
      run(f, { git: (_cwd, args) => ({ status: 'green', stdout: args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? moved : onto) : args[0] === 'symbolic-ref' ? 'lane9' : '' }) }).go()
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.subject, 'fix: original build', stage)
    } finally { cleanup(f) }
  }
})

// MUTATION: trust a builder row whose envelope carries another turn's id and finish launches on a return the loop refused.
test('a builder return whose id is not the issued one is never a finish subject or a finish build', () => {
  const wrong = { ...builderRow, parsed: { ...BUILDER, id: 'lane9.builder.9', details: { ...BUILDER.details, subject: 'fix: mechanical' } } }
  const stop = { event: 'verdict', stage: 'build', status: 'stopped', reason: 'envelope-refused' }
  for (const tier of ['mechanical', 'build']) {
    const f = fixture({ rows: [{ event: 'run-start' }, wrong, stop] })
    try {
      const path = join(f.taskDir, 'lean.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), tier }))
      if (tier === 'mechanical') rmSync(join(f.taskDir, 'planner-1.json'))
      assert.equal(refusal(f)?.reason, 'finish-no-build', tier)
    } finally { cleanup(f) }
  }
})

test('a lane the loop raised to judge is finished on the judge tier', () => {
  for (const raised of [false, true]) {
    const f = fixture()
    try {
      if (raised) {
        const path = join(f.taskDir, 'journal.jsonl')
        writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ event: 'tier-raised', from: 'build', to: 'judge', reason: 'protected-path', paths: ['crew/loop.mjs'] })}\n`)
      }
      run(f).go()
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).tier, raised ? 'judge' : 'build')
    } finally { cleanup(f) }
  }
})

test('a lane raised from mechanical is finished on the highest tier it was raised to', () => {
  for (const [initial, raises, expected] of [
    ['mechanical', [], 'mechanical'], ['mechanical', ['build'], 'build'],
    ['mechanical', ['build', 'judge'], 'judge'], ['judge', ['build'], 'judge'],
  ]) {
    const f = fixture()
    try {
      const path = join(f.taskDir, 'lean.json')
      const spec = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...spec, tier: initial }))
      const journal = join(f.taskDir, 'journal.jsonl')
      writeFileSync(journal, readFileSync(journal, 'utf8') + raises.map((to) => JSON.stringify({ event: 'tier-raised', to }) + '\n').join(''))
      run(f).go()
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).tier, expected)
    } finally { cleanup(f) }
  }
})

// MUTATION: skip the build check and a lane with no accepted builder envelope is finished anyway.
test('a lane with no qualifying builder envelope is refused as finish-no-build', () => {
  const f = fixture({ builder: false })
  try {
    const error = refusal(f)
    assert.ok(error instanceof FinishRefusal)
    assert.equal(error.reason, 'finish-no-build')
  } finally { cleanup(f) }
  for (const row of [
    { ...builderRow, defects: ['x'] },
    { ...builderRow, parsed: { ...BUILDER, status: 'insufficient' }, defects: ['x'] },
    { ...builderRow, parsed: { ...BUILDER, status: 'escalate' } },
    { ...builderRow, role: 'reviewer' },
    { ...builderRow, parsed: null },
    { ...builderRow, parsed: {} },
    { ...builderRow, defects: null },
    { ...builderRow, defects: undefined },
  ]) {
    const g = fixture({ rows: [{ event: 'run-start' }, row, { event: 'verdict', stage: 'review', status: 'stopped', reason: 'round-bound' }] })
    try {
      const r = run(g)
      const before = readFileSync(join(g.taskDir, 'journal.jsonl'), 'utf8')
      assert.throws(r.go, (e) => e instanceof FinishRefusal && e.reason === 'finish-no-build')
      assert.deepEqual(r.spawned, [])
      assert.equal(existsSync(join(g.taskDir, 'finish.json')), false)
      assert.equal(readFileSync(join(g.taskDir, 'journal.jsonl'), 'utf8'), before)
    } finally { cleanup(g) }
  }
})

test('finish fixtures use a current planner return and LOOP_REASONS stops', () => {
  assert.deepEqual(validateEnvelope('planner', PLANNER).defects, [])
  assert.ok(validateEnvelope('planner', ARCHIVED_PLANNER).defects.length > 0)
  assert.deepEqual(validateEnvelope('planner', ARCHIVED_PLANNER, { archived: true }).defects, [])
  // baseline-green is exempt: it belongs to the archived D6 case below.
  for (const reason of [STOP.reason, 'round-bound', 'envelope-refused', 'lead-escalated', 'rebase-conflict']) assert.ok(LOOP_REASONS.includes(reason), reason)
})

// MUTATION: drop the stage test and a lane that never built is re-entered.
// archived journal: the baseline stage is retired; D6 keeps the finish.mjs:210 refusal while old journals exist
test('a lane that stopped in the plan or baseline stage, or never stopped, is refused as finish-premise', () => {
  for (const stage of ['plan', 'baseline']) {
    const f = fixture({ stage })
    try { assert.equal(refusal(f)?.reason, 'finish-premise', stage) } finally { cleanup(f) }
  }
  const g = fixture({ rows: [{ event: 'run-start' }, builderRow] })
  try { assert.equal(refusal(g)?.reason, 'finish-premise') } finally { cleanup(g) }
})

// MUTATION: read the stage only from the stop row and a baseline stop, which the loop writes with stage null, is re-entered.
// archived journal: the baseline stage is retired; D6 keeps the finish.mjs:210 refusal while old journals exist
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
  const stop = { event: 'verdict', stage: null, status: 'stopped', reason: 'round-bound' }
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

test('a finish spec carries the lead rulings journaled before the stop (#2341)', () => {
  const rulings = [{ id: 'lead-bounce', summary: 'ruling 1' }]
  const f = fixture({ rows: [
    { event: 'run-start' }, builderRow,
    { event: 'lead-rulings', rulings },
    { event: 'verdict', stage: 'review', status: 'stopped', ...STOP },
    { event: 'lead-rulings', rulings: [{ id: 'lead-bounce', summary: 'later' }] },
  ] })
  try {
    run(f).go()
    assert.deepEqual(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.rulings, rulings)
  } finally { cleanup(f) }
})

// MUTATION: rewrite lean.json instead of finish.json and the stopped lane's own spec is lost.
test('a stopped lane with a build is finished: finish.json carries the stop, findings, plan and offset, and the run is spawned in the worktree', () => {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', parsed: PLANNER, defects: [] },
    ...['build', 'proof', 'review'].map((stage) => ({ event: 'stage-start', stage })),
    builderRow,
    { event: 'envelope', role: 'reviewer', parsed: { status: 'done' }, defects: [] },
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: 'changes-needed', findings: [FINDING] },
    { event: 'verdict', stage: 'review', status: 'stopped', ...STOP },
  ] })
  try {
    const r = run(f)
    const before = readFileSync(join(f.taskDir, 'lean.json'), 'utf8')
    const out = r.go()
    assert.equal(readFileSync(join(f.taskDir, 'lean.json'), 'utf8'), before)
    const spec = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8'))
    assert.equal(spec.shape, 'finish')
    assert.equal(spec.cwd, f.cwd)
    assert.deepEqual(spec.finish, {
      planPath: '/t/plan.md', subject: 'fix(crew): planned lane', filesInScope: ['src/widget.svelte'], testsRequired: true, planSummary: 'planned',
      stop: STOP, findings: [FINDING], turnOffset: 3,
    })
    assert.equal(r.spawned.length, 1)
    assert.equal(r.spawned[0].file, process.execPath)
    assert.ok(r.spawned[0].args[0].endsWith('crew/lean.mjs'))
    assert.equal(r.spawned[0].args[1], join(f.taskDir, 'finish.json'))
    assert.equal(r.spawned[0].opts.cwd, f.cwd)
    assert.equal(r.spawned[0].opts.log, join(f.root, 'briefs', 'started', 'lane9.run.log'))
    assert.deepEqual(out, { lane: 'lane9', worktree: f.cwd, specPath: join(f.taskDir, 'finish.json'), pid: 4242 })
  } finally { cleanup(f) }
  for (const [tests, required] of [[[], false], [undefined, true]]) {
    const f = fixture()
    try {
      const plan = structuredClone(PLANNER)
      if (tests === undefined) delete plan.details.tests
      else plan.details.tests = tests
      writeFileSync(join(f.taskDir, 'planner-1.json'), JSON.stringify(plan))
      run(f).go()
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.testsRequired, required)
    } finally { cleanup(f) }
  }
})

// MUTATION: pass any env in the spawn options.
test('a finish run inherits the caller environment and passes no env of its own', () => {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', parsed: PLANNER, defects: [] },
    ...['build', 'proof', 'review'].map((stage) => ({ event: 'stage-start', stage })),
    builderRow,
    { event: 'envelope', role: 'reviewer', parsed: { status: 'done' }, defects: [] },
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: 'changes-needed', findings: [FINDING] },
    { event: 'verdict', stage: 'review', status: 'stopped', ...STOP },
  ] })
  try {
    const r = run(f)
    r.go()
    assert.equal(r.spawned.length, 1)
    assert.equal(r.spawned[0].opts.env, undefined)
  } finally { cleanup(f) }
})

// A replan the journal records as accepted (planner 3) or refused (planner 5).
const replanRows = (accepted3) => {
  const p3 = { ...PLANNER, id: 'lane9.planner.3', details: { ...PLANNER.details, plan_path: '/t/plan-3.md', tests: [] } }
  const p5 = { ...PLANNER, id: 'lane9.planner.5', status: 'insufficient' }
  return { p3, p5, rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    builderRow,
    { event: 'envelope', role: 'planner', id: p3.id, parsed: p3, defects: accepted3 ? [] : ['details.tests is required'], error: null },
    { event: 'envelope', role: 'planner', id: p5.id, parsed: p5, defects: [], error: null },
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: 'changes-needed', findings: [FINDING] },
    { event: 'verdict', stage: 'review', status: 'stopped', reason: STOP.reason, observation: STOP.observation },
  ] }
}

test('a re-planned lane finishes on its latest accepted plan', () => {
  for (const revised of [false, true]) {
    const replan = replanRows(true)
    const f = revised ? fixture({ rows: replan.rows }) : fixture()
    try {
      if (revised) {
        writeFileSync(join(f.taskDir, 'planner-3.json'), JSON.stringify(replan.p3))
        writeFileSync(join(f.taskDir, 'planner-5.json'), JSON.stringify(replan.p5))
      }
      assert.doesNotThrow(() => run(f).go())
      assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.planPath, revised ? '/t/plan-3.md' : '/t/plan.md')
    } finally { cleanup(f) }
  }
})

test('an archived planner return without tests, carrying gate_path, acceptance and mutations, still finishes on its plan', () => {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: ARCHIVED_PLANNER.id, parsed: ARCHIVED_PLANNER, defects: [], error: null },
    builderRow,
    { event: 'verdict', stage: 'review', status: 'stopped', ...STOP },
  ] })
  try {
    writeFileSync(join(f.taskDir, 'planner-1.json'), JSON.stringify(ARCHIVED_PLANNER))
    run(f).go()
    const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
    assert.equal(finish.planPath, '/t/plan-archived.md')
    assert.deepEqual(finish.filesInScope, ['src/widget.svelte'])
  } finally { cleanup(f) }
})

// MUTATION: choose planner files without the journal's acceptance.
test('a replan the journal records as refused is never the plan finish resumes', () => {
  const replan = replanRows(false)
  const f = fixture({ rows: replan.rows })
  try {
    writeFileSync(join(f.taskDir, 'planner-3.json'), JSON.stringify(replan.p3))
    run(f).go()
    assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.planPath, '/t/plan.md')
  } finally { cleanup(f) }
})

// MUTATION: pass over an unrecorded newer plan for an older accepted one.
test('a valid newer plan the journal does not mention refuses finish rather than resuming an older plan', () => {
  for (const recorded of [true, false]) {
    const f = recorded ? fixture() : fixture({ planRecorded: false, rows: [builderRow, { event: 'verdict', stage: 'review', status: 'stopped', ...STOP }] })
    try {
      if (recorded) writeFileSync(join(f.taskDir, 'planner-3.json'), JSON.stringify({ ...PLANNER, id: 'lane9.planner.3', details: { ...PLANNER.details, plan_path: '/t/plan-3.md', tests: [] } }))
      assert.throws(() => run(f).go(), { reason: 'finish-premise', message: /has no journal row/ })
    } finally { cleanup(f) }
  }
})

// MUTATION: read a journal-refused planner file before skipping it.
test('a refused replan that is not JSON is skipped for the older accepted plan', () => {
  const replan = replanRows(false)
  const f = fixture({ rows: replan.rows })
  try {
    writeFileSync(join(f.taskDir, 'planner-3.json'), '{ not json')
    run(f).go()
    assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.planPath, '/t/plan.md')
  } finally { cleanup(f) }
})

test('older accepted plans without scope still finish', () => {
  const f = fixture()
  try {
    const { files_in_scope, ...details } = PLANNER.details
    writeFileSync(join(f.taskDir, 'planner-1.json'), JSON.stringify({ ...PLANNER, details }))
    run(f).go()
    assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.filesInScope, null)
  } finally { cleanup(f) }
})

test('a schema-valid insufficient build stopped after build can be finished', () => {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'stage-start', stage: 'build' },
    { ...builderRow, parsed: { ...BUILDER, status: 'insufficient' } },
    { event: 'stage-end', stage: 'build' },
    { event: 'verdict', stage: null, status: 'stopped', reason: 'lead-escalated' },
  ] })
  try {
    const change = join(f.cwd, 'change.txt')
    writeFileSync(change, 'uncommitted build')
    const before = readFileSync(join(f.taskDir, 'lean.json'), 'utf8')
    const r = run(f)
    r.go()
    assert.equal(readFileSync(join(f.taskDir, 'lean.json'), 'utf8'), before)
    assert.equal(readFileSync(change, 'utf8'), 'uncommitted build')
    assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop.reason, 'lead-escalated')
    assert.equal(r.spawned.length, 1)
    assert.equal(r.spawned[0].opts.cwd, f.cwd)
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
    try { assert.throws(run(f, { git: () => ({ status: 'green', stdout: 'different' }) }).go, { reason }) } finally { cleanup(f) }
  }
})

// MUTATION: drop the outcome status check and a red undo finishes.
test('a commit the loop undid before its recheck stopped does not block a finish; a standing or failed undo is still refused', () => {
  const head = 'a'.repeat(40)
  const commit = { event: 'commit', stage: 'commit', head }
  const greenUndo = { event: 'stage-end', stage: 'uncommit', outcome: { status: 'green', code: 0, reason: null } }
  const review = { event: 'stage-start', stage: 'review' }
  const stop = { event: 'verdict', stage: null, status: 'stopped', reason: 'round-bound' }
  const base = [
    { event: 'run-start', stage: null }, { event: 'stage-start', stage: 'build' }, builderRow,
    { event: 'stage-end', stage: 'build' }, { event: 'stage-start', stage: 'commit' },
    { event: 'stage-end', stage: 'commit', outcome: { status: 'green', head } }, commit,
    { event: 'stage-start', stage: 'fetch' }, { event: 'stage-end', stage: 'fetch' },
    { event: 'stage-start', stage: 'rebase' }, { event: 'stage-end', stage: 'rebase' },
    { event: 'stage-start', stage: 'uncommit' },
  ]
  for (const [name, tail, allowed] of [
    ['undone', [greenUndo, review], true],
    ['failed undo', [{ ...greenUndo, outcome: { status: 'red', reason: 'command-failed' } }], false],
    ['thrown undo', [{ ...greenUndo, outcome: { threw: 'error' } }], false],
    ['never ended', [], false],
    ['re-committed', [greenUndo, review, commit], false],
  ]) {
    const f = fixture({ rows: [...base, ...tail, stop] })
    try {
      const attempt = run(f, { git: () => ({ status: 'green', stdout: 'different' }) })
      if (allowed) { assert.doesNotThrow(() => attempt.go(), name); assert.equal(attempt.spawned.length, 1, name) }
      else { assert.throws(() => attempt.go(), (e) => e instanceof FinishRefusal && e.reason === 'finish-committed', name); assert.equal(attempt.spawned.length, 0, name) }
    } finally { cleanup(f) }
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

test('bare crew finish reports a stopped lane without spawning or writing anything', async () => {
  for (const stage of ['review', 'plan', 'baseline', 'none']) {
    const f = stage === 'none' ? fixture({ rows: [{ event: 'run-start' }, builderRow] }) : fixture({ stage })
    try {
      writeFileSync(join(f.taskDir, 'run.pid'), '111\n')
      writeFileSync(join(f.cwd, 'change'), 'keep')
      const before = Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')]))
      const logs = [], spawned = [], git = [], errors = []
      const stderr = process.stderr.write
      process.stderr.write = (chunk) => { errors.push(String(chunk)); return true }
      let code
      try { code = await main(['lane9'], { crewRoot: f.root, alive: () => true, log: (line) => logs.push(line), spawnDetached: () => { spawned.push(true); return 4242 }, git: (...args) => { git.push(args); return { status: 'green', stdout: '' } } }) } finally { process.stderr.write = stderr }
      assert.equal(code, stage === 'review' ? 0 : 1, stage)
      if (stage === 'review') assert.match(logs.join('\n'), /lane=lane9.*stop=round-bound/)
      else assert.match(errors.join(''), /finish-premise/)
      assert.deepEqual(Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')])), before, stage)
      assert.equal(readFileSync(join(f.cwd, 'change'), 'utf8'), 'keep')
      assert.deepEqual(spawned, [])
      assert.equal(git.some(([, args]) => args[0] === 'reset'), false)
    } finally { cleanup(f) }
  }
})

test('bare crew finish reports a finish-ready lane without spawning or writing anything', async () => {
  const r = ready()
  try {
    writeFileSync(join(r.f.taskDir, 'run.pid'), '111\n')
    writeFileSync(join(r.f.cwd, 'change'), 'keep')
    const before = Object.fromEntries(readdirSync(r.f.taskDir).map((name) => [name, readFileSync(join(r.f.taskDir, name), 'utf8')]))
    const logs = [], git = []
    assert.equal(await main(['lane9'], { ...r.deps, crewRoot: r.f.root, log: (line) => logs.push(line), git: (...args) => { git.push(args); return { status: 'green', stdout: '' } } }), 0)
    assert.match(logs.join('\n'), /lane=lane9.*stop=finish-ready/)
    assert.deepEqual(Object.fromEntries(readdirSync(r.f.taskDir).map((name) => [name, readFileSync(join(r.f.taskDir, name), 'utf8')])), before)
    assert.equal(readFileSync(join(r.f.cwd, 'change'), 'utf8'), 'keep')
    assert.deepEqual(r.spawned, [])
    assert.equal(git.some(([, args]) => args[0] === 'reset'), false)
  } finally { cleanup(r.f) }
})

test('--return launches a first finish pass on a lane stopped lead-escalated, carrying the guidance and the escalation stop', async () => {
  for (const reason of ['lead-escalated', 'seat-escalated']) for (const status of ['done', 'insufficient', 'escalate']) {
    const parsed = { ...BUILDER, status, details: { ...BUILDER.details, question: 'Which approach?' } }
    const stop = { event: 'verdict', stage: 'build', status: 'stopped', reason, observation: { question: 'Which approach?' } }
    const f = fixture({ rows: [{ event: 'run-start' }, { ...builderRow, parsed }, stop] })
    try {
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'Use approach A')
      const spawned = []
      const result = await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { log: () => {}, spawnDetached: (...args) => { spawned.push(args); return 4242 } } }))
      assert.equal(result, null, `${reason} ${status}`)
      const spec = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8'))
      assert.equal(spec.shape, 'finish')
      assert.deepEqual([spec.finish.guidance, spec.finish.stop, spec.finish.subject, spec.finish.filesInScope, spec.finish.priorReviewRounds], ['Use approach A', { reason, observation: stop.observation }, PLANNER.details.subject, PLANNER.details.files_in_scope, 0])
      assert.equal(spawned.length, 1)
      const rows = readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.ok(Number.isFinite(rows.at(-1).at))
      assert.deepEqual(rows.filter((row) => row.event === 'finish-decision').map((row) => ({ ...row, at: 0 })), [{ event: 'finish-decision', lane: 'lane9', choice: 'return', at: 0, launchedAt: 4, notesSha256: createHash('sha256').update('Use approach A').digest('hex') }])
    } finally { cleanup(f) }
  }
})

test('--return on an escalated lane with no schema-valid builder envelope is refused as finish-no-build and writes nothing', async () => {
  for (const row of [null, { ...builderRow, defects: ['bad'] }, { ...builderRow, parsed: { ...BUILDER, id: 'other' } }, { ...builderRow, parsed: { ...BUILDER, details: {} } }, { ...builderRow, error: 'bad' }]) {
    const f = fixture({ rows: [{ event: 'run-start' }, ...(row ? [row] : []), { event: 'verdict', stage: 'build', status: 'stopped', reason: 'lead-escalated' }] })
    try {
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'answer')
      const before = Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')]))
      const spawned = []
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } } })), 'finish-no-build')
      assert.deepEqual(Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')])), before)
      assert.deepEqual(spawned, [])
    } finally { cleanup(f) }
  }
})

test('a second --return on an escalated lane is refused as finish-decided and spawns nothing', async () => {
  const f = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'lead-escalated' }] })
  try {
    const file = join(f.base, 'guidance')
    writeFileSync(file, 'answer')
    const spawned = []
    const decide = () => decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { alive: () => true, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } } })
    assert.equal(await reasonOf(decide()), null)
    assert.equal(await reasonOf(decide()), 'finish-decided')
    assert.equal(spawned.length, 1)
  } finally { cleanup(f) }
  const failed = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'lead-escalated' }] })
  try {
    const file = join(failed.base, 'guidance'), spawned = []
    writeFileSync(file, 'answer')
    const deps = { alive: () => true, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 }, appendFileSync: (path, text, ...args) => { if (text.includes('finish-decision')) throw new Error('EPERM'); appendFileSync(path, text, ...args) } }
    const decide = () => decideFinish({ lane: 'lane9', root: failed.root, choice: 'return', file, deps })
    await assert.rejects(decide(), /EPERM/)
    assert.equal(await reasonOf(decide()), 'finish-decided')
    assert.equal(spawned.length, 1)
  } finally { cleanup(failed) }
})

test('a returned finish pass that escalates carries its spent reviews into the next --return', async () => {
  const review = [{ event: 'envelope', role: 'reviewer' }, { event: 'verdict', status: 'reviewed' }]
  const stop = { event: 'verdict', stage: 'review', status: 'stopped', reason: 'seat-escalated' }
  for (const [history, recovered] of [
    [[{ event: 'finish-ready', reviewRounds: 1 }, { event: 'finish-decision', choice: 'return' }, ...review], false],
    [[...review, stop, { event: 'finish-decision', choice: 'return' }, ...review], false],
    [[{ event: 'envelope', role: 'reviewer' }, stop, { event: 'finish-decision', choice: 'return' }, ...review], false],
    [[...review, ...review], true],
  ]) {
    const original = [{ event: 'run-start' }, builderRow, ...review, ...review, ...review]
    const f = fixture({ rows: [...original, ...(recovered ? [] : [stop]), { event: 'finish-decision', choice: 'return' }, ...history, stop] })
    try {
      if (recovered) writeFileSync(join(f.taskDir, 'finish.json'), JSON.stringify({ finish: { stop: { reason: 'run-died' }, recoveredStopAt: original.length + 1 } }))
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'answer')
      const spawned = []
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } } })), null)
      const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
      assert.equal(finish.priorReviewRounds, 2)
      if (recovered) assert.equal(finish.recoveredStopAt, original.length + 1)
      assert.equal(spawned.length, 1)
    } finally { cleanup(f) }
  }
})

test('an escalated lane with three spent finish reviews is refused finish-rounds-spent', async () => {
  const review = [{ event: 'envelope', role: 'reviewer' }, { event: 'verdict', status: 'reviewed' }]
  const stop = { event: 'verdict', stage: 'review', status: 'stopped', reason: 'seat-escalated' }
  for (const history of [
    [{ event: 'finish-ready', reviewRounds: 2 }, { event: 'finish-decision', choice: 'return' }, ...review],
    [...review, stop, { event: 'finish-decision', choice: 'return' }, ...review, ...review],
  ]) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, stop, { event: 'finish-decision', choice: 'return' }, ...history, stop] })
    try {
      const file = join(f.base, 'guidance')
      writeFileSync(file, 'answer')
      const before = Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')]))
      const spawned = []
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } } })), 'finish-rounds-spent')
      assert.deepEqual(Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')])), before)
      assert.deepEqual(spawned, [])
    } finally { cleanup(f) }
  }
  for (const mode of ['corrupt', 'invalid', 'denied']) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, ...review, ...review, ...review, stop] })
    try {
      const file = join(f.base, 'guidance'), spec = join(f.taskDir, 'finish.json'), spawned = []
      writeFileSync(file, 'answer')
      writeFileSync(spec, mode === 'corrupt' ? '{' : mode === 'invalid' ? '{"finish":{"recoveredStopAt":-1}}' : '{"finish":{"recoveredStopAt":2}}')
      const before = Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')]))
      const deps = { log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 }, readFileSync: (path, ...args) => { if (mode === 'denied' && path === spec) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return readFileSync(path, ...args) } }
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })), 'finish-unreadable', mode)
      assert.deepEqual(Object.fromEntries(readdirSync(f.taskDir).map((name) => [name, readFileSync(join(f.taskDir, name), 'utf8')])), before)
      assert.deepEqual(spawned, [])
    } finally { cleanup(f) }
  }
})

test('a provably dead returned finish pass is relaunched by --return as run-died, keeping its spent reviews', async () => {
  const review = { event: 'verdict', status: 'reviewed' }
  const stop = { event: 'verdict', stage: 'build', status: 'stopped', reason: 'lead-escalated' }
  for (const [originalStop, reviews, recovered] of [[true, 1, false], [true, 3, false], [false, 0, false], [false, 2, true]]) {
    const original = [{ event: 'stage-start', stage: 'build' }, builderRow, review, review, review]
    const rows = [...original, ...(originalStop || recovered ? [ ...(originalStop ? [stop] : []), { event: 'finish-decision', choice: 'return' }] : []), ...Array(reviews).fill(review), { event: 'stage-start', stage: 'review' }]
    const f = fixture({ rows })
    try {
      const file = join(f.base, 'guidance'), spawned = []
      if (recovered) writeFileSync(join(f.taskDir, 'finish.json'), JSON.stringify({ finish: { stop: { reason: 'run-died' }, recoveredStopAt: original.length + 1 } }))
      writeFileSync(file, 'answer')
      writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      const deps = { alive: (pid) => pid !== 123, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } }
      const reason = await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps }))
      assert.equal(reason, reviews === 3 ? 'finish-rounds-spent' : null)
      assert.equal(spawned.length, reviews === 3 ? 0 : 1)
      if (reviews !== 3) {
        const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
        assert.deepEqual(finish.stop, { reason: 'run-died', observation: { pid: 123 } })
        assert.equal(finish.priorReviewRounds, reviews)
        assert.equal(finish.recoveredStopAt, (recovered ? original.length : rows.length) + 1)
        assert.equal(finish.guidance, 'answer')
      }
    } finally { cleanup(f) }
  }
  for (const mode of ['liveness-changed', 'spawn-failed']) {
    const f = fixture({ rows: [{ event: 'stage-start', stage: 'build' }, builderRow, stop, { event: 'finish-decision', choice: 'return' }, { event: 'stage-start', stage: 'review' }] })
    try {
      const file = join(f.base, 'guidance'), pid = join(f.taskDir, 'run.pid')
      writeFileSync(file, 'answer')
      writeFileSync(pid, '123\n')
      let probes = 0, spawned = 0
      const deps = { alive: () => mode === 'liveness-changed' && ++probes > 1 ? null : false, log: () => {}, spawnDetached: () => { spawned++; throw new Error('spawn failed') } }
      const decide = () => decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })
      if (mode === 'liveness-changed') assert.equal(await reasonOf(decide()), 'finish-running')
      else await assert.rejects(decide(), /spawn failed/)
      assert.equal(spawned, mode === 'spawn-failed' ? 1 : 0)
      assert.equal(readFileSync(pid, 'utf8'), '123\n')
    } finally { cleanup(f) }
  }
})

test('a returned finish pass from finish-ready that dies is relaunched by --return', async () => {
  const rows = [{ event: 'run-start' }, builderRow, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'round-bound' }, { event: 'finish-ready', reviewRounds: 2 }, { event: 'finish-decision', choice: 'return' }, { event: 'stage-start', stage: 'build' }]
  const f = fixture({ rows })
  try {
    const file = join(f.base, 'guidance'), spawned = []
    writeFileSync(file, 'answer')
    writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
    const deps = { alive: (pid) => pid !== 123, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } }
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })), null)
    const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
    assert.deepEqual([finish.stop, finish.priorReviewRounds, finish.recoveredStopAt], [{ reason: 'run-died', observation: { pid: 123 } }, 2, rows.length + 1])
    assert.equal(spawned.length, 1)
  } finally { cleanup(f) }
})

test('--return launches a finish pass on a non-escalated stop such as round-bound', async () => {
  const f = fixture()
  try {
    const file = join(f.base, 'guidance'), spawned = []
    writeFileSync(file, 'fix it')
    const deps = { alive: () => true, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } }
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })), null)
    const finish = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish
    assert.deepEqual([finish.stop, finish.guidance, finish.priorReviewRounds], [STOP, 'fix it', 0])
    assert.equal(spawned.length, 1)
  } finally { cleanup(f) }
})

test('--return refuses finish-decided while the returned run is alive or its pid is unproven', async () => {
  for (const alive of [true, null, 'missing']) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'round-bound' }, { event: 'finish-decision', choice: 'return' }, { event: 'stage-start', stage: 'build' }] })
    try {
      const file = join(f.base, 'guidance'), spawned = []
      writeFileSync(file, 'answer')
      if (alive !== 'missing') writeFileSync(join(f.taskDir, 'run.pid'), '123\n')
      const deps = { alive: () => alive, log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 } }
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })), 'finish-decided', String(alive))
      assert.deepEqual(spawned, [])
    } finally { cleanup(f) }
  }
})

test('a return decision recorded after its child ends belongs to the original stop', async () => {
  for (const initial of ['stop', 'ready']) for (const terminal of ['ready', 'stopped']) {
    const r = initial === 'ready' ? ready() : null
    const f = r?.f ?? fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'lead-escalated' }] })
    try {
      writeFileSync(join(f.root, 'dt-lane9', 'lane9', 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
      const file = join(f.base, 'guidance'), journal = join(f.taskDir, 'journal.jsonl')
      writeFileSync(file, 'answer')
      const child = terminal === 'ready'
        ? { event: 'finish-ready', head: 'b'.repeat(40), subject: 'fix: child', body: 'measured', reviewRounds: 1 }
        : { event: 'verdict', status: 'stopped', stage: 'review', reason: 'seat-escalated' }
      const deps = { ...r?.deps, alive: () => false, log: () => {}, spawnDetached: () => {
        appendFileSync(journal, `${JSON.stringify({ event: 'stage-start', stage: 'build' })}\n${JSON.stringify(child)}\n`)
        return 4242
      } }
      assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps })), null, initial)
      const listed = laneRows({ root: f.root, archiveRoot: join(f.base, 'archive'), alive: () => false })[0]
      const logs = []
      const code = await main(['lane9'], { ...deps, crewRoot: f.root, log: (line) => logs.push(line) })
      if (terminal === 'ready') {
        const published = []
        assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'accept', deps: { ...deps, run: async () => ({ status: 'green', stdout: 'b'.repeat(40) }), openPullRequest: async () => { published.push(true); return { status: 'green', pr: PR } } } })), null)
        assert.equal(published.length, 1)
      } else if (initial === 'stop') {
        let spawned = 0
        assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps: { ...deps, spawnDetached: () => { spawned++; return 4243 } } })), null)
        assert.equal(spawned, 1)
        assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8')).finish.stop.reason, 'seat-escalated')
      }
      assert.deepEqual([listed.status, listed.reason], terminal === 'ready' ? ['ready-for-operator', null] : ['stopped', 'seat-escalated'])
      assert.equal(code, 0)
      assert.match(logs.join('\n'), terminal === 'ready' ? /stop=finish-ready/ : /stop=seat-escalated/)
    } finally { cleanup(f) }
  }
})

// ---- decisions on a ready lane ----
const PR = { number: 73, url: 'https://github.com/o/r/pull/73' }
function ready(extra = [], { before = [], legacy = false, spec = {} } = {}) {
  const f = fixture({ rows: [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    builderRow,
    { event: 'verdict', stage: 'review', status: 'stopped', reason: STOP.reason, observation: STOP.observation },
    { event: 'commit', stage: 'commit', head: 'a'.repeat(40) },
    ...before,
    legacy
      ? { event: 'finish-ready', stage: null, status: 'ready-for-operator', head: 'b'.repeat(40) }
      : { event: 'finish-ready', stage: null, status: 'ready-for-operator', head: 'b'.repeat(40), subject: 'fix(crew): planned lane', body: 'MEASURED BODY', reviewRounds: 2 },
    ...extra,
  ] })
  const specPath = join(f.taskDir, 'lean.json')
  writeFileSync(specPath, JSON.stringify({ ...JSON.parse(readFileSync(specPath, 'utf8')), ...spec }))
  const published = [], spawned = []
  const deps = {
    openPullRequest: async (input) => { published.push(input); return { status: 'green', reason: null, pr: PR } },
    alive: () => true,
    spawnDetached: (file, args, opts) => { spawned.push({ file, args, opts }); return 4242 }, log: () => {},
    run: async () => ({ status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout: `${'b'.repeat(40)}\n`, stderr: '' }),
  }
  const rowsOf = () => readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const decide = (choice, file) => decideFinish({ lane: 'lane9', root: f.root, choice, file, deps })
  return { f, published, spawned, rowsOf, decide, deps }
}
const reasonOf = async (promise) => { try { await promise } catch (e) { return e.reason } return null }

test('--accept refuses a gated lane whose worktree is not onboarded and publishes nothing; a pre-gate lane publishes and abandon is never gated (ADR-057)', async () => {
  for (const [spec, choice, reason] of [[{ onboarded: 'hash' }, 'accept', 'not-onboarded'], [{}, 'accept', null], [{ onboarded: 'hash' }, 'abandon', null]]) {
    const r = ready([], { spec })
    try {
      const before = r.rowsOf()
      assert.equal(await reasonOf(r.decide(choice)), reason)
      assert.equal(r.published.length, choice === 'accept' && reason === null ? 1 : 0)
      if (reason) assert.deepEqual(r.rowsOf(), before)
    } finally { cleanup(r.f) }
  }
})

// MUTATION: drop the comparison with spec.onboarded and a recalibrated project file publishes a lane started under another onboarding.
test('--accept refuses a gated lane whose calibrated project file differs from the onboarding it started under, and publishes when they match (ADR-057)', async () => {
  const project = { suite: 'npm test', proof: [] }
  const hash = projectHash(project)
  for (const [started, reason] of [['a'.repeat(64), 'onboarding-stale'], [hash, null]]) {
    const r = ready([], { spec: { onboarded: started } })
    try {
      mkdirSync(join(r.f.base, 'worktree', '.crew'), { recursive: true })
      writeFileSync(join(r.f.base, 'worktree', '.crew', 'project.json'), JSON.stringify({ ...project, onboarded: { hash } }))
      const before = r.rowsOf()
      assert.equal(await reasonOf(r.decide('accept')), reason)
      assert.equal(r.published.length, reason === null ? 1 : 0)
      if (reason) assert.deepEqual(r.rowsOf(), before)
    } finally { cleanup(r.f) }
  }
})

// MUTATION: publish another title or body than the measured one, or drop the notes heading, and the PR text is not what was measured.
test('--accept publishes the measured subject and body, notes under their own heading, then records the pr and the decision (FD3, FD4, FD5)', async () => {
  const r = ready()
  try {
    await r.decide('accept')
    assert.equal(r.published.length, 1)
    assert.deepEqual([r.published[0].title, r.published[0].body, r.published[0].branch], ['fix(crew): planned lane', 'MEASURED BODY', 'lane9'])
    const rows = r.rowsOf()
    assert.ok(rows.slice(-2).every((row) => Number.isFinite(row.at)))
    assert.deepEqual(rows.slice(-2).map((row) => ({ ...row, at: 0 })), [{ event: 'pr', lane: 'lane9', stage: 'publish', at: 0, pr: PR }, { event: 'finish-decision', lane: 'lane9', choice: 'accept', at: 0, notesSha256: null }])
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

test('--abandon ends a lane whose finish pass stopped after a --return, once per stop', async () => {
  const r = ready([
    { event: 'finish-decision', lane: 'lane9', choice: 'return', launchedAt: 6, notesSha256: 'x' },
    { event: 'stage-start', stage: 'triage' },
    { event: 'verdict', stage: null, status: 'stopped', reason: 'lead-escalated' },
  ])
  try {
    const before = r.rowsOf()
    assert.deepEqual(await r.decide('abandon').catch((error) => error.reason), { lane: 'lane9', choice: 'abandon' })
    const at = r.rowsOf().at(-1).at
    assert.ok(Number.isFinite(at))
    const after = [...before, { event: 'finish-decision', lane: 'lane9', choice: 'abandon', at, notesSha256: null }]
    assert.deepEqual(r.rowsOf(), after)
    for (const [choice, reason] of [['abandon', 'finish-decided'], ['return', 'finish-decided'], ['accept', 'finish-not-ready']]) {
      assert.equal(await reasonOf(r.decide(choice)), reason)
      assert.deepEqual(r.rowsOf(), after)
    }
    assert.deepEqual([r.published.length, r.spawned.length], [0, 0])
  } finally { cleanup(r.f) }

  const f = fixture({ rows: [{ event: 'verdict', status: 'stopped' }, { event: 'stage-start', stage: 'triage' }] })
  try {
    const journal = join(f.taskDir, 'journal.jsonl'), before = readFileSync(journal, 'utf8')
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'abandon', deps: { log: () => {} } })), 'finish-running')
    assert.equal(readFileSync(journal, 'utf8'), before)
  } finally { cleanup(f) }
})

// MUTATION: publish or spawn on abandon and a lane the operator ended is still pushed.
test('--abandon records only the decision (FD6)', async () => {
  const r = ready()
  try {
    await r.decide('abandon')
    const last = r.rowsOf().at(-1)
    assert.ok(Number.isFinite(last.at))
    assert.deepEqual({ ...last, at: 0 }, { event: 'finish-decision', lane: 'lane9', choice: 'abandon', at: 0, notesSha256: null })
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
    assert.deepEqual(spec.finish.filesInScope, ['src/widget.svelte'])
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
  const none = fixture()
  try {
    const published = []
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: none.root, choice: 'accept', deps: { openPullRequest: async (i) => { published.push(i) }, log: () => {} } })), 'finish-not-ready')
    assert.equal(published.length, 0)
  } finally { cleanup(none) }
  for (const [choice, extra] of [['accept', [stoppedAfter]], ['accept', [{ event: 'stage-start', stage: 'build' }]], ['abandon', [{ event: 'stage-start', stage: 'build' }]]]) {
    const r = ready(extra)
    try {
      assert.equal(await reasonOf(r.decide(choice)), 'finish-not-ready')
      assert.deepEqual([r.published.length, r.spawned.length], [0, 0])
    } finally { cleanup(r.f) }
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
    if (args[1] === 'edit') { record.body = args[args.indexOf('--body') + 1]; return ok() }
    if (args[1] === 'view') return ok(JSON.stringify({ body: record.body }))
    throw new Error(`unexpected ${JSON.stringify(spec)}`)
  }
  return { calls, run, gh: (word) => calls.findLast((c) => c.command === 'gh' && c.args[1] === word)?.args }
}
const argOf = (args, flag) => args[args.indexOf(flag) + 1]

// MUTATION: pass the raw body to gh pr edit and "Fixes #42" is restored.
test('--accept leaves the PR with the measured text, issue tokens stripped and issue numbers only on the trailer lines, also when it was already open (FD3, FD4)', async () => {
  const subject = 'fix: repair #42'
  const rows = (r) => r.rowsOf()
  const lane = (open) => {
    const r = ready()
    const specPath = join(r.f.taskDir, 'lean.json')
    writeFileSync(specPath, JSON.stringify({ ...JSON.parse(readFileSync(specPath, 'utf8')), closes: [91], refs: [92] }))
    writeFileSync(join(r.f.taskDir, 'journal.jsonl'), `${rows(r).map((row) => JSON.stringify(row.event === 'finish-ready' ? { ...row, subject, body: 'Fixes #42.' } : row)).join('\n')}\n`)
    const g = ghLane({ open })
    return { r, g, deps: { run: g.run, log: () => {}, openPullRequest: (input) => { assert.equal(Object.hasOwn(input, 'refs'), false); return openPullRequest(input, { run: g.run }) } } }
  }
  const created = lane(false)
  try {
    const notes = join(created.r.f.base, 'notes.md')
    writeFileSync(notes, 'see #42')
    await decideFinish({ lane: 'lane9', root: created.r.f.root, choice: 'accept', file: notes, deps: created.deps })
    const edit = created.g.gh('edit')
    assert.deepEqual(edit.slice(0, 3), ['pr', 'edit', '18'])
    assert.equal(argOf(edit, '--title'), 'fix: repair issue 42')
    assert.equal(argOf(edit, '--body'), 'Fixes issue 42.\n\n## Operator notes\n\nsee issue 42\n\nCloses: #91')
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
    assert.equal(argOf(edit, '--title'), 'fix: repair issue 42')
    assert.equal(argOf(edit, '--body'), 'Fixes issue 42.\n\n## Operator notes\n\nnew notes issue 42\n\nCloses: #91')
    assert.equal(rows(reused.r).at(-1).notesSha256, createHash('sha256').update('new notes #42').digest('hex'))
  } finally { cleanup(reused.r.f) }

  // A PR it did not create (opened by someone else between its lookup and its create) reads as fresh: it is edited too.
  const plain = lane(false)
  try {
    writeFileSync(join(plain.r.f.taskDir, 'journal.jsonl'), `${rows(plain.r).map((row) => JSON.stringify(row.event === 'finish-ready' ? { ...row, subject: 'fix: plain', body: 'plain body' } : row)).join('\n')}\n`)
    await decideFinish({ lane: 'lane9', root: plain.r.f.root, choice: 'accept', deps: plain.deps })
    assert.equal(argOf(plain.g.gh('edit'), '--body'), 'plain body\n\nCloses: #91')
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
test('--accept refuses a checkout that moved off the finish run head, publishing and recording nothing', async () => {
  const r = ready()
  try {
    const before = r.rowsOf().length
    const run = async (spec) => ({ status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout: `${'c'.repeat(40)}\n`, stderr: '' })
    assert.equal(await reasonOf(decideFinish({ lane: 'lane9', root: r.f.root, choice: 'accept', deps: { ...r.deps, run } })), 'finish-head-moved')
    assert.deepEqual([r.published.length, r.rowsOf().length], [0, before])
  } finally { cleanup(r.f) }
})

// MUTATION: treat a failed HEAD probe as a match and a moved checkout is published under the earlier measurements.
test('--accept refuses when the HEAD probe is red or unmeasured, publishing and recording nothing', async () => {
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
test('--return on a legacy ready row counts the finish reviews already in the journal', async () => {
  const review = (n) => [{ event: 'envelope', role: 'reviewer', id: `lane9.reviewer.${n}`, parsed: {}, defects: [], error: null }, { event: 'verdict', status: 'reviewed', verdict: 'changes-needed', findings: [] }]
  const r = ready([], { legacy: true, before: [1, 2].flatMap(review) })
  try {
    const file = join(r.f.base, 'return.md')
    writeFileSync(file, 'More')
    await r.decide('return', file)
    const spec = JSON.parse(readFileSync(join(r.f.taskDir, 'finish.json'), 'utf8'))
    assert.equal(spec.finish.priorReviewRounds, 2)
  } finally { cleanup(r.f) }
})

// MUTATION: carry mutations or gatePath into the finish spec on return.
test('--return writes no mutation declarations or gate path into finish.json', async () => {
  const proven = [{ ...MUTATION, find: 'older' }]
  const r = ready()
  try {
    writeFileSync(join(r.f.taskDir, 'planner-1.json'), JSON.stringify(ARCHIVED_PLANNER))
    const rows = r.rowsOf().map((row) => (row.event === 'finish-ready' ? { ...row, mutations: proven } : row))
    writeFileSync(join(r.f.taskDir, 'journal.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const file = join(r.f.base, 'return.md')
    writeFileSync(file, 'go')
    await r.decide('return', file)
    const finish = JSON.parse(readFileSync(join(r.f.taskDir, 'finish.json'), 'utf8')).finish
    assert.equal(Object.hasOwn(finish, 'mutations'), false)
    assert.equal(Object.hasOwn(finish, 'gatePath'), false)
  } finally { cleanup(r.f) }
})

// MUTATION: drop the constructor's FINISH_REASONS check and an unlisted reason constructs.
test('FinishRefusal accepts only a reason in the frozen FINISH_REASONS list', () => {
  const reasons = finishModule.FINISH_REASONS
  assert.ok(Array.isArray(reasons))
  assert.deepEqual(reasons, ['finish-unreadable', 'finish-worktree', 'finish-premise', 'finish-running', 'finish-published', 'finish-committed', 'finish-no-build', 'finish-not-ready', 'finish-decided', 'finish-head-moved', 'finish-publish', 'finish-rounds-spent', 'not-onboarded', 'onboarding-stale'])
  assert.ok(Object.isFrozen(reasons))
  assert.equal(new Set(reasons).size, reasons.length)
  for (const reason of reasons) assert.equal(new FinishRefusal(reason, 'x').reason, reason)
  assert.throws(() => new FinishRefusal('finish-bogus', 'x'), TypeError)
  const source = readFileSync(new URL('./finish.mjs', import.meta.url), 'utf8')
  for (const [, reason] of source.matchAll(/new FinishRefusal\('([^']+)'/g)) assert.ok(reasons.includes(reason), reason)
})

// MUTATION: treat an unknown liveness (null) as gone and an EPERM claim is taken over.
test('a claim whose run is provably gone does not block a retry; a live, unknown or locked claim is still finish-running', () => {
  for (const mode of ['dead', 'live', 'unknown', 'invalid', 'locked']) {
    const f = fixture()
    try {
      run(f).go()
      const claim = join(f.taskDir, 'finish-5.claim')
      assert.match(readFileSync(claim, 'utf8'), /^4242 \d+\n$/)
      if (mode === 'invalid') writeFileSync(claim, 'not a pid\n')
      if (mode === 'locked') writeFileSync(join(f.taskDir, 'finish-5.reclaim'), 'locked')
      const seen = []
      const attempt = run(f, { alive: (pid) => { seen.push(pid); return mode === 'live' ? true : mode === 'unknown' ? null : false } })
      if (mode === 'dead') {
        attempt.go()
        assert.equal(attempt.spawned.length, 1)
        assert.ok(seen.includes(4242))
      } else {
        assert.throws(attempt.go, { reason: 'finish-running' }, mode)
        assert.equal(attempt.spawned.length, 0, mode)
      }
    } finally { cleanup(f) }
  }
})

// MUTATION: compare with > instead of >= and a pass with zero rounds left launches.
test('--return on a finish run that spent its three review rounds is refused as finish-rounds-spent and writes nothing', async () => {
  for (const legacy of [false, true]) {
    const before = legacy ? [1, 2, 3].map(() => ({ event: 'verdict', status: 'reviewed' })) : []
    const r = ready([], { legacy, before })
    try {
      const journal = join(r.f.taskDir, 'journal.jsonl')
      if (!legacy) writeFileSync(journal, `${r.rowsOf().map((row) => JSON.stringify(row.event === 'finish-ready' ? { ...row, reviewRounds: 3 } : row)).join('\n')}\n`)
      const original = readFileSync(journal, 'utf8')
      const report = join(r.f.taskDir, 'finish-report.json')
      writeFileSync(report, 'keep')
      assert.equal(await reasonOf(r.decide('return', join(r.f.base, 'missing'))), 'finish-rounds-spent')
      assert.equal(r.spawned.length, 0)
      assert.equal(existsSync(join(r.f.taskDir, 'finish.json')), false)
      assert.equal(readFileSync(journal, 'utf8'), original)
      assert.equal(readFileSync(report, 'utf8'), 'keep')
      assert.equal(readdirSync(r.f.taskDir).some((name) => name.startsWith('finish-decision-')), false)
    } finally { cleanup(r.f) }
  }
})

// MUTATION: skip the HEAD equality check and a moved checkout is reset off its own build.
test('a committed, unpublished build at HEAD on the lane branch is uncommitted and finished; a moved, pushed, unprobed or other-branch checkout is still finish-committed', async () => {
  const head = 'a'.repeat(40)
  for (const mode of ['success', 'retry', 'moved', 'pushed', 'head-red', 'remote-red', 'reset-red', 'other-branch', 'detached']) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'commit', head }, { event: 'verdict', stage: 'rebase', status: 'stopped', reason: 'rebase-conflict' }] })
    try {
      const calls = []
      const gitProbe = (cwd, args) => {
        calls.push(args)
        if (args[0] === 'rev-parse') return { status: mode === 'head-red' ? 'red' : 'green', stdout: mode === 'moved' ? 'b'.repeat(40) : head }
        if (args[0] === 'symbolic-ref') return mode === 'detached' ? { status: 'red', stdout: '' } : { status: 'green', stdout: mode === 'other-branch' ? 'other\n' : 'lane9\n' }
        if (args[0] === 'ls-remote') return { status: mode === 'remote-red' ? 'red' : 'green', stdout: mode === 'pushed' ? `${head}\trefs/heads/lane9\n` : '' }
        return { status: mode === 'reset-red' ? 'red' : 'green', stdout: '' }
      }
      const journal = join(f.taskDir, 'journal.jsonl')
      const original = readFileSync(journal, 'utf8')
      const attempt = run(f, { git: gitProbe, ...(mode === 'retry' ? { spawnDetached: () => { throw new Error('spawn failed') } } : {}) })
      if (mode === 'success' || mode === 'retry') {
        if (mode === 'retry') assert.throws(attempt.go, /spawn failed/)
        else { assert.doesNotThrow(attempt.go); assert.equal(attempt.spawned.length, 1) }
        assert.deepEqual(calls.filter((args) => args[0] === 'reset'), [['reset', '--soft', `${head}^`]])
        const last = JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1))
        assert.ok(Number.isFinite(last.at))
        assert.deepEqual({ ...last, at: 0 }, { event: 'finish-uncommit', lane: 'lane9', at: 0, head, onto: `${head}^` })
        if (mode === 'retry') {
          const retry = run(f, { git: gitProbe })
          retry.go()
          assert.equal(retry.spawned.length, 1)
          assert.equal(calls.filter((args) => args[0] === 'reset').length, 1)
        }
      } else {
        assert.throws(attempt.go, { reason: 'finish-committed' }, mode)
        assert.equal(attempt.spawned.length, 0, mode)
        assert.equal(readFileSync(journal, 'utf8'), original, mode)
        assert.equal(readdirSync(f.taskDir).some((name) => name.endsWith('.claim')), false, mode)
      }
    } finally { cleanup(f) }
  }
  for (const mode of ['success', 'moved']) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'commit', head }, { event: 'verdict', stage: 'rebase', status: 'stopped', reason: 'lead-escalated' }] })
    try {
      const file = join(f.base, 'guidance'), calls = [], spawned = []
      writeFileSync(file, 'answer')
      const deps = { log: () => {}, spawnDetached: () => { spawned.push(true); return 4242 }, git: (_cwd, args) => {
        calls.push(args)
        return { status: 'green', stdout: args[0] === 'rev-parse' ? (mode === 'moved' ? 'b'.repeat(40) : head) : args[0] === 'symbolic-ref' ? 'lane9' : '' }
      } }
      const reason = await reasonOf(decideFinish({ lane: 'lane9', root: f.root, choice: 'return', file, deps }))
      assert.equal(reason, mode === 'success' ? null : 'finish-committed')
      assert.equal(spawned.length, mode === 'success' ? 1 : 0)
      assert.equal(calls.filter((args) => args[0] === 'reset').length, mode === 'success' ? 1 : 0)
      const rows = readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(rows.filter((row) => row.event === 'finish-uncommit').length, mode === 'success' ? 1 : 0)
    } finally { cleanup(f) }
  }
  // A prior finish can complete while this caller is probing the remote, before it reclaims the old stop.
  for (const mode of ['journal', 'head', 'head-red', 'branch']) {
    const f = fixture({ rows: [{ event: 'run-start' }, builderRow, { event: 'commit', head }, { event: 'verdict', stage: 'rebase', status: 'stopped', reason: 'rebase-conflict' }] })
    try {
      const journal = join(f.taskDir, 'journal.jsonl'), calls = []
      let probed = false, expected = readFileSync(journal, 'utf8')
      const attempt = run(f, {
        alive: () => false,
        git: (_cwd, args) => {
          calls.push(args)
          if (args[0] === 'ls-remote') {
            writeFileSync(join(f.taskDir, 'finish-4.claim'), '4242\n')
            if (mode === 'journal') {
              expected += `${JSON.stringify({ event: 'finish-ready', head: 'b'.repeat(40) })}\n`
              writeFileSync(journal, expected)
            }
            probed = true
            return { status: 'green', stdout: '' }
          }
          // 'branch': the operator switches to another branch at the same commit while the remote is probed.
          if (args[0] === 'symbolic-ref') return { status: 'green', stdout: probed && mode === 'branch' ? 'other\n' : 'lane9\n' }
          return { status: probed && mode === 'head-red' ? 'red' : 'green', stdout: probed && mode === 'head' ? 'b'.repeat(40) : head }
        },
      })
      assert.throws(attempt.go, { reason: mode === 'journal' ? 'finish-running' : 'finish-committed' }, mode)
      assert.deepEqual(calls.filter((args) => args[0] === 'reset'), [], mode)
      assert.equal(attempt.spawned.length, 0, mode)
      assert.equal(readFileSync(journal, 'utf8'), expected, mode)
      assert.equal(readdirSync(f.taskDir).some((name) => name.endsWith('.claim')), false, mode)
    } finally { cleanup(f) }
  }
})

test('main parses the decision flags and returns 2 for any other shape', async () => {
  for (const argv of [['lane9', '--accept', '--notes'], ['lane9', '--return'], ['lane9', '--abandon', 'x'], ['lane9', '--bogus'], ['lane9', '--notes', 'f'], ['--accept']]) {
    assert.equal(await main(argv, {}), 2, argv.join(' '))
  }
})
