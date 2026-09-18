import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { ROOT, scratchDir, git, gitResult } from './helpers.mjs'
import {
  analyzeKills,
  buildMarkdown,
  classifyMutantOutcome,
  formatRate,
  main,
  ISOLATION_PREFIX,
  RECLAIM_SKIPPED,
  ownerRecordPath,
  MUTANT_UNMEASURED_REASONS,
  reclaimAbandoned,
  REASON,
  TERMINATION_SIGNALS,
  baselineCensus,
  mutantsForLines,
  parseTapKills,
  restoreSnapshot,
  sampleLineNumbers,
  snapshotFile,
} from '../scripts/factory/kill-redundancy.mjs'
import { generateDiffCandidates } from '../scripts/factory/prove-mutations.mjs'

// The identity production code builds: [suite, subtest path, occurrence]. Tests name tests
// the way a reader does and encode here, so a change of encoding is one edit, not thirty.
const id = (suite, path, occurrence = 1) => JSON.stringify([suite, Array.isArray(path) ? path : [path], occurrence])

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

// Survivors are grouped by the enclosing DECLARATION, never by a call, keyword or string on
// a nearer line. Mutation killed: the call-shaped fallback regex (`if`, `Error` groups).
test('survivors group by enclosing declaration, not by the nearest call or keyword', () => {
  const lines = ['export function documentStringLiterals(x) {', '  const s = "DISCRIMINATE(" + x', '  if (x) throw new Error(s)', '  return s', '}', 'const arrow = (y) => {', '  foo(y)', '}']
  const result = analyzeKills({ mutantResults: [{ mutant: { id: 'm1', line: 3 }, killers: [], survivor: true }, { mutant: { id: 'm2', line: 7 }, killers: [], survivor: true }] })
  const markdown = buildMarkdown({ ...result, sourceLines: lines, wallClockSeconds: 1 })
  assert.match(markdown, /- documentStringLiterals: 1 of 2/)
  assert.match(markdown, /- arrow: 1 of 2/)
  assert.doesNotMatch(markdown, /- (if|Error|DISCRIMINATE|foo):/)
  assert.match(markdown, /best-effort/)
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
  assert.deepEqual(result, { status: 'unmeasured', reason: 'no-tap-output', survivor: false, killers: [], observed: [], labels: {}, suitesMeasured: [] })
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
  assert.deepEqual(parsed.killers, [id('crew/x.test.mjs', 'fails here'), id('crew/x.test.mjs', ['nested', 'inner fails'])])
  assert.deepEqual(parsed.observed, [id('crew/x.test.mjs', 'passes'), id('crew/x.test.mjs', 'fails here'), id('crew/x.test.mjs', ['nested', 'inner ok']), id('crew/x.test.mjs', ['nested', 'inner fails'])])
  assert.equal(parsed.labels[id('crew/x.test.mjs', ['nested', 'inner fails'])], 'crew/x.test.mjs :: nested > inner fails', 'the label is what a reader sees')
  assert.deepEqual([parsed.totals.tests, parsed.totals.fail, parsed.fileLevel, parsed.failedRecords], [5, 3, false, 3])
  // Node-shaped: several YAML fields precede exitCode inside the record's block.
  const crash = parseTapKills(['TAP version 13', '# Error: boom', '# Subtest: crash.test.mjs', 'not ok 1 - crash.test.mjs', '  ---', '  duration_ms: 41.2', "  location: 'test/crash.test.mjs:3:7'", "  failureType: 'subtestsFailed'", "  error: 'boom'", '  exitCode: 7', '  signal: ~', '  ...', '1..1', '# tests 1', '# fail 1'].join('\n'), 'test/crash.test.mjs')
  assert.deepEqual([crash.killers, crash.observed, crash.fileLevel], [[], [], true])
  const notCrash = parseTapKills(['TAP version 13', '# Subtest: crash.test.mjs', 'not ok 1 - crash.test.mjs', '  ---', "  error: 'assert'", '  ...', '1..1', '# tests 1', '# fail 1'].join('\n'), 'test/crash.test.mjs')
  assert.deepEqual([notCrash.killers, notCrash.fileLevel], [[id('test/crash.test.mjs', 'crash.test.mjs')], false], 'no exitCode in the block: a test that happens to carry the file name')
  // Sol on #1401: a test that merely calls itself "x.test.mjs" is a test, not a file row.
  const named = parseTapKills(['TAP version 13', '# Subtest: named.test.mjs', 'ok 1 - named.test.mjs', '# Subtest: dir/other.test.mjs', 'not ok 2 - dir/other.test.mjs', '# Subtest: ordinary', 'ok 3 - ordinary', '1..3', '# tests 3', '# fail 1'].join('\n'), 'test/suite.test.mjs')
  assert.deepEqual([named.observed.length, named.killers, named.fileLevel], [3, [id('test/suite.test.mjs', 'dir/other.test.mjs')], false])
  // Directives: a skipped or TODO record measures nothing — not observed, never a kill —
  // and node's `# fail` excludes a TODO failure, which the reconciliation must match.
  const directives = parseTapKills(['TAP version 13', '# Subtest: a', 'ok 1 - a', '# Subtest: s', 'ok 2 - s # SKIP not today', '# Subtest: t', 'not ok 3 - t # TODO later', '1..3', '# tests 3', '# pass 1', '# fail 0', '# skipped 1', '# todo 1'].join('\n'), 'x')
  assert.deepEqual([directives.observed, directives.killers, directives.failedRecords, directives.totals.todo], [[id('x', 'a')], [], 0, 1])
  assert.equal(parseTapKills('TAP version 13\nok 1 - x\n', 's'), null, 'no summary: not a finished run')
})

