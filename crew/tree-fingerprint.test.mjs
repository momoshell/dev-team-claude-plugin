import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir, git } from '../test/helpers.mjs'
import {
  FINGERPRINT_FILE, FINGERPRINT_OUTCOMES, FINGERPRINT_WITHHELD, UNMEASURABLE_CAUSES,
  checkRecordedTree, compareFingerprints, fingerprintTree, fingerprintWithheld,
  readTreeFingerprint, recordTreeFingerprint, writerUnproven,
} from './tree-fingerprint.mjs'

const CLEAN_ROOTS = { records: 0, settled: 0, already_dead: 0, unidentified: 0, failed: 0, unproven: 0 }
const CLEAN_DESCENDANTS = {
  sweep_id: 't', records: 0, swept: 0, skipped: 0, retryable: 0, snapshot_ok: true,
  groups: 0, reclaimed: 0, live: 0, identity_refused: 0, probe_unknown: 0,
  signalled: 0, recorded: 0, record_failed: 0, incomplete: 0, coverage_outcome: 'unproven',
}
const PROVEN_SEATS = { seats: 1, proven: 1, failed: 0, unproven: 0, recorded: 1, record_failed: 0 }

function checkoutFixture(prefix) {
  const root = scratchDir(prefix)
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-q')
  writeFileSync(join(checkout, 'edit.txt'), 'before\n')
  writeFileSync(join(checkout, 'gone.txt'), 'gone\n')
  writeFileSync(join(checkout, 'keep.txt'), 'keep\n')
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-qm', 'seed')
  return { root, checkout }
}

test('tree fingerprint: an untouched checkout is unchanged', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-quiet-')
  const before = fingerprintTree(checkout)
  const after = fingerprintTree(checkout)
  const result = compareFingerprints(before, after)
  assert.equal(before.measured, true)
  assert.equal(after.measured, true)
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unchanged)
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.modified, [])
})

test('tree fingerprint: edits, additions and deletions occupy separate buckets', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-diff-')
  writeFileSync(join(checkout, '.gitignore'), 'ignored.txt\n')
  git(checkout, 'add', '.gitignore')
  git(checkout, 'commit', '-qm', 'ignore')
  const before = fingerprintTree(checkout)
  writeFileSync(join(checkout, 'edit.txt'), 'after\n')
  writeFileSync(join(checkout, 'fresh.txt'), 'fresh\n')
  writeFileSync(join(checkout, 'loose.txt'), 'untracked\n')
  writeFileSync(join(checkout, 'ignored.txt'), 'ignored\n')
  rmSync(join(checkout, 'gone.txt'))
  const result = compareFingerprints(before, fingerprintTree(checkout))
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(result.modified, ['edit.txt'])
  assert.deepEqual(result.added, ['fresh.txt', 'loose.txt'])
  assert.deepEqual(result.removed, ['gone.txt'])
  assert.equal(result.added.includes('ignored.txt'), false)
})

// C1: a scalar payload digest cannot see a chmod. git can, so this must too.
test('tree fingerprint: an executable-bit change is a modification', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-mode-')
  const before = fingerprintTree(checkout)
  chmodSync(join(checkout, 'keep.txt'), 0o755)
  assert.match(git(checkout, 'diff', '--name-only'), /keep\.txt/)
  const result = compareFingerprints(before, fingerprintTree(checkout))
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(result.modified, ['keep.txt'])
})

// C1: dereferencing a symlink hides a retarget between equal-content files.
test('tree fingerprint: a symlink retargeted to an equal-content file is a modification', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-link-')
  writeFileSync(join(checkout, 'target-a'), 'identical\n')
  writeFileSync(join(checkout, 'target-b'), 'identical\n')
  symlinkSync('target-a', join(checkout, 'link'))
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-qm', 'link')
  const before = fingerprintTree(checkout)
  assert.match(before.entries.link, /^symlink:/)
  unlinkSync(join(checkout, 'link'))
  symlinkSync('target-b', join(checkout, 'link'))
  assert.match(git(checkout, 'diff', '--name-only'), /link/)
  const result = compareFingerprints(before, fingerprintTree(checkout))
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(result.modified, ['link'])
})

// C1: following a broken symlink raises ENOENT, which a dereferencing
// implementation reports as a deletion that never happened.
test('tree fingerprint: a broken tracked symlink is measured, not a phantom deletion', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-broken-')
  symlinkSync('nowhere', join(checkout, 'broken'))
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-qm', 'broken link')
  const before = fingerprintTree(checkout)
  assert.equal(before.measured, true)
  assert.match(before.entries.broken, /^symlink:/)
  const result = compareFingerprints(before, fingerprintTree(checkout))
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unchanged)
  assert.deepEqual(result.removed, [])
})

