// scripts/chain/gates.mjs is the Option C gate kernel for issue #28: it
// collapses spec-lint, validation, scope compliance, claim-checking and
// verdict consistency into a single JSON GateReport. Every check function is
// pure over already-collected inputs (asserted directly with canned data);
// every git fixture used for the end-to-end scope_compliance suite is a REAL
// `git init` checkout (test/cmux-dispatch.test.mjs:101's makeGitCheckout
// idiom) — git itself is never faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHECK_NAMES,
  PROTECTED_PREFIXES,
  UsageError,
  parseArgs,
  baselinePathFor,
  checkArtifacts,
  checkFilesNonEmpty,
  checkJsonParses,
  collectClaims,
  checkDiffMatchesClaims,
  checkScopeCompliance,
  checkSpecLint,
  checkTestsPass,
  checkVerdictConsistent,
  buildReport,
  runChecks,
  main,
} from '../scripts/chain/gates.mjs'
import { resolveRoots, taskPaths, specPathFor } from '../scripts/cmux/resolve.mjs'
import { extractVerdictBlock, VERDICT_SECTION_MISSING } from '../scripts/cmux/return-lint.mjs'
import { captureBaseline, writeBaselineExclusive, touchedPaths } from '../scripts/chain/evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GATES_PATH = join(ROOT, 'scripts', 'chain', 'gates.mjs')
const GATES_SOURCE = readFileSync(GATES_PATH, 'utf8')

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'chain-gates-'))
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

// buildTaskPaths(dir, { repo, task }) -> { root: taskArtifactsRoot, paths }.
// A local re-derivation through resolve.mjs's OWN functions — never a
// hand-rolled path — so fixture setup and the CLI itself agree on where
// spec/returns/state live.
function buildTaskPaths(taskArtifactsRoot, { repo = 'sample-repo', task = 'sample-task' } = {}) {
  const roots = resolveRoots({ taskArtifactsRoot })
  const paths = taskPaths({ roots, repoSlug: repo, taskSlug: task })
  return paths
}

function writeSpecFixture(paths, sliceId, overrides = {}) {
  const specPath = specPathFor(paths, sliceId)
  mkdirSync(dirname(specPath), { recursive: true })
  const spec = {
    task_id: `${sliceId}-test`,
    domain: 'backend',
    goal: 'a fixture spec',
    files_in_scope: ['f.mjs'],
    constraints: [],
    acceptance_criteria: ['works'],
    validation_commands: ['node --version'],
    discovery_context: 'none',
    out_of_scope: [],
    depends_on: [],
    interface_contract: 'none',
    ...overrides,
  }
  writeFileSync(specPath, JSON.stringify(spec))
  return specPath
}

function writeReturnFixture(paths, sliceId, attempt, envelope, ext = 'json') {
  const stem = `${sliceId}.${attempt}`
  mkdirSync(paths.returnsDir, { recursive: true })
  const p = join(paths.returnsDir, `${stem}.${ext}`)
  writeFileSync(p, typeof envelope === 'string' ? envelope : JSON.stringify(envelope))
  return p
}

function baseEnvelope(sliceId, attempt, body) {
  return {
    schema_version: 1,
    dispatch_id: 'd1',
    slice_id: sliceId,
    attempt,
    role: 'coder',
    produced_at: new Date().toISOString(),
    body,
  }
}

function runCli(args, opts = {}) {
  return spawnSync('node', [GATES_PATH, ...args], { encoding: 'utf8', ...opts })
}

// ---------------------------------------------------------------------------
// Frozen closed allow-lists
// ---------------------------------------------------------------------------

test('CHECK_NAMES is exactly the frozen closed list and is actually frozen', () => {
  assert.deepEqual(CHECK_NAMES, [
    'artifacts_exist', 'files_non_empty', 'json_parses', 'diff_matches_claims',
    'scope_compliance', 'spec_lint', 'tests_pass', 'verdict_consistent',
  ])
  assert.ok(Object.isFrozen(CHECK_NAMES))
})

test('PROTECTED_PREFIXES is the frozen exact-two-entry glob-free list and is actually frozen', () => {
  assert.deepEqual(PROTECTED_PREFIXES, ['.claude/dev-team/memory/', '.claude/dev-team/config.md'])
  assert.ok(Object.isFrozen(PROTECTED_PREFIXES))
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: an unknown subcommand throws UsageError naming it', () => {
  assert.throws(() => parseArgs(['teardown', '--task', 'x']), (err) => err instanceof UsageError && err.message.includes('teardown'))
})

test('parseArgs: a --flag=value token throws UsageError naming the exact token', () => {
  assert.throws(
    () => parseArgs(['check', '--task=x', '--slice', 'a']),
    (err) => err instanceof UsageError && err.message.includes('--task=x'),
  )
})

test('parseArgs: an unrecognized flag for the subcommand throws UsageError naming it', () => {
  assert.throws(
    () => parseArgs(['baseline', '--task', 'x', '--slice', 'a', '--checks', 'spec_lint']),
    (err) => err instanceof UsageError && err.message.includes('--checks'),
  )
})

test('parseArgs: a missing required flag throws UsageError naming it', () => {
  assert.throws(() => parseArgs(['check', '--task', 'x']), (err) => err instanceof UsageError && err.message.includes('--slice'))
})

test('parseArgs: --checks NEVER silently ignores an unknown check name', () => {
  assert.throws(
    () => parseArgs(['check', '--task', 'x', '--slice', 'a', '--checks', 'spec_lint,not_a_real_check']),
    (err) => err instanceof UsageError && err.message.includes('not_a_real_check'),
  )
})

test('parseArgs: a valid check invocation parses cleanly', () => {
  const { subcommand, options } = parseArgs(['check', '--task', 'x', '--slice', 'a', '--checks', 'spec_lint,tests_pass'])
  assert.equal(subcommand, 'check')
  assert.deepEqual(options, { task: 'x', slice: 'a', checks: 'spec_lint,tests_pass' })
})

test('parseArgs: common options --checkout / --repo / --root are accepted on both subcommands', () => {
  const b = parseArgs(['baseline', '--task', 'x', '--slice', 'a', '--checkout', '/tmp/c', '--repo', 'r', '--root', '/tmp/root'])
  assert.deepEqual(b.options, { task: 'x', slice: 'a', checkout: '/tmp/c', repo: 'r', root: '/tmp/root' })
  const c = parseArgs(['check', '--task', 'x', '--slice', 'a', '--checkout', '/tmp/c', '--repo', 'r', '--root', '/tmp/root'])
  assert.deepEqual(c.options, { task: 'x', slice: 'a', checkout: '/tmp/c', repo: 'r', root: '/tmp/root' })
})

// ---------------------------------------------------------------------------
// buildReport — pure derivation
// ---------------------------------------------------------------------------

test('buildReport: hard_fail === checks.some(hard_fail) and violations === filtered+mapped checks', () => {
  const checks = [
    { item: 'a', ok: true, hard_fail: false, note: 'fine' },
    { item: 'b', ok: false, hard_fail: false, note: 'warn' },
    { item: 'c', ok: false, hard_fail: true, note: 'bad' },
  ]
  const report = buildReport({ task: 't', slice: 's', checks })
  assert.equal(report.hard_fail, true)
  assert.deepEqual(report.violations, [
    { item: 'b', hard_fail: false, note: 'warn' },
    { item: 'c', hard_fail: true, note: 'bad' },
  ])
  assert.deepEqual(report.checks, checks)
})

test('buildReport: zero violations yields hard_fail false and an empty violations array', () => {
  const checks = [{ item: 'a', ok: true, hard_fail: false, note: 'fine' }]
  const report = buildReport({ task: 't', slice: 's', checks })
  assert.equal(report.hard_fail, false)
  assert.deepEqual(report.violations, [])
})

// ---------------------------------------------------------------------------
// checkArtifacts / checkFilesNonEmpty / checkJsonParses
// ---------------------------------------------------------------------------

test('checkArtifacts: all present, at least one return file -> ok:true with a non-empty note naming size', () => {
  const items = [
    { path: '/x/spec/a.json', kind: 'spec', exists: true, sizeBytes: 2150 },
    { path: '/x/returns/a.1.json', kind: 'return-json', exists: true, sizeBytes: 800 },
  ]
  const check = checkArtifacts(items)
  assert.equal(check.item, 'artifacts_exist')
  assert.equal(check.ok, true)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.length > 0, 'note is empty string on pass') // degenerate guard
  assert.ok(check.note.includes('2.1KB'))
})

