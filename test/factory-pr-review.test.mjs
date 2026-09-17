import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symlinkSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { scratchDir } from './helpers.mjs'
import { assertUsage, parseArgs, reviewIdentityFromArgs } from '../crew/crew.mjs'
import { canonicalWorktreePath,
  PR_REVIEW_REFUSALS,
  PrReviewError,
  parseChangedFiles,
  parseMainArgs,
  renderReviewBody,
  reportCounts,
  removeWorktreeDefault,
  runPrReview,
  main,
} from '../scripts/factory/pr-review.mjs'

const BASE40 = 'a'.repeat(40)
const HEAD40 = 'b'.repeat(40)
const BASE64 = 'c'.repeat(64)
const HEAD64 = 'd'.repeat(64)
const DEFAULT_VALUES = {
  base: BASE40,
  head: HEAD40,
  outcome: 'findings',
  findings: [{
    id: 'F1',
    severity: 'must-fix',
    location: 'src/a.mjs',
    summary: 'fixture finding',
    evidence: 'fixture evidence',
    disposition: 'ask-user',
  }],
  reviewed_files: ['src/a.mjs'],
  unreviewable_files: [{ path: 'src/b.mjs', reason: 'binary' }],
}

function terminal(pointer, status = 'done') {
  return JSON.stringify({ status, commit: null, task_return: pointer, archived: null })
}

