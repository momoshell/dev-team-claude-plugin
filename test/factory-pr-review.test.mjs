import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symlinkSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scratchDir } from './helpers.mjs'
import { assertUsage, parseArgs, reviewIdentityFromArgs } from '../crew/crew.mjs'
import { canonicalWorktreePath,
  PrReviewError,
  parseChangedFiles,
  reportCounts,
  removeWorktreeDefault,
  runPrReview,
  main,
} from '../scripts/factory/pr-review.mjs'

const BASE40 = 'a'.repeat(40)
const HEAD40 = 'b'.repeat(40)
const BASE64 = 'c'.repeat(64)
const HEAD64 = 'd'.repeat(64)

function terminal(pointer, status = 'done') {
  return JSON.stringify({ status, commit: null, task_return: pointer, archived: null })
}

function fixture({
  runMode = 'success',
  teardownMode = 'success',
  removeMode = 'success',
  values = { base: BASE40, head: HEAD40, outcome: 'findings', findings: [{ id: 'F1', location: 'src/a.mjs' }] },
  taskStatus = 'done',
  taskValue = null,
} = {}) {
  const root = scratchDir('pr-review-fixture-')
  const checkout = join(root, 'checkout')
  mkdirSync(checkout, { recursive: true })
  const pointer = join(root, 'task.json')
  const calls = { gh: [], git: [], crew: [], reads: [], writes: [], remove: 0, teardownRead: false }
  const registrations = new Set()
  let worktree = null
  let task = taskValue || { status: taskStatus, details: { envelope: { values } } }
  const deps = {
    checkout,
    tempRoot: root,
    gh: (args, options) => {
      calls.gh.push({ args: [...args], options })
      return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD40, title: 'fixture title', body: 'fixture body' }) }
    },
    git: (args, options) => {
      calls.git.push({ args: [...args], options })
      if (args[0] === 'merge-base') return { status: 0, stdout: `${BASE40}\n` }
      if (args[0] === 'diff' && args[1] === '--name-only') return { status: 0, stdout: 'src/a.mjs\0src/b.mjs\0' }
      if (args[0] === 'diff') return { status: 0, stdout: 'diff --git a/src/a.mjs b/src/a.mjs\n' }
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktree = args[3]
        mkdirSync(worktree, { recursive: true })
        registrations.add(worktree)
        return { status: 0, stdout: '' }
      }
      return { status: 0, stdout: '' }
    },
    crew: async (args, options) => {
      calls.crew.push({ args: [...args], options })
      if (args[0] === 'boot') return { status: 0, stdout: '' }
      if (args[0] === 'run') {
        if (runMode === 'refusal') return { status: 1, stdout: 'crew refused before a terminal envelope\n' }
        if (runMode === 'crash') throw new Error('crew driver crashed')
        return { status: 0, stdout: `progress\n${terminal(pointer)}\n` }
      }
      if (args[0] === 'teardown') {
        calls.teardownRead = calls.reads.includes(pointer)
        if (teardownMode === 'reject') throw new Error('teardown rejected')
        return { status: 0, stdout: '' }
      }
      return { status: 0, stdout: '' }
    },
    readFile: (path, encoding) => {
      calls.reads.push(path)
      if (path.endsWith('/skills/pr-review/SKILL.md')) return '# fixture skill\n'
      if (path.endsWith('/skills/pr-review/references/rubric.md')) return '# fixture rubric\n'
      if (path === pointer) return task
      return readFileSync(path, encoding)
    },
    writeFile: (path, data, encoding) => {
      calls.writes.push({ path, data: String(data) })
      writeFileSync(path, data, encoding)
    },
    removeWorktree: (_checkout, path) => {
      calls.remove += 1
      if (removeMode === 'fail') return { removed: false, why: 'injected removal failure', workdir: path }
      rmSync(path, { recursive: true, force: true })
      registrations.delete(path)
      return { removed: true, why: null, workdir: path }
    },
  }
  return {
    root,
    checkout,
    pointer,
    calls,
    registrations,
    get worktree() { return worktree },
    deps,
    setTask(value) { task = value },
  }
}

function assertCleaned(fixtureValue) {
  assert.ok(fixtureValue.worktree)
  assert.equal(existsSync(fixtureValue.worktree), false)
  assert.equal(fixtureValue.registrations.has(fixtureValue.worktree), false)
  assert.equal(fixtureValue.calls.remove, 1)
}

async function rejectedReason(promise, reason) {
  await assert.rejects(promise, (error) => error instanceof PrReviewError && error.reason === reason)
}

