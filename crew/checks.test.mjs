import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, gitResult, scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, checkBaseline, commitChanges, openPullRequest, proveMutations, rebaseBranch, runGate, runSuite } from './checks.mjs'

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
function gateIn(source) {
  const cwd = scratchDir('checks-gate-')
  const gatePath = join(cwd, 'gate.mjs')
  writeFileSync(gatePath, source)
  return { cwd, gatePath, timeoutMs: GATE_TIMEOUT_MS }
}
const failing = (lines, code = 1) => `${lines.map((line) => `console.log(${JSON.stringify(line)})`).join(';')};process.exitCode=${code}`

test('the reason vocabulary is a frozen list of unique tokens', () => {
  assert.ok(Object.isFrozen(CHECK_REASONS))
  assert.equal(new Set(CHECK_REASONS).size, CHECK_REASONS.length)
  assert.equal(CHECK_REASONS.length, 34)
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

test('runGate reads exact deduplicated FAIL ids from ANSI-stripped stdout', async () => {
  const spec = gateIn(failing(['\u001b[31mFAIL A1: rejected\u001b[0m', 'FAIL A1', 'FAIL A10: other', 'FAIL B.2-x_y', 'FAIL A1', 'FAIL', 'FAIL A1 trailing', 'FAIL  A2', ' FAIL A3', 'FAIL a!']))
  const result = await runGate(spec)
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'gate-failed')
  assert.deepEqual(result.failingIds, ['A1', 'A10', 'B.2-x_y'])
  writeFileSync(spec.gatePath, failing(['FAIL A10: only the longer id']))
  assert.deepEqual((await runGate(spec)).failingIds, ['A10'], 'A10 does not claim A1')
  writeFileSync(spec.gatePath, failing(['FAIL A1: rejected']))
  assert.deepEqual((await runGate(spec)).failingIds, ['A1'])
})

test('runGate treats nonzero without a FAIL line as red gate-no-fail', async () => {
  const result = await runGate(gateIn("console.error('crashed'); process.exitCode = 2"))
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'gate-no-fail')
  assert.deepEqual(result.failingIds, [])
  assert.equal(result.code, 2)
})

test('runGate treats only a clean exit 0 as green', async () => {
  const result = await runGate(gateIn('process.exitCode = 0'))
  assert.equal(result.status, 'green')
  assert.equal(reasonOf(result), null)
  assert.deepEqual(result.failingIds, [])
})

test('runGate rejects exit 0 with FAIL lines as gate-inconsistent', async () => {
  const result = await runGate(gateIn(failing(['FAIL A1: contradictory'], 0)))
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'gate-inconsistent')
  assert.deepEqual(result.failingIds, ['A1'])
})

test('runGate ignores stderr as the gate protocol', async () => {
  const result = await runGate(gateIn("console.error('FAIL A1: diagnostic only'); process.exitCode = 2"))
  assert.deepEqual(result.failingIds, [])
  assert.equal(reasonOf(result), 'gate-no-fail')
  assert.match(result.stderr, /FAIL A1/)
})

test('runGate reports a missing gate, a hung gate and invalid input as non-green', async () => {
  const spec = gateIn('process.exitCode = 0')
  const missing = await runGate({ ...spec, gatePath: join(spec.cwd, 'missing.mjs') })
  assert.notEqual(missing.status, 'green')
  assert.equal(reasonOf(missing), 'gate-no-fail')
  const hung = gateIn("console.log('FAIL A1: then hangs'); setInterval(() => {}, 1000)")
  const timedOut = await runGate({ ...hung, timeoutMs: SHORT_TIMEOUT_MS })
  assert.equal(timedOut.status, 'unmeasured')
  assert.equal(reasonOf(timedOut), 'timeout')
  assert.deepEqual(timedOut.failingIds, ['A1'], 'ids are diagnostic only on an unmeasured run')
  for (const bad of [{ ...spec, timeoutMs: 0 }, { ...spec, cwd: '' }, { ...spec, gatePath: 7 }, undefined]) {
    const result = await runGate(bad)
    assert.equal(result.status, 'unmeasured')
    assert.equal(reasonOf(result), 'invalid-input')
    assert.deepEqual(result.failingIds, [])
  }
})

