// scripts/spec-lint.mjs — mechanical Handover Spec lint, exercised both as a
// library (lintSpec, imported directly) and as a CLI (spawned), against a
// throwaway fixture project (no network, no live model).
//
// VACUITY LENS (qa-notes.md 2026-08-02): two named degenerate lintSpec
// implementations a reviewer can check this suite actually rejects.
//   DEGENERATE A — reject-everything:
//     `(spec, root) => ({ ok: false, failures: [{ check: 'schema', detail: 'x' }], warnings: [] })`
//     caught by: 'a complete spec passes' (expects zero failures/warnings),
//                'CROSS-CONTAMINATION' (the golden call would still show a failure),
//                'CHECK-NAME MANIFEST' (would only ever surface one check name).
//   DEGENERATE B — permissive-everything:
//     `(spec, root) => ({ ok: true, failures: [], warnings: [] })`
//     caught by: 'schema: missing required field ...' (expects exactly one schema FAIL),
//                'missing file with missing parent dir fails' (expects exit 1 / one FAIL),
//                '5c: citing a multi-dot filename ...' and other exact-count assertions
//                that pin a specific WARN, not merely "no FAIL",
//                'validation_lane negative: an entry matching config.validate.full verbatim warns exactly once, naming the command',
//                'test_ownership negative: a coverage-mentioning criterion with no owner warns exactly once'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, cpSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'spec-lint.mjs')
const { lintSpec, main } = await import(pathToFileURL(SCRIPT).href)

const TMP_DIRS = []
function makeTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TMP_DIRS.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

