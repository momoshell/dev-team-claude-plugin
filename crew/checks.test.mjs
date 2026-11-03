import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, gitResult, scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, commitChanges, openPullRequest, rebaseBranch, runSuite } from './checks.mjs'
import * as checks from './checks.mjs'

const GATE_TIMEOUT_MS = 10_000
const SHORT_TIMEOUT_MS = 2_500
const BOUNDED_WALL_MS = 8_000
const OUTPUT_PROBE_TIMEOUT_MS = 30_000

const node = (cwd, source, extra = {}, deps = {}) => runSuite({ cwd, command: process.execPath, args: ['-e', source], timeoutMs: GATE_TIMEOUT_MS, ...extra }, deps)
const reasonOf = (result) => {
  assert.ok(result.reason === null || CHECK_REASONS.includes(result.reason), `reason ${result.reason} is outside the closed vocabulary`)
  return result.reason
}
const groupGone = (pgid) => {
  try { process.kill(-pgid, 0) } catch (error) { return error.code === 'ESRCH' }
  return false
}
const pidGone = (pid) => {
  try { process.kill(pid, 0) } catch (error) { return error.code === 'ESRCH' }
  return false
}
test('the reason vocabulary is a frozen list of unique tokens', () => {
  assert.ok(Object.isFrozen(CHECK_REASONS))
  assert.equal(new Set(CHECK_REASONS).size, CHECK_REASONS.length)
  assert.equal(CHECK_REASONS.length, 18)
  for (const token of ['nothing-to-commit', 'commit-failed', 'rebase-conflict', 'rebase-failed', 'dirty-worktree', 'push-unmeasured', 'pr-unmeasured', 'invalid-remote-data']) assert.ok(CHECK_REASONS.includes(token), token)
})

test('runSuite reports exit 0 as green with a null reason and a real process group', async () => {
  const result = await node(scratchDir('checks-suite-'), "console.log('out'); console.error('err')")
  assert.equal(result.status, 'green')
  assert.equal(reasonOf(result), null)
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'out\n')
  assert.equal(result.stderr, 'err\n')
  assert.equal(result.timedOut, false)
  assert.ok(result.pgid > 1)
  assert.ok(groupGone(result.pgid))
})

test('runSuite reports a completed nonzero exit as red exit-nonzero and keeps its output', async () => {
  const result = await node(scratchDir('checks-suite-'), "console.log('partial'); console.error('boom'); process.exitCode = 3")
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'exit-nonzero')
  assert.equal(result.code, 3)
  assert.equal(result.stdout, 'partial\n')
  assert.equal(result.stderr, 'boom\n')
})

test('runSuite decodes a multibyte character split across chunks without corruption', async () => {
  const result = await node(scratchDir('checks-suite-'), "const b = Buffer.from('€€'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1, 5)), 60); setTimeout(() => process.stdout.write(b.subarray(5)), 120)")
  assert.equal(result.stdout, '€€')
})

test('runSuite strips inherited colour and test-runner variables and sets NO_COLOR', async () => {
  const saved = { FORCE_COLOR: process.env.FORCE_COLOR, CLICOLOR_FORCE: process.env.CLICOLOR_FORCE, NODE_TEST_WORKER_ID: process.env.NODE_TEST_WORKER_ID }
  Object.assign(process.env, { FORCE_COLOR: '1', CLICOLOR_FORCE: '1', NODE_TEST_WORKER_ID: '7' })
  try {
    const result = await node(scratchDir('checks-suite-'), "const e = process.env; console.log(JSON.stringify([e.FORCE_COLOR, e.CLICOLOR_FORCE, e.NODE_TEST_CONTEXT, e.NODE_TEST_WORKER_ID, e.NO_COLOR]))")
    assert.equal(result.stdout.trim(), '[null,null,null,null,"1"]')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('runSuite refuses invalid input as unmeasured without spawning', async () => {
  const cwd = scratchDir('checks-suite-')
  const cases = [
    { cwd: '', command: process.execPath },
    { cwd, command: '' },
    { cwd, command: process.execPath, args: 'x' },
    { cwd, command: process.execPath, args: [1] },
    { cwd, command: process.execPath, timeoutMs: 0 },
    { cwd, command: process.execPath, timeoutMs: -5 },
    { cwd, command: process.execPath, timeoutMs: 1.5 },
    { cwd, command: process.execPath, timeoutMs: Number.NaN },
    { cwd, command: process.execPath, timeoutMs: '5' },
    { cwd, command: process.execPath, timeoutMs: 2 ** 31 },
  ]
  for (const spec of cases) {
    const result = await runSuite(spec)
    assert.equal(result.status, 'unmeasured', JSON.stringify(spec))
    assert.equal(reasonOf(result), 'invalid-input')
    assert.equal(result.pgid, null, 'nothing was spawned')
  }
  assert.equal((await runSuite()).reason, 'invalid-input')
})

test('runSuite reports an unavailable executable or working directory as spawn-error', async () => {
  const cwd = scratchDir('checks-suite-')
  const missing = await runSuite({ cwd, command: join(cwd, 'no-such-binary'), timeoutMs: GATE_TIMEOUT_MS })
  assert.equal(missing.status, 'unmeasured')
  assert.equal(reasonOf(missing), 'spawn-error')
  assert.equal(missing.error.code, 'ENOENT')
  const noDir = await runSuite({ cwd: join(cwd, 'absent'), command: process.execPath, args: ['-e', ''], timeoutMs: GATE_TIMEOUT_MS })
  assert.equal(noDir.status, 'unmeasured')
  assert.equal(reasonOf(noDir), 'spawn-error')
})

test('runSuite reports a signalled leader as unmeasured signal, never red or green', async () => {
  const result = await node(scratchDir('checks-suite-'), "process.kill(process.pid, 'SIGKILL')")
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'signal')
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.code, null)
})

test('runSuite times out a hung leader and proves its group dead', async () => {
  const result = await node(scratchDir('checks-suite-'), "console.log('started'); setInterval(() => {}, 1000)", { timeoutMs: SHORT_TIMEOUT_MS })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'timeout')
  assert.equal(result.timedOut, true)
  assert.equal(result.cleanup, 'proven')
  assert.equal(result.stdout, 'started\n')
  assert.ok(groupGone(result.pgid))
})

