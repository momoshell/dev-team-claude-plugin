import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, ciActions, runSuite } from './checks.mjs'
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

test('runSuite serializes opted-in suites across worktrees and processes', { timeout: 30_000 }, async () => {
  const root = scratchDir('checks-suite-lock-')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: GATE_TIMEOUT_MS })
  git('init', '--quiet')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'base')
  const trees = [join(root, 'one'), join(root, 'two')]
  for (const tree of trees) git('worktree', 'add', '--detach', '--quiet', tree, 'HEAD')
  const cases = [[join(root, 'parallel'), 2], [join(root, 'mixed'), 1]]
  for (const [dir] of cases) mkdirSync(dir)
  const marker = (name, dir = root) => join(dir, name)
  const command = `
    const { existsSync, writeFileSync, openSync, closeSync, unlinkSync } = require('node:fs');
    const { join } = require('node:path');
    const [root, name, slots] = process.argv.slice(1);
    const marker = name => join(root, name);
    let owns = false;
    if (slots === undefined) {
      try { closeSync(openSync(marker('active'), 'wx')); owns = true }
      catch (error) { if (error.code !== 'EEXIST') throw error; writeFileSync(marker('overlap'), name) }
    }
    writeFileSync(marker(name + '-entered'), '');
    const deadline = Date.now() + 8000;
    const timer = setInterval(() => {
      if ((name === 'one' || (slots !== undefined && name === 'two')) && !existsSync(marker('release-' + name))) {
        if (Date.now() < deadline) return;
        process.exitCode = 1;
      }
      clearInterval(timer);
      if (owns) unlinkSync(marker('active'));
    }, 10);
  `
  const suspensionMs = 3 * 60 * 60 * 1000
  const runner = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { runSuite } from ${JSON.stringify(new URL('./checks.mjs', import.meta.url).href)};
    const [cwd, root, name, source, slots] = process.argv.slice(1);
    if (name === 'two' && slots === undefined) {
      const now = performance.now.bind(performance);
      Object.defineProperty(performance, 'now', {
        value: () => now() + (existsSync(root + '/release-one') ? ${suspensionMs} : 0),
      });
    }
    writeFileSync(root + '/' + name + '-requested', '');
    const result = await runSuite({ cwd, command: process.execPath, args: ['-e', source, root, name, ...(slots === undefined ? [] : [slots])],
      timeoutMs: 10000, suiteLock: true, lane: name, ...(slots === undefined ? {} : { suiteSlots: Number(slots) }) });
    console.log(JSON.stringify(result));
  `
  const runners = []
  const launch = (i, dir = root, slots) => {
    const args = ['--input-type=module', '-e', runner, trees[i % trees.length], dir, ['one', 'two', 'three'][i], command]
    if (slots !== undefined) args.push(String(slots))
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const done = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
    runners.push({ child, done })
    return done
  }
  const waitFor = async (name, dir = root, ms = GATE_TIMEOUT_MS) => {
    const path = marker(name, dir)
    const deadline = Date.now() + ms
    while (!existsSync(path) && Date.now() < deadline) await sleep(10)
    assert.ok(existsSync(path), `${name} was not reached`)
  }
  const greenResults = async (...runs) => (await Promise.all(runs)).map((run) => {
    assert.equal(run.code, 0, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.status, 'green', run.stdout)
    return result
  })
  try {
    const first = launch(0)
    await waitFor('one-entered')
    const second = launch(1)
    await waitFor('two-requested')
    // Keep the first command gated while the independent runner requests its turn.
    const until = Date.now() + 1000
    while (!existsSync(marker('two-entered')) && Date.now() < until) await sleep(10)
    const overlapped = existsSync(marker('overlap'))
    writeFileSync(marker('release-one'), '')
    const [, contender] = await greenResults(first, second)
    assert.ok(contender.suite_lock_wait_s >= suspensionMs / 1000, 'elapsed queue time includes suspension')
    assert.ok(Math.abs(contender.suite_lock_sleep_credited_s - suspensionMs / 1000) < 2, 'queue credit accounts for suspension')
    assert.equal(contender.sleep_credited_s ?? 0, 0, 'queue credit is separate from suite execution credit')
    assert.equal(overlapped || existsSync(marker('overlap')), false, 'suite commands in sibling worktrees overlapped')
    assert.ok(existsSync(marker('two-entered')), 'the waiting suite eventually ran')

    const legacy = join(root, '.git', 'crew-suite-lock')
    for (const [dir, firstCount] of cases) {
      const one = launch(0, dir, firstCount)
      const pid = runners.at(-1).child.pid
      await waitFor('one-entered', dir)
      const two = launch(1, dir, 2)
      // Fail while the first suite is still gated if the second slot is unusable.
      await waitFor('two-entered', dir, 5000)
      const epochs = readdirSync(legacy).filter((name) => /^[1-9]\d*\.json$/.test(name))
      const record = JSON.parse(readFileSync(join(legacy, `${Math.max(...epochs.map((name) => parseInt(name, 10)))}.json`), 'utf8'))
      assert.equal(record.pid, pid, 'the first runner owns the legacy epoch')
      assert.equal(record.lane, 'one')

      const three = launch(2, dir, 2)
      await waitFor('three-requested', dir)
      await sleep(1000)
      assert.equal(existsSync(marker('three-entered', dir)), false, 'a third suite entered before either holder released')
      writeFileSync(marker('release-one', dir), '')
      await waitFor('three-entered', dir, 5000)
      const [third] = await greenResults(three)
      writeFileSync(marker('release-two', dir), '')
      const holders = await greenResults(one, two)
      assert.deepEqual([...holders, third].map((run) => run.suite_lock_slot), [1, 2, 1])
    }
  } finally {
    for (const dir of [root, ...cases.map(([dir]) => dir)]) {
      for (const name of ['one', 'two']) writeFileSync(marker(`release-${name}`, dir), '')
    }
    await Promise.race([Promise.allSettled(runners.map(({ done }) => done)), sleep(12_000, undefined, { ref: false })])
    for (const { child } of runners) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const tree of trees) git('worktree', 'remove', '--force', tree)
  }
})

test('ciActions.base skips cancelled base runs and reads a stale failure as unknown', async () => {
  // A collapsed base push leaves a superseded run `cancelled`; it must not stand in for the base.
  const row = (databaseId, conclusion) => ({ databaseId, attempt: 1, headBranch: 'main', event: 'push', status: 'completed', conclusion })
  const base = async (rows) => {
    // The fake honours --limit, as gh does.
    const run = async ({ args }) => {
      const limit = Number(args[args.indexOf('--limit') + 1])
      return { status: 'green', code: 0, reason: null, signal: null, timedOut: false, stdout: JSON.stringify(rows.slice(0, limit)), stderr: '' }
    }
    return ciActions({ cwd: '/unused', pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }, { run }).base(5, 'main')
  }
  const green = await base([row(3, 'cancelled'), row(2, 'success'), row(1, 'failure')])
  assert.equal(green.link, 'https://github.com/o/r/actions/runs/2')
  assert.equal(green.failed, false)
  // A failure below a cancelled run may predate a fix on a newer base commit.
  assert.equal(await base([row(3, 'cancelled'), row(2, 'failure')]), null)
  // The newest run itself failing is still a red base.
  assert.equal((await base([row(2, 'failure'), row(1, 'success')])).failed, true)
})
