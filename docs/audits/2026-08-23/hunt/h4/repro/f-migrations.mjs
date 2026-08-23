#!/usr/bin/env node
// REPRO F — migrations against a db created at an earlier schema version,
// including one holding rows that violate a constraint added later.
// Usage: node f-migrations.mjs <path-to-scratch-repo>   (throwaway dirs only)
//
// Claim under test: "the schema fence is additive-only" (ledger.mjs:120-127)
// and AC-4 — opening a db created by an earlier migration prefix under the
// full list works.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const repo = resolve(process.argv[2] || '.')
const mod = join(repo, 'scripts/factory/ledger.mjs')
const { openLedger, applyMigrations, MIGRATIONS, TABLES } = await import(mod)

// ---- F1: every strict prefix of MIGRATIONS upgrades cleanly ---------------
console.log('=== F1: apply prefix k, then the full list (AC-4) ===')
let f1bad = 0
for (let k = 0; k <= MIGRATIONS.length; k += Math.max(1, Math.floor(MIGRATIONS.length / 12))) {
  const dir = mkdtempSync(join(tmpdir(), 'h4f1-'))
  const db = new DatabaseSync(join(dir, 'ledger.db'))
  try {
    applyMigrations(db, MIGRATIONS.slice(0, k))
    applyMigrations(db)               // the full list, as ensureDb does
    applyMigrations(db)               // idempotence
  } catch (err) { f1bad++; console.log(`  prefix ${k}: FAILED ${err.message}`) }
  db.close()
}
console.log(`  prefixes probed, failures: ${f1bad}`)

// ---- F2: a db whose rows violate a UNIQUE INDEX declared later -----------
// The fence is additive-only for COLUMNS (ledger.mjs:120-127, :898-904). It
// says nothing about the UNIQUE indexes migrationsFor() also generates
// (:864-867). A db created before an index was declared can hold rows that
// violate it — and REPRO E shows seat_teardowns' own key is one a real run
// duplicates.
console.log('\n=== F2: rows that violate a UNIQUE INDEX declared later ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'h4f2-'))
  const dbPath = join(dir, 'ledger.db')
  const IDX = '"seat_teardowns_adw_id_role_uq"'
  const withoutOneIndex = MIGRATIONS.filter((s) => !s.includes(IDX))
  console.log(`  migrations withheld: ${MIGRATIONS.length - withoutOneIndex.length} (${IDX})`)
  const db = new DatabaseSync(dbPath)
  applyMigrations(db, withoutOneIndex)
  const cols = TABLES.seat_teardowns.columns.map((c) => c.name).filter((c) => c !== 'id')
  const ins = db.prepare(`INSERT INTO seat_teardowns (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
  const row = Object.fromEntries(cols.map((c) => [c, null]))
  row.adw_id = 'r1'; row.role = 'builder'; row.forced = 0
  row.outcome = 'proven'; row.created_at = '2026-08-01T00:00:00.000Z'
  ins.run(...cols.map((c) => row[c]))
  row.outcome = 'failed'; row.created_at = '2026-08-01T00:05:00.000Z'
  ins.run(...cols.map((c) => row[c]))   // legal under the old schema
  console.log(`  rows written under the old schema: ${db.prepare('SELECT COUNT(*) AS n FROM seat_teardowns').get().n}`)
  db.close()

  let stderrText = ''
  const l = openLedger({ dbPath, stderr: { write: (s) => { stderrText += s } } })
  let threw = null
  try {
    l.startSession({ adw_id: 'r2', repo_slug: 'r', task_slug: 't' })
    for (let i = 0; i < 3; i++) l.recordEvent({ adw_id: 'r2', type: 'log', payload: { level: 'info', message: `m${i}` } })
    l.endSession({ adw_id: 'r2', status: 'ok' })
  } catch (err) { threw = err }
  const { readFileSync } = await import('node:fs')
  console.log(`  writer threw            : ${threw ? threw.message : 'no'}`)
  console.log(`  handle.degraded         : ${l.degraded}`)
  console.log(`  stats().degraded_reason : ${l.stats().degraded_reason}`)
  console.log(`  stats().mirror_errors   : ${l.stats().mirror_errors}`)
  console.log(`  stderr                  : ${JSON.stringify(stderrText.trim())}`)
  console.log(`  JSONL lines             : ${readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length}`)
  console.log(`  sessions rows mirrored  : ${l.dumpTable('sessions').length}`)
  console.log(`  events rows mirrored    : ${l.dumpTable('events').length}`)
  const d = l.jsonlDrift()
  console.log(`  jsonlDrift(): measured=${d.measured} reason=${d.unmeasured_reason} drift_total=${d.drift_total}`)
  l.close()
}