const fixture = makeTmpDir('spec-lint-')
mkdirSync(join(fixture, 'src', 'api'), { recursive: true })
mkdirSync(join(fixture, 'scripts'), { recursive: true })
mkdirSync(join(fixture, 'dist'), { recursive: true })
mkdirSync(join(fixture, 'packages', 'app', 'dist'), { recursive: true })
writeFileSync(join(fixture, 'src', 'api', 'items.ts'), 'export {}\n'.repeat(80))
writeFileSync(join(fixture, 'src', 'api', 'thing.min.js'), 'export {}\n')
writeFileSync(join(fixture, 'src', 'api', 'widget.schema.mjs'), 'export {}\n'.repeat(10))
writeFileSync(join(fixture, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
writeFileSync(join(fixture, 'dist', 'bundle.js'), 'console.log(1)\n')
writeFileSync(join(fixture, 'packages', 'app', 'dist', 'bundle.js'), 'console.log(1)\n')
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', lint: 'eslint .' } }))
mkdirSync(join(fixture, 'test'), { recursive: true })
writeFileSync(join(fixture, 'test', 'items.test.ts'), 'export {}\n')

// A second project tree, entirely outside `fixture`, for the 5b out-of-root case.
const outsideDir = makeTmpDir('spec-lint-outside-')
writeFileSync(join(outsideDir, 'external.ts'), 'export {}\n'.repeat(5))

// A third project tree with no package.json at all, for the "no readable
// package.json" branch of checkValidationCommands.
const noPkgFixture = makeTmpDir('spec-lint-nopkg-')
mkdirSync(join(noPkgFixture, 'src', 'api'), { recursive: true })
writeFileSync(join(noPkgFixture, 'src', 'api', 'items.ts'), 'export {}\n'.repeat(80))

// A fourth project tree, mirroring the shared fixture's minimum, carrying a
// `.claude/dev-team/config.md` with a "## validate" section — kept separate
// from the shared `fixture` so every existing exact-count assertion against
// `fixture` stays untouched (constraints: no config.md on the shared fixture).
const configFixture = makeTmpDir('spec-lint-config-')
mkdirSync(join(configFixture, 'src', 'api'), { recursive: true })
mkdirSync(join(configFixture, '.claude', 'dev-team'), { recursive: true })
writeFileSync(join(configFixture, 'src', 'api', 'items.ts'), 'export {}\n'.repeat(80))
writeFileSync(join(configFixture, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', lint: 'eslint .' } }))
writeFileSync(join(configFixture, '.claude', 'dev-team', 'config.md'), ['## validate', '', '```', 'fast: node --test', 'full: node --test', '```', ''].join('\n'))

// A fifth project tree: config.md exists but has no "## validate" heading at all.
const noValidateHeadingFixture = makeTmpDir('spec-lint-config-noheading-')
mkdirSync(join(noValidateHeadingFixture, '.claude', 'dev-team'), { recursive: true })
writeFileSync(join(noValidateHeadingFixture, '.claude', 'dev-team', 'config.md'), '## task_source\n\nno validate section here\n')

// A sixth project tree: "## validate" section exists with a fenced block, but
// the block has a "fast:" line and no "full:" line.
const noFullLineFixture = makeTmpDir('spec-lint-config-nofull-')
mkdirSync(join(noFullLineFixture, '.claude', 'dev-team'), { recursive: true })
writeFileSync(join(noFullLineFixture, '.claude', 'dev-team', 'config.md'), ['## validate', '', '```', 'fast: node --test', '```', ''].join('\n'))

// A seventh project tree: a "full:" line appears in a fenced block, but under
// a DIFFERENT "##" heading only — section scoping must not pick it up.
const wrongSectionFixture = makeTmpDir('spec-lint-config-wrongsection-')
mkdirSync(join(wrongSectionFixture, '.claude', 'dev-team'), { recursive: true })
writeFileSync(join(wrongSectionFixture, '.claude', 'dev-team', 'config.md'), ['## validate', '', 'no fenced block here', '', '## other', '', '```', 'full: node --test', '```', ''].join('\n'))

const baseSpec = {
  task_id: 'be-01',
  domain: 'backend',
  goal: 'g',
  files_in_scope: ['src/api/items.ts'],
  constraints: [],
  acceptance_criteria: ['works'],
  validation_commands: ['npm test', 'npm run typecheck'],
  discovery_context: 'Handlers live in src/api/items.ts:40, pattern to mirror at src/api/items.ts:12.',
  out_of_scope: [],
  depends_on: [],
  interface_contract: 'none',
}

let n = 0
function lint(overrides = {}) {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify({ ...baseSpec, ...overrides }))
  return spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
}

function lintJson(overrides = {}) {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify({ ...baseSpec, ...overrides }))
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--json', specPath], { encoding: 'utf8' })
  return { r, obj: JSON.parse(r.stdout) }
}

// Pins the exact summary line and its counts — a spec-lint whose
// invokedDirectly guard is always false (or a permissive-everything
// degenerate) is a no-op/vacuous-pass and must fail this loudly, not just
// "not exit 1".
function assertSummary(r, failCount, warnCount) {
  const ok = failCount === 0
  assert.equal(r.status, ok ? 0 : 1, r.stdout + r.stderr)
  const re = new RegExp(`^spec-lint: ${ok ? 'PASS' : 'FAIL'} \\(${failCount} failure\\(s\\), ${warnCount} warning\\(s\\)\\)$`, 'm')
  assert.match(r.stdout, re, r.stdout + r.stderr)
}

test('spec-lint.mjs parses (node --check)', () => {
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('importing the module performs no I/O and exposes exactly lintSpec + main', async () => {
  const mod = await import(pathToFileURL(SCRIPT).href)
  assert.equal(typeof mod.lintSpec, 'function')
  assert.equal(typeof mod.main, 'function')
})

test('CROSS-CONTAMINATION: a failing call followed by the golden call leaves the golden call clean', () => {
  const r1 = lintSpec({ ...baseSpec, files_in_scope: ['src/nowhere/new.ts'] }, fixture)
  assert.ok(r1.failures.length > 0, 'sanity: the failing call actually failed')
  const r2 = lintSpec(baseSpec, fixture)
  assert.deepEqual(r2.failures, [])
  assert.deepEqual(r2.warnings, [])
})

test('a complete spec passes', () => {
  const r = lint()
  assertSummary(r, 0, 0)
})

test('reads the spec from stdin with -', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, '-'], {
    encoding: 'utf8',
    input: JSON.stringify(baseSpec),
  })
  assertSummary(r, 0, 0)
})

// ---------------------------------------------------------------------------
// SCHEMA VALIDATION (replaces the old presence-only checkFields)
// ---------------------------------------------------------------------------

test('missing required field fails via schema validation', () => {
  const spec = { ...baseSpec }
  delete spec.interface_contract
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(spec))
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /missing required property interface_contract/)
})

test('schema: wrong type (goal: 42) -> exactly one schema FAIL', () => {
  const r = lintSpec({ ...baseSpec, goal: 42 }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /goal/)
})

