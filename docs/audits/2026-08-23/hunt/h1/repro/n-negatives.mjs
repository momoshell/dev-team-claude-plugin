#!/usr/bin/env node
// NEGATIVE RESULTS — attacks that the code SURVIVED. Recorded so the next hunt
// does not re-run them. Same scratch discipline as the R-series.
//
// N1  socket disconnect delivered mid tail-replay (real unix socket, real client
//     destroyed while the daemon is writing the backlog)
// N2  the descendant sweep pointed at a REUSED pid (right pid, wrong start time)
// N3  the whole teardown settle run TWICE against one seat record

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { daemon } = await import(join(REPO, 'crew/daemon.mjs'))
const { settleSeatRoots, reclaimDescendants, DESCENDANT_DIR } = await import(join(REPO, 'crew/seat-io.mjs'))

const alive = (pgid) => { try { process.kill(-pgid, 0); return true } catch { return false } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const psRow = (pid) => {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && Number(m[1]) === pid) return { pid, pgid: Number(m[3]), stat: m[4], start: m[5].trim() }
  }
  return null
}
const writeRecord = (taskDir, overrides) => {
  const dir = join(taskDir, DESCENDANT_DIR)
  mkdirSync(dir, { recursive: true })
  const key = 'headless__d1__seat-1'
  writeFileSync(join(dir, `.${key}.active.json`), JSON.stringify({
    reservation_id: `record-${key}`, key, phase: 'running',
    owner: { pid: process.pid, startedAt: Date.now() },
    transport: 'headless-json', role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1',
    marker_owner_pid: process.pid, captures: 3, missed_snapshots: 0, discovery_failures: 0,
    groups: [], root_settled: null, swept_at: null, sweep_id: null, ...overrides,
  }))
  return () => JSON.parse(readFileSync(join(dir, `.${key}.active.json`), 'utf8'))
}

// ---------------- N1: disconnect during tail replay --------------------------
{
  const root = mkdtempSync('/tmp/h1n1-')
  const crewDir = join(root, 'crew')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'n1', checkout: root, members: { builder: { transport: 'headless-json' } } }))
  // 4000 journal rows -> 4000 feed events, so the replay is a long synchronous
  // write loop the client can be destroyed in the middle of.
  appendFileSync(join(crewDir, 'journal.jsonl'),
    Array.from({ length: 4000 }, (_, i) => JSON.stringify({ no_lead_escalation: `backlog event ${i} ${'x'.repeat(200)}` })).join('\n') + '\n')
  const kids = []
  const fork = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); kids.push(c.pid); return c }
  const d = daemon({ root, deps: { pollMs: 1_000_000, fork } })
  await d.start()
  d.enqueue({ crew_dir: crewDir, run_id: 'r-1' })
  d.poll()
  const backlog = d.feed('r-1').length
  let survived = null, reply = null
  await new Promise((resolve) => {
    const socket = connect(d.socketPath, () => {
      socket.write(`${JSON.stringify({ id: 'a', cmd: 'tail', params: { run: 'r-1', since: 0 } })}\n`)
      // Destroy while the daemon is still pushing the backlog.
      setTimeout(() => { socket.destroy(); resolve() }, 2)
    })
    socket.on('error', () => resolve())
  })
  await new Promise((r) => setTimeout(r, 300))
  // Is the daemon still alive and answering on a fresh connection?
  await new Promise((resolve) => {
    const socket = connect(d.socketPath, () => socket.write(`${JSON.stringify({ id: 'b', cmd: 'ping' })}\n`))
    socket.on('data', (chunk) => { reply = String(chunk).trim().split('\n')[0]; survived = true; socket.destroy(); resolve() })
    socket.on('error', () => { survived = false; resolve() })
    setTimeout(() => { if (survived == null) { survived = false; resolve() } }, 2000)
  })
  console.log(`N1 tail replay backlog=${backlog} events; client destroyed 2ms into the replay`)
  console.log(`   daemon still answering : ${survived}  reply=${reply}`)
  console.log(`   subscribers left       : ${JSON.stringify(d.subscribers())}`)
  console.log(`   VERDICT: ${survived && d.subscribers().length === 0 ? 'SURVIVED — the write is guarded (crew/daemon.mjs:1294-1297) and close/error unsubscribe (:1381-1382)' : 'FAILED — investigate'}`)
  await d.stop()
  for (const pid of kids) { try { process.kill(pid, 'SIGKILL') } catch {} }
  rmSync(root, { recursive: true, force: true })
}