// Every way a suite run can finish without attributable outcomes is a closed unmeasured
// reason, never a survivor. Mutation killed: dropping any one of the four guards.
test('a mutant is measured only when every suite run finished with attributable outcomes', () => {
  const tap = (body, fail) => `TAP version 13\n${body}\n1..2\n# tests 2\n# pass ${2 - fail}\n# fail ${fail}\n`
  const ok = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0), stderr: '' }
  const killed = { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nnot ok 2 - b', 1), stderr: '' }
  const okRun = classifyMutantOutcome({ suiteOutputs: [ok] })
  assert.deepEqual([okRun.status, okRun.survivor, okRun.killers, okRun.observed, okRun.suitesMeasured], ['measured', true, [], [id('s', 'a'), id('s', 'b')], ['s']])
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok, killed] }).killers, [id('s', 'b')])
  // Sol on #1401, pass 5: one unreadable suite makes the MUTANT unmeasured without erasing
  // the suites that did measure — that is what the suite-run rate counts.
  const crashed = { suite: 'r', status: 1, stdout: 'TAP version 13\n# Subtest: r\nnot ok 1 - r\n  ---\n  exitCode: 7\n  ...\n1..1\n# tests 1\n# fail 1\n', stderr: '' }
  const mixed = classifyMutantOutcome({ suiteOutputs: [ok, crashed] })
  assert.deepEqual([mixed.status, mixed.reason, mixed.suitesMeasured], ['unmeasured', 'file-level-failure', ['s']], 'the readable suite still counts as a measured run')
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
  const todoRun = classifyMutantOutcome({ suiteOutputs: [todo] })
  assert.deepEqual([todoRun.status, todoRun.survivor, todoRun.killers, todoRun.observed], ['measured', true, [], [id('s', 'a')]])
})