test('tree fingerprint: a removed checkout is unmeasurable, not unchanged', () => {
  const { root, checkout } = checkoutFixture('tree-fingerprint-missing-')
  const before = fingerprintTree(checkout)
  rmSync(root, { recursive: true, force: true })
  const after = fingerprintTree(checkout)
  const result = compareFingerprints(before, after)
  assert.equal(after.measured, false)
  assert.equal(after.cause, UNMEASURABLE_CAUSES.missing)
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.notEqual(result.outcome, FINGERPRINT_OUTCOMES.unchanged)
})

// H1: an existing ordinary directory is its own input class.
test('tree fingerprint: an existing non-git directory is unmeasurable, not unchanged', () => {
  const root = scratchDir('tree-fingerprint-notrepo-')
  const plain = join(root, 'plain')
  mkdirSync(plain)
  writeFileSync(join(plain, 'a.txt'), 'a\n')
  const f = fingerprintTree(plain)
  assert.equal(f.measured, false)
  assert.equal(f.cause, UNMEASURABLE_CAUSES.not_a_checkout)
  const { checkout } = checkoutFixture('tree-fingerprint-notrepo-ok-')
  const result = compareFingerprints(fingerprintTree(checkout), f)
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.notEqual(result.outcome, FINGERPRINT_OUTCOMES.unchanged)
})

// H1: a partly-read tree is its own input class, and a partial measurement is
// not a measurement.
test('tree fingerprint: an unreadable listed file makes the whole tree unmeasurable', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-unreadable-')
  const locked = join(checkout, 'keep.txt')
  chmodSync(locked, 0o000)
  try {
    assert.throws(() => readFileSync(locked), 'keep.txt must be unreadable for this test to mean anything')
    const f = fingerprintTree(checkout)
    assert.equal(f.measured, false)
    assert.equal(f.cause, UNMEASURABLE_CAUSES.unreadable)
    assert.match(String(f.detail), /keep\.txt/)
    const result = compareFingerprints(f, f)
    assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
    assert.notEqual(result.outcome, FINGERPRINT_OUTCOMES.unchanged)
  } finally { chmodSync(locked, 0o644) }
})

test('tree fingerprint: the not-measured guard names either side', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-guard-')
  const measured = fingerprintTree(checkout)
  const before = compareFingerprints(fingerprintTree(null), measured)
  const after = compareFingerprints(measured, fingerprintTree(join(checkout, 'missing')))
  assert.equal(before.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.equal(before.side, 'before')
  assert.equal(after.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.equal(after.side, 'after')
})

test('tree fingerprint: different checkouts are an unmeasurable comparison', () => {
  const first = checkoutFixture('tree-fingerprint-first-')
  const second = checkoutFixture('tree-fingerprint-second-')
  const result = compareFingerprints(fingerprintTree(first.checkout), fingerprintTree(second.checkout))
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.equal(result.side, 'both')
  assert.equal(result.cause, UNMEASURABLE_CAUSES.checkout_mismatch)
})

test('tree fingerprint: records and reads a covered checkout', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-record-')
  const root = scratchDir('tree-fingerprint-record-dir-')
  const dir = join(root, 'crew')
  mkdirSync(dir)
  const result = recordTreeFingerprint(dir, checkout, { task: 'fingerprint', seats: PROVEN_SEATS, roots: CLEAN_ROOTS, descendants: CLEAN_DESCENDANTS })
  const path = join(dir, FINGERPRINT_FILE)
  assert.equal(result.recorded, true)
  assert.equal(result.path, path)
  assert.equal(result.file, FINGERPRINT_FILE)
  assert.ok(result.covered >= 3)
  const record = readTreeFingerprint(dir)
  assert.equal(record.checkout, checkout)
  assert.equal(record.task, 'fingerprint')
  assert.deepEqual(record.roots, CLEAN_ROOTS)
  assert.deepEqual(record.descendants, CLEAN_DESCENDANTS)
  assert.equal(record.fingerprint.at, result.at)
  assert.equal(readTreeFingerprint(join(root, 'empty')), null)
})

test('tree fingerprint: an unmeasurable checkout writes no record', () => {
  const root = scratchDir('tree-fingerprint-absent-')
  const dir = join(root, 'crew')
  mkdirSync(dir)
  const result = recordTreeFingerprint(dir, join(root, 'missing'), { task: 'absent' })
  assert.equal(result.recorded, false)
  assert.equal(result.absent, UNMEASURABLE_CAUSES.missing)
  assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false)
})

