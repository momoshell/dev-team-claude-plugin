import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { ROOT, scratchDir } from './helpers.mjs'
import {
  analyzeKills,
  buildMarkdown,
  classifyMutantOutcome,
  formatRate,
  main,
  MUTANT_UNMEASURED_REASONS,
  REASON,
  baselineCensus,
  mutantsForLines,
  parseTapKills,
  restoreSnapshot,
  sampleLineNumbers,
  snapshotFile,
} from '../scripts/factory/kill-redundancy.mjs'
import { generateDiffCandidates } from '../scripts/factory/prove-mutations.mjs'

test('subset kill-set is redundant and names its dominator', () => {
  const result = analyzeKills({ mutantResults: [
    { mutant: { id: 'm1' }, killers: ['suite :: broad'] },
    { mutant: { id: 'm2' }, killers: ['suite :: broad', 'suite :: narrow'] },
  ] })
  assert.equal(result.redundant.length, 1)
  assert.deepEqual(result.redundant[0], { candidate: 'suite :: narrow', kills: ['m2'], dominator: 'suite :: broad', dominatorKills: ['m1', 'm2'], status: 'redundancy-candidate' })
  const markdown = buildMarkdown({ ...result, sourceLines: [], wallClockSeconds: 1 })
  assert.match(markdown, /- suite :: broad dominates suite :: narrow: 1 of 2/)
})

test('equal kill-sets are not redundant', () => {
  const result = analyzeKills({ mutantResults: [
    { mutant: { id: 'm1' }, killers: ['a'] },
    { mutant: { id: 'm2' }, killers: ['a'] },
  ] })
  assert.equal(result.redundant.length, 0)
})

test('an empty observed kill-set is unmeasured with its closed reason', () => {
  const result = analyzeKills({
    mutantResults: [{ mutant: { id: 'm1' }, killers: ['a'] }],
    observedTests: ['a', 'silent'],
  })
  const silent = result.tests.find((test) => test.key === 'silent')
  assert.equal(silent.reason, 'sample-killed-nothing')
  assert.equal(silent.status, 'unmeasured')
})

test('survivors are retained and markdown labels the sample gap', () => {
  const result = analyzeKills({ mutantResults: [{ mutant: { id: 'm1', line: 1 }, killers: [], survivor: true }] })
  assert.deepEqual(result.survivors, ['m1'])
  const markdown = buildMarkdown({ ...result, sourceLines: ['function one() {}'], wallClockSeconds: 1 })
  assert.match(markdown, /Survivors \(gaps in this sample\)/)
  assert.doesNotMatch(markdown, /\bclear\b/i)
})

test('snapshot restores bytes after a throwing mutation', () => {
  const dir = scratchDir('kill-redundancy-snapshot-')
  const file = join(dir, 'drive.mjs')
  const original = Buffer.from('original bytes\n')
  writeFileSync(file, original)
  const snapshot = snapshotFile(file)
  try {
    writeFileSync(file, 'mutated bytes\n')
    throw new Error('fixture throw')
  } catch (error) {
    assert.equal(error.message, 'fixture throw')
  } finally {
    restoreSnapshot(snapshot)
  }
  assert.deepEqual(readFileSync(file), original)
  assert.equal(snapshot.sha256, snapshotFile(file).sha256)
})

test('no TAP output is unmeasured and never a survivor or kill', () => {
  const result = classifyMutantOutcome({ suiteOutputs: [{ stdout: '', stderr: '' }] })
  assert.deepEqual(result, { status: 'unmeasured', reason: 'no-tap-output', survivor: false, killers: [], observed: [], suitesMeasured: [] })
})

test('formatRate always carries its denominator', () => {
  assert.match(formatRate(2, 5), /\d+ of \d+/)
})

