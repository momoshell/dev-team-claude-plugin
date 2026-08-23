#!/usr/bin/env node
// R4 — one unreadable read of the run envelope makes the daemon's "orphaned"
// verdict PERMANENT. It never looks at the file again — not on the next tick, not
// after a restart — so a run that finished is recorded as a run that died.
//
//   crew/child.mjs:157      write(taskReturn, JSON.stringify(result, null, 2))   <-- plain, O_TRUNC, NOT atomic
//   crew/daemon.mjs:306-312 jsonAt: a parse failure returns null, exactly like "no file"
//   crew/daemon.mjs:857     else if (run.child_dead) orphanRun(run, ...)
//   crew/daemon.mjs:842     if (run.lifecycle === 'orphaned' || ... === 'settled') return   <-- never re-read
//   crew/daemon.mjs:499     const SETTLED_LIFECYCLES = ['settled', 'orphaned']              <-- a restart skips it too
//
// The daemon knows how to publish a file so a reader can never see it half-written
// — crew/daemon.mjs:872 "Workers publish their own atomically-renamed exit marker"
// — but the ENVELOPE, the one file that carries the run's outcome, is written in
// place by crew/child.mjs:157 and read with no tolerance for a torn read.
//
// The torn bytes here are the literal truncated prefix of the child's real
// envelope, and the child's write is then completed. Scratch daemon root only.

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { daemon } = await import(join(REPO, 'crew/daemon.mjs'))

const root = mkdtempSync('/tmp/h1r4-')
const crewDir = join(root, 'crew')
mkdirSync(join(crewDir, 'returns'), { recursive: true })
writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'h1-r4', checkout: root, members: { builder: { transport: 'headless-json' } } }))
const taskReturn = join(crewDir, 'returns', 'r-1.json')

// The child's real envelope — the run SUCCEEDED and committed.
const real = JSON.stringify({
  status: 'done', summary: 'Task h1-r4: built, suite green, committed.',
  artifacts: [join(crewDir, 'journal.jsonl')],
  details: { stages: ['build', 'suite', 'commit'], commit: 'abc1234', dissents: [] },
}, null, 2)
// The same bytes, caught mid-write: writeFileSync truncates first, then writes.
writeFileSync(taskReturn, real.slice(0, 120))

const registry = join(root, 'runs.jsonl')
const at = Date.now() - 60_000
appendFileSync(registry, `${JSON.stringify({ kind: 'enqueued', run_id: 'r-1', at, crew_dir: crewDir, task: 'h1-r4', suite: 'node --test', checkout: root, task_return: taskReturn, attempt: 1 })}\n`)
appendFileSync(registry, `${JSON.stringify({ kind: 'started', run_id: 'r-1', at: at + 1, child_pid: 999999 })}\n`)   // a pid that is gone

const d = daemon({ root, deps: { pollMs: 1_000_000 } })
await d.start()
console.log(`tick 1 (envelope torn)   : state=${JSON.stringify(d.state({ run: 'r-1' }))}  records=[${readFileSync(registry, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind).join(', ')}]`)
console.log(`tick 1 result()          : ${JSON.stringify(d.result({ run: 'r-1' }))}`)

// The child's write completes microseconds later. The envelope on disk is now the
// real, valid, successful one.
writeFileSync(taskReturn, real)
console.log(`envelope on disk now     : status=${JSON.parse(readFileSync(taskReturn, 'utf8')).status} commit=${JSON.parse(readFileSync(taskReturn, 'utf8')).details.commit}`)
d.poll(); d.poll()
console.log(`tick 2 (envelope valid)  : state=${JSON.stringify(d.state({ run: 'r-1' }))}  records=[${readFileSync(registry, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind).join(', ')}]`)
const listed1 = d.list()
console.log(`tick 2 list()            : ${JSON.stringify(listed1)}`)
await d.stop()

// And a restart does not repair it: 'orphaned' is a settled lifecycle.
const d2 = daemon({ root, deps: { pollMs: 1_000_000 } })
await d2.start()
d2.poll()
console.log(`after restart            : state=${JSON.stringify(d2.state({ run: 'r-1' }))}  records=[${readFileSync(registry, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind).join(', ')}]`)
console.log(`after restart list()     : ${JSON.stringify(d2.list())}`)
const records = readFileSync(registry, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
await d2.stop()

const orphaned = records.some((r) => r.kind === 'orphaned')
const settled = records.some((r) => r.kind === 'settled')
console.log('')
console.log('EXPECTED: an envelope that cannot be parsed is UNMEASURED, not absent — the next tick')
console.log('          re-reads it and the run settles as done (a `settled` record, the feed closed')
console.log('          with the real outcome, regrant eligibility evaluated).')
console.log(`OBSERVED: registry holds orphaned=${orphaned}, settled=${settled}. The successful run is recorded`)
console.log('          as orphaned forever, across a restart, while its own `done` envelope sits on disk.')
console.log(orphaned && !settled ? 'R4 REPRODUCED — a single torn read is a permanent, restart-proof wrong verdict' : 'R4 did not reproduce')
rmSync(root, { recursive: true, force: true })
process.exit(orphaned && !settled ? 0 : 1)
