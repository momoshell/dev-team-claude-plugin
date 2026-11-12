import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './closeout.mjs'
import { decideFinish } from './finish.mjs'
import { laneRows } from './lanes.mjs'
import { probeAlive } from './run-pid.mjs'
import { git, gitResult, scratchDir, trackProcessGroupFile } from '../test/helpers.mjs'

const LANE = 'demo'
const PR_ROW = { event: 'pr', lane: LANE, pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const STOPPED = [
  { event: 'run-start', lane: LANE },
  { event: 'stage-start', stage: 'plan' },
  { event: 'envelope', role: 'planner', status: 'error' },
  { event: 'verdict', status: 'stopped', reason: 'seat-unmeasured' },
  { event: 'stage-end', stage: 'plan' },
]

function world({ rows = [{ event: 'run-start', lane: LANE }, PR_ROW], cwd, origin = 'git@github.com:o/r.git' } = {}) {
  const home = realpathSync(scratchDir('closeout-'))
  const checkout = join(home, 'repos', 'checkout')
  const worktree = join(home, 'repos', `dt-${LANE}`)
  const root = join(home, '.crew')
  const archiveRoot = join(home, '.crew-journal-archive')
  const laneDir = join(root, `dt-${LANE}`)
  const leaf = join(laneDir, LANE)
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(leaf, 'task'), { recursive: true })
  git(checkout, 'init', '-q', '-b', 'main')
  writeFileSync(join(checkout, 'tracked.txt'), 'one\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'one')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'worktree', 'add', '-q', '-b', LANE, worktree, 'main')
  writeFileSync(join(leaf, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
  git(checkout, 'worktree', 'add', '-q', '-b', 'other', join(home, 'repos', 'dt-other'), 'main')
  writeFileSync(join(leaf, 'task', 'lean.json'), JSON.stringify({ id: LANE, cwd: cwd?.(home) ?? worktree, branch: LANE, base: 'main' }))
  const journalText = jsonl(rows)
  writeFileSync(join(leaf, 'task', 'journal.jsonl'), journalText)
  return { home, checkout, worktree, root, archiveRoot, laneDir, leaf, journalText, done: () => rmSync(home, { recursive: true, force: true }) }
}

// Records every call in order; git runs for real, gh answers `state` and `headRefOid` (default: the lane tip).
function runner(state, head, calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'gh') return { status: 0, stdout: JSON.stringify({ state, headRefOid: head }), stderr: '' }
    return spawnSync(cmd, args, { encoding: 'utf8' })
  }
}

const tipOf = (w) => String(git(w.checkout, 'rev-parse', `refs/heads/${LANE}`)).trim()

function close(w, { state = 'MERGED', head = tipOf(w), argv = [LANE], psCommand, psStart = 0, ...extra } = {}) {
  const calls = [], err = [], out = [], run = runner(state, head, calls)
  const status = main(argv, { root: w.root, archiveRoot: w.archiveRoot, run: (cmd, args) => {
    if (cmd !== 'ps') return run(cmd, args)
    const file = join(w.leaf, 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid')
    const marker = JSON.parse(readFileSync(join(file, '..', '..', '.planner.active.json'), 'utf8'))
    const date = new Date(marker.startedAt + psStart).toString().split(' ')
    return { status: 0, stdout: `${args.at(-1)} ${args.at(-1)} ${date[0]} ${date[1]} ${date[2]} ${date[4]} ${date[3]} ${psCommand ?? `sh -c pgid=${file}`}\n` }
  }, stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...extra })
  return { status, calls, err: err.join(''), out: out.join('') }
}

const branchExists = (w) => gitResult(w.checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${LANE}`).status === 0

function assertUnchanged(w) {
  assert.ok(existsSync(w.worktree), 'worktree kept')
  assert.ok(branchExists(w), 'branch kept')
  assert.equal(readFileSync(join(w.leaf, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
  assert.ok(!existsSync(join(w.archiveRoot, `dt-${LANE}`)), 'no archive destination')
}

test('closeout preserves journal refusal messages for malformed and non-object rows (#2324)', () => {
  const w = world()
  try {
    const journal = join(w.leaf, 'task', 'journal.jsonl')
    for (const [text, kind] of [['{torn\n', 'malformed'], ['3\n', 'non-object']]) {
      writeFileSync(journal, w.journalText + text)
      const result = close(w)
      assert.equal(result.status, 1)
      assert.equal(result.err, `crew closeout: task journal has a ${kind} row\n`)
    }
  } finally { w.done() }
})

test('discard is not blocked by a claim whose pid now names a later process (S3-4)', () => {
  const w = world({ rows: [...STOPPED, PR_ROW] })
  try {
    writeFileSync(join(w.leaf, 'task', 'finish-1.claim'), `${process.pid} ${Date.now() - 86_400_000}\n`)
    const result = close(w, { state: 'CLOSED', argv: [LANE, '--discard'], alive: probeAlive })
    assert.equal(result.status, 0, result.err)
  } finally { w.done() }
})

test('discard ends a lane whose review stop is followed by the in-flight suite\'s rows (#2304)', () => {
  const rows = [
    { event: 'run-start', lane: LANE }, { event: 'stage-start', stage: 'suite' }, { event: 'stage-start', stage: 'review' },
    { event: 'verdict', stage: 'review', status: 'stopped', reason: 'seat-unmeasured' },
    { event: 'stage-end', stage: 'review' }, { event: 'check', stage: 'suite', check: 'suite', result: { status: 'green', code: 0 } },
    { event: 'stage-end', stage: 'suite' },
  ]
  for (const tail of [rows, [rows[0], rows[3], { at: 1, role: 'builder', advisor_usage: { provider: 'openai', billed_input_tokens: 1 } }]]) {
    const w = world({ rows: tail })
    try {
      const result = close(w, { argv: [LANE, '--discard'] })
      assert.equal(result.status, 0, result.err)
      assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`)))
    } finally { w.done() }
  }
})

