// B1: runSuite() accumulates the suite child's TAP into a 50 KiB / 2000-line
// bounded buffer (lab.ts appendSuite -> boundedTextInfo, LAB_OUTPUT_CAP_BYTES /
// LAB_OUTPUT_CAP_LINES). The TAP SUMMARY is the LAST thing a run prints, so any
// suite whose TAP exceeds the cap loses its own summary and comes back
// 'suite-failed' -- "the suite produced no parseable TAP summary" -- for a run
// that in fact passed. This is the declared host-authority carve-out.
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'

function fakeChild(pid = 4321) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter()
  c.stdin.write = () => true; c.stdin.end = () => {}; c.stdin.destroy = () => {}
  c.stdout.destroy = () => {}; c.stderr.destroy = () => {}
  c.pid = pid; c.kill = () => true; c.unref = () => {}
  return c
}

// A passing TAP run of `n` tests: n "ok" lines then the summary block.
function tap(n) {
  const body = Array.from({ length: n }, (_, i) => `ok ${i + 1} - test number ${i + 1} in some/suite/file.test.mjs`).join('\n')
  return `TAP version 13\n${body}\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1234\n`
}

async function run(n) {
  const holder = mkdtempSync(join(tmpdir(), 'b1-'))
  const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
  const program = fakeChild(1111)
  let served = 0
  program.stdin.write = (value) => {
    served += 1
    const frame = JSON.parse(String(value).trim())
    queueMicrotask(() => {
      if (served === 1) program.stdout.emit('data', Buffer.from(JSON.stringify({ id: 2, op: 'runSuite', args: [] }) + '\n'))
      else {
        program.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: frame }) + '\n'))
        program.emit('close', 0, null)
      }
    })
    return true
  }
  let calls = 0
  const spawn = () => {
    calls += 1
    if (calls === 1) {
      queueMicrotask(() => program.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, op: 'scratchCheckout', args: [] }) + '\n')))
      return program
    }
    const suite = fakeChild(2222)
    queueMicrotask(() => {
      suite.stdout.emit('data', Buffer.from(tap(n), 'utf8'))
      suite.emit('close', 0, null)
    })
    return suite
  }
  const tool = mod.createLabTool({
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' },
    isDirectory: () => true,
    spawn,
    spawnSync: () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' }),
    mkTempDir: () => dir,
    removeDir: () => {},
    realpath: (p) => p,
    kill: (pid) => { const e = new Error('gone'); e.code = 'ESRCH'; throw e },
    writeFile: () => {},
    readFile: () => '',
  })
  const out = await tool.execute('id', { program: 'x' }, null, null, { cwd: '/tmp' })
  rmSync(holder, { recursive: true, force: true })
  const tapBytes = Buffer.byteLength(tap(n))
  const frame = out.details?.result
  return { n, tapBytes, tapLines: tap(n).split('\n').length, outcome: out.details.outcome, refused: out.details.refused, frame: frame && frame.ok ? JSON.stringify(frame.value) : JSON.stringify(frame) }
}

for (const n of [10, 500, 967, 968, 970, 2000, 5000]) {
  const r = await run(n)
  console.log(`tests=${String(r.n).padStart(5)}  tap=${String(r.tapBytes).padStart(7)}B/${String(r.tapLines).padStart(5)}L  outcome=${r.outcome.padEnd(8)} refused=${String(r.refused).padEnd(12)} runSuite frame -> ${r.frame}`)
}
console.log(`\ncaps: LAB_OUTPUT_CAP_BYTES=${mod.LAB_OUTPUT_CAP_BYTES} LAB_OUTPUT_CAP_LINES=${mod.LAB_OUTPUT_CAP_LINES}`)