test('tree fingerprint: recorded checks name a later changed path and missing records', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-check-')
  const root = scratchDir('tree-fingerprint-check-dir-')
  const dir = join(root, 'crew')
  mkdirSync(dir)
  const recorded = recordTreeFingerprint(dir, checkout, { task: 'check' })
  const record = readTreeFingerprint(dir)
  writeFileSync(join(checkout, 'edit.txt'), 'changed after record\n')
  const result = checkRecordedTree(dir)
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(result.modified, ['edit.txt'])
  assert.equal(result.record_path, recorded.path)
  assert.equal(result.recorded_at, record.fingerprint.at)
  const missing = checkRecordedTree(join(root, 'no-record'))
  assert.equal(missing.outcome, FINGERPRINT_OUTCOMES.unmeasurable)
  assert.equal(missing.cause, UNMEASURABLE_CAUSES.missing)
  assert.notEqual(missing.outcome, FINGERPRINT_OUTCOMES.unchanged)
})

test('tree fingerprint: a moved HEAD is reported as changed', () => {
  const { checkout } = checkoutFixture('tree-fingerprint-head-')
  const before = fingerprintTree(checkout)
  writeFileSync(join(checkout, 'keep.txt'), 'new commit content\n')
  git(checkout, 'add', 'keep.txt')
  git(checkout, 'commit', '-qm', 'move head')
  const after = fingerprintTree(checkout)
  const result = compareFingerprints(before, after)
  assert.equal(result.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(result.head_changed, { from: before.head, to: after.head })
  assert.deepEqual(result.modified, ['keep.txt'])
})

// C2: a proven PANE tally says nothing about a seat root or a descendant group.
test('tree fingerprint: the withheld gate refuses every writer it did not see proved dead', () => {
  assert.equal(fingerprintWithheld({ seats: PROVEN_SEATS, roots: CLEAN_ROOTS, descendants: CLEAN_DESCENDANTS }), null)
  assert.equal(fingerprintWithheld({ seats: null, seatsAbsent: 'nothing measured' }).cause, FINGERPRINT_WITHHELD.unmeasured)
  assert.equal(fingerprintWithheld({ seats: { seats: 2, proven: 1 }, roots: CLEAN_ROOTS, descendants: CLEAN_DESCENDANTS }).cause, FINGERPRINT_WITHHELD.seats_unproven)
  for (const roots of [null, { ...CLEAN_ROOTS, unproven: 1 }, { ...CLEAN_ROOTS, failed: 1 }, { ...CLEAN_ROOTS, unidentified: 1 }]) {
    assert.equal(fingerprintWithheld({ seats: PROVEN_SEATS, roots, descendants: CLEAN_DESCENDANTS }).cause, FINGERPRINT_WITHHELD.writer_unproven)
  }
  for (const descendants of [
    null,
    { ...CLEAN_DESCENDANTS, snapshot_ok: false },
    { ...CLEAN_DESCENDANTS, live: 1 },
    { ...CLEAN_DESCENDANTS, identity_refused: 1 },
    { ...CLEAN_DESCENDANTS, probe_unknown: 1 },
    { ...CLEAN_DESCENDANTS, incomplete: 1 },
    { ...CLEAN_DESCENDANTS, retryable: 1, record_failed: 1 },
    { ...CLEAN_DESCENDANTS, retryable: 2, record_failed: 1 },
  ]) {
    assert.equal(fingerprintWithheld({ seats: PROVEN_SEATS, roots: CLEAN_ROOTS, descendants }).cause, FINGERPRINT_WITHHELD.writer_unproven)
  }
})

// C1 (round 3): a failed receipt alone does not logically disprove death, but
// this aggregate cannot establish that the receipt failed ALONE — one row can
// increment `retryable` and `record_failed` together while still naming a live
// zero-group root — so a baseline is withheld either way. Fail closed.
test('tree fingerprint: a retryable row a receipt failure cannot explain away is an unproven writer', () => {
  const ambiguous = { ...CLEAN_DESCENDANTS, records: 1, retryable: 1, record_failed: 1 }
  assert.equal(typeof writerUnproven({ roots: CLEAN_ROOTS, descendants: ambiguous }), 'string')
  assert.equal(fingerprintWithheld({ seats: PROVEN_SEATS, roots: CLEAN_ROOTS, descendants: ambiguous }).cause, FINGERPRINT_WITHHELD.writer_unproven)
  // An additional input, no longer the decision boundary.
  assert.equal(typeof writerUnproven({ roots: CLEAN_ROOTS, descendants: { ...CLEAN_DESCENDANTS, records: 2, retryable: 2, record_failed: 1 } }), 'string')
  // Nothing retryable at all is the only clean shape.
  assert.equal(writerUnproven({ roots: CLEAN_ROOTS, descendants: { ...CLEAN_DESCENDANTS, records: 1, swept: 1, recorded: 1 } }), null)
})