test('runGate resolves a relative gate path and defaults to task/gate.mjs under cwd', async () => {
  const cwd = scratchDir('checks-gate-')
  writeFileSync(join(cwd, 'rel.mjs'), failing(['FAIL R1']))
  assert.deepEqual((await runGate({ cwd, gatePath: 'rel.mjs', timeoutMs: GATE_TIMEOUT_MS })).failingIds, ['R1'])
  mkdirSync(join(cwd, 'task'))
  writeFileSync(join(cwd, 'task', 'gate.mjs'), failing(['FAIL D1']))
  assert.deepEqual((await runGate({ cwd, timeoutMs: GATE_TIMEOUT_MS })).failingIds, ['D1'])
})

test('runGate validates an optional GATE-SUMMARY but never requires one', async () => {
  const summary = (total, failed, errored) => `GATE-SUMMARY ${JSON.stringify({ total, failed, errored })}`
  const ok = await runGate(gateIn(failing(['FAIL A1', summary(2, 1, 0)])))
  assert.equal(reasonOf(ok), 'gate-failed')
  assert.equal((await runGate(gateIn(failing([summary(2, 0, 0)], 0)))).status, 'green')
  const bad = [
    failing(['FAIL A1', summary(2, 1, 1)]),
    failing(['FAIL A1', 'GATE-SUMMARY {nope']),
    failing(['FAIL A1', summary(2, 0, 0)]),
    failing(['FAIL A1', summary(1, 2, 0)]),
    failing(['FAIL A1', summary(2, 1, 0), summary(2, 1, 0)]),
    failing([summary(2, 1, 0)], 0),
    failing(['FAIL A1', 'FAIL A2', summary(2, 1, 0)]),
    failing(['GATE-SUMMARY null', 'FAIL A1']),
    failing(['FAIL A1', summary(2, 2, 0)]),
  ]
  for (const source of bad) {
    const result = await runGate(gateIn(source))
    assert.equal(result.status, 'red', source)
    assert.equal(reasonOf(result), 'gate-invalid', source)
  }
})

test('checkBaseline accepts only a completed nonzero gate that names a failing check', async () => {
  const red = await checkBaseline(gateIn(failing(['FAIL A1: baseline'])))
  assert.equal(red.accepted, true)
  assert.equal(red.reason, 'gate-failed')
  assert.deepEqual(red.result.failingIds, ['A1'])
})

test('checkBaseline refuses a green pre-build baseline', async () => {
  const result = await checkBaseline(gateIn('process.exitCode = 0'))
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'baseline-green')
  assert.equal(result.result.status, 'green')
})

test('checkBaseline refuses a broken, inconsistent or unmeasured red', async () => {
  const cases = [
    ['process.exitCode = 1', 'baseline-invalid'],
    [failing(['FAIL A1'], 0), 'baseline-invalid'],
    [failing(['FAIL A1', 'GATE-SUMMARY {"total":1,"failed":1,"errored":1}']), 'baseline-invalid'],
  ]
  for (const [source, reason] of cases) {
    const result = await checkBaseline(gateIn(source))
    assert.equal(result.accepted, false, source)
    assert.equal(result.reason, reason, source)
  }
  const hung = await checkBaseline({ ...gateIn("console.log('FAIL A1'); setInterval(() => {}, 1000)"), timeoutMs: SHORT_TIMEOUT_MS })
  assert.equal(hung.accepted, false)
  assert.equal(hung.reason, 'baseline-unmeasured')
  assert.equal((await checkBaseline(undefined)).reason, 'baseline-unmeasured')
})

const A1 = { check: 'A1', file: 'target.txt', find: 'alpha', replace: 'beta' }
const GREEN_RESULT = { status: 'green', reason: null, code: 0, signal: null, timedOut: false, failingIds: [] }
const redResult = (...failingIds) => ({ status: 'red', reason: 'gate-failed', code: 1, signal: null, timedOut: false, failingIds })
const CAUGHT_GATE = "import {readFileSync} from 'node:fs'; if (readFileSync('target.txt','utf8').includes('beta')) { console.log('FAIL A1: beta'); process.exitCode = 1 }"

