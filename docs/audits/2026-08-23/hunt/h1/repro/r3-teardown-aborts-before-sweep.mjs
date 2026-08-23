#!/usr/bin/env node
// R3 — teardownCore's FIRST statement can throw, and it runs before every
// process-reclaim step, so an unhealthy pane substrate strands every seat process
// AND the state dir.
//
//   crew/crew.mjs:2059  for (const m of ...) if (m.surface_id) closeSurfaceFn(m.surface_id)   <-- unguarded
//   crew/crew.mjs:2079  try { roots = settleRootsFn(...) } catch { ... }                      <-- the kill
//   crew/crew.mjs:2081  try { descendants = reclaimFn(...) } catch { ... }                    <-- the kill
//   crew/crew.mjs:2086  renameSyncFn(paths.dir, archived)                                     <-- the archive
//
// crew/driver.mjs:211 closeSurface calls tree(), and crew/driver.mjs:31 THROWS
// whenever the cmux CLI answers non-zero, times out, or prints unparseable JSON.
// teardownCmd (crew/crew.mjs:2103) does not catch it either — only `finally`.
//
// No dependency injection: this drives the REAL closeSurface with the real
// spawnSync, using CMUX_BIN (crew/driver.mjs:11) to stand in for a cmux that is
// missing/failing. Scratch repo copy + scratch state dir; the checkout is untouched.

import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }

const mode = process.argv[2] || 'broken'   // 'broken' | 'healthy'
const root = mkdtempSync(join(tmpdir(), `h1-r3-${mode}-`))
const stub = join(root, 'cmux-stub.sh')
writeFileSync(stub, mode === 'broken'
  ? '#!/bin/sh\necho "cmux: connection refused" >&2\nexit 1\n'
  : '#!/bin/sh\nif [ "$1" = tree ]; then echo \'{"windows":[]}\'; fi\nexit 0\n')
chmodSync(stub, 0o755)
process.env.CMUX_BIN = stub                 // read at import time by crew/driver.mjs:11

const { teardownCore } = await import(join(REPO, 'crew/crew.mjs'))
const { DESCENDANT_DIR } = await import(join(REPO, 'crew/seat-io.mjs'))

const stateDir = join(root, 'crew-state')
const taskDir = join(stateDir, 'task')
mkdirSync(taskDir, { recursive: true })
const paths = { dir: stateDir, taskDir, repo: 'scratch/repo' }

const alive = (pgid) => { try { process.kill(-pgid, 0); return true } catch { return false } }
const psRow = (pid) => {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
  for (const line of String(ps.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m && Number(m[1]) === pid) return { pid, pgid: Number(m[3]), stat: m[4], start: m[5].trim() }
  }
  return null
}

// A real, live seat root in its own process group, with a descendant record
// bound to it exactly as descendantCapture writes one.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
child.unref()
await new Promise((r) => setTimeout(r, 600))
const row = psRow(child.pid)
if (!row) { console.error('could not observe the spawned root'); process.exit(2) }
const dDir = join(taskDir, DESCENDANT_DIR)
mkdirSync(dDir, { recursive: true })
const key = 'headless__d1__seat-1'
writeFileSync(join(dDir, `.${key}.active.json`), JSON.stringify({
  reservation_id: `record-${key}`, key, phase: 'running',
  owner: { pid: process.pid, startedAt: Date.now() },
  transport: 'headless-json', role: 'builder', seat_id: 'd1', seat_reservation_id: 'seat-1',
  marker_owner_pid: process.pid, captures: 3, missed_snapshots: 0, discovery_failures: 0,
  root_pid: row.pid, root_pgid: row.pgid, root_start: row.start, groups: [],
  root_settled: null, swept_at: null, sweep_id: null,
}))

const crew = {
  task: 'h1-r3', checkout: root, workspace_id: 'ws-1',
  members: { builder: { role: 'builder', transport: 'pane', surface_id: 'aaaaaaaa-1111-2222-3333-444444444444' } },
}
writeFileSync(join(stateDir, 'crew.json'), JSON.stringify(crew, null, 2))

console.log(`mode=${mode}  cmux stub=${mode === 'broken' ? 'exits 1 (unhealthy substrate)' : 'exits 0 (healthy)'}`)
console.log(`seat root pid=${row.pid} pgid=${row.pgid} alive=${alive(row.pgid)}`)
const journal = []
let threw = null
try { teardownCore(paths, crew, { io: { log: (r) => journal.push(r) } }) } catch (err) { threw = err }
const archived = readdirSync(root).filter((n) => n.includes('.archive-'))
console.log(`teardownCore threw : ${threw ? JSON.stringify(threw.message) : 'no'}`)
console.log(`journal events     : ${JSON.stringify(journal.map((r) => r.event))}`)
console.log(`state dir archived : ${archived.length > 0 ? archived[0] : 'NO — ' + stateDir + ' still in place'}`)
console.log(`seat root alive    : ${alive(row.pgid)}`)
const leaked = alive(row.pgid)
console.log('')
if (mode === 'broken') {
  console.log('EXPECTED: a pane substrate that cannot be reached is a teardown DIAGNOSTIC — the seat')
  console.log('          processes are still reclaimed and the dir is still archived.')
  console.log(`OBSERVED: teardownCore threw at crew/crew.mjs:2059; no settle ran; root alive=${leaked}; archived=${archived.length > 0}.`)
  console.log(leaked && archived.length === 0 ? 'R3 REPRODUCED — live seat process + unarchived state dir' : 'R3 did not reproduce')
} else {
  console.log('CONTROL: identical inputs, healthy cmux stub.')
  console.log(`OBSERVED: root alive=${leaked}; archived=${archived.length > 0} — the sweep is exactly what the throw skipped.`)
}
try { process.kill(-row.pgid, 'SIGKILL') } catch {}
rmSync(root, { recursive: true, force: true })
process.exit(mode === 'broken' ? (leaked && archived.length === 0 ? 0 : 1) : (leaked ? 1 : 0))