// G1: mutant generation is prove-mutations' (`generateDiffCandidates`), never a local
// operator table. Proven by behaviour, not by grepping the source for names: the tool's
// candidates for a line are byte-for-byte what prove-mutations generates for the same line.
test('mutant generation is delegated to prove-mutations: the same line yields the same candidates', () => {
  const target = 'crew/drive.mjs'
  const texts = ['  if (count > 0 && !stale) return left + right', "  const label = 'gate'"]
  const ours = mutantsForLines({ target, lines: [12, 40], texts })
  const theirs = generateDiffCandidates({ files: [{ path: target, added: [{ lineNumber: 12, text: texts[0] }, { lineNumber: 40, text: texts[1] }] }] })
  assert.ok(theirs.candidates.length > 0, 'the fixture lines must generate candidates')
  // The tool keeps the FIRST candidate per sampled line (its stated sample blind spot).
  const firstPerLine = theirs.candidates.filter((candidate, index) => theirs.candidates.findIndex((other) => other.line === candidate.line) === index)
  assert.deepEqual(ours.candidates, firstPerLine)
  assert.ok(ours.candidates.length >= 2, 'both sampled lines yield a candidate')
  assert.deepEqual(ours.skips, theirs.skips)
  assert.match(readFileSync(join(ROOT, 'scripts/factory/kill-redundancy.mjs'), 'utf8'), /generateDiffCandidates, applyDiffCandidate/)
})

// Node's TAP for ONE file: top-level records, subtests indented under `# Subtest:`, the
// parent's record after its children, and a file-level failure as a record titled by the
// file. Sol on #1401: the old parser expected a file wrapper that never exists in a
// single-file run, so every failure read as a survivor.
test('TAP is attributed to leaf tests by suite and subtest path; containers and file rows are not tests', () => {
  const text = [
    'TAP version 13', '# Subtest: passes', 'ok 1 - passes', '# Subtest: fails here', 'not ok 2 - fails here',
    '# Subtest: nested', '    # Subtest: inner ok', '    ok 1 - inner ok', '    # Subtest: inner fails', '    not ok 2 - inner fails', 'not ok 3 - nested',
    '1..3', '# tests 5', '# pass 2', '# fail 3',
  ].join('\n')
  const parsed = parseTapKills(text, 'crew/x.test.mjs')
  assert.deepEqual(parsed.killers, ['crew/x.test.mjs :: fails here', 'crew/x.test.mjs :: nested > inner fails'])
  assert.deepEqual(parsed.observed, ['crew/x.test.mjs :: passes', 'crew/x.test.mjs :: fails here', 'crew/x.test.mjs :: nested > inner ok', 'crew/x.test.mjs :: nested > inner fails'])
  assert.deepEqual([parsed.totals.tests, parsed.totals.fail, parsed.fileLevel, parsed.failedRecords], [5, 3, false, 3])
  // Node-shaped: several YAML fields precede exitCode inside the record's block.
  const crash = parseTapKills(['TAP version 13', '# Error: boom', '# Subtest: crash.test.mjs', 'not ok 1 - crash.test.mjs', '  ---', '  duration_ms: 41.2', "  location: 'test/crash.test.mjs:3:7'", "  failureType: 'subtestsFailed'", "  error: 'boom'", '  exitCode: 7', '  signal: ~', '  ...', '1..1', '# tests 1', '# fail 1'].join('\n'), 'test/crash.test.mjs')
  assert.deepEqual([crash.killers, crash.observed, crash.fileLevel], [[], [], true])
  const notCrash = parseTapKills(['TAP version 13', '# Subtest: crash.test.mjs', 'not ok 1 - crash.test.mjs', '  ---', "  error: 'assert'", '  ...', '1..1', '# tests 1', '# fail 1'].join('\n'), 'test/crash.test.mjs')
  assert.deepEqual([notCrash.killers, notCrash.fileLevel], [['test/crash.test.mjs :: crash.test.mjs'], false], 'no exitCode in the block: a test that happens to carry the file name')
  // Sol on #1401: a test that merely calls itself "x.test.mjs" is a test, not a file row.
  const named = parseTapKills(['TAP version 13', '# Subtest: named.test.mjs', 'ok 1 - named.test.mjs', '# Subtest: dir/other.test.mjs', 'not ok 2 - dir/other.test.mjs', '# Subtest: ordinary', 'ok 3 - ordinary', '1..3', '# tests 3', '# fail 1'].join('\n'), 'test/suite.test.mjs')
  assert.deepEqual([named.observed.length, named.killers, named.fileLevel], [3, ['test/suite.test.mjs :: dir/other.test.mjs'], false])
  // Directives: a skipped or TODO record measures nothing — not observed, never a kill —
  // and node's `# fail` excludes a TODO failure, which the reconciliation must match.
  const directives = parseTapKills(['TAP version 13', '# Subtest: a', 'ok 1 - a', '# Subtest: s', 'ok 2 - s # SKIP not today', '# Subtest: t', 'not ok 3 - t # TODO later', '1..3', '# tests 3', '# pass 1', '# fail 0', '# skipped 1', '# todo 1'].join('\n'), 'x')
  assert.deepEqual([directives.observed, directives.killers, directives.failedRecords, directives.totals.todo], [['x :: a'], [], 0, 1])
  assert.equal(parseTapKills('TAP version 13\nok 1 - x\n', 's'), null, 'no summary: not a finished run')
})