test('runSuite kills a TERM-resistant descendant past the timeout, observed in the OS', async () => {
  const cwd = scratchDir('checks-suite-')
  const pidPath = join(cwd, 'descendant.pid')
  const runner = join(cwd, 'suite.mjs')
  writeFileSync(runner, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); setInterval(() => {}, 1000);`)
  let result
  try {
    result = await runSuite({ cwd, command: process.execPath, args: [runner], timeoutMs: SHORT_TIMEOUT_MS })
    const descendant = Number(readFileSync(pidPath, 'utf8'))
    assert.equal(result.timedOut, true)
    assert.notEqual(result.status, 'green')
    assert.ok(groupGone(result.pgid), 'no member of the suite group remains')
    assert.ok(pidGone(descendant), 'the TERM-resistant descendant is gone')
  } finally {
    if (existsSync(pidPath)) { try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL') } catch {} }
    if (result?.pgid > 1) { try { process.kill(-result.pgid, 'SIGKILL') } catch {} }
  }
})

test('runSuite bounds a leader that exits while a descendant holds the pipes', async () => {
  const cwd = scratchDir('checks-suite-')
  const pidPath = join(cwd, 'holder.pid')
  const source = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); console.log('leader gone')`
  let result
  const started = Date.now()
  try {
    result = await node(cwd, source, { timeoutMs: SHORT_TIMEOUT_MS })
    assert.ok(Date.now() - started < BOUNDED_WALL_MS, 'settled soon after the deadline')
    assert.equal(result.status, 'unmeasured')
    assert.equal(reasonOf(result), 'timeout')
    assert.equal(result.timedOut, true)
    assert.equal(result.stdout, 'leader gone\n')
    assert.ok(groupGone(result.pgid))
    assert.ok(pidGone(Number(readFileSync(pidPath, 'utf8'))))
  } finally {
    if (existsSync(pidPath)) { try { process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL') } catch {} }
    if (result?.pgid > 1) { try { process.kill(-result.pgid, 'SIGKILL') } catch {} }
  }
})

test('runSuite stops a runaway writer at the output limit', async () => {
  const source = "const chunk = Buffer.alloc(1 << 20, 97); let n = 0; (function write() { while (n < 200) { n++; if (!process.stdout.write(chunk)) return process.stdout.once('drain', write) } })()"
  const result = await node(scratchDir('checks-suite-'), source, { timeoutMs: OUTPUT_PROBE_TIMEOUT_MS })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'output-limit')
  assert.ok(result.stdout.length <= 64 * 1024 * 1024)
  assert.ok(groupGone(result.pgid))
})

test('runSuite never reports green when the group probe says EPERM or fails unknown', async () => {
  const cwd = scratchDir('checks-suite-')
  for (const code of ['EPERM', 'EIO']) {
    const probes = []
    const probeKill = (pid, signal) => { probes.push([pid, signal]); throw Object.assign(new Error(code), { code }) }
    const result = await node(cwd, "console.log('done')", {}, { probeKill })
    assert.notEqual(result.status, 'green', code)
    assert.equal(result.status, 'unmeasured')
    assert.equal(reasonOf(result), 'cleanup-unproven')
    assert.equal(result.cleanup, 'unproven')
    assert.equal(result.code, 0, 'the leader completion is preserved as a diagnostic')
    assert.equal(result.stdout, 'done\n')
    assert.ok(probes.length > 0 && probes.every(([pid, signal]) => pid < -1 && signal === 0), 'probes are signal-0 group probes only')
  }
})

test('runSuite keeps timedOut true even when cleanup cannot be proven', async () => {
  const probeKill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
  const result = await node(scratchDir('checks-suite-'), 'setInterval(() => {}, 1000)', { timeoutMs: SHORT_TIMEOUT_MS }, { probeKill })
  assert.equal(result.timedOut, true)
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'cleanup-unproven')
})

// MUTATION: re-export runGate.
test('legacy gate and mutation exports are absent', () => {
  for (const key of ['runGate', 'checkBaseline', 'proveMutations']) assert.equal(Object.hasOwn(checks, key), false)
  assert.ok(CHECK_REASONS.includes('proof-unproven'))
})

const FAKE_OK = (stdout = '') => ({ status: 'green', reason: null, code: 0, signal: null, stdout, stderr: '', timedOut: false })
const FAKE_BAD = { status: 'red', reason: 'exit-nonzero', code: 1, signal: null, stdout: '', stderr: 'injected failure', timedOut: false }
const FAKE_UNMEASURED = (reason) => ({ status: 'unmeasured', reason, code: null, signal: null, stdout: '', stderr: '', timedOut: false })
const through = (override) => async (spec) => (await override(spec)) ?? runSuite(spec)
const has = (spec, word) => spec.command === 'git' && spec.args.includes(word)

function laneRepo(files = { 'a.txt': 'base\n', 'outside.txt': 'base\n' }) {
  const cwd = scratchDir('checks-lane-')
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Lane')
  git(cwd, 'config', 'user.email', 'lane@example.invalid')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', 'base')
  git(cwd, 'checkout', '-qb', 'lane')
  return cwd
}
const snapshot = (cwd) => ({
  head: git(cwd, 'rev-parse', 'HEAD'),
  status: git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
  entries: git(cwd, 'ls-files', '--stage', '-z'),
  bytes: ['a.txt', 'outside.txt'].map((name) => (existsSync(join(cwd, name)) ? readFileSync(join(cwd, name), 'utf8') : null)),
})
const committed = (cwd) => git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean).sort()
const numbered = (text) => text.split('\n').filter((line) => /#\d+/.test(line))
function conflictLane() {
  const cwd = laneRepo()
  writeFileSync(join(cwd, 'a.txt'), 'lane\n')
  writeFileSync(join(cwd, 'outside.txt'), 'lane\n')
  git(cwd, 'commit', '-qam', 'lane')
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'a.txt'), 'main\n')
  writeFileSync(join(cwd, 'outside.txt'), 'main\n')
  git(cwd, 'commit', '-qam', 'main')
  git(cwd, 'checkout', '-q', 'lane')
  return cwd
}

