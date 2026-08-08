// scripts/chain/evidence.mjs is the impure evidence layer for the B1 gates
// CLI (issue #28): a fail-closed git-status-based baseline/touched-set
// change detector, plus an fd-backed validation-command runner. Every git
// fixture below is a REAL `git init` checkout (test/cmux-dispatch.test.mjs:
// 101 idiom) — git itself is never faked here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import {
  captureBaseline,
  readBaseline,
  writeBaselineExclusive,
  touchedPaths,
  parsePorcelainZ,
  statusSnapshot,
  gitAnchorSha,
  hashFileSha256,
  flaggedIndexPaths,
  runValidationCommand,
  GATE_RUN_TIMEOUT_MS,
  EVIDENCE_ERROR_CODES,
  EvidenceError,
} from '../scripts/chain/evidence.mjs'
import { checkScopeCompliance } from '../scripts/chain/gates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const EVIDENCE_PATH = join(ROOT, 'scripts', 'chain', 'evidence.mjs')
const EVIDENCE_SOURCE = readFileSync(EVIDENCE_PATH, 'utf8')
const SLOW_FIXTURE = join(HERE, 'fixtures', 'slow-command.mjs')
const HUGE_FIXTURE = join(HERE, 'fixtures', 'huge-output.mjs')

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// A real git repo (git init + one commit) — mirrors test/cmux-dispatch.
// test.mjs:101's makeGitCheckout idiom.
function makeGitCheckout(dir) {
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: checkout })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: checkout })
  writeFileSync(join(checkout, 'README.md'), '# sample repo\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: checkout })
  return checkout
}

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'chain-evidence-'))
}

// ---------------------------------------------------------------------------
// EVIDENCE_ERROR_CODES / GATE_RUN_TIMEOUT_MS drift guards
// ---------------------------------------------------------------------------

test('EVIDENCE_ERROR_CODES is exactly the frozen closed list and is actually frozen', () => {
  assert.deepEqual(EVIDENCE_ERROR_CODES, [
    'git_unavailable', 'unborn_branch', 'status_unparseable', 'baseline_malformed', 'baseline_exists',
  ])
  assert.ok(Object.isFrozen(EVIDENCE_ERROR_CODES))
})

test('GATE_RUN_TIMEOUT_MS matches the 600000ms harness ceiling default', () => {
  assert.equal(GATE_RUN_TIMEOUT_MS, 600000)
})

// ---------------------------------------------------------------------------
// gitAnchorSha / captureBaseline
// ---------------------------------------------------------------------------

test('gitAnchorSha throws EvidenceError(unborn_branch) on a fresh git init with no commit', () => {
  const dir = freshTmp()
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })

  assert.throws(
    () => gitAnchorSha(checkout),
    (err) => err instanceof EvidenceError && err.code === 'unborn_branch',
  )
})

test('captureBaseline throws EvidenceError(unborn_branch) on the same unborn-branch fixture', () => {
  const dir = freshTmp()
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: checkout })

  assert.throws(
    () => captureBaseline({ cwd: checkout, reason: 'unborn' }),
    (err) => err instanceof EvidenceError && err.code === 'unborn_branch',
  )
})

test('captureBaseline returns exactly { anchor_sha, reason, captured_at, dirty } with a real hash for a dirty file', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nedited\n')
  writeFileSync(join(checkout, 'new.txt'), 'brand new\n')

  const baseline = captureBaseline({ cwd: checkout, reason: 'test capture' })

  assert.deepEqual(Object.keys(baseline).sort(), ['anchor_sha', 'captured_at', 'dirty', 'reason'])
  assert.equal(baseline.anchor_sha, execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim())
  assert.equal(baseline.reason, 'test capture')
  assert.equal(new Date(baseline.captured_at).toISOString(), baseline.captured_at)
  assert.equal(baseline.dirty['README.md'].sha256, sha256(readFileSync(join(checkout, 'README.md'))))
  assert.equal(baseline.dirty['new.txt'].sha256, sha256(readFileSync(join(checkout, 'new.txt'))))
})

// ---------------------------------------------------------------------------
// statusSnapshot argv pin — source-text test, needle built from fragments
// (conventions.md 2026-08-08) so this assertion never trivially matches its
// own source.
// ---------------------------------------------------------------------------

test('statusSnapshot pins --no-optional-locks, --porcelain=v1, -z, -uall and --ignored=matching inside one argv array literal', () => {
  const noLocks = ['--no', '-optional', '-locks'].join('')
  const porcelainV1 = ['--porcelain', '=v1'].join('')
  const zFlag = '-z'
  const uAll = ['-u', 'all'].join('')
  const ignoredMatching = ['--ignored', '=matching'].join('')

  const arrayLiterals = [...EVIDENCE_SOURCE.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])
  const target = arrayLiterals.find((literal) => literal.includes(uAll))
  assert.ok(target, 'expected an argv array literal containing -uall')
  for (const flag of [noLocks, porcelainV1, zFlag, uAll, ignoredMatching]) {
    assert.ok(target.includes(flag), `argv literal missing required flag fragment: ${flag}`)
  }
})

test('statusSnapshot / touchedPaths: a write matching a .gitignore rule under a would-be-scope-checked path IS captured as touched (real git fixture)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, '.gitignore'), '*.tmp.md\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  mkdirSync(join(checkout, 'watched-dir'), { recursive: true })
  writeFileSync(join(checkout, 'watched-dir', 'sneaky.tmp.md'), 'ignored-but-present write\n')

  // Without --ignored=matching this write is invisible to git status at
  // all, regardless of -uall — pin that a plain (non-ignored) invocation
  // really does miss it, then assert statusSnapshot/touchedPaths do not.
  const plainStatus = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall'], { cwd: checkout, encoding: 'buffer' }).toString('utf8')
  assert.ok(!plainStatus.includes('sneaky.tmp.md'), 'expected the plain (no --ignored) status to miss the gitignored file')

  const snapshotPaths = statusSnapshot(checkout).map((e) => e.path)
  assert.ok(snapshotPaths.includes('watched-dir/sneaky.tmp.md'), 'statusSnapshot must capture a gitignored write via --ignored=matching')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('watched-dir/sneaky.tmp.md'), 'touchedPaths must surface a gitignored write as touched, never invisible')
})

// ---------------------------------------------------------------------------
// QA round-2 fix #1: --ignored=matching collapses a wholly-untracked
// ignored DIRECTORY to a single trailing-slash path (a shape -uall alone
// never produced) — captureBaseline/touchedPaths must survive it (never
// EISDIR) and must count it as touched, never silently excluded.
// ---------------------------------------------------------------------------