test('checkArtifacts: zero return files makes it ok:false even when the spec exists', () => {
  const items = [{ path: '/x/spec/a.json', kind: 'spec', exists: true, sizeBytes: 10 }]
  const check = checkArtifacts(items)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.length > 0)
})

test('checkArtifacts: a missing artifact makes it ok:false', () => {
  const items = [
    { path: '/x/spec/a.json', kind: 'spec', exists: false, sizeBytes: null },
    { path: '/x/returns/a.1.json', kind: 'return-json', exists: true, sizeBytes: 10 },
  ]
  const check = checkArtifacts(items)
  assert.equal(check.ok, false)
})

test('checkFilesNonEmpty: every artifact present and non-empty -> ok:true with a populated note', () => {
  const items = [
    { path: '/x/spec/a.json', exists: true, sizeBytes: 10 },
    { path: '/x/returns/a.1.json', exists: true, sizeBytes: 5 },
  ]
  const check = checkFilesNonEmpty(items)
  assert.equal(check.ok, true)
  assert.ok(check.note.length > 0)
})

test('checkFilesNonEmpty: a zero-byte artifact fails it', () => {
  const items = [{ path: '/x/spec/a.json', exists: true, sizeBytes: 0 }]
  const check = checkFilesNonEmpty(items)
  assert.equal(check.ok, false)
})

test('checkJsonParses: .json items only, .md excluded with an explicit note naming why', () => {
  const items = [
    { path: '/x/spec/a.json', exists: true, jsonOk: true, excluded: false },
    { path: '/x/returns/a.1.json', exists: true, jsonOk: true, excluded: false },
    { path: '/x/returns/a.1.md', exists: true, jsonOk: null, excluded: true },
  ]
  const check = checkJsonParses(items)
  assert.equal(check.ok, true)
  assert.ok(check.note.includes('excluded'))
  assert.ok(check.note.includes('not JSON'))
  assert.ok(check.note.includes('a.1.md'))
})

test('checkJsonParses: an unparseable .json artifact fails it and names it', () => {
  const items = [{ path: '/x/spec/a.json', exists: true, jsonOk: false, excluded: false }]
  const check = checkJsonParses(items)
  assert.equal(check.ok, false)
  assert.ok(check.note.includes('does not parse'))
})

// ---------------------------------------------------------------------------
// collectClaims / checkDiffMatchesClaims
// ---------------------------------------------------------------------------

test('collectClaims: extracts the leading token of each body.changes[] entry across every structured return', () => {
  const returnArtifacts = [
    { kind: 'return-json', exists: true, text: JSON.stringify({ body: { status: 'done', reason: 'r', changes: ['./scripts/chain/gates.mjs — did a thing', 'test/x.test.mjs - added tests'] } }) },
  ]
  const claims = collectClaims(returnArtifacts)
  assert.deepEqual(claims, ['scripts/chain/gates.mjs', 'test/x.test.mjs'])
})

test('collectClaims: no structured return yields null (never a silent empty array)', () => {
  const returnArtifacts = [{ kind: 'return-md', exists: true, text: 'some markdown' }]
  assert.equal(collectClaims(returnArtifacts), null)
})

test('checkDiffMatchesClaims: every claimed path present in the touched set -> ok:true', () => {
  const check = checkDiffMatchesClaims(['a.mjs', 'b.mjs'], ['a.mjs', 'b.mjs', 'c.mjs'])
  assert.equal(check.ok, true)
  assert.ok(check.note.length > 0)
})

test('checkDiffMatchesClaims: an unmatched claim fails and names EVERY unmatched path, not just the first', () => {
  const check = checkDiffMatchesClaims(['a.mjs', 'b.mjs', 'c.mjs'], ['a.mjs'])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.includes('b.mjs'))
  assert.ok(check.note.includes('c.mjs'))
})

test('checkDiffMatchesClaims: null claims (markdown-kind, no structured changes) yields ok:true with an explicit note, never a silent pass', () => {
  const check = checkDiffMatchesClaims(null, ['a.mjs'])
  assert.equal(check.ok, true)
  assert.ok(check.note.toLowerCase().includes('no structured changes'))
})

// ---------------------------------------------------------------------------
// checkScopeCompliance — pure-logic cases and named degenerates
// ---------------------------------------------------------------------------

test('checkScopeCompliance: a touched path inside files_in_scope is clean -> ok:true with a populated note', () => {
  const check = checkScopeCompliance(['f.mjs'], ['f.mjs'])
  assert.equal(check.ok, true)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.length > 0)
})

test('checkScopeCompliance: an out-of-scope, non-protected touch is a CORRECTABLE WARNING, never hard_fail', () => {
  const check = checkScopeCompliance(['other.mjs'], ['f.mjs'])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.includes('other.mjs'))
})

test('checkScopeCompliance: a protected touch is ok:false hard_fail:true naming every offender', () => {
  const check = checkScopeCompliance(['.claude/dev-team/config.md', '.claude/dev-team/memory/backend-notes.md'], [])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/config.md'))
  assert.ok(check.note.includes('.claude/dev-team/memory/backend-notes.md'))
})

test('checkScopeCompliance: both a protected touch and an out-of-scope touch in one run produce ONE check, hard_fail:true, with both sets named separately', () => {
  const check = checkScopeCompliance(['.claude/dev-team/config.md', 'other.mjs'], ['f.mjs'])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('protected'))
  assert.ok(check.note.includes('out-of-scope'))
  assert.ok(check.note.includes('.claude/dev-team/config.md'))
  assert.ok(check.note.includes('other.mjs'))
})

test('checkScopeCompliance: a protected path listed in files_in_scope is NOT exempt (positive requirement, directly asserted)', () => {
  const check = checkScopeCompliance(['.claude/dev-team/config.md'], ['.claude/dev-team/config.md'])
  assert.equal(check.hard_fail, true, 'listing a protected path in files_in_scope must not exempt it')
})

test('scope_compliance degenerate: "always ok:true" is refuted by the protected-touch case above', () => {
  const check = checkScopeCompliance(['.claude/dev-team/config.md'], [])
  assert.equal(check.ok, false)
})

// NOTE: the "diff-only comparison blind to reversions and untracked files"
// degenerate cannot be meaningfully refuted at this layer — checkScopeCompliance
// is a pure function over an already-computed touched LIST, and can't distinguish
// a diff-only touched-set from a correctly-computed one; that distinction only
// exists one layer down, in how the touched-set itself was computed. That
// coverage lives in evidence.mjs's own tests (see the "degenerate guard: 'a
// diff-only comparison blind to reversions and untracked files'" test in
// test/chain-evidence.test.mjs) and in the 'scope_compliance end-to-end' tests
// below, which exercise the real touchedPaths computation.

test('checkScopeCompliance: a sibling-prefix path (starts with the protected prefix STRING but is not actually under it) is NOT protected', () => {
  const check = checkScopeCompliance(['.claude/dev-team/memory-adjacent/x.md'], [])
  assert.equal(check.hard_fail, false)
  assert.equal(check.ok, false, 'still out-of-scope, non-protected — a correctable warning')
  assert.ok(!check.note.includes('protected'))
})

// ---------------------------------------------------------------------------
// checkScopeCompliance: ancestor-collapse fix — pure-logic cases (matrix
// cases 3, 4, 5 from the handover spec; case 1/2/6 are covered by the
// existing tests above/below).
// ---------------------------------------------------------------------------

test('checkScopeCompliance case 3: a directory-shaped touch that is a STRICT ANCESTOR of a protected prefix (".claude/") hard_fails, never routes to the ordinary/ignored-advisory channel', () => {
  const check = checkScopeCompliance(['.claude/'], [])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true, 'an ancestor directory of a protected prefix must be treated as a protected hit — its true contents are unknown')
  assert.ok(check.note.includes('protected'))
  assert.ok(check.note.includes('.claude/'))
})

test('checkScopeCompliance case 3: ".claude/dev-team/" (ancestor of BOTH .claude/dev-team/memory/ and .claude/dev-team/config.md) hard_fails', () => {
  const check = checkScopeCompliance(['.claude/dev-team/'], [])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('protected'))
})

test('checkScopeCompliance case 3: even when ".claude/" is also present in an ignoredPathList, it still hard_fails — ignoredPathList never exempts an ancestor-collapsed protected hit', () => {
  const check = checkScopeCompliance(['.claude/'], [], ['.claude/'])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('protected'), 'must never be routed to the advisory channel')
  assert.ok(!check.note.toLowerCase().includes('advisory'), 'the note must not carry the collapsed ancestor as an advisory entry')
})

