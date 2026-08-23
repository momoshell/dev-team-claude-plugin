// B5: (a) RPC frame split mid-4-byte-emoji across two writes; (b) frame flood at
// LAB_FRAME_QUEUE_MAX, max+1 and far past, through the real tool; (c) does the
// program-child deadline actually fire?
import { EventEmitter } from 'node:events'
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
function build({ drive, deps = {} }) {
  const holder = mkdtempSync(join(tmpdir(), 'b5-'))
  const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
  const child = fakeChild(1111)
  const tool = mod.createLabTool({
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' },
    isDirectory: () => true,
    spawn: () => { queueMicrotask(() => drive(child)); return child },
    spawnSync: () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' }),
    mkTempDir: () => dir, removeDir: () => {}, realpath: () => dir,
    writeFile: () => {}, readFile: () => 'body\n',
    kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e },
    ...deps,
  })
  return { tool, child, cleanup: () => rmSync(holder, { recursive: true, force: true }) }
}

console.log('--- (a) terminal frame split mid-emoji across two writes ---')
{
  const payload = Buffer.from(JSON.stringify({ done: true, result: '💥ok' }) + '\n', 'utf8')
  const cut = payload.indexOf(0xf0) + 2   // inside the 4-byte emoji
  const { tool, cleanup } = build({ drive: (c) => {
    c.stdout.emit('data', payload.subarray(0, cut))
    queueMicrotask(() => { c.stdout.emit('data', payload.subarray(cut)); c.emit('close', 0, null) })
  } })
  const out = await tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  console.log(`  split at byte ${cut} of ${payload.length} -> outcome=${out.details.outcome} result=${JSON.stringify(out.details.result)} (U+FFFD present: ${JSON.stringify(out.details.result).includes('�')})`)
  cleanup()
}
console.log('--- (b) frame flood, nothing served until the host drains ---')
for (const n of [mod.LAB_FRAME_QUEUE_MAX - 1, mod.LAB_FRAME_QUEUE_MAX, mod.LAB_FRAME_QUEUE_MAX + 1, mod.LAB_FRAME_QUEUE_MAX * 20]) {
  const { tool, child, cleanup } = build({ drive: (c) => {
    let buf = ''
    for (let i = 0; i < n; i += 1) buf += JSON.stringify({ id: i + 1, op: 'read', args: ['a.mjs'] }) + '\n'
    c.stdout.emit('data', Buffer.from(buf))   // ONE synchronous chunk: nothing can be served mid-chunk
    queueMicrotask(() => { c.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: 'end' }) + '\n')); c.emit('close', 0, null) })
  } })
  const t0 = Date.now()
  const out = await tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  console.log(`  ${String(n).padStart(6)} unserved frames -> outcome=${out.details.outcome} refused=${String(out.details.refused)} ops served=${out.details.ops.length} kills=${JSON.stringify(child.kills)} ${Date.now() - t0} ms`)
  cleanup()
}
console.log('--- (c) does the program-child deadline fire? ---')
{
  const timers = []
  const { tool, child, cleanup } = build({
    drive: () => { /* the child says nothing, ever */ },
    deps: {
      childTimeoutMs: 12345,
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
      clearTimeout: (t) => { if (t) t.cleared = true },
      kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e },
    },
  })
  const p = tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  await new Promise((r) => setTimeout(r, 30))
  const deadline = timers.find((t) => t.ms === 12345)
  console.log(`  a timer was armed at childTimeoutMs=12345: ${Boolean(deadline)}`)
  deadline.fn()                                     // fire the deadline
  await new Promise((r) => setTimeout(r, 10))
  console.log(`  after firing -> kills=${JSON.stringify(child.kills)} (SIGTERM expected)`)
  const grace = timers.find((t) => t.ms === 2000 && !t.cleared)
  grace?.fn()                                       // fire the SIGKILL grace
  await new Promise((r) => setTimeout(r, 10))
  child.emit('close', null, 'SIGKILL')
  const out = await p
  console.log(`  settled -> outcome=${out.details.outcome} refused=${out.details.refused}`)
  cleanup()
}
