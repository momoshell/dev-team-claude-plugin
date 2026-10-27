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
  lane(archiveRoot, 'delta', [{ event: 'stage-start', stage: 'gate' }])
  const run = (argv) => {
    const out = [], err = []
    const status = main(argv, { root, archiveRoot, stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
    return { status, out: out.join(''), err: err.join('') }
  }
  return { run, done: () => rmSync(home, { recursive: true, force: true }) }
}
const lines = (text) => text.trim().split('\n')

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
    assert.equal(all.find((line) => line.startsWith('delta')), 'delta | running | gate | not recorded | not recorded | archived')
  } finally { w.done() }
})

test('--json prints the same rows', () => {
  const w = world()
  try {
    const rows = JSON.parse(w.run(['--json', '--all']).out)
    assert.deepEqual(rows.map((row) => row.lane), ['alpha', 'beta', 'delta', 'gamma'])
    assert.deepEqual(rows.find((row) => row.lane === 'beta'), { lane: 'beta', status: 'stopped', latest_stage: 'build', reason: 'seat-unmeasured', pr: null, archived: false, unreadable_rows: 0 })
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