test('commitChanges commits exactly the listed changed files, keeps unrelated staged work staged and builds trailers', async () => {
  const cwd = laneRepo()
  const odd = ['new file.txt', '-dash.txt', ':(glob)*.txt', 'line\nbreak.txt']
  for (const name of odd) writeFileSync(join(cwd, name), 'x\n')
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  writeFileSync(join(cwd, 'outside.txt'), 'staged elsewhere\n')
  git(cwd, 'add', 'outside.txt')
  const result = await commitChanges({ cwd, files: ['a.txt', ...odd, 'never-created.txt', 'a.txt'], subject: 'feat: scoped (#5)', body: 'Fixes #303; owner/repo#7 stays prose.\nCloses: #8', closes: [101, 202, 101], refs: [303, 101] })
  assert.equal(result.status, 'green')
  assert.equal(reasonOf(result), null)
  assert.equal(result.head, git(cwd, 'rev-parse', 'HEAD').trim())
  assert.deepEqual(committed(cwd), ['a.txt', ...odd].sort())
  assert.equal(git(cwd, 'diff', '--cached', '--name-only').trim(), 'outside.txt')
  assert.deepEqual(numbered(git(cwd, 'log', '-1', '--format=%B')), ['Closes: #101', 'Closes: #202', 'Refs: #303'])
  assert.match(git(cwd, 'log', '-1', '--format=%s'), /^feat: scoped \(issue 5\)$/m)
})

test('commitChanges commits deletions whether staged or not, and a rename only with both ends', async () => {
  const cwd = laneRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' })
  rmSync(join(cwd, 'a.txt'))
  git(cwd, 'rm', '-q', 'b.txt')
  git(cwd, 'mv', 'c.txt', 'd.txt')
  const before = snapshot(cwd)
  const half = await commitChanges({ cwd, files: ['a.txt', 'b.txt', 'd.txt'], subject: 'feat: half rename' })
  assert.equal(half.status, 'unmeasured')
  assert.equal(reasonOf(half), 'invalid-input')
  assert.deepEqual(snapshot(cwd), before)
  const whole = await commitChanges({ cwd, files: ['a.txt', 'b.txt', 'c.txt', 'd.txt'], subject: 'feat: whole' })
  assert.equal(whole.status, 'green', JSON.stringify(whole))
  assert.deepEqual(committed(cwd), ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  assert.equal(git(cwd, 'status', '--porcelain'), '')
})

test('commitChanges refuses an empty or unchanged scope without staging or committing', async () => {
  const cwd = laneRepo()
  const calls = []
  const run = through((spec) => { calls.push(spec) })
  writeFileSync(join(cwd, 'outside.txt'), 'changed\n')
  for (const files of [[], ['never-created.txt'], ['a.txt']]) {
    const result = await commitChanges({ cwd, files, subject: 'feat: nothing' }, { run })
    assert.equal(result.status, 'red')
    assert.equal(reasonOf(result), 'nothing-to-commit')
  }
  assert.ok(!calls.some((spec) => has(spec, 'add') || has(spec, 'commit')))
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '')
})

test('commitChanges refuses invalid input as unmeasured without running anything', async () => {
  const cwd = laneRepo()
  mkdirSync(join(cwd, 'dir'))
  writeFileSync(join(cwd, 'dir/f.txt'), 'x\n')
  const calls = []
  const run = async (spec) => { calls.push(spec); return FAKE_OK() }
  const base = { cwd, files: ['a.txt'], subject: 'feat: x' }
  const cases = [
    { cwd: '' }, { cwd: 5 }, { files: 'a.txt' }, { files: [1] }, { files: ['/etc/passwd'] }, { files: ['../x'] }, { files: ['.git/config'] }, { files: ['dir/'] }, { files: ['a\\b'] },
    { files: ['dir'] }, { subject: '' }, { subject: 'a\nb' }, { subject: 5 }, { body: 5 }, { closes: ['1'] }, { closes: [0] }, { closes: [1.5] }, { closes: 'x' }, { refs: [-1] },
    { timeoutMs: 0 }, { timeoutMs: 'x' },
  ]
  for (const patch of cases) {
    const result = await commitChanges({ ...base, ...patch }, { run })
    assert.equal(result.status, 'unmeasured', JSON.stringify(patch))
    assert.equal(reasonOf(result), 'invalid-input', JSON.stringify(patch))
  }
  assert.equal((await commitChanges()).reason, 'invalid-input')
  assert.equal((await commitChanges(null, null)).status, 'unmeasured')
  assert.equal(calls.length, 0)
})

test('commitChanges refuses a checkout with a merge, lock or unmerged state in progress and changes nothing', async () => {
  for (const marker of ['MERGE_HEAD', 'index.lock', 'CHERRY_PICK_HEAD']) {
    const cwd = laneRepo()
    writeFileSync(join(cwd, 'a.txt'), 'changed\n')
    const before = snapshot(cwd)
    writeFileSync(join(cwd, '.git', marker), `${git(cwd, 'rev-parse', 'HEAD').trim()}\n`)
    const result = await commitChanges({ cwd, files: ['a.txt'], subject: 'feat: x' })
    assert.equal(result.status, 'red', marker)
    assert.equal(reasonOf(result), 'dirty-worktree')
    assert.deepEqual(snapshot(cwd), before)
  }
  const cwd = conflictLane()
  assert.throws(() => git(cwd, 'merge', 'main'))
  const result = await commitChanges({ cwd, files: ['a.txt'], subject: 'feat: x' })
  assert.equal(reasonOf(result), 'dirty-worktree')
})

test('commitChanges restores HEAD, index and tree when staging or the commit fails after taking effect', async () => {
  for (const word of ['add', 'commit']) {
    const cwd = laneRepo()
    writeFileSync(join(cwd, 'a.txt'), 'change\n')
    writeFileSync(join(cwd, 'outside.txt'), 'staged\n')
    writeFileSync(join(cwd, 'fresh.txt'), 'new\n')
    git(cwd, 'add', 'outside.txt')
    const before = snapshot(cwd)
    let attempted = 0
    const run = through(async (spec) => {
      if (!has(spec, word)) return undefined
      attempted++
      await runSuite(spec)
      return FAKE_BAD
    })
    const result = await commitChanges({ cwd, files: ['a.txt', 'fresh.txt'], subject: 'feat: fails' }, { run })
    assert.equal(attempted, 1, word)
    assert.equal(result.status, 'red', word)
    assert.equal(reasonOf(result), 'commit-failed')
    assert.deepEqual(snapshot(cwd), before, word)
  }
})

test('commitChanges never claims a restore it could not prove', async () => {
  const cwd = laneRepo()
  writeFileSync(join(cwd, 'a.txt'), 'change\n')
  const run = through(async (spec) => {
    if (has(spec, 'update-ref')) return FAKE_BAD
    if (!has(spec, 'commit')) return undefined
    await runSuite(spec)
    return FAKE_BAD
  })
  const result = await commitChanges({ cwd, files: ['a.txt'], subject: 'feat: fails' }, { run })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'cleanup-unproven')
  assert.ok(result.problems.length > 0)
})