test('checkScopeCompliance case 4: a directory-shaped SIBLING of a protected prefix (".claude/dev-team-other/", shares a string prefix but is not a true path ancestor) is NOT protected', () => {
  const check = checkScopeCompliance(['.claude/dev-team-other/'], [])
  assert.equal(check.hard_fail, false)
  assert.equal(check.ok, false, 'still out-of-scope, non-protected — a correctable warning')
  assert.ok(!check.note.includes('protected'))
})

test('checkScopeCompliance case 5: a directory-shaped touch completely unrelated to any protected prefix ("src/") is NOT protected', () => {
  const check = checkScopeCompliance(['src/'], [])
  assert.equal(check.hard_fail, false)
  assert.equal(check.ok, false, 'still out-of-scope, non-protected — a correctable warning')
  assert.ok(!check.note.includes('protected'))
})

test('checkScopeCompliance: a case-varied path is NOT protected (protected-path matching is case-sensitive)', () => {
  const check = checkScopeCompliance(['.CLAUDE/dev-team/memory/x.md', '.claude/DEV-TEAM/config.md'], [])
  assert.equal(check.hard_fail, false)
  assert.equal(check.ok, false, 'still out-of-scope, non-protected — a correctable warning')
  assert.ok(!check.note.includes('protected'))
})

test('scope_compliance degenerate: "first-offender-only naming" is refuted — every offender is named, not just the first', () => {
  const check = checkScopeCompliance(['a.mjs', 'b.mjs', 'c.mjs'], [])
  assert.ok(check.note.includes('a.mjs') && check.note.includes('b.mjs') && check.note.includes('c.mjs'), 'a first-offender-only implementation would omit b.mjs/c.mjs')
})

// ---------------------------------------------------------------------------
// Full pipeline, reviewer-exact repro: committing a `git mv` of BOTH
// protected surfaces (.claude/dev-team/memory/ and .claude/dev-team/
// config.md) out to in-scope destinations must hard_fail, end to end,
// through the real (unmocked) touchedPaths -> checkScopeCompliance path.
// This is the layer above the evidence.mjs unit fix — it is the test that
// would have caught the actually-reported failure mode.
// ---------------------------------------------------------------------------

test('full pipeline: committing a git mv of BOTH protected surfaces out to in-scope destinations still hard_fails scope_compliance (reviewer-exact repro, real git)', () => {
  const checkout = makeGitCheckout(freshTmp())
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'MEMORY.md'), 'protected memory content\n')
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'protected config content\n')
  execFileSync('git', ['add', '.'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add protected files'], { cwd: checkout })

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean baseline' })

  mkdirSync(join(checkout, 'docs'), { recursive: true })
  execFileSync('git', ['mv', '.claude/dev-team/memory/MEMORY.md', 'docs/mem.md'], { cwd: checkout })
  execFileSync('git', ['mv', '.claude/dev-team/config.md', 'docs-config.md'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'move both protected files out'], { cwd: checkout })

  const touched = touchedPaths({ cwd: checkout, baseline })
  // A spec whose files_in_scope only covers the new docs/ destinations —
  // exactly the reviewer's repro shape.
  const filesInScope = ['docs/mem.md', 'docs-config.md']
  const check = checkScopeCompliance(touched.paths, filesInScope, touched.sources.ignored)

  assert.equal(check.hard_fail, true, 'a committed rename that vacates a protected path must hard_fail, never pass clean')
  assert.equal(check.ok, false)
  assert.ok(check.note.includes('.claude/dev-team/memory/MEMORY.md'), 'the vacated protected memory path must be named in the violation')
  assert.ok(check.note.includes('.claude/dev-team/config.md'), 'the vacated protected config.md path must be named in the violation')
})

// ---------------------------------------------------------------------------
// checkScopeCompliance QA round-2 fix #2: the ignoredPathList advisory
// channel — pure-logic cases.
// ---------------------------------------------------------------------------

test('checkScopeCompliance: an ignored, non-protected touch is excluded from the ordinary out-of-scope warning and reported as a separate advisory note instead', () => {
  const check = checkScopeCompliance(['ignored.lock'], [], ['ignored.lock'])
  assert.equal(check.ok, true, 'an ignored non-protected touch must never trip the ordinary out-of-scope ok:false')
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.toLowerCase().includes('advisory'))
  assert.ok(check.note.includes('ignored.lock'))
})

test('checkScopeCompliance: a directory-shaped ignored, non-protected touch gets a note caveat that its contents were not individually inspected (minor wording fix)', () => {
  const check = checkScopeCompliance(['unrelated-dir/'], [], ['unrelated-dir/'])
  assert.equal(check.ok, true)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.toLowerCase().includes('not inspected') || check.note.toLowerCase().includes('not individually inspected'), 'expected a caveat that a directory-shaped entry\'s contents were not individually inspected')
})

test('checkScopeCompliance: an ignored touch under a protected prefix still hard_fails — ignoredPathList never exempts a protected path', () => {
  const check = checkScopeCompliance(['.claude/dev-team/config.md'], [], ['.claude/dev-team/config.md'])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('protected'))
})

test('checkScopeCompliance: an ignored touch mixed with a genuine non-ignored out-of-scope touch keeps the ordinary violation for the non-ignored one, and both are named', () => {
  const check = checkScopeCompliance(['ignored.lock', 'other.mjs'], [], ['ignored.lock'])
  assert.equal(check.ok, false, 'the non-ignored out-of-scope touch still trips the ordinary warning')
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.includes('other.mjs'))
  assert.ok(check.note.includes('ignored.lock'))
  assert.ok(check.note.toLowerCase().includes('advisory'))
})

test('checkScopeCompliance: omitting ignoredPathList entirely (default []) preserves the pre-fix behavior for a plain out-of-scope touch', () => {
  const check = checkScopeCompliance(['other.mjs'], [])
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.includes('other.mjs'))
  assert.ok(!check.note.toLowerCase().includes('advisory'))
})

test('degenerate: "note is empty string on pass" fails for every check (all eight)', () => {
  assert.ok(checkArtifacts([{ path: '/s', kind: 'spec', exists: true, sizeBytes: 1 }, { path: '/r', kind: 'return-json', exists: true, sizeBytes: 1 }]).note.length > 0)
  assert.ok(checkFilesNonEmpty([{ path: '/s', exists: true, sizeBytes: 1 }]).note.length > 0)
  assert.ok(checkJsonParses([{ path: '/s', exists: true, jsonOk: true, excluded: false }]).note.length > 0)
  assert.ok(checkDiffMatchesClaims([], []).note.length > 0)
  assert.ok(checkScopeCompliance([], []).note.length > 0)
  assert.ok(checkSpecLint({ ok: true, failures: [], warnings: [] }).note.length > 0)
  assert.ok(checkTestsPass([{ cmd: 'node --version', result: { classified: 'exit', code: 0, elapsed_ms: 5, tail: '', note: '' } }])[0].note.length > 0)
  assert.ok(checkVerdictConsistent([{ stem: 'a.1', verdictResult: { ok: true, verdict: 'inconclusive', findings: [] } }])[0].note.length > 0)
})

// ---------------------------------------------------------------------------
// checkSpecLint
// ---------------------------------------------------------------------------

test('checkSpecLint: ok mirrors lintSpec result.ok, and the note carries failure/warning counts plus rendered detail', () => {
  const lintResult = { ok: false, failures: [{ check: 'schema', detail: 'bad' }], warnings: [{ check: 'w', detail: 'meh' }] }
  const check = checkSpecLint(lintResult)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, false, 'a spec-lint failure is correctable, never hard_fail')
  assert.ok(check.note.includes('1 failure'))
  assert.ok(check.note.includes('1 warning'))
  assert.ok(check.note.includes('schema: bad'))
})

test('checkSpecLint: a passing lint result is ok:true with a populated note', () => {
  const check = checkSpecLint({ ok: true, failures: [], warnings: [] })
  assert.equal(check.ok, true)
  assert.ok(check.note.length > 0)
})

