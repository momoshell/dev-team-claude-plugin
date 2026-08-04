// return-lint.mjs coverage. Positives asserted FIRST (qa-notes 2026-08-02):
// a valid json return and a valid markdown+verdict return each produce zero
// FAIL lines before any negative case runs. Every negative asserts the
// violation's KEYWORD, not merely exit 1 (acceptance criteria).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, readFileSync, rmSync, existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { ROOT } from './helpers.mjs'
import { resolveRoots, taskPaths, resolveRole } from '../scripts/cmux/resolve.mjs'
import { newDispatchId, buildRecord, snapshotWorkerPlugin } from '../scripts/cmux/record.mjs'
import { validateReturn } from '../scripts/cmux/ladder.mjs'
import {
  main, lintReturn, writeBlockedReturn, sanitizeReasonForMarkdown,
  RETURN_PATH_NOT_REGULAR_FILE, STALE_OR_ABSENT_RETURN,
  VERDICT_SECTION_MISSING, VERDICT_BLOCK_MISSING, VERDICT_BLOCK_MULTIPLE,
  VERDICT_BLOCK_UNPARSEABLE, VERDICT_BLOCK_INVALID,
  USAGE_MESSAGE, RECORD_UNREADABLE_MESSAGE, RECORD_INVALID_MESSAGE,
  RETURN_PATH_ESCAPES_TASK_DIR_MESSAGE,
} from '../scripts/cmux/return-lint.mjs'
import { BLOCKED_MARKDOWN_PREFIX } from '../scripts/cmux/contract.mjs'

const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const FIXED_CREATED_AT = '2026-08-01T00:00:00.000Z'

// Every fixture task/state tree lives under a fresh tmp root, removed after.
const CREATED_TMP_DIRS = []
function makeTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  CREATED_TMP_DIRS.push(dir)
  return dir
}
after(() => {
  for (const dir of CREATED_TMP_DIRS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// buildTestRecord(role) -> a fully dispatch-record.schema.json-valid record
// (mirroring test/cmux-record.test.mjs's buildValidRecord), created_at
// pinned to a fixed value so every test controls freshness by mtime offset
// alone.
function buildTestRecord(role, sliceId = 'be-1c') {
  const root = makeTmpDir('return-lint-')
  const primaryCheckout = join(root, 'checkout')
  mkdirSync(primaryCheckout, { recursive: true })
  const roots = resolveRoots({ taskArtifactsRoot: join(root, 'dev-team') })
  const paths = taskPaths({ roots, repoSlug: 'sample-repo', taskSlug: 'sample-task' })
  const snapshot = snapshotWorkerPlugin({
    pluginRoot: ROOT, snapshotDir: paths.snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles,
  })
  const ctx = {
    roots,
    paths,
    roster: rosterDefault,
    resolved: resolveRole(role, { plugin: rosterDefault.roles[role] }),
    pluginRoot: ROOT,
    taskId: 'be-1c task',
    taskSlug: 'sample-task',
    repoSlug: 'sample-repo',
    primaryCheckout,
    snapshot,
    config: {},
    now: 1754136000123,
    dispatchId: newDispatchId(),
    attnUpstream: null,
  }
  const record = buildRecord(ctx, { role, sliceId, attempt: 1, spec: { validation_commands: ['node --test'] } })
  record.created_at = FIXED_CREATED_AT
  return record
}

function writeReturnFile(record, text, { mtimeOffsetMs = 5000 } = {}) {
  mkdirSync(dirname(record.return_path), { recursive: true })
  writeFileSync(record.return_path, text, 'utf8')
  const mtime = new Date(Date.parse(record.created_at) + mtimeOffsetMs)
  utimesSync(record.return_path, mtime, mtime)
}

function envelopeText(record, body) {
  return JSON.stringify({
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: '2026-08-01T00:00:05.000Z',
    body,
  })
}

function keywords(violations) {
  return violations.map((v) => v.keyword)
}

function validVerdictMarkdown(verdict = 'pass') {
  return `## Verdict\n\n\`\`\`json\n${JSON.stringify({ verdict, findings: [] })}\n\`\`\`\n`
}

function captureStdio(fn) {
  const outWrite = process.stdout.write.bind(process.stdout)
  const errWrite = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  process.stdout.write = (chunk) => { stdout += chunk; return true }
  process.stderr.write = (chunk) => { stderr += chunk; return true }
  try {
    const code = fn()
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = outWrite
    process.stderr.write = errWrite
  }
}

// ---------------------------------------------------------------------------
// POSITIVES FIRST (qa-notes 2026-08-02).
// ---------------------------------------------------------------------------

test('positive: a valid json return produces zero violations', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, envelopeText(record, { status: 'done', reason: 'ok' }))
  assert.deepEqual(lintReturn(record), [])
})

test('positive: a valid markdown+verdict return produces zero violations', () => {
  const record = buildTestRecord('build-validator')
  writeReturnFile(record, envelopeText(record, validVerdictMarkdown()))
  assert.deepEqual(lintReturn(record), [])
})

test('positive: CLI base form exits 0 for a valid json return', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, envelopeText(record, { status: 'done', reason: 'ok' }))
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code, stdout } = captureStdio(() => main([recordPath]))
  assert.equal(code, 0)
  assert.match(stdout, /PASS/)
})

