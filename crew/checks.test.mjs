import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS, runSuite } from './checks.mjs'

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
  const marker = (name) => join(root, name)
  const command = `
    const { existsSync, writeFileSync, openSync, closeSync, unlinkSync } = require('node:fs');
    const { join } = require('node:path');
    const [root, name] = process.argv.slice(1);
    const marker = name => join(root, name);
    let owns = false;
    try { closeSync(openSync(marker('active'), 'wx')); owns = true }
    catch (error) { if (error.code !== 'EEXIST') throw error; writeFileSync(marker('overlap'), name) }
    writeFileSync(marker(name + '-entered'), '');
    const deadline = Date.now() + 8000;
    const timer = setInterval(() => {
      if (name === 'one' && !existsSync(marker('release-one')) && Date.now() < deadline) return;
      clearInterval(timer);
      if (owns) unlinkSync(marker('active'));
    }, 10);
  `
  const suspensionMs = 3 * 60 * 60 * 1000
  const runner = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { runSuite } from ${JSON.stringify(new URL('./checks.mjs', import.meta.url).href)};
    const [cwd, root, name, source] = process.argv.slice(1);
    if (name === 'two') {
      const now = performance.now.bind(performance);
      Object.defineProperty(performance, 'now', {
        value: () => now() + (existsSync(root + '/release-one') ? ${suspensionMs} : 0),
      });
    }
    writeFileSync(root + '/' + name + '-requested', '');
    const result = await runSuite({ cwd, command: process.execPath, args: ['-e', source, root, name], timeoutMs: 10000, suiteLock: true, lane: name });
    console.log(JSON.stringify(result));
  `
  const runners = []
  const launch = (i) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', runner, trees[i], root, ['one', 'two'][i], command], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  const waitFor = async (name) => {
    const deadline = Date.now() + GATE_TIMEOUT_MS
    while (!existsSync(marker(name)) && Date.now() < deadline) await sleep(10)
    assert.ok(existsSync(marker(name)), `${name} was not reached`)
  }
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
    const completed = await Promise.all([first, second])
    for (const run of completed) {
      assert.equal(run.code, 0, run.stderr)
      assert.equal(JSON.parse(run.stdout).status, 'green', run.stdout)
    }
    const contender = JSON.parse(completed[1].stdout)
    assert.ok(contender.suite_lock_wait_s >= suspensionMs / 1000, 'elapsed queue time includes suspension')
    assert.ok(Math.abs(contender.suite_lock_sleep_credited_s - suspensionMs / 1000) < 2, 'queue credit accounts for suspension')
    assert.equal(contender.sleep_credited_s ?? 0, 0, 'queue credit is separate from suite execution credit')
    assert.equal(overlapped || existsSync(marker('overlap')), false, 'suite commands in sibling worktrees overlapped')
    assert.ok(existsSync(marker('two-entered')), 'the waiting suite eventually ran')
  } finally {
    writeFileSync(marker('release-one'), '')
    await Promise.race([Promise.allSettled(runners.map(({ done }) => done)), sleep(12_000, undefined, { ref: false })])
    for (const { child } of runners) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const tree of trees) git('worktree', 'remove', '--force', tree)
  }
})