test('source-text pin: gates.mjs never imports `main` from spec-lint.mjs (only lintSpec)', () => {
  assert.ok(!/import\s*\{[^}]*\bmain\b[^}]*\}\s*from\s*['"]\.\.\/spec-lint\.mjs['"]/.test(GATES_SOURCE))
  assert.ok(/import\s*\{\s*lintSpec\s*\}\s*from\s*['"]\.\.\/spec-lint\.mjs['"]/.test(GATES_SOURCE))
})

// ---------------------------------------------------------------------------
// checkTestsPass — check FACTORY
// ---------------------------------------------------------------------------

test('checkTestsPass: one NAMED check per command, never merged; every command runs even when others fail', () => {
  const entries = [
    { cmd: 'node --version', result: { classified: 'exit', code: 0, elapsed_ms: 3, tail: '', note: '' } },
    { cmd: 'nonexistent-binary-zzz', result: { classified: 'missing_binary', code: 127, elapsed_ms: 1, tail: '', note: '' } },
    { cmd: 'node --check /nope.js', result: { classified: 'exit', code: 1, elapsed_ms: 2, tail: 'Cannot find module', note: '' } },
  ]
  const checks = checkTestsPass(entries)
  assert.equal(checks.length, 3)
  assert.deepEqual(checks.map((c) => c.item), [
    'tests_pass(node --version)',
    'tests_pass(nonexistent-binary-zzz)',
    'tests_pass(node --check /nope.js)',
  ])
  assert.deepEqual(checks.map((c) => c.ok), [true, false, false])
  for (const c of checks) {
    assert.ok(c.note.length > 0)
    assert.equal(c.hard_fail, false)
  }
})

test('tests_pass degenerate: "all validation_commands merged into a single tests_pass check" is refuted — the factory always produces one check per command', () => {
  const entries = [
    { cmd: 'a', result: { classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '' } },
    { cmd: 'b', result: { classified: 'exit', code: 1, elapsed_ms: 1, tail: '', note: '' } },
  ]
  const checks = checkTestsPass(entries)
  assert.equal(checks.length, 2, 'a merged implementation would collapse this to exactly one check')
})

test('checkTestsPass: timeout, missing_binary and refused are distinct outcomes named in the note, read from the injected classified field', () => {
  const entries = [
    { cmd: 'a', result: { classified: 'timeout', code: 124, elapsed_ms: 600000, tail: '', note: '' } },
    { cmd: 'b', result: { classified: 'missing_binary', code: 127, elapsed_ms: 1, tail: '', note: '' } },
    { cmd: 'c', result: { classified: 'refused', code: null, elapsed_ms: 0, tail: '', note: 'refused: unsafe command' } },
  ]
  const checks = checkTestsPass(entries)
  assert.ok(checks[0].note.includes('timeout'))
  assert.ok(checks[1].note.includes('missing_binary'))
  assert.ok(checks[2].note.includes('refused'))
})

test('checkTestsPass: a new "spawn_error" classified RunResult (a non-ENOENT res.error, e.g. EACCES) renders sensibly — ok:false, code=null shown as "null", and the real error message carried through — with no exhaustive-enum switch to update', () => {
  const entries = [
    { cmd: 'badbin', result: { classified: 'spawn_error', code: null, elapsed_ms: 3, tail: '', note: 'spawnSync badbin EACCES' } },
  ]
  const checks = checkTestsPass(entries)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].ok, false)
  assert.equal(checks[0].hard_fail, false)
  assert.ok(checks[0].note.includes('spawn_error'))
  assert.ok(checks[0].note.includes('code=null'))
  assert.ok(checks[0].note.includes('spawnSync badbin EACCES'))
})

// ---------------------------------------------------------------------------
// checkVerdictConsistent — consistency-refutation only
// ---------------------------------------------------------------------------

test('verdict_consistent Variant A: verdict "pass" with a critical finding -> ok:false hard_fail:true naming EVERY critical finding', () => {
  const checks = checkVerdictConsistent([{
    stem: 'r.1',
    verdictResult: {
      ok: true,
      verdict: 'pass',
      findings: [
        { severity: 'critical', file: 'a.js', line: 10, summary: 'sql injection' },
        { severity: 'critical', file: 'b.js', line: null, summary: 'auth bypass' },
        { severity: 'warning', file: 'c.js', line: 1, summary: 'nit' },
      ],
    },
  }])
  assert.equal(checks.length, 1)
  assert.equal(checks[0].item, 'verdict_consistent(r.1)')
  assert.equal(checks[0].ok, false)
  assert.equal(checks[0].hard_fail, true)
  assert.ok(checks[0].note.includes('a.js'))
  assert.ok(checks[0].note.includes('sql injection'))
  assert.ok(checks[0].note.includes('b.js'))
  assert.ok(checks[0].note.includes('auth bypass'))
  assert.ok(!checks[0].note.includes('nit'), 'a non-critical finding must not be named as a Variant A offender')

  const report = buildReport({ task: 't', slice: 's', checks })
  assert.deepEqual(report.violations.map((v) => v.item), ['verdict_consistent(r.1)'])
})

test('verdict_consistent Variant B: "changes-needed" with zero findings -> ok:true, exact note, ABSENT from violations', () => {
  const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: true, verdict: 'changes-needed', findings: [] } }])
  assert.equal(checks[0].ok, true)
  assert.equal(checks[0].hard_fail, false)
  assert.equal(checks[0].note, 'changes-needed with 0 findings - blocking reasoning may be in Must-fix prose')

  const report = buildReport({ task: 't', slice: 's', checks })
  assert.deepEqual(report.violations, [])
})

for (const verdict of ['pass', 'changes-needed', 'inconclusive']) {
  test(`verdict_consistent: a genuinely self-consistent verdict ("${verdict}") produces zero violations`, () => {
    const findings = verdict === 'pass' || verdict === 'inconclusive' ? [] : [{ severity: 'warning', file: 'a.js', line: 1, summary: 'nit' }]
    const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: true, verdict, findings } }])
    assert.equal(checks[0].ok, true)
    const report = buildReport({ task: 't', slice: 's', checks })
    assert.deepEqual(report.violations, [])
  })
}

test('verdict_consistent: an N-panel input (N=3) produces N independent checks with distinct item ids, never one merged verdict', () => {
  const entries = [
    { stem: 'r.1', verdictResult: { ok: true, verdict: 'pass', findings: [] } },
    { stem: 'r.2', verdictResult: { ok: true, verdict: 'changes-needed', findings: [{ severity: 'warning', file: 'x', line: 1, summary: 's' }] } },
    { stem: 'r.3', verdictResult: { ok: true, verdict: 'inconclusive', findings: [] } },
  ]
  const checks = checkVerdictConsistent(entries)
  assert.equal(checks.length, 3)
  assert.equal(new Set(checks.map((c) => c.item)).size, 3)
})

test('verdict_consistent degenerate: "always ok:true" is refuted by Variant A', () => {
  const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: true, verdict: 'pass', findings: [{ severity: 'critical', file: 'a', line: 1, summary: 's' }] } }])
  assert.equal(checks[0].ok, false)
})

test('verdict_consistent degenerate: "ok = verdict !== \'pass\'" is refuted — a genuinely self-consistent "pass" must be ok:true', () => {
  const naive = (verdict) => verdict !== 'pass'
  const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: true, verdict: 'pass', findings: [] } }])
  assert.equal(checks[0].ok, true)
  assert.notEqual(checks[0].ok, naive('pass'))
})

test('verdict_consistent degenerate: "ok = !findings.some(critical)" is refuted — it is verdict-BLIND and would wrongly pass a "changes-needed" with a critical finding but no pass claim, AND wrongly evaluate independent of the verdict field entirely', () => {
  const entries = [{ stem: 'r.1', verdictResult: { ok: true, verdict: 'changes-needed', findings: [{ severity: 'critical', file: 'a', line: 1, summary: 's' }] } }]
  const naiveOk = !entries[0].verdictResult.findings.some((f) => f.severity === 'critical')
  const checks = checkVerdictConsistent(entries)
  // The real check has no rule against "changes-needed + critical" (that
  // combination is itself self-consistent) — but the naive predicate above
  // is blind to the verdict field, which is exactly the hole this named
  // degenerate exists to catch: it must not be what gates.mjs actually does.
  assert.equal(checks[0].ok, true)
  assert.equal(naiveOk, false)
  assert.notEqual(checks[0].ok, naiveOk)
})

test('verdict_consistent: a lead/plan-reviewer-shaped markdown return with NO Verdict section at all (VERDICT_SECTION_MISSING) produces NO check — it is not verdict-bearing, never a fabricated violation', () => {
  const checks = checkVerdictConsistent([{
    stem: 'lead.1',
    verdictResult: { ok: false, keyword: VERDICT_SECTION_MISSING, message: 'markdown body has no Verdict section (outside any fenced example)' },
  }])
  assert.deepEqual(checks, [], 'a non-reviewer return legitimately missing a Verdict section must never surface as a violation')
})

