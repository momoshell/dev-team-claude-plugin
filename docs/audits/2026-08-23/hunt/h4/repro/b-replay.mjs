#!/usr/bin/env node
// REPRO B — replayJsonl against the JSONL authority it belongs to.
// Usage: node b-replay.mjs <path-to-scratch-repo>   (throwaway dirs only)
//
// Claim under test (scripts/factory/ledger.mjs:6-12): "the JSONL file is the
// run's true, permanent record. The SQLite database is a REBUILDABLE
// PROJECTION of that record — it may be deleted at any time and rebuilt in
// full via replayJsonl()."
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const { openLedger, replayJsonl } = await import(join(repo, 'scripts/factory/ledger.mjs'))
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean)

// ---- B1: the documented rebuild — delete the db, replay the authority ------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4b1-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  let l = openLedger({ dbPath })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  for (let i = 0; i < 5; i++) l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `m${i}` } })
  l.endSession({ adw_id: 'r1', status: 'ok' })
  l.close()
  const before = lines(jsonlPath).length

  // "it may be deleted at any time and rebuilt in full via replayJsonl()"
  rmSync(dbPath); rmSync(`${dbPath}-wal`, { force: true }); rmSync(`${dbPath}-shm`, { force: true })
  l = openLedger({ dbPath })
  const r1 = replayJsonl(jsonlPath, l)
  const after1 = lines(jsonlPath).length
  const r2 = replayJsonl(jsonlPath, l)   // an operator who runs the remedy twice
  const after2 = lines(jsonlPath).length
  console.log('=== B1: rebuild the mirror from its own authority ===')
  console.log(`JSONL lines before rebuild      : ${before}`)
  console.log(`after 1 replay (applied ${r1.applied})     : ${after1}`)
  console.log(`after 2 replays (applied ${r2.applied})    : ${after2}`)
  console.log(`events rows                     : ${l.dumpTable('events').length}`)
  console.log(`drift_total                     : ${l.jsonlDrift().drift_total}`)
  l.close()
}

// ---- B2: one line the current writers cannot re-accept --------------------
// A JSONL written by a ledger whose enum carried a member this build does not
// (a downgrade, an archived record, or a member retired from the set). Nothing
// here is hypothetical about the FILE: it is exactly the shape recordCellFailure
// itself appends, with one enum member changed.
{
  const dir = mkdtempSync(join(tmpdir(), 'h4b2-'))
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  let l = openLedger({ dbPath })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  for (let i = 0; i < 3; i++) l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `before-${i}` } })
  l.recordCellFailure({ adw_id: 'r1', role: 'builder', kind: 'timeout' })
  l.close()
  // rewrite that one line's `kind` to a member this build does not know
  const raw = lines(jsonlPath)
  const idx = raw.findIndex((s) => JSON.parse(s).kind === 'recordCellFailure')
  const bad = JSON.parse(raw[idx]); bad.args.kind = 'quota-exhausted'
  raw[idx] = JSON.stringify(bad)
  // ...and append three more perfectly good lines AFTER it
  l = openLedger({ dbPath, jsonlPath: join(dir, 'sink.jsonl') })
  const tail = []
  for (let i = 0; i < 3; i++) tail.push(JSON.stringify({ v: 1, kind: 'recordEvent', at: '2026-08-23T00:00:00.000Z', args: l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `after-${i}` } }) }))
  l.close()
  const authority = join(dir, 'authority.jsonl')
  appendFileSync(authority, `${[...raw, ...tail].join('\n')}\n`)

  const dir2 = mkdtempSync(join(tmpdir(), 'h4b2-rebuild-'))
  const l2 = openLedger({ dbPath: join(dir2, 'ledger.db'), jsonlPath: join(dir2, 'sink.jsonl') })
  console.log('\n=== B2: one unrepresentable line in the middle of the authority ===')
  console.log(`authority lines: ${lines(authority).length} (4 good, 1 unrepresentable, 3 good)`)
  let thrown = null
  try { replayJsonl(authority, l2) } catch (err) { thrown = err }
  console.log(`replayJsonl threw   : ${thrown ? `${thrown.constructor.name}: ${thrown.message}` : 'no'}`)
  console.log(`sessions rows       : ${l2.dumpTable('sessions').length}`)
  console.log(`events rows rebuilt : ${l2.dumpTable('events').length}  (authority carries 6)`)
  console.log(`cell_failures rows  : ${l2.dumpTable('cell_failures').length}`)
  const got = l2.dumpTable('events').map((r) => JSON.parse(r.payload_json).message)
  console.log(`messages present    : ${JSON.stringify(got)}`)
  console.log(`drift_total after the failed rebuild: ${l2.jsonlDrift().drift_total} (against its own empty sink, not the authority)`)
  l2.close()
}