test('A1', async () => {
  const malformed = fixture()
  const malformedErrors = []
  assert.equal(await main(['--pr', 'bad'], { ...malformed.deps, stderr: (line) => malformedErrors.push(String(line)) }), 2)
  assert.match(malformedErrors.join(''), /malformed-pr/)
  assert.equal(malformed.calls.gh.length, 0)
  assert.equal(malformed.calls.git.length, 0)
  assert.equal(malformed.calls.remove, 0)
  await rejectedReason(runPrReview({ pr: 'bad', deps: malformed.deps }), 'malformed-pr')

  const unknown = fixture()
  unknown.deps.gh = () => ({ status: 1, stderr: 'not found' })
  const unknownErrors = []
  assert.equal(await main(['--pr', '17'], { ...unknown.deps, stderr: (line) => unknownErrors.push(String(line)) }), 2)
  assert.match(unknownErrors.join(''), /unknown-pr/)
  await rejectedReason(runPrReview({ pr: '17', deps: unknown.deps }), 'unknown-pr')
  assert.equal(unknown.calls.git.length, 0)
  assert.equal(unknown.calls.remove, 0)
})

test('B1-success', async () => {
  const current = fixture()
  const report = await runPrReview({ pr: 17, deps: current.deps })
  assert.equal(report.outcome, 'findings')
  assert.deepEqual(report.counts.findings, { count: 1, reason: 'review-envelope' })
  assert.deepEqual(report.counts.changed_files, { count: 2, reason: 'pr-diff' })
  assertCleaned(current)
})

test('B1-refusal', async () => {
  const current = fixture({ runMode: 'refusal' })
  await rejectedReason(runPrReview({ pr: 18, deps: current.deps }), 'terminal-unreadable')
  assertCleaned(current)
})

test('B1-crash', async () => {
  const current = fixture({ runMode: 'crash' })
  await rejectedReason(runPrReview({ pr: 19, deps: current.deps }), 'crew-failed')
  assertCleaned(current)
})

test('B1-teardown', async () => {
  const current = fixture({ teardownMode: 'reject' })
  await rejectedReason(runPrReview({ pr: 20, deps: current.deps }), 'teardown-failed')
  assert.equal(current.calls.teardownRead, true)
  assertCleaned(current)

  const precedence = fixture({ teardownMode: 'reject', removeMode: 'fail' })
  await rejectedReason(runPrReview({ pr: 21, deps: precedence.deps }), 'worktree-remove-failed')
  assert.equal(precedence.calls.remove, 1)
})

