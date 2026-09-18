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
  snapshotFile,
} from '../scripts/factory/kill-redundancy.mjs'
import { generateDiffCandidates } from '../scripts/factory/prove-mutations.mjs'

test('subset kill-set is redundant and names its dominator', () => {
  const result = analyzeKills({ mutantResults: [
    { mutant: { id: 'm1' }, killers: ['suite :: broad'] },
    { mutant: { id: 'm2' }, killers: ['suite :: broad', 'suite :: narrow'] },
  ] })
  assert.equal(result.redundant.length, 1)
  assert.deepEqual([...result.redundant[0].dominatedBy], ['m1', 'm2'])
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
  assert.deepEqual(result, { status: 'unmeasured', reason: 'no-tap-output', survivor: false, killers: [] })
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

test('TAP fixture keys failing tests by suite and title', () => {
  const parsed = parseTapKills([
    'ok 1 - /repo/test/one.test.mjs',
    '    not ok 1 - rejects bad input',
    '1..1',
    '# tests 1',
  ].join('\n'))
  assert.deepEqual(parsed, { killers: ['/repo/test/one.test.mjs :: rejects bad input'] })
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
  let restoredOnInterrupt = null
  const spawnSync = () => {
    calls += 1
    if (restoredOnInterrupt === null) {
      seenMutated = !readFileSync(target).equals(original)
      signals.emit('SIGINT')
      restoredOnInterrupt = readFileSync(target).equals(original)
    }
    return { status: 0, stdout: 'TAP version 13\nok 1 - x\n1..1\n', stderr: '' }
  }
  for (let seed = 0; seed < 10 && calls === 0; seed += 1) {
    main(['--mutants', '1', '--seed', String(seed), '--out', join(dir, 'k.json'), '--md', join(dir, 'k.md'), '--checkout', dir], { spawnSync, signals, kill: (pid, signal) => raised.push([pid, signal]) })
  }
  assert.ok(calls > 0, 'no seed in 0..9 reached the suite runner')
  assert.equal(seenMutated, true, 'the runner must see the mutant in the target')
  assert.equal(restoredOnInterrupt, true, 'the interrupt must restore the original bytes before re-raising')
  assert.deepEqual(raised, [[process.pid, 'SIGINT']], 'the handler re-raises exactly once, at this process')
  assert.ok(readFileSync(target).equals(original))
})