test('discard ends an accepted lane whose published PR GitHub reports CLOSED', () => {
  for (const state of ['CLOSED', 'OPEN', 'MERGED', 'missing']) {
    const w = world({ rows: [...STOPPED, { event: 'finish-ready' }, ...(state === 'missing' ? [] : [PR_ROW]), { event: 'finish-decision', choice: 'accept' }] })
    try {
      const r = close(w, { state, argv: [LANE, '--discard'], alive: () => false })
      assert.equal(r.status, state === 'CLOSED' ? 0 : 1, r.err)
      if (state === 'CLOSED') assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`)))
      else {
        assert.match(r.err, state === 'missing' ? /crew finish demo/ : /lane recorded a pull request; use crew closeout demo/)
        assertUnchanged(w)
      }
    } finally { w.done() }
  }
})

test('closeout retried after a failed move archives the lane, treating the absent worktree and branch as done', () => {
  const w = world()
  try {
    const head = tipOf(w)
    const first = close(w, { renameSync: () => { throw Object.assign(new Error('move'), { code: 'EXDEV' }) } })
    assert.equal(first.status, 1)
    const retry = close(w, { head })
    assert.equal(retry.status, 0, retry.err)
    assert.match(retry.out, /already absent/)
    assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`)))
    assert.ok(!retry.calls.some((c) => c[0] === 'git'))
  } finally { w.done() }
  const other = world()
  try {
    git(other.checkout, 'worktree', 'remove', other.worktree)
    const r = close(other, { state: 'OPEN' })
    assert.equal(r.status, 1)
    assert.match(r.err, /not merged/)
    assert.ok(existsSync(other.laneDir))
    assert.ok(!r.calls.some((c) => c[0] === 'git'))
  } finally { other.done() }
})