test('captureBaseline / touchedPaths: an ignored, wholly-untracked DIRECTORY (collapsed by --ignored=matching to a trailing-slash path) never crashes EISDIR and lands in the touched set (real git fixture, OUTSIDE any protected prefix)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, '.gitignore'), 'ignored-dir/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, 'ignored-dir'), { recursive: true })
  writeFileSync(join(checkout, 'ignored-dir', 'inner.txt'), 'ignored write\n')

  // Confirm git really does collapse this to a trailing-slash directory
  // entry (the SHAPE this fix exists to handle), and that captureBaseline
  // survives hashing it AT CAPTURE TIME — the reviewer-reproduced EISDIR
  // crash site (readFileSync on a directory throws EISDIR, not ENOENT).
  const snapshot = statusSnapshot(checkout)
  const dirEntry = snapshot.find((e) => e.path === 'ignored-dir/')
  assert.ok(dirEntry, 'expected git to collapse the wholly-untracked ignored directory to a trailing-slash path')
  assert.equal(dirEntry.xy, '!!')

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' }) // must not throw EISDIR
  assert.ok(Object.prototype.hasOwnProperty.call(baseline.dirty, 'ignored-dir/'), 'expected the collapsed directory path as a baseline.dirty key')
  assert.equal(baseline.dirty['ignored-dir/'].sha256, null, 'a directory-shaped entry must never carry a hashed sha256')

  // Mutate further inside the ignored directory so the SAME directory-shaped
  // path is present again at check time — this drives touchedPaths's own
  // hashFileSha256 call site (source 2, the baselineEntry-exists branch)
  // down the exact path that would otherwise re-crash.
  writeFileSync(join(checkout, 'ignored-dir', 'another.txt'), 'more ignored content\n')

  const result = touchedPaths({ cwd: checkout, baseline }) // must not throw EISDIR
  assert.ok(result.paths.includes('ignored-dir/'), 'the directory-shaped entry must land in the touched set, never crash and never be silently excluded')
})

// ---------------------------------------------------------------------------
// QA round-2 fix #2: sources.ignored carries every touched path whose git
// status entry carries the `!!` ignored marker, separate from the
// committed/dirty/reverted classification.
// ---------------------------------------------------------------------------

test('touchedPaths: sources.ignored carries a currently-present ignored (!!) touched path (source 2, dirty branch)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, '.gitignore'), '*.lock\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })

  writeFileSync(join(checkout, 'scheduled_tasks.lock'), 'v1\n')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('scheduled_tasks.lock'))
  assert.ok(result.sources.dirty.includes('scheduled_tasks.lock'))
  assert.ok(result.sources.ignored.includes('scheduled_tasks.lock'), 'an ignored touched path must be named in sources.ignored')
})

test('touchedPaths: sources.ignored also carries an ignored path detected via the reverted branch (source 3)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, '.gitignore'), '*.lock\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })
  writeFileSync(join(checkout, 'scheduled_tasks.lock'), 'v1\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })
  assert.equal(baseline.dirty['scheduled_tasks.lock'].xy, '!!')

  // "released mid-slice": the ignored file disappears entirely from disk —
  // git status no longer reports it at all, matching the reviewer's exact
  // repro ("an ignored file ... released mid-slice lands in touchedPaths's
  // reverted bucket").
  unlinkSync(join(checkout, 'scheduled_tasks.lock'))

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('scheduled_tasks.lock'))
  assert.ok(result.sources.reverted.includes('scheduled_tasks.lock'))
  assert.ok(result.sources.ignored.includes('scheduled_tasks.lock'), 'an ignored path surfaced via the reverted branch must still be named in sources.ignored')
})

test('touchedPaths: a non-ignored dirty file never lands in sources.ignored', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  writeFileSync(join(checkout, 'ordinary.txt'), 'not ignored\n')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('ordinary.txt'))
  assert.ok(!result.sources.ignored.includes('ordinary.txt'))
})

// ---------------------------------------------------------------------------
// parsePorcelainZ: positives, then the rename-desync negative, then the
// truncated-buffer negatives.
// ---------------------------------------------------------------------------

