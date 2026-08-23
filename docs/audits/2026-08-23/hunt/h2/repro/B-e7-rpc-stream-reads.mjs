// E7: how many bytes does headless-rpc read per poll, and is the un-terminated
// tail bounded?  daemon.mjs:147 caps a frame at MAX_FRAME_BYTES (1 MiB);
// headless-rpc.mjs readFrames (:282-301) has no cap at all.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessRpcIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless-rpc.mjs'

const base = mkdtempSync(join(tmpdir(), 'lensB-e7-'))
const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
writeFileSync(join(paths.taskDir, 'role-builder.md'), '# builder')
writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')
const crew = { checkout: base, members: { builder: { model: 'gpt', transport: 'headless-rpc' } } }

let clock = 0
let bytesRead = 0
let reads = 0
const realRead = readFileSync
const io = headlessRpcIo({
  crew, paths, taskDir: paths.taskDir, checkout: base, adapters: {}, bin: 'pi',
  deps: {
    spawn: () => ({ pid: 4242, unref() {} }),
    openSync: () => 7, writeSync: () => {}, closeSync: () => {},
    now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {},
    uuid: () => 's', pid: 1, log: () => {}, emit: () => {},
    readFileSync: (p, enc) => { const v = realRead(p, enc); reads += 1; bytesRead += (Buffer.isBuffer(v) ? v.length : Buffer.byteLength(String(v))); return v },
  },
})

const stream = join(paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
mkdirSync(join(paths.taskDir, 'headless-rpc', 'builder'), { recursive: true })
// A long-lived seat: 40 MiB of already-written transcript.
const chunk = JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } }) + '\n'
const reps = Math.ceil((20 * 1024 * 1024) / chunk.length)
writeFileSync(stream, chunk.repeat(reps))
console.log('pre-existing stream size:', (statSync(stream).size / 1048576).toFixed(1), 'MiB')

reads = 0; bytesRead = 0
const { id, returnPath } = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
console.log(`assign(${id}): readFileSync calls = ${reads}, bytes read = ${(bytesRead / 1048576).toFixed(1)} MiB  (a stat() would have cost 0)`)

// Now the turn runs: 10 polls before the envelope lands. Each poll re-reads the
// WHOLE file from byte 0 and subarrays off the new tail.
reads = 0; bytesRead = 0
let polls = 0
const fs = await import('node:fs')
const t0 = Date.now()
// let 10 polls happen, then land the envelope
const origSleep = null
for (let i = 0; i < 10; i += 1) appendFileSync(stream, chunk)
// drive the wait: envelope appears only after several polls
let landed = false
const timer = setInterval(() => {}, 1000); clearInterval(timer)
const waitPromise = (() => {
  // synchronous wait: pre-place envelope after N virtual polls via a sleep hook is
  // not reachable from outside, so instead measure ONE poll's read cost directly.
  writeFileSync(returnPath, JSON.stringify({ assignment_id: id, role: 'builder', status: 'done', summary: 's', artifacts: [], details: {} }))
  return io.wait(returnPath, 600)
})()
console.log('wait returned status =', waitPromise.status)
console.log(`one wait() iteration: readFileSync calls = ${reads}, bytes read = ${(bytesRead / 1048576).toFixed(1)} MiB, wall ${Date.now() - t0} ms`)
console.log('=> every 5s poll of a live seat re-reads the ENTIRE transcript from byte 0.')

// --- unbounded un-terminated tail ---------------------------------------------
console.log('\n--- un-terminated tail: no MAX_FRAME_BYTES equivalent ---')
const big = 'z'.repeat(8 * 1024 * 1024)   // 8 MiB with NO trailing newline
appendFileSync(stream, `{"type":"noise","payload":"${big}"`)
reads = 0; bytesRead = 0
let threw = null
try { io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') }) } catch (e) { threw = e.message }
console.log('assign after an 8 MiB un-terminated frame threw:', JSON.stringify(threw))
console.log('daemon.mjs:147 would have raised code="frame-too-large" at 1 MiB; headless-rpc raised nothing.')
