// test/factory-emit-floor.test.mjs — the no-condition-excluded half of the
// emit.mjs suite. Runs identically on every Node major in the CI matrix (no
// node:sqlite is ever reached from this file — every ledger handle here is
// forced degraded via the injected-version seam openLedger({nodeVersion}),
// never by probing process.versions). This is the file that proves the
// deterministic below-floor seq collision (ledger.mjs's own nextSeq always
// seeds max=0 below floor) is prevented by the parent-side allocator, not
// by MAX(seq).
import { test as nodeTest, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './helpers.mjs'
import { openRun } from '../scripts/factory/emit.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'emit.mjs')
const SELF = fileURLToPath(import.meta.url)
const EMIT_SOURCE = readFileSync(SCRIPT, 'utf8')
const SELF_SOURCE = readFileSync(SELF, 'utf8')

// Thin test() wrapper: a module-level counter proves this file's tests did
// not silently vanish (mirrors factory-ledger-floor.test.mjs).
let registeredCount = 0
function test(name, optionsOrFn, maybeFn) {
  registeredCount += 1
  if (typeof optionsOrFn === 'function') {
    return nodeTest(name, optionsOrFn)
  }
  return nodeTest(name, optionsOrFn, maybeFn)
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-emit-floor-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

function freshDir(label) {
  return mkdtempSync(join(fixtureRoot, `${label}-`))
}

const BELOW_FLOOR_VERSION = '20.11.0'

test('BELOW-FLOOR COLLISION IS COVERED EXPLICITLY: two below-floor emitters never collide on seq and drop no JSONL line', () => {
  const dir = freshDir('below-floor-collision')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const jsonlPath = join(dir, 'ledger', 'ledger.jsonl')
  const e1 = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, nodeVersion: BELOW_FLOOR_VERSION, stderr: { write: () => {} },
  })
  const e2 = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, nodeVersion: BELOW_FLOOR_VERSION, stderr: { write: () => {} },
  })
  assert.equal(e1.adwId, e2.adwId)

  const ITER = 10
  const allSeqs = []
  for (let i = 0; i < ITER; i += 1) {
    for (const emitter of [e1, e2]) {
      const ok = emitter.emit((handle, nextSeq) => {
        const seq = nextSeq('event')
        allSeqs.push(seq)
        handle.recordEvent({ adw_id: emitter.adwId, type: 'log', seq, payload: { level: 'info', message: 'x' } })
      })
      assert.equal(ok, true, 'a below-floor emission unexpectedly failed')
    }
  }

  assert.equal(new Set(allSeqs).size, allSeqs.length, 'seq collided across two below-floor emitters sharing one adw_id')

  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const recordEventLines = lines.filter((l) => l.kind === 'recordEvent')
  assert.equal(recordEventLines.length, allSeqs.length, 'a JSONL line was dropped below floor')
  const seqsInJsonl = recordEventLines.map((l) => l.args.seq)
  assert.equal(new Set(seqsInJsonl).size, seqsInJsonl.length, 'a duplicate seq made it into the JSONL raw record')
})

test('below-floor emitter never touches node:sqlite: the mirror db file is never created', () => {
  const dir = freshDir('below-floor-no-sqlite')
  const dbPath = join(dir, 'ledger', 'ledger.db')
  const emitter = openRun({
    stateDir: dir, repoSlug: 'r', taskSlug: 't', dbPath, nodeVersion: BELOW_FLOOR_VERSION, stderr: { write: () => {} },
  })
  emitter.startRun()
  assert.equal(emitter.stats().dropped, 0)
  // The title's claim, asserted rather than argued: ledger.mjs's degraded
  // path short-circuits before the lazy node:sqlite require, so nothing may
  // exist at dbPath afterwards.
  assert.equal(existsSync(dbPath), false, 'the below-floor path must never create the mirror db file')
})

test('this file contains no node:test exclusion directive (self-assertion; word-boundary aware to tolerate "skipped" as a status value)', () => {
  const needle = ['s', 'k', 'i', 'p'].join('')
  const wordBoundary = new RegExp(`\\b${needle}\\b`, 'i')
  assert.ok(!wordBoundary.test(SELF_SOURCE), 'floor test file unexpectedly contains an exclusion token as a standalone word')
})

test('AC-13-style hygiene: this file never references the CLI-only default-db-path resolver by name', () => {
  const needle = ['default', 'Db', 'Path'].join('')
  assert.ok(!SELF_SOURCE.includes(needle), 'this file references the forbidden symbol')
  assert.ok(!EMIT_SOURCE.includes(needle), 'emit.mjs references the CLI-only default-db-path resolver')
})

after(() => {
  assert.ok(registeredCount >= 1, 'this floor test file registered zero tests')
})