test('commitChanges in a linked worktree uses and restores that worktree index', async () => {
  const cwd = laneRepo()
  const linked = join(scratchDir('checks-linked-'), 'wt')
  git(cwd, 'worktree', 'add', '-q', '-b', 'side', linked)
  writeFileSync(join(linked, 'a.txt'), 'side\n')
  const before = snapshot(linked)
  const failing = through(async (spec) => {
    if (!has(spec, 'commit')) return undefined
    await runSuite(spec)
    return FAKE_BAD
  })
  const failed = await commitChanges({ cwd: linked, files: ['a.txt'], subject: 'feat: side' }, { run: failing })
  assert.equal(reasonOf(failed), 'commit-failed')
  assert.deepEqual(snapshot(linked), before)
  const ok = await commitChanges({ cwd: linked, files: ['a.txt'], subject: 'feat: side' })
  assert.equal(ok.status, 'green')
  assert.deepEqual(committed(linked), ['a.txt'])
  assert.equal(git(cwd, 'rev-parse', 'lane'), git(cwd, 'rev-parse', 'main'))
})

test('commitChanges and rebaseBranch turn every runner failure into an unmeasured result', async () => {
  const cwd = laneRepo()
  const runners = [
    ['runner-threw', async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) }],
    ['runner-threw', async () => undefined],
    ['runner-threw', async () => ({ ...FAKE_OK(), code: 1 })],
    ['runner-threw', async () => ({ ...FAKE_OK(), stdout: null })],
    ['spawn-error', async () => FAKE_UNMEASURED('spawn-error')],
    ['signal', async () => FAKE_UNMEASURED('signal')],
    ['timeout', async () => FAKE_UNMEASURED('timeout')],
  ]
  for (const [reason, run] of runners) {
    for (const result of [await commitChanges({ cwd, files: ['a.txt'], subject: 'feat: x' }, { run }), await rebaseBranch({ cwd, base: 'main' }, { run })]) {
      assert.equal(result.status, 'unmeasured', reason)
      assert.equal(reasonOf(result), reason)
    }
  }
})

test('rebaseBranch fast-forwards, and a rebase that is already current is green', async () => {
  const cwd = laneRepo()
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'outside.txt'), 'main moved\n')
  git(cwd, 'commit', '-qam', 'main moved')
  git(cwd, 'checkout', '-q', 'lane')
  const moved = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(moved.status, 'green')
  assert.equal(reasonOf(moved), null)
  assert.equal(moved.head, git(cwd, 'rev-parse', 'main').trim())
  assert.equal(git(cwd, 'rev-parse', 'HEAD').trim(), moved.head)
  const again = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(again.status, 'green')
  assert.equal(again.head, moved.head)
})

// MUTATION: report the lane's old head as onto instead of the base commit.
test('rebaseBranch reports the base commit it rebased onto, and a lane commit already on the base leaves the head there', async () => {
  for (const dropped of [false, true]) {
    const cwd = laneRepo()
    writeFileSync(join(cwd, 'a.txt'), 'lane\n')
    git(cwd, 'commit', '-qam', 'lane')
    git(cwd, 'checkout', '-q', 'main')
    if (dropped) git(cwd, 'cherry-pick', 'lane')
    else { writeFileSync(join(cwd, 'outside.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main') }
    const base = git(cwd, 'rev-parse', 'main').trim()
    git(cwd, 'checkout', '-q', 'lane')
    const result = await rebaseBranch({ cwd, base: 'main' })
    assert.equal(result.status, 'green')
    assert.equal(result.onto, base)
    if (dropped) assert.equal(result.head, base)
    else { assert.notEqual(result.head, base); assert.equal(git(cwd, 'rev-parse', 'HEAD^').trim(), base) }
  }
})

test('rebaseBranch reports every conflicting path, aborts, and leaves the checkout as found', async () => {
  const cwd = conflictLane()
  const before = snapshot(cwd)
  const result = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'rebase-conflict')
  assert.deepEqual([...result.conflicts].sort(), ['a.txt', 'outside.txt'])
  assert.deepEqual(snapshot(cwd), before)
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'lane')
  assert.equal(existsSync(join(cwd, '.git', 'rebase-merge')), false)
})

test('rebaseBranch refuses a dirty or busy checkout without starting a rebase', async () => {
  const calls = []
  const run = through((spec) => { calls.push(spec) })
  const cases = [
    (cwd) => writeFileSync(join(cwd, 'untracked.txt'), 'x\n'),
    (cwd) => writeFileSync(join(cwd, 'a.txt'), 'edited\n'),
    (cwd) => { writeFileSync(join(cwd, 'a.txt'), 'edited\n'); git(cwd, 'add', 'a.txt') },
    (cwd) => mkdirSync(join(cwd, '.git', 'rebase-merge')),
    (cwd) => writeFileSync(join(cwd, '.git', 'index.lock'), ''),
    (cwd) => writeFileSync(join(cwd, '.git', 'MERGE_HEAD'), `${git(cwd, 'rev-parse', 'HEAD').trim()}\n`),
  ]
  for (const arrange of cases) {
    const cwd = laneRepo()
    arrange(cwd)
    const before = snapshot(cwd)
    const result = await rebaseBranch({ cwd, base: 'main' }, { run })
    assert.equal(result.status, 'red')
    assert.equal(reasonOf(result), 'dirty-worktree')
    assert.deepEqual(snapshot(cwd), before)
  }
  assert.ok(!calls.some((spec) => has(spec, 'rebase')))
})

test('rebaseBranch reports an ordinary rebase failure as red rebase-failed with nothing changed', async () => {
  const cwd = laneRepo()
  const before = snapshot(cwd)
  const result = await rebaseBranch({ cwd, base: 'no-such-branch' })
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'rebase-failed')
  assert.equal(result.conflicts, undefined)
  assert.deepEqual(snapshot(cwd), before)
})

test('rebaseBranch rejects bases that could be read as options or are not ref names', async () => {
  const cwd = laneRepo()
  const calls = []
  const run = through((spec) => { calls.push(spec) })
  for (const base of ['', '-x', '--onto', 'a b', 'a..b', 'a\nb', 5, undefined]) {
    const result = await rebaseBranch({ cwd, base }, { run })
    assert.equal(result.status, 'unmeasured', String(base))
    assert.equal(reasonOf(result), 'invalid-input')
  }
  assert.ok(!calls.some((spec) => has(spec, 'rebase')))
})