test('parsePorcelainZ: an ordinary modified entry', () => {
  const buf = Buffer.from('M  file.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [{ xy: 'M ', path: 'file.txt' }])
})

test('parsePorcelainZ: an untracked entry inside a new directory keeps the full path', () => {
  const buf = Buffer.from('?? newdir/inner.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [{ xy: '??', path: 'newdir/inner.txt' }])
})

test('parsePorcelainZ: a rename entry yields { xy, path: TO, from: FROM }', () => {
  const buf = Buffer.from('R  newname.txt\0oldname.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [{ xy: 'R ', path: 'newname.txt', from: 'oldname.txt' }])
})

test('parsePorcelainZ: a copy entry is handled the same way as a rename', () => {
  const buf = Buffer.from('C  copy.txt\0source.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [{ xy: 'C ', path: 'copy.txt', from: 'source.txt' }])
})

test('parsePorcelainZ: an index-side rename shape (xy[0]="R") pairs its FROM token', () => {
  const buf = Buffer.from('R  to.txt\0from.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [{ xy: 'R ', path: 'to.txt', from: 'from.txt' }])
})

test('parsePorcelainZ: a worktree-side rename shape (X blank, xy[1]="R") also pairs its FROM token — the bypass this fix exists to close', () => {
  // Git documents this shape too: X is blank (unstaged) while Y carries the
  // rename/copy letter. A parser that only checks xy[0] would treat this as
  // an ordinary one-token entry and desync every entry that follows it.
  const buf = Buffer.from(' R to.txt\0from.txt\0M  c.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [
    { xy: ' R', path: 'to.txt', from: 'from.txt' },
    { xy: 'M ', path: 'c.txt' },
  ])
})

test('parsePorcelainZ: a worktree-side copy shape (X blank, xy[1]="C") also pairs its FROM token', () => {
  const buf = Buffer.from(' C copy.txt\0source.txt\0?? untouched.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [
    { xy: ' C', path: 'copy.txt', from: 'source.txt' },
    { xy: '??', path: 'untouched.txt' },
  ])
})

test('parsePorcelainZ negative: a worktree-side rename entry misparsed as xy[0]-only would desync the FOLLOWING protected-path entry (mutation-catching)', () => {
  // Mirrors the reviewer-reproduced bypass: an unpaired worktree-rename FROM
  // token that looks like a plain entry swallows the real entry after it.
  const buf = Buffer.from(' R to.txt\0from.txt\0?? .claude/dev-team/memory/tampered.md\0', 'utf8')
  const entries = parsePorcelainZ(buf)
  assert.deepEqual(entries, [
    { xy: ' R', path: 'to.txt', from: 'from.txt' },
    { xy: '??', path: '.claude/dev-team/memory/tampered.md' },
  ])
  assert.ok(entries.some((e) => e.path === '.claude/dev-team/memory/tampered.md'), 'the protected-path entry must survive intact, not be swallowed as a phantom FROM token')
})

test('touchedPaths end-to-end: a real `mv` + `git add -N` (worktree-side rename) still surfaces both the TO and FROM path via a real git checkout', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  execFileSync('mv', [join(checkout, 'README.md'), join(checkout, 'RENAMED.md')])
  execFileSync('git', ['add', '-N', 'RENAMED.md'], { cwd: checkout })

  // Confirm the worktree-side shape is actually what git emits here: X blank,
  // Y = 'R'.
  const entries = statusSnapshot(checkout)
  const renameEntry = entries.find((e) => e.from === 'README.md' || e.path === 'README.md')
  assert.ok(renameEntry, 'expected a rename/copy-shaped entry pairing README.md')
  assert.equal(renameEntry.xy[0], ' ', 'expected the worktree-side shape (X blank)')
  assert.equal(renameEntry.xy[1], 'R', 'expected Y="R" for the worktree-side rename shape')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('README.md'), 'FROM side missing for a real mv + git add -N worktree rename')
  assert.ok(result.paths.includes('RENAMED.md'), 'TO side missing for a real mv + git add -N worktree rename')
})

test('parsePorcelainZ: empty buffer parses to []', () => {
  assert.deepEqual(parsePorcelainZ(Buffer.alloc(0)), [])
})

test('parsePorcelainZ negative: a rename followed by two ordinary entries must not desync (mutation-catching)', () => {
  // A parser that blindly splits on '\0' and slices at fixed offsets would
  // consume the wrong number of tokens for the rename pair and mislabel
  // everything after it. This fixture pins the exact, correctly-synced
  // entry list.
  const buf = Buffer.from('R  b.txt\0a.txt\0M  c.txt\0?? d.txt\0', 'utf8')
  assert.deepEqual(parsePorcelainZ(buf), [
    { xy: 'R ', path: 'b.txt', from: 'a.txt' },
    { xy: 'M ', path: 'c.txt' },
    { xy: '??', path: 'd.txt' },
  ])
})

test('parsePorcelainZ negative: a buffer with no trailing NUL throws status_unparseable (never silently dropped)', () => {
  const buf = Buffer.from('M  file.txt', 'utf8') // no terminator at all
  assert.throws(
    () => parsePorcelainZ(buf),
    (err) => err instanceof EvidenceError && err.code === 'status_unparseable',
  )
})

test('parsePorcelainZ negative: trailing garbage after the last well-formed entry throws status_unparseable', () => {
  const buf = Buffer.from('M  a.txt\0M  b', 'utf8') // second entry never terminated
  assert.throws(
    () => parsePorcelainZ(buf),
    (err) => err instanceof EvidenceError && err.code === 'status_unparseable',
  )
})

test('parsePorcelainZ negative: a rename entry missing its FROM pair throws status_unparseable', () => {
  const buf = Buffer.from('R  b.txt\0', 'utf8') // FROM token never arrives
  assert.throws(
    () => parsePorcelainZ(buf),
    (err) => err instanceof EvidenceError && err.code === 'status_unparseable',
  )
})

// ---------------------------------------------------------------------------
// hashFileSha256
// ---------------------------------------------------------------------------

test('hashFileSha256 returns the real sha256 hex digest for an existing file, and null for an absent one', () => {
  const dir = freshTmp()
  const filePath = join(dir, 'x.txt')
  writeFileSync(filePath, 'hello world\n')
  assert.equal(hashFileSha256(filePath), sha256(Buffer.from('hello world\n')))
  assert.equal(hashFileSha256(join(dir, 'does-not-exist.txt')), null)
})

// ---------------------------------------------------------------------------
// writeBaselineExclusive / readBaseline
// ---------------------------------------------------------------------------

test('writeBaselineExclusive writes once, then throws EvidenceError(baseline_exists) on a second capture', () => {
  const dir = freshTmp()
  const baselinePath = join(dir, 'baseline.json')
  const baseline = { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} }

  writeBaselineExclusive(baselinePath, baseline)
  assert.ok(existsSync(baselinePath))
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, 'utf8')), baseline)

  assert.throws(
    () => writeBaselineExclusive(baselinePath, baseline),
    (err) => err instanceof EvidenceError && err.code === 'baseline_exists',
  )
})

test('readBaseline returns null iff the file is absent', () => {
  const dir = freshTmp()
  assert.equal(readBaseline(join(dir, 'nope.json')), null)
})

test('readBaseline throws baseline_malformed for unreadable content (a directory, not a file)', () => {
  const dir = freshTmp()
  const asDir = join(dir, 'baseline-is-a-dir.json')
  mkdirSync(asDir)
  assert.throws(
    () => readBaseline(asDir),
    (err) => err instanceof EvidenceError && err.code === 'baseline_malformed',
  )
})

test('readBaseline throws baseline_malformed for unparseable JSON', () => {
  const dir = freshTmp()
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, '{ not valid json')
  assert.throws(
    () => readBaseline(baselinePath),
    (err) => err instanceof EvidenceError && err.code === 'baseline_malformed',
  )
})

test('readBaseline negative (single mutation): missing/non-string anchor_sha', () => {
  const dir = freshTmp()
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, JSON.stringify({ reason: 'r', captured_at: new Date().toISOString(), dirty: {} }))
  assert.throws(
    () => readBaseline(baselinePath),
    (err) => err instanceof EvidenceError && err.code === 'baseline_malformed',
  )
})

test('readBaseline negative (single mutation): missing/non-object dirty', () => {
  const dir = freshTmp()
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, JSON.stringify({ anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString() }))
  assert.throws(
    () => readBaseline(baselinePath),
    (err) => err instanceof EvidenceError && err.code === 'baseline_malformed',
  )
})

test('readBaseline negative (single mutation): a dirty entry lacking xy or sha256 keys', () => {
  const dir = freshTmp()
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, JSON.stringify({
    anchor_sha: 'a'.repeat(40),
    reason: 'r',
    captured_at: new Date().toISOString(),
    dirty: { 'a.txt': { xy: 'M ' } }, // sha256 key entirely absent
  }))
  assert.throws(
    () => readBaseline(baselinePath),
    (err) => err instanceof EvidenceError && err.code === 'baseline_malformed',
  )
})

