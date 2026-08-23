#!/usr/bin/env node
// REPRO G — values a writer accepts that no reader/replayer can carry back.
// Usage: node g-unrepresentable.mjs <path-to-scratch-repo>   (throwaway dirs only)
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const mod = join(repo, 'scripts/factory/ledger.mjs')
const { openLedger, replayJsonl, isoMs } = await import(mod)

// ---- G1: an out-of-ms-range epoch is ACCEPTED by every writer and then makes
//          the JSONL authority permanently un-replayable -----------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4g1-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const l = openLedger({ dbPath })
  l.startSession({ adw_id: 'ok-1', repo_slug: 'r', task_slug: 't' })
  // A caller that hands a MICROSECOND timestamp where the API wants epoch-ms —
  // still inside Date's representable range, so nothing refuses.
  const micros = Date.now() * 1000
  l.recordCellFailure({ adw_id: 'ok-1', role: 'builder', kind: 'timeout', created_at: micros })
  l.recordEvent({ adw_id: 'ok-1', type: 'log', payload: { level: 'info', message: 'after' } })
  l.close()
  console.log('=== G1: an expanded-year timestamp poisons the rebuild path ===')
  console.log(`  writer accepted           : ${isoMs(micros)}`)
  console.log(`  stored in cell_failures   : ${JSON.stringify(readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)).find((r) => r.kind === 'recordCellFailure').args.created_at)}`)
  const dir2 = mkdtempSync(join(tmpdir(), 'h4g1-rebuild-'))
  const l2 = openLedger({ dbPath: join(dir2, 'ledger.db'), jsonlPath: join(dir2, 'sink.jsonl') })
  let threw = null
  try { replayJsonl(jsonlPath, l2) } catch (err) { threw = err }
  console.log(`  replayJsonl               : ${threw ? `${threw.constructor.name}: ${threw.message}` : 'ok'}`)
  console.log(`  rows rebuilt              : sessions=${l2.dumpTable('sessions').length} cell_failures=${l2.dumpTable('cell_failures').length} events=${l2.dumpTable('events').length} (authority carries 1/1/1)`)
  l2.close()
}

// ---- G2: an unbounded log message in the durable record -------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4g2-'))
  const dbPath = join(dir, 'ledger.db')
  const l = openLedger({ dbPath })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  const big = 'x'.repeat(5 * 1024 * 1024)
  const t0 = Date.now()
  l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: big } })
  const ms = Date.now() - t0
  const size = statSync(join(dir, 'ledger.jsonl')).size
  console.log('\n=== G2: a 5 MB log message ===')
  console.log(`  accepted, no refusal      : yes (${ms} ms)`)
  console.log(`  ledger.jsonl size         : ${size} bytes`)
  console.log(`  payload_json stored       : ${l.dumpTable('events')[0].payload_json.length} chars`)
  console.log('  every other free-text field on these tables is sliced (note/detail/reason -> 500,')
  console.log('  stage -> 120, request -> 2000); `log.message` and `gate_results.checks` are not.')
  l.close()
}

// ---- G3: a NULL primary key -----------------------------------------------
// requireFields rejects only `undefined` ("null is a legitimate explicit value
// for several required keys", ledger.mjs:1400-1403). SQLite lets a
// TEXT PRIMARY KEY be NULL, and UNIQUE treats NULLs as distinct.
{
  const dir = mkdtempSync(join(tmpdir(), 'h4g3-'))
  const l = openLedger({ dbPath: join(dir, 'ledger.db') })
  l.startSession({ adw_id: null, repo_slug: 'r', task_slug: 'first' })
  l.startSession({ adw_id: null, repo_slug: 'r', task_slug: 'second' })
  l.recordEvent({ adw_id: null, type: 'log', payload: { level: 'info', message: 'orphan' } })
  console.log('\n=== G3: adw_id = null ===')
  console.log(`  sessions rows             : ${JSON.stringify(l.dumpTable('sessions').map((r) => ({ adw_id: r.adw_id, task_slug: r.task_slug })))}`)
  console.log(`  getSession(null)          : ${JSON.stringify(l.getSession(null))}`)
  console.log(`  taskReadout(null).adw_id  : ${JSON.stringify(l.taskReadout(null).adw_id)}`)
  console.log(`  jsonlDrift drift_total    : ${l.jsonlDrift().drift_total}`)
  console.log('  two sessions rows exist that no reader can address by key.')
  l.close()
}