test('positive: CLI --block-json prints nothing and exits 0 for a valid return', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, envelopeText(record, { status: 'done', reason: 'ok' }))
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code, stdout } = captureStdio(() => main(['--block-json', recordPath]))
  assert.equal(code, 0)
  assert.equal(stdout, '')
})

// ---------------------------------------------------------------------------
// The doc-tab placeholder (dispatch.mjs:712) is invalid in BOTH kinds.
// ---------------------------------------------------------------------------

const PLACEHOLDER_TEXT = '# robot coder — working…\n'

test('negative: the doc-tab placeholder is invalid for a json-kind role', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, PLACEHOLDER_TEXT)
  assert.ok(keywords(lintReturn(record)).includes('invalid_json'))
})

test('negative: the doc-tab placeholder is invalid for a markdown-kind role', () => {
  const record = buildTestRecord('build-validator')
  writeReturnFile(record, PLACEHOLDER_TEXT)
  assert.ok(keywords(lintReturn(record)).includes('invalid_json'))
})

// ---------------------------------------------------------------------------
// Freshness / fs-state negatives.
// ---------------------------------------------------------------------------

test('negative: an absent return is reported stale_or_absent_return', () => {
  const record = buildTestRecord('coder')
  assert.ok(keywords(lintReturn(record)).includes(STALE_OR_ABSENT_RETURN))
})

test('negative: a stale (same-instant) return is reported stale_or_absent_return', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, envelopeText(record, { status: 'done', reason: 'ok' }), { mtimeOffsetMs: 0 })
  const violations = lintReturn(record)
  assert.ok(keywords(violations).includes(STALE_OR_ABSENT_RETURN))
})

test('negative: a directory at return_path is reported return_path_not_regular_file', () => {
  const record = buildTestRecord('coder')
  mkdirSync(record.return_path, { recursive: true })
  assert.ok(keywords(lintReturn(record)).includes(RETURN_PATH_NOT_REGULAR_FILE))
})

test('negative: a symlink at return_path is reported return_path_not_regular_file', () => {
  const record = buildTestRecord('coder')
  mkdirSync(dirname(record.return_path), { recursive: true })
  const targetPath = join(dirname(record.return_path), 'elsewhere.json')
  writeFileSync(targetPath, envelopeText(record, { status: 'done', reason: 'ok' }))
  symlinkSync(targetPath, record.return_path)
  assert.ok(keywords(lintReturn(record)).includes(RETURN_PATH_NOT_REGULAR_FILE))
})