test('rebaseBranch cleans up before reporting a stopped or interrupted rebase as unmeasured', async () => {
  for (const reason of ['signal', 'timeout']) {
    const cwd = conflictLane()
    const before = snapshot(cwd)
    const run = through(async (spec) => {
      if (!has(spec, 'rebase') || has(spec, '--abort')) return undefined
      await runSuite(spec)
      return FAKE_UNMEASURED(reason)
    })
    const result = await rebaseBranch({ cwd, base: 'main' }, { run })
    assert.equal(result.status, 'unmeasured', reason)
    assert.equal(reasonOf(result), reason)
    assert.deepEqual(snapshot(cwd), before)
  }
  const cwd = laneRepo()
  const thrown = await rebaseBranch({ cwd, base: 'main' }, { run: through((spec) => { if (has(spec, 'rebase')) throw new Error('boom') }) })
  assert.equal(reasonOf(thrown), 'runner-threw')
})

test('rebaseBranch never credits a cleanup whose abort or restoration probe failed', async () => {
  const aborted = conflictLane()
  const abortFails = through((spec) => (has(spec, '--abort') ? FAKE_BAD : undefined))
  const stuck = await rebaseBranch({ cwd: aborted, base: 'main' }, { run: abortFails })
  assert.equal(stuck.status, 'unmeasured')
  assert.equal(reasonOf(stuck), 'cleanup-unproven')
  assert.equal(existsSync(join(aborted, '.git', 'rebase-merge')), true)

  const probed = conflictLane()
  let abortSeen = false
  const probeFails = through(async (spec) => {
    if (has(spec, '--abort')) { abortSeen = true; return undefined }
    return abortSeen && has(spec, 'ls-files') ? FAKE_BAD : undefined
  })
  const unproven = await rebaseBranch({ cwd: probed, base: 'main' }, { run: probeFails })
  assert.equal(unproven.status, 'unmeasured')
  assert.equal(reasonOf(unproven), 'cleanup-unproven')
})

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const prRecord = (number, extra = {}) => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', headRefName: 'lane', baseRefName: 'main', isCrossRepository: false, ...extra })
const publishSpec = { cwd: process.cwd(), branch: 'lane', base: 'main', title: 'feat: publish', body: 'Fixes #91; issue #92 stays open.', closes: [91], refs: [92] }

// A scripted git remote and gh. `push` and `create` say whether the effect lands and what the command reports; `list` and `lsRemote` override a readback by call number.
function fakeRemote({ remote = OTHER_SHA, prs = [], push = 'lands', create = 'lands', edit = 'lands', view, list, lsRemote, head = SHA, branch = 'lane' } = {}) {
  const calls = []
  const state = { remote, prs: prs.map((pr) => ({ ...pr })), listed: 0, lsed: 0 }
  const run = async (spec) => {
    calls.push(spec)
    const { command, args } = spec
    if (command === 'git') {
      if (args[0] === 'rev-parse') return FAKE_OK(`${head}\n`)
      if (args[0] === 'symbolic-ref') return FAKE_OK(`${branch}\n`)
      if (args[0] === 'check-ref-format') return FAKE_OK()
      if (args[0] === 'push') {
        if (push.startsWith('lands')) state.remote = SHA
        return push.endsWith('fails') ? FAKE_BAD : FAKE_OK()
      }
      if (args[0] === 'ls-remote') return lsRemote?.(++state.lsed, state) ?? FAKE_OK(state.remote === '' ? '' : `${state.remote}\trefs/heads/lane\n`)
    }
    if (command === 'gh' && args[1] === 'list') return list?.(++state.listed, state) ?? FAKE_OK(JSON.stringify(state.prs))
    if (command === 'gh' && args[1] === 'create') {
      if (create.startsWith('lands')) state.prs.push(prRecord(18, { body: args[args.indexOf('--body') + 1] }))
      return create.endsWith('fails') ? FAKE_BAD : FAKE_OK('https://github.com/o/r/pull/18\n')
    }
    if (command === 'gh' && args[1] === 'edit') {
      const pr = state.prs.find((item) => String(item.number) === args[2])
      assert.ok(pr)
      if (typeof edit === 'function') return edit(spec, pr)
      if (edit === 'lands') pr.body = args[args.indexOf('--body') + 1]
      return FAKE_OK()
    }
    if (command === 'gh' && args[1] === 'view') {
      const pr = state.prs.find((item) => String(item.number) === args[2])
      assert.ok(pr)
      return view ? view(spec, pr) : FAKE_OK(JSON.stringify({ body: pr.body }))
    }
    throw new Error(`unexpected call ${JSON.stringify(spec)}`)
  }
  const count = (command, word) => calls.filter((spec) => spec.command === command && spec.args.includes(word)).length
  return { run, calls, state, count }
}

test('openPullRequest pushes without force, creates the PR with argv only and reads it back', async () => {
  const f = fakeRemote()
  const result = await openPullRequest(publishSpec, { run: f.run })
  assert.equal(result.status, 'green')
  assert.equal(reasonOf(result), null)
  assert.equal(result.reused, false)
  assert.equal(result.pr.number, 18)
  const push = f.calls.find((spec) => spec.args[0] === 'push')
  assert.deepEqual(push.args, ['push', 'origin', 'HEAD:refs/heads/lane'])
  const create = f.calls.find((spec) => spec.args[1] === 'create')
  assert.deepEqual(create.args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'lane', '--title', 'feat: publish'])
  assert.deepEqual(numbered(create.args[create.args.indexOf('--body') + 1]), ['Closes: #91', 'Refs: #92'])
  assert.ok(f.calls.every((spec) => spec.command === 'git' || spec.command === 'gh'))
  assert.ok(f.calls.every((spec) => Number.isSafeInteger(spec.timeoutMs) && spec.cwd === publishSpec.cwd))
  assert.ok(f.calls.every((spec) => spec.args.every((arg) => typeof arg === 'string' && !/^(--force|-f$|--force-with-lease|\+)/.test(arg))))
  assert.ok(f.calls.findIndex((spec) => spec.args[1] === 'list') < f.calls.indexOf(push), 'the PR query comes before anything is created or pushed')
})

test('openPullRequest returns the PR already open without creating, and skips a push the remote already has', async () => {
  const f = fakeRemote({ prs: [prRecord(17)], remote: SHA })
  const result = await openPullRequest(publishSpec, { run: f.run })
  assert.equal(result.status, 'green')
  assert.equal(result.reused, true)
  assert.equal(result.pr.number, 17)
  assert.equal(f.count('gh', 'create'), 0)
  assert.equal(f.count('git', 'push'), 0)
  const stale = fakeRemote({ prs: [prRecord(17)] })
  assert.equal((await openPullRequest(publishSpec, { run: stale.run })).pr.number, 17)
  assert.equal(stale.count('git', 'push'), 1)
  assert.equal(stale.count('gh', 'create'), 0)
})

