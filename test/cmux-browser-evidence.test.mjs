// browser-evidence.mjs (be-12-03, issue #12/D5, ADR-019) — the import-
// firewalled page-byte reducer for browser console output. Model:
// triage.mjs / test/cmux-ladder.test.mjs's one-directional firewall guard
// (:812-815) — this suite demonstrates BOTH directions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts', 'cmux')

const { BROWSER_ERRORS_CLEAN_LINE, reduceBrowserErrors } = await import(join(SCRIPTS_DIR, 'browser-evidence.mjs'))

// ---------------------------------------------------------------------------
// TEST-SET SUFFICIENCY — the two named degenerates (qa-notes 2026-08-02),
// killed explicitly below:
//   degenerate 1: clean <=> stdout === CLEAN_LINE (an includes()-based check
//     would wrongly call a superstring/substring of the literal clean)
//   degenerate 2: clean = !stdout.includes('[error]') (reads empty,
//     whitespace-only, null, and a raw `Error: js_error: ...` payload as
//     clean — the exact stacked-undrivable live failure this module exists
//     to prevent)
// ---------------------------------------------------------------------------

test('REDUCER CONTRACT: the clean literal, trimmed-equal, reduces to {clean:true,count:0,shape:"clean"}', () => {
  assert.deepEqual(reduceBrowserErrors(BROWSER_ERRORS_CLEAN_LINE), { clean: true, count: 0, shape: 'clean' })
  assert.deepEqual(reduceBrowserErrors(`  ${BROWSER_ERRORS_CLEAN_LINE}\n`), { clean: true, count: 0, shape: 'clean' })
})

test('REDUCER CONTRACT: >=1 line matching /^[error]/ reduces to {clean:false,count:N,shape:"errors"}', () => {
  assert.deepEqual(reduceBrowserErrors('[error] boom'), { clean: false, count: 1, shape: 'errors' })
  assert.deepEqual(
    reduceBrowserErrors('[error] one\n[error] two\n[error] three'),
    { clean: false, count: 3, shape: 'errors' },
  )
})

test('COUNT CORRECTNESS: a single [error] line with two non-matching continuation lines counts 1 (kills split(\'\\n\').length)', () => {
  const raw = '[error] boom\n    at foo.js:1\n    at bar.js:2'
  assert.deepEqual(reduceBrowserErrors(raw), { clean: false, count: 1, shape: 'errors' })
})

test('COUNT CORRECTNESS: three [error] lines count 3', () => {
  const raw = '[error] a\n[error] b\n[error] c'
  assert.deepEqual(reduceBrowserErrors(raw), { clean: false, count: 3, shape: 'errors' })
})

test('DEGENERATE KILLER: empty string is unrecognized + not clean (degenerate 2 would call this clean)', () => {
  assert.deepEqual(reduceBrowserErrors(''), { clean: false, count: null, shape: 'unrecognized' })
})

test('DEGENERATE KILLER: whitespace-only is unrecognized + not clean', () => {
  assert.deepEqual(reduceBrowserErrors('   \n\t  '), { clean: false, count: null, shape: 'unrecognized' })
})

test('DEGENERATE KILLER: null is unrecognized + not clean', () => {
  assert.deepEqual(reduceBrowserErrors(null), { clean: false, count: null, shape: 'unrecognized' })
})

test('DEGENERATE KILLER: a raw Error: js_error payload is unrecognized + not clean', () => {
  assert.deepEqual(
    reduceBrowserErrors('Error: js_error: Timed out waiting for the browser document to become ready'),
    { clean: false, count: null, shape: 'unrecognized' },
  )
})

test('DEGENERATE KILLER: a page-authored line CONTAINING the clean literal as a substring (not equal to it) is unrecognized (kills an includes() implementation)', () => {
  const raw = `console: ${BROWSER_ERRORS_CLEAN_LINE} (reported by app)`
  const result = reduceBrowserErrors(raw)
  assert.equal(result.shape, 'unrecognized')
  assert.equal(result.clean, false)
})

test('a non-string input (number, object, array) is unrecognized + not clean; function never throws', () => {
  for (const input of [42, {}, [], undefined, true]) {
    assert.deepEqual(reduceBrowserErrors(input), { clean: false, count: null, shape: 'unrecognized' })
  }
})

test('REDUCER shape is exactly {clean,count,shape} — no extra keys, no message text ever returned', () => {
  const result = reduceBrowserErrors('[error] boom')
  assert.deepEqual(Object.keys(result).sort(), ['clean', 'count', 'shape'])
  const json = JSON.stringify(result)
  assert.doesNotMatch(json, /boom/)
})

// ---------------------------------------------------------------------------
// IMPORT FIREWALL, both directions (AC: "the guard needs its own red").
// ---------------------------------------------------------------------------

const browserEvidenceSrc = readFileSync(join(SCRIPTS_DIR, 'browser-evidence.mjs'), 'utf8')

test('IMPORT FIREWALL (direction 1): browser-evidence.mjs contains no repo import at all', () => {
  assert.doesNotMatch(browserEvidenceSrc, /^import /m)
  assert.doesNotMatch(browserEvidenceSrc, /require\(/)
  // S10 (panel-1 S1): the static-import/require checks above would both
  // miss a dynamic import() or a bare re-export — reject those forms too.
  assert.doesNotMatch(browserEvidenceSrc, /\bimport\(/, 'no dynamic import() either')
  assert.doesNotMatch(browserEvidenceSrc, /\bfrom ['"]\.\.?\//, 'no relative-path import/re-export either')
  assert.doesNotMatch(browserEvidenceSrc, /^export \* from /m, 'no re-export either')
})

test('IMPORT FIREWALL (direction 2): no decision module (ladder.mjs, triage.mjs, contract.mjs) references browser-evidence.mjs', () => {
  for (const f of ['ladder.mjs', 'triage.mjs', 'contract.mjs']) {
    const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8')
    assert.doesNotMatch(src, /browser-evidence/, `${f} must never reference browser-evidence.mjs`)
  }
})

// ---------------------------------------------------------------------------
// SINGLE CALL SITE: browserErrorsList (cmuxctl.mjs) has exactly one call
// site outside its own definition, under scripts/cmux/.
// ---------------------------------------------------------------------------

function browserErrorsListCallSites() {
  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'))
  const sites = []
  for (const f of files) {
    const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8')
    for (const line of src.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) continue
      if (/export function browserErrorsList\(/.test(line)) continue
      if (/browserErrorsList\(/.test(line)) sites.push(`${f}: ${trimmed}`)
    }
  }
  return sites
}

test('SINGLE CALL SITE: browserErrorsList has exactly one call site outside its own definition under scripts/cmux/', () => {
  const sites = browserErrorsListCallSites()
  assert.equal(sites.length, 1, `expected exactly one call site, found: ${JSON.stringify(sites)}`)
})
