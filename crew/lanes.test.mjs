import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { main } from './lanes.mjs'
import { scratchDir } from '../test/helpers.mjs'

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
  const run = (argv) => {
    const out = [], err = []
    const status = main(argv, { root, archiveRoot, stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
    return { status, out: out.join(''), err: err.join('') }
  }
  return { run, lane: (name, rows) => lane(root, name, rows), done: () => rmSync(home, { recursive: true, force: true }) }
}
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
