import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, runSuite } from './checks.mjs'
import * as checks from './checks.mjs'

const GATE_TIMEOUT_MS = 10_000
const SHORT_TIMEOUT_MS = 2_500
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
  try {
    result = await node(cwd, source, { timeoutMs: SHORT_TIMEOUT_MS })
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