// ---------------------------------------------------------------------------
// touchedPaths: three-way union over real git fixtures, plus the four named
// cases and their paired positives.
// ---------------------------------------------------------------------------

test('touchedPaths case (a): a git mv rename touches BOTH the TO and the FROM path', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })
  assert.deepEqual(baseline.dirty, {})

  execFileSync('git', ['mv', 'README.md', 'RENAMED.md'], { cwd: checkout })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('README.md'), 'FROM side missing')
  assert.ok(result.paths.includes('RENAMED.md'), 'TO side missing')

  // Degenerate guard: "returns only the FROM side of a rename" would leave
  // RENAMED.md out of dirty entirely — assert both sides are attributed to
  // the dirty source, not just one.
  assert.ok(result.sources.dirty.includes('README.md'))
  assert.ok(result.sources.dirty.includes('RENAMED.md'))
})

test('touchedPaths case (b): an untracked file inside a brand-new directory keeps its full path (the -uall proof)', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  mkdirSync(join(checkout, 'newdir'))
  writeFileSync(join(checkout, 'newdir', 'inner.txt'), 'new file\n')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('newdir/inner.txt'), 'expected the full untracked path, not a collapsed directory entry')
  assert.ok(!result.paths.includes('newdir/'), 'directory entry must never appear as a touched path')

  // Regression proof: git's own default `-u` collapses the same tree to
  // "newdir/" — this is exactly the failure -uall exists to avoid.
  const defaultStatus = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: checkout, encoding: 'buffer' }).toString('utf8')
  assert.ok(defaultStatus.includes('newdir/\0') || defaultStatus.includes('?? newdir/'), 'expected default -u status to collapse the new directory')
})

test('touchedPaths case (c): a baseline-dirty file edited then restored to its original committed bytes counts as touched (source 3, content-only)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'README.md'), '# sample repo\ndirty at baseline\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })
  assert.ok(baseline.dirty['README.md'])

  // Edit further, then fully revert back to the ORIGINAL committed bytes —
  // git status shows no difference from HEAD any more, so path-membership
  // diffing alone would call this untouched. Content comparison must not.
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nyet another edit\n')
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: checkout })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('README.md'), 'reverted-to-committed file must still count as touched')
  assert.ok(result.sources.reverted.includes('README.md'))
  assert.ok(!result.sources.dirty.includes('README.md'), 'the file is absent from the fresh status snapshot; it belongs to reverted, not dirty')
})

test('touchedPaths case (d): a baseline-dirty file left as the user own untouched edit is NOT counted as touched', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nuser edit, never touched again\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(!result.paths.includes('README.md'), 'an unchanged baseline-dirty file must not be reported as touched')
  assert.ok(!result.sources.reverted.includes('README.md'))
})

test('touchedPaths source (1): a committed change between anchor_sha and HEAD is touched', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  writeFileSync(join(checkout, 'committed.txt'), 'new committed file\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add committed.txt'], { cwd: checkout })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('committed.txt'))
  assert.ok(result.sources.committed.includes('committed.txt'))
})

// ---------------------------------------------------------------------------
// touchedPaths committed-rename fix: `git diff --name-only` has rename
// detection ON by default, which prints ONLY the destination path for a
// COMMITTED rename — the FROM path (e.g. a protected path vacated by a
// committed `git mv`) never enters sources.committed at all. This is the
// sibling bug to parsePorcelainZ's worktree-side rename fix above, but on
// the completely separate committed-diff code path. Verified against real
// (unmocked) git — never a synthetic/mocked diff-output test.
// ---------------------------------------------------------------------------

test('touchedPaths committed rename: a `git mv` that is COMMITTED (not left dirty) surfaces BOTH the FROM and TO path in sources.committed (real git, reviewer-reported regression)', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'notes.md'), 'protected memory content\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add protected memory file'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  // Confirm real git's default (rename detection ON) behavior really does
  // drop the FROM path for a committed rename — the exact regression this
  // fix exists to close, pinned against the actual git binary in use.
  mkdirSync(join(checkout, 'docs'), { recursive: true })
  execFileSync('git', ['mv', '.claude/dev-team/memory/notes.md', 'docs/notes.md'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'move protected file out'], { cwd: checkout })

  const renameAwareDiff = execFileSync(
    'git',
    ['diff', '--name-only', '-z', `${baseline.anchor_sha}..HEAD`],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8').split('\0').filter((p) => p.length > 0)
  assert.ok(!renameAwareDiff.includes('.claude/dev-team/memory/notes.md'), 'expected real git rename detection to actually drop the FROM path by default (the regression under test)')
  assert.ok(renameAwareDiff.includes('docs/notes.md'))

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.sources.committed.includes('.claude/dev-team/memory/notes.md'), 'FROM side of a committed rename missing from sources.committed — the protected path vacated by a committed git mv must never be invisible')
  assert.ok(result.sources.committed.includes('docs/notes.md'), 'TO side of a committed rename missing from sources.committed')
  assert.ok(result.paths.includes('.claude/dev-team/memory/notes.md'))
  assert.ok(result.paths.includes('docs/notes.md'))
})

test('touchedPaths committed rename: a committed rename INTO a would-be-protected-shaped path still shows the destination (paired positive, confirms the fix does not flip which side is visible)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'source.md'), 'ordinary content\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add source file'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  execFileSync('git', ['mv', 'source.md', '.claude/dev-team/memory/moved-in.md'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'move file into protected prefix'], { cwd: checkout })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.sources.committed.includes('.claude/dev-team/memory/moved-in.md'), 'TO side of a committed rename into a protected-shaped path must be visible')
  assert.ok(result.sources.committed.includes('source.md'), 'FROM side must also be visible (--no-renames pairing, not a flip)')
})

// Named degenerate assertions (each described in the spec as a wrong
// implementation this suite must catch). We assert the REAL result would
// contradict each degenerate's output, rather than reimplementing the bug.

test('degenerate guard: "always returns []" fails every positive case above', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })
  execFileSync('git', ['mv', 'README.md', 'RENAMED.md'], { cwd: checkout })
  const result = touchedPaths({ cwd: checkout, baseline })
  assert.notDeepEqual(result.paths, [], 'an always-[] implementation would wrongly report nothing touched')
})