function repo(files = { 'target.txt': 'alpha\n' }) {
  const cwd = scratchDir('checks-proof-')
  execFileSync('git', ['init', '-q', cwd])
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  return cwd
}
const realSpec = (cwd, gate, extra = {}) => {
  writeFileSync(join(cwd, 'gate.mjs'), gate)
  return { cwd, gatePath: join(cwd, 'gate.mjs'), checks: ['A1'], mutations: [A1], timeoutMs: GATE_TIMEOUT_MS, ...extra }
}
// The first call is the green preflight; later calls run `onMutant` against the mutated checkout.
function fakeGate(cwd, onMutant) {
  const calls = []
  const runGate = async (spec) => {
    calls.push(spec)
    return calls.length === 1 ? GREEN_RESULT : onMutant(calls.length - 1, spec)
  }
  return { calls, deps: { runGate }, spec: { cwd, checks: ['A1'], mutations: [A1], timeoutMs: GATE_TIMEOUT_MS } }
}
function readTree(root, dir = root, into = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = join(dir, entry.name)
    const rel = full.slice(root.length + 1)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) into[rel] = `link:${readlinkSync(full)}`
    else if (st.isDirectory()) readTree(root, full, into)
    else into[rel] = `file:${(st.mode & 0o7777).toString(8)}:${readFileSync(full).toString('hex')}`
  }
  return into
}
const rowOf = (result) => {
  for (const row of result.rows) assert.ok(['killed', 'survived', 'unmeasured'].includes(row.outcome))
  return result.rows[0]
}

test('proveMutations kills a mutant its own check catches and restores the target', async () => {
  const cwd = repo()
  const result = await proveMutations(realSpec(cwd, CAUGHT_GATE))
  assert.equal(result.status, 'green')
  assert.equal(result.reason, null)
  assert.deepEqual(result.rows.map((row) => [row.check, row.outcome, row.reason]), [['A1', 'killed', null]])
  assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'alpha\n')
})

test('proveMutations reports a mutant the gate never notices as survived under its own id', async () => {
  const cwd = repo()
  const result = await proveMutations(realSpec(cwd, 'process.exitCode = 0'))
  assert.equal(result.status, 'red')
  assert.equal(reasonOf(result), 'mutations-survived')
  assert.deepEqual(result.rows.map((row) => [row.check, row.outcome, row.reason]), [['A1', 'survived', 'gate-green']])
  assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'alpha\n')
})

test('proveMutations does not let FAIL A10 kill A1', async () => {
  const cwd = repo()
  const result = await proveMutations(realSpec(cwd, CAUGHT_GATE.replace('FAIL A1:', 'FAIL A10:')))
  assert.equal(rowOf(result).outcome, 'survived')
  assert.equal(rowOf(result).reason, 'target-not-failed')
  assert.equal(result.status, 'red')
})

test('proveMutations keeps a mutant that printed FAIL then timed out unmeasured and restores everything', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', 'data.bin': Buffer.from([0, 255, 254, 10]) })
  const gate = "import {readFileSync, writeFileSync} from 'node:fs'; if (readFileSync('target.txt','utf8').includes('beta')) { writeFileSync('extra.txt','x'); writeFileSync('data.bin', Buffer.from([9, 9])); console.log('FAIL A1: then hangs'); setInterval(() => {}, 1000) }"
  const spec = realSpec(cwd, gate, { timeoutMs: SHORT_TIMEOUT_MS })
  const before = readTree(cwd)
  const result = await proveMutations(spec)
  assert.equal(rowOf(result).outcome, 'unmeasured')
  assert.equal(rowOf(result).reason, 'timeout')
  assert.deepEqual(rowOf(result).result.failingIds, ['A1'])
  assert.equal(result.status, 'unmeasured')
  assert.equal(reasonOf(result), 'mutation-unmeasured')
  assert.deepEqual(readTree(cwd), before)
})

