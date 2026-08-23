#!/usr/bin/env node
// R1 — a seat root whose FIRST settle could not be measured is never settled again.
//
// crew/seat-io.mjs:566  `if (record.swept_at != null || record.root_settled != null) continue`
// stamps every settle outcome, including 'unproven' (an UNMEASURED root, :595), and
// nothing anywhere resets root_settled. The run-end sweep (crew/seat-io.mjs:1791)
// stamps first; teardownCore's later settle (crew/crew.mjs:2079) then skips the
// record, and scripts/factory/reap-stale.mjs only calls reclaimDescendants, which
// refuses to touch a LIVE root ('root-alive', crew/seat-io.mjs:729-730). The live seat
// process is out of reach of every sweep the runtime has.
//
// Runs against a scratch `git archive HEAD` copy of the repo and a scratch task
// dir. Touches nothing in the checkout.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { settleSeatRoots, reclaimDescendants, DESCENDANT_DIR } = await import(join(REPO, 'crew/seat-io.mjs'))

const root = mkdtempSync(join(tmpdir(), 'h1-r1-'))
const taskDir = join(root, 'task')
mkdirSync(taskDir, { recursive: true })

const records = () => {
  const dir = join(taskDir, DESCENDANT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.active.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
}
const alive = (pgid) => { try { process.kill(-pgid, 0); return true } catch { return false } }
const psRow = (pid) => {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && Number(m[1]) === pid) return { pid, ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], start: m[5].trim() }
  }
  return null
}

// A real, detached seat root: setsid() makes it its own process group leader.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
child.unref()
await new Promise((r) => setTimeout(r, 600))
const row = psRow(child.pid)
if (!row) { console.error('could not observe the spawned root'); process.exit(2) }
console.log(`root pid=${row.pid} pgid=${row.pgid} start=${JSON.stringify(row.start)} alive=${alive(row.pgid)}`)

const dir = join(taskDir, DESCENDANT_DIR)
mkdirSync(dir, { recursive: true })
const key = 'headless__d1__seat-1'
writeFileSync(join(dir, `.${key}.active.json`), JSON.stringify({
  reservation_id: `record-${key}`, key, phase: 'running',
  owner: { pid: process.pid, startedAt: Date.now() },
  transport: 'headless-json', role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1',
  marker_owner_pid: process.pid, captures: 3, missed_snapshots: 0, discovery_failures: 0,
  root_pid: row.pid, root_pgid: row.pgid, root_start: row.start, groups: [],
  root_settled: null, swept_at: null, sweep_id: null,
}))

// Sweep 1 — the run-end sweep, with ps unavailable for this one call (a timeout,
// a hung ps, a container without procfs). NOTHING is measured, so nothing is killed.
const journal1 = []
const blindSnapshot = () => ({ ok: false, rows: new Map() })
const s1 = settleSeatRoots({ taskDir, log: (r) => journal1.push(r), deps: { snapshot: blindSnapshot, sleep: () => {} } })
console.log(`sweep1 summary   : ${JSON.stringify(s1)}`)
console.log(`sweep1 stamp     : root_settled=${JSON.stringify(records()[0].root_settled)}`)
console.log(`sweep1 root alive: ${alive(row.pgid)}`)

// Sweep 2 — teardownCore's settle, ps working perfectly, the root plainly alive
// and plainly bound (pid+pgid+start all match). This is the sweep whose whole job
// is to kill it.
const journal2 = []
const s2 = settleSeatRoots({ taskDir, log: (r) => journal2.push(r), deps: {} })
console.log(`sweep2 summary   : ${JSON.stringify(s2)}`)
console.log(`sweep2 journal   : ${JSON.stringify(journal2.map((r) => r.event))}`)
console.log(`sweep2 root alive: ${alive(row.pgid)}`)

// Sweep 3 — the standalone stale reaper's only tool.
const journal3 = []
const s3 = reclaimDescendants({ taskDir, log: (r) => journal3.push(r), deps: {} })
const rowLog = journal3.find((r) => r.event === 'descendant-reclaim')
console.log(`reap  outcome    : ${JSON.stringify({ outcome: rowLog?.outcome, reason: rowLog?.reason, root_liveness: rowLog?.root_liveness, root_settled: rowLog?.root_settled })}`)
console.log(`reap  summary    : ${JSON.stringify({ swept: s3.swept, retryable: s3.retryable, live: s3.live, reclaimed: s3.reclaimed })}`)
console.log(`reap  root alive : ${alive(row.pgid)}`)

const leaked = alive(row.pgid)
console.log('')
console.log(`EXPECTED: sweep2 measures the bound, live root and settles it (records>=1, root alive=false).`)
console.log(`OBSERVED: sweep2 records=${s2.records} (it skipped the record on the root_settled stamp); root still alive=${leaked}.`)
console.log(leaked ? 'R1 REPRODUCED — the seat root leaked past every sweep' : 'R1 did not reproduce')
try { process.kill(-row.pgid, 'SIGKILL') } catch {}
rmSync(root, { recursive: true, force: true })
process.exit(leaked ? 0 : 1)