test('degenerate guard: "a diff-only comparison blind to reversions and untracked files" fails cases (b) and (c)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'README.md'), '# sample repo\ndirty at baseline\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })

  mkdirSync(join(checkout, 'newdir'))
  writeFileSync(join(checkout, 'newdir', 'inner.txt'), 'new file\n')
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nyet another edit\n')
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: checkout })

  // A diff-only degenerate: `git diff --name-only anchor_sha..HEAD` sees
  // neither the untracked file nor the reverted one (both are working-tree
  // state, not committed history).
  const diffOnly = execFileSync('git', ['diff', '--name-only', '-z', `${baseline.anchor_sha}..HEAD`], { cwd: checkout, encoding: 'buffer' })
    .toString('utf8').split('\0').filter((p) => p.length > 0)
  assert.ok(!diffOnly.includes('newdir/inner.txt'))
  assert.ok(!diffOnly.includes('README.md'))

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('newdir/inner.txt'))
  assert.ok(result.paths.includes('README.md'))
})

test('degenerate guard: "path-membership diffing of baseline.dirty against current status" fails case (c)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'README.md'), '# sample repo\ndirty at baseline\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })

  writeFileSync(join(checkout, 'README.md'), '# sample repo\nyet another edit\n')
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: checkout })

  // A membership-only degenerate: is README.md still present in the fresh
  // status snapshot at all? It is not (git sees no diff from HEAD), so a
  // membership check alone reports "not touched" — the content-hash
  // comparison in touchedPaths must disagree.
  const freshPaths = statusSnapshot(checkout).map((e) => e.path)
  assert.ok(!freshPaths.includes('README.md'))

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('README.md'))
})

test('degenerate guard: "returns only the FROM side of a rename" fails case (a)', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })
  execFileSync('git', ['mv', 'README.md', 'RENAMED.md'], { cwd: checkout })

  const result = touchedPaths({ cwd: checkout, baseline })
  const fromOnlyDegenerate = ['README.md']
  assert.notDeepEqual(result.paths.slice().sort(), fromOnlyDegenerate.sort(), 'a FROM-only implementation must not match the real (TO+FROM) result')
  assert.ok(result.paths.includes('RENAMED.md'))
})

// ---------------------------------------------------------------------------
// runValidationCommand: spawn-shape pin, refusals, exit classification order,
// timeout, missing binary, huge output.
// ---------------------------------------------------------------------------

test('runValidationCommand spawn shape: stdio is [ignore, fd, fd] and never "pipe" (source-text pin)', () => {
  const spawnCallMatch = EVIDENCE_SOURCE.match(/spawnSync\(argv\[0\], argv\.slice\(1\), \{([^}]*)\}\)/s)
  assert.ok(spawnCallMatch, 'expected the runner spawnSync(argv[0], argv.slice(1), {...}) call')
  const optionsText = spawnCallMatch[1]
  assert.ok(optionsText.includes("stdio: ['ignore', fd, fd]"), 'stdio array shape must be exactly [ignore, fd, fd]')
  const pipeToken = ['pi', 'pe'].join('')
  assert.ok(!optionsText.includes(pipeToken), 'the spawn options must never mention "pipe"')
})

test('runValidationCommand refuses a shell-metacharacter command as { classified: "refused", ok: false }', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'echo hi; rm -rf /', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'log.txt') })
  assert.equal(result.classified, 'refused')
  assert.equal(result.code, null)
  assert.equal(result.ok, false)
  assert.ok(result.note && result.note.length > 0)
})

test('runValidationCommand refuses a bash -c interpreter command as { classified: "refused", ok: false }', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'bash -c ls', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'log.txt') })
  assert.equal(result.classified, 'refused')
  assert.equal(result.code, null)
  assert.equal(result.ok, false)
})

test('runValidationCommand classifies a missing binary as { classified: "missing_binary", code: 127 }', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'nonexistent-binary-zzz --version', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'missing_binary', code: 127 })
})

test('runValidationCommand classification order: missing binary yields 127 even when a timeout is also set', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'nonexistent-binary-zzz', cwd: dir, timeoutMs: 300, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'missing_binary', code: 127 })
})

test('runValidationCommand classification order (real pin): with timeoutMs: 0, elapsedMs >= timeoutMs is trivially true AND res.error.code === "ENOENT" is true simultaneously — missing_binary must still win over timeout', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'nonexistent-binary-zzz', cwd: dir, timeoutMs: 0, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'missing_binary', code: 127 })
})

test('runValidationCommand times out at 300ms against a fixture that holds the event loop and is classified { timeout, 124 }', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: `node ${SLOW_FIXTURE} run`, cwd: dir, timeoutMs: 300, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'timeout', code: 124 })
})