// MUTATION: substitute stale text for the edit's composedBody.
test('RP1: reuse replaces the body exactly as a fresh PR for each publication', async () => {
  const reused = fakeRemote({ prs: [prRecord(17, { body: 'stale measurements' })] })
  const inputs = [
    { ...publishSpec, body: 'Fixes #5; measurements 1/1.', closes: [91, 91], refs: [91, 92, 92] },
    { ...publishSpec, body: 'New measurements 2/2; see #93.', closes: [93], refs: [94] },
    { ...publishSpec, body: '', closes: [], refs: [] },
    { ...publishSpec, body: '  Unicode ✓ and trailing whitespace  \n\n', closes: [], refs: [] },
  ]
  for (const [index, input] of inputs.entries()) {
    const fresh = fakeRemote({ remote: SHA })
    assert.equal((await openPullRequest(input, { run: fresh.run })).status, 'green')
    const start = reused.calls.length
    const result = await openPullRequest(input, { run: reused.run })
    assert.equal(result.status, 'green')
    assert.equal(result.reused, true)
    assert.equal(result.pr.number, 17)
    assert.equal(reused.state.prs[0].body, fresh.state.prs[0].body)
    const calls = reused.calls.slice(start)
    const editAt = calls.findIndex((call) => call.command === 'gh' && call.args[1] === 'edit')
    const pushAt = calls.findIndex((call) => call.command === 'git' && call.args[0] === 'push')
    assert.ok(editAt >= 0)
    assert.equal(pushAt >= 0, index === 0)
    if (pushAt >= 0) assert.ok(pushAt < editAt)
  }
  assert.equal(reused.count('gh', 'create'), 0)
  assert.equal(reused.count('gh', 'edit'), inputs.length)
})

// MUTATION: disable the confirmedBody !== composedBody refusal.
test('RP2: reuse refuses failed or unconfirmed body updates', async () => {
  const cases = {
    failed: { edit: () => FAKE_BAD },
    timeout: { edit: () => FAKE_UNMEASURED('timeout') },
    thrown: { edit: () => { throw new Error('interrupted') } },
    malformed: { edit: () => undefined },
    dropped: { edit: 'drops' },
    viewFailed: { view: () => FAKE_BAD },
    viewTimeout: { view: () => FAKE_UNMEASURED('timeout') },
    invalidJson: { view: () => FAKE_OK('{') },
    missing: { view: () => FAKE_OK('{}') },
    nonString: { view: () => FAKE_OK('{"body":42}') },
    newline: { view: (_spec, pr) => FAKE_OK(JSON.stringify({ body: `${pr.body}\n` })) },
  }
  for (const [name, options] of Object.entries(cases)) {
    const f = fakeRemote({ prs: [prRecord(17, { body: 'stale' })], remote: SHA, ...options })
    const result = await openPullRequest(publishSpec, { run: f.run })
    assert.ok(['red', 'unmeasured'].includes(result.status), name)
    assert.ok(CHECK_REASONS.includes(reasonOf(result)), name)
    assert.equal(f.count('gh', 'edit'), 1, name)
    assert.equal(f.count('gh', 'create'), 0, name)
  }
})

test('openPullRequest pushes a branch the remote does not have, and trusts the readback over the push exit', async () => {
  const absent = fakeRemote({ remote: '' })
  assert.equal((await openPullRequest(publishSpec, { run: absent.run })).status, 'green')
  assert.equal(absent.count('git', 'push'), 1)
  const failedButLanded = fakeRemote({ push: 'lands-fails' })
  const result = await openPullRequest(publishSpec, { run: failedButLanded.run })
  assert.equal(result.status, 'green')
  assert.equal(failedButLanded.count('gh', 'create'), 1)
})

test('openPullRequest stops before any PR when the push cannot be proven', async () => {
  const readbacks = {
    mismatch: [{ push: 'drops' }],
    denied: [{ lsRemote: (n) => (n === 1 ? undefined : FAKE_BAD) }],
    empty: [{ lsRemote: (n) => (n === 1 ? undefined : FAKE_OK('')) }],
    malformed: [{ lsRemote: (n) => (n === 1 ? undefined : FAKE_OK('garbage\n')) }],
    foreign: [{ lsRemote: (n) => (n === 1 ? undefined : FAKE_OK(`${SHA}\trefs/heads/other\n`)) }],
    twice: [{ lsRemote: (n) => (n === 1 ? undefined : FAKE_OK(`${SHA}\trefs/heads/lane\n${SHA}\trefs/heads/lane\n`)) }],
    pushFailsUnreadable: [{ push: 'fails', lsRemote: (n) => (n === 1 ? undefined : FAKE_UNMEASURED('timeout')) }],
  }
  for (const [name, [options]] of Object.entries(readbacks)) {
    const f = fakeRemote(options)
    const result = await openPullRequest(publishSpec, { run: f.run })
    assert.equal(result.status, 'unmeasured', name)
    assert.equal(reasonOf(result), 'push-unmeasured', name)
    assert.equal(f.count('gh', 'create'), 0, name)
  }
})

test('openPullRequest treats an unreadable, ambiguous or foreign PR list as unknown, not as no PR', async () => {
  const lists = {
    failed: () => FAKE_BAD,
    notJson: () => FAKE_OK('not json'),
    notArray: () => FAKE_OK('{"number":1}'),
    two: () => FAKE_OK(JSON.stringify([prRecord(1), prRecord(2)])),
    badNumber: () => FAKE_OK(JSON.stringify([prRecord(0)])),
    badUrl: () => FAKE_OK(JSON.stringify([prRecord(3, { url: 'http://github.com/o/r/pull/3' })])),
    noUrl: () => FAKE_OK(JSON.stringify([prRecord(3, { url: 5 })])),
    closed: () => FAKE_OK(JSON.stringify([prRecord(4, { state: 'CLOSED' })])),
    wrongHead: () => FAKE_OK(JSON.stringify([prRecord(5, { headRefName: 'other' })])),
    wrongBase: () => FAKE_OK(JSON.stringify([prRecord(6, { baseRefName: 'dev' })])),
    fork: () => FAKE_OK(JSON.stringify([prRecord(7, { isCrossRepository: true })])),
    forkUnknown: () => FAKE_OK(JSON.stringify([prRecord(8, { isCrossRepository: undefined })])),
    timeout: () => FAKE_UNMEASURED('timeout'),
  }
  for (const [name, list] of Object.entries(lists)) {
    const f = fakeRemote({ list })
    const result = await openPullRequest(publishSpec, { run: f.run })
    assert.equal(result.status, 'unmeasured', name)
    assert.equal(reasonOf(result), 'pr-unmeasured', name)
    assert.equal(f.count('gh', 'create') + f.count('git', 'push'), 0, name)
  }
})