test('negative: an identity mismatch is reported by ladder\'s own keyword', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, envelopeText({ ...record, dispatch_id: '99999999-9999-9999-9999-999999999999' }, { status: 'done', reason: 'ok' }))
  assert.ok(keywords(lintReturn(record)).includes('dispatch_id_mismatch'))
})

test('negative: a required markdown section missing (non-verdict role) is reported missing_required_section', () => {
  const record = buildTestRecord('plan-reviewer')
  writeReturnFile(record, envelopeText(record, 'no headings here at all\n'))
  assert.ok(keywords(lintReturn(record)).includes('missing_required_section'))
})

// ---------------------------------------------------------------------------
// The one new predicate: verdict-block presence/parse/enum.
// ---------------------------------------------------------------------------

test('negative: a fenced fake Verdict heading inside an example never satisfies the section (fence-stripped)', () => {
  const record = buildTestRecord('build-validator')
  const body = 'Intro text.\n\n```md\n## Verdict\nthis is only an example\n```\n\nNo real section follows.\n'
  writeReturnFile(record, envelopeText(record, body))
  const found = keywords(lintReturn(record))
  assert.ok(found.includes('missing_required_section'))
  assert.ok(found.includes(VERDICT_SECTION_MISSING))
})

// be-06-01 S2: extractSection's match predicate is now the SAME as S1's
// checkSections predicate (level >= 2, case-folded prefix). A divergence
// between the heading the lint REQUIRES and the heading the verdict block is
// looked up IN is exactly the accept-a-fake hole recorded at
// .claude/dev-team/memory/backend-notes.md:16.
test('positive: `### Verdict (gate)` satisfies the Verdict section lookup (level >= 2, prefix match)', () => {
  const record = buildTestRecord('build-validator')
  const body = `### Verdict (gate)\n\n\`\`\`json\n${JSON.stringify({ verdict: 'pass', findings: [] })}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.deepEqual(lintReturn(record), [])
})

test('negative: `# Verdict` (level 1) does NOT satisfy the Verdict section lookup', () => {
  const record = buildTestRecord('build-validator')
  const body = `# Verdict\n\n\`\`\`json\n${JSON.stringify({ verdict: 'pass', findings: [] })}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_SECTION_MISSING))
})

test('positive: the Verdict section still ends at the next real heading of ANY level (including level 1)', () => {
  const record = buildTestRecord('build-validator')
  const body = `## Verdict\n\n\`\`\`json\n${JSON.stringify({ verdict: 'pass', findings: [] })}\n\`\`\`\n\n# Unrelated trailer\n\nnot part of the verdict section\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.deepEqual(lintReturn(record), [])
})

test('negative: zero fenced json blocks in the Verdict section is verdict_block_missing', () => {
  const record = buildTestRecord('build-validator')
  writeReturnFile(record, envelopeText(record, '## Verdict\n\nNo fenced block here.\n'))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_MISSING))
})

test('negative: two fenced json blocks in the Verdict section is verdict_block_multiple', () => {
  const record = buildTestRecord('build-validator')
  const one = JSON.stringify({ verdict: 'pass', findings: [] })
  const body = `## Verdict\n\n\`\`\`json\n${one}\n\`\`\`\n\n\`\`\`json\n${one}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_MULTIPLE))
})

test('negative: an unparseable fenced block is verdict_block_unparseable', () => {
  const record = buildTestRecord('build-validator')
  writeReturnFile(record, envelopeText(record, '## Verdict\n\n```json\n{ not json\n```\n'))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_UNPARSEABLE))
})

test('negative: a bad verdict enum value is verdict_block_invalid', () => {
  const record = buildTestRecord('build-validator')
  const bad = JSON.stringify({ verdict: 'maybe', findings: [] })
  writeReturnFile(record, envelopeText(record, `## Verdict\n\n\`\`\`json\n${bad}\n\`\`\`\n`))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_INVALID))
})

test('negative: a malformed finding (bad severity enum) is verdict_block_invalid', () => {
  const record = buildTestRecord('build-validator')
  const bad = JSON.stringify({ verdict: 'changes-needed', findings: [{ severity: 'oops', file: 'a.ts', line: 1, summary: 'x' }] })
  writeReturnFile(record, envelopeText(record, `## Verdict\n\n\`\`\`json\n${bad}\n\`\`\`\n`))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_INVALID))
})

