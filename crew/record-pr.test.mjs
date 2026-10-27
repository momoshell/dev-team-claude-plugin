import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { main, parsePrUrl, recordPr } from './record-pr.mjs'
import { scratchDir } from '../test/helpers.mjs'

const URL1 = 'https://github.com/o/r/pull/12'
const STOP = [
  { event: 'stage-start', stage: 'build' },
  { event: 'verdict', stage: 'build', status: 'stopped', reason: 'x' },
  { event: 'stage-end', stage: 'build' },
]
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

function world() {
  const home = realpathSync(scratchDir('record-pr-'))
  const root = join(home, '.crew')
  mkdirSync(root)
  const lane = (name, { rows = STOP, base = root, leaf = name, text } = {}) => {
    const dir = join(base, `dt-${name}`, leaf)
    put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
    put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name }))
    put(join(dir, 'task', 'journal.jsonl'), text ?? jsonl(rows))
    return join(dir, 'task', 'journal.jsonl')
  }
  return { home, root, lane, done: () => rmSync(home, { recursive: true, force: true }) }
}
const run = (w, lane, url = URL1, extra = {}) => {
  const err = []
  const status = main([lane, '--pr', url], { root: w.root, stdout: () => {}, stderr: (t) => err.push(t), ...extra })
  return { status, err: err.join('') }
}

test('HF1 appends exactly one operator pr row after the original bytes, live and archived', () => {
  const w = world()
  try {
    const live = w.lane('a')
    const sib = w.lane('b', { leaf: 'b.archive-2026-10-01' })
    const arch = w.lane('c', { base: join(w.home, '.crew-journal-archive') })
    const bare = w.lane('d', { text: jsonl(STOP).trimEnd() })
    for (const [name, file] of [['a', live], ['b', sib], ['c', arch], ['d', bare]]) {
      const before = readFileSync(file, 'utf8')
      assert.equal(run(w, name).status, 0)
      const after = readFileSync(file, 'utf8')
      assert.ok(after.startsWith(before))
      const added = after.slice(before.length).split('\n').filter((line) => line.trim())
      assert.equal(added.length, 1)
      const row = JSON.parse(added[0])
      assert.deepEqual({ event: row.event, lane: row.lane, actor: row.actor, pr: row.pr }, { event: 'pr', lane: name, actor: 'operator', pr: { number: 12, url: URL1 } })
      assert.ok(after.endsWith('\n'))
      assert.equal(after.trim().split('\n').length, STOP.length + 1)
    }
  } finally { w.done() }
})

test('HF1 refuses open, reviewed, empty, torn, non-lean, missing lanes and bad arguments without writing', () => {
  const w = world()
  try {
    const files = {
      open: w.lane('open', { rows: [{ event: 'stage-start', stage: 'build' }] }),
      reviewed: w.lane('reviewed', { rows: [{ event: 'verdict', status: 'reviewed' }] }),
      empty: w.lane('empty', { text: '' }),
      torn: w.lane('torn', { text: jsonl(STOP) + '{torn\n' }),
      scalar: w.lane('scalar', { text: jsonl(STOP) + '3\n' }),
      ok: w.lane('ok'),
    }
    rmSync(join(w.root, 'dt-ok', 'ok', 'task', 'lean.json'))
    const outside = join(w.home, 'outside.jsonl')
    put(outside, jsonl(STOP))
    const esc = w.lane('esc')
    rmSync(esc); symlinkSync(outside, esc)
    files.esc = outside
    const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, 'utf8')]))
    for (const name of [...Object.keys(files), 'missing']) assert.equal(run(w, name).status, 1, name)
    for (const [k, f] of Object.entries(files)) assert.equal(readFileSync(f, 'utf8'), before[k], k)
    const f = w.lane('args'), text = readFileSync(f, 'utf8')
    for (const url of ['http://github.com/o/r/pull/1', 'https://github.com/o/r/pull/0', 'https://github.com/o/r/pull/1/files', 'https://github.com/o/r/pull/99999999999999999999', 'https://evil.example/o/r/pull/1']) {
      assert.equal(run(w, 'args', url).status, 1, url)
      assert.throws(() => parsePrUrl(url))
    }
    for (const argv of [[], ['args'], ['args', '--pr'], ['args', '--pr', URL1, 'x'], ['args', '--pr', URL1, '--pr', URL1], ['args', '--bogus', URL1], ['-x', '--pr', URL1]]) {
      assert.equal(main(argv, { root: w.root, stdout: () => {}, stderr: () => {} }), 2, argv.join(' '))
    }
    assert.equal(readFileSync(f, 'utf8'), text)
  } finally { w.done() }
})

test('HF1 an append failure is nonzero and the journal is unchanged', () => {
  const w = world()
  try {
    const f = w.lane('a'), text = readFileSync(f, 'utf8')
    const out = run(w, 'a', URL1, { append: () => { throw Object.assign(new Error('x'), { code: 'EIO' }) } })
    assert.equal(out.status, 1)
    assert.match(out.err, /EIO/)
    assert.equal(readFileSync(f, 'utf8'), text)
  } finally { w.done() }
})

test('HF3 refuses any lane that already records a pr, whoever wrote it and wherever it sits', () => {
  const w = world()
  try {
    assert.equal(run(w, 'ctl').status, 1)
    const control = w.lane('ctl')
    assert.equal(run(w, 'ctl').status, 0)
    const once = readFileSync(control, 'utf8')
    const second = run(w, 'ctl')
    assert.equal(second.status, 1)
    assert.match(second.err, /already records/)
    assert.equal(readFileSync(control, 'utf8'), once)
    const pr = { number: 3, url: 'https://github.com/o/r/pull/3' }
    let n = 0
    for (const row of [{ event: 'pr', pr }, { event: 'pr', pr, actor: 'loop' }, { event: 'pr', pr, actor: 'operator' }]) {
      for (const rows of [[...STOP, row], [row, ...STOP]]) {
        const name = `p${n++}`, f = w.lane(name, { rows }), text = readFileSync(f, 'utf8')
        assert.equal(run(w, name).status, 1, name)
        assert.equal(readFileSync(f, 'utf8'), text)
      }
    }
  } finally { w.done() }
})

test('recordPr stamps the clock it was given', () => {
  const w = world()
  try {
    const f = w.lane('a')
    recordPr({ lane: 'a', url: URL1, root: w.root, now: () => 42 })
    assert.equal(JSON.parse(readFileSync(f, 'utf8').trim().split('\n').at(-1)).at, 42)
  } finally { w.done() }
})
