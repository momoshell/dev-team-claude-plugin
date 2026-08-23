// B6: do the remaining lab timeouts actually fire?
//  (a) LAB_OP_TIMEOUT_MS  -> syncGit ETIMEDOUT -> 'op-timeout'
//  (b) LAB_SUITE_TIMEOUT_MS -> suite child SIGTERM -> refusal
//  (c) LAB_REAP_POLLS_MAX -> 'child-unreaped'
import { EventEmitter } from 'node:events'
import { spawnSync as realSpawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'

function fakeChild(pid) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter()
  c.stdin.write = () => true; c.stdin.end = () => {}; c.stdin.destroy = () => {}
  c.stdout.destroy = () => {}; c.stderr.destroy = () => {}
  c.stdout.removeListener = () => {}; c.stderr.removeListener = () => {}
  c.kills = []; c.pid = pid; c.kill = (s) => { c.kills.push(s); return true }; c.unref = () => {}
  return c
}
console.log('--- (a) real spawnSync timeout on a git op ---')
{
  const holder = mkdtempSync(join(tmpdir(), 'b6-')); const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
  const child = fakeChild(1111); const answers = []
  child.stdin.write = (v) => {
    answers.push(JSON.parse(String(v).trim()))
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: null }) + '\n')); child.emit('close', 0, null) })
    return true
  }
  const t0 = Date.now()
  const tool = mod.createLabTool({
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' }, isDirectory: () => true,
    spawn: () => { queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, op: 'scratchCheckout', args: [] }) + '\n'))); return child },
    // a real spawnSync of `sleep 5` with the lab's own opTimeoutMs, shortened to 200 ms
    spawnSync: () => { return realSpawnSync('sleep', ['5'], { timeout: 200, encoding: 'utf8' }) },
    opTimeoutMs: 200, mkTempDir: () => dir, removeDir: () => {}, realpath: () => dir, writeFile: () => {}, readFile: () => 'x',
  })
  const out = await tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  console.log(`  answer=${JSON.stringify(answers[0])} after ${Date.now() - t0} ms  outcome=${out.details.outcome}`)
  rmSync(holder, { recursive: true, force: true })
}
console.log('--- (b) suite timeout fires and SIGTERMs the group ---')
{
  const holder = mkdtempSync(join(tmpdir(), 'b6b-')); const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
  const program = fakeChild(1111); const suite = fakeChild(2222)
  const answers = []; const timers = []
  const killed = []
  program.stdin.write = (v) => {
    answers.push(JSON.parse(String(v).trim()))
    queueMicrotask(() => {
      if (answers.length === 1) program.stdout.emit('data', Buffer.from(JSON.stringify({ id: 2, op: 'runSuite', args: [] }) + '\n'))
      else { program.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: null }) + '\n')); program.emit('close', 0, null) }
    })
    return true
  }
  let calls = 0
  const tool = mod.createLabTool({
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' }, isDirectory: () => true,
    spawn: () => {
      calls += 1
      if (calls === 1) { queueMicrotask(() => program.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, op: 'scratchCheckout', args: [] }) + '\n'))); return program }
      return suite   // never closes: the suite hangs
    },
    spawnSync: () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' }),
    suiteTimeoutMs: 777,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true },
    kill: (pid, sig) => { killed.push([pid, sig]); const e = new Error('gone'); e.code = 'ESRCH'; throw e },
    mkTempDir: () => dir, removeDir: () => {}, realpath: () => dir, writeFile: () => {}, readFile: () => 'x',
  })
  const p = tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  await new Promise((r) => setTimeout(r, 50))
  const st = timers.find((t) => t.ms === 777)
  console.log(`  suite timer armed at 777 ms: ${Boolean(st)}`)
  st.fn()
  await new Promise((r) => setTimeout(r, 50))
  console.log(`  after firing -> kill calls = ${JSON.stringify(killed)}`)
  const out = await p
  console.log(`  settled -> outcome=${out.details.outcome} answers=${JSON.stringify(answers)}`)
  rmSync(holder, { recursive: true, force: true })
}