test('proveMutations refuses a red or failing preflight before any mutation is applied', async () => {
  for (const preflight of [redResult('A1'), { ...GREEN_RESULT, status: 'unmeasured', reason: 'timeout', timedOut: true }, 'throw']) {
    const cwd = repo()
    const calls = []
    const runGate = async (spec) => { calls.push(spec); if (preflight === 'throw') throw new Error('boom'); return preflight }
    const result = await proveMutations({ cwd, checks: ['A1'], mutations: [A1], timeoutMs: GATE_TIMEOUT_MS }, { runGate })
    assert.equal(result.reason, 'preproof-not-green')
    assert.equal(result.status, preflight.status === 'red' ? 'red' : 'unmeasured')
    assert.deepEqual(result.rows, [])
    assert.equal(calls.length, 1)
    assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'alpha\n')
  }
  const cwd = repo()
  const real = await proveMutations(realSpec(cwd, "console.log('FAIL A1: always red'); process.exitCode = 1"))
  assert.equal(real.reason, 'preproof-not-green')
  assert.deepEqual(real.rows, [])
})

test('proveMutations hands the caller timeout, unchanged, to both the preflight and every mutant run', async () => {
  const cwd = repo()
  const tight = 1_234
  const gate = fakeGate(cwd, () => redResult('A1'))
  const result = await proveMutations({ ...gate.spec, timeoutMs: tight }, gate.deps)
  assert.equal(result.status, 'green')
  assert.deepEqual(gate.calls.map((call) => call.timeoutMs), [tight, tight])
})

test('proveMutations returns preproof-not-green with no rows and no mutation when the preflight times out', async () => {
  const cwd = repo()
  const calls = []
  const timedOut = { ...GREEN_RESULT, status: 'unmeasured', reason: 'timeout', timedOut: true }
  const runGate = async (spec) => { calls.push(spec); return timedOut }
  const result = await proveMutations({ cwd, checks: ['A1'], mutations: [A1], timeoutMs: 1_234 }, { runGate })
  assert.equal(result.status, 'unmeasured')
  assert.equal(result.reason, 'preproof-not-green')
  assert.deepEqual(result.rows, [])
  assert.deepEqual(calls.map((call) => call.timeoutMs), [1_234])
  assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'alpha\n')
})

test('proveMutations refuses missing, extra, duplicate and malformed declarations before running anything', async () => {
  const cwd = repo()
  const A2 = { ...A1, check: 'A2' }
  const cases = [
    { checks: ['A1'], mutations: [] },
    { checks: ['A1', 'A2'], mutations: [A1] },
    { checks: ['A1'], mutations: [A1, A2] },
    { checks: ['A1'], mutations: [A2] },
    { checks: ['A1'], mutations: [A1, A1] },
    { checks: ['A1', 'A1'], mutations: [A1, A1] },
    { checks: ['A1', 'A2'], mutations: [A1, A1] },
    { checks: [], mutations: [] },
    { checks: 'A1', mutations: [A1] },
    { checks: ['bad id'], mutations: [{ ...A1, check: 'bad id' }] },
    { checks: ['A1'], mutations: [{ ...A1, find: '' }] },
    { checks: ['A1'], mutations: [{ ...A1, replace: 'alpha' }] },
    { checks: ['A1'], mutations: [{ ...A1, extra: 'x' }] },
    { checks: ['A1'], mutations: [{ check: 'A1', file: 'target.txt', find: 'alpha' }] },
    { checks: ['A1'], mutations: [{ ...A1, replace: 7 }] },
    { checks: ['A1'], mutations: [null] },
    { checks: ['A1'], mutations: [[A1]] },
  ]
  for (const spec of cases) {
    const calls = []
    const result = await proveMutations({ cwd, ...spec, timeoutMs: GATE_TIMEOUT_MS }, { runGate: async () => { calls.push(1); return GREEN_RESULT } })
    assert.equal(result.status, 'red', JSON.stringify(spec))
    assert.equal(result.reason, 'invalid-mutations', JSON.stringify(spec))
    assert.deepEqual(result.rows, [])
    assert.equal(calls.length, 0, 'no gate run for an invalid declaration list')
  }
  const bad = [{ cwd: '', checks: ['A1'], mutations: [A1] }, { cwd, checks: ['A1'], mutations: [A1], timeoutMs: 0 }, { cwd, gatePath: 5, checks: ['A1'], mutations: [A1] }]
  for (const spec of bad) assert.equal((await proveMutations(spec)).reason, 'invalid-input')
  assert.equal((await proveMutations()).reason, 'invalid-input')
})

