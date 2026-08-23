// B3a: byte-cap boundary measured with NEWLINE-TERMINATED data (B2's stderr
// probe was confounded: an unterminated buffer trips the RESIDUAL cap first).
// B3b: end-to-end CPU burn -- a program child that fills the 4 MiB stream cap
// with tiny non-JSON lines. Every line re-runs boundedTextInfo over the whole
// 50 KiB accumulator (lab.ts appendOutput), on the HOST event loop.
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'

console.log('--- B3a byte cap, newline-terminated ---')
for (const n of [mod.LAB_STREAM_CAP_BYTES - 1, mod.LAB_STREAM_CAP_BYTES, mod.LAB_STREAM_CAP_BYTES + 1]) {
  let lines = 0, overflow = 0
  const c = mod.createStreamCollector({
    capBytes: mod.LAB_STREAM_CAP_BYTES, residualCapBytes: mod.LAB_RESIDUAL_CAP_BYTES, frameQueueMax: mod.LAB_FRAME_QUEUE_MAX,
    onLine: () => { lines += 1; c.served() }, onOverflow: () => { overflow += 1 },
  })
  const buf = Buffer.alloc(n, 0x61); buf[n - 1] = 0x0a
  c.push(buf, 'stderr')
  console.log(`  ${String(n).padStart(8)} B -> bytesSeen=${c.bytesSeen()} overflow=${c.isOverflowed()} (cap ${mod.LAB_STREAM_CAP_BYTES}; expect overflow only at cap+1)`)
}

console.log('--- B3b end-to-end host CPU burn ---')
function fakeChild(pid) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter()
  c.stdin.write = () => true; c.stdin.end = () => {}; c.stdin.destroy = () => {}
  c.stdout.destroy = () => {}; c.stderr.destroy = () => {}
  c.stdout.removeListener = () => {}; c.stderr.removeListener = () => {}
  c.pid = pid; c.kill = () => true; c.unref = () => {}
  return c
}
const holder = mkdtempSync(join(tmpdir(), 'b3-'))
const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
const child = fakeChild(1111)
const tool = mod.createLabTool({
  env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' },
  isDirectory: () => true,
  spawn: () => {
    queueMicrotask(() => {
      // 4 MiB of two-byte non-JSON lines, exactly what the stream cap permits
      const chunk = Buffer.from('x\n'.repeat(32 * 1024))
      for (let i = 0; i < 64; i += 1) child.stdout.emit('data', chunk)
      child.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: 'ok' }) + '\n'))
      child.emit('close', 0, null)
    })
    return child
  },
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
  mkTempDir: () => dir, removeDir: () => {}, realpath: (p) => p,
  writeFile: () => {}, readFile: () => '',
})
const t0 = Date.now()
const out = await tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
console.log(`  4 MiB of "x\\n" from ONE lab child -> ${Date.now() - t0} ms of blocking host CPU; outcome=${out.details.outcome} refused=${out.details.refused}`)
rmSync(holder, { recursive: true, force: true })