// ---------------------------------------------------------------------------
// writeBlockedReturn: the written envelope passes ladder.validateReturn for
// BOTH kinds — asserted against the bytes actually written.
// ---------------------------------------------------------------------------

test('writeBlockedReturn: json-kind envelope passes ladder.validateReturn', () => {
  const record = buildTestRecord('coder')
  const path = writeBlockedReturn(record, 'agent ended 20 turns without a contract-valid return; last lint failure: invalid_json')
  assert.equal(path, record.return_path)
  const text = readFileSync(path, 'utf8')
  const result = validateReturn(record, text)
  assert.deepEqual(result.violations, [])
  assert.equal(result.ok, true)
  assert.equal(result.envelope.body.status, 'blocked')
  assert.equal(typeof result.envelope.body.reason, 'string')
})

test('writeBlockedReturn: markdown+verdict envelope passes ladder.validateReturn', () => {
  const record = buildTestRecord('build-validator')
  const path = writeBlockedReturn(record, 'adapter failure: worker process exited before writing a return')
  const text = readFileSync(path, 'utf8')
  const result = validateReturn(record, text)
  assert.deepEqual(result.violations, [])
  assert.equal(result.ok, true)
  assert.match(result.envelope.body, /^status: blocked - /)
  assert.match(result.envelope.body, /## Verdict/)
  const fenceMatch = result.envelope.body.match(/```json\n([\s\S]*?)\n```/)
  assert.ok(fenceMatch, 'expected exactly one fenced json block in the written body')
  const verdictObj = JSON.parse(fenceMatch[1])
  assert.deepEqual(verdictObj, { verdict: 'inconclusive', findings: [] })
})

test('writeBlockedReturn: markdown role with multiple required_sections covers every heading', () => {
  const record = buildTestRecord('code-reviewer')
  const path = writeBlockedReturn(record, 'timed out')
  const text = readFileSync(path, 'utf8')
  const result = validateReturn(record, text)
  assert.deepEqual(result.violations, [])
  for (const name of record.return.required_sections) {
    assert.match(result.envelope.body, new RegExp(`## ${name}`))
  }
})

// ---------------------------------------------------------------------------
// destinationHoldsFreshNonBlockedReturn asymmetry (NOT re-keyed on
// BLOCKED_MARKDOWN_PREFIX, deliberately, unlike ladder.mjs's classify()):
// writeBlockedReturn must never clobber an existing fresh markdown return
// already sitting at return_path, whether or not that return happens to be
// blocked-prefixed itself. See the comment at return-lint.mjs's
// destinationHoldsFreshNonBlockedReturn pointing at OUTCOME_MAPPING's
// worker_blocked_markdown row for the classifier's opposite treatment.
// ---------------------------------------------------------------------------

test('destinationHoldsFreshNonBlockedReturn asymmetry: writeBlockedReturn leaves an existing fresh non-blocked markdown return byte-identical', () => {
  const record = buildTestRecord('build-validator')
  const existingBody = '## Verdict\n\n```json\n{"verdict": "pass", "findings": []}\n```\n'
  writeReturnFile(record, envelopeText(record, existingBody))
  const before = readFileSync(record.return_path, 'utf8')

  const path = writeBlockedReturn(record, 'a racing/orphaned gate write')
  const after = readFileSync(record.return_path, 'utf8')

  assert.equal(path, record.return_path)
  assert.equal(after, before, 'writeBlockedReturn must not overwrite an existing fresh legitimate markdown return')
})

test('destinationHoldsFreshNonBlockedReturn asymmetry: writeBlockedReturn leaves an existing fresh BLOCKED-prefixed markdown return byte-identical too', () => {
  const record = buildTestRecord('build-validator')
  const existingBody = `${BLOCKED_MARKDOWN_PREFIX}an earlier blocked envelope\n\n## Verdict\n\n\`\`\`json\n{"verdict": "inconclusive", "findings": []}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, existingBody))
  const before = readFileSync(record.return_path, 'utf8')

  const path = writeBlockedReturn(record, 'a second, later gate write for the same dispatch')
  const after = readFileSync(record.return_path, 'utf8')

  assert.equal(path, record.return_path)
  assert.equal(after, before, 'writeBlockedReturn must not overwrite a prior blocked envelope from the same dispatch either')
})

// ---------------------------------------------------------------------------
// WORKER_BLOCKED_STATUSES drift guard (fix-1c-04 constraint: re-declared
// locally rather than imported from fix-1c-01's contract.mjs export, since
// fix-1c-01 lands in a parallel fix-round slice — this guards the local
// copy in return-lint.mjs against silently rotting if that source-of-truth
// literal ever changes).
// ---------------------------------------------------------------------------

test('WORKER_BLOCKED_STATUSES drift guard: contract.mjs still declares the identical two-element literal', () => {
  const contractSource = readFileSync(join(ROOT, 'scripts/cmux/contract.mjs'), 'utf8')
  assert.match(
    contractSource,
    /export const WORKER_BLOCKED_STATUSES = \['blocked', 'insufficient'\]/,
    'return-lint.mjs re-declares WORKER_BLOCKED_STATUSES locally; update its local copy if contract.mjs\'s literal changed',
  )
})

// BLOCKED_MARKDOWN_PREFIX drift guard: return-lint.mjs imports the constant
// (never re-declares the literal) — this pins contract.mjs still declaring
// it, mirroring the WORKER_BLOCKED_STATUSES drift guard above.
test('BLOCKED_MARKDOWN_PREFIX drift guard: contract.mjs still declares the identical literal', () => {
  const contractSource = readFileSync(join(ROOT, 'scripts/cmux/contract.mjs'), 'utf8')
  assert.match(
    contractSource,
    /export const BLOCKED_MARKDOWN_PREFIX = 'status: blocked - '/,
    'return-lint.mjs imports BLOCKED_MARKDOWN_PREFIX from contract.mjs; update this guard if contract.mjs\'s literal changed',
  )
  const returnLintSource = readFileSync(join(ROOT, 'scripts/cmux/return-lint.mjs'), 'utf8')
  assert.ok(
    !/['"]status: blocked - ['"]/.test(returnLintSource),
    'return-lint.mjs must import BLOCKED_MARKDOWN_PREFIX, never re-declare its literal',
  )
})

// ---------------------------------------------------------------------------
// MF3: writeBlockedReturn refuses a return_path outside record.task_dir.
// ---------------------------------------------------------------------------

test('positive: writeBlockedReturn writes when return_path resolves inside task_dir', () => {
  const record = buildTestRecord('coder')
  const path = writeBlockedReturn(record, 'boom')
  assert.equal(path, record.return_path)
  assert.ok(existsSync(record.return_path))
})

test('negative: writeBlockedReturn throws when return_path resolves outside task_dir, and writes nothing', () => {
  const record = buildTestRecord('coder')
  const escapedPath = join(dirname(record.task_dir), 'escaped-return.json')
  record.return_path = escapedPath
  assert.throws(
    () => writeBlockedReturn(record, 'boom'),
    new RegExp(RETURN_PATH_ESCAPES_TASK_DIR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  assert.ok(!existsSync(escapedPath), 'the envelope must not be written on refusal')
})

// ---------------------------------------------------------------------------
// MF5: reason sanitize — both directly on the helper and end-to-end through
// writeBlockedReturn's guaranteed-valid markdown envelope.
// ---------------------------------------------------------------------------

test('sanitizeReasonForMarkdown: collapses embedded newlines to "; "', () => {
  assert.equal(sanitizeReasonForMarkdown('boom\nmore\r\nmore still'), 'boom; more; more still')
})

test('sanitizeReasonForMarkdown: strips a leading fence run', () => {
  assert.equal(sanitizeReasonForMarkdown('```oops'), 'oops')
  assert.equal(sanitizeReasonForMarkdown('~~~~ tilde fence'), ' tilde fence')
})

test('MF5: a newline+fence-poisoned reason still produces a ladder-valid markdown envelope', () => {
  const record = buildTestRecord('build-validator')
  const path = writeBlockedReturn(record, 'boom\n```\nnot a real verdict')
  const text = readFileSync(path, 'utf8')
  const result = validateReturn(record, text)
  assert.deepEqual(result.violations, [])
  assert.equal(result.ok, true)
  assert.match(result.envelope.body, /^status: blocked - /)
  assert.match(result.envelope.body, /## Verdict/)
  const fenceMatch = result.envelope.body.match(/```json\n([\s\S]*?)\n```/)
  assert.ok(fenceMatch, 'expected exactly one fenced json block in the written body')
  assert.deepEqual(JSON.parse(fenceMatch[1]), { verdict: 'inconclusive', findings: [] })
})

// ---------------------------------------------------------------------------
// SF2: verdict-block counting is json-tagged-only once more than one fenced
// block is present in the Verdict section. Positive first.
// ---------------------------------------------------------------------------

test('positive: one ```json verdict block plus one ```ts illustrative block lints CLEAN', () => {
  const record = buildTestRecord('build-validator')
  const verdict = JSON.stringify({ verdict: 'pass', findings: [] })
  const body = `## Verdict\n\n\`\`\`json\n${verdict}\n\`\`\`\n\n\`\`\`ts\nconst x: number = 1\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.deepEqual(lintReturn(record), [])
})

test('negative: two ```json blocks in the Verdict section is still verdict_block_multiple', () => {
  const record = buildTestRecord('build-validator')
  const one = JSON.stringify({ verdict: 'pass', findings: [] })
  const body = `## Verdict\n\n\`\`\`json\n${one}\n\`\`\`\n\n\`\`\`json\n${one}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_MULTIPLE))
})

test('positive: one untagged fenced block still passes (fallback when nothing is json-tagged)', () => {
  const record = buildTestRecord('build-validator')
  writeReturnFile(record, envelopeText(record, validVerdictMarkdown()).replace('```json', '```'))
  assert.deepEqual(lintReturn(record), [])
})

test('negative: two untagged fenced blocks (none json-tagged) still falls back to verdict_block_multiple', () => {
  const record = buildTestRecord('build-validator')
  const one = JSON.stringify({ verdict: 'pass', findings: [] })
  const body = `## Verdict\n\n\`\`\`\n${one}\n\`\`\`\n\n\`\`\`\n${one}\n\`\`\`\n`
  writeReturnFile(record, envelopeText(record, body))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_MULTIPLE))
})