test('proveMutations binds only on exactly one occurrence, counting overlaps', async () => {
  for (const [content, find, occurrences] of [['alpha\n', 'gamma', 0], ['alpha alpha\n', 'alpha', 2], ['aaa\n', 'aa', 2]]) {
    const cwd = repo({ 'target.txt': content })
    const gate = fakeGate(cwd, () => assert.fail('an unbound mutation must never run the gate'))
    const result = await proveMutations({ ...gate.spec, mutations: [{ ...A1, find }] }, gate.deps)
    assert.equal(rowOf(result).outcome, 'unmeasured')
    assert.equal(rowOf(result).reason, 'bind-fail')
    assert.equal(rowOf(result).occurrences, occurrences)
    assert.equal(result.reason, 'mutation-unmeasured')
    assert.equal(gate.calls.length, 1)
    assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), content)
  }
})

test('proveMutations splices only the matched bytes and leaves surrounding non-UTF-8 bytes identical', async () => {
  const original = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('alpha'), Buffer.from([0xc3, 0x28, 0x80])])
  const cwd = repo({ 'target.txt': original })
  let seen
  const gate = fakeGate(cwd, (n, spec) => { seen = readFileSync(join(spec.cwd, 'target.txt')); return redResult('A1') })
  const result = await proveMutations(gate.spec, gate.deps)
  assert.deepEqual(seen, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('beta'), Buffer.from([0xc3, 0x28, 0x80])]))
  assert.equal(rowOf(result).outcome, 'killed')
  assert.deepEqual(readFileSync(join(cwd, 'target.txt')), original)
})

test('proveMutations refuses targets that escape, are links or are absent', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'alpha\n', 'real/f.txt': 'alpha\n' })
  const outside = scratchDir('checks-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'alpha\n')
  symlinkSync('target.txt', join(cwd, 'leaf-link'))
  symlinkSync('real', join(cwd, 'alias'))
  symlinkSync(join(outside, 'secret.txt'), join(cwd, 'out-link'))
  const files = ['../secret.txt', join(outside, 'secret.txt'), '.git/config', 'a\\b', 'a//b', './target.txt', 'real/../target.txt', 'a\0b', '', 'leaf-link', 'out-link', 'alias/f.txt', 'missing.txt', 'real']
  for (const file of files) {
    const gate = fakeGate(cwd, () => assert.fail(`${file} must not reach the gate`))
    const result = await proveMutations({ ...gate.spec, mutations: [{ ...A1, file }] }, gate.deps)
    assert.equal(rowOf(result).outcome, 'unmeasured', file)
    assert.equal(rowOf(result).reason, 'unsafe-target', file)
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'alpha\n')
  assert.equal(readFileSync(join(cwd, 'ignored.txt'), 'utf8'), 'alpha\n')
})

