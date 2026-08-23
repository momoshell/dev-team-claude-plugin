#!/usr/bin/env node
// REPRO H — forcing the degraded path mid-session.
// Usage: node h-degraded.mjs <path-to-scratch-repo>   (throwaway dirs only)
//
// Claims under test (scripts/factory/ledger.mjs:9-13, 22-28):
//  * "A caller must never be able to observe a mirror failure ... a mirror
//     failure only increments stats().mirror_errors"
//  * degraded is true, and one diagnostic line reaches stderr, when the
//    mirror is not recording.
import { mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const { openLedger } = await import(join(repo, 'scripts/factory/ledger.mjs'))
const jsonlLines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean)

// ---- H1: delete the db (and its WAL) out from under a live handle ---------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4h1-'))
  const dbPath = join(dir, 'ledger.db')
  let stderrText = ''
  const l = openLedger({ dbPath, stderr: { write: (s) => { stderrText += s } } })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: 'before' } })
  // The operator (or a `rm -rf ~/.dev-team/factory` / a disk sweeper) removes
  // the mirror. The JSONL authority is untouched.
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true })
  for (let i = 0; i < 5; i++) l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `after-${i}` } })
  l.endSession({ adw_id: 'r1', status: 'ok' })

  console.log('=== H1: db deleted under a live handle ===')
  console.log(`JSONL lines (authority)     : ${jsonlLines(join(dir, 'ledger.jsonl')).length}   <- no line lost`)
  console.log(`handle.degraded             : ${l.degraded}`)
  console.log(`stats().mirror_errors       : ${l.stats().mirror_errors}`)
  console.log(`stats().degraded_reason     : ${l.stats().degraded_reason}`)
  console.log(`stderr diagnostic           : ${JSON.stringify(stderrText)}`)
  console.log(`this handle reads back      : ${l.dumpTable('events').length} events (from the deleted inode)`)
  const drift = l.jsonlDrift()
  console.log(`jsonlDrift(): measured=${drift.measured} drift_total=${drift.drift_total}`)
  l.close()
  // What the NEXT process — and every reader — actually sees on disk:
  const l2 = openLedger({ dbPath, stderr: { write: () => {} } })
  console.log(`next process sees           : ${l2.dumpTable('events').length} events, ${l2.dumpTable('sessions').length} sessions`)
  const d2 = l2.jsonlDrift()
  console.log(`next process jsonlDrift()   : measured=${d2.measured} drift_total=${d2.drift_total} remedy=${d2.remedy ? 'yes' : 'null'}`)
  l2.close()
}

// ---- H2: revoke write permission on the db file mid-session ---------------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4h2-'))
  const dbPath = join(dir, 'ledger.db')
  let stderrText = ''
  const l = openLedger({ dbPath, stderr: { write: (s) => { stderrText += s } } })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: 'before' } })
  chmodSync(dir, 0o500)      // no new files: SQLite cannot create/extend siblings
  chmodSync(dbPath, 0o400)   // read-only mirror
  let threw = null
  try {
    for (let i = 0; i < 5; i++) l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `after-${i}` } })
  } catch (err) { threw = err }
  console.log('\n=== H2: db + dir made read-only mid-session ===')
  console.log(`a writer threw              : ${threw ? `${threw.constructor.name}: ${threw.message}` : 'no'}`)
  console.log(`JSONL lines (authority)     : ${jsonlLines(join(dir, 'ledger.jsonl')).length}`)
  console.log(`handle.degraded             : ${l.degraded}`)
  console.log(`stats().mirror_errors       : ${l.stats().mirror_errors}`)
  console.log(`stats().mirror_first_code   : ${l.stats().mirror_first_code}`)
  console.log(`stderr diagnostic           : ${JSON.stringify(stderrText)}`)
  chmodSync(dir, 0o700); chmodSync(dbPath, 0o600)
  console.log(`events actually mirrored    : ${l.dumpTable('events').length} (JSONL carries 6 events)`)
  l.close()
}

// ---- H3: the daemon's budget ceiling over the same deleted mirror ---------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4h3-'))
  const dbPath = join(dir, 'ledger.db')
  const { usageWindow } = await import(join(repo, 'crew/daemon.mjs'))
  const l = openLedger({ dbPath, stderr: { write: () => {} } })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  l.startAgentSession({ adw_id: 'r1', dispatch_id: 'd1', role: 'builder', model: 'm', claude_session_id: 's1', transcript_path: '/x' })
  l.endAgentSession({
    adw_id: 'r1', claude_session_id: 's1', context_tokens: 1, context_window: 2,
    raw_read_tokens: 3, raw_written_tokens: 4,
    billed_input_tokens: 900_000, billed_output_tokens: 100_000,
    billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
  })
  l.close()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  console.log('\n=== H3: budget ceiling reads the mirror, not the authority ===')
  console.log(`usageWindow with the mirror present : ${JSON.stringify(usageWindow({ dbPath, since }))}`)
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true })
  console.log(`usageWindow with the mirror deleted : ${JSON.stringify(usageWindow({ dbPath, since }))}`)
  console.log(`JSONL authority still records the spend: ${jsonlLines(join(dir, 'ledger.jsonl')).some((s) => JSON.parse(s).kind === 'endAgentSession')}`)
}