// ---------------- N2: a REUSED pid in the descendant sweep -------------------
{
  const root = mkdtempSync(join(tmpdir(), 'h1n2-'))
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  innocent.unref()
  await new Promise((r) => setTimeout(r, 600))
  const row = psRow(innocent.pid)
  // Same pid and pgid, a start time from another era: the shape of a recycled pid.
  const read = writeRecord(taskDir, { root_pid: row.pid, root_pgid: row.pgid, root_start: 'Mon Jan  1 00:00:00 2001' })
  const journal = []
  const summary = settleSeatRoots({ taskDir, log: (r) => journal.push(r), deps: {} })
  const sweep = reclaimDescendants({ taskDir, log: (r) => journal.push(r), deps: {} })
  const stillAlive = alive(row.pgid)
  console.log(`\nN2 record bound to pid=${row.pid} pgid=${row.pgid} with a stale start string`)
  console.log(`   settleSeatRoots        : ${JSON.stringify(summary)} stamp=${JSON.stringify(read().root_settled)}`)
  console.log(`   reclaimDescendants     : reason=${JSON.stringify(journal.find((r) => r.event === 'descendant-reclaim')?.reason)}`)
  console.log(`   innocent process alive : ${stillAlive}`)
  console.log(`   VERDICT: ${stillAlive && read().root_settled === 'root-unidentified' ? 'SURVIVED — the pgid+start binding refuses the row (crew/seat-io.mjs:531) and signals nothing' : 'FAILED — investigate'}`)
  try { process.kill(-row.pgid, 'SIGKILL') } catch {}
  rmSync(root, { recursive: true, force: true })
}

// ---------------- N3: the settle run twice for one seat ----------------------
{
  const root = mkdtempSync(join(tmpdir(), 'h1n3-'))
  const taskDir = join(root, 'task')
  mkdirSync(taskDir, { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  child.unref()
  await new Promise((r) => setTimeout(r, 600))
  const row = psRow(child.pid)
  const read = writeRecord(taskDir, { root_pid: row.pid, root_pgid: row.pgid, root_start: row.start })
  const j1 = [], j2 = []
  const first = settleSeatRoots({ taskDir, log: (r) => j1.push(r), deps: {} })
  const deadAfterFirst = !alive(row.pgid)
  const second = settleSeatRoots({ taskDir, log: (r) => j2.push(r), deps: {} })
  const s1 = reclaimDescendants({ taskDir, log: (r) => j1.push(r), deps: {} })
  const s2 = reclaimDescendants({ taskDir, log: (r) => j2.push(r), deps: {} })
  console.log(`\nN3 first settle : ${JSON.stringify(first)} -> root dead=${deadAfterFirst}`)
  console.log(`   second settle  : ${JSON.stringify(second)} (skipped on the stamp)`)
  console.log(`   reclaim x2     : swept=${s1.swept}/${s2.swept} signalled=${s1.signalled}/${s2.signalled} skipped=${s1.skipped}/${s2.skipped}`)
  console.log(`   VERDICT: ${deadAfterFirst && second.records === 0 && s2.signalled === 0 ? 'SURVIVED (idempotence only) — the second settle is skipped and nothing is re-signalled; note the FIRST settle stamped root_settled=unproven for a kill that worked -- finding F3, see r7' : 'FAILED — investigate'}`)
  try { process.kill(-row.pgid, 'SIGKILL') } catch {}
  rmSync(root, { recursive: true, force: true })
}
