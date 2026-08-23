#!/usr/bin/env node
// R6 — crew.json has three writers and two durability contracts. The two
// non-atomic ones publish a truncation window that every reader in the runtime
// parses with no tolerance and no retry; and every writer overwrites the whole
// file from its own private in-memory copy, so a concurrent update is lost.
//
//   ATOMIC   crew/seat-io.mjs:909-916  saveCrew: writeFileSync(tmp) + renameSync(tmp, p)
//            used by bootCmd (crew/crew.mjs:1637), seatIo.reseat (:2084), seatIo.showDoc (:2145)
//   NOT      crew/headless.mjs:178     if (fsExistsSync(file)) writeFileSync(file, JSON.stringify(crew, null, 2))
//   NOT      crew/headless-rpc.mjs:182 the same line again, a verbatim duplicate
//
//   readers, none of which tolerate a torn read:
//            crew/crew.mjs:315   loadCrew: JSON.parse(readFileSync(p,'utf8'))  -> THROWS
//                                (callers: runCmd :1724, statusCmd :2042, teardownCmd :2094)
//            crew/daemon.mjs:1082 JSON.parse(read(crew.json)) -> runError('invalid-spec')
//
// The seats that use the non-atomic writer are exactly the seats the daemon runs
// (pane transport is refused, crew/daemon.mjs:1084), and they write on every
// assignment that mints a session id (crew/headless.mjs:264, :303,
// crew/headless-rpc.mjs:398) — i.e. throughout a run, while `crew status`, the
// visualizer, a sibling seat and the daemon are all reading.
//
// Part 1 races a real second process against a real reader. Part 2 is the
// lost-update, which needs no race at all. Scratch dir only.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { saveCrew } = await import(join(REPO, 'crew/seat-io.mjs'))

const root = mkdtempSync('/tmp/h1r6-')
const paths = { dir: root }
const file = join(root, 'crew.json')
const crew = {
  task: 'h1-r6', checkout: root, workspace_id: 'ws-1',
  members: Object.fromEntries(['planner', 'builder', 'reviewer', 'lead'].map((role) => [role, {
    role, transport: 'headless-json', model: 'claude-sonnet-5', agent: role,
    session_id: null, surface_id: null, brief: `${role}.md`,
  }])),
  seats: { planner: { tier: 'build' }, builder: { tier: 'build' }, reviewer: { tier: 'judge' }, lead: { tier: 'judge' } },
}
writeFileSync(file, JSON.stringify(crew, null, 2))
console.log(`crew.json size: ${readFileSync(file, 'utf8').length} bytes`)

// ---- Part 1: the truncation window, measured across two processes ------------
const writerLoop = (mode) => spawn(process.execPath, ['-e', `
  const { writeFileSync, renameSync } = require('node:fs')
  const file = ${JSON.stringify(file)}
  const crew = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
  const deadline = Date.now() + 2000
  let n = 0
  while (Date.now() < deadline) {
    crew.members.builder.session_id = 'sess-' + (n++)
    ${mode === 'plain'
      // crew/headless.mjs:178 / crew/headless-rpc.mjs:182, verbatim discipline
      ? "writeFileSync(file, JSON.stringify(crew, null, 2))"
      // crew/seat-io.mjs:914-915, verbatim discipline
      : "writeFileSync(file + '.tmp', JSON.stringify(crew, null, 2)); renameSync(file + '.tmp', file)"}
  }
  process.stdout.write(String(n))
`], { stdio: ['ignore', 'pipe', 'inherit'] })

const measure = async (mode) => {
  const child = writerLoop(mode)
  let writes = ''
  child.stdout.on('data', (c) => { writes += c })
  let reads = 0, torn = 0, empty = 0
  const firstTorn = { text: null }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    reads += 1
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (text.length === 0) empty += 1
    try { JSON.parse(text) } catch (err) {
      torn += 1
      if (!firstTorn.text) firstTorn.text = `${err.message} | bytes read: ${text.length} | head: ${JSON.stringify(text.slice(0, 40))}`
    }
  }
  await new Promise((r) => child.once('exit', r))
  return { mode, reads, writes: Number(writes) || 0, torn, empty, firstTorn: firstTorn.text }
}

const plain = await measure('plain')
console.log(`\nplain writeFileSync (headless.mjs:178, headless-rpc.mjs:182)`)
console.log(`  reads=${plain.reads} writes=${plain.writes} TORN READS=${plain.torn} (of which zero-byte: ${plain.empty})`)
if (plain.firstTorn) console.log(`  first torn read: ${plain.firstTorn}`)
writeFileSync(file, JSON.stringify(crew, null, 2))
const atomic = await measure('atomic')
console.log(`\ntmp + renameSync (saveCrew, seat-io.mjs:914-915)`)
console.log(`  reads=${atomic.reads} writes=${atomic.writes} TORN READS=${atomic.torn} (of which zero-byte: ${atomic.empty})`)

// ---- Part 2: the lost update, no race required ------------------------------
writeFileSync(file, JSON.stringify(crew, null, 2))
// The forked child's headless seat loads crew.json and holds it in memory.
const seatCopy = JSON.parse(readFileSync(file, 'utf8'))
// Meanwhile the driver re-seats the reviewer a rung up and saves it atomically
// (seatIo.reseat -> saveCrew, crew/seat-io.mjs:2084).
const driverCopy = JSON.parse(readFileSync(file, 'utf8'))
driverCopy.members.reviewer.model = 'claude-opus-5'
driverCopy.seats.reviewer.tier = 'judge'
driverCopy.reseated = { role: 'reviewer', from: 'claude-sonnet-5', to: 'claude-opus-5' }
saveCrew(paths, driverCopy)
console.log(`\nafter the driver's reseat  : reviewer.model=${JSON.parse(readFileSync(file, 'utf8')).members.reviewer.model} reseated=${JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).reseated)}`)
// The seat now mints its session id and persists ITS copy — a full overwrite that
// never re-read the file (crew/headless.mjs:262-265).
seatCopy.members.builder.session_id = 'sess-abc'
writeFileSync(file, JSON.stringify(seatCopy, null, 2))
const after = JSON.parse(readFileSync(file, 'utf8'))
console.log(`after the seat's persist   : reviewer.model=${after.members.reviewer.model} reseated=${JSON.stringify(after.reseated ?? null)} builder.session_id=${JSON.stringify(after.members.builder.session_id)}`)

console.log('')
console.log('EXPECTED: one durability contract for one file — every writer publishes atomically, and a')
console.log('          read-modify-write of a shared file re-reads under a lock instead of overwriting.')
console.log(`OBSERVED: the plain writer produced ${plain.torn} unparseable reads in ${plain.reads} attempts;`)
console.log(`          the atomic writer produced ${atomic.torn}. Every reader of crew.json (loadCrew,`)
console.log(`          crew/crew.mjs:315) turns one of those into a throw, and teardownCmd is one of them.`)
console.log(`          Part 2: the driver's reseat survived on disk for one write and was then erased`)
console.log(`          by a seat that had never read it — with reseat's own save error swallowed anyway`)
console.log(`          (crew/seat-io.mjs:2084).`)
const reproduced = plain.torn > 0 && atomic.torn === 0 && after.reseated == null
console.log(reproduced ? 'R6 REPRODUCED — torn reads from the non-atomic writers, and a silently lost reseat' : 'R6 did not reproduce')
rmSync(root, { recursive: true, force: true })
process.exit(reproduced ? 0 : 1)