test('verdict_consistent: VERDICT_SECTION_MISSING is skipped even when mixed with a real reviewer envelope — only the real one produces a check', () => {
  const entries = [
    { stem: 'lead.1', verdictResult: { ok: false, keyword: VERDICT_SECTION_MISSING, message: 'no verdict section' } },
    { stem: 'reviewer.1', verdictResult: { ok: true, verdict: 'pass', findings: [] } },
  ]
  const checks = checkVerdictConsistent(entries)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].item, 'verdict_consistent(reviewer.1)')
})

for (const [keyword, message] of [
  ['verdict_block_missing', 'Verdict section carries no fenced json block'],
  ['verdict_block_multiple', 'Verdict section carries more than one fenced json block'],
  ['verdict_block_unparseable', 'Verdict section fenced block is not valid JSON'],
  ['verdict_block_invalid', 'Verdict section fenced block does not match {verdict, findings}'],
]) {
  test(`verdict_consistent: a genuinely malformed verdict return (${keyword}) still correctly produces ok:false — only VERDICT_SECTION_MISSING is skipped`, () => {
    const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: false, keyword, message } }])
    assert.equal(checks.length, 1)
    assert.equal(checks[0].ok, false)
    assert.ok(checks[0].note.includes(keyword))
  })
}

test('verdict_consistent: a verdict-block extraction failure is reported as a failing check, never thrown or silently skipped', () => {
  const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult: { ok: false, keyword: 'verdict_block_missing', message: 'no fenced json block' } }])
  assert.equal(checks[0].ok, false)
  assert.ok(checks[0].note.includes('verdict_block_missing'))
})

test('verdict_consistent end-to-end: a real markdown body with BOTH an illustrative fenced example and the real Verdict block reads the REAL one (via extractVerdictBlock, never re-parsed here)', () => {
  const body = [
    '# Review',
    '',
    'Example shape for reference:',
    '```',
    '{"verdict": "pass", "findings": []}',
    '```',
    '',
    '## Verdict',
    '',
    'Illustrative note inside this section too:',
    '```',
    'not the real block',
    '```',
    '',
    '```json',
    '{"verdict": "changes-needed", "findings": [{"severity": "warning", "file": "a.js", "line": 3, "summary": "nit"}]}',
    '```',
  ].join('\n')

  const verdictResult = extractVerdictBlock(body)
  assert.equal(verdictResult.ok, true)
  assert.equal(verdictResult.verdict, 'changes-needed')

  const checks = checkVerdictConsistent([{ stem: 'r.1', verdictResult }])
  assert.equal(checks[0].ok, true)
})

// ---------------------------------------------------------------------------
// runChecks purity: mocked io, non-repo cwd, zero real IO of any kind
// ---------------------------------------------------------------------------

test('runChecks with a fully-mocked io performs zero real IO — a non-repo, non-existent cwd never throws', () => {
  const mockIo = {
    readArtifact: (path) => ({ path, exists: true, sizeBytes: 42, text: path.endsWith('spec.json') ? JSON.stringify({ files_in_scope: ['a.mjs'], validation_commands: ['echo ok'] }) : JSON.stringify({ body: { status: 'done', reason: 'r', changes: ['a.mjs - did it'] } }) }),
    touchedPaths: () => ({ paths: ['a.mjs'], sources: { committed: [], dirty: ['a.mjs'], reverted: [], ignored: [] } }),
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => ({ ok: true, verdict: 'inconclusive', findings: [] }),
  }
  const ctx = {
    task: 't', slice: 's',
    root: '/definitely/not/a/real/git/repo/at/all',
    specPath: '/nowhere/spec.json',
    returnCandidatePaths: ['/nowhere/returns/s.1.json'],
    baseline: { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} },
    baselinePath: '/nowhere/baseline.json',
    timeoutMs: 1000,
    logDir: '/nowhere/logs',
    enabledChecks: null,
  }
  assert.doesNotThrow(() => runChecks(ctx, mockIo))
  const checks = runChecks(ctx, mockIo)
  const items = checks.map((c) => c.item)
  assert.ok(items.includes('artifacts_exist'))
  assert.ok(items.includes('scope_compliance'))
  assert.ok(items.includes('spec_lint'))
  assert.ok(items.some((i) => i.startsWith('tests_pass(')))
})

// ---------------------------------------------------------------------------
// verdict_consistent: zero verdict-bearing envelopes must never collapse to
// checks:[] (a vacuous pass) — mirrors tests_pass's explicit
// zero-validation-commands Check and checkArtifacts's explicit
// zero-return-files fail.
// ---------------------------------------------------------------------------

test('runChecks: zero verdict-bearing envelopes among the returns scanned produces exactly ONE ok:true, non-hard_fail "verdict_consistent" check naming the returns directory (mirrors checkDiffMatchesClaims\'s not-applicable-here precedent — never a fabricated violation)', () => {
  const mockIo = {
    // Every return present is markdown-kind (never reaches extractVerdictBlock at all, since kind !== 'return-json').
    readArtifact: (path) => ({ path, exists: true, sizeBytes: 10, text: 'some markdown, no structured body' }),
    touchedPaths: () => ({ paths: [], sources: { committed: [], dirty: [], reverted: [], ignored: [] } }),
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => { throw new Error('must never be called: no return-json envelope with a string body exists') },
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: ['/nowhere/returns/s.1.md'], returnsDir: '/nowhere/returns',
    baseline: { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} },
    baselinePath: '/nowhere/baseline.json', timeoutMs: 1000, logDir: '/nowhere/logs',
    enabledChecks: new Set(['verdict_consistent']),
  }
  const checks = runChecks(ctx, mockIo)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].item, 'verdict_consistent')
  assert.equal(checks[0].ok, true, 'a coder/lead-shaped all-markdown return set is NOT APPLICABLE to this check, never a violation — must be able to reach exit 0 under default --checks')
  assert.equal(checks[0].hard_fail, false)
  assert.ok(checks[0].note.includes('/nowhere/returns'))

  const report = buildReport({ task: 't', slice: 's', checks })
  assert.deepEqual(report.violations, [], 'ok:true must never surface in violations')
})

test('runChecks: zero return files at all also produces the single "verdict_consistent" zero-envelope check, never checks:[]', () => {
  const mockIo = {
    readArtifact: () => ({ path: 'x', exists: false, sizeBytes: null, text: null }),
    touchedPaths: () => ({ paths: [], sources: { committed: [], dirty: [], reverted: [], ignored: [] } }),
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => { throw new Error('must never be called') },
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: [], returnsDir: '/nowhere/returns',
    baseline: null, baselinePath: '/nowhere/baseline.json', timeoutMs: 1000, logDir: '/nowhere/logs',
    enabledChecks: new Set(['verdict_consistent']),
  }
  const checks = runChecks(ctx, mockIo)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].item, 'verdict_consistent')
  assert.equal(checks[0].ok, true)
})

// ---------------------------------------------------------------------------
// runChecks: an io.* throw must never propagate uncaught and discard every
// already-computed check — it becomes a reported hard_fail Check instead.
// ---------------------------------------------------------------------------

test('runChecks: a throwing io.touchedPaths is converted to hard_fail Checks for diff_matches_claims/scope_compliance, while every OTHER check (artifacts_exist, spec_lint, tests_pass) still runs and is present in the report', () => {
  const mockIo = {
    readArtifact: (path) => ({
      path,
      exists: true,
      sizeBytes: 42,
      text: path.endsWith('spec.json')
        ? JSON.stringify({ files_in_scope: ['a.mjs'], validation_commands: ['echo ok'] })
        : JSON.stringify({ body: { status: 'done', reason: 'r', changes: ['a.mjs - did it'] } }),
    }),
    touchedPaths: () => { throw Object.assign(new Error('git status exited 1: fatal: not a git repository'), { code: 'git_unavailable' }) },
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => ({ ok: true, verdict: 'inconclusive', findings: [] }),
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: ['/nowhere/returns/s.1.json'], returnsDir: '/nowhere/returns',
    baseline: { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} },
    baselinePath: '/nowhere/baseline.json', timeoutMs: 1000, logDir: '/nowhere/logs',
    enabledChecks: null,
  }
  assert.doesNotThrow(() => runChecks(ctx, mockIo))
  const checks = runChecks(ctx, mockIo)
  const byItem = Object.fromEntries(checks.map((c) => [c.item, c]))

  assert.equal(byItem.diff_matches_claims.ok, false)
  assert.equal(byItem.diff_matches_claims.hard_fail, true)
  assert.ok(byItem.diff_matches_claims.note.includes('git_unavailable'))
  assert.equal(byItem.scope_compliance.ok, false)
  assert.equal(byItem.scope_compliance.hard_fail, true)
  assert.ok(byItem.scope_compliance.note.includes('git_unavailable'))

  // Every OTHER already-computed check must still be present — the throw
  // must never discard the whole report.
  assert.ok(byItem.artifacts_exist, 'artifacts_exist must still be present after the touchedPaths throw')
  assert.ok(byItem.spec_lint, 'spec_lint must still be present after the touchedPaths throw')
  assert.ok(Object.keys(byItem).some((k) => k.startsWith('tests_pass(')), 'tests_pass must still run after the touchedPaths throw')

  const report = buildReport({ task: 't', slice: 's', checks })
  assert.equal(report.hard_fail, true)
})

