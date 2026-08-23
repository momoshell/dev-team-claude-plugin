#!/usr/bin/env node
// R7 — on Darwin, teardown records a seat root it DID kill as `unproven` /
// root_liveness: 'unknown'. The whole run-end settle of every seat the supervisor
// spawned itself is mis-recorded, and (with R1) the record can never be revisited.
//
// The mechanism, measured below: a group whose only member is an unreaped zombie
// answers kill(-pgid, 0) with EPERM, not ESRCH. seat-io maps EPERM to
// "alive, permission" and then treats a permission answer as UNMEASURED:
//
//   crew/seat-io.mjs:458   if (err?.code === 'EPERM') return { state: LIVENESS.ALIVE, permission: true }
//   crew/seat-io.mjs:613   } else if (afterTerm.state === LIVENESS.UNKNOWN || afterTerm.permission) {
//   crew/seat-io.mjs:614-615   result = { root_settled: 'unproven', ... reason: 'probe-unknown' }
//
// The seat root IS the supervisor's own direct child (headless.mjs spawns the
// worker from the same process that later sweeps), and the sweep's sleeps are
// blocking Atomics.wait (crew/seat-io.mjs:53-56), so the event loop cannot reap it
// for the whole synchronous teardown stack — the file says so itself at :58-60.
// The `rebound` step two lines further down DOES know how to read a `Z` row as a
// death (crew/seat-io.mjs:547), but the EPERM poll short-circuits before it.
//
// ARM A: the root is our own direct child, exactly as production spawns it.
// ARM B (control): the same program, reparented away by a double fork, so it is
//        reaped by launchd rather than by us — the only difference between the arms.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { settleSeatRoots, DESCENDANT_DIR } = await import(join(REPO, 'crew/seat-io.mjs'))

const sab = new SharedArrayBuffer(4)
const blockingSleep = (ms) => Atomics.wait(new Int32Array(sab), 0, 0, ms)  // the sweep's own sleep
const stat = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return String(r.stdout || '').trim() || '(gone)' }
const groupProbe = (pgid) => { try { process.kill(-pgid, 0); return 'ok (reads ALIVE)' } catch (e) { return `${e.code}` } }
const psRow = (pid) => {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && Number(m[1]) === pid) return { pid, ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], start: m[5].trim() }
  }
  return null
}

// ---- the errno measurement this whole finding rests on ----------------------
{
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  kid.unref()
  blockingSleep(600)
  console.log(`measurement: our own child, running   : stat=${stat(kid.pid)} kill(-pgid,0)=${groupProbe(kid.pid)}`)
  process.kill(-kid.pid, 'SIGTERM')
  blockingSleep(400)
  console.log(`measurement: our own child, killed    : stat=${stat(kid.pid)} kill(-pgid,0)=${groupProbe(kid.pid)}  <-- EPERM, not ESRCH`)
}

const arm = async (name, makeRoot) => {
  const root = mkdtempSync(join(tmpdir(), `h1-r7-${name}-`))
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const pid = await makeRoot()
  const row = psRow(pid)
  if (!row) { console.error(`${name}: could not observe the root`); process.exit(2) }
  const dir = join(taskDir, DESCENDANT_DIR)
  mkdirSync(dir, { recursive: true })
  const key = 'headless__d1__seat-1'
  const path = join(dir, `.${key}.active.json`)
  writeFileSync(path, JSON.stringify({
    reservation_id: `record-${key}`, key, phase: 'running', owner: { pid: process.pid, startedAt: Date.now() },
    transport: 'headless-json', role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1',
    marker_owner_pid: process.pid, captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_pid: row.pid, root_pgid: row.pgid, root_start: row.start, groups: [],
    root_settled: null, swept_at: null, sweep_id: null,
  }))
  const journal = []
  const summary = settleSeatRoots({ taskDir, log: (r) => journal.push(r) })
  const settleRow = journal.find((r) => r.event === 'seat-root-settle')
  const after = stat(row.pid)
  console.log(`\n${name}: root pid=${row.pid} ppid=${row.ppid} (ours=${process.pid}) pgid=${row.pgid}`)
  console.log(`   summary      : ${JSON.stringify(summary)}`)
  console.log(`   journal row  : ${JSON.stringify({ root_settled: settleRow?.root_settled, root_liveness: settleRow?.root_liveness, reason: settleRow?.reason })}`)
  console.log(`   ps after     : stat=${after}  (Z or gone == the sweep DID kill it)`)
  try { process.kill(-row.pgid, 'SIGKILL') } catch {}
  rmSync(root, { recursive: true, force: true })
  return { settled: settleRow?.root_settled, dead: after === '(gone)' || after.startsWith('Z') }
}

const a = await arm('ARM-A own-child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  child.unref()
  await new Promise((r) => setTimeout(r, 600))
  return child.pid
})

const b = await arm('ARM-B reparented', async () => {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
    'c.unref()',
    "process.stdout.write(String(c.pid))",
  ].join('; ')
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })   // the middle process exits: grandchild is reparented
  await new Promise((r) => setTimeout(r, 600))
  return Number(String(res.stdout).trim())
})

console.log('')
console.log(`EXPECTED: both arms are the same kill of the same program — both record 'proven'.`)
console.log(`OBSERVED: ARM-A (the production shape, the supervisor's own child) recorded ${JSON.stringify(a.settled)}`)
console.log(`          with the process dead=${a.dead}; ARM-B (reparented, reaped by launchd) recorded`)
console.log(`          ${JSON.stringify(b.settled)} with dead=${b.dead}. The only difference is who reaps the corpse.`)
const reproduced = a.settled === 'unproven' && a.dead === true && b.settled === 'proven'
console.log(reproduced ? 'R7 REPRODUCED — a proven kill recorded as unproven for every seat the supervisor spawned' : 'R7 did not reproduce')
process.exit(reproduced ? 0 : 1)