test('discard ends a lane with no journal whose run pid is absent or dead', () => {
  for (const [pid, live] of [[false, false], [true, false], [true, true], [true, null]]) {
    const w = world()
    try {
      rmSync(join(w.leaf, 'task', 'journal.jsonl'))
      if (pid) writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
      const r = close(w, { argv: [LANE, '--discard'], alive: () => live })
      assert.equal(r.status, live === false ? 0 : 1, r.err)
      if (live === false) assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`)))
      else { assert.match(r.err, /not stopped/); assert.ok(existsSync(w.laneDir)) }
      assert.ok(!r.calls.some((c) => c[0] === 'gh'))
    } finally { w.done() }
  }
})

test('discard refuses a branch tip on neither a remote ref nor the base and prints the sha it deletes', () => {
  const w = world({ rows: STOPPED })
  try {
    writeFileSync(join(w.worktree, 'new.txt'), 'build\n')
    git(w.worktree, 'add', 'new.txt')
    git(w.worktree, 'commit', '-qm', 'build')
    const tip = tipOf(w)
    const refused = close(w, { argv: [LANE, '--discard'] })
    assert.equal(refused.status, 1)
    assert.ok(refused.err.includes(tip))
    assertUnchanged(w)
    git(w.checkout, 'update-ref', 'refs/remotes/origin/demo', tip)
    const result = close(w, { argv: [LANE, '--discard'] })
    assert.equal(result.status, 0, result.err)
    assert.ok(result.out.includes(`(was ${tip})`))
  } finally { w.done() }
})

test('a lane stopped in plan with no pull request is discarded: worktree and branch removed, lane archived, no gh call', () => {
  const w = world({ rows: STOPPED })
  try {
    const r = close(w, { argv: [LANE, '--discard'], renameSync: (from, to) => {
      assert.ok(!existsSync(w.worktree))
      assert.ok(!branchExists(w))
      renameSync(from, to)
    } })
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /^discarded demo:/)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.ok(!existsSync(w.laneDir))
    assert.equal(readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.deepEqual(r.calls.filter((c) => c[0] === 'git' && (c.includes('remove') || c.includes('-D'))).map((c) => c.slice(3, 5).join(' ')), ['worktree remove', 'branch -D'])
    assert.ok(!r.calls.some((c) => c[0] === 'gh'))
  } finally { w.done() }
})

test('a lane whose returned finish pass stopped is abandoned with crew finish and then discarded', async () => {
  const w = world({ rows: [
    { event: 'run-start', lane: LANE },
    { event: 'stage-start', stage: 'build' },
    { event: 'verdict', status: 'stopped', reason: 'round-bound' },
    { event: 'finish-decision', lane: LANE, choice: 'return', launchedAt: 3, notesSha256: 'x' },
    { event: 'stage-start', stage: 'triage' },
    { event: 'verdict', status: 'stopped', reason: 'lead-escalated' },
    { event: 'stage-end', stage: 'triage' },
  ] })
  try {
    const refused = close(w, { argv: [LANE, '--discard'] })
    assert.equal(refused.status, 1)
    assert.match(refused.err, /crew finish demo/)
    await assert.doesNotReject(decideFinish({ lane: LANE, root: w.root, choice: 'abandon', deps: { log: () => {} } }))
    const result = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(result.status, 0, result.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    const rows = readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(Number.isFinite(rows.at(-1).at))
    assert.deepEqual({ ...rows.at(-1), at: 0 }, { event: 'finish-decision', lane: LANE, choice: 'abandon', at: 0, notesSha256: null })
    assert.equal(rows.filter((row) => row.event === 'finish-decision' && row.choice === 'abandon').length, 1)
  } finally { w.done() }
})

test('a lane whose returned finish pass died is abandoned with crew finish and then discarded', async () => {
  const w = world({ rows: [
    { event: 'run-start', lane: LANE },
    { event: 'stage-start', stage: 'build' },
    { event: 'verdict', status: 'stopped', reason: 'round-bound' },
    { event: 'finish-decision', lane: LANE, choice: 'return', launchedAt: 3, notesSha256: 'x' },
    { event: 'stage-start', stage: 'triage' },
  ] })
  try {
    const journal = join(w.leaf, 'task', 'journal.jsonl')
    const pidFile = join(w.leaf, 'task', 'run.pid')
    const decide = (alive) => decideFinish({ lane: LANE, root: w.root, choice: 'abandon', deps: { log: () => {}, alive } })
    for (const [hasPid, alive] of [[false, () => false], [true, () => true], [true, () => null]]) {
      if (hasPid) writeFileSync(pidFile, '123\n')
      await assert.rejects(decide(alive), { reason: 'finish-decided' })
      assert.equal(readFileSync(journal, 'utf8'), w.journalText)
    }
    let result
    await assert.doesNotReject(async () => { result = await decide((pid) => pid !== 123) })
    assert.deepEqual(result, { lane: LANE, choice: 'abandon' })
    const recorded = readFileSync(journal, 'utf8')
    const rows = recorded.trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 6)
    assert.ok(Number.isFinite(rows.at(-1).at))
    assert.deepEqual({ ...rows.at(-1), at: 0 }, { event: 'finish-decision', lane: LANE, choice: 'abandon', at: 0, notesSha256: null })
    await assert.rejects(decide((pid) => pid !== 123), { reason: 'finish-decided' })
    assert.equal(readFileSync(journal, 'utf8'), recorded)
    const closed = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(closed.status, 0, closed.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.equal(readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8'), recorded)
  } finally { w.done() }
})

test('discard holds the finish stop claim throughout teardown', () => {
  const w = world({ rows: STOPPED })
  try {
    let attempted = false
    const run = runner('MERGED', tipOf(w), [])
    const r = close(w, { argv: [LANE, '--discard'], run: (cmd, args) => {
      if (!attempted) {
        attempted = true
        assert.throws(() => writeFileSync(join(w.leaf, 'task', 'finish-3.claim'), '999\n', { flag: 'wx' }), { code: 'EEXIST' })
      }
      return run(cmd, args)
    } })
    assert.equal(r.status, 0, r.err)
    assert.ok(attempted)
    assert.ok(!existsSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'finish-3.claim')))
  } finally { w.done() }
})

test('discard tears down a stopped lane whose recorded PR is closed unmerged', () => {
  for (const rows of [[PR_ROW, ...STOPPED], [...STOPPED, PR_ROW], [{ event: 'run-start', lane: LANE }, PR_ROW]]) {
    const w = world({ rows })
    try {
      if (rows.length === 2) writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
      const r = close(w, { state: 'CLOSED', argv: [LANE, '--discard'], alive: () => false, renameSync: (from, to) => {
        assert.ok(!existsSync(w.worktree))
        assert.ok(!branchExists(w))
        renameSync(from, to)
      } })
      assert.equal(r.status, 0, r.err)
      assert.match(r.out, /^discarded demo:/)
      assert.ok(!existsSync(w.laneDir))
      assert.equal(readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
      assert.deepEqual(r.calls.filter((c) => c[0] === 'gh'), [['gh', 'pr', 'view', PR_ROW.pr.url, '--json', 'state']])
      assert.deepEqual(r.calls.filter((c) => c[0] === 'git' && (c.includes('remove') || c.includes('-D'))).map((c) => c.slice(3, 5).join(' ')), ['worktree remove', 'branch -D'])
      assert.ok(!r.calls.some((c) => c.includes('push') || c.includes('--force')))
    } finally { w.done() }
  }
})

test('discard refuses a stopped lane whose recorded PR is not closed, with nothing changed', () => {
  for (const state of ['OPEN', 'MERGED', 'UNKNOWN', null]) {
    const w = world({ rows: [PR_ROW, ...STOPPED] })
    try {
      const r = close(w, { state, argv: [LANE, '--discard'] })
      assert.equal(r.status, 1)
      assert.match(r.err, /lane recorded a pull request; use crew closeout demo/)
      assert.deepEqual(r.calls, [['gh', 'pr', 'view', PR_ROW.pr.url, '--json', 'state']])
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('discard refuses a closed-PR lane when gh cannot prove the PR is closed, with nothing changed', () => {
  for (const [result, error] of [[{ status: 1, stderr: 'offline' }, /gh pr view failed: offline/], [{ status: 0, stdout: '{' }, /gh pr view returned unparseable output/]]) {
    const w = world({ rows: [PR_ROW, ...STOPPED] })
    try {
      const calls = []
      const r = close(w, { argv: [LANE, '--discard'], run: (cmd, args) => { calls.push([cmd, ...args]); return result } })
      assert.equal(r.status, 1)
      assert.match(r.err, error)
      assert.deepEqual(calls, [['gh', 'pr', 'view', PR_ROW.pr.url, '--json', 'state']])
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('discard of a closed-PR lane still refuses a finish record and a lane not proven stopped, with nothing changed', () => {
  for (const [rows, error, ghCalls] of [
    [[PR_ROW, ...STOPPED, { event: 'finish-ready' }], /crew finish demo/, 0],
    [[PR_ROW, ...STOPPED, { event: 'finish-decision' }], /crew finish demo/, 0],
    [[PR_ROW, { event: 'stage-start', stage: 'plan' }], /not stopped/, 1],
    [[{ event: 'run-start', lane: LANE }, PR_ROW], /not stopped/, 1],
  ]) {
    const w = world({ rows })
    try {
      const r = close(w, { state: 'CLOSED', argv: [LANE, '--discard'] })
      assert.equal(r.status, 1)
      assert.match(r.err, error)
      assert.equal(r.calls.length, ghCalls)
      if (ghCalls) assert.deepEqual(r.calls[0], ['gh', 'pr', 'view', PR_ROW.pr.url, '--json', 'state'])
      assertUnchanged(w)
    } finally { w.done() }
  }
  for (const [file, alive] of [['run.pid', true], ['run.pid', null], ['finish-3.claim', true], ['finish-3.reclaim', true]]) {
    const w = world({ rows: [...STOPPED, PR_ROW] })
    try {
      writeFileSync(join(w.leaf, 'task', file), '123\n')
      const r = close(w, { state: 'CLOSED', argv: [LANE, '--discard'], alive: () => alive })
      assert.equal(r.status, 1)
      assert.match(r.err, /not stopped/)
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('discard refuses a lane with a finish-ready row, naming crew finish, with nothing changed', () => {
  for (const event of ['finish-ready', 'finish-decision']) {
    const w = world({ rows: [...STOPPED, { event }] })
    try {
      const r = close(w, { argv: [LANE, '--discard'] })
      assert.equal(r.status, 1, event)
      assert.match(r.err, /crew finish demo/)
      assert.equal(r.calls.length, 0)
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('a dead run with no pull request and no stop verdict is discarded', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'plan' }] })
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    const r = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(r.status, 0, r.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.equal(readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.ok(!r.calls.some((c) => c[0] === 'gh'))
  } finally { w.done() }
})

function seat(w, unbound = false) {
  const file = join(w.leaf, 'seat-runtime', 'acp-seat-test', 'acp', 'planner', 'pgid')
  mkdirSync(join(file, '..'), { recursive: true })
  const tracked = trackProcessGroupFile(join(w.home, 'seat-pgid'))
  const startedAt = Date.now()
  const spawned = spawnSync(process.execPath, ['-e', `const {spawn} = require('node:child_process'); const {writeFileSync} = require('node:fs'); const child = spawn('sleep', ['300'], {detached:true, stdio:'ignore'}); writeFileSync(process.argv[1], String(child.pid)); child.unref()`, tracked], { encoding: 'utf8' })
  assert.equal(spawned.status, 0, spawned.stderr)
  const pgid = Number(readFileSync(tracked, 'utf8'))
  writeFileSync(file, String(pgid))
  writeFileSync(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: join(file, '..'), startedAt, owner: { pid: 123, startedAt }, at: Date.now(), pid: pgid, evidence: { kind: 'pgid', file: unbound ? file + '-other' : file } }))
  return pgid
}

test('discard of a dead run stops a proven live seat process group recorded under seat-runtime and names it', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'plan' }] })
  let pgid
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    pgid = seat(w)
    const r = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(r.status, 0, r.err)
    assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' })
    assert.match(r.out, new RegExp(`stopped.*planner.*${pgid}`))
    assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`, LANE)))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('closeout leaves a reused pgid whose live leader is not the recorded seat alone and reports it unproven', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'plan' }] })
  let pgid
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    pgid = seat(w)
    const r = close(w, { argv: [LANE, '--discard'], alive: () => false, psCommand: 'sleep 300' })
    assert.equal(r.status, 0, r.err)
    assert.doesNotThrow(() => process.kill(-pgid, 0))
    assert.match(r.out, new RegExp(`planner.*${pgid}.*not proven`))
    assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`, LANE)))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('closeout reports an unreadable seat-runtime entry as not proven instead of skipping it', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'plan' }] })
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    const acp = join(w.leaf, 'seat-runtime', 'acp-seat-test', 'acp')
    mkdirSync(join(acp, '..'), { recursive: true })
    writeFileSync(acp, 'not a directory')
    const r = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(r.status, 0, r.err)
    assert.ok(r.out.includes(acp) && r.out.includes('not proven'))
    assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`, LANE)))
  } finally { w.done() }
})