test('runChecks: a throwing io.lintSpec is converted to a non-hard_fail "spec_lint" Check (spec_lint never hard_fails, even on its own io throw) without discarding other checks', () => {
  const mockIo = {
    readArtifact: (path) => ({
      path,
      exists: true,
      sizeBytes: 42,
      text: path.endsWith('spec.json') ? JSON.stringify({ files_in_scope: [], validation_commands: [] }) : 'md return',
    }),
    touchedPaths: () => ({ paths: [], sources: { committed: [], dirty: [], reverted: [], ignored: [] } }),
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => { throw new Error('spec-lint.mjs blew up') },
    extractVerdictBlock: () => ({ ok: false, keyword: VERDICT_SECTION_MISSING, message: 'x' }),
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: [], returnsDir: '/nowhere/returns',
    baseline: { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} },
    baselinePath: '/nowhere/baseline.json', timeoutMs: 1000, logDir: '/nowhere/logs',
    enabledChecks: null,
  }
  const checks = runChecks(ctx, mockIo)
  const byItem = Object.fromEntries(checks.map((c) => [c.item, c]))
  assert.equal(byItem.spec_lint.ok, false)
  assert.equal(byItem.spec_lint.hard_fail, false, 'spec_lint never hard_fails, even when io.lintSpec itself throws')
  assert.ok(byItem.spec_lint.note.includes('spec-lint.mjs blew up'))
  assert.ok(byItem.artifacts_exist, 'artifacts_exist must still be present after the lintSpec throw')
})

test('runChecks: a throwing io.runValidationCommand is converted to a non-hard_fail "tests_pass(<cmd>)" Check per offending command (tests_pass never hard_fails, even on its own io throw), without discarding other checks', () => {
  const mockIo = {
    readArtifact: (path) => ({
      path,
      exists: true,
      sizeBytes: 42,
      text: path.endsWith('spec.json') ? JSON.stringify({ files_in_scope: [], validation_commands: ['node --version', 'node -e "1"'] }) : 'md return',
    }),
    touchedPaths: () => ({ paths: [], sources: { committed: [], dirty: [], reverted: [], ignored: [] } }),
    runValidationCommand: ({ cmd }) => {
      if (cmd === 'node --version') throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
      return { classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }
    },
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => ({ ok: false, keyword: VERDICT_SECTION_MISSING, message: 'x' }),
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: [], returnsDir: '/nowhere/returns',
    baseline: { anchor_sha: 'a'.repeat(40), reason: 'r', captured_at: new Date().toISOString(), dirty: {} },
    baselinePath: '/nowhere/baseline.json', timeoutMs: 1000, logDir: '/nowhere/logs',
    enabledChecks: null,
  }
  const checks = runChecks(ctx, mockIo)
  const byItem = Object.fromEntries(checks.map((c) => [c.item, c]))
  assert.equal(byItem['tests_pass(node --version)'].ok, false)
  assert.equal(byItem['tests_pass(node --version)'].hard_fail, false, 'tests_pass never hard_fails, even when io.runValidationCommand itself throws')
  assert.ok(byItem['tests_pass(node --version)'].note.includes('EMFILE'))
  // The command AFTER the throwing one must still run — no short-circuiting.
  assert.ok(byItem['tests_pass(node -e "1")'], 'the second validation command must still run despite the first throwing')
  assert.equal(byItem['tests_pass(node -e "1")'].ok, true)
  assert.ok(byItem.artifacts_exist, 'artifacts_exist must still be present after the runValidationCommand throw')
})

// ---------------------------------------------------------------------------
// FAIL-CLOSED BASELINE ORDERING (integration, via runChecks with real io.touchedPaths untouched — the point is io.touchedPaths must never even be called)
// ---------------------------------------------------------------------------

test('runChecks: when ctx.baseline is null, diff_matches_claims and scope_compliance both hard_fail — and io.touchedPaths is NEVER called (never lazily captured)', () => {
  let touchedPathsCalled = false
  const mockIo = {
    readArtifact: () => ({ path: 'x', exists: false, sizeBytes: null, text: null }),
    touchedPaths: () => { touchedPathsCalled = true; return { paths: [], sources: { committed: [], dirty: [], reverted: [], ignored: [] } } },
    runValidationCommand: () => ({ classified: 'exit', code: 0, elapsed_ms: 1, tail: '', note: '', ok: true }),
    lintSpec: () => ({ ok: true, failures: [], warnings: [] }),
    extractVerdictBlock: () => ({ ok: false, keyword: 'x', message: 'x' }),
  }
  const ctx = {
    task: 't', slice: 's', root: '/nowhere', specPath: '/nowhere/spec.json',
    returnCandidatePaths: [], baseline: null, baselinePath: '/nowhere/state/chain/baseline.s.json',
    timeoutMs: 1000, logDir: '/nowhere/logs', enabledChecks: null,
  }
  const checks = runChecks(ctx, mockIo)
  const byItem = Object.fromEntries(checks.map((c) => [c.item, c]))
  assert.equal(byItem.diff_matches_claims.ok, false)
  assert.equal(byItem.diff_matches_claims.hard_fail, true)
  assert.ok(byItem.diff_matches_claims.note.includes('/nowhere/state/chain/baseline.s.json'))
  assert.equal(byItem.scope_compliance.ok, false)
  assert.equal(byItem.scope_compliance.hard_fail, true)
  assert.equal(touchedPathsCalled, false, 'a lazily-capturing implementation would call touchedPaths even with no baseline')
})

// ---------------------------------------------------------------------------
// FAIL-CLOSED BASELINE ORDERING — full CLI, real subprocess, real git
// ---------------------------------------------------------------------------

test('CLI: baseline captures once, then a second capture for the same slice refuses (exit 2, baseline_exists) rather than overwrite', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', {})

  const first = runCli(['baseline', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  assert.equal(first.status, 0)
  const firstJson = JSON.parse(first.stdout.trim())
  assert.equal(firstJson.ok, true)

  const baselinePath = baselinePathFor(paths, 'be-gt')
  assert.ok(existsSync(baselinePath))
  const beforeMtime = statSync(baselinePath).mtimeMs
  const beforeBytes = readFileSync(baselinePath, 'utf8')

  const second = runCli(['baseline', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  assert.equal(second.status, 2)
  assert.ok(second.stderr.includes('baseline_exists'))

  assert.equal(readFileSync(baselinePath, 'utf8'), beforeBytes, 'the first baseline must never be overwritten')
  assert.equal(statSync(baselinePath).mtimeMs, beforeMtime)
})

test('CLI degenerate: "check captures the baseline lazily when absent" must fail — a check run before any baseline exists must NOT create one', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', {})

  const baselinePath = baselinePathFor(paths, 'be-gt')
  assert.ok(!existsSync(baselinePath))

  // The work: an out-of-scope, protected-path edit that a lazily-captured
  // "baseline after the fact" would produce an EMPTY touched set for — the
  // exact silent-pass bug this ordering exists to prevent.
  mkdirSync(dirname(join(checkout, '.claude/dev-team/config.md')), { recursive: true })
  writeFileSync(join(checkout, '.claude/dev-team/config.md'), 'tampered\n')

  const result = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  assert.ok(!existsSync(baselinePath), 'check must never create the baseline it was missing')

  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.hard_fail, true)
  const scopeViolation = report.violations.find((v) => v.item === 'scope_compliance')
  assert.ok(scopeViolation, 'scope_compliance must hard_fail rather than lazily pass on an empty touched set')
  assert.equal(scopeViolation.hard_fail, true)
})

// ---------------------------------------------------------------------------
// GateReport stdout contract, exit codes, subcommand real-subprocess pins
// ---------------------------------------------------------------------------

test('CLI: GateReport is emitted as exactly ONE line of JSON on stdout, even with many violations, and stderr carries only human text', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', { files_in_scope: ['nope.mjs'], validation_commands: ['nonexistent-binary-zzz', 'nonexistent-binary-zzz-2'] })

  const baseline = captureBaseline({ cwd: checkout, reason: 'test' })
  mkdirSync(dirname(baselinePathFor(paths, 'be-gt')), { recursive: true })
  writeBaselineExclusive(baselinePathFor(paths, 'be-gt'), baseline)

  writeFileSync(join(checkout, 'other.mjs'), 'x')
  mkdirSync(join(checkout, '.claude', 'dev-team'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'x')

  const result = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  const lines = result.stdout.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 1, 'stdout must be exactly one line')
  const report = JSON.parse(lines[0]) // throws if not a single valid JSON object
  assert.equal(typeof report, 'object')
  assert.ok(Array.isArray(report.checks))
  assert.ok(report.checks.length > 3)
  assert.ok(!result.stdout.includes('FAIL '), 'no human-formatted line should leak onto stdout')
})