test('schema: bad domain enum value -> exactly one schema FAIL', () => {
  const r = lintSpec({ ...baseSpec, domain: 'nope' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /domain/)
})

test('schema: non-string array item in files_in_scope -> exactly one schema FAIL, no double-report', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: [42] }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /files_in_scope/)
})

test('schema: a bare-string files_in_scope is one schema FAIL, not one FAIL plus per-character WARNs (for...of on a string)', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: 'src/a.ts' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /files_in_scope/)
  assert.deepEqual(r.warnings, [])
})

test('schema: unexpected extra property -> exactly one schema FAIL (additionalProperties)', () => {
  const r = lintSpec({ ...baseSpec, bogus_extra: 'x' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /bogus_extra/)
})

test('schema: non-string validation_commands entry -> exactly one schema FAIL, no crash, no double-report', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: [42] }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /validation_commands/)
})

test('schema: a bare-string validation_commands is one schema FAIL, not one FAIL plus per-character WARNs (for...of on a string)', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: 'npm test' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /validation_commands/)
  assert.deepEqual(r.warnings, [])
})

test('minItems: all four legal-empty arrays pass with []', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: [], constraints: [], out_of_scope: [], depends_on: [] }, fixture)
  assert.deepEqual(r.failures, [])
})

test('minItems: empty files_in_scope -> exactly one schema FAIL, keyword minItems', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: [] }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /minItems/)
})

test('minItems: empty acceptance_criteria -> exactly one schema FAIL, keyword minItems', () => {
  const r = lintSpec({ ...baseSpec, acceptance_criteria: [] }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'schema')
  assert.match(r.failures[0].detail, /minItems/)
})

// ---------------------------------------------------------------------------
// files_in_scope
// ---------------------------------------------------------------------------

test('glob in files_in_scope fails', () => {
  const r = lint({ files_in_scope: ['src/**/*.ts'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /is a glob/)
})

test('prose in files_in_scope fails', () => {
  const r = lint({ files_in_scope: ['the items module'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /looks like prose/)
})

test('missing file with existing parent dir is a new-file warning, not a failure', () => {
  const r = lint({ files_in_scope: ['src/api/new-handler.ts'] })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /treated as a new file/)
})

test('missing file with missing parent dir fails', () => {
  const r = lint({ files_in_scope: ['src/nowhere/new.ts'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /neither does its parent directory/)
})

// ---------------------------------------------------------------------------
// NOISE-GLOB WARN (absorbed from issue #9)
// ---------------------------------------------------------------------------

test('noise-glob: root-level dist file in files_in_scope gets exactly one WARN naming the glob', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: ['dist/bundle.js'] }, fixture)
  assert.deepEqual(r.failures, [])
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].check, 'files_in_scope')
  assert.match(r.warnings[0].detail, /dist/)
})

test('noise-glob: nested *.min.* file gets a WARN ("*" crosses "/")', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: ['src/api/thing.min.js'] }, fixture)
  assert.deepEqual(r.failures, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0].detail, /\*\.min\.\*/)
})

test('noise-glob: nested dist file under packages/app/ is NOT flagged (bare directory glob is root-level only)', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: ['packages/app/dist/bundle.js'] }, fixture)
  assert.deepEqual(r.warnings, [])
})

test('noise-glob: golden spec has no noise WARN', () => {
  const r = lintSpec(baseSpec, fixture)
  assert.deepEqual(r.warnings, [])
})

// ---------------------------------------------------------------------------
// discovery_context softening table
// ---------------------------------------------------------------------------