test('openPullRequest recovers a PR created despite a failed create, and a retry reuses it', async () => {
  const f = fakeRemote({ create: 'lands-fails' })
  const first = await openPullRequest(publishSpec, { run: f.run })
  assert.equal(first.status, 'green')
  assert.equal(first.reused, false)
  assert.equal(first.pr.number, 18)
  const retry = await openPullRequest(publishSpec, { run: f.run })
  assert.equal(retry.status, 'green')
  assert.equal(retry.reused, true)
  assert.equal(f.count('gh', 'create'), 1)
  const thrown = fakeRemote()
  const throwing = async (spec) => {
    const result = await thrown.run(spec)
    if (spec.args[1] === 'create') throw Object.assign(new Error('interrupted'), { code: 'EINTR' })
    return result
  }
  assert.equal((await openPullRequest(publishSpec, { run: throwing })).pr.number, 18)
})

test('openPullRequest reports a create it cannot confirm as unmeasured pr-unmeasured', async () => {
  const cases = {
    unrecorded: fakeRemote({ create: 'drops' }),
    okButAbsent: fakeRemote({ create: 'ok' }),
    readbackFailed: fakeRemote({ list: (n) => (n === 1 ? undefined : FAKE_BAD) }),
    readbackMalformed: fakeRemote({ list: (n) => (n === 1 ? undefined : FAKE_OK('not json')) }),
    readbackTwo: fakeRemote({ list: (n) => (n === 1 ? undefined : FAKE_OK(JSON.stringify([prRecord(18), prRecord(19)]))) }),
  }
  for (const [name, f] of Object.entries(cases)) {
    const result = await openPullRequest(publishSpec, { run: f.run })
    assert.equal(result.status, 'unmeasured', name)
    assert.equal(reasonOf(result), 'pr-unmeasured', name)
    assert.equal(f.count('gh', 'create'), 1, name)
  }
})

test('openPullRequest refuses invalid input and a branch that is not checked out without publishing anything', async () => {
  const cases = [
    { cwd: '' }, { branch: '' }, { branch: '-x' }, { branch: 'a b' }, { branch: 5 }, { base: '--head' }, { base: undefined }, { title: '' }, { title: 'a\nb' }, { body: 5 },
    { closes: [0] }, { refs: ['1'] }, { remote: '-o' }, { remote: 'a b' }, { remote: '' }, { timeoutMs: 0 },
  ]
  for (const patch of cases) {
    const f = fakeRemote()
    const result = await openPullRequest({ ...publishSpec, ...patch }, { run: f.run })
    assert.equal(result.status, 'unmeasured', JSON.stringify(patch))
    assert.equal(reasonOf(result), 'invalid-input', JSON.stringify(patch))
    assert.equal(f.count('gh', 'create') + f.count('git', 'push'), 0)
  }
  const elsewhere = fakeRemote({ branch: 'other' })
  assert.equal((await openPullRequest(publishSpec, { run: elsewhere.run })).reason, 'invalid-input')
  assert.equal(elsewhere.count('git', 'push'), 0)
  assert.equal((await openPullRequest()).reason, 'invalid-input')
})

test('openPullRequest turns runner failures and empty readbacks into unmeasured results, never a PR', async () => {
  const runners = {
    eperm: ['runner-threw', async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) }],
    enoent: ['spawn-error', async () => ({ ...FAKE_UNMEASURED('spawn-error'), error: { code: 'ENOENT', message: 'spawn gh ENOENT' } })],
    interrupted: ['signal', async () => FAKE_UNMEASURED('signal')],
    undefinedResult: ['runner-threw', async () => undefined],
  }
  for (const [name, [reason, run]] of Object.entries(runners)) {
    const result = await openPullRequest(publishSpec, { run })
    assert.equal(result.status, 'unmeasured', name)
    assert.notEqual(result.status, 'green')
    assert.equal(reasonOf(result), reason, name)
  }
  const emptyHead = fakeRemote({ head: '' })
  assert.equal((await openPullRequest(publishSpec, { run: emptyHead.run })).reason, 'invalid-remote-data')
  assert.equal(emptyHead.count('gh', 'create'), 0)
})

test('issue numbers reach a commit message and a PR body only on the dedicated trailer lines', async () => {
  const prose = 'Fixes #5 and resolves #6; see owner/repo#7.\nCloses: #8\nRefs: #9\nthis stays open (#10)'
  const f = fakeRemote()
  await openPullRequest({ ...publishSpec, body: prose, closes: [91, 92, 91], refs: [92, 93, 93] }, { run: f.run })
  const create = f.calls.find((spec) => spec.args[1] === 'create')
  const body = create.args[create.args.indexOf('--body') + 1]
  assert.deepEqual(numbered(body), ['Closes: #91', 'Closes: #92', 'Refs: #93'])
  assert.match(body, /^Fixes issue 5 and resolves issue 6; see owner\/repoissue 7\.$/m)
  const cwd = laneRepo()
  writeFileSync(join(cwd, 'a.txt'), 'changed\n')
  const made = await commitChanges({ cwd, files: ['a.txt'], subject: 'fix: x (#4)', body: prose, closes: [91, 92], refs: [92, 93] })
  assert.equal(made.status, 'green')
  assert.deepEqual(numbered(git(cwd, 'log', '-1', '--format=%B')), ['Closes: #91', 'Closes: #92', 'Refs: #93'])
  const none = await commitChanges({ cwd, files: ['outside.txt'], subject: 'fix: y' })
  assert.equal(none.reason, 'nothing-to-commit')
})

// MUTATION: count an added-then-deleted entry as changed and its pathspec fails the whole commit.
test('commitChanges commits the real change beside a file added to the index then deleted from the tree', async () => {
  const cwd = laneRepo({ 'a.txt': 'one\n' })
  writeFileSync(join(cwd, 'a.txt'), 'two\n')
  writeFileSync(join(cwd, 'new.txt'), 'x\n')
  git(cwd, 'add', 'new.txt')
  rmSync(join(cwd, 'new.txt'))
  const result = await commitChanges({ cwd, files: ['a.txt', 'new.txt'], subject: 'feat: real change' })
  assert.equal(result.status, 'green', JSON.stringify(result))
  assert.deepEqual(committed(cwd), ['a.txt'])
})

