import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scratchDir } from './helpers.mjs'
import {
  CensusError,
  assertClassificationReason,
  classifyMutant,
  classifyMutants,
  discoverSurvivors,
  main,
  parseRunCount,
  runTranche,
  selectTranche,
  summarizeCensus,
} from '../scripts/factory/mutant-census.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CENSUS_CLI = join(HERE, '..', 'scripts', 'factory', 'mutant-census.mjs')

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

function inventory(root) {
  const entries = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) entries.push([full.slice(root.length + 1), readFileSync(full, 'utf8')])
    }
  }
  walk(root)
  return entries
}

// A1: the suite swaps the resolved target to an outside symlink after the mutant
// write; restore-time revalidation must refuse and leave outside bytes intact.
test('A1', async () => {
  const checkout = writeCheckout(scratchDir('mutant-census-a1-checkout-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const outside = writeCheckout(scratchDir('mutant-census-a1-outside-'), { 'only-copy.mjs': 'evidence-only-copy\n' })
  const target = join(checkout, 'src/widget.mjs')
  const evidence = join(outside, 'only-copy.mjs')
  await assert.rejects(
    runTranche([{ ...survivor('a1') }], {
      checkout,
      runSuite: async () => {
        unlinkSync(target)
        symlinkSync(evidence, target)
        return { status: 0 }
      },
    }),
    (err) => err instanceof CensusError && err.code === 'unsafe-target',
    'restore-time swap must throw unsafe-target',
  )
  assert.equal(readFileSync(evidence, 'utf8'), 'evidence-only-copy\n', 'outside evidence must stay unchanged')
})

// B1: the parent directory is replaced with a symlink to an outside directory
// between snapshot and write; the pre-write check must refuse and create nothing.
test('B1', async () => {
  const checkout = writeCheckout(scratchDir('mutant-census-b1-checkout-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const outside = scratchDir('mutant-census-b1-outside-')
  let swapped = false
  const row = { ...survivor('b1') }
  Object.defineProperty(row, 'original', {
    enumerable: true,
    configurable: true,
    get() {
      if (!swapped) {
        swapped = true
        renameSync(join(checkout, 'src'), join(checkout, 'moved-src'))
        symlinkSync(outside, join(checkout, 'src'))
      }
      return 'const marker = 1;'
    },
  })
  await assert.rejects(
    runTranche([row], { checkout, runSuite: async () => ({ status: 0 }) }),
    (err) => err instanceof CensusError && err.code === 'unsafe-target',
    'pre-write swap must throw unsafe-target',
  )
  let created = false
  try {
    readFileSync(join(outside, 'widget.mjs'))
    created = true
  } catch {}
  assert.equal(created, false, 'no leaf may be created outside the checkout')
})

// C1: a real SIGTERM to the real CLI while mutant bytes are installed must still
// restore pristine bytes, and the process must die by that same signal.
test('C1', async () => {
  const checkout = scratchDir('mutant-census-c1-checkout-')
  const corpus = scratchDir('mutant-census-c1-corpus-')
  writeCheckout(checkout, {
    'src/widget.mjs': 'const marker = 1;\n',
    'package.json': JSON.stringify({ scripts: { test: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"` } }),
  })
  writeReport(corpus, 'one.report.json', [survivor('c1')])
  const target = join(checkout, 'src/widget.mjs')
  const child = spawn(
    process.execPath,
    [CENSUS_CLI, '--corpus', corpus, '--checkout', checkout, '--run', '1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.resume()
  child.stderr.resume()
  const reap = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    const deadline = Date.now() + 15000
    let sawMutant = false
    while (Date.now() < deadline) {
      let bytes = ''
      try {
        bytes = readFileSync(target, 'utf8')
      } catch {}
      if (bytes.includes('marker = 2')) {
        sawMutant = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(sawMutant, true, 'mutant bytes were never observable before signalling')
    child.kill('SIGTERM')
    const termination = await Promise.race([
      reap,
      new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 10000)),
    ])
    assert.equal(termination.signal, 'SIGTERM', `expected SIGTERM termination, got ${JSON.stringify(termination)}`)
    assert.equal(readFileSync(target, 'utf8'), 'const marker = 1;\n', 'target must be byte-identical to pristine')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {}
      await reap
    }
  }
})

// D1: only decimal digit spellings are accepted; blank, hex, exponent, and
// decimal-point strings are closed refusals.
test('D1', () => {
  assert.equal(parseRunCount(0), 0)
  assert.equal(parseRunCount('0'), 0)
  assert.equal(parseRunCount('16'), 16)
  assert.equal(parseRunCount('007'), 7)
  for (const value of ['', '0x10', '1e2', '1.0']) {
    assert.throws(() => parseRunCount(value), (err) => err instanceof CensusError && err.code === 'run-invalid', `${JSON.stringify(value)} must throw run-invalid`)
  }
})

// E1: every summary line carries its exact numerator and denominator, with the
// Distinct line denominated by survived records rather than itself.
test('E1', () => {
  const discovery = { scanned: 5, readable: 4, survived: 8, distinct: 4 }
  const classified = [
    { ...survivor('e1-a'), reason: 'applies-once', runnable: true },
    { ...survivor('e1-b'), reason: 'applies-once', runnable: true },
    { ...survivor('e1-c'), reason: 'text-absent', runnable: false },
    { ...survivor('e1-d'), reason: 'text-ambiguous', runnable: false },
  ]
  const results = [
    { id: 'e1-a', path: 'src/widget.mjs', outcome: 'killed' },
    { id: 'e1-b', path: 'src/widget.mjs', outcome: 'unmeasured', reason: 'suite-indeterminate' },
  ]
  const summary = summarizeCensus({ discovery, classified, requested: 2, results })
  assert.deepEqual(summary.lines, [
    'Reports: 4 of 5 (80%)',
    'Survived records: 8',
    'Distinct: 4 of 8 (50%)',
    'Applies once: 2 of 4 (50%)',
    'Text absent: 1 of 4 (25%)',
    'Text ambiguous: 1 of 4 (25%)',
    'File absent: 0 of 4 (0%)',
    'Selected: 2 of 2 (100%)',
    'Killed: 1 of 1 (100%)',
    'Survived: 0 of 1 (0%)',
    'Execution unmeasured: 1 of 2 (50%)',
    'Applicable remainder: 0 of 2 (0%)',
  ])
})

// F1: the corpus is evidence with no second copy — classification, a safe run,
// path-swap refusals, and the overlap refusal must leave every corpus byte,
// name, and count untouched.
test('F1', async () => {
  const corpus = scratchDir('mutant-census-f1-corpus-')
  const checkout = writeCheckout(scratchDir('mutant-census-f1-checkout-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  writeReport(corpus, 'one.report.json', [survivor('f1')])
  writeCheckout(corpus, { 'src/widget.mjs': 'const marker = 1;\n', 'evidence.txt': 'only-copy\n' })
  const before = inventory(corpus)
  const discovered = discoverSurvivors(corpus)
  classifyMutants(discovered.rows, { checkout: corpus })
  const pristine = readFileSync(join(checkout, 'src/widget.mjs'))
  const safe = await runTranche([{ ...survivor('f1-safe') }], { checkout, runSuite: async () => ({ status: 0 }) })
  assert.deepEqual(safe.map((row) => row.outcome), ['survived'])
  assert.deepEqual(readFileSync(join(checkout, 'src/widget.mjs')), pristine)
  const outside = writeCheckout(scratchDir('mutant-census-f1-outside-'), { 'only-copy.mjs': 'evidence\n' })
  const linkCheckout = writeCheckout(scratchDir('mutant-census-f1-link-'), { 'src/keep.mjs': 'const keep = 1;\n' })
  symlinkSync(join(outside, 'only-copy.mjs'), join(linkCheckout, 'src/widget.mjs'))
  await assert.rejects(
    runTranche([{ ...survivor('f1-esc') }], { checkout: linkCheckout, runSuite: async () => ({ status: 0 }) }),
    (err) => err instanceof CensusError && err.code === 'unsafe-target',
  )
  let suiteRan = false
  await assert.rejects(
    main(['--corpus', corpus, '--checkout', corpus, '--run', '1'], {
      stdout: () => {},
      runSuite: () => {
        suiteRan = true
        return { status: 0 }
      },
    }),
    (err) => err instanceof CensusError && err.code === 'roots-overlap',
  )
  assert.equal(suiteRan, false, 'the overlapping run must refuse before any suite runs')
  assert.deepEqual(inventory(corpus), before, 'corpus inventory and bytes must be unchanged')
})

// Derived here, not review-prescribed: a mid-tranche restore refusal must name
// the residue (path + sha256), replace the meaningless verdict with a single
// restore-refused record, keep the completed rows on the error, and main must
// print that partial summary before the refusal propagates.
test('restore-refusal-keeps-partial-results', async () => {
  const checkout = writeCheckout(scratchDir('mutant-census-refusal-'), {
    'src/widget.mjs': 'const alpha = 1;\nconst beta = 1;\n',
  })
  const outside = writeCheckout(scratchDir('mutant-census-refusal-outside-'), { 'only-copy.mjs': 'evidence\n' })
  const target = join(checkout, 'src/widget.mjs')
  const evidence = join(outside, 'only-copy.mjs')
  const first = { id: 'r-1', path: 'src/widget.mjs', line: 1, operator: 'literal', original: 'const alpha = 1;', replacement: 'const alpha = 2;' }
  const second = { id: 'r-2', path: 'src/widget.mjs', line: 2, operator: 'literal', original: 'const beta = 1;', replacement: 'const beta = 2;' }
  let calls = 0
  const runSuite = async () => {
    calls += 1
    if (calls === 2) {
      unlinkSync(target)
      symlinkSync(evidence, target)
    }
    return { status: 1 }
  }
  const refusal = await runTranche([first, second], { checkout, runSuite }).then(
    () => { throw new Error('expected an unsafe-target refusal') },
    (err) => err,
  )
  assert.equal(refusal.code, 'unsafe-target')
  assert.match(refusal.detail ?? '', /mutant bytes remain at .*expected sha256 [0-9a-f]{64}/)
  assert.deepEqual(
    refusal.results.map((row) => [row.id, row.outcome, row.reason ?? null]),
    [['r-1', 'killed', null], ['r-2', 'unmeasured', 'restore-refused']],
  )
  assert.equal(readFileSync(evidence, 'utf8'), 'evidence\n')
  const corpus = scratchDir('mutant-census-refusal-corpus-')
  const checkout2 = writeCheckout(scratchDir('mutant-census-refusal-main-'), {
    'src/widget.mjs': 'const alpha = 1;\nconst beta = 1;\n',
  })
  writeReport(corpus, 'one.report.json', [
    { ...first, outcome: 'survived' },
    { ...second, outcome: 'survived' },
  ])
  const target2 = join(checkout2, 'src/widget.mjs')
  let mainCalls = 0
  const lines = []
  await assert.rejects(
    main(['--corpus', corpus, '--checkout', checkout2, '--run', '2'], {
      stdout: (line) => lines.push(line),
      runSuite: async () => {
        mainCalls += 1
        if (mainCalls === 2) {
          unlinkSync(target2)
          symlinkSync(evidence, target2)
        }
        return { status: 1 }
      },
    }),
    (err) => err instanceof CensusError && err.code === 'unsafe-target',
  )
  const partial = JSON.parse(lines[0])
  assert.deepEqual(
    partial.run.results.map((row) => [row.id, row.outcome, row.reason ?? null]),
    [['r-1', 'killed', null], ['r-2', 'unmeasured', 'restore-refused']],
  )
})

// A file deleted between mutants aborts the tranche at snapshotFile with a raw
// ENOENT: the completed rows must still travel on the error and main must
// still print the partial summary.
test('deleted-target-carries-partial-results', async () => {
  const first = { id: 'e-1', path: 'src/a.mjs', line: 1, operator: 'literal', original: 'const alpha = 1;', replacement: 'const alpha = 2;' }
  const second = { id: 'e-2', path: 'src/b.mjs', line: 2, operator: 'literal', original: 'const beta = 1;', replacement: 'const beta = 2;' }
  const checkout = writeCheckout(scratchDir('mutant-census-enoent-'), {
    'src/a.mjs': 'const alpha = 1;\n',
    'src/b.mjs': 'const beta = 1;\n',
  })
  const missing = await runTranche([first, second], {
    checkout,
    runSuite: async () => {
      unlinkSync(join(checkout, 'src/b.mjs'))
      return { status: 0 }
    },
  }).then(
    () => { throw new Error('expected an ENOENT abort') },
    (err) => err,
  )
  assert.equal(missing.code, 'ENOENT')
  assert.deepEqual(missing.results.map((row) => row.id), ['e-1'])
  const corpus = scratchDir('mutant-census-enoent-corpus-')
  const checkout2 = writeCheckout(scratchDir('mutant-census-enoent-main-'), {
    'src/a.mjs': 'const alpha = 1;\n',
    'src/b.mjs': 'const beta = 1;\n',
  })
  writeReport(corpus, 'one.report.json', [{ ...first, outcome: 'survived' }, { ...second, outcome: 'survived' }])
  const lines = []
  await assert.rejects(
    main(['--corpus', corpus, '--checkout', checkout2, '--run', '2'], {
      stdout: (line) => lines.push(line),
      runSuite: async () => {
        unlinkSync(join(checkout2, 'src/b.mjs'))
        return { status: 0 }
      },
    }),
    (err) => err.code === 'ENOENT',
  )
  assert.deepEqual(JSON.parse(lines[0]).run.results.map((row) => row.id), ['e-1'])
})

// A target replaced by a directory between write and restore fails the restore
// with a raw EISDIR: the original error (errno intact, never rewrapped as a
// CensusError) plus the residue context and the completed rows must reach the
// caller, and main must print the partial summary.
test('directory-target-carries-partial-results', async () => {
  const first = { id: 'd-1', path: 'src/a.mjs', line: 1, operator: 'literal', original: 'const alpha = 1;', replacement: 'const alpha = 2;' }
  const second = { id: 'd-2', path: 'src/b.mjs', line: 2, operator: 'literal', original: 'const beta = 1;', replacement: 'const beta = 2;' }
  const checkout = writeCheckout(scratchDir('mutant-census-eisdir-'), {
    'src/a.mjs': 'const alpha = 1;\n',
    'src/b.mjs': 'const beta = 1;\n',
  })
  const target = join(checkout, 'src/b.mjs')
  let calls = 0
  const blocked = await runTranche([first, second], {
    checkout,
    runSuite: async () => {
      calls += 1
      if (calls === 2) {
        unlinkSync(target)
        mkdirSync(target)
      }
      return { status: 0 }
    },
  }).then(
    () => { throw new Error('expected an EISDIR abort') },
    (err) => err,
  )
  assert.equal(blocked.code, 'EISDIR')
  assert.ok(!(blocked instanceof CensusError), 'a filesystem failure must not be rewrapped as a CensusError')
  assert.match(blocked.residue ?? '', /mutant bytes remain at .*expected sha256 [0-9a-f]{64}/)
  assert.deepEqual(blocked.results.map((row) => [row.id, row.outcome]), [['d-1', 'survived'], ['d-2', 'survived']])
  const corpus = scratchDir('mutant-census-eisdir-corpus-')
  const checkout2 = writeCheckout(scratchDir('mutant-census-eisdir-main-'), {
    'src/a.mjs': 'const alpha = 1;\n',
    'src/b.mjs': 'const beta = 1;\n',
  })
  writeReport(corpus, 'one.report.json', [{ ...first, outcome: 'survived' }, { ...second, outcome: 'survived' }])
  const target2 = join(checkout2, 'src/b.mjs')
  let mainCalls = 0
  const lines = []
  await assert.rejects(
    main(['--corpus', corpus, '--checkout', checkout2, '--run', '2'], {
      stdout: (line) => lines.push(line),
      runSuite: async () => {
        mainCalls += 1
        if (mainCalls === 2) {
          unlinkSync(target2)
          mkdirSync(target2)
        }
        return { status: 0 }
      },
    }),
    (err) => err.code === 'EISDIR',
  )
  assert.deepEqual(JSON.parse(lines[0]).run.results.map((row) => [row.id, row.outcome]), [['d-1', 'survived'], ['d-2', 'survived']])
})

// RV1-1: the corpus filter is the only thing keeping a non-report file out of the
// parser, and a fixture made only of *.report.json files cannot see it fail. The
// guard is TOP-LEVEL, not a subtest of A1: the hardening proof resolves a guard by
// its exact test name, and a nested name is reported as `A1 > …`, which is how this
// lane first escalated.
// MUTATION: blank CENSUS_REPORT_SUFFIX and notes.json is parsed as a report.
test('report-suffix-filter', () => {
  const guarded = scratchDir('mutant-census-suffix-')
  writeReport(guarded, 'only.report.json', [survivor('solo-1')])
  writeFileSync(join(guarded, 'notes.json'), '{}\n')
  const found = discoverSurvivors(guarded)
  assert.equal(found.scanned, 1)
  assert.deepEqual(found.rows.map((row) => row.id), ['solo-1'])
})

test('discovery-dedupes-survived-reports', () => {
  const corpus = scratchDir('mutant-census-discovery-')
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
  const clash = scratchDir('mutant-census-discovery-clash-')
  writeReport(clash, 'one.report.json', [survivor('dup-1')])
  writeReport(clash, 'two.report.json', [survivor('dup-1', { replacement: 'const marker = 3;' })])
  assert.throws(() => discoverSurvivors(clash), /duplicate-conflict/)
})

test('classification-reason-closed-set', () => {
  for (const reason of ['applies-once', 'text-absent', 'text-ambiguous', 'file-absent']) {
    assert.equal(assertClassificationReason(reason), reason)
  }
  assert.throws(() => assertClassificationReason('unknown-reason'), /classification-reason-invalid/)
  assert.throws(() => assertClassificationReason(''), /classification-reason-invalid/)
  const checkout = writeCheckout(scratchDir('mutant-census-classify-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const reasons = new Set([
    classifyMutant({ ...survivor('ok-1'), path: 'src/widget.mjs' }, { checkout }).reason,
    classifyMutant({ ...survivor('gone-1'), path: 'src/missing.mjs' }, { checkout }).reason,
  ])
  for (const reason of reasons) assert.ok(['applies-once', 'text-absent', 'text-ambiguous', 'file-absent'].includes(reason), reason)
})

test('classification-text-counts', () => {
  const checkout = writeCheckout(scratchDir('mutant-census-counts-'), {
    'src/widget.mjs': 'const marker = 1;\nconst marker = 1;\n',
  })
  const classified = classifyMutant({ ...survivor('amb-1'), path: 'src/widget.mjs' }, { checkout })
  assert.equal(classified.reason, 'text-ambiguous')
  assert.equal(classified.runnable, false)
  const single = writeCheckout(scratchDir('mutant-census-counts-single-'), { 'src/widget.mjs': 'const marker = 1;\nconst other = 2;\n' })
  const once = classifyMutant({ ...survivor('ok-1'), path: 'src/widget.mjs' }, { checkout: single })
  assert.equal(once.reason, 'applies-once')
  assert.equal(once.runnable, true)
})

test('tranche-orders-runnable-first', () => {
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

test('run-restores-bytes-across-verdicts', async () => {
  const checkout = writeCheckout(scratchDir('mutant-census-verdicts-'), { 'src/widget.mjs': 'const marker = 1;\n' })
  const abs = join(checkout, 'src/widget.mjs')
  const mutant = { ...survivor('run-1'), path: 'src/widget.mjs' }
  const pristine = readFileSync(abs)
  const pass = await runTranche([mutant], { checkout, runSuite: async () => ({ status: 0 }) })
  assert.deepEqual(pass.map((row) => row.outcome), ['survived'])
  assert.deepEqual(readFileSync(abs), pristine)
  const fail = await runTranche([mutant], { checkout, runSuite: async () => ({ status: 1 }) })
  assert.deepEqual(fail.map((row) => row.outcome), ['killed'])
  assert.deepEqual(readFileSync(abs), pristine)
  await assert.rejects(runTranche([mutant], { checkout, runSuite: () => { throw new Error('runner boom') } }), /runner boom/)
  assert.deepEqual(readFileSync(abs), pristine)
  const indeterminate = await runTranche([mutant], { checkout, runSuite: async () => ({ status: null, signal: 'SIGTERM' }) })
  assert.deepEqual(indeterminate.map((row) => row.outcome), ['unmeasured'])
  assert.deepEqual(readFileSync(abs), pristine)
})

// RV1-5 (Sol): containment was lexical, so a checkout file symlinked into the evidence
// corpus was mutated through the alias. ~/.crew is the only copy of that corpus.
// MUTATION: compare lexical paths instead of real ones and the escape is admitted.
test('symlink-escape-refused', async () => {
  const outside = writeCheckout(scratchDir('mutant-census-escape-evidence-'), { 'only-copy.mjs': 'const marker = 1;\n' })
  const checkout = writeCheckout(scratchDir('mutant-census-escape-'), { 'src/keep.mjs': 'const keep = 1;\n' })
  symlinkSync(join(outside, 'only-copy.mjs'), join(checkout, 'src/widget.mjs'))
  const evidence = readFileSync(join(outside, 'only-copy.mjs'))
  const mutant = { ...survivor('esc-1'), path: 'src/widget.mjs' }
  await assert.rejects(runTranche([mutant], { checkout, runSuite: async () => ({ status: 0 }) }), /unsafe-target/)
  assert.deepEqual(readFileSync(join(outside, 'only-copy.mjs')), evidence, 'evidence outside the checkout is never written')
})

// RV1-6 (Sol): main knew both roots and never compared them, so `--corpus X --checkout X
// --run 1` applied a discovered mutant to a file inside the evidence directory. That
// directory is the only copy. Classification stays allowed; only a mutating run refuses.
// MUTATION: drop assertDisjointRoots and the overlapping run is admitted.
test('roots-overlap-refuses-mutating-run', async () => {
  const shared = scratchDir('mutant-census-overlap-')
  writeReport(shared, 'one.report.json', [survivor('ov-1')])
  await assert.rejects(main(['--corpus', shared, '--checkout', shared, '--run', '1'], { stdout: () => {} }), /roots-overlap/)
  const classifyOnly = await main(['--corpus', shared, '--checkout', shared], { stdout: () => {} })
  assert.equal(classifyOnly.json.run.selected, 0, 'a read-only classification over the same root is still allowed')
})

test('summary-totals-shape', () => {
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