// MUTATION: run the mutant gate in the checkout itself and every write below lands there.
test('proveMutations runs each mutant in a removed copy and leaves the checkout untouched after every outcome', async () => {
  const variants = {
    green: () => GREEN_RESULT,
    killed: () => redResult('A1'),
    timeout: () => ({ status: 'unmeasured', reason: 'timeout', code: null, signal: 'SIGTERM', timedOut: true, failingIds: ['A1'] }),
    throws: () => { throw new Error('runner interrupted') },
  }
  for (const [name, outcome] of Object.entries(variants)) {
    const cwd = repo({ 'target.txt': 'alpha\n', 'bin/data.bin': Buffer.from([0, 255, 254, 10]), 'run.sh': '#!/bin/sh\n', 'doomed.txt': 'delete me', 'dir/nested/file.txt': 'nested', '.gitignore': 'generated/\n', 'generated/cache.json': '{}' })
    chmodSync(join(cwd, 'run.sh'), 0o755)
    symlinkSync('target.txt', join(cwd, 'link'))
    const before = readTree(cwd)
    const copies = []
    const gate = fakeGate(cwd, (n, spec) => {
      const at = spec.cwd
      copies.push(at)
      assert.notEqual(at, cwd)
      assert.equal(readFileSync(join(at, 'target.txt'), 'utf8'), 'beta\n')
      writeFileSync(join(at, 'bin/data.bin'), Buffer.from([0, 254, 255, 10]))
      writeFileSync(join(at, 'generated/cache.json'), '{"rewritten":true}')
      mkdirSync(join(at, 'empty/dir'), { recursive: true })
      writeFileSync(join(at, 'extra.txt'), 'side effect')
      rmSync(join(at, 'doomed.txt'))
      chmodSync(join(at, 'run.sh'), 0o644)
      rmSync(join(at, 'link'))
      rmSync(join(at, 'dir'), { recursive: true })
      return outcome()
    })
    const result = await proveMutations(gate.spec, gate.deps)
    assert.equal(rowOf(result).outcome, name === 'killed' ? 'killed' : name === 'green' ? 'survived' : 'unmeasured', name)
    assert.equal(rowOf(result).reason, { green: 'gate-green', killed: null, timeout: 'timeout', throws: 'runner-threw' }[name])
    assert.deepEqual(readTree(cwd), before, name)
    assert.equal(copies.length, 1, name)
    assert.equal(existsSync(copies[0]), false, `${name}: the copy is removed`)
  }
})
test('proveMutations turns a runner throw into unmeasured runner-threw with the error kept', async () => {
  const cwd = repo()
  const gate = fakeGate(cwd, () => { throw new Error('runner interrupted') })
  const result = await proveMutations(gate.spec, gate.deps)
  assert.equal(rowOf(result).reason, 'runner-threw')
  assert.equal(rowOf(result).error.message, 'runner interrupted')
  assert.equal(result.status, 'unmeasured')
})

test('proveMutations never credits a kill from a timed out, signalled, incomplete or malformed gate', async () => {
  const cases = [
    [{ ...redResult('A1'), timedOut: true }, 'unmeasured', 'mutation-unmeasured'],
    [{ ...redResult('A1'), signal: 'SIGTERM' }, 'unmeasured', 'mutation-unmeasured'],
    [{ ...redResult('A1'), code: null }, 'unmeasured', 'mutation-unmeasured'],
    [{ ...redResult('A1'), reason: 'gate-no-fail' }, 'unmeasured', 'gate-no-fail'],
    [{ ...redResult('A1'), reason: 'gate-invalid' }, 'unmeasured', 'gate-invalid'],
    [{ ...redResult('A1'), reason: 'gate-inconsistent' }, 'unmeasured', 'gate-inconsistent'],
    [{ status: 'unmeasured', reason: 'spawn-error', failingIds: ['A1'] }, 'unmeasured', 'spawn-error'],
    [{ status: 'unmeasured', reason: 'timeout', failingIds: ['A1'] }, 'unmeasured', 'timeout'],
    [{ ...redResult('A1'), failingIds: 'A1' }, 'unmeasured', 'mutation-unmeasured'],
    [undefined, 'unmeasured', 'gate-invalid'],
    [redResult('A10', 'B1'), 'survived', 'target-not-failed'],
    [redResult('A1', 'A10'), 'killed', null],
  ]
  for (const [gateResult, outcome, reason] of cases) {
    const gate = fakeGate(repo(), () => gateResult)
    const result = await proveMutations(gate.spec, gate.deps)
    assert.equal(rowOf(result).outcome, outcome, JSON.stringify(gateResult))
    assert.equal(rowOf(result).reason, reason, JSON.stringify(gateResult))
    assert.equal(result.status === 'green', outcome === 'killed')
  }
})