// ---------------------------------------------------------------------------
// verdictBlockViolations gating: a role without verdict_block is untouched.
// ---------------------------------------------------------------------------

test('positive: a role without verdict_block is untouched by verdictBlockViolations (no Verdict section at all)', () => {
  const record = buildTestRecord('plan-reviewer')
  assert.equal(record.return.verdict_block, false)
  const body = '## Must Fix\n\nnone\n\n## Should Fix\n\nnone\n'
  writeReturnFile(record, envelopeText(record, body))
  assert.deepEqual(lintReturn(record), [])
})

test('positive: flipping verdict_block false suppresses verdict_block_missing for the same body', () => {
  const record = buildTestRecord('build-validator')
  const body = '## Verdict\n\nprose only, no fenced block\n'
  writeReturnFile(record, envelopeText(record, body))
  assert.ok(keywords(lintReturn(record)).includes(VERDICT_BLOCK_MISSING))
  record.return.verdict_block = false
  assert.deepEqual(lintReturn(record), [])
})

// ---------------------------------------------------------------------------
// SF7: writeBlockedReturn never clobbers a fresh, valid, non-blocked return
// already sitting at return_path.
// ---------------------------------------------------------------------------

test('SF7: a fresh valid done return already at return_path is not overwritten', () => {
  const record = buildTestRecord('coder')
  const doneText = envelopeText(record, { status: 'done', reason: 'already finished' })
  writeReturnFile(record, doneText)
  const path = writeBlockedReturn(record, 'stale blocked write racing behind a real return')
  assert.equal(path, record.return_path)
  const onDiskText = readFileSync(record.return_path, 'utf8')
  assert.equal(onDiskText, doneText, 'on-disk bytes must be unchanged')
  const result = validateReturn(record, onDiskText)
  assert.equal(result.ok, true)
  assert.equal(result.envelope.body.status, 'done')
})

