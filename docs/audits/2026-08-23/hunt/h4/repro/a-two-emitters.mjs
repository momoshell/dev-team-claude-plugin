#!/usr/bin/env node
// REPRO A — two emitters writing ONE session concurrently.
//
// Usage: node a-two-emitters.mjs <path-to-scratch-repo>
// Runs entirely inside a throwaway DEVTEAM_LEDGER_DIR (mkdtemp). Touches no
// checkout and never reads ~/.dev-team.
//
// Claims under test:
//  1. the JSONL authority and the SQLite mirror agree on what happened;
//  2. when they do not, `ledger.jsonlDrift()` — the doctor's drift readout,
//     whose whole job is to answer "did the mirror lose a row?" — says so.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repo = resolve(process.argv[2] || '.')
const ledgerMod = join(repo, 'scripts/factory/ledger.mjs')
const dir = mkdtempSync(join(tmpdir(), 'h4a-'))
const dbPath = join(dir, 'ledger.db')
const N = 25

// Each child is a separate PROCESS opening the same ledger — exactly the shape
// of two crew emitters on one adw_id (crew/crew.mjs and scripts/factory/emit.mjs
// both call openLedger() against the same DEVTEAM_LEDGER_DIR).
// The rendezvous only makes a REAL race deterministic; it invents nothing:
// it holds both emitters at the point where each is about to allocate its
// first event seq, which is where two live emitters naturally meet.
const child = join(dir, 'emitter.mjs')
writeFileSync(child, `
import { openLedger } from ${JSON.stringify(ledgerMod)}
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [dbPath, dir, tag, n] = process.argv.slice(2)
const l = openLedger({ dbPath })
l.startSession({ adw_id: 'run-1', repo_slug: 'r', task_slug: 't' })
writeFileSync(join(dir, 'ready.' + tag), '')
const other = tag === 'A' ? 'B' : 'A'
const deadline = Date.now() + 10000
while (!existsSync(join(dir, 'ready.' + other)) && Date.now() < deadline) { /* spin */ }
for (let i = 0; i < Number(n); i++) {
  l.recordEvent({ adw_id: 'run-1', type: 'log', payload: { level: 'info', message: tag + ':' + i } })
}
l.close()
`)

await Promise.all(['A', 'B'].map((tag) => new Promise((res, rej) => {
  const p = spawn(process.execPath, [child, dbPath, dir, tag, String(N)], { stdio: 'inherit' })
  p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${tag} exited ${c}`))))
})))

const { openLedger } = await import(ledgerMod)
const l = openLedger({ dbPath })
const jsonl = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
const jsonlEvents = jsonl.filter((r) => r.kind === 'recordEvent')
const rows = l.dumpTable('events')
const drift = l.jsonlDrift()

const messages = new Set(jsonlEvents.map((r) => r.args.payload.message))
const stored = new Set(rows.map((r) => JSON.parse(r.payload_json).message))
const lost = [...messages].filter((m) => !stored.has(m))

console.log(`ledger dir: ${dir}`)
console.log(`JSONL recordEvent lines    : ${jsonlEvents.length}  (expected ${2 * N})`)
console.log(`events rows in mirror      : ${rows.length}`)
console.log(`distinct messages in JSONL : ${messages.size}`)
console.log(`distinct messages in db    : ${stored.size}`)
console.log(`messages LOST by the mirror: ${lost.length}`)
console.log(`  e.g. ${lost.slice(0, 6).join(', ')}`)
console.log(`stats().mirror_errors      : ${l.stats().mirror_errors}`)
console.log(`degraded                   : ${l.degraded}`)
console.log('--- jsonlDrift() (the doctor readout) ---')
const w = drift.writers.find((x) => x.writer === 'recordEvent')
console.log(`measured    : ${drift.measured}`)
console.log(`lines       : ${drift.lines}`)
console.log(`recordEvent : distinct_keys=${w.distinct_keys} rows_present=${w.rows_present} drift=${w.drift}`)
console.log(`drift_total : ${drift.drift_total}`)
console.log(`remedy      : ${drift.remedy}`)
console.log('--- replayJsonl into a FRESH mirror (the documented remedy) ---')
const { replayJsonl } = await import(ledgerMod)
const dir2 = mkdtempSync(join(tmpdir(), 'h4a-rebuild-'))
const l2 = openLedger({ dbPath: join(dir2, 'ledger.db'), jsonlPath: join(dir2, 'replay.jsonl') })
const r = replayJsonl(join(dir, 'ledger.jsonl'), l2)
console.log(`applied=${r.applied} skipped=${r.skipped}`)
console.log(`events rows after rebuild  : ${l2.dumpTable('events').length}  (JSONL carries ${jsonlEvents.length})`)
l2.close(); l.close()
void existsSync

// ---- A2: no concurrency needed — one degraded run, then a healthy one -----
// nextSeq seeds from MAX(seq) in the MIRROR (ledger.mjs:1386-1396). A handle
// that was degraded mirrored nothing, so the next healthy handle for the same
// adw_id re-issues seq 1..N over the same JSONL authority.
{
  const dir3 = mkdtempSync(join(tmpdir(), 'h4a2-'))
  const dbPath3 = join(dir3, 'ledger.db')
  const { openLedger: open3 } = await import(ledgerMod)
  const degraded = open3({ dbPath: dbPath3, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  degraded.startSession({ adw_id: 'r1', repo_slug: 'r', task_slug: 't' })
  for (let i = 0; i < 5; i++) degraded.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `degraded-${i}` } })
  degraded.close()
  const healthy = open3({ dbPath: dbPath3 })
  for (let i = 0; i < 5; i++) healthy.recordEvent({ adw_id: 'r1', type: 'log', payload: { level: 'info', message: `healthy-${i}` } })
  const authored = readFileSync(join(dir3, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.kind === 'recordEvent')
  console.log('\n--- A2: one degraded handle, then a healthy one, same run ---')
  console.log(`JSONL events        : ${authored.length}, seqs ${JSON.stringify(authored.map((r) => r.args.seq))}`)
  console.log(`events rows         : ${healthy.dumpTable('events').length}`)
  console.log(`drift_total         : ${healthy.jsonlDrift().drift_total}`)
  healthy.close()
  const dir4 = mkdtempSync(join(tmpdir(), 'h4a2-rebuild-'))
  const l4 = openLedger({ dbPath: join(dir4, 'ledger.db'), jsonlPath: join(dir4, 'sink.jsonl') })
  replayJsonl(join(dir3, 'ledger.jsonl'), l4)
  console.log(`rebuilt from authority: ${l4.dumpTable('events').length} events out of ${authored.length}`)
  console.log(`  kept: ${JSON.stringify(l4.dumpTable('events').map((r) => JSON.parse(r.payload_json).message))}`)
  l4.close()
}