test('proveMutations proves every check in order and reports an overall status from measured rows only', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', 'other.txt': 'one\n' })
  const B1 = { check: 'B1', file: 'other.txt', find: 'one', replace: 'two' }
  const gate = fakeGate(cwd, (n) => (n === 1 ? redResult('A1') : n === 2 ? GREEN_RESULT : redResult('C1')))
  const spec = { ...gate.spec, checks: ['A1', 'B1', 'C1'], mutations: [{ ...A1, check: 'C1' }, B1, A1] }
  const result = await proveMutations(spec, gate.deps)
  assert.deepEqual(result.rows.map((row) => [row.check, row.outcome]), [['A1', 'killed'], ['B1', 'survived'], ['C1', 'killed']])
  assert.equal(result.status, 'red')
  assert.equal(result.reason, 'mutations-survived')
  const all = fakeGate(cwd, () => redResult('A1', 'B1'))
  const killedAll = await proveMutations({ ...all.spec, checks: ['A1', 'B1'], mutations: [A1, B1] }, all.deps)
  assert.equal(killedAll.status, 'green')
  assert.equal(killedAll.reason, null)
  assert.equal(killedAll.rows.length, 2)
})

test('proveMutations accepts check ids that start with or contain any digit and the grammar punctuation', async () => {
  const ids = ['9z', 'Z8.b_c-7']
  const gate = fakeGate(repo(), (n) => redResult(ids[n - 1]))
  const result = await proveMutations({ ...gate.spec, checks: ids, mutations: ids.map((check) => ({ ...A1, check })) }, gate.deps)
  assert.equal(result.reason, null)
  assert.deepEqual(result.rows.map((row) => [row.check, row.outcome]), [['9z', 'killed'], ['Z8.b_c-7', 'killed']])
})

// MUTATION: snapshot only after the preflight and its tracked write survives the proof.
test('proveMutations undoes what the green preflight writes to a tracked file', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', 'other.txt': 'one\n' })
  execFileSync('git', ['-C', cwd, 'add', '.'])
  const gate = CAUGHT_GATE + "; import {writeFileSync as w} from 'node:fs'; if (!readFileSync('target.txt','utf8').includes('beta')) w('other.txt', 'rewritten by preflight\\n')"
  const result = await proveMutations(realSpec(cwd, gate))
  assert.equal(readFileSync(join(cwd, 'other.txt'), 'utf8'), 'one\n')
  assert.equal(result.status, 'green')
})

// MUTATION: run the gate in the checkout and the ignored writes and the empty directory stay behind.
test('proveMutations leaves no ignored file, rewritten ignored file or empty directory from a mutant gate', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', 'other.txt': 'one\n', '.gitignore': 'generated/\nscratch/\n', 'generated/cache.json': '{}' })
  const gate = CAUGHT_GATE + "; import {mkdirSync as m, writeFileSync as w} from 'node:fs'; if (readFileSync('target.txt','utf8').includes('beta')) { w('generated/cache.json', 'mutant'); m('scratch', { recursive: true }); w('scratch/new.json', '{}'); m('empty/dir', { recursive: true }) }"
  const spec = realSpec(cwd, gate, { checks: ['A1', 'A2'], mutations: [A1, { check: 'A2', file: 'other.txt', find: 'one', replace: 'two' }] })
  const before = readTree(cwd)
  const result = await proveMutations(spec)
  assert.deepEqual(readTree(cwd), before)
  assert.equal(existsSync(join(cwd, 'empty')), false, 'the empty directory stayed in the copy')
  assert.equal(existsSync(join(cwd, 'scratch')), false)
  assert.equal(rowOf(result).outcome, 'killed')
})