// Sol on #1401, pass 2: without a pristine census, a run that finished after only test A
// makes B's later kill-set a strict subset of A's. A mutant run measures the same thing as
// the baseline or it is unmeasured. Mutation killed: dropping the outcome-set comparison.
test('a mutant run whose observed set differs from the pristine baseline is unmeasured', () => {
  const tap = (body, fail, tests) => `TAP version 13\n${body}\n1..${tests}\n# tests ${tests}\n# pass ${tests - fail}\n# fail ${fail}\n`
  const pristine = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0, 2), stderr: '' }
  const census = baselineCensus(pristine)
  assert.deepEqual([census.suite, census.status, census.reason, census.observed], ['s', 'measured', null, [id('s', 'a'), id('s', 'b')]])
  const baselines = new Map([['s', census.observed]])
  const truncated = { suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' }
  assert.deepEqual([classifyMutantOutcome({ suiteOutputs: [truncated], baselines }).reason, classifyMutantOutcome({ suiteOutputs: [truncated] }).status], ['outcome-set-differs', 'measured'])
  const full = { suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a\n# Subtest: b\nok 2 - b', 1, 2), stderr: '' }
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [full], baselines }).killers, [id('s', 'a')])
  const red = baselineCensus({ suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' })
  assert.deepEqual([red.status, red.reason, MUTANT_UNMEASURED_REASONS.includes(red.reason)], ['unmeasured', 'baseline-red', true])
  // Sol on #1401, pass 3: occurrence identity. Two tests titled the same are two tests; a
  // run that dropped one, or reordered them, measured something else.
  const twin = baselineCensus({ suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nok 2 - same\n# Subtest: b\nok 3 - b', 0, 3), stderr: '' })
  assert.deepEqual(twin.observed, [id('s', 'same', 1), id('s', 'same', 2), id('s', 'b')])
  assert.equal(twin.labels[id('s', 'same', 2)], 's :: same (occurrence 2)')
  const twins = new Map([['s', twin.observed]])
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 1, stdout: tap('# Subtest: same\nnot ok 1 - same\n# Subtest: b\nok 2 - b', 1, 2), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'a duplicate dropped')
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 0, stdout: tap('# Subtest: b\nok 1 - b\n# Subtest: same\nok 2 - same\n# Subtest: same\nok 3 - same', 0, 3), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'reordered')
  assert.equal(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nok 2 - same\n# Subtest: c\nok 3 - c', 0, 3), stderr: '' }], baselines: twins }).reason, 'outcome-set-differs', 'a title the mutant changed')
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [{ suite: 's', status: 1, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nnot ok 2 - same\n# Subtest: b\nok 3 - b', 1, 3), stderr: '' }], baselines: twins }).killers, [id('s', 'same', 2)], 'the second twin is the killer')
  // Sol on #1401, passes 4 and 5: no title can spell another test's identity — not a `#2`
  // suffix, not a NUL, not the ` > ` the label joins a path with.
  const hostile = baselineCensus({ suite: 's', status: 0, stdout: tap('# Subtest: a > b\nok 1 - a > b\n# Subtest: a\nok 2 - a\n# Subtest: same\nok 3 - same\n# Subtest: same\nok 4 - same\n# Subtest: same#2\nok 5 - same#2', 0, 5), stderr: '' })
  assert.equal(new Set(hostile.observed).size, 5, 'five distinct identities')
  assert.ok(hostile.observed.includes(id('s', 'a > b')) && hostile.observed.includes(id('s', 'same', 2)) && hostile.observed.includes(id('s', 'same#2')))
  const spelled = baselineCensus({ suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same\nok 2 - same\n# Subtest: same#2\nok 3 - same#2', 0, 3), stderr: '' })
  assert.equal(new Set(spelled.observed).size, 3, 'three distinct identities')
  const reordered = { suite: 's', status: 0, stdout: tap('# Subtest: same\nok 1 - same\n# Subtest: same#2\nok 2 - same#2\n# Subtest: same\nok 3 - same', 0, 3), stderr: '' }
  assert.equal(classifyMutantOutcome({ suiteOutputs: [reordered], baselines: new Map([['s', spelled.observed]]) }).reason, 'outcome-set-differs', 'reordering around a spelled suffix is caught')
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
  const baselines = new Map([['s', [id('s', 'a')]]])
  for (const [reason, suiteOutputs] of Object.entries(paths)) {
    const verdict = classifyMutantOutcome({ suiteOutputs, baselines })
    assert.equal(verdict.status, 'unmeasured', reason)
    assert.equal(verdict.reason, reason)
    assert.ok(MUTANT_UNMEASURED_REASONS.includes(verdict.reason), `${reason} is in the closed source`)
  }
  assert.equal(classifyMutantOutcome({ suiteOutputs: [ok], baselines }).status, 'measured')
  assert.equal(baselineCensus({ suite: 's', status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' }).reason, 'baseline-red')
  // The one reason only main emits: no suite had a measured baseline, so every mutant is unmeasured.
  const dir = scratchDir('kr-nobase-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), ['export const a = 1', 'export function f(x) { return x + 1 }', ''].join('\n'))
  assert.equal(main(['--in-place', '--mutants', '2', '--seed', '1', '--suites', 'r', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync: () => ({ status: 1, stdout: tap('# Subtest: a\nnot ok 1 - a', 1, 1), stderr: '' }) }), 0)
  const none = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))
  assert.ok(none.unmeasured.length > 0 && none.unmeasured.every((row) => row.reason === REASON.BASELINE_UNMEASURED), JSON.stringify(none.unmeasured))
  assert.ok(MUTANT_UNMEASURED_REASONS.includes(none.unmeasured[0].reason))
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
  assert.equal(main(['--in-place', '--mutants', '2', '--seed', '1', '--suites', 'good', '--suites', 'red', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync }), 0)
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
  const code = main(['--in-place', '--mutants', '4', '--seed', '3', '--suites', 's', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync })
  assert.equal(code, 0)
  const report = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))
  assert.ok(report.sampling.selectedCandidates >= 2, `at least two mutants: ${JSON.stringify(report.sampling)}`)
  assert.ok(runs >= 3, `baseline plus mutants ran: ${runs}`)
  assert.equal(report.redundant.length, 1, JSON.stringify(report.redundant))
  assert.deepEqual([report.redundant[0].candidate, report.redundant[0].dominator, report.redundant[0].status], [id('s', 'B'), id('s', 'A'), 'redundancy-candidate'])
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
// Sol on #1401, pass 5: only SIGINT restored — a SIGTERM left the mutant in the target.
// Every termination signal restores first and re-raises itself exactly once.
test('every termination signal restores the target before re-raising', () => {
  // Named here, not read from production: a list that shrinks must redden this, not shrink
  // the loop with it.
  assert.deepEqual([...TERMINATION_SIGNALS], ['SIGINT', 'SIGTERM', 'SIGHUP'])
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const dir = scratchDir('kr-signal-')
    mkdirSync(join(dir, 'crew'), { recursive: true })
    const target = join(dir, 'crew', 'drive.mjs')
    const original = Buffer.from(['export const a = 1', 'export function f(x) { return x + 1 }', 'export const b = a + 2', ''].join('\n'))
    writeFileSync(target, original)
    const raised = []
    const signals = new EventEmitter()
    let calls = 0
    const kill = (pid, name) => { raised.push([name, readFileSync(target).equals(original)]); signals.emit(name) }
    const spawnSync = () => {
      calls += 1
      // Run 1 is the pristine baseline; the signal arrives during the first MUTATED run.
      if (raised.length === 0 && !readFileSync(target).equals(original)) signals.emit(signal)
      return { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# fail 0\n', stderr: '' }
    }
    for (let seed = 0; seed < 10 && raised.length === 0; seed += 1) {
      main(['--in-place', '--mutants', '1', '--seed', String(seed), '--suites', 's', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync, signals, kill })
    }
    assert.ok(calls > 1, `${signal}: no seed produced a mutated run`)
    assert.deepEqual(raised, [[signal, true]], `${signal}: one re-raise, bytes restored at that instant`)
    assert.ok(readFileSync(target).equals(original), signal)
  }
})

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
    // Run 1 is the pristine baseline; the interrupt belongs to the first MUTATED run.
    if (raised.length === 0 && !readFileSync(target).equals(original)) { seenMutated = true; signals.emit('SIGINT') }
    return { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# fail 0\n', stderr: '' }
  }
  for (let seed = 0; seed < 10 && raised.length === 0; seed += 1) {
    main(['--in-place', '--mutants', '1', '--seed', String(seed), '--suites', 's', '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync, signals, kill })
  }
  assert.ok(calls > 1, 'no seed in 0..9 produced a mutated run')
  assert.equal(seenMutated, true, 'the runner must see the mutant in the target')
  assert.deepEqual(raised, [[process.pid, 'SIGINT', true]], 'exactly one re-raise, with the original bytes already restored at that instant')
  assert.ok(readFileSync(target).equals(original))
})

// Sol on #1401, pass 6: a mocked signal cannot prove the process dies, and a SIGKILL cannot
// be handled at all. The guarantee is therefore structural — the mutations run in a
// disposable worktree, so the CHECKOUT cannot carry a mutant however the run ends. Proven
// with a real subprocess killed mid-run. Mutation killed: mutating the checkout (the default
// isolation removed) — the checkout's bytes then differ after the kill.
test('a SIGKILL mid-run cannot leave the checkout mutated, because the mutations are not in the checkout', async () => {
  const dir = scratchDir('kr-kill-')
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  const target = join(dir, 'crew', 'drive.mjs')
  const original = ['export const a = 1', 'export function f(x) { return x + 1 }', 'export const b = a + 2', 'export const c = b > 1', ''].join('\n')
  writeFileSync(target, original)
  // A suite slow enough that the kill lands while a mutant is in the worktree.
  // Fast for the pristine census, then slow for the first MUTATED run — so the kill lands
  // while a mutant exists, wherever the tool put it.
  writeFileSync(join(dir, 'slow.test.mjs'), [
    "import { test } from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    `const pristine = ${JSON.stringify(original)}`,
    "test('slow when mutated', async () => {",
    "  if (readFileSync('crew/drive.mjs', 'utf8') !== pristine) await new Promise((resolve) => setTimeout(resolve, 60000))",
    '})',
    '',
  ].join('\n'))
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
  const child = spawn(process.execPath, [join(ROOT, 'scripts/factory/kill-redundancy.mjs'), '--mutants', '2', '--seed', '1', '--suites', 'slow.test.mjs', '--timeout-ms', '600000', '--md', join(dir, 'k.md'), '--checkout', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let say = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { say += chunk })
  // Wait until a mutant exists ANYWHERE — the disposable worktree, or (if the tool were to
  // mutate in place) the checkout itself — then kill the way nothing can catch. The
  // condition holds in both worlds, so the assertion below is what separates them.
  const mutantAt = (root) => { try { return readFileSync(join(root, 'crew', 'drive.mjs'), 'utf8') !== original } catch { return false } }
  const roots = () => gitResult(dir, 'worktree', 'list').stdout.split('\n').map((line) => line.split(' ')[0]).filter(Boolean)
  const mutantExists = () => roots().some(mutantAt)
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !mutantExists() && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(child.exitCode, null, `the run finished before the kill: ${say.slice(0, 300)}`)
  assert.ok(mutantExists(), `no mutant appeared in ${roots().join(', ')}`)
  child.kill('SIGKILL')
  await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(readFileSync(target, 'utf8'), original, 'the checkout still carries its own bytes')
  assert.equal(gitResult(dir, 'status', '--porcelain').stdout.trim(), '', 'and nothing else moved in it')
  gitResult(dir, 'worktree', 'prune')
})

// Without a worktree — a checkout that is not a git repository — the tool REFUSES rather than
// mutating something a crash could leave broken, and says how to accept that risk.
// Mutation killed: falling back to the checkout when the worktree cannot be made.
test('a checkout it cannot isolate is refused, naming --in-place', () => {
  const dir = scratchDir('kr-norepo-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), 'export const a = 1\n')
  let stderr = ''
  assert.equal(main(['--mutants', '1', '--suites', 's', '--md', join(dir, 'k.md'), '--checkout', dir], { stderr: { write: (text) => { stderr += text } }, spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) }), 3)
  assert.match(stderr, /refusing to mutate the checkout in place/)
  assert.match(stderr, /--in-place/)
  assert.equal(existsSync(join(dir, 'k.md')), false, 'nothing was written')
})

// Sol on #1401, pass 7: the commit claimed these two and no test pinned them. The suites run
// under the node running this tool, with the test runner's own context stripped — inheriting
// NODE_TEST_CONTEXT made the spawned runner report to that parent instead of running the
// file, so a tool invoked from inside a suite measured nothing in milliseconds.
// Mutation killed: spawning PATH 'node'; keeping NODE_TEST_CONTEXT; keeping NODE_OPTIONS.
test('the measured runs use this node and carry no test-runner context', () => {
  const dir = scratchDir('kr-spawn-')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), ['export const a = 1', 'export function f(x) { return x + 1 }', ''].join('\n'))
  const seen = []
  const spawnSync = (bin, args, options) => {
    seen.push({ bin, args, env: options?.env ?? null })
    return { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# pass 1\n# fail 0\n', stderr: '' }
  }
  const before = { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT, NODE_OPTIONS: process.env.NODE_OPTIONS }
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  process.env.NODE_OPTIONS = '--require=/tmp/evil.js'
  try {
    main(['--in-place', '--mutants', '1', '--seed', '1', '--suites', 's.test.mjs', '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync })
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  const runs = seen.filter((call) => Array.isArray(call.args) && call.args.includes('--test'))
  assert.ok(runs.length > 0, 'no suite run was spawned')
  for (const run of runs) {
    assert.equal(run.bin, process.execPath, 'the suites run under the node running this tool')
    assert.equal(run.env.NODE_TEST_CONTEXT, undefined, 'the runner context never reaches a measured run')
    assert.equal(run.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS can load code into a measured run')
    assert.equal(run.env.NO_COLOR, '1')
  }
})

// The isolation gives the worktree back on EVERY catchable path. Mutation killed: the
// cleanup outside the finally (an output that cannot be written then keeps the worktree);
// no unregister on a failed add (the refusal then leaves a registry row).
test('a refusal and a failed output both leave the source repository with no extra worktree', () => {
  const dir = scratchDir('kr-leak-')
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), 'export const a = 1\nexport function f(x) { return x + 1 }\n')
  writeFileSync(join(dir, 's.test.mjs'), "import { test } from 'node:test'\ntest('x', () => {})\n")
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
  const worktrees = () => gitResult(dir, 'worktree', 'list').stdout.split('\n').filter(Boolean).length
  const registry = () => { try { return readdirSync(join(dir, '.git', 'worktrees')).length } catch { return 0 } }
  assert.deepEqual([worktrees(), registry()], [1, 0])
  // 1. the output cannot be written: the md path is a directory
  mkdirSync(join(dir, 'blocked.md'), { recursive: true })
  assert.throws(() => main(['--mutants', '1', '--seed', '1', '--suites', 's.test.mjs', '--md', join(dir, 'blocked.md'), '--checkout', dir], {
    spawnSync: (bin, args, options) => (Array.isArray(args) && args.includes('--test')
      ? { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# pass 1\n# fail 0\n', stderr: '' }
      : spawnSync(bin, args, options)),
  }))
  assert.deepEqual([worktrees(), registry()], [1, 0], 'a failed output gives the worktree back')
  // 2. a repository without the target: refused, and nothing registered stays behind
  const bare = scratchDir('kr-leak-bare-')
  git(bare, 'init', '-q'); writeFileSync(join(bare, 'x.md'), 'x\n'); git(bare, 'add', '-A'); git(bare, 'commit', '-q', '-m', 'base')
  let stderr = ''
  assert.equal(main(['--mutants', '1', '--suites', 's', '--md', join(bare, 'k.md'), '--checkout', bare], { stderr: { write: (text) => { stderr += text } } }), 3)
  assert.match(stderr, /refusing to mutate the checkout in place/)
  assert.equal(gitResult(bare, 'worktree', 'list').stdout.split('\n').filter(Boolean).length, 1, 'the refusal registered no worktree')
  assert.equal((() => { try { return readdirSync(join(bare, '.git', 'worktrees')).length } catch { return 0 } })(), 0, 'and left no registry row')
})

// What a SIGKILLed run really leaves is BOTH the registry row and its directory, and
// `git worktree prune` cannot reclaim a worktree whose directory still exists (pass 8). But
// the prefix alone does not prove abandonment — a concurrent run owns one too (pass 9) — so
// a worktree is taken only when its owner record names a pid that is gone and git has not
// locked it, and it is COUNTED only once directory and row are verified absent.
// Mutation killed: taking a live owner; taking a locked or ownerless one; counting an
// unverified removal; matching a worktree that is not ours; skipping reclaim at run start.
test('a run reclaims only worktrees whose owner is provably gone, and counts only verified removals', () => {
  const dir = scratchDir('kr-stale-')
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'crew'), { recursive: true })
  writeFileSync(join(dir, 'crew', 'drive.mjs'), 'export const a = 1\nexport function f(x) { return x + 1 }\n')
  writeFileSync(join(dir, 's.test.mjs'), "import { test } from 'node:test'\ntest('x', () => {})\n")
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
  const home = scratchDir('kr-abandoned-')
  const make = (name, owner) => {
    const path = join(home, name)
    git(dir, 'worktree', 'add', '--detach', '--quiet', path, 'HEAD')
    if (owner !== undefined) writeFileSync(ownerRecordPath(path), JSON.stringify(owner))
    return path
  }
  const DEAD = 999_999_991, LIVE = 999_999_992
  const dead = make(`${ISOLATION_PREFIX}dead`, { pid: DEAD })
  const live = make(`${ISOLATION_PREFIX}live`, { pid: LIVE })
  const locked = make(`${ISOLATION_PREFIX}locked`, { pid: DEAD })
  git(dir, 'worktree', 'lock', locked)
  const ownerless = make(`${ISOLATION_PREFIX}ownerless`)
  const foreign = make('someone-elses', { pid: DEAD })
  const reclaimed = reclaimAbandoned(dir, { pidAlive: (pid) => pid === LIVE })
  assert.deepEqual(reclaimed.removed.map((path) => basename(path)), [`${ISOLATION_PREFIX}dead`])
  assert.deepEqual(reclaimed.skipped.map(({ path, reason }) => [basename(path), reason]).sort(), [
    [`${ISOLATION_PREFIX}live`, RECLAIM_SKIPPED.OWNER_LIVE],
    [`${ISOLATION_PREFIX}locked`, RECLAIM_SKIPPED.LOCKED],
    [`${ISOLATION_PREFIX}ownerless`, RECLAIM_SKIPPED.OWNER_UNKNOWN],
  ])
  assert.equal(existsSync(dead), false, 'the directory is gone, not only the row')
  assert.equal(existsSync(ownerRecordPath(dead)), false, 'and its owner record with it')
  for (const kept of [live, locked, ownerless, foreign]) assert.equal(existsSync(kept), true, `${basename(kept)} is untouched`)
  assert.deepEqual(Object.values(RECLAIM_SKIPPED).sort(), ['locked', 'owner-live', 'owner-unknown', 'removal-unverified'])

  // A removal git refuses is not counted: the row is still listed, so it is unverified.
  const stuck = make(`${ISOLATION_PREFIX}stuck`, { pid: DEAD })
  const refusing = reclaimAbandoned(dir, {
    pidAlive: (pid) => pid === LIVE,
    rmSync: () => { throw new Error('EPERM') },
    spawnSync: (bin, args, options) => (args.includes('remove') || args.includes('prune') ? { status: 1, stdout: '', stderr: 'refused' } : spawnSync(bin, args, options)),
  })
  assert.deepEqual(refusing.removed, [])
  assert.ok(refusing.skipped.some(({ path, reason }) => path.endsWith('stuck') && reason === RECLAIM_SKIPPED.UNVERIFIED))

  // A whole run reclaims on the way in, reports both counts, and leaves no owner record of its own.
  const ownRecords = () => readdirSync(tmpdir()).filter((name) => name.startsWith(ISOLATION_PREFIX) && name.endsWith('.owner.json') && JSON.parse(readFileSync(join(tmpdir(), name), 'utf8')).pid === process.pid)
  let recordsWhileRunning = null
  main(['--mutants', '1', '--seed', '1', '--suites', 's.test.mjs', '--md', join(dir, 'k.md'), '--out', join(dir, 'k.json'), '--checkout', dir], {
    pidAlive: (pid) => pid === LIVE,
    spawnSync: (bin, args, options) => {
      if (!(Array.isArray(args) && args.includes('--test'))) return spawnSync(bin, args, options)
      recordsWhileRunning ??= ownRecords().length
      return { status: 0, stdout: 'TAP version 13\n# Subtest: x\nok 1 - x\n1..1\n# tests 1\n# pass 1\n# fail 0\n', stderr: '' }
    },
  })
  assert.equal(recordsWhileRunning, 1, 'a running tool is named by exactly one owner record, which is what protects it from a concurrent run')
  const provenance = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')).provenance
  assert.equal(provenance.reclaimed, 1, 'the stuck worktree, now removable, is reclaimed by the run')
  assert.deepEqual([...provenance.reclaim_skipped].sort(), ['locked', 'owner-live', 'owner-unknown'])
  assert.match(readFileSync(join(dir, 'k.md'), 'utf8'), /reclaimed at start: 1 verified gone; 3 left \(/)
  assert.deepEqual(ownRecords(), [], 'a finished run leaves no owner record')
})


