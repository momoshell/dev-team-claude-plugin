#!/usr/bin/env node
// R2 — the daemon re-adopts a run by BARE PID. A pid the OS has recycled to an
// unrelated process is adopted as "the child, still working": the run never
// terminates, its concurrency slot and its crew dir stay wedged, and when the
// stranger finally exits the daemon fabricates a death record for it.
//
//   crew/daemon.mjs:1004  appendRecord({ kind: 'started', ..., child_pid })   <-- pid only, no identity
//   crew/daemon.mjs:1212  const alive = processAlive(kill, run.child_pid)
//   crew/daemon.mjs:1213  if (alive === true || alive === null) { run.lifecycle = 'adopted' ... }
//
// The runtime knows how to do this properly ten files away: a descendant record
// binds root_pid + root_pgid + root_start and REFUSES a row whose start string
// disagrees ('root-unidentified', crew/seat-io.mjs:531). The registry records no
// start time at all, so the daemon cannot make that comparison even in principle.
//
// Scratch repo copy, scratch daemon root, and a real unrelated process standing in
// for the recycled pid. The checkout is untouched.

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { daemon } = await import(join(REPO, 'crew/daemon.mjs'))

const root = mkdtempSync('/tmp/h1r2-')            // short: the sun_path limit is 104 bytes
const crewDir = join(root, 'crew')
mkdirSync(join(crewDir, 'returns'), { recursive: true })
writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
  task: 'h1-r2', checkout: root,
  members: { builder: { role: 'builder', transport: 'headless-json' } },
}))
const taskReturn = join(crewDir, 'returns', 'r-1.json')

// The stranger: an unrelated process that happens to hold the pid the dead child
// used to have. This is the exact post-recycle state, expressed directly.
const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
stranger.unref()
await new Promise((r) => setTimeout(r, 400))

const registry = join(root, 'runs.jsonl')
const at = Date.now() - 3_600_000
appendFileSync(registry, `${JSON.stringify({
  kind: 'enqueued', run_id: 'r-1', at, crew_dir: crewDir, task: 'h1-r2',
  brief_file: null, lane: null, suite: 'node --test', checkout: root,
  task_return: taskReturn, attempt: 1,
})}\n`)
appendFileSync(registry, `${JSON.stringify({ kind: 'started', run_id: 'r-1', at: at + 1000, child_pid: stranger.pid })}\n`)
console.log(`registry 'started' record  : {"child_pid":${stranger.pid}}   <- no start time, no pgid, no cmdline`)
console.log(`that pid is really         : an unrelated node process this run never forked`)

const d = daemon({ root, deps: { pollMs: 1_000_000 } })      // no timer noise; poll() is driven by hand
await d.start()
const listed = d.list()
console.log(`after start(): lifecycle   : ${JSON.stringify(listed.runs?.map((r) => ({ run: r.run_id, state: r.state })) ?? listed)}`)
console.log(`registry now contains      : ${readFileSync(registry, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind).join(', ')}`)
console.log(`state({run:'r-1'})         : ${JSON.stringify(d.state({ run: 'r-1' }))}`)

// Consequence 1 — the crew dir is wedged for as long as the stranger lives.
let refusal = null
try { d.enqueue({ crew_dir: crewDir, run_id: 'r-2' }) } catch (err) { refusal = { reason: err.reason, message: err.message } }
console.log(`enqueue of a NEW run       : ${JSON.stringify(refusal)}`)

// Consequence 2 — when the stranger exits, the daemon writes a death record for
// a child that died long ago (or, on a reused pid, never existed at all).
process.kill(stranger.pid, 'SIGKILL')
await new Promise((r) => setTimeout(r, 400))
d.poll()
const envelope = existsSync(taskReturn) ? JSON.parse(readFileSync(taskReturn, 'utf8')) : null
console.log(`envelope the daemon wrote  : ${JSON.stringify(envelope && { status: envelope.status, summary: envelope.summary, escalation: envelope.details?.escalation })}`)
await d.stop()

const adopted = readFileSync(registry, 'utf8').includes('"adopted"')
console.log('')
console.log(`EXPECTED: the daemon cannot identify the pid as its child, so the run is orphaned on restart`)
console.log(`          ('orphaned-on-restart', crew/daemon.mjs:1220) and the crew dir is free.`)
console.log(`OBSERVED: lifecycle 'adopted'=${adopted}; state=${JSON.stringify(d.state ? 'working (above)' : '')}; a new run for that crew dir is refused;`)
console.log(`          and the run's terminal record is a fabricated "the child died" escalation.`)
console.log(adopted ? 'R2 REPRODUCED — an unrelated live pid is adopted as the run child' : 'R2 did not reproduce')
rmSync(root, { recursive: true, force: true })
process.exit(adopted ? 0 : 1)