test('runValidationCommand classifies a real non-executable file (EACCES, not ENOENT) as { classified: "spawn_error", code: null }, preserving the real error message', () => {
  const dir = freshTmp()
  const binPath = join(dir, 'badbin')
  writeFileSync(binPath, '#!/bin/sh\necho should never run\n')
  chmodSync(binPath, 0o644) // no execute bit -> EACCES, not ENOENT

  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath || ''}`
  try {
    const result = runValidationCommand({ cmd: 'badbin', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'log.txt') })
    assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'spawn_error', code: null })
    assert.ok(result.note && result.note.length > 0, 'note must carry the real spawn error, never be blank')
    assert.ok(/EACCES/.test(result.note), `expected the real EACCES message to survive into the note, got: ${result.note}`)
  } finally {
    process.env.PATH = originalPath
  }
})

test('runValidationCommand classification order: ETIMEDOUT (spawnSync\'s own authoritative timeout signal) still wins, pinned at timeoutMs: 1 against a fixture that holds the event loop', () => {
  const dir = freshTmp()
  // timeoutMs: 1 fires spawnSync's own timer almost immediately.
  // res.error.code === 'ETIMEDOUT' is the SOLE predicate this file uses to
  // classify a timeout — the previous wall-clock-elapsed heuristic
  // (status === null && elapsedMs >= timeoutMs) was removed entirely: it
  // could misfire on a child killed by an unrelated external signal that
  // merely landed at/after timeoutMs, and could misclassify a real spawn
  // error (at timeoutMs: 0) as a timeout instead. This test pins that
  // ETIMEDOUT alone still correctly wins here.
  const result = runValidationCommand({ cmd: `node ${SLOW_FIXTURE} run`, cwd: dir, timeoutMs: 1, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'timeout', code: 124 })
})

test('runValidationCommand: a real successful command is classified { exit, 0 } and ok is true', () => {
  const dir = freshTmp()
  const result = runValidationCommand({ cmd: 'node --version', cwd: dir, timeoutMs: 5000, logPath: join(dir, 'log.txt') })
  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'exit', code: 0 })
  assert.equal(result.ok, true)
})

test('runValidationCommand: two failing commands run independently with no short-circuiting', () => {
  const dir = freshTmp()
  const first = runValidationCommand({ cmd: 'nonexistent-binary-zzz', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'a.log') })
  const second = runValidationCommand({ cmd: 'nonexistent-binary-zzz-two', cwd: dir, timeoutMs: 1000, logPath: join(dir, 'b.log') })
  assert.equal(first.classified, 'missing_binary')
  assert.equal(second.classified, 'missing_binary')
  assert.notEqual(first.log_path, second.log_path)
})

test('runValidationCommand huge output: >4MB on stdout+stderr never throws, is not ENOBUFS, and the tail is bounded and complete on disk', () => {
  const dir = freshTmp()
  const logPath = join(dir, 'huge.log')
  const result = runValidationCommand({ cmd: `node ${HUGE_FIXTURE} run`, cwd: dir, timeoutMs: 10000, logPath })

  assert.deepEqual({ classified: result.classified, code: result.code }, { classified: 'exit', code: 7 })
  assert.ok(result.tail.length <= 4096, 'tail must be bounded to at most 4096 bytes')

  // ENOBUFS is unreachable by construction here: stdio is a single shared fd
  // (no pipe, no maxBuffer), so spawnSync never buffers into memory — that
  // IS the fix this test proves.
  const onDiskSize = readFileSync(logPath).length
  assert.ok(onDiskSize >= 2 * 5 * 1024 * 1000, 'the log file on disk must contain the full byte count from both streams')
})

test('runValidationCommand tail read: never a full-file read (source-text pin)', () => {
  const readFileSyncOnLogPath = /readFileSync\(logPath\)/
  assert.ok(!readFileSyncOnLogPath.test(EVIDENCE_SOURCE), 'the tail path must never call readFileSync(logPath) — it must be a bounded readSync')
})

test('runValidationCommand tail read: a SHORT log (never truncated) keeps its true first line — the leading-line-drop bug this test catches', () => {
  const dir = freshTmp()
  const scriptPath = join(dir, 'short.mjs')
  writeFileSync(
    scriptPath,
    "process.stdout.write('FAIL: expected 3 got 4\\n')\nprocess.stdout.write('at test/foo.test.mjs:12\\n')\nprocess.exit(1)\n",
  )
  const result = runValidationCommand({ cmd: `node ${scriptPath}`, cwd: dir, timeoutMs: 5000, logPath: join(dir, 'short.log') })
  assert.equal(result.classified, 'exit')
  assert.ok(result.tail.includes('FAIL: expected 3 got 4'), `a short/untruncated log must keep its true first line; got tail: ${JSON.stringify(result.tail)}`)
  assert.ok(result.tail.includes('at test/foo.test.mjs:12'))
})

test('runValidationCommand tail read: a 4000-byte boundary landing mid-multi-byte-character decodes with no U+FFFD', () => {
  const dir = freshTmp()
  // The runner truncates logPath on every call (openSync(logPath, 'w')), so
  // the crafted bytes must come from the CHILD PROCESS's own stdout, not a
  // pre-seeded log file. A tiny dump script (built at test time, not a
  // checked-in fixture) reads a crafted data file and writes it verbatim.
  const filler = Buffer.alloc(3997, 0x61) // 'a' * 3997
  const snowman = Buffer.from('☃', 'utf8') // 3 bytes, split by the 4000-byte tail boundary
  const rest = Buffer.from('rest of the line\n', 'utf8')
  const full = Buffer.concat([filler, snowman, rest])

  const dataPath = join(dir, 'data.bin')
  writeFileSync(dataPath, full)
  const dumpScriptPath = join(dir, 'dump.mjs')
  writeFileSync(
    dumpScriptPath,
    `import { readFileSync } from 'node:fs'\nprocess.stdout.write(readFileSync(${JSON.stringify(dataPath)}))\n`,
  )

  const result = runValidationCommand({ cmd: `node ${dumpScriptPath}`, cwd: dir, timeoutMs: 5000, logPath: join(dir, 'boundary.log') })
  assert.equal(result.classified, 'exit')
  assert.ok(!result.tail.includes('�'), 'decoded tail must contain no U+FFFD replacement character')
})

// ---------------------------------------------------------------------------
// Index-bit fail-open fix (assume-unchanged / skip-worktree, CRITICAL
// review fix): git status has NO flag that can override either bit, so a
// path with either set is invisible to statusSnapshot entirely, no matter
// what mutates on disk underneath it. flaggedIndexPaths (git ls-files -v -z)
// is the only primitive that can see these bits at all, and every fixture
// below is a REAL `git update-index --assume-unchanged|--skip-worktree`
// checkout — never a synthetic/mocked git output.
// ---------------------------------------------------------------------------

test('flaggedIndexPaths: real git letter scheme — lowercase "h" for assume-unchanged, uppercase "S" for skip-worktree, both detected', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'au.txt'), 'a\n')
  writeFileSync(join(checkout, 'sw.txt'), 'b\n')
  writeFileSync(join(checkout, 'plain.txt'), 'c\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add fixtures'], { cwd: checkout })
  execFileSync('git', ['update-index', '--assume-unchanged', 'au.txt'], { cwd: checkout })
  execFileSync('git', ['update-index', '--skip-worktree', 'sw.txt'], { cwd: checkout })

  // Pin the actual letters real git emits, so this test would fail loudly if
  // a future git version ever changed the scheme this fix depends on.
  const rawEntries = execFileSync('git', ['ls-files', '-v', '-z'], { cwd: checkout, encoding: 'buffer' })
    .toString('utf8').split('\0').filter((t) => t.length > 0)
  assert.ok(rawEntries.includes('h au.txt'), `expected real git to emit "h au.txt", got: ${JSON.stringify(rawEntries)}`)
  assert.ok(rawEntries.includes('S sw.txt'), `expected real git to emit "S sw.txt", got: ${JSON.stringify(rawEntries)}`)

  const flagged = flaggedIndexPaths(checkout)
  assert.ok(flagged.has('au.txt'))
  assert.ok(flagged.has('sw.txt'))
  assert.ok(!flagged.has('plain.txt'), 'a plain tracked file with neither bit set must never be reported flagged')
})

test('flaggedIndexPaths: assume-unchanged stacked ON TOP of skip-worktree lowercases the letter to "s", still detected as skip-worktree (real git, case-robustness proof)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'both.txt'), 'x\n')
  execFileSync('git', ['add', 'both.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add both.txt'], { cwd: checkout })
  execFileSync('git', ['update-index', '--skip-worktree', 'both.txt'], { cwd: checkout })
  execFileSync('git', ['update-index', '--assume-unchanged', 'both.txt'], { cwd: checkout })

  const rawEntries = execFileSync('git', ['ls-files', '-v', '-z'], { cwd: checkout, encoding: 'buffer' })
    .toString('utf8').split('\0').filter((t) => t.length > 0)
  assert.ok(rawEntries.includes('s both.txt'), `expected real git to lowercase skip-worktree's "S" to "s" when assume-unchanged stacks on top, got: ${JSON.stringify(rawEntries)}`)

  assert.ok(flaggedIndexPaths(checkout).has('both.txt'))
})

