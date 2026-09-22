import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import {
  assertClassificationReason,
  classifyMutant,
  discoverSurvivors,
  main,
  runTranche,
  selectTranche,
  summarizeCensus,
} from '../scripts/factory/mutant-census.mjs'

function writeReport(dir, name, mutants) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify({ mutants })}\n`)
  return path
}

function survivor(id, overrides = {}) {
  return {
    id,
    path: 'src/widget.mjs',
    line: 3,
    operator: 'literal',
    original: 'const marker = 1;',
    replacement: 'const marker = 2;',
    outcome: 'survived',
    ...overrides,
  }
}

function writeCheckout(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

// RV1-1: the corpus filter is the only thing keeping a non-report file out of the
// parser, and a fixture made only of *.report.json files cannot see it fail. The
// guard is TOP-LEVEL, not a subtest of A1: the hardening proof resolves a guard by
// its exact test name, and a nested name is reported as `A1 > …`, which is how this
// lane first escalated.
// MUTATION: blank CENSUS_REPORT_SUFFIX and notes.json is parsed as a report.
test('RV1-1-report-suffix', () => {
  const guarded = scratchDir('mutant-census-rv11-')
  writeReport(guarded, 'only.report.json', [survivor('solo-1')])
  writeFileSync(join(guarded, 'notes.json'), '{}\n')
  const found = discoverSurvivors(guarded)
  assert.equal(found.scanned, 1)
  assert.deepEqual(found.rows.map((row) => row.id), ['solo-1'])
})

test('A1', () => {
  const corpus = scratchDir('mutant-census-a1-')
  const shared = survivor('dup-1')
  writeReport(corpus, 'one.report.json', [shared, survivor('aaa-1'), { ...survivor('kill-1'), outcome: 'killed' }])
  writeReport(corpus, 'two.report.json', [{ ...shared }, survivor('zzz-9'), { id: 'skip-1', outcome: 'skipped' }])
  writeFileSync(join(corpus, 'notes.json'), '{}\n')
  const discovery = discoverSurvivors(corpus)
  assert.deepEqual(discovery.rows.map((row) => row.id), ['aaa-1', 'dup-1', 'zzz-9'])
  assert.equal(discovery.rows.filter((row) => row.id === 'dup-1').length, 1)
  assert.deepEqual(
    { scanned: discovery.scanned, readable: discovery.readable, survived: discovery.survived, distinct: discovery.distinct },
    { scanned: 2, readable: 2, survived: 4, distinct: 3 },
  )
  const clash = scratchDir('mutant-census-a1-clash-')
  writeReport(clash, 'one.report.json', [survivor('dup-1')])
  writeReport(clash, 'two.report.json', [survivor('dup-1', { replacement: 'const marker = 3;' })])
  assert.throws(() => discoverSurvivors(clash), /duplicate-conflict/)
})

test('B1', () => {
  for (const reason of ['applies-once', 'text-absent', 'text-ambiguous', 'file-absent']) {
    assert.equal(assertClassificationReason(reason), reason)
  }
  assert.throws(() => assertClassificationReason('unknown-reason'), /classification-reason-invalid/)
  assert.throws(() => assertClassificationReason(''), /classification-reason-invalid/)
  const checkout = writeCheckout(scratchDir('mutant-census-b1-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const reasons = new Set([
    classifyMutant({ ...survivor('ok-1'), path: 'src/widget.mjs' }, { checkout }).reason,
    classifyMutant({ ...survivor('gone-1'), path: 'src/missing.mjs' }, { checkout }).reason,
  ])
  for (const reason of reasons) assert.ok(['applies-once', 'text-absent', 'text-ambiguous', 'file-absent'].includes(reason), reason)
})

test('C1', () => {
  const checkout = writeCheckout(scratchDir('mutant-census-c1-'), {
    'src/widget.mjs': 'const marker = 1;\nconst marker = 1;\n',
  })
  const classified = classifyMutant({ ...survivor('amb-1'), path: 'src/widget.mjs' }, { checkout })
  assert.equal(classified.reason, 'text-ambiguous')
  assert.equal(classified.runnable, false)
  const single = writeCheckout(scratchDir('mutant-census-c1-single-'), { 'src/widget.mjs': 'const marker = 1;\nconst other = 2;\n' })
  const once = classifyMutant({ ...survivor('ok-1'), path: 'src/widget.mjs' }, { checkout: single })
  assert.equal(once.reason, 'applies-once')
  assert.equal(once.runnable, true)
})

test('D1', () => {
  const classified = [
    { ...survivor('m-3'), runnable: true, reason: 'applies-once' },
    { ...survivor('m-1'), runnable: true, reason: 'applies-once' },
    { ...survivor('m-4'), runnable: false, reason: 'text-absent' },
    { ...survivor('m-2'), runnable: true, reason: 'applies-once' },
  ]
  const first = selectTranche(classified, 2).map((row) => row.id)
  const second = selectTranche([...classified].reverse(), 2).map((row) => row.id)
  assert.deepEqual(first, ['m-1', 'm-2'])
  assert.deepEqual(second, first)
  assert.ok(first.length <= Math.min(2, 3))
  assert.deepEqual(selectTranche(classified, 0), [])
  assert.deepEqual(selectTranche(classified, 99).map((row) => row.id), ['m-1', 'm-2', 'm-3'])
})

test('E1', () => {
  const checkout = writeCheckout(scratchDir('mutant-census-e1-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const abs = join(checkout, 'src/widget.mjs')
  const mutant = { ...survivor('run-1'), path: 'src/widget.mjs' }
  const pristine = readFileSync(abs)
  const pass = runTranche([mutant], { checkout, runSuite: () => ({ status: 0 }) })
  assert.deepEqual(pass.map((row) => row.outcome), ['survived'])
  assert.deepEqual(readFileSync(abs), pristine)
  const fail = runTranche([mutant], { checkout, runSuite: () => ({ status: 1 }) })
  assert.deepEqual(fail.map((row) => row.outcome), ['killed'])
  assert.deepEqual(readFileSync(abs), pristine)
  assert.throws(() => runTranche([mutant], { checkout, runSuite: () => { throw new Error('runner boom') } }), /runner boom/)
  assert.deepEqual(readFileSync(abs), pristine)
  const indeterminate = runTranche([mutant], { checkout, runSuite: () => ({ status: null, signal: 'SIGTERM' }) })
  assert.deepEqual(indeterminate.map((row) => row.outcome), ['unmeasured'])
  assert.deepEqual(readFileSync(abs), pristine)
})

// RV1-5 (Sol): containment was lexical, so a checkout file symlinked into the evidence
// corpus was mutated through the alias. ~/.crew is the only copy of that corpus.
// MUTATION: compare lexical paths instead of real ones and the escape is admitted.
test('RV1-5-symlink-escape-refused', () => {
  const outside = writeCheckout(scratchDir('mutant-census-rv15-evidence-'), { 'only-copy.mjs': 'const marker = 1;\n' })
  const checkout = writeCheckout(scratchDir('mutant-census-rv15-'), { 'src/keep.mjs': 'const keep = 1;\n' })
  symlinkSync(join(outside, 'only-copy.mjs'), join(checkout, 'src/widget.mjs'))
  const evidence = readFileSync(join(outside, 'only-copy.mjs'))
  const mutant = { ...survivor('esc-1'), path: 'src/widget.mjs' }
  assert.throws(() => runTranche([mutant], { checkout, runSuite: () => ({ status: 0 }) }), /unsafe-target/)
  assert.deepEqual(readFileSync(join(outside, 'only-copy.mjs')), evidence, 'evidence outside the checkout is never written')
})

// RV1-6 (Sol): main knew both roots and never compared them, so `--corpus X --checkout X
// --run 1` applied a discovered mutant to a file inside the evidence directory. That
// directory is the only copy. Classification stays allowed; only a mutating run refuses.
// MUTATION: drop assertDisjointRoots and the overlapping run is admitted.
test('RV1-6-roots-overlap-refused', () => {
  const shared = scratchDir('mutant-census-rv16-')
  writeReport(shared, 'one.report.json', [survivor('ov-1')])
  assert.throws(() => main(['--corpus', shared, '--checkout', shared, '--run', '1'], { stdout: () => {} }), /roots-overlap/)
  const classifyOnly = main(['--corpus', shared, '--checkout', shared], { stdout: () => {} })
  assert.equal(classifyOnly.json.run.selected, 0, 'a read-only classification over the same root is still allowed')
})