function fixture({
  runMode = 'success',
  teardownMode = 'success',
  removeMode = 'success',
  values = DEFAULT_VALUES,
  taskStatus = 'done',
  taskValue = null,
  ghViews = null,
  postResult = { status: 0, stdout: '' },
} = {}) {
  const root = scratchDir('pr-review-fixture-')
  const checkout = join(root, 'checkout')
  mkdirSync(checkout, { recursive: true })
  const pointer = join(root, 'task.json')
  const calls = { gh: [], review: [], git: [], crew: [], reads: [], writes: [], remove: 0, teardownRead: false }
  const registrations = new Set()
  let worktree = null
  let task = taskValue || { status: taskStatus, details: { envelope: { values } } }
  const queuedGhViews = ghViews ? [...ghViews] : [
    { headRefOid: HEAD40, title: 'fixture title', body: 'fixture body' },
    { headRefOid: HEAD40, reviews: [] },
  ]
  const ghResult = (value) => {
    if (value && typeof value === 'object'
      && ['status', 'stdout', 'stderr', 'output', 'error', 'signal', 'ok'].some((key) => key in value)) return value
    return { status: 0, stdout: JSON.stringify(value) }
  }
  const deps = {
    checkout,
    tempRoot: root,
    gh: (args, options) => {
      calls.gh.push({ args: [...args], options })
      if (args[0] === 'pr' && args[1] === 'view') {
        const response = queuedGhViews.shift() || { headRefOid: HEAD40, reviews: [] }
        return typeof response === 'function' ? response(args, options) : ghResult(response)
      }
      if (args[0] === 'pr' && args[1] === 'review') {
        calls.review.push({ args: [...args], options })
        return typeof postResult === 'function' ? postResult(args, options) : ghResult(postResult)
      }
      return { status: 0, stdout: '' }
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

function bodyPayload(body) {
  const separator = '\n\n<!-- review-only:'
  return JSON.parse(body.slice(0, body.indexOf(separator)))
}

function bodyMarker(body) {
  const match = body.match(/<!-- review-only:[0-9a-f]{64} -->/)
  assert.ok(match, 'rendered body must carry an idempotency marker')
  return match[0]
}

async function rejectedReason(promise, reason) {
  await assert.rejects(promise, (error) => error instanceof PrReviewError && error.reason === reason)
}

test('PR_REVIEW_REFUSALS is the closed 14-value vocabulary', () => {
  const expected = [
    'malformed-pr',
    'unknown-pr',
    'invalid-review-sha',
    'worktree-add-failed',
    'worktree-remove-failed',
    'git-diff-failed',
    'review-input-unreadable',
    'crew-failed',
    'terminal-unreadable',
    'task-return-unreadable',
    'task-return-invalid',
    'teardown-failed',
    'head-moved',
    'post-failed',
  ]
  const actual = Object.values(PR_REVIEW_REFUSALS)
  assert.equal(Object.isFrozen(PR_REVIEW_REFUSALS), true)
  assert.equal(actual.length, expected.length)
  assert.equal(new Set(actual).size, actual.length)
  assert.deepEqual([...actual].sort(), [...expected].sort())
})

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
  assert.deepEqual(report.counts.reviewed_files, { count: 1, reason: 'review-envelope' })
  assert.deepEqual(report.counts.unreviewable_files, { count: 1, reason: 'review-envelope' })
  assert.equal(report.posted, true)
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

// Sol pass 3 must-fix: an alias symlink whose worktree directory is gone canonicalizes to the alias,
// while git still lists the real path. Mutation killed: dropping the link-target candidate reports
// removed:true while the registration survives.
test('B1-dangling-alias-registration', () => {
  const root = scratchDir('pr-review-dangling-')
  const checkout = join(root, 'repo')
  const real = join(root, 'real-worktree')
  const alias = join(root, 'alias-worktree')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: checkout })
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', real, 'HEAD'], { stdio: 'pipe' })
  symlinkSync(real, alias)
  rmSync(real, { recursive: true, force: true })
  // git that neither removes nor prunes: the real registration survives behind the dangling alias.
  const spawn = (command, args, options) => {
    if (args.includes('remove') || args.includes('prune')) return { status: 0, stdout: '', stderr: '' }
    const stdout = execFileSync(command, args, { encoding: 'utf8', ...(options || {}) })
    return { status: 0, stdout, stderr: '' }
  }
  const result = removeWorktreeDefault(checkout, alias, { spawn })
  assert.equal(result.removed, false, JSON.stringify(result))
  assert.match(result.why, /registration still exists|could not be canonicalized/)
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
  const current = fixture({ values: {
    base: BASE40, head: HEAD40, outcome: 'no-findings', findings: [],
    reviewed_files: ['src/a.mjs'], unreviewable_files: [{ path: 'src/b.mjs', reason: 'generated' }],
  } })
  const report = await runPrReview({ pr: 23, deps: current.deps })
  assert.equal(report.outcome, 'no-findings')
  assert.deepEqual(report.findings, [])
  assert.equal(current.calls.teardownRead, true)
  assert.ok(current.calls.reads.includes(current.pointer))
})

test('D1-no-coverage', async () => {
  const current = fixture()
  const values = new Proxy({
    base: BASE40,
    head: HEAD40,
    outcome: 'findings',
    findings: [{
      id: 'one', severity: 'should-fix', location: 'x', summary: 'summary',
      evidence: 'evidence', disposition: 'no-op',
    }],
    reviewed_files: ['x'],
    unreviewable_files: [{ path: 'y', reason: 'out-of-context' }],
  }, {
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
  assert.equal(report.counts.reviewed_files.count, 1)
  assert.equal(report.counts.unreviewable_files.count, 1)
  assert.equal(report.counts.reviewed_files.reason, 'review-envelope')
  assert.equal(report.counts.unreviewable_files.reason, 'review-envelope')
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
  const counts = reportCounts({
    findings: [{ id: 'a' }, { id: 'b' }],
    reviewed_files: ['a.mjs'],
    unreviewable_files: [{ path: 'b.mjs', reason: 'binary' }],
  }, ['a.mjs', 'b.mjs', 'c.mjs'])
  assert.deepEqual(counts.findings, { count: 2, reason: 'review-envelope' })
  assert.deepEqual(counts.changed_files, { count: 3, reason: 'pr-diff' })
  assert.deepEqual(counts.reviewed_files, { count: 1, reason: 'review-envelope' })
  assert.deepEqual(counts.unreviewable_files, { count: 1, reason: 'review-envelope' })
})

test('F1-measured-empty', () => {
  const counts = reportCounts({ findings: [], reviewed_files: [], unreviewable_files: [] }, [])
  assert.deepEqual(counts.reviewed_files, { count: 0, reason: 'review-envelope' })
  assert.deepEqual(counts.unreviewable_files, { count: 0, reason: 'review-envelope' })
})

test('POST-A1', async () => {
  const moved = 'e'.repeat(40)
  const current = fixture({ ghViews: [
    { headRefOid: HEAD40, title: 'fixture title', body: 'fixture body' },
    { headRefOid: moved, reviews: [] },
  ] })
  await assert.rejects(runPrReview({ pr: 41, deps: current.deps }), (error) => {
    assert.equal(error.reason, 'head-moved')
    assert.match(error.message, new RegExp(`${HEAD40}.*${moved}`))
    return true
  })
  assert.equal(current.calls.review.length, 0)
  assert.deepEqual(current.calls.gh.map(({ args }) => args), [
    ['pr', 'view', '41', '--json', 'headRefOid,title,body'],
    ['pr', 'view', '41', '--json', 'headRefOid,reviews'],
  ])
  assertCleaned(current)
})

test('POST-B1', async () => {
  const first = fixture()
  const posted = await runPrReview({ pr: 42, deps: first.deps })
  const marker = bodyMarker(posted.review_body)
  assert.equal(renderReviewBody(posted, 'COMMENT').body, posted.review_body)

  const duplicate = fixture({ ghViews: [
    { headRefOid: HEAD40, title: 'fixture title', body: 'fixture body' },
    { headRefOid: HEAD40, reviews: [{ body: `existing ${marker} review` }] },
  ] })
  const duplicateReport = await runPrReview({ pr: 42, deps: duplicate.deps })
  assert.equal(duplicateReport.posted, false)
  assert.equal(duplicateReport.reason, 'already-posted')
  assert.equal(bodyMarker(duplicateReport.review_body), marker)
  assert.equal(duplicate.calls.review.length, 0)
  assertCleaned(duplicate)

  const distinctValues = {
    ...DEFAULT_VALUES,
    findings: [{ ...DEFAULT_VALUES.findings[0], id: 'F2' }],
  }
  const distinct = fixture({ values: distinctValues })
  const distinctReport = await runPrReview({ pr: 42, noPost: true, deps: distinct.deps })
  assert.notEqual(bodyMarker(distinctReport.review_body), marker)
  assertCleaned(distinct)
})

test('POST-C1', async () => {
  const output = []
  const current = fixture()
  const code = await main(['--pr', '43', '--no-post'], {
    ...current.deps,
    stdout: (value) => output.push(String(value)),
  })
  assert.equal(code, 0)
  const body = output.join('').trimEnd()
  assert.equal(bodyPayload(body).schema, 'review_only')
  assert.match(body, /<!-- review-only:[0-9a-f]{64} -->/)
  assert.equal(current.calls.gh.filter(({ args }) => args.join(' ') === 'pr view 43 --json headRefOid,reviews').length, 0)
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('POST-D1', async () => {
  const current = fixture({ values: {
    ...DEFAULT_VALUES,
    unreviewable_files: [
      { path: 'src/b.mjs', reason: 'binary' },
      { path: 'src/generated.mjs', reason: 'generated' },
      { path: 'src/large.mjs', reason: 'too-large' },
      { path: 'src/other.mjs', reason: 'out-of-context' },
    ],
  } })
  const report = await runPrReview({ pr: 44, noPost: true, deps: current.deps })
  const payload = bodyPayload(report.review_body)
  for (const key of ['findings', 'changed_files', 'reviewed_files', 'unreviewable_files']) {
    assert.equal(Number.isInteger(payload.counts[key].count), true, key)
  }
  assert.deepEqual(payload.counts, {
    findings: { count: 1, reason: 'review-envelope' },
    changed_files: { count: 2, reason: 'pr-diff' },
    reviewed_files: { count: 1, reason: 'review-envelope' },
    unreviewable_files: { count: 4, reason: 'review-envelope' },
  })
  assert.deepEqual(payload.unreviewable_files, [
    { path: 'src/b.mjs', reason: 'binary' },
    { path: 'src/generated.mjs', reason: 'generated' },
    { path: 'src/large.mjs', reason: 'too-large' },
    { path: 'src/other.mjs', reason: 'out-of-context' },
  ])
  assert.equal(report.review_body.includes(['fence', 'excluded'].join(' ')), false)
  assertCleaned(current)
})

test('POST-E1', async () => {
  const defaultRun = fixture()
  const defaultReport = await runPrReview({ pr: 45, deps: defaultRun.deps })
  assert.equal(defaultReport.verdict, 'COMMENT')
  assert.deepEqual(defaultRun.calls.review.map(({ args }) => args), [[
    'pr', 'review', '45', '--comment', '--body', defaultReport.review_body,
  ]])
  assert.doesNotMatch(defaultReport.review_body, /APPROVE/)
  assertCleaned(defaultRun)

  const requested = fixture()
  const requestedReport = await runPrReview({ pr: 46, requestChanges: true, deps: requested.deps })
  assert.equal(requestedReport.verdict, 'REQUEST_CHANGES')
  assert.deepEqual(requested.calls.review.map(({ args }) => args), [[
    'pr', 'review', '46', '--request-changes', '--body', requestedReport.review_body,
  ]])
  assert.doesNotMatch(requestedReport.review_body, /APPROVE/)
  assertCleaned(requested)

  const output = []
  const renderOnly = fixture()
  assert.equal(await main(['--pr', '47', '--no-post'], {
    ...renderOnly.deps,
    stdout: (value) => output.push(String(value)),
  }), 0)
  assert.equal(bodyPayload(output.join('').trimEnd()).verdict, 'COMMENT')
  assert.equal(renderOnly.calls.review.length, 0)
  assert.equal(renderOnly.calls.gh.filter(({ args }) => args.at(-1) === 'headRefOid,reviews').length, 0)
  assert.doesNotMatch(output.join(''), /APPROVE/)
  assertCleaned(renderOnly)
})

test('POST-cli-refusals', () => {
  assert.deepEqual(parseMainArgs(['--pr', '48']), { pr: '48', requestChanges: false, noPost: false, panel: false, panelDistinctAgents: false })
  assert.deepEqual(parseMainArgs(['--request-changes', '--no-post', '--pr', '49']), { pr: '49', requestChanges: true, noPost: true, panel: false, panelDistinctAgents: false })
  assert.deepEqual(parseMainArgs(['--pr', '50', '--panel']), { pr: '50', requestChanges: false, noPost: false, panel: true, panelDistinctAgents: false })
  assert.deepEqual(parseMainArgs(['--pr', '50', '--panel', '--panel-distinct-agents']), { pr: '50', requestChanges: false, noPost: false, panel: true, panelDistinctAgents: true })
  for (const args of [
    ['--pr', '48', '--pr', '49'],
    ['--pr', '48', '--request-changes', '--request-changes'],
    ['--pr', '48', '--no-post', '--no-post'],
    ['--pr', '48', '--panel', '--panel'],
    ['--pr', '48', '--panel-distinct-agents', '--panel-distinct-agents'],
    ['--pr', '48', '--unknown'],
    ['--pr', '48', '--approve'],
  ]) assert.throws(() => parseMainArgs(args), (error) => error.reason === 'malformed-pr')
})

test('POST-post-failure-no-retry', async () => {
  for (const postResult of [
    () => ({ status: 1, stderr: 'permission denied' }),
    () => ({ signal: 'SIGTERM' }),
    () => ({}),
    () => '',
    () => { throw new Error('review process failed') },
  ]) {
    let attempts = 0
    const current = fixture({ postResult: (...args) => {
      attempts += 1
      return postResult(...args)
    } })
    await rejectedReason(runPrReview({ pr: 50, deps: current.deps }), 'post-failed')
    assert.equal(attempts, 1)
    assert.equal(current.calls.review.length, 1)
    assertCleaned(current)
  }
})

test('POST-recheck-refusals', async () => {
  for (const response of [
    { headRefOid: HEAD40 },
    { headRefOid: HEAD40, reviews: {} },
    { headRefOid: 'not-a-sha', reviews: [] },
    { headRefOid: HEAD40, reviews: [{ body: 42 }] },
  ]) {
    const current = fixture({ ghViews: [
      { headRefOid: HEAD40, title: 'fixture title', body: 'fixture body' },
      response,
    ] })
    await rejectedReason(runPrReview({ pr: 51, deps: current.deps }), 'post-failed')
    assert.equal(current.calls.gh.length, 2)
    assert.equal(current.calls.review.length, 0)
    assertCleaned(current)
  }
})

test('POST-envelope-validation', async () => {
  const current = fixture({ values: {
    ...DEFAULT_VALUES,
    findings: [{ id: 'bad', location: 'src/a.mjs' }],
  } })
  await rejectedReason(runPrReview({ pr: 52, deps: current.deps }), 'task-return-invalid')
  assert.equal(current.calls.gh.length, 1)
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('A1 valid vacuity claim is accepted', async () => {
  const values = {
    ...DEFAULT_VALUES,
    findings: [{ ...DEFAULT_VALUES.findings[0], vacuity_claim: 'mutation-survived' }],
  }
  const current = fixture({ values })
  const report = await runPrReview({ pr: 53, noPost: true, deps: current.deps })
  assert.deepEqual(report.findings, values.findings)
  assert.equal(report.posted, false)
  assert.equal(report.reason, 'no-post')
  assertCleaned(current)
})

test('B1 undeclared record keys are refused', async () => {
  const cases = [
    {
      ...DEFAULT_VALUES,
      findings: [{ ...DEFAULT_VALUES.findings[0], undeclared: 'not-permitted' }],
    },
    {
      ...DEFAULT_VALUES,
      unreviewable_files: [{ ...DEFAULT_VALUES.unreviewable_files[0], source: 'reviewer' }],
    },
  ]
  for (const values of cases) {
    const current = fixture({ values })
    await rejectedReason(runPrReview({ pr: 54, deps: current.deps }), 'task-return-invalid')
    assert.equal(current.calls.review.length, 0)
    assertCleaned(current)
  }
})

test('C1 unknown vacuity claim is refused', async () => {
  const values = {
    ...DEFAULT_VALUES,
    findings: [{ ...DEFAULT_VALUES.findings[0], vacuity_claim: 'invented-claim' }],
  }
  const current = fixture({ values })
  await rejectedReason(runPrReview({ pr: 55, deps: current.deps }), 'task-return-invalid')
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('D1 non-must-fix vacuity claim is refused', async () => {
  const values = {
    ...DEFAULT_VALUES,
    findings: [{ ...DEFAULT_VALUES.findings[0], severity: 'should-fix', vacuity_claim: 'mutation-survived' }],
  }
  const current = fixture({ values })
  await rejectedReason(runPrReview({ pr: 56, deps: current.deps }), 'task-return-invalid')
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('D2 no-op vacuity claim is refused', async () => {
  const values = {
    ...DEFAULT_VALUES,
    findings: [{ ...DEFAULT_VALUES.findings[0], disposition: 'no-op', vacuity_claim: 'mutation-survived' }],
  }
  const current = fixture({ values })
  await rejectedReason(runPrReview({ pr: 57, deps: current.deps }), 'task-return-invalid')
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('RV1-2 renders vacuity claims into distinct markers', () => {
  const report = {
    head: HEAD40,
    findings: DEFAULT_VALUES.findings,
    counts: reportCounts(DEFAULT_VALUES, ['src/a.mjs', 'src/b.mjs']),
    unreviewable_files: DEFAULT_VALUES.unreviewable_files,
  }
  const ordinary = renderReviewBody(report, 'COMMENT')
  const claimed = renderReviewBody({
    ...report,
    findings: [{ ...DEFAULT_VALUES.findings[0], vacuity_claim: 'mutation-survived' }],
  }, 'COMMENT')
  assert.equal(bodyPayload(claimed.body).findings[0].vacuity_claim, 'mutation-survived')
  assert.notEqual(claimed.marker, ordinary.marker)
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

function panelFinding(id, panelDisposition, reason, raisedBy) {
  return { ...DEFAULT_VALUES.findings[0], id, raised_by: raisedBy, panel_disposition: panelDisposition, reason }
}

function panelEnvelope(findings) {
  return {
    ...DEFAULT_VALUES,
    panel: {
      changed_files: ['src/a.mjs', 'src/b.mjs'],
      reviewers: [
        { role: 'reviewer', reviewed_files: ['src/a.mjs'], unreviewable_files: [] },
        { role: 'tech-lead', reviewed_files: ['src/a.mjs'], unreviewable_files: [{ path: 'src/b.mjs', reason: 'binary' }] },
      ],
      adjudicator: { role: 'lead', reviewed_files: ['src/a.mjs'], unreviewable_files: [{ path: 'src/b.mjs', reason: 'binary' }] },
      findings,
    },
  }
}

function crewCall(fixtureValue, verb) {
  return fixtureValue.calls.crew.find(({ args }) => args[0] === verb)
}

test('panel boot runs three seats under review_panel with a panel brief', async () => {
  const current = fixture({ values: panelEnvelope([panelFinding('F1', 'consensus', 'reviewer and tech-lead agreed on this finding', ['reviewer', 'tech-lead'])]) })
  const report = await runPrReview({ pr: 60, panel: true, noPost: true, deps: current.deps })
  const boot = crewCall(current, 'boot')
  const run = crewCall(current, 'run')
  assert.deepEqual(boot.args.slice(0, 5), ['boot', '--task', 'pr-review-60', '--checkout', current.worktree])
  assert.deepEqual(boot.args.slice(5), ['--roles', 'reviewer,tech-lead,lead', '--profile', 'code_review'])
  assert.deepEqual(run.args.slice(5, 9), ['--brief-file', run.args[6], '--execution', 'review_panel'])
  const brief = current.calls.writes.find((write) => write.data.startsWith('# Pull-request review'))
  assert.ok(brief.data.includes('execution: review_panel'))
  assert.ok(report.panel)
  assert.equal(report.posted, false)
  assertCleaned(current)
})

test('panel-distinct-agents forwards onto boot and is accepted without panel', async () => {
  const forwarded = fixture()
  await runPrReview({ pr: 61, noPost: true, panelDistinctAgents: true, deps: forwarded.deps })
  assert.ok(crewCall(forwarded, 'boot').args.includes('--panel-distinct-agents'))
  assertCleaned(forwarded)
  const single = fixture()
  await runPrReview({ pr: 62, noPost: true, deps: single.deps })
  assert.equal(crewCall(single, 'boot').args.includes('--panel-distinct-agents'), false)
  assertCleaned(single)
})

test('single-seat boot and run argv stay byte-identical with no panel key', async () => {
  const current = fixture()
  const report = await runPrReview({ pr: 63, noPost: true, deps: current.deps })
  const boot = crewCall(current, 'boot')
  const run = crewCall(current, 'run')
  assert.deepEqual(boot.args.slice(5), ['--roles', 'reviewer', '--profile', 'code_review'])
  assert.deepEqual(run.args.slice(7), ['--execution', 'review_only', '--review-base-sha', BASE40, '--review-head-sha', HEAD40, '--keep'])
  const brief = current.calls.writes.find((write) => write.data.startsWith('# Pull-request review'))
  assert.ok(brief.data.includes('execution: review_only'))
  assert.equal(report.panel, null)
  assert.ok(!('panel' in bodyPayload(report.review_body)))
  assertCleaned(current)
})

test('panel post renders every disposition with provenance and coverage', async () => {
  const current = fixture({ values: panelEnvelope([
    panelFinding('F1', 'consensus', 'reviewer and tech-lead agreed on this finding', ['reviewer', 'tech-lead']),
    panelFinding('panel-tech-lead-0', 'upheld', 'adjudicator kept this divergent finding', ['tech-lead']),
    panelFinding('panel-reviewer-1', 'dismissed', 'adjudicator dismissed: unreachable from this diff', ['reviewer']),
  ]) })
  const report = await runPrReview({ pr: 64, panel: true, noPost: true, deps: current.deps })
  const payload = bodyPayload(report.review_body)
  assert.equal(payload.panel.findings.length, 3)
  const byId = new Map(payload.panel.findings.map((row) => [row.id, row]))
  assert.deepEqual(byId.get('F1').raised_by, ['reviewer', 'tech-lead'])
  assert.equal(byId.get('F1').panel_disposition, 'consensus')
  assert.equal(byId.get('panel-tech-lead-0').panel_disposition, 'upheld')
  assert.equal(byId.get('panel-reviewer-1').panel_disposition, 'dismissed')
  assert.match(byId.get('panel-reviewer-1').reason, /unreachable/)
  assert.deepEqual(payload.panel.reviewers.map((row) => row.role).sort(), ['reviewer', 'tech-lead'])
  assert.equal(payload.panel.adjudicator.role, 'lead')
  bodyMarker(report.review_body)
  assertCleaned(current)
})

test('provenance-only panel changes move the idempotency digest', async () => {
  const values = (disposition, reason) => panelEnvelope([panelFinding('F1', disposition, reason, ['reviewer'])])
  const first = fixture({ values: values('upheld', 'adjudicator kept this divergent finding') })
  const second = fixture({ values: values('dismissed', 'adjudicator dropped this divergent finding') })
  const hexOf = (body) => body.match(/<!-- review-only:([0-9a-f]{64}) -->/)[1]
  const hexA = hexOf((await runPrReview({ pr: 65, panel: true, noPost: true, deps: first.deps })).review_body)
  const hexB = hexOf((await runPrReview({ pr: 65, panel: true, noPost: true, deps: second.deps })).review_body)
  assert.notEqual(hexA, hexB)
  assertCleaned(first)
  assertCleaned(second)
})

test('panel envelope without provenance is refused', async () => {
  const current = fixture({ values: { ...DEFAULT_VALUES, panel: { changed_files: [] } } })
  await rejectedReason(runPrReview({ pr: 66, panel: true, deps: current.deps }), 'task-return-invalid')
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})

test('panel escalation refuses crew-failed carrying the reason and posts nothing', async () => {
  const current = fixture({
    taskValue: { status: 'escalation', details: { panel: { failure: { reason: 'panel-partner-absent', seat: 'tech-lead' } } } },
  })
  const innerCrew = current.deps.crew
  current.deps.crew = async (args, options) => {
    const result = await innerCrew(args, options)
    if (args[0] === 'run') return { status: 0, stdout: `progress\n${terminal(current.pointer, 'escalation')}\n` }
    return result
  }
  await assert.rejects(
    runPrReview({ pr: 67, panel: true, deps: current.deps }),
    (error) => error instanceof PrReviewError && error.reason === 'crew-failed' && /panel-partner-absent/.test(error.detail),
  )
  assert.equal(current.calls.review.length, 0)
  assertCleaned(current)
})
