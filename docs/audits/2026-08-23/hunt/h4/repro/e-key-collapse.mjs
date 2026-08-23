#!/usr/bin/env node
// REPRO E — natural keys that cannot represent a run's second attempt.
// Usage: node e-key-collapse.mjs <path-to-scratch-repo>   (throwaway dirs only)
//
// seat_teardowns is UNIQUE(adw_id, role) and review_outcomes is
// UNIQUE(adw_id, dispatch_id). Both mirrors INSERT OR IGNORE. A run that seats
// one role twice (a bounce / a re-ask — visualizer/server/shape.mjs:57-63 says
// in so many words that "the runtime reuses [a dispatch id] across a resumed
// drive (#461)") therefore writes two JSONL lines and gets one row.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const { openLedger } = await import(join(repo, 'scripts/factory/ledger.mjs'))
const { startServer } = await import(join(repo, 'visualizer/server/server.mjs'))

const dir = mkdtempSync(join(tmpdir(), 'h4e-'))
const dbPath = join(dir, 'ledger.db')
const l = openLedger({ dbPath })
l.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 'bounced-builder' })

// The builder's first seat is torn down cleanly; the run re-seats the role and
// the SECOND teardown is a MEASURED live worker after teardown ('failed').
l.recordSeatTeardown({ adw_id: 'r1', role: 'builder', outcome: 'proven', transport: 'headless-json', reason: 'exited', created_at: Date.now() - 60_000 })
l.recordSeatTeardown({ adw_id: 'r1', role: 'builder', outcome: 'failed', transport: 'headless-json', reason: 'worker still alive after SIGKILL', evidence_kind: 'ps', created_at: Date.now() - 1_000 })

// The reviewer is re-asked under the SAME dispatch id and changes its verdict.
l.recordReviewOutcome({ adw_id: 'r1', dispatch_id: 'd3', role: 'reviewer', verdict: 'changes-needed', must_fix: 4, provider: 'anthropic', model_id: 'opus-5', agent: 'claude', effort: 'high', created_at: Date.now() - 30_000 })
l.recordReviewOutcome({ adw_id: 'r1', dispatch_id: 'd3', role: 'reviewer', verdict: 'pass', must_fix: 0, provider: 'anthropic', model_id: 'opus-5', agent: 'claude', effort: 'high', created_at: Date.now() - 2_000 })

const jsonl = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
console.log(`ledger dir: ${dir}`)
console.log('=== seat_teardowns: UNIQUE(adw_id, role) ===')
console.log(`  JSONL lines            : ${jsonl.filter((r) => r.kind === 'recordSeatTeardown').length}`)
console.log(`  outcomes in the JSONL  : ${JSON.stringify(jsonl.filter((r) => r.kind === 'recordSeatTeardown').map((r) => r.args.outcome))}`)
console.log(`  rows in the mirror     : ${JSON.stringify(l.dumpTable('seat_teardowns').map((r) => ({ role: r.role, outcome: r.outcome, reason: r.reason })))}`)
console.log(`  ledger.seatTeardowns() : ${JSON.stringify(l.seatTeardowns({ since: new Date(Date.now() - 864e5).toISOString() }))}`)
console.log('=== review_outcomes: UNIQUE(adw_id, dispatch_id) ===')
console.log(`  JSONL lines            : ${jsonl.filter((r) => r.kind === 'recordReviewOutcome').length}`)
console.log(`  verdicts in the JSONL  : ${JSON.stringify(jsonl.filter((r) => r.kind === 'recordReviewOutcome').map((r) => r.args.verdict))}`)
console.log(`  rows in the mirror     : ${JSON.stringify(l.dumpTable('review_outcomes').map((r) => ({ dispatch_id: r.dispatch_id, verdict: r.verdict, must_fix: r.must_fix })))}`)
console.log('=== the doctor readout ===')
const d = l.jsonlDrift()
console.log(`  measured=${d.measured} drift_total=${d.drift_total} remedy=${d.remedy}`)
for (const w of d.writers.filter((x) => /Teardown|Review/.test(x.writer))) {
  console.log(`  ${w.writer}: distinct_keys=${w.distinct_keys} rows_present=${w.rows_present} drift=${w.drift}`)
}
console.log(`  stats(): ${JSON.stringify(l.stats())}`)
l.close()

const { server } = startServer({ port: 0, host: '127.0.0.1', ledgerDb: dbPath, triageDb: join(dir, 'viz.db'), crewRoot: join(dir, 'crew'), checkout: dir })
await new Promise((r) => server.once('listening', r))
const port = server.address().port
const teardowns = await (await fetch(`http://127.0.0.1:${port}/api/seat-teardowns`)).json()
console.log('=== /api/seat-teardowns (what the operator sees) ===')
console.log(`  totals : ${JSON.stringify(teardowns.totals)}`)
console.log(`  run r1 : ${JSON.stringify(teardowns.runs?.[0]?.seats ?? teardowns.runs?.[0])}`)
server.close()