// Every way a suite run can finish without attributable outcomes is a closed unmeasured
// reason, never a survivor. Mutation killed: dropping any one of the four guards.
test('a mutant is measured only when every suite run finished with attributable outcomes', () => {
  const tap = (body, fail) => `TAP version 13\n${body}\n1..2\n# tests 2\n# pass ${2 - fail}\n# fail ${fail}\n`
  const ok = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0), stderr: '' }
  const killed = { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nnot ok 2 - b', 1), stderr: '' }
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok] }), { status: 'measured', survivor: true, killers: [], observed: ['s :: a', 's :: b'], suitesMeasured: ['s'] })
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok] }), { status: 'measured', survivor: true, killers: [], observed: ['s :: a', 's :: b'], suitesMeasured: ['s'] })
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok, killed] }).killers, ['s :: b'])
  const reasons = {
    'file-level-failure': { suite: 's', status: 1, stdout: 'TAP version 13\n# Subtest: s\nnot ok 1 - s\n  exitCode: 7\n1..1\n# tests 1\n# fail 1\n', stderr: '' },
    cancelled: { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nnot ok 2 - b', 1).replace('# fail 1', '# fail 1\n# cancelled 1'), stderr: '' },
    'failures-unattributed': { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 1), stderr: '' },
    // and the other direction: a failing record the footer does not count is the same lie
    'failures-unattributed ': { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nnot ok 2 - b', 0), stderr: '' },
    'suite-exit-unattributed': { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0), stderr: '' },
    'no-tap-output': { suite: 's', status: 0, stdout: '', stderr: '' },
  }
  for (const [reason, output] of Object.entries(reasons)) {
    const verdict = classifyMutantOutcome({ suiteOutputs: [ok, output] })
    assert.deepEqual([verdict.status, verdict.reason, verdict.survivor], ['unmeasured', reason.trim(), false], reason)
    assert.ok(MUTANT_UNMEASURED_REASONS.includes(reason.trim()), `${reason} is in the closed enum`)
  }
  // A TODO failure is not a kill and `# fail 0` reconciles: the mutant is measured, a survivor.
  const todo = { suite: 's', status: 0, stdout: 'TAP version 13\n# Subtest: a\nok 1 - a\n# Subtest: t\nnot ok 2 - t # TODO\n1..2\n# tests 2\n# pass 1\n# fail 0\n# todo 1\n', stderr: '' }
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [todo] }), { status: 'measured', survivor: true, killers: [], observed: ['s :: a'], suitesMeasured: ['s'] })
})