// MUTATION: let a copy failure fall through to the gate and a proof runs in the checkout.
test('proveMutations refuses with copy-failed when a copy cannot be made, and never runs the gate there', async () => {
  const cwd = repo()
  const failing = fakeGate(cwd, () => assert.fail('no mutant without a copy'))
  const refused = await proveMutations(failing.spec, { ...failing.deps, copyTree: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) } })
  assert.equal(refused.status, 'unmeasured')
  assert.equal(refused.reason, 'copy-failed')
  assert.equal(refused.error.code, 'ENOSPC')
  assert.equal(failing.calls.length, 0, 'not even the preflight runs')
  let copiesMade = 0
  const later = fakeGate(cwd, () => assert.fail('no mutant without a copy'))
  const copyTree = (dir) => {
    if (++copiesMade > 1) throw new Error('second copy failed')
    const copy = scratchDir('checks-copy-')
    cpSync(dir, copy, { recursive: true })
    return copy
  }
  const result = await proveMutations(later.spec, { ...later.deps, copyTree })
  assert.equal(rowOf(result).reason, 'copy-failed')
  assert.equal(result.reason, 'mutation-unmeasured')
})
// MUTATION: share one copy between proofs and two proofs of one checkout see each other's mutants.
test('two proofs of the same checkout at once each measure their own mutant', async () => {
  const cwd = repo()
  const [first, second] = await Promise.all([
    proveMutations(realSpec(cwd, CAUGHT_GATE)),
    proveMutations({ cwd, gatePath: join(cwd, 'gate.mjs'), checks: ['A1'], mutations: [A1], timeoutMs: GATE_TIMEOUT_MS }),
  ])
  assert.equal(first.status, 'green')
  assert.equal(second.status, 'green')
  assert.equal(readFileSync(join(cwd, 'target.txt'), 'utf8'), 'alpha\n')
})

// MUTATION: run a gate inside the checkout from the original and it imports the unmutated module.
test('a gate inside the checkout runs from the copy, so its imports see the mutant', async () => {
  const cwd = repo({ 'lib.mjs': "export const word = 'alpha'\n" })
  const gate = "import { word } from './lib.mjs'; if (word !== 'alpha') { console.log('FAIL A1: word changed'); process.exitCode = 1 }"
  const result = await proveMutations(realSpec(cwd, gate, { mutations: [{ check: 'A1', file: 'lib.mjs', find: 'alpha', replace: 'beta' }] }))
  assert.equal(rowOf(result).outcome, 'killed')
})

// MUTATION: drop the checkout fingerprint and a gate writing through a symlink into the checkout is credited.
test('a gate that writes through a symlink back into the checkout is never credited', async () => {
  const cwd = repo({ 'target.txt': 'alpha\n', 'other.txt': 'one\n' })
  symlinkSync(cwd, join(cwd, 'home'))
  const gate = CAUGHT_GATE + "; import {writeFileSync as w} from 'node:fs'; if (readFileSync('target.txt','utf8').includes('beta')) w('home/other.txt', 'escaped')"
  const result = await proveMutations(realSpec(cwd, gate))
  assert.equal(rowOf(result).outcome, 'unmeasured')
  assert.equal(rowOf(result).reason, 'checkout-changed')
  assert.notEqual(result.status, 'green')
})

// MUTATION: let the copy removal throw and the proof rejects with no closed reason.
test('a copy that cannot be removed is unmeasured cleanup-unproven, not a thrown proof', async () => {
  const cwd = repo()
  const copies = []
  const gate = fakeGate(cwd, (n, spec) => {
    mkdirSync(join(spec.cwd, 'locked/inner'), { recursive: true })
    writeFileSync(join(spec.cwd, 'locked/inner/f'), 'x')
    chmodSync(join(spec.cwd, 'locked'), 0o500)
    copies.push(spec.cwd)
    return redResult('A1')
  })
  try {
    const result = await proveMutations(gate.spec, gate.deps)
    assert.equal(rowOf(result).reason, 'cleanup-unproven')
    assert.equal(result.reason, 'mutation-unmeasured')
  } finally {
    for (const copy of copies) { try { chmodSync(join(copy, 'locked'), 0o700) } catch {} rmSync(copy, { recursive: true, force: true }) }
  }
})


// Lane publication: real git in scratch repositories for commit and rebase, scripted transcripts for gh and the remote.
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
function fakeRemote({ remote = OTHER_SHA, prs = [], push = 'lands', create = 'lands', list, lsRemote, head = SHA, branch = 'lane' } = {}) {
  const calls = []
  const state = { remote, prs: [...prs], listed: 0, lsed: 0 }
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
      if (create.startsWith('lands')) state.prs.push(prRecord(18))
      return create.endsWith('fails') ? FAKE_BAD : FAKE_OK('https://github.com/o/r/pull/18\n')
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