test('discovery_context citing a nonexistent file:line now warns (parent dir exists)', () => {
  const r = lint({ discovery_context: 'Mirror the pattern at src/api/missing.ts:10.' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context citing a line beyond EOF now warns, not fails', () => {
  const r = lint({ discovery_context: 'Mirror the pattern at src/api/items.ts:9999.' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /file has only/)
})

test('discovery_context citing the true last line passes (lineCount off-by-one)', () => {
  const r = lint({ discovery_context: 'See src/api/items.ts:80 for the pattern.' })
  assertSummary(r, 0, 0)
})

test('discovery_context citing one line past the true last line warns, names the true line count', () => {
  const r = lint({ discovery_context: 'See src/api/items.ts:81 for the pattern.' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /file has only 80 lines/)
})

test('discovery_context mentioning a nonexistent bare path with a missing parent dir still FAILs (retained FAIL)', () => {
  const r = lint({ discovery_context: 'Rows persist via db.insert() from src/gone/db.ts.' })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context mentioning a nonexistent bare path with an existing parent dir warns', () => {
  const r = lint({ discovery_context: 'Rows persist via db.insert() from src/api/ghostfile.ts.' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context mentioning a domain-like bare path is not flagged', () => {
  const r = lint({ discovery_context: 'Pattern from github.com/foo/bar/utils.ts here.' })
  assertSummary(r, 0, 0)
})

test('discovery_context citing a slash-less basename:line only warns (unchanged)', () => {
  const r = lint({ discovery_context: 'see items.ts:5 in the handler' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /basename-only reference/)
})

test('discovery_context with a full URL is not misread as a path citation', () => {
  const r = lint({ discovery_context: 'See https://example.com/docs/api.ts:40 for background.' })
  assertSummary(r, 0, 0)
})

test('discovery_context with a hyphenated full URL is not misread as a path citation', () => {
  const r = lint({ discovery_context: 'See https://github.com/my-org/my-repo/blob/main/docs/api.ts:40 for background.' })
  assertSummary(r, 0, 0)
})

test('empty discovery_context with non-empty scope warns but passes', () => {
  const r = lint({ discovery_context: 'none' })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /the coder starts blind/)
})

// ---------------------------------------------------------------------------
// 5a — relative-path lookbehind (missing '-' let a hyphen open a false start)
// ---------------------------------------------------------------------------

test('5a: a citation blocked at its true start by "@" but containing a hyphen produces zero diagnostics', () => {
  // Against HEAD (unfixed) this produced exactly one basename-only WARN
  // ("cited item.ts:3 ..."), confirmed by hand: the '@' blocks the citation's
  // true start (src/api/my-item.ts:3), but the missing '-' in the lookbehind
  // let the regex re-open a false start right after the hyphen in
  // "my-item.ts", matching the bare "item.ts:3" fragment. 5b cannot affect
  // this fixture: the absolute-path regex needs a '/' preceded by a
  // non-class character, and there is none here.
  const r = lintSpec({ ...baseSpec, discovery_context: 'Reach out contact@src/api/my-item.ts:3 with questions.' }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

// ---------------------------------------------------------------------------
// 5b — absolute-path resolution (root-relative-only resolve(root, path))
// ---------------------------------------------------------------------------

test('5b: an absolute citation to a real file OUTSIDE the project root produces exactly one WARN', () => {
  // Against HEAD both regexes resolve the path against the project root
  // only, producing a phantom path and a FAIL, not a WARN naming the
  // out-of-root condition.
  const abs = join(outsideDir, 'external.ts')
  const r = lintSpec({ ...baseSpec, discovery_context: `see ${abs}:2 for reference` }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0].detail, /outside the project root/)
})

test('5b: an absolute citation to a nonexistent file whose root-relative parent exists warns', () => {
  const r = lintSpec({ ...baseSpec, discovery_context: 'see /src/api/nope.ts:40 for the shape' }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 1)
})

test('5b: an absolute citation whose parents are missing under both interpretations still FAILs', () => {
  const r = lintSpec({ ...baseSpec, discovery_context: 'see /nowhere/at/all/ghost.ts:1 for the shape' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.warnings.length, 0)
})

test('5b: realpath asymmetry — a canonical (symlink-resolved) absolute citation against the raw (unresolved) fixture root still resolves in-root', () => {
  // fixture is the raw, non-realpath'd mkdtempSync path (macOS TMPDIR itself
  // is /var -> /private/var, so on macOS `fixture` and its realpath already
  // differ). Deliberately realpathSync the CITED path only — exactly what a
  // citation looks like when copied from a shell that resolves symlinks —
  // to force root and the cited path onto opposite sides of the asymmetry.
  // Without realpathOr on both sides of the containment check, this
  // misclassifies as "resolves outside the project root" (a false WARN).
  const canonicalAbs = realpathSync(join(fixture, 'src', 'api', 'items.ts'))
  const r = lintSpec({ ...baseSpec, discovery_context: `see ${canonicalAbs}:40 for the shape` }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

test('COMBINED (5a+5b): an in-root hyphenated absolute citation to a real file is zero diagnostics', () => {
  // The fixture directory is created with prefix "spec-lint-", so this
  // absolute path is itself hyphenated and exercises both the lookbehind
  // bug and the resolution bug at once. Against HEAD this produces TWO
  // diagnostics (one false-start FAIL/WARN per regex) — confirmed by hand
  // simulation of the unmodified relRefs/absRefs regexes against an
  // equivalent path; see STRIKE REPORT in the coder return for the count.
  const abs = join(fixture, 'src', 'api', 'items.ts')
  const r = lintSpec({ ...baseSpec, discovery_context: `see ${abs}:40 for the shape` }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

// ---------------------------------------------------------------------------
// 5c — bare-mention truncation of a double-extension citation (span exclusion)
// ---------------------------------------------------------------------------

test('5c: citing a multi-dot filename with a line number produces zero diagnostics after the fix', () => {
  // Against HEAD this produced exactly one FAIL naming the TRUNCATED path
  // "src/api/widget.schema" (everything up to the last dot) — the bare
  // regex's backtracking end-lookahead re-matches inside the span the
  // relative-citation pass already correctly claimed and resolved. This
  // fixture has no hyphen and no absolute path, so neither 5a's nor 5b's
  // fix can influence it.
  const r = lintSpec({ ...baseSpec, discovery_context: 'See src/api/widget.schema.mjs:5 for the shape.' }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

test('5c negative (a): a bare multi-dot mention with no line number is silent when the file exists', () => {
  const r = lintSpec({ ...baseSpec, discovery_context: 'The shape lives in src/api/widget.schema.mjs.' }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

test('5c negative (a): a bare multi-dot mention with a missing parent dir still FAILs', () => {
  const r = lintSpec({ ...baseSpec, discovery_context: 'See src/ghostdir/widget.schema.mjs for the shape.' }, fixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'discovery_context')
})

test('5c negative (b): a single-extension citation with a line number is unaffected', () => {
  const r = lintSpec({ ...baseSpec, discovery_context: 'See src/api/items.ts:40 for the pattern.' }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 0)
})

test('5c negative (d): the same multi-dot file mentioned once bare and once cited produces exactly two diagnostics, not three', () => {
  const r = lintSpec({
    ...baseSpec,
    discovery_context: 'See src/api/ghost.schema.mjs:5 for the pattern, and also src/api/ghost.schema.mjs is referenced again below.',
  }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 2)
  for (const w of r.warnings) assert.equal(w.check, 'discovery_context')
})

// ---------------------------------------------------------------------------
// CHECK-NAME MANIFEST
// ---------------------------------------------------------------------------

test('CHECK-NAME MANIFEST: lintSpec only ever emits {discovery_context, files_in_scope, schema, test_ownership, validation_commands, validation_lane}', () => {
  const seen = new Set()
  const specs = [
    [baseSpec, fixture],
    [{ ...baseSpec, files_in_scope: [] }, fixture],
    [{ ...baseSpec, files_in_scope: ['src/nowhere/new.ts'] }, fixture],
    [{ ...baseSpec, discovery_context: 'Mirror the pattern at src/api/missing.ts:10.' }, fixture],
    [{ ...baseSpec, validation_commands: ['definitely-not-a-real-cmd-xyz --flag'] }, fixture],
    [{ ...baseSpec, validation_commands: ['node --test'] }, configFixture],
    [{ ...baseSpec, acceptance_criteria: ['coverage for the bad-enum path is handled'] }, fixture],
  ]
  for (const [s, root] of specs) {
    const r = lintSpec(s, root)
    for (const d of [...r.failures, ...r.warnings]) seen.add(d.check)
  }
  assert.deepEqual([...seen].sort(), ['discovery_context', 'files_in_scope', 'schema', 'test_ownership', 'validation_commands', 'validation_lane'])
})

// ---------------------------------------------------------------------------
// validation_commands
// ---------------------------------------------------------------------------

test('validation command whose npm script is missing fails', () => {
  const r = lint({ validation_commands: ['npm run nonexistent-script'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /not in package\.json/)
})

test('validation command whose binary is not on PATH fails', () => {
  const r = lint({ validation_commands: ['definitely-not-a-real-cmd-xyz --flag'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /not found on PATH/)
})

test('env-var prefix is skipped when resolving the binary', () => {
  const r = lint({ validation_commands: ['CI=1 node --version'] })
  assertSummary(r, 0, 0)
})

test('lowercase env-var prefix is also skipped when resolving the binary', () => {
  const r = lint({ validation_commands: ['npm_config_yes=true node --version'] })
  assertSummary(r, 0, 0)
})

test('pnpm without "run" whose script is missing fails', () => {
  const r = lint({ validation_commands: ['pnpm nonexistent-xyz'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /not in package\.json/)
})

test('pnpm without "run" whose script exists passes', () => {
  const r = lint({ validation_commands: ['pnpm lint'] })
  assertSummary(r, 0, 0)
})

test('yarn without "run" whose script is missing fails', () => {
  const r = lint({ validation_commands: ['yarn nonexistent-xyz'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /not in package\.json/)
})

test('yarn without "run" whose script exists passes', () => {
  const r = lint({ validation_commands: ['yarn test'] })
  assertSummary(r, 0, 0)
})

test('a package-manager verb (install) is not treated as a script name', () => {
  const r = lint({ validation_commands: ['npm install'] })
  assertSummary(r, 0, 0)
})

test('a relative-path command is resolved against --root, not the linter cwd', () => {
  const r = lint({ validation_commands: ['scripts/run.sh'] })
  assertSummary(r, 0, 0)
})

test('a nonexistent relative-path command fails', () => {
  const r = lint({ validation_commands: ['scripts/nope.sh'] })
  assertSummary(r, 1, 0)
  assert.match(r.stdout, /not found on PATH/)
})

test('validation_commands: missing package.json at project root -> exactly one FAIL naming it', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['npm run typecheck'] }, noPkgFixture)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].check, 'validation_commands')
  assert.match(r.failures[0].detail, /no readable package\.json/)
})

// ---------------------------------------------------------------------------
// validation_lane (WARN — a spec's validation_commands entry matches
// config.md's `## validate` `full:` lane verbatim)
// ---------------------------------------------------------------------------

test('validation_lane negative: an entry matching config.validate.full verbatim warns exactly once, naming the command', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test'] }, configFixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].check, 'validation_lane')
  assert.match(r.warnings[0].detail, /matches config\.validate\.full/)
  assert.match(r.warnings[0].detail, /node --test/)
})

test('validation_lane env-prefix normalization: an env-prefixed full-lane command still warns (tokenization is reused, not re-implemented)', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['CI=1 node --test'] }, configFixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 1)
})

test('validation_lane positive (a): a scoped command narrower than the full lane produces no validation_lane diagnostic', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test test/spec-lint.test.mjs'] }, configFixture)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 0)
})

test('validation_lane positive (b): the exact full-lane command against a root with no config.md at all (the null path) does not throw and does not warn', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test'] }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 0)
})

test('validation_lane positive (c): a config.md with no "## validate" heading does not throw and does not warn', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test'] }, noValidateHeadingFixture)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 0)
})

test('validation_lane positive (d): a "## validate" fenced block with a "fast:" line but no "full:" line does not warn', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test'] }, noFullLineFixture)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 0)
})

test('validation_lane positive (e): a "full:" line under a DIFFERENT "##" heading only is not picked up (section scoping)', () => {
  const r = lintSpec({ ...baseSpec, validation_commands: ['node --test'] }, wrongSectionFixture)
  assert.equal(r.warnings.filter((w) => w.check === 'validation_lane').length, 0)
})

// ---------------------------------------------------------------------------
// test_ownership (WARN — acceptance_criteria mentions test coverage but
// names no owner)
// ---------------------------------------------------------------------------

test('test_ownership negative: a coverage-mentioning criterion with no owner warns exactly once', () => {
  const r = lintSpec({ ...baseSpec, acceptance_criteria: ['coverage for the bad-enum path is handled'] }, fixture)
  assert.equal(r.failures.length, 0)
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].check, 'test_ownership')
  assert.match(r.warnings[0].detail, /no owner is named/)
})

test('test_ownership false-positive guard: quoted command text is stripped before keyword matching (double quotes)', () => {
  const r = lintSpec({ ...baseSpec, acceptance_criteria: ['"npm test -- items" passes'] }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0)
})

test('test_ownership false-positive guard: quoted command text is stripped before keyword matching (backticks)', () => {
  const r = lintSpec({ ...baseSpec, acceptance_criteria: ['`node --test` passes'] }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0)
})

test('test_ownership positive (a): a test-mentioning criterion with a test file present in files_in_scope does not warn', () => {
  const r = lintSpec({ ...baseSpec, files_in_scope: [...baseSpec.files_in_scope, 'test/items.test.ts'], acceptance_criteria: ['coverage for the bad-enum path is handled'] }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0)
})

test('test_ownership positive (b): a criterion naming dev-team:test-engineer as gate owner does not warn, even with no test file in scope', () => {
  const r = lintSpec({ ...baseSpec, acceptance_criteria: ["coverage for the 400 path is dev-team:test-engineer's job at the gate"] }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0)
})

test('test_ownership positive (c): the golden baseSpec, which mentions nothing, does not warn', () => {
  const r = lintSpec(baseSpec, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0)
})

test('test_ownership detection matrix: each files_in_scope pattern that should suppress or not suppress the warning', () => {
  const suppressing = ['test/spec-lint.test.mjs', 'tests/foo.py', '__tests__/a.js', 'pkg/foo_test.go', 'pkg/test_foo.py', 'src/api/items.spec.ts']
  const nonSuppressing = ['src/api/items.ts', 'src/api/latest.ts', 'contest/foo.js']
  for (const p of suppressing) {
    const r = lintSpec({ ...baseSpec, files_in_scope: [p], acceptance_criteria: ['coverage for the bad-enum path is handled'] }, fixture)
    assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 0, `expected ${p} to suppress`)
  }
  for (const p of nonSuppressing) {
    const r = lintSpec({ ...baseSpec, files_in_scope: [p], acceptance_criteria: ['coverage for the bad-enum path is handled'] }, fixture)
    assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 1, `expected ${p} NOT to suppress`)
  }
})

test('test_ownership: three test-mentioning criteria with no owner produce exactly ONE warning, not three', () => {
  const r = lintSpec({
    ...baseSpec,
    acceptance_criteria: ['coverage for path A', 'this needs tests too', 'testing the third path'],
  }, fixture)
  assert.equal(r.warnings.filter((w) => w.check === 'test_ownership').length, 1)
})

test('test_ownership severity is WARN at the CLI surface: exits 0, prints WARN test_ownership and the PASS summary', () => {
  const r = lint({ acceptance_criteria: ['coverage for the bad-enum path is handled'] })
  assertSummary(r, 0, 1)
  assert.match(r.stdout, /WARN test_ownership:/)
})

test('invalid JSON exits 2', () => {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, '{not json')
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})

test('invalid JSON with --json still exits 2 and stdout stays empty (no leaked diagnostic in JSON mode)', () => {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, '{not json')
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--json', specPath], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
})

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

test('--json: stdout is exactly one JSON line matching lintSpec\'s return shape; human lines + summary go to stderr', () => {
  const { r, obj } = lintJson()
  assert.deepEqual(obj, { ok: true, failures: [], warnings: [] })
  assert.equal(r.stdout.trim().split('\n').length, 1)
  assert.match(r.stderr, /^spec-lint: PASS \(0 failure\(s\), 0 warning\(s\)\)$/m)
  assert.equal(r.status, 0)
})

test('--json: a failing spec still exits 1 and reports failures in the JSON object, human lines on stderr', () => {
  const { r, obj } = lintJson({ files_in_scope: ['src/nowhere/new.ts'] })
  assert.equal(r.status, 1)
  assert.equal(obj.ok, false)
  assert.equal(obj.failures.length, 1)
  assert.match(r.stderr, /^FAIL files_in_scope:/m)
  assert.match(r.stderr, /^spec-lint: FAIL \(1 failure\(s\), 0 warning\(s\)\)$/m)
  assert.equal(r.stdout.trim().split('\n').length, 1)
})

test('--json composes with the "-" stdin form', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--json', '-'], {
    encoding: 'utf8',
    input: JSON.stringify(baseSpec),
  })
  const obj = JSON.parse(r.stdout)
  assert.deepEqual(obj, { ok: true, failures: [], warnings: [] })
  assert.equal(r.status, 0)
})

// ---------------------------------------------------------------------------
// SYMLINK REGRESSION
// ---------------------------------------------------------------------------

test('SYMLINK: invoking spec-lint.mjs through a symlinked path component still runs main() and PASSes', () => {
  const dir = makeTmpDir('spec-lint-symlink-')
  const linkPath = join(dir, 'spec-lint-link.mjs')
  symlinkSync(SCRIPT, linkPath)
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [linkPath, '--root', fixture, specPath], { encoding: 'utf8' })
  assertSummary(r, 0, 0)
})

// ---------------------------------------------------------------------------
// SCHEMA-LOAD FAILURE + DRIFT GUARD (byte-copy fixture)
// ---------------------------------------------------------------------------

const REAL_SCHEMA = readFileSync(join(ROOT, 'handover-spec.schema.json'), 'utf8')

function makeSchemaCopyFixture() {
  const dir = makeTmpDir('spec-lint-copy-')
  mkdirSync(join(dir, 'scripts', 'cmux'), { recursive: true })
  cpSync(join(ROOT, 'scripts', 'spec-lint.mjs'), join(dir, 'scripts', 'spec-lint.mjs'))
  cpSync(join(ROOT, 'scripts', 'cmux', 'contract.mjs'), join(dir, 'scripts', 'cmux', 'contract.mjs'))
  cpSync(join(ROOT, 'scripts', 'noise-globs.json'), join(dir, 'scripts', 'noise-globs.json'))
  return dir
}

test('schema-copy CONTROL: real schema copied verbatim still PASSes (without this, the negatives below are vacuous)', () => {
  const dir = makeSchemaCopyFixture()
  writeFileSync(join(dir, 'handover-spec.schema.json'), REAL_SCHEMA)
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assertSummary(r, 0, 0)
})

test('schema-copy: unparseable schema bytes -> non-zero exit, diagnostic naming the schema on stderr, no PASS on stdout', () => {
  const dir = makeSchemaCopyFixture()
  writeFileSync(join(dir, 'handover-spec.schema.json'), '{not json')
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /handover-spec\.schema\.json/)
  assert.ok(!r.stdout.includes('spec-lint: PASS'))
})

test('schema-copy: unparseable schema bytes with --json -> stdout stays empty (no leaked diagnostic in JSON mode)', () => {
  const dir = makeSchemaCopyFixture()
  writeFileSync(join(dir, 'handover-spec.schema.json'), '{not json')
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, '--json', specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /handover-spec\.schema\.json/)
})

test('schema-copy: absent schema -> non-zero exit, diagnostic naming the schema on stderr, no PASS on stdout', () => {
  const dir = makeSchemaCopyFixture()
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /handover-spec\.schema\.json/)
  assert.ok(!r.stdout.includes('spec-lint: PASS'))
})

test('schema-copy: absent schema with --json -> stdout stays empty (no leaked diagnostic in JSON mode)', () => {
  const dir = makeSchemaCopyFixture()
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, '--json', specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /handover-spec\.schema\.json/)
})

test('schema-copy: schema reduced to "{}" (syntactically valid, structurally empty) -> non-zero exit, no PASS on stdout', () => {
  const dir = makeSchemaCopyFixture()
  writeFileSync(join(dir, 'handover-spec.schema.json'), '{}')
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /handover-spec\.schema\.json/)
  assert.ok(!r.stdout.includes('spec-lint: PASS'))
})

test('schema-copy: noise-globs.json with a shape drift (globs renamed) -> non-zero exit, diagnostic naming the path', () => {
  const dir = makeSchemaCopyFixture()
  writeFileSync(join(dir, 'handover-spec.schema.json'), REAL_SCHEMA)
  writeFileSync(join(dir, 'scripts', 'noise-globs.json'), JSON.stringify({ patterns: ['*.lock'] }))
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /noise-globs\.json/)
  assert.ok(!r.stdout.includes('spec-lint: PASS'))
})

test('DRIFT GUARD: a schema whose required array carries one extra probe field makes the golden spec FAIL naming it', () => {
  const dir = makeSchemaCopyFixture()
  const schema = JSON.parse(REAL_SCHEMA)
  schema.required = [...schema.required, 'probe_field_xyz']
  writeFileSync(join(dir, 'handover-spec.schema.json'), JSON.stringify(schema))
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(baseSpec))
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'spec-lint.mjs'), '--root', fixture, specPath], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /probe_field_xyz/)
})
