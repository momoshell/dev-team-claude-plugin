import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, runSuite } from './checks.mjs'
import * as checks from './checks.mjs'
import { sampledBudget } from './host-sleep.mjs'

const GATE_TIMEOUT_MS = 10_000
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
test('the reason vocabulary is a frozen list of unique tokens', () => {
  assert.ok(Object.isFrozen(CHECK_REASONS))
  assert.equal(new Set(CHECK_REASONS).size, CHECK_REASONS.length)
  assert.equal(CHECK_REASONS.length, 20)
  for (const token of ['invalid-project-config', 'setup-failed', 'nothing-to-commit', 'commit-failed', 'rebase-conflict', 'rebase-failed', 'dirty-worktree', 'push-unmeasured', 'pr-unmeasured', 'invalid-remote-data']) assert.ok(CHECK_REASONS.includes(token), token)
})

test('sampledBudget freezes its final sample at stop', () => {
  for (const [elapsed, left, fields] of [[100, 900, {}], [6025, 975, { sleep_credited_s: 6 }]]) {
    let clock = 0, failed = false, nowReads = 0, sampleReads = 0, scheduled = 0
    const budget = sampledBudget(1000, {
      now: () => { nowReads++; if (failed) throw new Error('late clock failure'); return clock },
      sampleNow: () => { sampleReads++; if (failed) throw new Error('late sample failure'); return clock },
      setTimeout: () => { scheduled++ },
    })
    clock = elapsed
    const before = [nowReads, sampleReads]
    budget.stop()
    assert.deepEqual([nowReads, sampleReads], before.map((count) => count + 1))
    const stoppedReads = [nowReads, sampleReads]
    for (const fail of [false, true]) {
      clock += 3_600_000
      failed = fail
      budget.stop()
      assert.equal(budget.remaining(), left)
      assert.deepEqual(budget.fields(), fields)
      budget.watch(() => assert.fail('a stopped budget cannot expire again'))
      assert.deepEqual([nowReads, sampleReads], stoppedReads)
      assert.equal(scheduled, 0)
    }
  }
})

test('a budget with failed sampling keeps its deadline and unavailable credit at stop', () => {
  for (const failure of ['backwards', 'throwing', 'missing']) {
    let clock = 0
    const budget = sampledBudget(1000, {
      now: () => clock,
      sampleNow: failure === 'missing' ? null : () => {
        if (clock && failure === 'throwing') throw new Error('no clock')
        return clock ? -1 : 0
      },
    })
    clock = 100
    assert.equal(budget.remaining(), 900)
    clock = 1000
    budget.stop()
    assert.equal(budget.remaining(), 0)
    assert.deepEqual(budget.fields(), { sleep_credited_s: null, sleep_credit_reason: 'clock-unavailable' })
  }
})

test('runSuite reports unavailable suspension sampling without disabling its timeout', async () => {
  for (const sampleNow of [null, () => { throw new Error('no clock') }]) {
    const result = await node(scratchDir('checks-sleep-'), 'setInterval(() => {}, 1000)', { timeoutMs: 100 }, { sampleNow })
    assert.equal(result.reason, 'timeout')
    assert.equal(result.sleep_credited_s, null)
    assert.equal(result.sleep_credit_reason, 'clock-unavailable')
    assert.equal(result.cleanup, 'proven')
    assert.ok(groupGone(result.pgid))
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

// MUTATION: re-export runGate.
test('legacy gate and mutation exports are absent', () => {
  for (const key of ['runGate', 'checkBaseline', 'proveMutations']) assert.equal(Object.hasOwn(checks, key), false)
  assert.ok(CHECK_REASONS.includes('proof-unproven'))
})