test('CLI exit codes: 0 with no violations, 1 with violations present, 2 for a usage error', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', { validation_commands: ['node --version'] })
  const baseline = captureBaseline({ cwd: checkout, reason: 'test' })
  mkdirSync(dirname(baselinePathFor(paths, 'be-gt')), { recursive: true })
  writeBaselineExclusive(baselinePathFor(paths, 'be-gt'), baseline)

  const clean = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root, '--checks', 'spec_lint,tests_pass'])
  assert.equal(clean.status, 0)

  writeFileSync(join(checkout, 'unclaimed.mjs'), 'x')
  const dirty = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root, '--checks', 'scope_compliance'])
  assert.equal(dirty.status, 1)

  const bad = runCli(['nonsense', '--task', 'sample-task'])
  assert.equal(bad.status, 2)
})

// ---------------------------------------------------------------------------
// QA round-2 fix #5: real-subprocess pin for the exit-code-change path — an
// evidence failure INSIDE runChecks (io.touchedPaths throwing) is exit 1
// with a full GateReport, distinct from a pre-runChecks operational error
// (still exit 2, no stdout at all).
// ---------------------------------------------------------------------------

test('CLI real-subprocess: an evidence failure INSIDE runChecks (the REAL io.touchedPaths throwing git_unavailable against a non-git --checkout) is exit 1 with a full GateReport, never the exit 2 usage/operational-error code', () => {
  const dir = freshTmp()
  const nonGitCheckout = join(dir, 'not-a-git-repo')
  mkdirSync(nonGitCheckout, { recursive: true })
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', { validation_commands: ['node --version'] })

  // Hand-write a baseline file directly at the expected state-dir location
  // for this slice — "gates baseline" would itself fail against a non-git
  // checkout, so this bypasses it entirely — putting ctx.baseline in place
  // so runChecks proceeds past the baseline-null branch and calls the REAL
  // (unmocked) io.touchedPaths, which throws git_unavailable against a
  // non-git cwd.
  const baselinePath = baselinePathFor(paths, 'be-gt')
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, JSON.stringify({
    anchor_sha: 'a'.repeat(40), reason: 'hand-written', captured_at: new Date().toISOString(), dirty: {},
  }))

  const result = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', nonGitCheckout, '--repo', 'sample-repo', '--root', root])

  assert.equal(result.status, 1, 'an evidence failure INSIDE runChecks must be exit 1, never exit 2')
  const lines = result.stdout.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 1, 'stdout must be exactly one line of JSON even on this failure path')
  const report = JSON.parse(lines[0])

  const diffViolation = report.violations.find((v) => v.item === 'diff_matches_claims')
  const scopeViolation = report.violations.find((v) => v.item === 'scope_compliance')
  assert.ok(diffViolation, 'diff_matches_claims must be present in violations')
  assert.equal(diffViolation.hard_fail, true, 'diff_matches_claims hard-fails on an io.touchedPaths evidence-loss throw')
  assert.ok(scopeViolation, 'scope_compliance must be present in violations')
  assert.equal(scopeViolation.hard_fail, true, 'scope_compliance hard-fails on an io.touchedPaths evidence-loss throw')
})

test('CLI: baseline subcommand is pinned by a real subprocess', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const result = runCli(['baseline', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  assert.equal(result.status, 0)
  const json = JSON.parse(result.stdout.trim())
  assert.equal(json.ok, true)
  assert.equal(json.task, 'sample-task')
  assert.equal(json.slice, 'be-gt')
})

test('CLI: check subcommand is pinned by a real subprocess (missing baseline path)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', {})
  const result = runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.hard_fail, true)
  assert.equal(result.status, 1)
})

// ---------------------------------------------------------------------------
// scope_compliance end-to-end against real git fixtures
// ---------------------------------------------------------------------------

// scopeCheckFor(checkout, baseline) -> the real scope_compliance Check,
// wired through the REAL touchedPaths (evidence.mjs) — never a mocked
// collector. specPath is deliberately absent (files_in_scope collapses to
// []), which is fine: these fixtures only assert what got NAMED as touched.
function scopeCheckFor(checkout, baseline, filesInScope = []) {
  const ctx = {
    task: 't', slice: 's', root: checkout, specPath: join(checkout, 'nonexistent-spec.json'),
    returnCandidatePaths: [], baseline, baselinePath: '/nope', timeoutMs: 1000, logDir: '/nope',
    enabledChecks: new Set(['scope_compliance']),
  }
  const io = {
    readArtifact: (p) => (existsSync(p) ? { path: p, exists: true, sizeBytes: statSync(p).size, text: readFileSync(p, 'utf8') } : { path: p, exists: false, sizeBytes: null, text: null }),
    touchedPaths,
    runValidationCommand: () => ({}),
    lintSpec: () => ({}),
    extractVerdictBlock: () => ({}),
  }
  if (filesInScope.length > 0) {
    writeFileSync(join(checkout, 'nonexistent-spec.json'), JSON.stringify({ files_in_scope: filesInScope }))
  }
  const checks = runChecks(ctx, io)
  return checks.find((c) => c.item === 'scope_compliance')
}

test('scope_compliance end-to-end: a rename entry is reported (both TO and FROM)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  execFileSync('git', ['mv', 'README.md', 'RENAMED.md'], { cwd: checkout })

  const check = scopeCheckFor(checkout, baseline)
  assert.ok(check.note.includes('README.md'))
  assert.ok(check.note.includes('RENAMED.md'))
})

test('scope_compliance end-to-end: an untracked file inside a brand-new directory is named in full (the -uall proof)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  mkdirSync(join(checkout, 'newdir'))
  writeFileSync(join(checkout, 'newdir', 'inner.txt'), 'new\n')

  const check = scopeCheckFor(checkout, baseline)
  assert.ok(check.note.includes('newdir/inner.txt'))
})

test('scope_compliance end-to-end: a baseline-dirty file restored to its original committed bytes still counts as touched', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, 'README.md'), '# sample repo\ndirty at baseline\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })

  writeFileSync(join(checkout, 'README.md'), '# sample repo\nyet another edit\n')
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: checkout })

  const check = scopeCheckFor(checkout, baseline)
  assert.ok(check.note.includes('README.md'))
})

test('scope_compliance end-to-end: a baseline-dirty file left as the user own untouched edit is NOT reported as touched', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nuser edit, never touched again\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, true)
  assert.ok(!check.note.includes('README.md'))
})

test('scope_compliance end-to-end: a newly-untracked file under a protected prefix hard_fails', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'sneaky.md'), 'tampered\n')

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/memory/sneaky.md'))
})

test('scope_compliance end-to-end: a touch that IS in files_in_scope produces a clean pass', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  writeFileSync(join(checkout, 'in-scope.mjs'), 'x\n')

  const check = scopeCheckFor(checkout, baseline, ['in-scope.mjs', 'nonexistent-spec.json'])
  assert.equal(check.ok, true)
})

// ---------------------------------------------------------------------------
// QA round-2 fix #1: a collapsed ignored-DIRECTORY status entry directly
// under a protected prefix must never crash and must still hard_fail.
// ---------------------------------------------------------------------------

test('scope_compliance end-to-end: an ignored, wholly-untracked DIRECTORY directly under a protected prefix still hard_fails, and captureBaseline survives the SAME directory-shaped entry present at capture time (never crashes, never silently excluded)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '.claude/dev-team/memory/sneaky-dir/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory', 'sneaky-dir'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'sneaky-dir', 'tampered.md'), 'tampered\n')

  // captureBaseline must survive a protected-prefix directory-shaped entry
  // present AT capture time (the reviewer-reproduced EISDIR crash site).
  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  assert.ok(Object.prototype.hasOwnProperty.call(baseline.dirty, '.claude/dev-team/memory/sneaky-dir/'))

  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'sneaky-dir', 'more.md'), 'more tampering\n')

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/memory/sneaky-dir/'))
})