// Sol on #1401, pass 2: without a pristine census, a run that finished after only test A
// makes B's later kill-set a strict subset of A's. A mutant run measures the same thing as
// the baseline or it is unmeasured. Mutation killed: dropping the outcome-set comparison.
test('a mutant run whose observed set differs from the pristine baseline is unmeasured', () => {
  const tap = (body, fail, tests) => `TAP version 13\n${body}\n1..${tests}\n# tests ${tests}\n# pass ${tests - fail}\n# fail ${fail}\n`
  const pristine = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0, 2), stderr: '' }
  const census = baselineCensus(pristine)
  assert.deepEqual(census, { suite: 's', status: 'measured', reason: null, observed: ['s :: a', 's :: b'] })
  const baselines = new Map([['s', census.observed]])
  const truncated = { suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' }
  assert.deepEqual([classifyMutantOutcome({ suiteOutputs: [truncated], baselines }).reason, classifyMutantOutcome({ suiteOutputs: [truncated] }).status], ['outcome-set-differs', 'measured'])
  const full = { suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a\n# Subtest: b\nok 2 - b', 1, 2), stderr: '' }
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [full], baselines }).killers, ['s :: a'])
  const red = baselineCensus({ suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' })
  assert.deepEqual([red.status, red.reason, MUTANT_UNMEASURED_REASONS.includes(red.reason)], ['unmeasured', 'baseline-red', true])
  // Sol on #1401, pass 3: occurrence identity. Two tests titled the same are two tests; a
  // run that dropped one, or reordered them, measured something else.
  const twin = baselineCensus({ suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nok 2 - same\n# Subtest: b\nok 3 - b', 0, 3), stderr: '' })
  assert.deepEqual(twin.observed, ['s :: same', 's :: same#2', 's :: b'])
  const twins = new Map([['s', twin.observed]])
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 1, stdout: tap('# Subtest: same\nnot ok 1 - same\n# Subtest: b\nok 2 - b', 1, 2), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'a duplicate dropped')
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 0, stdout: tap('# Subtest: b\nok 1 - b\n# Subtest: same\nok 2 - same\n# Subtest: same\nok 3 - same', 0, 3), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'reordered')
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nok 2 - same\n# Subtest: c\nok 3 - c', 0, 3), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'a title the mutant changed')
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 1, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nnot ok 2 - same\n# Subtest: b\nok 3 - b', 1, 3), stderr: '' }], baselines: twins }).killers, ['s :: same#2'], 'the second twin is the killer')
})

