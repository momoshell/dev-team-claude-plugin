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
  const crash = parseTapKills(['TAP version 13', '# Error: boom', '# Subtest: crash.test.mjs', 'not ok 1 - crash.test.mjs', '  exitCode: 7', '1..1', '# tests 1', '# fail 1'].join('\n'), 'crash.test.mjs')
  assert.deepEqual([crash.killers, crash.observed, crash.fileLevel], [[], [], true])
  assert.equal(parseTapKills('TAP version 13\nok 1 - x\n', 's'), null, 'no summary: not a finished run')
})

// Every way a suite run can finish without attributable outcomes is a closed unmeasured
// reason, never a survivor. Mutation killed: dropping any one of the four guards.
test('a mutant is measured only when every suite run finished with attributable outcomes', () => {
  const tap = (body, fail) => `TAP version 13\n${body}\n1..2\n# tests 2\n# pass ${2 - fail}\n# fail ${fail}\n`
  const ok = { suite: 's', status: 0, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0), stderr: '' }
  const killed = { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nnot ok 2 - b', 1), stderr: '' }
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok] }), { status: 'measured', survivor: true, killers: [], observed: ['s :: a', 's :: b'], suitesMeasured: ['s'] })
  assert.deepEqual(classifyMutantOutcome({ suiteOutputs: [ok, killed] }).killers, ['s :: b'])
  const reasons = {
    'file-level-failure': { suite: 's', status: 1, stdout: 'TAP version 13\n# Subtest: s.test.mjs\nnot ok 1 - s.test.mjs\n1..1\n# tests 1\n# fail 1\n', stderr: '' },
    'failures-unattributed': { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 1), stderr: '' },
    'suite-exit-unattributed': { suite: 's', status: 1, stdout: tap('# Subtest: a\nok 1 - a\n# Subtest: b\nok 2 - b', 0), stderr: '' },
    'no-tap-output': { suite: 's', status: 0, stdout: '', stderr: '' },
  }
  for (const [reason, output] of Object.entries(reasons)) {
    const verdict = classifyMutantOutcome({ suiteOutputs: [ok, output] })
    assert.deepEqual([verdict.status, verdict.reason, verdict.survivor], ['unmeasured', reason, false], reason)
  }
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