// ---------------------------------------------------------------------------
// Ancestor-collapse fix (critical fail-open regression): a gitignored
// ANCESTOR directory of a protected prefix (e.g. `.claude/` when
// `.gitignore` contains `.claude/`) collapses BOTH `.claude/dev-team/
// memory/notes.md` AND `.claude/dev-team/config.md` into a single `.claude/`
// status entry — this is matrix case 3, driven through the REAL
// `git status --ignored=matching` pipeline end-to-end, not a hand-
// constructed path string.
// ---------------------------------------------------------------------------

test('a gitignored ancestor directory of a protected prefix hard_fails, never routes to the ignored-advisory channel (real git fixture, .gitignore contains ".claude/")', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '.claude/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'notes.md'), 'tampered memory write\n')
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'tampered config write\n')

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })

  // Confirm git really does collapse BOTH protected writes to a single
  // `.claude/` entry — the exact shape the reviewer reproduced.
  const result = touchedPaths({ cwd: checkout, baseline })
  assert.deepEqual(result.paths, ['.claude/'], 'expected git to collapse both protected writes under one wholly-ignored ancestor directory entry')
  assert.ok(result.sources.ignored.includes('.claude/'))

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true, 'an ancestor-collapsed protected touch must hard_fail, never report ok:true via the ignored-advisory channel')
  assert.ok(check.note.includes('protected'))
  assert.ok(check.note.includes('.claude/'))
  assert.ok(!check.note.toLowerCase().includes('advisory'), 'must never be reported as a mere advisory note')
})

test('a gitignored ancestor directory ".claude/dev-team/" (one level closer) also hard_fails against the same protected writes (real git fixture)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '.claude/dev-team/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'notes.md'), 'tampered memory write\n')
  writeFileSync(join(checkout, '.claude', 'dev-team', 'config.md'), 'tampered config write\n')

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })

  const result = touchedPaths({ cwd: checkout, baseline })
  assert.deepEqual(result.paths, ['.claude/dev-team/'], 'expected git to collapse both protected writes under this ancestor directory entry')

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('protected'))
})

test('a gitignored directory that is only a STRING sibling of a protected prefix (".claude/dev-team-other/", not a true path ancestor) does NOT hard_fail — it stays an ordinary ignored-advisory touch (real git fixture, regression guard for the round-1 sibling-prefix fix)', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '.claude/dev-team-other/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, '.claude', 'dev-team-other'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team-other', 'unrelated.md'), 'unrelated write\n')

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  const result = touchedPaths({ cwd: checkout, baseline })
  assert.deepEqual(result.paths, ['.claude/dev-team-other/'])

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.hard_fail, false, 'a sibling-shaped directory must never be treated as protected')
  assert.equal(check.ok, true, 'an ignored, non-protected directory touch is a clean pass via the advisory channel')
  assert.ok(!check.note.includes('protected-path touch'), 'must never be named as an actual protected-path offender')
  assert.ok(check.note.toLowerCase().includes('advisory'))
})

// ---------------------------------------------------------------------------
// QA round-2 fix #2: the ignored-advisory channel, end-to-end against real
// touchedPaths — the protected half must stay entirely unaffected.
// ---------------------------------------------------------------------------

test('scope_compliance end-to-end: an ignored, non-protected file present at baseline capture and later released mid-slice (git no longer sees it) does NOT produce an ordinary out-of-scope ok:false — advisory-only', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '*.lock\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  writeFileSync(join(checkout, 'scheduled_tasks.lock'), 'lock v1\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })
  assert.equal(baseline.dirty['scheduled_tasks.lock'].xy, '!!')

  unlinkSync(join(checkout, 'scheduled_tasks.lock'))

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, true, 'an ignored, non-protected touch must never trip the ordinary out-of-scope warning')
  assert.equal(check.hard_fail, false)
  assert.ok(check.note.toLowerCase().includes('advisory'))
})

test('scope_compliance end-to-end: an ignored file under a protected prefix still hard_fails even via the reverted-detection path — the protected half is unaffected by fix #2', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  writeFileSync(join(checkout, '.gitignore'), '.claude/dev-team/memory/*.lock\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: checkout })
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: checkout })

  mkdirSync(join(checkout, '.claude', 'dev-team', 'memory'), { recursive: true })
  writeFileSync(join(checkout, '.claude', 'dev-team', 'memory', 'tampered.lock'), 'v1\n')
  const baseline = captureBaseline({ cwd: checkout, reason: 'dirty baseline' })
  assert.equal(baseline.dirty['.claude/dev-team/memory/tampered.lock'].xy, '!!')

  unlinkSync(join(checkout, '.claude', 'dev-team', 'memory', 'tampered.lock'))

  const check = scopeCheckFor(checkout, baseline)
  assert.equal(check.ok, false)
  assert.equal(check.hard_fail, true)
  assert.ok(check.note.includes('.claude/dev-team/memory/tampered.lock'))
})

// ---------------------------------------------------------------------------
// DESIGN INVARIANTS (source-text pins + behavioral pins)
// ---------------------------------------------------------------------------

test('design invariant: gates.mjs never imports ladder.validateReturn and never references return-envelope.schema.json', () => {
  assert.ok(!GATES_SOURCE.includes('validateReturn'))
  assert.ok(!GATES_SOURCE.includes('return-envelope.schema.json'))
})

test('design invariant: gates.mjs never reads, writes, or references an OUTCOMES value', () => {
  assert.ok(!GATES_SOURCE.includes('OUTCOMES'))
})

test('design invariant: gates.mjs contains no auto-rollback verb (built from fragments so this assertion never trivially matches its own source)', () => {
  const forbidden = [
    ['git', ' ', 'reset'].join(''),
    ['re', 'vert'].join(''),
    ['roll', 'back'].join(''),
    ['unl', 'ink', 'Sync'].join(''),
    ['rm', 'Sync'].join(''),
  ]
  for (const needle of forbidden) {
    assert.ok(!GATES_SOURCE.includes(needle), `gates.mjs must not contain the forbidden verb fragment: ${needle}`)
  }
})

test('design invariant: a full check run never writes to returns/ — directory contents and mtimes are unchanged', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const paths = buildTaskPaths(root)
  writeSpecFixture(paths, 'be-gt', { validation_commands: ['node --version'] })
  const returnPath = writeReturnFixture(paths, 'be-gt', 1, baseEnvelope('be-gt', 1, { status: 'done', reason: 'r', changes: ['README.md - edited'] }))
  const before = readFileSync(returnPath, 'utf8')
  const beforeMtime = statSync(returnPath).mtimeMs

  const baseline = captureBaseline({ cwd: checkout, reason: 'clean' })
  mkdirSync(dirname(baselinePathFor(paths, 'be-gt')), { recursive: true })
  writeBaselineExclusive(baselinePathFor(paths, 'be-gt'), baseline)
  writeFileSync(join(checkout, 'README.md'), '# sample repo\nedited\n')

  runCli(['check', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root])

  assert.equal(readFileSync(returnPath, 'utf8'), before, 'the return file on disk must be byte-identical after a check run')
  assert.equal(statSync(returnPath).mtimeMs, beforeMtime)
})

// ---------------------------------------------------------------------------
// symlinked-invocation regression (backend-notes.md 2026-08-02)
// ---------------------------------------------------------------------------

test('symlinked invocation: gates.mjs still runs its CLI body when invoked through a symlinked path component', () => {
  const dir = freshTmp()
  const checkout = makeGitCheckout(dir)
  const root = join(dir, 'dev-team')
  const linkDir = join(dir, 'linked')
  symlinkSync(dirname(GATES_PATH), linkDir)
  const linkedGatesPath = join(linkDir, 'gates.mjs')

  const result = spawnSync('node', [linkedGatesPath, 'baseline', '--task', 'sample-task', '--slice', 'be-gt', '--checkout', checkout, '--repo', 'sample-repo', '--root', root], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  const json = JSON.parse(result.stdout.trim())
  assert.equal(json.ok, true)
})

test('main(argv) always returns its exit code and never calls process.exit itself (source-text pin, code lines only — comments may still explain why)', () => {
  const codeLines = GATES_SOURCE.split('\n').filter((line) => !line.trim().startsWith('//'))
  assert.ok(!codeLines.some((line) => /process\.exit\(/.test(line)))
  assert.ok(codeLines.some((line) => /process\.exitCode\s*=\s*main\(/.test(line)))
})

test('in-process main(): an unknown subcommand returns 2 without throwing', () => {
  assert.equal(main(['bogus']), 2)
})