test('statusSnapshot / touchedPaths: an assume-unchanged path whose on-disk content is mutated afterward is invisible to plain git status but still reported touched (real git fixture, reviewer repro)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'watched.txt'), 'original\n')
  execFileSync('git', ['add', 'watched.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add watched.txt'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  execFileSync('git', ['update-index', '--assume-unchanged', 'watched.txt'], { cwd: checkout })
  writeFileSync(join(checkout, 'watched.txt'), 'MUTATED CONTENT\n')

  const plainStatus = execFileSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8')
  assert.ok(!plainStatus.includes('watched.txt'), 'expected real git status to be blind to an assume-unchanged mutation (the bug this fix closes)')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('watched.txt'), 'an assume-unchanged mutated file must be reported touched')
  assert.ok(result.sources.indexBits.includes('watched.txt'))
})

test('statusSnapshot / touchedPaths: a skip-worktree path whose file is deleted from disk afterward is invisible to plain git status but still reported touched (real git fixture, reviewer repro)', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'skip.txt'), 'original\n')
  execFileSync('git', ['add', 'skip.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add skip.txt'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  execFileSync('git', ['update-index', '--skip-worktree', 'skip.txt'], { cwd: checkout })
  unlinkSync(join(checkout, 'skip.txt'))

  const plainStatus = execFileSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8')
  assert.ok(!plainStatus.includes('skip.txt'), 'expected real git status to be blind to a skip-worktree deletion (the bug this fix closes)')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('skip.txt'), 'a skip-worktree deleted file must be reported touched')
  assert.ok(result.sources.indexBits.includes('skip.txt'))
})

test('captureBaseline: an assume-unchanged path lands in baseline.dirty with a REAL on-disk sha256 captured directly via the filesystem, never crashing despite git being blind to it', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'watched.txt'), 'original\n')
  execFileSync('git', ['add', 'watched.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add watched.txt'], { cwd: checkout })
  execFileSync('git', ['update-index', '--assume-unchanged', 'watched.txt'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'baseline with index bit set' })
  assert.ok(Object.prototype.hasOwnProperty.call(baseline.dirty, 'watched.txt'), 'expected the assume-unchanged path to be captured into baseline.dirty despite git status never reporting it')
  assert.equal(baseline.dirty['watched.txt'].sha256, sha256(readFileSync(join(checkout, 'watched.txt'))), 'expected a real filesystem-derived sha256, not null')
})

test('touchedPaths -> checkScopeCompliance end-to-end: assume-unchanged (overwritten) + skip-worktree (deleted) on protected-prefix paths produce hard_fail:true through the full pipeline (real git, mirrors the reviewer\'s exact repro)', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'original config\n')
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'MEMORY.md'), 'original memory\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add protected files'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  // Reviewer's exact repro: assume-unchanged + overwrite on one protected
  // path, skip-worktree + rm on another.
  execFileSync('git', ['update-index', '--assume-unchanged', '.claude/dev-team/config.md'], { cwd: checkout })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'TAMPERED config\n')

  execFileSync('git', ['update-index', '--skip-worktree', '.claude/dev-team/memory/MEMORY.md'], { cwd: checkout })
  unlinkSync(join(checkout, '.claude', 'dev-team', 'memory', 'MEMORY.md'))

  const plainStatus = execFileSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8')
  assert.equal(plainStatus.length, 0, 'expected real git status to report NOTHING at all for the reviewer repro — the exact fail-open this fix closes')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('.claude/dev-team/config.md'))
  assert.ok(result.paths.includes('.claude/dev-team/memory/MEMORY.md'))
  assert.ok(result.sources.indexBits.includes('.claude/dev-team/config.md'))
  assert.ok(result.sources.indexBits.includes('.claude/dev-team/memory/MEMORY.md'))

  const check = checkScopeCompliance(result.paths, [], result.sources.ignored)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/config.md'))
  assert.ok(check.note.includes('.claude/dev-team/memory/MEMORY.md'))
})

test('touchedPaths regression: an ordinary file with neither index bit set is unaffected by the new index-bit source — no double counting, no blanket-flagging every file', () => {
  const checkout = makeGitCheckout(freshTmp())
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })
  writeFileSync(join(checkout, 'ordinary.txt'), 'plain edit\n')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(result.paths.includes('ordinary.txt'))
  assert.equal(result.paths.filter((p) => p === 'ordinary.txt').length, 1, 'must not be double-counted across sources')
  assert.ok(!result.sources.indexBits.includes('ordinary.txt'))
  assert.deepEqual(result.sources.indexBits, [], 'no file in this fixture has either index bit set — the new source must not blanket-flag every file')
})

// ---------------------------------------------------------------------------
// flaggedIndexPaths cwd-scope fix (LAST fix round, issue #28): plain
// `git ls-files -v -z` with no pathspec and no --full-name is cwd-SCOPED
// (only lists entries under cwd) and emits paths relative to cwd, not the
// repo root — unlike statusSnapshot/touchedPaths's `git diff`, both of which
// cover the whole tree and emit repo-root-relative paths regardless of cwd.
// `--full-name -- :/` closes both gaps. Every fixture below runs with cwd
// set to a SUBDIRECTORY of the checkout (gates.mjs's working root is
// `options.checkout ? resolvePath(options.checkout) : process.cwd()`, with
// no toplevel normalization — a non-toplevel cwd is reachable by ordinary
// invocation).
// ---------------------------------------------------------------------------

test('flaggedIndexPaths: cwd set to a SUBDIRECTORY of the checkout still reports a flagged path elsewhere in the tree, correctly root-relative', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  mkdirSync(join(checkout, 'src'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'original config\n')
  writeFileSync(join(checkout, 'src', 'app.js'), 'console.log(1)\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add fixtures'], { cwd: checkout })
  execFileSync('git', ['update-index', '--assume-unchanged', '.claude/dev-team/config.md'], { cwd: checkout })

  const subdir = join(checkout, 'src')

  const flaggedFromRoot = flaggedIndexPaths(checkout)
  const flaggedFromSubdir = flaggedIndexPaths(subdir)

  assert.ok(flaggedFromRoot.has('.claude/dev-team/config.md'))
  assert.deepEqual(
    [...flaggedFromSubdir].sort(),
    [...flaggedFromRoot].sort(),
    'flaggedIndexPaths must report the SAME root-relative set regardless of which subdirectory cwd is set to',
  )
  assert.ok(
    flaggedFromSubdir.has('.claude/dev-team/config.md'),
    'a flagged path outside the subdirectory cwd must still be reported, correctly prefixed with .claude/ (not collapsed to dev-team/config.md)',
  )
})