test('closeout leaves a recorded pgid it cannot prove is the seat alone and reports it unproven', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'plan' }] })
  let pgid
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    pgid = seat(w, true)
    const r = close(w, { argv: [LANE, '--discard'], alive: () => false })
    assert.equal(r.status, 0, r.err)
    assert.doesNotThrow(() => process.kill(-pgid, 0))
    assert.match(r.out, new RegExp(`planner.*${pgid}.*not proven`))
    assert.ok(existsSync(join(w.archiveRoot, `dt-${LANE}`, LANE)))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('merged closeout stops a proven live seat process group recorded under seat-runtime and names it', () => {
  const w = world()
  let pgid
  try {
    pgid = seat(w)
    const r = close(w, { alive: () => false })
    assert.equal(r.status, 0, r.err)
    assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' })
    assert.match(r.out, new RegExp(`stopped.*planner.*${pgid}`))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('merged closeout leaves a seat group whose marker owner is alive and reports it unproven', () => {
  const w = world()
  let pgid
  try {
    pgid = seat(w)
    const r = close(w, { alive: () => true })
    assert.equal(r.status, 0, r.err)
    assert.doesNotThrow(() => process.kill(-pgid, 0))
    assert.match(r.out, new RegExp(`planner.*${pgid}.*not proven`))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('merged closeout leaves a seat group whose ps start time is outside the marker window and reports it unproven', () => {
  const w = world()
  let pgid
  try {
    pgid = seat(w)
    const r = close(w, { alive: () => false, psStart: -3_600_000 })
    assert.equal(r.status, 0, r.err)
    assert.doesNotThrow(() => process.kill(-pgid, 0))
    assert.match(r.out, new RegExp(`planner.*${pgid}.*not proven`))
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('discard refuses a lane whose recorded pid is still alive, with nothing changed', () => {
  for (const { rows, file, pid, alive } of [
    ...[true, null].map((result) => ({ rows: [{ event: 'stage-start', stage: 'plan' }], file: 'run.pid', pid: '123\n', alive: () => result })),
    ...[true, null].map((result) => ({ rows: STOPPED, file: 'run.pid', pid: '123\n', alive: () => result })),
    ...['123\n', ''].map((pid) => ({ rows: STOPPED, file: 'finish-3.claim', pid, alive: () => true })),
    { rows: STOPPED, file: 'finish-3.reclaim', pid: '123\n', alive: () => true },
  ]) {
    const w = world({ rows })
    try {
      writeFileSync(join(w.leaf, 'task', file), pid)
      const r = close(w, { argv: [LANE, '--discard'], alive })
      assert.equal(r.status, 1)
      assert.match(r.err, /not stopped/)
      assert.equal(r.calls.length, 0)
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('discard refuses a worktree with uncommitted changes, with nothing changed', () => {
  const w = world({ rows: STOPPED })
  try {
    writeFileSync(join(w.worktree, 'dirty.txt'), 'x\n')
    const r = close(w, { argv: [LANE, '--discard'] })
    assert.equal(r.status, 1)
    assert.match(r.err, /git worktree remove failed/)
    assert.ok(!r.calls.some((c) => c.includes('--force') || c.includes('-D') || c[0] === 'gh'))
    assertUnchanged(w)
    assert.ok(existsSync(join(w.worktree, 'dirty.txt')))
  } finally { w.done() }
})

test('discard refuses a lean.json naming another lane worktree, with nothing changed', () => {
  for (const wrongBranch of [false, true]) {
    const w = world({ rows: STOPPED, ...(wrongBranch ? {} : { cwd: (home) => join(home, 'repos', 'dt-other') }) })
    try {
      if (wrongBranch) git(w.worktree, 'switch', '-q', '-c', 'side')
      const r = close(w, { argv: [LANE, '--discard'] })
      assert.equal(r.status, 1)
      assert.match(r.err, wrongBranch ? /refs\/heads\/side, not demo/ : /is not dt-demo/)
      assert.ok(!r.calls.some((c) => c.includes('remove') || c.includes('-D') || c[0] === 'gh'))
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('closeout usage names --discard and bad discard usage exits 2', () => {
  const w = world({ rows: STOPPED })
  try {
    for (const argv of [[], [''], ['', '--discard'], ['--discard'], [LANE, '--discard', '--discard'], [LANE, 'bad'], ['--discard', LANE]]) {
      const r = close(w, { argv })
      assert.equal(r.status, 2)
      assert.equal(r.err, 'usage: crew closeout <lane> [--discard]\n')
      assert.equal(r.calls.length, 0)
    }
    assertUnchanged(w)
  } finally { w.done() }
})

test('a dead run with no pull request is refused as run-died naming crew record-pr, with nothing changed', () => {
  const w = world({ rows: [{ event: 'stage-start', stage: 'build' }] })
  try {
    writeFileSync(join(w.leaf, 'task', 'run.pid'), '123\n')
    const r = close(w, { alive: (pid) => pid === 123 ? false : null })
    assert.equal(r.status, 1)
    assert.match(r.err, /run-died.*pid 123.*crew record-pr demo --pr <url>/)
    assert.equal(r.calls.length, 0)
    assertUnchanged(w)
  } finally { w.done() }
})

test('CL1-CL3 a merged clean lane loses worktree and branch and moves to the archive, in order', () => {
  const w = world()
  try {
    const r = close(w)
    assert.equal(r.status, 0, r.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.ok(!existsSync(w.laneDir))
    assert.equal(readFileSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    const effects = r.calls.filter((c) => c[0] === 'git' && (c.includes('remove') || c.includes('-D'))).map((c) => c.slice(3, 5).join(' '))
    assert.deepEqual(effects, ['worktree remove', 'branch -D'])
    assert.deepEqual(r.calls.find((c) => c[0] === 'gh'), ['gh', 'pr', 'view', PR_ROW.pr.url, '--json', 'state,headRefOid'])
  } finally { w.done() }
})

test('a lane archived before is closed out to the next free archive destination, keeping the previous archive', () => {
  const w = world()
  try {
    const previous = join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl')
    cpSync(w.laneDir, join(w.archiveRoot, `dt-${LANE}`), { recursive: true })
    const previousText = jsonl([{ event: 'pr', pr: { number: 6, url: 'https://github.com/o/r/pull/6' } }])
    writeFileSync(previous, previousText)
    const destination = join(w.archiveRoot, `dt-${LANE}.archive-2`)
    const r = close(w)
    assert.equal(r.status, 0, r.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.ok(!existsSync(w.laneDir))
    assert.equal(readFileSync(previous, 'utf8'), previousText)
    assert.equal(readFileSync(join(destination, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.ok(r.out.includes(destination))
    assert.equal(laneRows({ root: w.root, archiveRoot: w.archiveRoot, all: true })[0].pr, PR_ROW.pr.url)
    rmSync(join(w.archiveRoot, `dt-${LANE}`), { recursive: true })
    assert.equal(laneRows({ root: w.root, archiveRoot: w.archiveRoot, all: true })[0].pr, PR_ROW.pr.url)
  } finally { w.done() }
})

test('archive selection ignores older directory metadata changes', () => {
  const w = world({ rows: [{ event: 'run-start', lane: LANE, at: 200 }, PR_ROW] })
  try {
    const previous = join(w.archiveRoot, `dt-${LANE}`)
    cpSync(w.laneDir, previous, { recursive: true })
    writeFileSync(join(previous, LANE, 'task', 'journal.jsonl'), jsonl([
      { event: 'run-start', lane: LANE, at: 100 },
      { event: 'pr', pr: { number: 6, url: 'https://github.com/o/r/pull/6' }, at: 300 },
    ]))
    const r = close(w)
    assert.equal(r.status, 0, r.err)
    chmodSync(previous, 0o700)
    assert.equal(laneRows({ root: w.root, archiveRoot: w.archiveRoot, all: true })[0].pr, PR_ROW.pr.url)
  } finally { w.done() }
})

test('a discarded lane archived before is archived to a suffixed destination, keeping the previous archive', () => {
  const w = world({ rows: STOPPED })
  try {
    const previous = join(w.archiveRoot, `dt-${LANE}`, LANE, 'task', 'journal.jsonl')
    mkdirSync(join(w.archiveRoot, `dt-${LANE}`, LANE, 'task'), { recursive: true })
    writeFileSync(previous, 'previous journal\n')
    const destination = join(w.archiveRoot, `dt-${LANE}.archive-2`)
    const r = close(w, { argv: [LANE, '--discard'] })
    assert.equal(r.status, 0, r.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.ok(!existsSync(w.laneDir))
    assert.ok(!r.calls.some((c) => c[0] === 'gh'))
    assert.equal(readFileSync(previous, 'utf8'), 'previous journal\n')
    assert.equal(readFileSync(join(destination, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.ok(r.out.includes(destination))
  } finally { w.done() }
})

test('a third archive of one lane name takes the next free suffix and keeps both earlier archives', () => {
  const w = world()
  try {
    const previous = [`dt-${LANE}`, `dt-${LANE}.archive-2`].map((name, i) => {
      const task = join(w.archiveRoot, name, LANE, 'task')
      mkdirSync(task, { recursive: true })
      const journal = join(task, 'journal.jsonl')
      writeFileSync(journal, `previous journal ${i}\n`)
      return journal
    })
    const destination = join(w.archiveRoot, `dt-${LANE}.archive-3`)
    const r = close(w)
    assert.equal(r.status, 0, r.err)
    assert.ok(!existsSync(w.worktree))
    assert.ok(!branchExists(w))
    assert.ok(!existsSync(w.laneDir))
    for (const [i, journal] of previous.entries()) assert.equal(readFileSync(journal, 'utf8'), `previous journal ${i}\n`)
    assert.equal(readFileSync(join(destination, LANE, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.ok(r.out.includes(destination))
  } finally { w.done() }

  const gap = world({ rows: [{ event: 'run-start', lane: LANE, at: 200 }, PR_ROW] })
  try {
    for (const name of [`dt-${LANE}`, `dt-${LANE}.archive-3`]) {
      const dir = join(gap.archiveRoot, name)
      cpSync(gap.laneDir, dir, { recursive: true })
      writeFileSync(join(dir, LANE, 'task', 'journal.jsonl'), jsonl([{ event: 'run-start', lane: LANE, at: 100 }, { event: 'pr', pr: { url: 'https://github.com/o/r/pull/6' } }]))
    }
    const r = close(gap)
    assert.equal(r.status, 0, r.err)
    assert.ok(r.out.includes(join(gap.archiveRoot, `dt-${LANE}.archive-2`)))
    assert.equal(laneRows({ root: gap.root, archiveRoot: gap.archiveRoot, all: true })[0].pr, PR_ROW.pr.url)
  } finally { gap.done() }
})

test('the move is the last effect: a failing rename happens after worktree and branch, and nothing is deleted', () => {
  const w = world()
  try {
    const order = []
    const r = close(w, { renameSync: () => { order.push('rename'); throw Object.assign(new Error('x'), { code: 'EXDEV' }) } })
    assert.equal(r.status, 1)
    assert.ok(!existsSync(w.worktree) && !branchExists(w))
    assert.equal(readFileSync(join(w.leaf, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
    assert.deepEqual(order, ['rename'])
  } finally { w.done() }
})

test('CL4 an unmerged PR is refused with nothing changed', () => {
  const w = world()
  try {
    const r = close(w, { state: 'OPEN' })
    assert.equal(r.status, 1)
    assert.match(r.err, /not merged/)
    assertUnchanged(w)
    assert.ok(!r.calls.some((c) => c.includes('remove') || c.includes('-D')))
  } finally { w.done() }
})

test('an unmerged closeout does not signal a proven seat', () => {
  const w = world()
  let pgid
  try {
    pgid = seat(w)
    const r = close(w, { state: 'OPEN', alive: () => false })
    assert.equal(r.status, 1)
    assert.doesNotThrow(() => process.kill(-pgid, 0))
    assertUnchanged(w)
  } finally { if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

// MUTATION CL5: pass --force to git worktree remove and the dirty worktree is deleted.
test('CL5 a worktree with uncommitted changes is refused with nothing changed', () => {
  const w = world()
  try {
    writeFileSync(join(w.worktree, 'dirty.txt'), 'x\n')
    const r = close(w)
    assert.equal(r.status, 1)
    assert.match(r.err, /git worktree remove failed/)
    assertUnchanged(w)
    assert.ok(existsSync(join(w.worktree, 'dirty.txt')))
  } finally { w.done() }
})

test('bad usage exits 2; a missing lane or a journal with no pr row is refused with nothing changed', () => {
  const w = world({ rows: [{ event: 'run-start', lane: LANE }] })
  try {
    assert.equal(close(w, { argv: [] }).status, 2)
    assert.equal(close(w, { argv: [LANE, 'x'] }).status, 2)
    assert.equal(close(w, { argv: ['nope'] }).status, 1)
    const r = close(w)
    assert.equal(r.status, 1)
    assert.match(r.err, /no pull request/)
    assertUnchanged(w)
    assert.equal(r.calls.length, 0)
  } finally { w.done() }
})

// MUTATION: drop the dt-<lane> check and closeout removes the worktree lean.json names, whoever's it is.
test('a lean.json naming another lane worktree is refused with nothing changed', () => {
  const w = world({ cwd: (home) => join(home, 'repos', 'dt-other') })
  try {
    const r = close(w)
    assert.equal(r.status, 1)
    assert.match(r.err, /is not dt-demo/)
    assertUnchanged(w)
    assert.ok(existsSync(join(w.home, 'repos', 'dt-other')))
    assert.equal(gitResult(w.checkout, 'rev-parse', '--verify', '--quiet', 'refs/heads/other').status, 0)
  } finally { w.done() }
})

// MUTATION: drop the head comparison and a branch carrying commits GitHub never merged is deleted.
test('a branch whose tip is not the merged PR head is refused with nothing changed', () => {
  const w = world()
  try {
    const merged = tipOf(w)
    writeFileSync(join(w.worktree, 'later.txt'), 'x\n')
    git(w.worktree, 'add', '.')
    git(w.worktree, 'commit', '-qm', 'after the merge')
    const r = close(w, { head: merged })
    assert.equal(r.status, 1)
    assert.match(r.err, /not the merged head/)
    assertUnchanged(w)
  } finally { w.done() }
})

// MUTATION: drop the symbolic-ref check and a dt-<lane> worktree switched to another branch is removed.
test('a lane worktree checked out on another branch is refused with nothing changed', () => {
  const w = world()
  try {
    git(w.worktree, 'switch', '-q', '-c', 'side')
    const r = close(w)
    assert.equal(r.status, 1)
    assert.match(r.err, /refs\/heads\/side, not demo/)
    assertUnchanged(w)
  } finally { w.done() }
})

// MUTATION: drop the origin comparison and a merged PR in another repository authorizes deleting this branch.
test('a merged PR from another repository is refused with nothing changed', () => {
  const w = world({ origin: 'https://github.com/o/elsewhere.git' })
  try {
    const r = close(w)
    assert.equal(r.status, 1)
    assert.match(r.err, /not in this worktree's origin \(o\/elsewhere\)/)
    assertUnchanged(w)
  } finally { w.done() }
})

// MUTATION: unanchor the host in repoOf and a lookalike host ending in github.com passes as this repository.
test('an origin on a lookalike host is refused with nothing changed', () => {
  for (const origin of ['https://evilgithub.com/o/r.git', 'git@evilgithub.com:o/r.git', 'https://github.com.evil.io/o/r.git']) {
    const w = world({ origin })
    try {
      const r = close(w)
      assert.equal(r.status, 1, origin)
      assert.match(r.err, /not a GitHub remote/)
      assertUnchanged(w)
    } finally { w.done() }
  }
})

test('https and ssh GitHub origins both match the PR repository', () => {
  for (const origin of ['https://github.com/O/R.git', 'ssh://git@github.com/o/r', 'git@github.com:o/r.git']) {
    const w = world({ origin })
    try { assert.equal(close(w).status, 0, origin) } finally { w.done() }
  }
})