// Sol must-fix 1 (second review of b775). Mutation killed: restoring trim() normalizes padded
// merge-base output into a valid SHA, and a worktree is then created from it.
test('SHA1-base-untrimmed', async () => {
  const current = fixture()
  const git = current.deps.git
  current.deps.git = (args, options) => args[0] === 'merge-base' ? { status: 0, stdout: ` ${BASE40} \n` } : git(args, options)
  await assert.rejects(runPrReview({ pr: 22, deps: current.deps }), (error) => {
    assert.match(`${error?.reason || ''} ${error?.message || ''}`, /invalid-review-sha|malformed review base/)
    return true
  })
  assert.equal(current.calls.git.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'), false)
})

// Sol pass 2 should-fix: pin the exact merge-base boundary, not just trim(). Mutations killed: stripping
// every trailing newline, right-trimming, and dropping the last byte unconditionally.
test('SHA1-base-boundaries', async () => {
  const outcome = async (stdout) => {
    const current = fixture()
    const git = current.deps.git
    current.deps.git = (args, options) => args[0] === 'merge-base' ? { status: 0, stdout } : git(args, options)
    try {
      await runPrReview({ pr: 22, deps: current.deps })
      return 'accepted'
    } catch (error) {
      return /invalid-review-sha|malformed review base/.test(`${error?.reason || ''} ${error?.message || ''}`) ? 'refused' : `other: ${error?.message}`
    }
  }
  assert.equal(await outcome(`${BASE40}\n`), 'accepted')
  assert.equal(await outcome(BASE40), 'accepted')
  assert.equal(await outcome(`${BASE40}\r\n`), 'refused')
  assert.equal(await outcome(`${BASE40}\n\n`), 'refused')
  assert.equal(await outcome(`${BASE40} \n`), 'refused')
})

test('B1-partial', () => {
  const root = scratchDir('pr-review-real-partial-')
  const checkout = join(root, 'repo')
  const residue = join(root, 'partial-worktree')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  // Sol must-fix 2: the residue must be a REAL git registration, or the prune proof is vacuous.
  // Case 1: add succeeded (directory and registration exist), then the review failed.
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', residue, 'HEAD'], { stdio: 'pipe' })
  const registered = (path) => execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' }).includes(`worktree ${canonicalWorktreePath(path) ?? path}\0`)
  assert.equal(registered(residue), true)
  const result = removeWorktreeDefault(checkout, residue)
  assert.equal(result.removed, true)
  assert.equal(existsSync(residue), false)
  assert.equal(registered(residue), false)
  // Case 2: registered, but the directory is already gone. Only prune clears the registration.
  const orphan = join(root, 'orphan-worktree')
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', orphan, 'HEAD'], { stdio: 'pipe' })
  rmSync(orphan, { recursive: true, force: true })
  assert.equal(registered(orphan), true)
  const orphanResult = removeWorktreeDefault(checkout, orphan)
  assert.equal(orphanResult.removed, true)
  assert.equal(existsSync(orphan), false)
  assert.equal(registered(orphan), false)
})

// Found while proving B1-partial: git lists real paths (/private/var on macOS) while the target was
// compared lexically (/var), so a registration that survived removal read as absent.
// Mutation killed: comparing only the lexical path reports removed:true while git still lists it.
// git worktree remove --force already clears a registration whose directory is gone, so prune is the
// only cleanup when remove itself FAILS. Mutation killed: dropping `git worktree prune` leaves the
// registration listed and removal reports worktree-remove-failed.
test('B1-prune-after-failed-remove', () => {
  const root = scratchDir('pr-review-prune-')
  const checkout = join(root, 'repo')
  const orphan = join(root, 'orphan-worktree')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', orphan, 'HEAD'], { stdio: 'pipe' })
  rmSync(orphan, { recursive: true, force: true })
  const registered = () => execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' }).includes(`worktree ${canonicalWorktreePath(orphan) ?? orphan}\0`)
  assert.equal(registered(), true)
  // remove exits non-zero (a completed, observed failure); every other git call is real.
  const spawn = (command, args, options) => {
    if (args.includes('remove')) return { status: 128, stdout: '', stderr: 'fatal: simulated remove failure' }
    const stdout = execFileSync(command, args, { encoding: 'utf8', ...(options || {}) })
    return { status: 0, stdout, stderr: '' }
  }
  const result = removeWorktreeDefault(checkout, orphan, { spawn })
  assert.equal(result.removed, true, result.why)
  assert.equal(registered(), false)
})

// Sol pass 2 should-fix: remove fails while the directory still EXISTS, so recursive removal and
// prune are both required. Mutation killed: dropping the recursive rmSync leaves the directory.
test('B1-failed-remove-present-directory', () => {
  const root = scratchDir('pr-review-present-')
  const checkout = join(root, 'repo')
  const present = join(root, 'present-worktree')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', present, 'HEAD'], { stdio: 'pipe' })
  const registered = () => execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' }).includes(`worktree ${canonicalWorktreePath(present) ?? present}\0`)
  assert.equal(existsSync(present), true)
  assert.equal(registered(), true)
  const canonical = canonicalWorktreePath(present)
  const spawn = (command, args, options) => {
    if (args.includes('remove')) return { status: 128, stdout: '', stderr: 'fatal: simulated remove failure' }
    const stdout = execFileSync(command, args, { encoding: 'utf8', ...(options || {}) })
    return { status: 0, stdout, stderr: '' }
  }
  const result = removeWorktreeDefault(checkout, present, { spawn })
  assert.equal(result.removed, true, result.why)
  assert.equal(existsSync(present), false)
  assert.equal(execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' }).includes(`worktree ${canonical}\0`), false)
})

// Sol pass 2 must-fix: a symlinked parent that is itself gone leaves the path unresolvable while git
// still lists the REAL path. Removal must fail closed. Mutation killed: falling back to the lexical path
// reports removed:true while the real directory and registration both survive.
test('B1-unresolvable-parent-fails-closed', () => {
  const root = scratchDir('pr-review-unresolvable-')
  const checkout = join(root, 'repo')
  const physical = join(root, 'physical')
  const link = join(root, 'link')
  mkdirSync(checkout, { recursive: true })
  mkdirSync(physical, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  symlinkSync(physical, link)
  const viaLink = join(link, 'wt')
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', viaLink, 'HEAD'], { stdio: 'pipe' })
  rmSync(link)
  assert.equal(existsSync(join(physical, 'wt')), true)
  assert.equal(canonicalWorktreePath(viaLink), null)
  const result = removeWorktreeDefault(checkout, viaLink)
  assert.equal(result.removed, false)
  assert.match(result.why, /could not be canonicalized/)
})

test('B1-registration-canonical', () => {
  const root = scratchDir('pr-review-canonical-')
  const checkout = join(root, 'repo')
  // An explicit symlinked parent, so the proof holds on hosts whose temp directory has no symlink.
  const physical = join(root, 'physical')
  const link = join(root, 'link')
  mkdirSync(physical, { recursive: true })
  symlinkSync(physical, link)
  const stuck = join(link, 'stuck-worktree')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', stuck, 'HEAD'], { stdio: 'pipe' })
  // A git that neither removes nor prunes: the registration survives, and removal must say so.
  const spawn = (command, args, options) => {
    if (args.includes('remove') || args.includes('prune')) return { status: 0, stdout: '', stderr: '' }
    const stdout = execFileSync(command, args, { encoding: 'utf8', ...(options || {}) })
    return { status: 0, stdout, stderr: '' }
  }
  rmSync(stuck, { recursive: true, force: true })
  const result = removeWorktreeDefault(checkout, stuck, { spawn })
  assert.equal(result.removed, false)
  assert.match(result.why, /worktree registration still exists/)
})

test('C1', async () => {
  const current = fixture()
  await runPrReview({ pr: 22, deps: current.deps })
  for (const call of current.calls.crew) {
    const [verb, ...rest] = call.args
    const parsed = parseArgs(rest)
    assert.doesNotThrow(() => assertUsage(verb, parsed))
    assert.equal(typeof parsed.checkout, 'string')
    assert.equal(parsed.checkout, call.options.cwd)
  }
  assert.deepEqual(current.calls.crew.map(({ args }) => args[0]), ['boot', 'run', 'teardown'])
})

test('D1-values', async () => {
  const current = fixture({ values: { base: BASE40, head: HEAD40, outcome: 'no-findings', findings: [] } })
  const report = await runPrReview({ pr: 23, deps: current.deps })
  assert.equal(report.outcome, 'no-findings')
  assert.deepEqual(report.findings, [])
  assert.equal(current.calls.teardownRead, true)
  assert.ok(current.calls.reads.includes(current.pointer))
})

test('D1-no-coverage', async () => {
  const current = fixture()
  const values = new Proxy({ base: BASE40, head: HEAD40, outcome: 'findings', findings: [{ id: 'one', location: 'x' }] }, {
    get(target, property, receiver) {
      if (property === 'coverage') throw new Error('coverage must not be read')
      return Reflect.get(target, property, receiver)
    },
  })
  const envelope = new Proxy({ values }, {
    get(target, property, receiver) {
      if (property === 'coverage') throw new Error('coverage must not be read')
      return Reflect.get(target, property, receiver)
    },
  })
  current.setTask({ status: 'done', details: { envelope } })
  const report = await runPrReview({ pr: 24, deps: current.deps })
  assert.equal(report.counts.reviewed.count, null)
  assert.equal(report.counts.unreviewable.count, null)
  assert.equal(report.counts.reviewed.reason, 'review-envelope-has-no-coverage')
  assert.equal(report.counts.unreviewable.reason, 'review-envelope-has-no-coverage')
})

test('E1-nul', () => {
  const files = parseChangedFiles('dir/embedded\nnewline.mjs\0plain.mjs\0')
  assert.deepEqual(files, ['dir/embedded\nnewline.mjs', 'plain.mjs'])
})

test('E1-whitespace', () => {
  const files = parseChangedFiles('  \0\t\n\0normal.mjs\0')
  assert.deepEqual(files, ['  ', '\t\n', 'normal.mjs'])
})

test('F1-measured', () => {
  const counts = reportCounts({ findings: [{ id: 'a' }, { id: 'b' }] }, ['a.mjs', 'b.mjs', 'c.mjs'])
  assert.deepEqual(counts.findings, { count: 2, reason: 'review-envelope' })
  assert.deepEqual(counts.changed_files, { count: 3, reason: 'pr-diff' })
})

test('F1-unmeasured', () => {
  const counts = reportCounts({ findings: [{ location: 'a.mjs' }, { location: 'b.mjs' }] }, ['a.mjs'])
  assert.deepEqual(counts.reviewed, { count: null, reason: 'review-envelope-has-no-coverage' })
  assert.deepEqual(counts.unreviewable, { count: null, reason: 'review-envelope-has-no-coverage' })
})

test('G1-context', () => {
  const identity = reviewIdentityFromArgs({ 'review-base-sha': BASE40, 'review-head-sha': HEAD64 })
  assert.deepEqual(identity, { base_sha: BASE40, head_sha: HEAD64 })
  assert.equal(Object.isFrozen(identity), true)
  const source = readFileSync(new URL('../crew/crew.mjs', import.meta.url), 'utf8')
  assert.match(source, /\.\.\.\(reviewIdentity \? \{ review_identity: reviewIdentity \} : \{\}\)/)
})

test('G1-sha', () => {
  for (const args of [
    { 'review-base-sha': BASE40 },
    { 'review-head-sha': HEAD40 },
    { 'review-base-sha': 'A'.repeat(40), 'review-head-sha': HEAD40 },
    { 'review-base-sha': 'a'.repeat(41), 'review-head-sha': HEAD40 },
    { 'review-base-sha': BASE40, 'review-head-sha': 'b'.repeat(63) },
  ]) assert.throws(() => reviewIdentityFromArgs(args), (error) => error.reason === 'invalid-review-identity')
})