test('touchedPaths -> checkScopeCompliance end-to-end with cwd set to a SUBDIRECTORY of the checkout: the flagged protected path is still root-relative and still trips hard_fail:true (regression for the cwd-scope bug this fix closes)', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  mkdirSync(join(checkout, 'src'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'original config\n')
  writeFileSync(join(checkout, 'src', 'app.js'), 'console.log(1)\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add fixtures'], { cwd: checkout })

  // Baseline is captured from the checkout root (as gates.mjs normally
  // would), BEFORE the subdirectory-cwd gate run below.
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  execFileSync('git', ['update-index', '--assume-unchanged', '.claude/dev-team/config.md'], { cwd: checkout })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'TAMPERED config\n')

  // The gate run itself happens with cwd set to a subdirectory — the exact
  // reachable-by-ordinary-invocation shape this fix closes (e.g. `--checkout`
  // pointed at a subdirectory, or the CLI simply invoked from one).
  const subdir = join(checkout, 'src')
  const result = touchedPaths({ cwd: subdir, baseline })

  assert.ok(
    result.paths.includes('.claude/dev-team/config.md'),
    `expected the flagged protected path to be reported correctly root-relative even with cwd inside a subdirectory; got paths: ${JSON.stringify(result.paths)}`,
  )
  assert.ok(result.sources.indexBits.includes('.claude/dev-team/config.md'))

  const check = checkScopeCompliance(result.paths, [], result.sources.ignored)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/config.md'))
})

// ---------------------------------------------------------------------------
// core.fsmonitor blind-spot neutralization (LAST fix round, issue #28):
// core.fsmonitor is repo-local, coder-writable config (same threat model
// this file already states for diff.renames) that lets an arbitrary
// script/hook claim "nothing changed" for any path; git TRUSTS that claim
// for any index entry it has already marked fsmonitor-valid and skips the
// lstat statusSnapshot depends on. Every fixture below is a REAL fake
// fsmonitor hook script (never a mock of git's behavior) — reproducing the
// exact "an active always-clean fsmonitor hook silently defeats git
// status" bug `-c core.fsmonitor=` closes.
//
// Reproducing this requires TWO git status invocations: fsmonitor's
// per-path valid bit is only persisted into the on-disk index by a status
// run that holds the index lock and writes back the refreshed index — a
// `--no-optional-locks` run (this file's own statusSnapshot invocation)
// deliberately never takes that lock and so never writes the bit itself.
// The first invocation below (lock-holding, simulating a legitimate prior
// refresh by e.g. an IDE's watchman/fsmonitor integration) establishes the
// valid bit and stores the hook's token in the index; only after that does
// mutating the file and re-running WITHOUT the lock (this file's exact
// invocation shape) reproduce the blind spot.
// ---------------------------------------------------------------------------

function installAlwaysCleanFsmonitorHook(checkout) {
  const hookPath = join(checkout, 'always-clean-fsmonitor-hook.sh')
  // git's fsmonitor hook protocol v2: invoked as `<hook> <version> <token>`;
  // stdout is the new token followed by NUL, then NUL-separated changed
  // paths. Printing only the token (no paths) unconditionally claims
  // "nothing has changed since any given token" for the whole tree.
  writeFileSync(hookPath, '#!/bin/sh\nprintf \'faketoken\\0\'\n')
  chmodSync(hookPath, 0o755)
  execFileSync('git', ['config', 'core.fsmonitor', hookPath], { cwd: checkout })
  return hookPath
}

test('fsmonitor blind-spot repro: a real always-clean fsmonitor hook makes plain git status blind to a protected-path overwrite, once the fsmonitor-valid bit has been persisted by a prior lock-holding status run', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'watched.txt'), 'original\n')
  execFileSync('git', ['add', 'watched.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add watched.txt'], { cwd: checkout })

  installAlwaysCleanFsmonitorHook(checkout)

  // Lock-holding status run: persists the fsmonitor-valid bit + token into
  // the on-disk index (never taken by this file's own --no-optional-locks
  // invocation).
  execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'], { cwd: checkout })

  writeFileSync(join(checkout, 'watched.txt'), 'TAMPERED\n')

  const blindStatus = execFileSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8')
  assert.ok(!blindStatus.includes('watched.txt'), 'expected the always-clean fsmonitor hook to make plain git status blind to the overwrite (the bug this fix closes)')
})

test('fsmonitor blind-spot fix, verified: adding -c core.fsmonitor= to THIS FILE\'s exact statusSnapshot invocation shape neutralizes the hook and correctly reports the overwrite', () => {
  const checkout = makeGitCheckout(freshTmp())
  writeFileSync(join(checkout, 'watched.txt'), 'original\n')
  execFileSync('git', ['add', 'watched.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add watched.txt'], { cwd: checkout })

  installAlwaysCleanFsmonitorHook(checkout)
  execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'], { cwd: checkout })

  writeFileSync(join(checkout, 'watched.txt'), 'TAMPERED\n')

  const neutralizedStatus = execFileSync(
    'git',
    ['-c', 'core.fsmonitor=', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd: checkout, encoding: 'buffer' },
  ).toString('utf8')
  assert.ok(neutralizedStatus.includes('watched.txt'), 'expected -c core.fsmonitor= to neutralize the hook and correctly report the overwrite')

  // And end to end through statusSnapshot itself.
  const entries = statusSnapshot(checkout)
  assert.ok(entries.some((e) => e.path === 'watched.txt'), 'expected statusSnapshot (which now pins -c core.fsmonitor=) to correctly see the overwrite despite the active always-clean hook')
})

test('fsmonitor blind-spot fix, end-to-end: a protected-path overwrite is still detected through the full touchedPaths -> checkScopeCompliance pipeline despite an active always-clean fsmonitor hook', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'original config\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add protected file'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  installAlwaysCleanFsmonitorHook(checkout)
  execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'], { cwd: checkout })

  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'TAMPERED config\n')

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.ok(
    result.paths.includes('.claude/dev-team/config.md'),
    `expected the protected-path overwrite to be detected despite the active always-clean fsmonitor hook; got paths: ${JSON.stringify(result.paths)}`,
  )

  const check = checkScopeCompliance(result.paths, [], result.sources.ignored)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/config.md'))
})
