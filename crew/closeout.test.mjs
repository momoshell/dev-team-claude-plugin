import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './closeout.mjs'
import { git, gitResult, scratchDir } from '../test/helpers.mjs'

const LANE = 'demo'
const PR_ROW = { event: 'pr', lane: LANE, pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

function world({ rows = [{ event: 'run-start', lane: LANE }, PR_ROW], cwd } = {}) {
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
  git(checkout, 'worktree', 'add', '-q', '-b', LANE, worktree, 'main')
  writeFileSync(join(leaf, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
  git(checkout, 'worktree', 'add', '-q', '-b', 'other', join(home, 'repos', 'dt-other'), 'main')
  writeFileSync(join(leaf, 'task', 'lean.json'), JSON.stringify({ id: LANE, cwd: cwd?.(home) ?? worktree, branch: LANE }))
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

function close(w, { state = 'MERGED', head = tipOf(w), argv = [LANE], ...extra } = {}) {
  const calls = [], err = [], out = []
  const status = main(argv, { root: w.root, archiveRoot: w.archiveRoot, run: runner(state, head, calls), stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...extra })
  return { status, calls, err: err.join(''), out: out.join('') }
}

const branchExists = (w) => gitResult(w.checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${LANE}`).status === 0

function assertUnchanged(w) {
  assert.ok(existsSync(w.worktree), 'worktree kept')
  assert.ok(branchExists(w), 'branch kept')
  assert.equal(readFileSync(join(w.leaf, 'task', 'journal.jsonl'), 'utf8'), w.journalText)
  assert.ok(!existsSync(join(w.archiveRoot, `dt-${LANE}`)), 'no archive destination')
}

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
