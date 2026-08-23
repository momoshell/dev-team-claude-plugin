#!/usr/bin/env node
// REPRO J — (1) a second process reading the mirror mid-write (WAL);
//           (2) what `ledger doctor` tells the operator about repro A's loss.
// Usage: node j-wal-and-doctor.mjs <path-to-scratch-repo>   (throwaway dirs only)
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const repo = resolve(process.argv[2] || '.')
const mod = join(repo, 'scripts/factory/ledger.mjs')
const { openLedger } = await import(mod)

// ---- J1: hammer every visualizer query while a writer is mid-run ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4j1-'))
  const dbPath = join(dir, 'ledger.db')
  const writer = join(dir, 'writer.mjs')
  writeFileSync(writer, `
import { openLedger } from ${JSON.stringify(mod)}
const l = openLedger({ dbPath: ${JSON.stringify(dbPath)} })
l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
for (let i = 0; i < 400; i++) {
  l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: 'm' + i } })
  l.recordCellFailure({ adw_id: 'r1', role: 'builder', kind: 'timeout', provider: 'p', model_id: 'm', agent: 'a', effort: 'e' })
  l.recordSeatTeardown({ adw_id: 'r1', role: 'builder' + i, outcome: 'proven' })
}
l.endSession({ adw_id: 'r1', status: 'ok' })
l.close()
`)
  const child = spawn(process.execPath, [writer], { stdio: 'inherit' })
  const { createLedgerFeed } = await import(join(repo, 'visualizer/server/ledger-feed.mjs'))
  const feed = createLedgerFeed({ ledgerDb: dbPath, triageDb: join(dir, 'viz.db') })
  const errors = []
  let reads = 0
  const since = new Date(Date.now() - 864e5).toISOString()
  const alive = new Promise((r) => child.on('exit', r))
  let done = false
  alive.then(() => { done = true })
  while (!done) {
    for (const fn of [
      () => feed.listRuns({}), () => feed.listEvents({ adw_id: 'r1' }),
      () => feed.cellFailures({ since }), () => feed.cellAttribution({ since }),
      () => feed.seatTeardowns({ since }), () => feed.budgetWindow({ since }),
    ]) {
      try { fn(); reads += 1 } catch (err) { errors.push(err.message) }
    }
    await new Promise((r) => setImmediate(r))
  }
  await alive
  console.log('=== J1: read-only feed hammering every query during a live write ===')
  console.log(`  reads completed : ${reads}`)
  console.log(`  read errors     : ${errors.length} ${errors.slice(0, 3).join(' | ')}`)
  console.log(`  feed.health()   : ${JSON.stringify(feed.health())}`)
  const l = openLedger({ dbPath })
  console.log(`  final rows      : events=${l.dumpTable('events').length} cell_failures=${l.dumpTable('cell_failures').length} seat_teardowns=${l.dumpTable('seat_teardowns').length}`)
  const jl = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
  console.log(`  JSONL lines     : ${jl.length}`)
  console.log(`  drift_total     : ${l.jsonlDrift().drift_total}`)
  l.close(); feed.close()
}

// ---- J2: `ledger doctor` over the two-emitter loss from repro A -----------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4j2-'))
  const dbPath = join(dir, 'ledger.db')
  const emitter = join(dir, 'emitter.mjs')
  writeFileSync(emitter, `
import { openLedger } from ${JSON.stringify(mod)}
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [dbPath, dir, tag] = process.argv.slice(2)
const l = openLedger({ dbPath })
l.startSession({ adw_id: 'run-1', repo_slug: 'r', task_slug: 't' })
writeFileSync(join(dir, 'ready.' + tag), '')
const other = tag === 'A' ? 'B' : 'A'
const deadline = Date.now() + 10000
while (!existsSync(join(dir, 'ready.' + other)) && Date.now() < deadline) {}
for (let i = 0; i < 20; i++) l.recordEvent({ adw_id: 'run-1', type: 'log', payload: { level: 'info', message: tag + ':' + i } })
l.close()
`)
  await Promise.all(['A', 'B'].map((tag) => new Promise((res) => {
    spawn(process.execPath, [emitter, dbPath, dir, tag], { stdio: 'inherit' }).on('exit', res)
  })))
  const out = execFileSync(process.execPath, [mod, 'doctor'], { env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath }, encoding: 'utf8' })
  const parsed = JSON.parse(out)
  console.log('\n=== J2: `ledger doctor` after 40 JSONL events became 20 rows ===')
  console.log(`  degraded      : ${JSON.stringify(parsed.degraded ?? parsed.state?.degraded)}`)
  console.log(`  jsonl_drift   : ${JSON.stringify(parsed.jsonl_drift ?? parsed.drift, null, 1).slice(0, 900)}`)
}
