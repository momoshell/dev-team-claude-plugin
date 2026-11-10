import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { laneRows, main } from './lanes.mjs'
import { scratchDir, trackProcessGroupFile } from '../test/helpers.mjs'

const PR = 'https://github.com/o/r/pull/7'
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

function world() {
  const home = realpathSync(scratchDir('lanes-'))
  const root = join(home, '.crew')
  const archiveRoot = join(home, '.crew-journal-archive')
  const lane = (base, name, rows) => {
    const dir = join(base, `dt-${name}`, name)
    put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
    put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name }))
    put(join(dir, 'task', 'journal.jsonl'), jsonl(rows))
  }
  lane(root, 'alpha', [{ event: 'stage-start', stage: 'build' }, { event: 'verdict', stage: 'build', status: 'reviewed' }])
  lane(root, 'beta', [{ event: 'verdict', stage: 'build', status: 'stopped', reason: 'seat-unmeasured' }, { event: 'stage-end', stage: 'build' }])
  lane(root, 'gamma', [{ event: 'verdict', stage: 'review', status: 'reviewed' }, { event: 'pr', stage: 'publish', pr: { number: 7, url: PR } }])
  lane(archiveRoot, 'delta', [{ event: 'stage-start', stage: 'gate' }])
  const run = (argv, alive) => {
    const out = [], err = []
    const status = main(argv, { root, archiveRoot, alive, stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
    return { status, out: out.join(''), err: err.join('') }
  }
  return { root, archiveRoot, run, lane: (name, rows) => lane(root, name, rows), done: () => rmSync(home, { recursive: true, force: true }) }
}
const lines = (text) => text.trim().split('\n')

function seat(w, n) {
  const file = join(w.root, 'dt-deadplan', 'deadplan', 'seat-runtime', `acp-seat-${n}`, 'acp', 'planner', 'pgid')
  mkdirSync(dirname(file), { recursive: true })
  const tracked = trackProcessGroupFile(join(w.root, `seat-pgid-${n}`)), startedAt = Date.now()
  const spawned = spawnSync(process.execPath, ['-e', `const {spawn} = require('node:child_process'); const {writeFileSync} = require('node:fs'); const child = spawn('sleep', ['300'], {detached:true, stdio:'ignore'}); writeFileSync(process.argv[1], String(child.pid)); child.unref()`, tracked], { encoding: 'utf8' })
  assert.equal(spawned.status, 0, spawned.stderr)
  const pgid = Number(readFileSync(tracked, 'utf8'))
  put(file, String(pgid))
  put(join(file, '..', '..', '.planner.active.json'), JSON.stringify({ phase: 'running', dir: dirname(file), startedAt, owner: { pid: 123, startedAt }, at: Date.now(), pid: pgid, evidence: { kind: 'pgid', file } }))
  const date = new Date(startedAt).toString().split(' ')
  return { pgid, ps: `${pgid} ${pgid} ${date[0]} ${date[1]} ${date[2]} ${date[4]} ${date[3]} sh -c pgid=${file}\n` }
}

test('lanes stops a proven live seat process group of a dead plan-stage run and names it', () => {
  const w = world(), groups = []
  try {
    w.lane('deadplan', [{ event: 'stage-start', stage: 'plan' }])
    put(join(w.root, 'dt-deadplan', 'deadplan', 'task', 'run.pid'), '123\n')
    const run = (argv, group) => {
      const out = [], err = []
      const status = main(argv, { root: w.root, archiveRoot: w.archiveRoot, alive: () => false, spawnSync: () => ({ status: 0, stdout: group.ps }), stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
      assert.equal(status, 0, err.join(''))
      return out.join('')
    }
    const first = seat(w, 1); groups.push(first.pgid)
    const text = run([], first)
    assert.throws(() => process.kill(-first.pgid, 0), { code: 'ESRCH' })
    assert.equal(lines(text).at(-1), `stopped seat planner pgid ${first.pgid}`)
    const second = seat(w, 2); groups.push(second.pgid)
    const rows = JSON.parse(run(['--json'], second))
    assert.throws(() => process.kill(-second.pgid, 0), { code: 'ESRCH' })
    assert.deepEqual(rows.find((row) => row.lane === 'deadplan').seats, { stopped: [{ role: 'planner', pgid: second.pgid }], unproven: [] })
    for (const row of rows.filter((row) => row.lane !== 'deadplan')) assert.deepEqual(row.seats, { stopped: [], unproven: [] })
  } finally { for (const pgid of groups) try { process.kill(-pgid, 'SIGKILL') } catch {} ; w.done() }
})

test('a lane whose run died with no terminal row lists as stopped run-died; terminal tails and unproven pids are unchanged', () => {
  const home = realpathSync(scratchDir('lanes-'))
  try {
    const root = join(home, '.crew'), archiveRoot = join(home, 'archive')
    const tails = [
      ['stopped', { event: 'verdict', status: 'stopped', reason: 'x' }, false],
      ['pr', { event: 'pr', pr: { url: PR } }, false],
      ['ready', { event: 'finish-ready' }, false],
      ['abandon', { event: 'finish-decision', choice: 'abandon' }, false],
      ['return', { event: 'finish-decision', choice: 'return' }, true],
      ['live', { event: 'stage-start', stage: 'build' }, false],
      ['unknown', { event: 'stage-start', stage: 'build' }, false],
      ['missing', { event: 'stage-start', stage: 'build' }, false],
    ]
    for (const [name, tail] of tails) {
      const dir = join(root, `dt-${name}`, name)
      put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
      put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name }))
      put(join(dir, 'task', 'journal.jsonl'), jsonl([tail, { event: 'stage-end' }]))
      if (name !== 'missing') put(join(dir, 'task', 'run.pid'), name === 'live' ? '124\n' : name === 'unknown' ? '125\n' : '123\n')
    }
    const opts = { root, archiveRoot }
    const baseline = laneRows({ ...opts, alive: () => true })
    const actual = laneRows({ ...opts, alive: (pid) => pid === 123 ? false : pid === 124 ? true : null })
    for (const [name, , dead] of tails) {
      const row = actual.find((r) => r.lane === name)
      if (dead) assert.deepEqual([row.status, row.reason], ['stopped', 'run-died'])
      else assert.deepEqual(row, baseline.find((r) => r.lane === name))
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('an archived lane with no terminal row lists as stopped archived-without-terminal-row, even with a dead pid', () => {
  const w = world()
  try {
    put(join(w.archiveRoot, 'dt-delta', 'delta', 'task', 'run.pid'), '123\n')
    const alive = () => false
    const rows = laneRows({ root: w.root, archiveRoot: w.archiveRoot, all: true, alive })
    const delta = rows.find((row) => row.lane === 'delta')
    assert.deepEqual([delta.status, delta.reason, delta.archived], ['stopped', 'archived-without-terminal-row', true])
    assert.equal(rows.find((row) => row.lane === 'alpha').status, 'reviewed')
    assert.deepEqual(JSON.parse(w.run(['--all', '--json'], alive).out), rows.map((row) => ({ ...row, seats: { stopped: [], unproven: [] } })))
    assert.ok(lines(w.run(['--all'], alive).out).includes('delta | stopped | gate | archived-without-terminal-row | not recorded | archived'))
  } finally { w.done() }
})

test('LS1 LS4 LS5 lists live lanes with journal status, stop reason and PR url', () => {
  const w = world()
  try {
    const r = w.run([])
    assert.equal(r.status, 0)
    assert.deepEqual(lines(r.out), [
      'alpha | reviewed | build | not recorded | not recorded | not archived',
      'beta | stopped | build | seat-unmeasured | not recorded | not archived',
      `gamma | done | publish | not recorded | ${PR} | not archived`,
    ])
  } finally { w.done() }
})

test('LS2 LS3 archived lanes appear only with --all, marked archived', () => {
  const w = world()
  try {
    assert.ok(!w.run([]).out.includes('delta'))
    const all = lines(w.run(['--all']).out)
    assert.equal(all.length, 4)
    assert.equal(all.find((line) => line.startsWith('delta')), 'delta | stopped | gate | archived-without-terminal-row | not recorded | archived')
  } finally { w.done() }
})

test('--json prints the same rows', () => {
  const w = world()
  try {
    const rows = JSON.parse(w.run(['--json', '--all']).out)
    assert.deepEqual(rows.map((row) => row.lane), ['alpha', 'beta', 'delta', 'gamma'])
    assert.deepEqual(rows.find((row) => row.lane === 'beta'), { lane: 'beta', status: 'stopped', latest_stage: 'build', reason: 'seat-unmeasured', pr: null, archived: false, unreadable_rows: 0, unreadable_rows_reason: null, seats: { stopped: [], unproven: [] } })
    assert.equal(rows.find((row) => row.lane === 'gamma').pr, PR)
    assert.equal(rows.find((row) => row.lane === 'delta').archived, true)
  } finally { w.done() }
})

test('a bogus flag or positional prints usage and exits 2', () => {
  const w = world()
  try {
    for (const argv of [['--bogus'], ['alpha']]) {
      const r = w.run(argv)
      assert.equal(r.status, 2)
      assert.equal(r.err, 'usage: crew lanes [--all] [--json]\n')
    }
  } finally { w.done() }
})

// MUTATION: drop unreadable_rows from the row and a status read past a truncated row prints as definite.
test('a journal with an unreadable row flags its status and reports the count', () => {
  const home = realpathSync(scratchDir('lanes-'))
  try {
    const root = join(home, '.crew')
    const dir = join(root, 'dt-eps', 'eps')
    put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
    put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: 'eps' }))
    put(join(dir, 'task', 'journal.jsonl'), `${JSON.stringify({ event: 'stage-start', stage: 'review' })}\n{"event":"verdict","sta\n`)
    const run = (argv) => { const out = []; main(argv, { root, archiveRoot: join(home, 'archive'), stdout: (t) => out.push(t), stderr: () => {} }); return out.join('') }
    assert.match(run([]), /^eps \| running \(journal has 1 unreadable rows\) \| /)
    assert.equal(JSON.parse(run(['--json']))[0].unreadable_rows, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// MUTATION: count an unread journal's rows as 0 and an unmeasured journal reads as a clean one.
test('a journal that cannot be read reports its unreadable-row count as null with the read error', () => {
  const home = realpathSync(scratchDir('lanes-'))
  try {
    const root = join(home, '.crew')
    const dir = join(root, 'dt-zeta', 'zeta')
    put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
    put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: 'zeta' }))
    const out = []
    main(['--json'], { root, archiveRoot: join(home, 'archive'), stdout: (t) => out.push(t), stderr: () => {} })
    const [row] = JSON.parse(out.join(''))
    assert.equal(row.unreadable_rows, null)
    assert.equal(typeof row.unreadable_rows_reason, 'string')
    assert.notEqual(row.unreadable_rows_reason, '')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// MUTATION: let the finish decision hide a concurrent early stop and lanes loses the reason.
test('a finish return preserves a concurrent stop in either order without reviving older stops', () => {
  const w = world()
  try {
    const ready = { event: 'finish-ready' }, decision = { event: 'finish-decision', choice: 'return' }
    const stop = { event: 'verdict', stage: null, status: 'stopped', reason: 'seat-unmeasured' }
    const start = { event: 'stage-start', stage: 'build' }
    for (const [name, rows, status, reason] of [
      ['stop-first', [ready, stop, decision], 'stopped', 'seat-unmeasured'],
      ['decision-first', [ready, decision, stop], 'stopped', 'seat-unmeasured'],
      ['stop-after-ready', [ready, { ...stop, reason: 'invalid-input' }], 'stopped', 'invalid-input'],
      ['returned', [stop, ready, decision], 'returned', null],
      ['run-before-decision', [ready, stop, start, decision], 'running', null],
      ['run-after-decision', [ready, decision, stop, start], 'running', null],
    ]) {
      w.lane(name, rows)
      const row = JSON.parse(w.run(['--json']).out).find((r) => r.lane === name)
      assert.equal(row.status, status, name)
      assert.equal(row.reason, reason, name)
    }
  } finally { w.done() }
})

test('a child started before its anchored return decision invalidates the previous ready state', () => {
  const w = world()
  try {
    const ready = { event: 'finish-ready' }, start = { event: 'stage-start', stage: 'build' }
    const decision = { event: 'finish-decision', choice: 'return', launchedAt: 1 }
    for (const [name, rows, status] of [
      ['active', [ready, start, decision], 'running'],
      ['child-ready', [ready, start, ready, decision], 'ready-for-operator'],
      ['child-stopped', [ready, start, { event: 'verdict', status: 'stopped', reason: 'x' }, decision], 'stopped'],
    ]) {
      w.lane(name, rows)
      assert.equal(JSON.parse(w.run(['--json'], () => true).out).find((row) => row.lane === name).status, status, name)
    }
  } finally { w.done() }
})

test('LP1 LP2 lanes shows the PR of an accepted finish and a finish-ready lane as ready-for-operator', () => {
  const home = realpathSync(scratchDir('lanes-'))
  try {
    const root = join(home, '.crew')
    const lane = (name, rows) => {
      const dir = join(root, `dt-${name}`, name)
      put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
      put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name }))
      put(join(dir, 'task', 'journal.jsonl'), jsonl(rows))
    }
    const ready = [{ event: 'verdict', stage: 'build', status: 'reviewed' }, { event: 'finish-ready', status: 'ready-for-operator' }]
    lane('accepted', [...ready, { event: 'pr', stage: 'publish', pr: { number: 7, url: PR } }, { event: 'finish-decision', choice: 'accept' }])
    lane('waiting', ready)
    const out = []
    assert.equal(main(['--json'], { root, archiveRoot: join(home, 'archive'), stdout: (t) => out.push(t), stderr: () => {} }), 0)
    const rows = JSON.parse(out.join(''))
    const accepted = rows.find((row) => row.lane === 'accepted'), waiting = rows.find((row) => row.lane === 'waiting')
    assert.equal(accepted.status, 'done')
    assert.equal(accepted.pr, PR)
    assert.equal(waiting.status, 'ready-for-operator')
    assert.equal(waiting.pr, null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