test('F1', () => {
  const discovery = { scanned: 2, readable: 2, survived: 4, distinct: 3 }
  const classified = [
    { ...survivor('m-1'), reason: 'applies-once', runnable: true },
    { ...survivor('m-2'), reason: 'applies-once', runnable: true },
    { ...survivor('m-3'), reason: 'text-absent', runnable: false },
    { ...survivor('m-4'), reason: 'text-ambiguous', runnable: false },
  ]
  const results = [
    { id: 'm-1', path: 'src/widget.mjs', outcome: 'killed' },
    { id: 'm-2', path: 'src/widget.mjs', outcome: 'unmeasured', reason: 'suite-indeterminate' },
  ]
  const summary = summarizeCensus({ discovery, classified, requested: 2, results })
  const run = summary.json.run
  assert.deepEqual(
    { requested: run.requested, applicable: run.applicable, selected: run.selected, measured: run.measured, killed: run.killed, survived: run.survived, execution_unmeasured: run.execution_unmeasured, applicable_remainder: run.applicable_remainder },
    { requested: 2, applicable: 2, selected: 2, measured: 1, killed: 1, survived: 0, execution_unmeasured: 1, applicable_remainder: 0 },
  )
  assert.equal(run.measured, run.killed + run.survived)
  assert.equal(run.applicable_remainder, run.applicable - run.selected)
  assert.ok(run.selected <= Math.min(run.requested, run.applicable))
  assert.deepEqual(summary.json.classification, { distinct: 4, applies_once: 2, text_absent: 1, text_ambiguous: 1, file_absent: 0 })
  // The doctrine is that a RATE carries its denominator, not that every line must be
  // shaped like one. Demanding `N of M` everywhere is what produced `Survived records:
  // 230 of 230 (100%)` — a count wearing a manufactured denominator, which reads as
  // "all records survived". So: any line that IS a rate must carry both numbers, and a
  // rate may never denominate itself by the field it counts.
  // MUTATION: restore formatRate(survived, survived) and the self-denominated check fails.
  for (const line of summary.lines) {
    if (!line.includes(' of ')) continue
    assert.match(line, /\d+ of \d+/, `rate without denominator: ${line}`)
  }
  const survivedLine = summary.lines.find((line) => line.startsWith('Survived records:'))
  assert.equal(survivedLine, `Survived records: ${discovery.survived}`, 'survived records is a count and has no denominator to report')
  assert.doesNotMatch(survivedLine, / of /, 'a count must not be dressed as a rate')
  assert.ok(summary.lines.some((line) => line.startsWith('Applicable remainder:')), 'missing applicable remainder line')
  assert.ok(summary.lines.some((line) => line.startsWith('Execution unmeasured:')), 'missing execution unmeasured line')
})
