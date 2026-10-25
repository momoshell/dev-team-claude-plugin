import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, checkBaseline, proveMutations, runGate, runSuite } from './checks.mjs'

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
  assert.equal(CHECK_REASONS.length, 25)
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
  assert.equal(result.reason, 'mutations-survived')
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
  assert.equal(result.reason, 'mutation-unmeasured')
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
