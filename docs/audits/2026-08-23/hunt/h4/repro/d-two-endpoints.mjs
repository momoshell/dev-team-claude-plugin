#!/usr/bin/env node
// REPRO D — /api/cell-health and /api/cell-attribution answer different
// failure counts for ONE cell over the SAME default window.
// Usage: node d-two-endpoints.mjs <path-to-scratch-repo>
// Binds an EPHEMERAL port (port 0) and shuts the server down; touches no checkout.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const { openLedger } = await import(join(repo, 'scripts/factory/ledger.mjs'))
const { startServer } = await import(join(repo, 'visualizer/server/server.mjs'))

const dir = mkdtempSync(join(tmpdir(), 'h4d-'))
const dbPath = join(dir, 'ledger.db')
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()

const l = openLedger({ dbPath })
// One ordinary long-lived run: it STARTED 9 days ago (outside the 7-day cell
// window) and one of its seats died 1 day ago (inside it). Nothing exotic —
// this is any run that straddles the window boundary.
l.startSession({ adw_id: 'straddler', repo_slug: 'r', task_slug: 'long-run', started_at: now - 9 * DAY })
l.recordCellFailure({
  adw_id: 'straddler', role: 'builder', kind: 'seat-died',
  provider: 'anthropic', model_id: 'opus-5', agent: 'claude', effort: 'high',
  created_at: now - 1 * DAY,
})
// A second run wholly inside the window, with a seat failure of its own, so
// neither endpoint is trivially empty.
l.startSession({ adw_id: 'inside', repo_slug: 'r', task_slug: 'short-run', started_at: now - 2 * DAY })
l.recordCellFailure({
  adw_id: 'inside', role: 'builder', kind: 'seat-died',
  provider: 'anthropic', model_id: 'opus-5', agent: 'claude', effort: 'high',
  created_at: now - 2 * DAY,
})
l.close()

const { server } = startServer({ port: 0, host: '127.0.0.1', ledgerDb: dbPath, triageDb: join(dir, 'viz.db'), crewRoot: join(dir, 'crew'), checkout: dir })
await new Promise((r) => server.once('listening', r))
const port = server.address().port
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()

const health = await get('/api/cell-health')
const attrib = await get('/api/cell-attribution')
const cell = health.cells.find((c) => c.model_id === 'opus-5')

console.log(`window (both endpoints): since=${health.window.since} label=${health.window.label}`)
console.log(`ledger dir: ${dir}`)
console.log('')
console.log('/api/cell-health     — cell anthropic/opus-5·claude·high')
console.log(`  failures        : ${cell.failures}`)
console.log(`  by_kind         : ${JSON.stringify(cell.by_kind)}`)
console.log('')
console.log('/api/cell-attribution — same window, same cell')
console.log(`  totals          : ${JSON.stringify(attrib.totals)}`)
console.log(`  runs listed     : ${JSON.stringify(attrib.runs.map((r) => ({ adw_id: r.adw_id, failures: r.failures, state: r.state })))}`)
console.log(`  unattributable  : ${attrib.unattributable.length}`)
console.log('')
console.log(`DISAGREEMENT: cell-health says ${cell.failures} failure(s); cell-attribution accounts for ${attrib.totals.failures}.`)
console.log(`The 'straddler' row is in neither cell-attribution bucket: its run is`)
console.log(`outside the run window, and it is not "unattributable" because its adw_id`)
console.log(`IS registered in sessions (ledger-feed.mjs:164-169).`)

// the CLI is a third reader of the same fact
const { execFileSync } = await import('node:child_process')
const out = execFileSync(process.execPath, [join(repo, 'scripts/factory/ledger.mjs'), 'cells', '--since', iso(now - 7 * DAY)], { env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath }, encoding: 'utf8' })
console.log('')
console.log('`ledger cells --since <same>` (the third reader):')
console.log(out.split('\n').filter((s) => /opus-5|failures/.test(s)).slice(0, 6).join('\n'))
server.close()
