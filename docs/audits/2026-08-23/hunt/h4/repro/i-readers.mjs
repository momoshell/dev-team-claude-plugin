#!/usr/bin/env node
// REPRO I — reader-side losses: a latched feed, and a column no reader selects.
// Usage: node i-readers.mjs <path-to-scratch-repo>   (throwaway dirs only)
// Binds EPHEMERAL ports only.
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const { openLedger } = await import(join(repo, 'scripts/factory/ledger.mjs'))
const { startServer } = await import(join(repo, 'visualizer/server/server.mjs'))

// ---- I1: a feed that opens before the first run degrades for its lifetime --
{
  const dir = mkdtempSync(join(tmpdir(), 'h4i1-'))
  const dbPath = join(dir, 'ledger.db')
  console.log('=== I1: `npm run viz:serve` started before the first crew run ===')
  console.log(`  ledger.db exists at boot: ${existsSync(dbPath)}`)
  const { server } = startServer({ port: 0, host: '127.0.0.1', ledgerDb: dbPath, triageDb: join(dir, 'viz.db'), crewRoot: join(dir, 'crew'), checkout: dir })
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()
  const first = await get('/api/sessions')
  console.log(`  /api/sessions before any run: ${JSON.stringify(first).slice(0, 200)}`)

  // Now a crew run happens, exactly as it would on a fresh machine.
  const l = openLedger({ dbPath })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 'first-ever-run' })
  l.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: 'plan:r1' } })
  l.endSession({ adw_id: 'r1', status: 'ok' })
  l.close()
  console.log(`  ledger.db exists now    : ${existsSync(dbPath)}`)

  const second = await get('/api/sessions')
  console.log(`  /api/sessions after the run : ${JSON.stringify(second).slice(0, 200)}`)
  const health = await get('/api/cell-health')
  console.log(`  /api/cell-health absent : ${JSON.stringify(health.absent)}`)
  const rs = await get('/api/run-set')
  console.log(`  /api/run-set degraded   : ${rs.degraded} reason=${JSON.stringify(rs.degraded_reason)}`)
  console.log('  the server never reopens: ledger-feed.mjs:30 `if (db || degraded || closed) return db`')
  server.close()
}

// ---- I2: heartbeats are written and never read ----------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'h4i2-'))
  const dbPath = join(dir, 'ledger.db')
  const l = openLedger({ dbPath })
  l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 'pane-run' })
  l.startAgentSession({ adw_id: 'r1', dispatch_id: 'd1', role: 'builder', model: 'm', claude_session_id: 's1', transcript_path: '/x' })
  const beat = Date.now() - 3000
  l.heartbeat({ adw_id: 'r1', target: 'session', at: beat })
  l.heartbeat({ adw_id: 'r1', target: 'agent_session', claude_session_id: 's1', at: beat })
  // ...and a heartbeat that lands AFTER the run is finalized: nothing refuses it.
  l.endSession({ adw_id: 'r1', status: 'ok', ended_at: Date.now() - 2000 })
  l.heartbeat({ adw_id: 'r1', target: 'session', at: Date.now() })
  const row = l.getSession('r1')
  console.log('\n=== I2: heartbeat vs. finalization, and who reads the column ===')
  console.log(`  sessions.status            : ${row.status}`)
  console.log(`  sessions.ended_at          : ${row.ended_at}`)
  console.log(`  sessions.last_heartbeat_at : ${row.last_heartbeat_at}   <- later than ended_at, no refusal`)
  l.close()

  const { server } = startServer({ port: 0, host: '127.0.0.1', ledgerDb: dbPath, triageDb: join(dir, 'viz.db'), crewRoot: join(dir, 'crew'), checkout: dir })
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  const runs = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()
  const run = runs.runs[0]
  console.log(`  /api/sessions last_heartbeat_at: ${JSON.stringify(run.last_heartbeat_at)}`)
  console.log(`  /api/sessions heartbeat_age_ms : ${JSON.stringify(run.heartbeat_age_ms)}`)
  console.log(`  /api/sessions pending marker   : ${JSON.stringify(run.pending.last_heartbeat_at)}`)
  server.close()
}