test('SF7: with no return present, writeBlockedReturn writes the blocked envelope as before', () => {
  const record = buildTestRecord('coder')
  const path = writeBlockedReturn(record, 'no prior return')
  const result = validateReturn(record, readFileSync(path, 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.envelope.body.status, 'blocked')
})

// ---------------------------------------------------------------------------
// CLI usage/refusal surface (exit 2, never 0 or 1).
// ---------------------------------------------------------------------------

test('CLI: missing record-path argument is a usage error (exit 2)', () => {
  const { code, stderr } = captureStdio(() => main([]))
  assert.equal(code, 2)
  assert.match(stderr, new RegExp(USAGE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('CLI: conflicting flags is a usage error (exit 2)', () => {
  const record = buildTestRecord('coder')
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code } = captureStdio(() => main(['--block-json', '--write-blocked', recordPath]))
  assert.equal(code, 2)
})

test('CLI: an unreadable record path is a usage error (exit 2)', () => {
  const { code, stderr } = captureStdio(() => main([join(tmpdir(), 'return-lint-does-not-exist.json')]))
  assert.equal(code, 2)
  assert.match(stderr, new RegExp(RECORD_UNREADABLE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('CLI: a record failing dispatch-record.schema.json is a usage error (exit 2)', () => {
  const dir = makeTmpDir('return-lint-invalid-')
  const recordPath = join(dir, 'record.json')
  writeFileSync(recordPath, JSON.stringify({ schema_version: 1 }))
  const { code, stderr } = captureStdio(() => main([recordPath]))
  assert.equal(code, 2)
  assert.match(stderr, new RegExp(RECORD_INVALID_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('CLI: --block-json prints the JSON.stringify-built block decision and exits 1 for an invalid return', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, PLACEHOLDER_TEXT)
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code, stdout } = captureStdio(() => main(['--block-json', recordPath]))
  assert.equal(code, 1)
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.decision, 'block')
  assert.match(parsed.reason, /invalid_json/)
})

test('CLI: --write-blocked writes a valid blocked envelope and prints its path (exit 0)', () => {
  const record = buildTestRecord('coder')
  writeReturnFile(record, PLACEHOLDER_TEXT)
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code, stdout } = captureStdio(() => main(['--write-blocked', recordPath]))
  assert.equal(code, 0)
  assert.equal(stdout.trim(), record.return_path)
  const result = validateReturn(record, readFileSync(record.return_path, 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.envelope.body.status, 'blocked')
})

test('CLI: base form reports one FAIL line per violation plus a summary line, exit 1', () => {
  const record = buildTestRecord('coder')
  const recordPath = join(dirname(record.return_path), '..', 'record.json')
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record))
  const { code, stdout } = captureStdio(() => main([recordPath]))
  assert.equal(code, 1)
  const lines = stdout.trim().split('\n')
  assert.ok(lines[0].startsWith('FAIL '))
  assert.match(lines[lines.length - 1], /FAIL \(\d+ violation/)
})