// Every unmeasured path, table-tested for membership in the one closed source (Sol on
// #1401, pass 3: the enum listed every value but nothing tied the emit sites to it).
// Mutation killed: any emit site spelling a literal outside REASON.
test('every unmeasured path emits a reason from the closed source', () => {
  const tap = (body, fail, tests) => `TAP version 13\n${body}\n1..${tests}\n# tests ${tests}\n# pass ${tests - fail}\n# fail ${fail}\n`
  const ok = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a', 0, 1), stderr: '' }
  const paths = {
    'suite-missing': [{ suite: 's', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }],
    'spawn-denied': [{ suite: 's', error: Object.assign(new Error('x'), { code: 'EACCES' }) }],
    timeout: [{ suite: 's', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }],
    interrupted: [{ suite: 's', signal: 'SIGINT', stdout: '', stderr: '' }],
    'no-tap-output': [{ suite: 's', status: 0, stdout: 'garbage', stderr: '' }],
    'file-level-failure': [{ suite: 's', status: 1, stdout: 'TAP version 13\n# Subtest: s\nnot ok 1 - s\n  ---\n  exitCode: 7\n  ...\n1..1\n# tests 1\n# fail 1\n', stderr: '' }],
    cancelled: [{ suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1).replace('# fail 1', '# fail 1\n# cancelled 1'), stderr: '' }],
    'failures-unattributed': [{ suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a', 1, 1), stderr: '' }],
    'suite-exit-unattributed': [{ suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a', 0, 1), stderr: '' }],
    'outcome-set-differs': [{ suite: 's', status: 0, stdout: tap('# Subtest: b\nok 1 - b', 0, 1), stderr: '' }],
  }
  const baselines = new Map([['s', ['s :: a']]])
  for (const [reason, suiteOutputs] of Object.entries(paths)) {
    const verdict = classifyMutantOutcome({ suiteOutputs, baselines })
    assert.equal(verdict.status, 'unmeasured', reason)
    assert.equal(verdict.reason, reason)
    assert.ok(MUTANT_UNMEASURED_REASONS.includes(verdict.reason), `${reason} is in the closed source`)
  }
  assert.equal(classifyMutantOutcome({ suiteOutputs: [ok], baselines }).status, 'measured')
  assert.equal(baselineCensus({ suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' }).reason, 'baseline-red')
  assert.deepEqual(Object.values(REASON).sort(), [...MUTANT_UNMEASURED_REASONS].sort())
  assert.equal(MUTANT_UNMEASURED_REASONS.length, 12)
})

// End to end with a positive candidate, through --out: the JSON serializes the record
// (Sol on #1401: it threw on the removed key) and the markdown names the dominator.
// Mutation killed: serializing entry.key / entry.dominatedBy again.
// Sol on #1401, pass 3: a suite whose baseline is red is excluded from the mutant runs, and
// the rates must say so — the denominator is every configured suite per mutant, not the
// eligible ones. Mutation killed: totalling the eligible runs instead.
test('a baseline-red suite stays in the denominator and is named in the report', () => {
  const dir = scratchDir('kr-red-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), ['export const a = 1', 'export function f(x) { return x + 1 }', ''].join('\n'))
  const tap = (fails) => `TAP version 13\n# Subtest: A\n${fails ? 'not ok' : 'ok'} 1 - A\n1..1\n# tests 1\n# pass ${fails ? 0 : 1}\n# fail ${fails ? 1 : 0}\n`
  const spawnSync = (_bin, args) => { const suite = args[args.length - 1]; return suite === 'red' ? { status: 1, stdout: tap(true), stderr: '' } : { status: 0, stdout: tap(false), stderr: '' } }
  assert.equal(main(['--mutants', '2', '--seed', '1', '--suites', 'good', '--suites', 'red', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync }), 0)
  const report = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))
  assert.deepEqual(report.baselines.map((b) => [b.suite, b.status, b.reason]), [['good', 'measured', null], ['red', 'unmeasured', 'baseline-red']])
  assert.equal(report.suiteRuns.total, 2 * report.sampledMutants, 'both configured suites count for every mutant')
  assert.equal(report.suiteRuns.measured, report.sampledMutants, 'only the eligible suite ran')
  const md = readFileSync(join(dir, 'k.md'), 'utf8')
  assert.match(md, /- red: unmeasured \(baseline-red\)/)
  assert.match(md, new RegExp(`Suite runs measured: ${report.sampledMutants} of ${2 * report.sampledMutants} `))
})

test('a redundancy candidate survives --out serialization and is named in the report', () => {
  const dir = scratchDir('kr-e2e-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), ['export const a = 1', 'export function f(x) { return x + 1 }', 'export const b = a + 2', 'export function g(y) { return y * 2 }', ''].join('\n'))
  const tap = (fails) => `TAP version 13\n# Subtest: A\n${fails.includes('A') ? 'not ok' : 'ok'} 1 - A\n# Subtest: B\n${fails.includes('B') ? 'not ok' : 'ok'} 2 - B\n1..2\n# tests 2\n# pass ${2 - fails.length}\n# fail ${fails.length}\n`
  let runs = 0
  // Run 1 is the pristine baseline; odd mutants are killed by A alone, even ones by A and B,
  // so B's sampled kill-set is a strict subset of A's once two mutants ran.
  const spawnSync = () => { runs += 1; const fails = runs === 1 ? [] : runs % 2 === 0 ? ['A'] : ['A', 'B']; return { status: fails.length ? 1 : 0, stdout: tap(fails), stderr: '' } }
  const code = main(['--mutants', '4', '--seed', '3', '--suites', 's', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync })
  assert.equal(code, 0)
  const report = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))
  assert.ok(report.sampling.selectedCandidates >= 2, `at least two mutants: ${JSON.stringify(report.sampling)}`)
  assert.ok(runs >= 3, `baseline plus mutants ran: ${runs}`)
  assert.equal(report.redundant.length, 1, JSON.stringify(report.redundant))
  assert.deepEqual([report.redundant[0].candidate, report.redundant[0].dominator, report.redundant[0].status], ['s :: B', 's :: A', 'redundancy-candidate'])
  assert.deepEqual(report.baselines, [{ suite: 's', status: 'measured', reason: null, tests: 2 }])
  assert.deepEqual(report.suiteRuns, { measured: report.sampledMutants, total: report.sampledMutants }, 'one configured suite per mutant, every run measured')
  const md = readFileSync(join(dir, 'k.md'), 'utf8')
  assert.match(md, /- s :: A dominates s :: B: \d+ of \d+ \(/)
  assert.ok(md.includes(`Sample blind spot: only the first generated candidate per sampled line was measured (${report.sampling.selectedCandidates} of ${report.sampling.generatedCandidates} (`), 'the blind-spot line states selected of generated')
})

test('a zero denominator is stated as unmeasured, never as 0%', () => {
  assert.equal(formatRate(0, 0), '0 of 0 (unmeasured: denominator 0)')
  assert.equal(formatRate(1, 4), '1 of 4 (25%)')
})

// Mutation killed: xorshift from state zero — every seed then picks the first line of each
// stratum, and seeds 0 and 1 no longer differ.
test('sampling is deterministic per seed and distinct across seeds, including seed 0', () => {
  const a = sampleLineNumbers({ lineCount: 5000, count: 40, seed: 0 })
  assert.deepEqual(sampleLineNumbers({ lineCount: 5000, count: 40, seed: 0 }), a)
  assert.notDeepEqual(sampleLineNumbers({ lineCount: 5000, count: 40, seed: 1 }), a)
  assert.notDeepEqual(a, sampleLineNumbers({ lineCount: 5000, count: 40, seed: 0 }).map((_, i) => Math.floor(i * 5000 / 40) + 1), 'seed 0 is not the stratum floor')
})

test('the sampling report states every count the selection dropped', () => {
  const { sampling } = mutantsForLines({ target: 'crew/drive.mjs', lines: [1, 2, 3], texts: ['  if (a > 0 && b) return c + 1', '', '  const x = y === z ? 1 : 2'] })
  assert.equal(sampling.sampledLines, 3)
  assert.equal(sampling.skippedLines, sampling.sampledLines - sampling.candidateLines)
  assert.equal(sampling.omittedCandidates, sampling.generatedCandidates - sampling.selectedCandidates)
  assert.ok(sampling.candidateLines >= 1 && sampling.selectedCandidates === sampling.candidateLines)
})

test('CLI usage errors return two', () => {
  const stderr = { write: () => {} }
  assert.equal(main(['--help'], { stderr }), 2)
  assert.equal(main(['--unknown'], { stderr }), 2)
  assert.equal(main(['--mutants', '0'], { stderr }), 2)
})

// D1b, measured on a scratch checkout: SIGINT while a mutant is in the target restores the
// original bytes at that instant, then re-raises through the injected kill. The signal
// arrives on an injected emitter: node --test's child listens for SIGINT on process and
// aborts the file. Mutation: `signals.on('SIGINT', () => {})` in main — the read at the
// interrupt then still sees the mutant and nothing is re-raised.
test('SIGINT mid-mutant restores the target before the process re-raises the signal', () => {
  const dir = scratchDir('kr-sigint-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  const target = join(dir, 'crew', 'drive.mjs')
  const original = Buffer.from(['export const a = 1', 'export function f(x) { return x + 1 }', 'export const b = a + 2', ''].join('\n'))
  writeFileSync(target, original)
  const raised = []
  const signals = new EventEmitter()
  let calls = 0
  let seenMutated = false
  // Sol on #1401: read the bytes AT THE KILL, not after the emit returns — that is the
  // instant the process would die. And the self-signal re-enters the emitter: the removed
  // listener must not fire again.
  const kill = (pid, signal) => { raised.push([pid, signal, readFileSync(target).equals(original)]); signals.emit('SIGINT') }
  const spawnSync = () => {
    calls += 1
    if (raised.length === 0) { seenMutated = !readFileSync(target).equals(original); signals.emit('SIGINT') }
    return { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# fail 0\n', stderr: '' }
  }
  for (let seed = 0; seed < 10 && calls === 0; seed += 1) {
    main(['--mutants', '1', '--seed', String(seed), '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync, signals, kill })
  }
  assert.ok(calls > 0, 'no seed in 0..9 reached the suite runner')
  assert.equal(seenMutated, true, 'the runner must see the mutant in the target')
  assert.deepEqual(raised, [[process.pid, 'SIGINT', true]], 'exactly one re-raise, with the original bytes already restored at that instant')
  assert.ok(readFileSync(target).equals(original))
})