// MUTATION: pass the title through unchanged and a squash merge subject closes the issue it names.
test('openPullRequest neutralizes issue numbers in the title', async () => {
  const f = fakeRemote()
  await openPullRequest({ ...publishSpec, title: 'fix: Fixes #5 partially' }, { run: f.run })
  const create = f.calls.find((spec) => spec.args[1] === 'create')
  const title = create.args[create.args.indexOf('--title') + 1]
  assert.equal(title.includes('#'), false, title)
})

// MUTATION: rebase onto the bare name and a tag of the same name wins over the branch.
test('rebaseBranch rebases onto the branch, not a tag that shares its name', async () => {
  const cwd = laneRepo({ 'a.txt': 'base\n' })
  const lane = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(cwd, 'tag', 'main', 'HEAD')
  git(cwd, 'checkout', '-q', 'refs/heads/main')
  git(cwd, 'checkout', '-q', '-B', 'main')
  writeFileSync(join(cwd, 'b.txt'), 'newer on main\n')
  git(cwd, 'add', 'b.txt')
  git(cwd, 'commit', '-q', '-m', 'main moves')
  git(cwd, 'checkout', '-q', lane)
  writeFileSync(join(cwd, 'c.txt'), 'lane work\n')
  git(cwd, 'add', 'c.txt')
  git(cwd, 'commit', '-q', '-m', 'lane work')
  const result = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(result.status, 'green', JSON.stringify(result))
  assert.equal(gitResult(cwd, 'merge-base', '--is-ancestor', 'refs/heads/main', 'HEAD').status, 0)
})

// MUTATION: query with --base and a PR the lane already has on another base is invisible, so a second is created.
test('openPullRequest finds the lane PR on any base and refuses to open a second', async () => {
  const f = fakeRemote({ prs: [prRecord(30, { baseRefName: 'dev' })], remote: SHA })
  const result = await openPullRequest(publishSpec, { run: f.run })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'pr-unmeasured')
  assert.equal(f.count('gh', 'create'), 0)
  assert.ok(f.calls.filter((spec) => spec.args[1] === 'list').every((spec) => !spec.args.includes('--base')))
})

// MUTATION: compare status labels only and a failed commit that left different bytes reads as restored.
test('commitChanges never reports a measured failure when the bytes of a changed file are not restored', async () => {
  const cwd = laneRepo()
  writeFileSync(join(cwd, 'a.txt'), 'requested\n')
  const run = through(async (spec) => {
    if (!has(spec, 'commit')) return undefined
    writeFileSync(join(cwd, 'a.txt'), 'tampered\n')
    return FAKE_BAD
  })
  const result = await commitChanges({ cwd, files: ['a.txt'], subject: 'feat: fails' }, { run })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'cleanup-unproven')
})

// MUTATION: prefer the local base and a lane rebased onto a stale local main reads as on its base.
test('rebaseBranch rebases onto origin/<base> when the local base lags it', async () => {
  const cwd = laneRepo({ 'a.txt': 'base\n' })
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'b.txt'), 'remote moved\n')
  git(cwd, 'add', 'b.txt')
  git(cwd, 'commit', '-qm', 'remote moves')
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(cwd, 'reset', '-q', '--hard', 'HEAD~1')
  git(cwd, 'checkout', '-q', 'lane')
  const result = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(result.status, 'green', JSON.stringify(result))
  assert.equal(gitResult(cwd, 'merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD').status, 0)
})

// MUTATION: drop the detached refusal and a rebase moves HEAD while the lane branch stays behind.
test('rebaseBranch refuses a detached HEAD without moving anything', async () => {
  const cwd = laneRepo({ 'a.txt': 'base\n' })
  git(cwd, 'checkout', '-q', '--detach')
  const before = snapshot(cwd)
  const result = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'invalid-input')
  assert.deepEqual(snapshot(cwd), before)
})

// MUTATION: skip the reset and a rebase whose runner failed after git finished leaves the branch moved.
test('rebaseBranch puts the branch back when its runner reports failure after git finished', async () => {
  const cwd = laneRepo({ 'a.txt': 'base\n' })
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'b.txt'), 'main moved\n')
  git(cwd, 'add', 'b.txt')
  git(cwd, 'commit', '-qm', 'main moves')
  git(cwd, 'checkout', '-q', 'lane')
  writeFileSync(join(cwd, 'c.txt'), 'lane\n')
  git(cwd, 'add', 'c.txt')
  git(cwd, 'commit', '-qm', 'lane work')
  const before = snapshot(cwd)
  const run = through(async (spec) => {
    if (!(has(spec, 'rebase') && !spec.args.includes('--abort'))) return undefined
    await runSuite(spec)
    return FAKE_BAD
  })
  const result = await rebaseBranch({ cwd, base: 'main' }, { run })
  assert.notEqual(result.status, 'green')
  assert.deepEqual(snapshot(cwd), before)
})

// MUTATION: drop the branch-equals-base refusal and the step pushes straight to the base.
test('openPullRequest refuses a lane branch that is its own base before any push', async () => {
  const f = fakeRemote({ branch: 'main' })
  const result = await openPullRequest({ ...publishSpec, branch: 'main' }, { run: f.run })
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'invalid-input')
  assert.equal(f.calls.length, 0)
})

// MUTATION: drop the ignored-path collision check and a conflicting rebase overwrites the ignored file.
test('rebaseBranch refuses to rebase over an ignored file the base tracks', async () => {
  const cwd = laneRepo({ 'a.txt': 'base\n', '.gitignore': 'build.log\n' })
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, '.gitignore'), '')
  writeFileSync(join(cwd, 'build.log'), 'tracked on main\n')
  git(cwd, 'add', '.gitignore', 'build.log')
  git(cwd, 'commit', '-qm', 'main tracks build.log')
  git(cwd, 'checkout', '-q', 'lane')
  writeFileSync(join(cwd, 'build.log'), 'precious local log\n')
  const result = await rebaseBranch({ cwd, base: 'main' })
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'dirty-worktree')
  assert.deepEqual(result.paths, ['build.log'])
  assert.equal(readFileSync(join(cwd, 'build.log'), 'utf8'), 'precious local log\n')
})
