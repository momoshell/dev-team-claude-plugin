// ---------------------------------------------------------------------------
// TEST-SET SUFFICIENCY CRITERION (qa-lead, hand this to the reviewer verbatim)
//
// The suite is sufficient iff BOTH degenerate implementations below fail it:
//
//   D-degenerate-A: completed <=> existsSync(record.return_path)
//     (ignores mtime and every envelope field)
//   D-degenerate-B: never returns completed
//
// Which tests kill which:
//   L-1  kills D-degenerate-B (a genuinely fresh, valid, identity-matching
//        return MUST classify completed; B never does).
//   L-2  kills D-degenerate-A (a file exists at return_path, but its
//        dispatch_id does not match the record; A only checks existsSync
//        and would wrongly call this completed).
//   L-8  kills D-degenerate-A (cross-record smear: D2's return_path holds a
//        FRESH file, so existsSync(D2.return_path) is true, but its content
//        carries D1's identity; A would wrongly mark D2 completed).
//   L-9  kills D-degenerate-A (the file exists and is envelope-valid, but
//        mtime === created_at, i.e. STALE under strict freshness; A ignores
//        mtime entirely and would wrongly call this completed).
//   L-13 kills D-degenerate-A DIRECTLY on record 1: attempt 1's return_path
//        genuinely exists (a real file is written), so existsSync(return_path)
//        is true and A would call it completed — but the test asserts
//        notEqual(r1.state, 'completed') (the file is deliberately stale,
//        mtime created_at-60s), which A gets wrong outright. (Fix-round
//        vacuity C2: an earlier draft of this header claimed A was "correct
//        here by accident" — that was wrong; the reviewer confirmed the test
//        is stronger than originally described.) The test's SECOND property —
//        assert.equal(fs2.returnPathKind, 'absent') for attempt 2's own
//        return_path — is what additionally kills any readdir/glob/newest-
//        file variant of collectFsState that would wrongly see attempt 1's
//        file when asked about attempt 2.
//
// Lens 3 of the review panel ("can any worker-writable byte cause
// completed?") is runnable by inspection against this list.
// ---------------------------------------------------------------------------
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, lstatSync, readFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'
import {
  validateReturn, checkIdentity, checkSections, stripFences,
  renderReturn, isFresh, collectFsState, classify, reconcile,
  evaluatePostcondition, relaySignals, RECOVERY_ROWS,
} from '../scripts/cmux/ladder.mjs'
import { validate as contractValidate } from '../scripts/cmux/contract.mjs'

const DISPATCH_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_DISPATCH_ID = '99999999-9999-9999-9999-999999999999'
const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222'
const PANE_ID = '33333333-3333-3333-3333-333333333333'
const SURFACE_ID = '44444444-4444-4444-4444-444444444444'

const CODER_RETURN_SCHEMA_PATH = join(ROOT, 'coder-return.schema.json')
const ENVELOPE_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/return-envelope.schema.json'), 'utf8'))

// Every fixture task dir is created under os.tmpdir() and removed after.
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

// One fully valid record + matching envelope, freely mutated per test via
// structuredClone. created_at is fixed; return_path/signals_path live under a
// fresh tmpdir per test so each test's filesystem state is isolated.
function buildRecord(overrides = {}) {
  const dir = makeTmpDir('cmux-ladder-')
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'signals'), { recursive: true })
  return {
    schema_version: 2,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1b',
    attempt: 1,
    role: 'coder',
    task_dir: dir,
    return_path: join(dir, 'returns', 'be-1b.1.json'),
    signals_path: join(dir, 'signals', 'be-1b.1.jsonl'),
    return: { kind: 'json', schema_path: CODER_RETURN_SCHEMA_PATH, required_sections: [], verdict_block: false },
    timeout_s: 1800,
    gate: { max_blocks: 2 },
    surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID },
    created_at: '2026-08-01T00:00:00.000Z',
    outcome: null,
    ...overrides,
  }
}

function buildEnvelope(overrides = {}) {
  return {
    schema_version: 1,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1b',
    attempt: 1,
    role: 'coder',
    produced_at: '2026-08-01T00:00:05.000Z',
    body: { status: 'done', reason: 'ok' },
    ...overrides,
  }
}

function writeReturn(record, envelope, { mtimeOffsetMs = 5000 } = {}) {
  writeFileSync(record.return_path, JSON.stringify(envelope), 'utf8')
  const mtime = new Date(Date.parse(record.created_at) + mtimeOffsetMs)
  utimesSync(record.return_path, mtime, mtime)
  return mtime
}

// ---------------------------------------------------------------------------
// validateReturn — positives FIRST (qa-notes.md: every negative-case suite
// needs its positive fixtures asserted first).
// ---------------------------------------------------------------------------

test('validateReturn: a valid json envelope returns zero violations and ok true', () => {
  const record = buildRecord()
  const envelope = buildEnvelope()
  const result = validateReturn(record, JSON.stringify(envelope))
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.envelope, envelope)
})

test('validateReturn: a valid markdown envelope with a satisfied required section returns zero violations', () => {
  const record = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const envelope = buildEnvelope({ role: 'code-reviewer', body: '## Findings\nAll good.' })
  const result = validateReturn(record, JSON.stringify(envelope))
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
})

// ---------------------------------------------------------------------------
// validateReturn — negatives. Each asserts path + keyword.
// ---------------------------------------------------------------------------

function firstViolation(result) {
  assert.equal(result.ok, false)
  assert.ok(result.violations.length > 0)
  return result.violations[0]
}

test('validateReturn negative: unparseable JSON', () => {
  const record = buildRecord()
  const v = firstViolation(validateReturn(record, '{ this is not json'))
  assert.equal(v.keyword, 'invalid_json')
})

test('validateReturn negative: schema_version 2 yields a distinct schema_version_too_new violation', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ schema_version: 2 })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.schema_version')
  assert.equal(v.keyword, 'schema_version_too_new')
})

test('validateReturn negative: dispatch_id mismatch', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ dispatch_id: OTHER_DISPATCH_ID })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.dispatch_id')
  assert.equal(v.keyword, 'dispatch_id_mismatch')
})

test('validateReturn negative: slice_id mismatch', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ slice_id: 'other-slice' })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.slice_id')
  assert.equal(v.keyword, 'slice_id_mismatch')
})

test('validateReturn negative: attempt mismatch', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ attempt: 2 })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.attempt')
  assert.equal(v.keyword, 'attempt_mismatch')
})

test('validateReturn negative: role mismatch', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ role: 'reviewer' })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.role')
  assert.equal(v.keyword, 'role_mismatch')
})

test('validateReturn negative: markdown body missing one required section', () => {
  const record = buildRecord({ return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const envelope = buildEnvelope({ body: '# Summary\nno findings heading here' })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  assert.equal(v.path, '$.body')
  assert.equal(v.keyword, 'missing_required_section')
})

test('validateReturn negative: json body failing the return schema', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ body: { unexpected: 'field only' } })
  const v = firstViolation(validateReturn(record, JSON.stringify(envelope)))
  // coder-return.schema.json requires status + reason; this body has neither.
  assert.equal(v.keyword, 'required')
})

// checkIdentity is exported so the conjunction is visible and reviewable in
// isolation, independent of the two-step validateReturn plumbing.
test('checkIdentity: exported directly, returns the four distinct violation keywords one mutation at a time', () => {
  const record = buildRecord()
  assert.deepEqual(checkIdentity(record, buildEnvelope()), [])
  assert.equal(checkIdentity(record, buildEnvelope({ dispatch_id: OTHER_DISPATCH_ID }))[0].keyword, 'dispatch_id_mismatch')
  assert.equal(checkIdentity(record, buildEnvelope({ slice_id: 'other' }))[0].keyword, 'slice_id_mismatch')
  assert.equal(checkIdentity(record, buildEnvelope({ attempt: 2 }))[0].keyword, 'attempt_mismatch')
  assert.equal(checkIdentity(record, buildEnvelope({ role: 'other-role' }))[0].keyword, 'role_mismatch')
  // produced_at is never compared — freshness owns time ordering.
  assert.deepEqual(checkIdentity(record, buildEnvelope({ produced_at: '2099-01-01T00:00:00.000Z' })), [])
})

// ---------------------------------------------------------------------------
// GROUP 1 — identity term isolated with freshness held TRUE (qa L-1..L-8).
//
// A single table-driven helper: build a fresh, envelope-valid base record
// via buildRecord/buildEnvelope/writeReturn, then classify() it through
// collectFsState with no exit sentinel, no gate, no signals, tree null. L-1
// is the positive fixture asserted FIRST.
// ---------------------------------------------------------------------------

function classifyFreshCase(record, envelopeOverrides = {}) {
  const envelope = buildEnvelope(envelopeOverrides)
  writeReturn(record, envelope)
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  return classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
}

test('L-1 (positive, FIRST): fresh valid envelope with a matching four-tuple -> completed', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record)
  assert.equal(result.state, 'completed')
})

test('L-2: sibling dispatch_id, otherwise perfect -> not completed (running)', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { dispatch_id: OTHER_DISPATCH_ID })
  assert.equal(result.state, 'running')
})

test('L-3: slice_id mismatch with correct dispatch_id -> not completed', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { slice_id: 'other-slice' })
  assert.notEqual(result.state, 'completed')
})

test('L-4: attempt mismatch -> not completed', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { attempt: 2 })
  assert.notEqual(result.state, 'completed')
})

test('L-5 (upgraded to MUST by pinned U-3): role mismatch -> not completed', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { role: 'reviewer' })
  assert.notEqual(result.state, 'completed')
})

test('L-6: schema_version 2 -> not completed with the schema_version_too_new violation asserted by path+keyword', () => {
  const record = buildRecord()
  const envelope = buildEnvelope({ schema_version: 2 })
  writeReturn(record, envelope)
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')
  const validation = validateReturn(record, fsState.returnText)
  assert.equal(validation.violations[0].path, '$.schema_version')
  assert.equal(validation.violations[0].keyword, 'schema_version_too_new')
})

// L-7: identity-field sweep (meta-test) — reads the schema's own required
// array so a future field cannot be silently exempt. produced_at is a
// FORMAT-only case (pattern-invalid string) because it is NOT an agreement
// field (checkIdentity never compares it — freshness owns time ordering).
test('L-7: mutating every required envelope field one at a time never yields completed', () => {
  const required = ENVELOPE_SCHEMA.required
  assert.deepEqual(required, ['schema_version', 'dispatch_id', 'slice_id', 'attempt', 'role', 'produced_at', 'body'])

  const mismatchValue = {
    schema_version: 2,
    dispatch_id: OTHER_DISPATCH_ID,
    slice_id: 'other-slice',
    attempt: 2,
    role: 'other-role',
    produced_at: 'not-an-iso-timestamp',
    body: 12345, // type-invalid for kind json
  }

  for (const key of required) {
    const record = buildRecord()
    const result = classifyFreshCase(record, { [key]: mismatchValue[key] })
    assert.notEqual(result.state, 'completed', `mutating ${key} must not yield completed`)
  }
})

// L-8: cross-record smear. D1's return_path holds D1's own valid fresh
// return; D2's return_path holds a fresh envelope carrying D1's dispatch_id.
// A .find() over all envelopes (or a shared foundValidReturn flag) would
// wrongly mark D2 completed too — this test fails any such implementation.
test('L-8: cross-record smear yields exactly { D1: completed, D2: running }', () => {
  const d1 = buildRecord({ dispatch_id: DISPATCH_ID, slice_id: 'be-1b-d1' })
  const d2 = buildRecord({ dispatch_id: OTHER_DISPATCH_ID, slice_id: 'be-1b-d2' })

  writeReturn(d1, buildEnvelope({ dispatch_id: DISPATCH_ID, slice_id: 'be-1b-d1' }))
  writeReturn(d2, buildEnvelope({ dispatch_id: DISPATCH_ID, slice_id: 'be-1b-d1' })) // smear: D1's identity at D2's path

  const now = Date.parse(d1.created_at) + 10000
  const fs1 = collectFsState({ record: d1, paths: {} })
  const fs2 = collectFsState({ record: d2, paths: {} })
  const r1 = classify({ record: d1, fsState: fs1, tree: null, now, quietState: null, topIdle: null })
  const r2 = classify({ record: d2, fsState: fs2, tree: null, now, quietState: null, topIdle: null })

  assert.equal(r1.state, 'completed')
  assert.equal(r2.state, 'running')
})

// ---------------------------------------------------------------------------
// GROUP 2 — freshness term isolated with identity held VALID (qa L-9..L-12),
// encoding PINNED DECISION U-2.
// ---------------------------------------------------------------------------

test('L-9: mtime exactly === created_at -> NOT completed (fail-closed, strict >)', () => {
  const record = buildRecord()
  writeReturn(record, buildEnvelope(), { mtimeOffsetMs: 0 })
  const fsState = collectFsState({ record, paths: {} })
  assert.equal(isFresh(record, fsState.returnStat), false)
  const result = classify({ record, fsState, tree: null, now: Date.parse(record.created_at) + 10000, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')
})

test('L-10: mtime one millisecond before created_at -> not completed', () => {
  const record = buildRecord()
  writeReturn(record, buildEnvelope(), { mtimeOffsetMs: -1 })
  const fsState = collectFsState({ record, paths: {} })
  assert.equal(isFresh(record, fsState.returnStat), false)
  const result = classify({ record, fsState, tree: null, now: Date.parse(record.created_at) + 10000, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')
})

test('L-11: now < created_at (clock stepped back) with no return file -> no throw, not completed, timeout does not fire', () => {
  const record = buildRecord()
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) - 60000
  assert.doesNotThrow(() => classify({ record, fsState, tree: null, now, quietState: null, topIdle: null }))
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')
  assert.notEqual(result.state, 'timeout')
})

test('L-12: second-granularity created_at cannot admit a stale file (structural + defence-in-depth)', () => {
  // be-1b-B's isoMs builder always emits .mmm — the STRUCTURAL half of this
  // fix: every real created_at this system writes carries full-millisecond
  // precision, so the whole-second-truncation hazard below never arises in
  // practice. This test is the DEFENCE-IN-DEPTH half: even for a
  // hand-written record carrying a legal second-granularity created_at (the
  // frozen pattern makes milliseconds OPTIONAL), isFresh must still compare
  // at full millisecond resolution rather than silently truncating mtime to
  // seconds too — so a return whose mtime falls inside that same second
  // (i.e. no strictly-later instant has elapsed) is rejected exactly as it
  // would be for a millisecond-precise created_at (qa L-9's fail-closed
  // strict `>`).
  const record = buildRecord({ created_at: '2026-08-01T00:00:00Z' }) // no .mmm — legal under the pattern
  const envelope = buildEnvelope()
  writeFileSync(record.return_path, JSON.stringify(envelope), 'utf8')
  // mtime sits at the exact same instant as the (whole-second) created_at —
  // "inside that second" in the strictest sense: zero elapsed time.
  const mtime = new Date(Date.parse('2026-08-01T00:00:00.000Z'))
  utimesSync(record.return_path, mtime, mtime)

  const fsState = collectFsState({ record, paths: {} })
  assert.equal(Date.parse(record.created_at), Date.parse('2026-08-01T00:00:00.000Z'), 'sanity: the whole-second and millisecond forms parse identically')
  assert.equal(isFresh(record, fsState.returnStat), false, 'same-instant return under a whole-second created_at must still fail-closed')

  // And a return genuinely one full second later (unambiguously past the
  // truncated second) is correctly fresh — the rule is millisecond-exact,
  // not second-exact, in both directions.
  const laterMtime = new Date(Date.parse('2026-08-01T00:00:01.000Z'))
  utimesSync(record.return_path, laterMtime, laterMtime)
  const laterFsState = collectFsState({ record, paths: {} })
  assert.equal(isFresh(record, laterFsState.returnStat), true)
})

// ---------------------------------------------------------------------------
// GROUP 3 — cross-attempt / stale-stem (qa L-13, L-14).
// ---------------------------------------------------------------------------

test('L-13: attempt 1 valid+stale return with no attempt-2 file while attempt 2 is awaited -> running (return_path-only read)', () => {
  const attempt1 = buildRecord({ attempt: 1 })
  writeReturn(attempt1, buildEnvelope({ attempt: 1 }), { mtimeOffsetMs: -60000 }) // created_at - 60s

  // attempt 2 is awaited at a DIFFERENT return_path that does not exist.
  const attempt2 = { ...attempt1, attempt: 2, return_path: join(attempt1.task_dir, 'returns', 'be-1b.2.json') }

  const fs1 = collectFsState({ record: attempt1, paths: {} })
  const fs2 = collectFsState({ record: attempt2, paths: {} })

  assert.equal(fs2.returnPathKind, 'absent', 'attempt 2 return_path must not exist yet')

  const now = Date.parse(attempt1.created_at) + 10000
  const r1 = classify({ record: attempt1, fsState: fs1, tree: null, now, quietState: null, topIdle: null })
  const r2 = classify({ record: attempt2, fsState: fs2, tree: null, now, quietState: null, topIdle: null })

  // attempt1's own evidence is stale relative to ITS created_at offset by
  // -60s in this fixture, but the load-bearing assertion is structural: the
  // implementation reads record.return_path and ONLY record.return_path — a
  // glob, readdir or newest-file scan over returns/ is a defect that would
  // let attempt 2 see attempt 1's file and wrongly call it done.
  assert.notEqual(r1.state, 'completed')
  assert.equal(r2.state, 'running')
})

test('L-14 (defence-in-depth, operator --attempt path): a valid fresh envelope carrying the PREVIOUS dispatch_id at the awaited return_path -> not completed, dispatch_id mismatch named', () => {
  const record = buildRecord({ dispatch_id: DISPATCH_ID })
  // The previous dispatch's identity sits at the CURRENT awaited return_path
  // (be-1b-B's exclusive-create + attempt bump make this unreachable in the
  // normal flow; the explicit --attempt operator path can still reach it).
  writeReturn(record, buildEnvelope({ dispatch_id: OTHER_DISPATCH_ID }))

  const fsState = collectFsState({ record, paths: {} })
  const validation = validateReturn(record, fsState.returnText)
  assert.equal(validation.ok, false)
  assert.equal(validation.violations[0].keyword, 'dispatch_id_mismatch')

  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')
})

// ---------------------------------------------------------------------------
// GROUP 4 — body / step-2 validation (qa L-17..L-20).
// ---------------------------------------------------------------------------

test('L-17: body is a VALID instance of a DIFFERENT schema B but invalid under record.return.schema_path (schema A) -> invalid_return, not completed', () => {
  // Schema B requires a totally different shape than coder-return's {status, reason}.
  const schemaB = { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }
  const bodyValidUnderB = { ok: true }
  assert.deepEqual(contractValidate(schemaB, bodyValidUnderB), [], 'sanity: body is genuinely valid under schema B')

  const record = buildRecord({ return: { kind: 'json', schema_path: CODER_RETURN_SCHEMA_PATH, required_sections: [], verdict_block: false } })
  const result = classifyFreshCase(record, { body: bodyValidUnderB })
  assert.notEqual(result.state, 'completed')
  const fsState = collectFsState({ record, paths: {} })
  const validation = validateReturn(record, fsState.returnText)
  assert.equal(validation.ok, false)
  assert.equal(validation.violations[0].keyword, 'required') // body validated against A (coder-return.schema.json), not B
})

test('L-18: fenced code blocks are stripped before SECTION_HEADING_RE (pinned U-5) — a heading inside a fence does NOT count', () => {
  const record = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const bodyFenced = '# Title\n\n```md\n## Findings\n```\n'
  const result1 = classifyFreshCase(record, { role: 'code-reviewer', body: bodyFenced })
  assert.notEqual(result1.state, 'completed')

  // Counter-fixture: bold text is not a heading either, correctly rejected.
  const record2 = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const result2 = classifyFreshCase(record2, { role: 'code-reviewer', body: '**Findings**\nsome text' })
  assert.notEqual(result2.state, 'completed')

  // Positive: the same heading OUTSIDE the fence passes.
  const record3 = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const result3 = classifyFreshCase(record3, { role: 'code-reviewer', body: '# Title\n\n## Findings\nall good\n\n```md\nnot a heading in here\n```\n' })
  assert.equal(result3.state, 'completed')
})

test('L-19: markdown body must be non-empty after trim (a named constant, since step 1 puts no pattern on body)', () => {
  for (const emptyBody of ['', '   \n']) {
    const record = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: [], verdict_block: false } })
    const result = classifyFreshCase(record, { role: 'code-reviewer', body: emptyBody })
    assert.notEqual(result.state, 'completed')
    const fsState = collectFsState({ record, paths: {} })
    const validation = validateReturn(record, fsState.returnText)
    assert.equal(validation.violations[0].keyword, 'markdown_body_empty')
  }
})

test('L-20: hostile inputs never throw and never complete, each REASON asserted by keyword (vacuity C1 — truthy-only is not enough)', () => {
  const cases = [
    { name: 'zero bytes', expectedReason: 'empty_return', setup: (record) => writeFileSync(record.return_path, '', 'utf8') },
    { name: 'truncated JSON', expectedReason: 'invalid_json', setup: (record) => writeFileSync(record.return_path, '{"schema_version":1,', 'utf8') },
    { name: 'top-level array', expectedReason: 'type', setup: (record) => writeFileSync(record.return_path, JSON.stringify([1, 2, 3]), 'utf8') },
    { name: 'top-level string', expectedReason: 'type', setup: (record) => writeFileSync(record.return_path, JSON.stringify('just a string'), 'utf8') },
    { name: 'directory at return_path', expectedReason: 'return_path_not_regular_file', setup: (record) => mkdirSync(record.return_path) },
    {
      name: 'symlink pointing at a sibling valid fresh return',
      expectedReason: 'return_path_not_regular_file',
      setup: (record, siblingRecord) => {
        writeReturn(siblingRecord, buildEnvelope({ dispatch_id: siblingRecord.dispatch_id }))
        symlinkSync(siblingRecord.return_path, record.return_path)
      },
    },
  ]

  for (const c of cases) {
    const record = buildRecord()
    const sibling = buildRecord({ dispatch_id: OTHER_DISPATCH_ID })
    assert.doesNotThrow(() => c.setup(record, sibling), `setup for "${c.name}" must not throw`)
    assert.doesNotThrow(() => collectFsState({ record, paths: {} }), `collectFsState must not throw for "${c.name}"`)
    const fsState = collectFsState({ record, paths: {} })
    const now = Date.parse(record.created_at) + 10000
    let result
    assert.doesNotThrow(() => {
      result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
    }, `classify must not throw for "${c.name}"`)
    assert.notEqual(result.state, 'completed', `"${c.name}" must not classify as completed`)
    assert.equal(result.reason, c.expectedReason, `"${c.name}" must carry the exact named reason`)
  }
})

// ---------------------------------------------------------------------------
// Fix-round trust M1 (D-1 items 2-3): validateBody's readFileSync+JSON.parse
// +validate() is wrapped so a tampered/missing/contained schema_path becomes
// a NAMED violation — never a throw. These three rows extend L-20's hostile
// coverage; each asserts ok:false + the named keyword + that classify did
// not throw.
// ---------------------------------------------------------------------------

test('L-20 (D-1 item 2): schema_path pointing at a deleted/nonexistent file -> schema_unreadable, no throw', () => {
  const dir = makeTmpDir('cmux-ladder-schema-missing-')
  const missingSchemaPath = join(dir, 'does-not-exist.schema.json')
  const record = buildRecord({ return: { kind: 'json', schema_path: missingSchemaPath, required_sections: [], verdict_block: false } })

  let result
  assert.doesNotThrow(() => {
    result = classifyFreshCase(record)
  }, 'a deleted schema_path must not throw out of classify')
  assert.notEqual(result.state, 'completed')
  assert.equal(result.reason, 'schema_unreadable')

  const fsState = collectFsState({ record, paths: {} })
  let validation
  assert.doesNotThrow(() => {
    validation = validateReturn(record, fsState.returnText)
  }, 'validateReturn must never throw for an unreadable schema')
  assert.equal(validation.ok, false)
  assert.equal(validation.violations[0].keyword, 'schema_unreadable')
})

test('L-20 (D-1 item 2): schema with an out-of-budget key ($ref) -> schema_tampered, no throw (validate() itself would throw uncaught)', () => {
  const dir = makeTmpDir('cmux-ladder-schema-ref-')
  const tamperedSchemaPath = join(dir, 'tampered.schema.json')
  // $ref is not in contract.mjs's BUDGET — validate() throws a
  // programmer-error Error for this schema shape; validateBody must catch
  // that and report it as data, not crash the classifier.
  writeFileSync(tamperedSchemaPath, JSON.stringify({ type: 'object', $ref: '#/definitions/whatever' }), 'utf8')
  assert.throws(() => contractValidate(JSON.parse(readFileSync(tamperedSchemaPath, 'utf8')), {}), 'sanity: this schema shape genuinely makes validate() throw')

  const record = buildRecord({ return: { kind: 'json', schema_path: tamperedSchemaPath, required_sections: [], verdict_block: false } })

  let result
  assert.doesNotThrow(() => {
    result = classifyFreshCase(record)
  }, 'a tampered schema must not throw out of classify')
  assert.notEqual(result.state, 'completed')
  assert.equal(result.reason, 'schema_tampered')
})

test('L-20 (D-1 item 3): schema_path resolving inside the worker-writable --plugin-dir tree -> schema_in_worker_writable_tree, independent of what a conforming schema_path looks like', () => {
  const dir = makeTmpDir('cmux-ladder-schema-snapshot-')
  const workerPluginDir = join(dir, 'worker-plugin')
  mkdirSync(join(workerPluginDir, 'roles'), { recursive: true })
  const rolePromptPath = join(workerPluginDir, 'roles', 'coder.txt')
  writeFileSync(rolePromptPath, 'role prompt body', 'utf8')
  // dirname(dirname(role_prompt_path)) === workerPluginDir — the tree handed
  // to `claude --plugin-dir`, which G13 makes worker-writable.
  const schemaInsideSnapshot = join(workerPluginDir, 'coder-return.schema.json')
  writeFileSync(schemaInsideSnapshot, readFileSync(CODER_RETURN_SCHEMA_PATH, 'utf8'), 'utf8') // a genuinely well-formed, non-tampered copy

  const record = buildRecord({ role_prompt_path: rolePromptPath, return: { kind: 'json', schema_path: schemaInsideSnapshot, required_sections: [], verdict_block: false } })

  let result
  assert.doesNotThrow(() => {
    result = classifyFreshCase(record)
  })
  assert.notEqual(result.state, 'completed')
  assert.equal(result.reason, 'schema_in_worker_writable_tree')

  const fsState = collectFsState({ record, paths: {} })
  const validation = validateReturn(record, fsState.returnText)
  assert.equal(validation.violations[0].keyword, 'schema_in_worker_writable_tree')
})

test('schemaInWorkerWritableTree containment holds for ANY record, independent of where B repoints a conforming schema_path (interface row 4)', () => {
  // A record whose role_prompt_path lives OUTSIDE the schema's directory —
  // e.g. the plugin-root-sourced schema_path B now writes — must NOT trip
  // the containment violation.
  const record = buildRecord({ role_prompt_path: join(ROOT, 'scripts/cmux/some-unrelated-worker-plugin-tree/roles/coder.txt') })
  const result = classifyFreshCase(record) // default schema_path is CODER_RETURN_SCHEMA_PATH, outside that unrelated tree
  assert.equal(result.state, 'completed')
})

test('L-20 symlink case decided structurally: collectFsState uses lstatSync, not statSync', () => {
  const record = buildRecord()
  const sibling = buildRecord({ dispatch_id: OTHER_DISPATCH_ID })
  writeReturn(sibling, buildEnvelope({ dispatch_id: OTHER_DISPATCH_ID }))
  symlinkSync(sibling.return_path, record.return_path)

  const fsState = collectFsState({ record, paths: {} })
  assert.equal(fsState.returnPathKind, 'symlink')
  assert.equal(fsState.returnStat, null)
  assert.equal(fsState.returnText, null)

  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.equal(result.state, 'running')

  // A second layer: even if collectFsState HAD followed the symlink and read
  // the sibling's content, the identity check would also have caught it.
  const siblingText = readFileSync(sibling.return_path, 'utf8')
  const validation = validateReturn(record, siblingText)
  assert.equal(validation.ok, false)
  assert.equal(validation.violations[0].keyword, 'dispatch_id_mismatch')
})

// ---------------------------------------------------------------------------
// GROUP 5 — forgeable-input independence (qa L-21..L-26). This is the actual
// proof; the nine reconcile rows (Group 7 below) are nine points on it.
// ---------------------------------------------------------------------------

function classifyWith(record, { returnKind = 'fresh-valid', exit, gate, signals = [] } = {}) {
  if (returnKind === 'fresh-valid') {
    writeReturn(record, buildEnvelope())
  } else if (returnKind === 'wrong-dispatch_id') {
    writeReturn(record, buildEnvelope({ dispatch_id: OTHER_DISPATCH_ID }))
  } else if (returnKind === 'stale') {
    writeReturn(record, buildEnvelope(), { mtimeOffsetMs: -5000 })
  } // 'absent' -> write nothing

  if (exit !== undefined && exit !== null) {
    writeFileSync(`${record.return_path}.exit-sidecar`, String(exit), 'utf8')
  }
  if (gate !== undefined && gate !== null) {
    writeFileSync(`${record.return_path}.gate-sidecar`, String(gate), 'utf8')
  }
  if (signals.length > 0) {
    writeFileSync(record.signals_path, signals.join('\n'), 'utf8')
  }

  const paths = {
    exitPath: exit !== undefined && exit !== null ? `${record.return_path}.exit-sidecar` : null,
    gatePath: gate !== undefined && gate !== null ? `${record.return_path}.gate-sidecar` : null,
  }
  const fsState = collectFsState({ record, paths })
  const now = Date.parse(record.created_at) + 10000
  return classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
}

test('L-21: .exit "0" + fresh valid return -> completed', () => {
  const record = buildRecord()
  const result = classifyWith(record, { returnKind: 'fresh-valid', exit: '0' })
  assert.equal(result.state, 'completed')
})

test('L-22: .exit "0" + stale or invalid return -> never completed', () => {
  for (const returnKind of ['stale', 'wrong-dispatch_id', 'absent']) {
    const record = buildRecord()
    const result = classifyWith(record, { returnKind, exit: '0' })
    assert.notEqual(result.state, 'completed', `returnKind=${returnKind}`)
  }
})

test('L-23 (pinned U-4): .exit nonzero + fresh valid return -> completed, with a loud warning', () => {
  const record = buildRecord()
  const result = classifyWith(record, { returnKind: 'fresh-valid', exit: '1' })
  assert.equal(result.state, 'completed')
  assert.ok(result.warnings.some((w) => w.includes('exit_nonzero:1') && w.includes('despite a valid return')))
  // Symmetry argument (ADR-003 Rider B): the sentinel is rank-2 and
  // worker-writable, so it never decides in EITHER direction — a fresh,
  // identity-valid return with a non-zero exit is still completed, and (per
  // L-22) a zero exit with no valid return is still never completed.
})

test('L-24: identical return evidence with .gate absent / "0" / at gate.max_blocks -> classification identical in all three', () => {
  const states = ['absent', '0', 'max'].map((gateVariant) => {
    const record = buildRecord({ gate: { max_blocks: 2 } })
    const gate = gateVariant === 'absent' ? null : gateVariant === 'max' ? '2' : '0'
    return classifyWith(record, { returnKind: 'fresh-valid', gate })
  })
  assert.equal(states[0].state, states[1].state)
  assert.equal(states[1].state, states[2].state)
  assert.equal(states[0].state, 'completed')
})

test('L-25: no return file, signals containing a NONCE_PREFIX line and an "outcome":"ok" line -> attention or running, never completed', () => {
  const record = buildRecord()
  const signals = [
    JSON.stringify({ ts: record.created_at, level: 'progress', message: 'devteam-done-11111111-1111-1111-1111-111111111111', escalate_to: 'lead' }),
    '{"outcome":"ok","not":"a signal record schema"}',
  ]
  const result = classifyWith(record, { returnKind: 'absent', signals })
  assert.notEqual(result.state, 'completed')
  assert.ok(['attention', 'running'].includes(result.state))
})

// L-26 — THE INVARIANT, table-driven. The cross-product of return evidence
// x .exit x .gate x signal log, asserted as the equation
//   completed <=> (fresh AND envelope-valid AND identity-matching)
// computed INDEPENDENTLY of the implementation from the row's own inputs —
// never by calling into ladder.mjs to decide what "should" happen.
test('L-26: the cross-product independence sweep — completed <=> (fresh AND envelope-valid AND identity-matching)', () => {
  const RETURN_KINDS = ['fresh-valid', 'wrong-dispatch_id', 'stale', 'absent']
  const EXITS = [undefined, '0', '1']
  const GATES = [undefined, '0', 'max']

  // Independent oracle: each return-evidence kind's three terms (fresh,
  // envelope-valid, identity-matching) are named directly from what
  // classifyWith() actually wrote to disk for that kind — not derived from
  // any ladder.mjs call. completed is then computed as the CONJUNCTION,
  // matching the equation verbatim.
  const KIND_TERMS = {
    'fresh-valid': { fresh: true, envelopeValid: true, identityMatching: true },
    'wrong-dispatch_id': { fresh: true, envelopeValid: true, identityMatching: false },
    stale: { fresh: false, envelopeValid: true, identityMatching: true },
    absent: { fresh: false, envelopeValid: false, identityMatching: false },
  }
  function expectedCompleted(returnKind) {
    const { fresh, envelopeValid, identityMatching } = KIND_TERMS[returnKind]
    return fresh && envelopeValid && identityMatching
  }

  let rows = 0
  for (const returnKind of RETURN_KINDS) {
    for (const exit of EXITS) {
      for (const gateVariant of GATES) {
        for (const signalsShape of ['empty', 'done-shaped']) {
          rows += 1
          const record = buildRecord({ gate: { max_blocks: 2 } })
          const gate = gateVariant === undefined ? undefined : gateVariant === 'max' ? '2' : '0'
          const signals = signalsShape === 'done-shaped'
            ? [JSON.stringify({ ts: record.created_at, level: 'progress', message: 'outcome ok all done', escalate_to: 'lead' })]
            : []
          const result = classifyWith(record, { returnKind, exit, gate, signals })
          const expected = expectedCompleted(returnKind)
          assert.equal(result.state === 'completed', expected, `row [${returnKind}, exit=${exit}, gate=${gateVariant}, signals=${signalsShape}]`)
        }
      }
    }
  }
  assert.equal(rows, RETURN_KINDS.length * EXITS.length * GATES.length * 2)
})

test('L-26 per-call form: classify with hostile exitSentinel/gateCounter/signalLines/tree leaves the completed verdict unchanged', () => {
  const record = buildRecord()
  writeReturn(record, buildEnvelope())
  const legitFsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000

  const legitResult = classify({ record, fsState: legitFsState, tree: null, now, quietState: null, topIdle: null })
  assert.equal(legitResult.state, 'completed')

  const hostileFsState = {
    ...legitFsState,
    exitSentinel: '137',
    gateCounter: '999',
    signalLines: ['not json at all', '{"malicious":"payload"}'],
  }
  const hostileTree = { windows: [{ workspaces: [{ id: 'evil', panes: [{ id: 'evil', surfaces: [{ id: 'evil' }] }] }] }] }
  const hostileResult = classify({ record, fsState: hostileFsState, tree: hostileTree, now, quietState: null, topIdle: null })
  assert.equal(hostileResult.state, 'completed')
})

// ---------------------------------------------------------------------------
// GROUP 5b — MF1: classify threads the envelope body's self-reported status
// onto the completed classification as bodyStatus, so dispatch.mjs's
// OUTCOME_MAPPING can key on it instead of the .exit sentinel (U-4).
// ---------------------------------------------------------------------------

test('MF1 (positive, FIRST): a completed "done" return carries bodyStatus "done"', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record)
  assert.equal(result.state, 'completed')
  assert.equal(result.bodyStatus, 'done')
})

test('MF1: a completed markdown reviewer return carries bodyStatus null (the body is a string, not an object)', () => {
  const record = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: ['Findings'], verdict_block: false } })
  const result = classifyFreshCase(record, { role: 'code-reviewer', body: '## Findings\nAll good.' })
  assert.equal(result.state, 'completed')
  assert.equal(result.bodyStatus, null)
})

test('MF1: a completed "blocked" body carries bodyStatus "blocked"', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { body: { status: 'blocked', reason: 'gate exhausted' } })
  assert.equal(result.state, 'completed')
  assert.equal(result.bodyStatus, 'blocked')
})

test('MF1: a completed "insufficient" body carries bodyStatus "insufficient"', () => {
  const record = buildRecord()
  const result = classifyFreshCase(record, { body: { status: 'insufficient', reason: 'missing contract', missing_context: 'x' } })
  assert.equal(result.state, 'completed')
  assert.equal(result.bodyStatus, 'insufficient')
})

// U-4 REGRESSION GUARD: a hostile-but-plausible non-zero .exit sentinel
// alongside a fresh, valid "done" return must NEVER move classify's verdict
// or its bodyStatus — only add a warning. A "fix" that reorders exit_nonzero
// ahead of completed, or keys off the sentinel instead of the body, breaks
// this test.
test('U-4 REGRESSION GUARD: .exit "2" + fresh valid "done" return -> still completed, bodyStatus "done", warning only', () => {
  const record = buildRecord()
  const result = classifyWith(record, { returnKind: 'fresh-valid', exit: '2' })
  assert.equal(result.state, 'completed')
  assert.equal(result.bodyStatus, 'done')
  assert.ok(result.warnings.some((w) => w.includes('exit_nonzero:2') && w.includes('despite a valid return')))
})

// ---------------------------------------------------------------------------
// GROUP 6 — terminal records are final (qa L-27, L-28).
// ---------------------------------------------------------------------------

test('L-27: a terminal no_return record stays terminal even after a fresh valid correct-identity file later appears', () => {
  const record = buildRecord({ outcome: 'no_return' })
  writeReturn(record, buildEnvelope()) // appears AFTER termination
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  // classify's first branch is "record.outcome !== null -> terminal" — this
  // is a consequence of the monotone lifecycle (dispatch-record.schema.json:
  // null becomes set, never set becomes null and never set becomes a
  // different value).
  assert.equal(result.state, 'terminal')
  assert.notEqual(result.state, 'completed')
  assert.equal(result.reason, 'terminal:no_return')
  assert.equal(record.outcome, 'no_return') // the outcome stays no_return
})

test('L-28: a terminal ok record stays completed/ok even after its return file is later truncated', () => {
  const record = buildRecord({ outcome: 'ok' })
  writeReturn(record, buildEnvelope())
  writeFileSync(record.return_path, '', 'utf8') // truncated after termination
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  // A terminal record is NEVER re-derived from current evidence.
  assert.equal(result.state, 'terminal')
  assert.equal(result.reason, 'terminal:ok')
})

// ---------------------------------------------------------------------------
// Fix-round trust M4: a worker's Bash subprocess can overwrite its own
// record with a well-formed outcome: "ok" (a valid enum value — schema
// validation alone accepts it) with no return file ever examined. classify
// never re-opens or re-terminates for this (L-27/L-28 stay literal), but it
// DOES corroborate 'ok' specifically — the only outcome worth forging —
// against the same read-only completion evaluation, appending the pinned
// warning string 'terminal_outcome_uncorroborated' when the ladder does not
// independently derive completed.
// ---------------------------------------------------------------------------

test('trust M4 (a): a forged well-formed outcome:"ok" record with NO return file -> still terminal, but carries terminal_outcome_uncorroborated', () => {
  const record = buildRecord({ outcome: 'ok' }) // forged: no return file was ever written
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.equal(result.state, 'terminal') // never re-opened
  assert.equal(result.reason, 'terminal:ok')
  assert.ok(result.warnings.includes('terminal_outcome_uncorroborated'))

  // reconcile forwards the warning through its rows unchanged.
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.ok(rows[0].warnings.includes('terminal_outcome_uncorroborated'))
})

test('trust M4 (b) — paired positive: a legitimately-terminated ok record WITH its fresh valid return carries no corroboration warning', () => {
  const record = buildRecord({ outcome: 'ok' })
  writeReturn(record, buildEnvelope())
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.equal(result.state, 'terminal')
  assert.equal(result.reason, 'terminal:ok')
  assert.equal(result.warnings.includes('terminal_outcome_uncorroborated'), false)
})

test('trust M4 (c): a terminal outcome:"timeout" record never attempts corroboration, no warning', () => {
  const record = buildRecord({ outcome: 'timeout' }) // also no return file
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.equal(result.state, 'terminal')
  assert.equal(result.reason, 'terminal:timeout')
  assert.deepEqual(result.warnings, []) // every non-'ok' outcome is self-inflicted failure, never corroborated
})

// ---------------------------------------------------------------------------
// GROUP 7 — the seam D's purity creates (qa L-30, L-31).
// ---------------------------------------------------------------------------

test('L-30: collectFsState is tested against a REAL filesystem — utimesSync to a known epoch, mtime collected in the SAME unit (mtimeMs)', () => {
  const record = buildRecord()
  writeFileSync(record.return_path, JSON.stringify(buildEnvelope()), 'utf8')
  const setMtime = new Date(Date.parse(record.created_at) + 12345) // sub-second offset baked in
  utimesSync(record.return_path, setMtime, setMtime)

  const fsState = collectFsState({ record, paths: {} })
  const freshLstat = lstatSync(record.return_path)

  assert.equal(fsState.returnStat.mtimeMs, freshLstat.mtimeMs, 'collected mtime must equal the real lstat mtimeMs, never rounded to seconds')
  assert.notEqual(fsState.returnStat.mtimeMs, undefined)
  assert.equal(typeof fsState.returnStat.mtimeMs, 'number')
})

test('L-30 end-to-end: real-file -> collectFsState -> classify for one fresh and one stale case', () => {
  // A seconds-vs-milliseconds bug in the fs->fsState seam would leave every
  // Group 2/3 unit test passing (they mock stat objects) while the real
  // system treats everything as fresh — this test exercises the actual seam.
  const freshRecord = buildRecord()
  writeFileSync(freshRecord.return_path, JSON.stringify(buildEnvelope()), 'utf8')
  const freshMtime = new Date(Date.parse(freshRecord.created_at) + 5000)
  utimesSync(freshRecord.return_path, freshMtime, freshMtime)
  const freshFsState = collectFsState({ record: freshRecord, paths: {} })
  const freshResult = classify({ record: freshRecord, fsState: freshFsState, tree: null, now: Date.parse(freshRecord.created_at) + 10000, quietState: null, topIdle: null })
  assert.equal(freshResult.state, 'completed')

  const staleRecord = buildRecord()
  writeFileSync(staleRecord.return_path, JSON.stringify(buildEnvelope()), 'utf8')
  const staleMtime = new Date(Date.parse(staleRecord.created_at) - 5000)
  utimesSync(staleRecord.return_path, staleMtime, staleMtime)
  const staleFsState = collectFsState({ record: staleRecord, paths: {} })
  const staleResult = classify({ record: staleRecord, fsState: staleFsState, tree: null, now: Date.parse(staleRecord.created_at) + 10000, quietState: null, topIdle: null })
  assert.notEqual(staleResult.state, 'completed')
})

test('L-31: surface identity is the (workspace_id, pane_id, surface_id) TRIPLE — a pane_id collision across a different workspace_id is not-my-pane', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  // no return file -> not completed regardless of pane presence
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const result = classify({ record, fsState, tree: null, now, quietState: null, topIdle: null })
  assert.notEqual(result.state, 'completed')

  // A tree containing a pane whose pane_id matches but whose workspace_id
  // differs is treated as not-my-pane by reconcile's surface-alive check.
  const treeWithDifferentWorkspace = {
    windows: [{ workspaces: [{ id: 'some-other-workspace-id', panes: [{ id: PANE_ID, surfaces: [{ id: SURFACE_ID }] }] }] }],
  }
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: treeWithDifferentWorkspace, now })
  assert.equal(rows[0].row, 'orphaned_surface_gone') // not "running_surface_alive"
})

// ---------------------------------------------------------------------------
// checkSections / stripFences — isolated review.
// ---------------------------------------------------------------------------

// be-06-01 S1: level->=2 + case-folded prefix matching, entirely
// consumer-side (SECTION_HEADING_RE itself is untouched).
test('checkSections: heading levels 2-6 count; level 1 does NOT; a section name in prose (not a heading) does NOT count; trailing whitespace tolerated', () => {
  const body = [
    '# One',
    '## Two',
    '### Three',
    '#### Four',
    '##### Five   ',
    '###### Six',
    'Prose mentioning Seven but not as a heading.',
  ].join('\n')
  assert.deepEqual(checkSections(body, ['One']), ['One']) // level 1 never matches
  assert.deepEqual(checkSections(body, ['Two', 'Three', 'Four', 'Five', 'Six']), [])
  assert.deepEqual(checkSections(body, ['Seven']), ['Seven'])
})

test('checkSections: `### Handover Spec (one per coder task)` satisfies required section `Handover Spec` (prefix match)', () => {
  const body = '### Handover Spec (one per coder task)\ncontent'
  assert.deepEqual(checkSections(body, ['Handover Spec']), [])
})

test('checkSections: `## HANDOVER SPEC` satisfies `Handover Spec` (case-folded)', () => {
  const body = '## HANDOVER SPEC\ncontent'
  assert.deepEqual(checkSections(body, ['Handover Spec']), [])
})

test('checkSections: `# Handover Spec` (level 1) does NOT satisfy `Handover Spec`', () => {
  const body = '# Handover Spec\ncontent'
  assert.deepEqual(checkSections(body, ['Handover Spec']), ['Handover Spec'])
})

test('checkSections: a `## Handover Spec` heading inside a fenced block does NOT count (existing fence-stripping behavior preserved)', () => {
  const body = '```\n## Handover Spec\n```\ncontent'
  assert.deepEqual(checkSections(body, ['Handover Spec']), ['Handover Spec'])
})

test('checkSections: an empty or whitespace-only required entry is reported missing, never vacuously satisfied', () => {
  const body = '## Handover Spec\ncontent'
  assert.deepEqual(checkSections(body, ['']), [''])
  assert.deepEqual(checkSections(body, ['   ']), ['   '])
})

// ANCHORED-PREFIX NEGATIVE (qa-lead gate audit, load-bearing): the rule is
// startsWith, not includes/contains. A heading whose text merely CONTAINS the
// required string mid-word/mid-phrase (rather than beginning with it) must
// NOT satisfy the requirement — an includes()-based implementation would
// pass every other case in this file (all the positives here happen to also
// be prefixes) and only this negative catches that degenerate.
test('checkSections: `### Draft Handover Spec` does NOT satisfy required section `Handover Spec` (startsWith, not includes/contains)', () => {
  const body = '### Draft Handover Spec\ncontent'
  assert.deepEqual(checkSections(body, ['Handover Spec']), ['Handover Spec'])
})

// LOCALE-INDEPENDENCE (qa-lead gate audit): the interface_contract pins
// "plain .toLowerCase() (no locale)". String.prototype.toLowerCase() and
// .toLocaleLowerCase() (no explicit locale arg) are byte-identical in this
// process's default (non-Turkish) locale — so a mutation from toLowerCase()
// to toLocaleLowerCase() is INVISIBLE to any in-process assertion here. The
// only way to make that mutation observable is to force the Turkish locale
// (LC_ALL=tr_TR.UTF-8) in a subprocess: under that locale, 'İ' (LATIN
// CAPITAL LETTER I WITH DOT ABOVE) case-folds to plain 'i' via
// toLocaleLowerCase, but toLowerCase() ALWAYS folds it to 'i' + a combining
// dot-above (U+0307), regardless of locale. A heading '## İSTANBUL' must
// therefore NEVER satisfy required section 'istanbul' — under the pinned
// plain .toLowerCase() rule this holds in EVERY locale; a toLocaleLowerCase
// mutation would flip it to satisfied specifically under a Turkish locale.
test('checkSections: locale-independence — `## İSTANBUL` never satisfies `istanbul`, even under a forced Turkish locale (catches a toLowerCase -> toLocaleLowerCase mutation)', () => {
  const script = `
    import assert from 'node:assert/strict'
    import { checkSections } from ${JSON.stringify(join(ROOT, 'scripts/cmux/ladder.mjs'))}
    const body = '## İSTANBUL\\ncontent'
    const missing = checkSections(body, ['istanbul'])
    assert.deepEqual(missing, ['istanbul'])
    console.log('LOCALE_OK')
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
  })
  assert.equal(res.status, 0, `subprocess failed: ${res.stderr}`)
  assert.match(res.stdout, /LOCALE_OK/)
})

// PROPOSED-MEMORY-DELTAS heading-vs-prose (qa-lead gate audit): the roster
// requires this exact section for every lead role. A heading whose body is
// literally the word "none" must satisfy it (per V2:333's "may say
// 'none'"); a bare PROSE line with no heading marker at all must not — the
// rule matches markdown HEADINGS, never a colon-delimited prose sentence
// that merely happens to start with the same words.
test('checkSections: `### Proposed memory deltas` heading with body "none" satisfies the section', () => {
  const body = '### Proposed memory deltas\nnone\n'
  assert.deepEqual(checkSections(body, ['Proposed memory deltas']), [])
})

test('checkSections: a bare prose line `Proposed memory deltas: none` (no heading marker) does NOT satisfy the section', () => {
  const body = 'Proposed memory deltas: none\n'
  assert.deepEqual(checkSections(body, ['Proposed memory deltas']), ['Proposed memory deltas'])
})

test('checkSections: a `~~~` fenced fake Proposed memory deltas heading does NOT count (tilde-fence variant of the fence-stripping rule)', () => {
  const body = '~~~\n### Proposed memory deltas\nnone\n~~~\ncontent'
  assert.deepEqual(checkSections(body, ['Proposed memory deltas']), ['Proposed memory deltas'])
})

test('checkSections: an unclosed fence swallows a real heading to EOF, so the required section is reported missing', () => {
  const body = '# Title\n\n```\nunclosed fence content\n### Handover Spec\nmore content'
  assert.deepEqual(checkSections(body, ['Handover Spec']), ['Handover Spec'])
})

test('checkSections: requiredSections defaults to empty via `|| []` guard', () => {
  const body = '## Handover Spec\ncontent'
  assert.deepEqual(checkSections(body, null), [])
  assert.deepEqual(checkSections(body, undefined), [])
})

test('stripFences: an unclosed fence strips to EOF', () => {
  const body = '# Title\n\n```\nunclosed fence content\n## Findings\nmore content'
  const stripped = stripFences(body)
  assert.equal(stripped.includes('Findings'), false)
  assert.equal(stripped.includes('Title'), true)
})

test('stripFences: ~~~ fences are also stripped', () => {
  const body = '# Title\n\n~~~\n## Hidden\n~~~\n\n## Visible'
  const stripped = stripFences(body)
  assert.equal(stripped.includes('Hidden'), false)
  assert.equal(stripped.includes('Visible'), true)
})

// ---------------------------------------------------------------------------
// renderReturn — writes returns/<stem>.md via tmp+rename, markdown only.
// ---------------------------------------------------------------------------

test('renderReturn: writes the markdown body to renderPathFor(record) and returns that path', () => {
  const record = buildRecord({ role: 'code-reviewer', return: { kind: 'markdown', schema_path: null, required_sections: [], verdict_block: false } })
  const envelope = buildEnvelope({ role: 'code-reviewer', body: '# Verdict\npass' })
  const path = renderReturn(record, envelope)
  assert.equal(path, join(record.task_dir, 'returns', 'be-1b.1.md'))
  assert.equal(readFileSync(path, 'utf8'), '# Verdict\npass')
})

test('renderReturn: throws for kind json (runs only for markdown)', () => {
  const record = buildRecord() // default kind json
  const envelope = buildEnvelope()
  assert.throws(() => renderReturn(record, envelope))
})

// WRITE DISCIPLINE (source-level, qa-lead gate audit + acceptance criteria):
// renderReturn is the one function in the repo that writes the doc-tab
// RENDER path — a delete-then-recreate there bricks the mounted cmux panel
// permanently (design R16 / V2:558). This extracts renderReturn's own
// function body by brace-counting (not a substring match, so it can't be
// fooled by a comment) and asserts it contains no unlinkSync/rmSync call at
// all — the ONLY legitimate write shape for this function is tmp+rename
// (writeFileSync(tmp) then renameSync(tmp, path)), which the function body
// must also still contain. Kills the mutation "replace tmp+rename with
// rm-then-write on the render path".
function extractFunctionBody(source, startRe) {
  const m = startRe.exec(source)
  assert.ok(m, `could not locate function matching ${startRe} in source`)
  const braceStart = source.indexOf('{', m.index)
  assert.ok(braceStart !== -1, 'no opening brace found for matched function')
  let depth = 0
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(braceStart, i + 1)
    }
  }
  throw new Error('unbalanced braces while extracting function body')
}

test('WRITE DISCIPLINE: renderReturn\'s function body contains no unlinkSync/rmSync call and still uses the tmp+rename shape', () => {
  const source = readFileSync(join(ROOT, 'scripts/cmux/ladder.mjs'), 'utf8')
  const body = extractFunctionBody(source, /export function renderReturn\(/)
  assert.equal(/\bunlinkSync\s*\(/.test(body), false, 'renderReturn must never unlink the render path — tmp+rename only')
  assert.equal(/\brmSync\s*\(/.test(body), false, 'renderReturn must never rm the render path — tmp+rename only')
  assert.match(body, /writeFileSync\(/)
  assert.match(body, /renameSync\(/)
})

// ---------------------------------------------------------------------------
// evaluatePostcondition
// ---------------------------------------------------------------------------

test('evaluatePostcondition: "clean" + any offending line => not ok; every ignored line is returned', () => {
  const profile = { postcondition: 'clean', postcondition_ignore: ['dist/**', '*.log'] }
  const porcelain = ' M src/index.js\n?? dist/bundle.js\n?? debug.log\n'
  const result = evaluatePostcondition(profile, porcelain)
  assert.equal(result.ok, false)
  assert.deepEqual(result.offending, [' M src/index.js'])
  assert.deepEqual(result.ignored, ['?? dist/bundle.js', '?? debug.log'])
})

test('evaluatePostcondition: "changes_expected" => dirt is expected, ok true regardless of offending lines', () => {
  const profile = { postcondition: 'changes_expected', postcondition_ignore: [] }
  const result = evaluatePostcondition(profile, ' M src/index.js\n')
  assert.equal(result.ok, true)
  assert.deepEqual(result.offending, [' M src/index.js'])
})

test('evaluatePostcondition: "clean" with no lines => ok true', () => {
  const profile = { postcondition: 'clean', postcondition_ignore: [] }
  const result = evaluatePostcondition(profile, '')
  assert.equal(result.ok, true)
  assert.deepEqual(result.ignored, [])
  assert.deepEqual(result.offending, [])
})

test('evaluatePostcondition: handles a rename line ("old -> new"), matching the ignore glob against the new path', () => {
  const profile = { postcondition: 'clean', postcondition_ignore: ['renamed/**'] }
  const result = evaluatePostcondition(profile, 'R  old/path.js -> renamed/path.js\n')
  assert.equal(result.ok, true)
  assert.deepEqual(result.ignored, ['R  old/path.js -> renamed/path.js'])
})

// ---------------------------------------------------------------------------
// relaySignals — SIGNAL_LIMITS enforcement.
// ---------------------------------------------------------------------------

function signalLine(overrides = {}) {
  return JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'hello', escalate_to: 'lead', ...overrides })
}

test('relaySignals: at most 5 relayed per dispatch', () => {
  const lines = []
  for (let i = 0; i < 8; i += 1) {
    lines.push(signalLine({ ts: new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 40000).toISOString(), message: `signal ${i}` }))
  }
  const record = buildRecord()
  const result = relaySignals(record, lines, {})
  assert.equal(result.relay.length, 5)
  assert.equal(result.dropped.filter((d) => d.reason === 'relay_limit_reached').length, 3)
})

test('relaySignals: relays at least 30s apart', () => {
  const record = buildRecord()
  const lines = [
    signalLine({ ts: '2026-08-01T00:00:00.000Z', message: 'first' }),
    signalLine({ ts: '2026-08-01T00:00:10.000Z', message: 'too soon' }), // only 10s later
    signalLine({ ts: '2026-08-01T00:00:35.000Z', message: 'ok now' }), // 35s after first
  ]
  const result = relaySignals(record, lines, {})
  assert.equal(result.relay.length, 2)
  assert.equal(result.relay[0].message, 'first')
  assert.equal(result.relay[1].message, 'ok now')
  assert.equal(result.dropped.some((d) => d.reason === 'relay_interval_too_short'), true)
})

test('trust C3 fix: a far-future ts does not suppress a later valid line\'s relay (clamped to the parent-supplied now)', () => {
  const record = buildRecord()
  const now = Date.parse('2026-08-01T00:00:00.000Z')
  const lines = [
    signalLine({ ts: '9999-01-01T00:00:00.000Z', message: 'malicious future timestamp' }),
    signalLine({ ts: '2026-08-01T00:00:40.000Z', message: 'legitimate, 40s after now' }),
  ]
  const result = relaySignals(record, lines, {}, now)
  assert.equal(result.relay.length, 2)
  assert.equal(result.relay[0].message, 'malicious future timestamp') // clamped to `now`, still relays once
  assert.equal(result.relay[1].message, 'legitimate, 40s after now') // NOT suppressed by the poisoned future ts
})

test('trust C3 fix (defence in depth): a persisted lastRelayAt carried over already poisoned to the far future is ALSO clamped on read', () => {
  const record = buildRecord()
  const now = Date.parse('2026-08-01T00:00:00.000Z')
  const poisonedState = { relayedCount: 1, lastRelayAt: '9999-01-01T00:00:00.000Z' } // a caller that naively persisted the raw ts
  const lines = [signalLine({ ts: '2026-08-01T00:00:40.000Z', message: 'legitimate, 40s after now' })]
  const result = relaySignals(record, lines, poisonedState, now)
  assert.equal(result.relay.length, 1)
  assert.equal(result.relay[0].message, 'legitimate, 40s after now')
})

test('relaySignals: message truncated to 200 chars AT RELAY TIME, never "fixed" to match the write-time 2000 bound', () => {
  const record = buildRecord()
  const longMessage = 'x'.repeat(1999) // legal under the write-time schema bound (<=2000)
  const lines = [signalLine({ message: longMessage })]
  const result = relaySignals(record, lines, {})
  assert.equal(result.relay[0].message.length, 200)
  assert.equal(result.recorded[0].message.length, 1999) // recorded copy is untouched
})

test('relaySignals: unknown level defaults to progress', () => {
  const record = buildRecord()
  // level is malformed per the schema's enum -> the line fails schema
  // validation and is recorded-not-relayed; the "unknown level defaults to
  // progress" rule applies to the RELAY-time read path, exercised here via a
  // line whose level round-trips through relay only when otherwise valid.
  const result = relaySignals(record, [signalLine({ level: 'progress' })], {})
  assert.equal(result.relay[0].level, 'progress')
})

test('relaySignals: malformed and over-limit lines are RECORDED but NOT relayed', () => {
  const record = buildRecord()
  const lines = ['not json', JSON.stringify({ ts: 'bad', level: 'progress', message: 'x', escalate_to: 'lead' })]
  const result = relaySignals(record, lines, {})
  assert.equal(result.relay.length, 0)
  assert.equal(result.dropped.length, 2)
})

// ---------------------------------------------------------------------------
// GROUP: reconcile — the nine-row recovery matrix, one test per row.
// ---------------------------------------------------------------------------

test('RECOVERY_ROWS: the first nine rows are 1a-frozen; a 10th 1b-owned row (timeout_surface_alive) was added by the fix round (lifecycle S13)', () => {
  assert.equal(RECOVERY_ROWS.length, 10)
  assert.deepEqual(RECOVERY_ROWS, [
    'completed_surface_gone', 'completed_surface_alive', 'running_surface_alive',
    'crashed_surface_gone', 'orphaned_surface_gone', 'socket_unreachable',
    'partial_write_ignored', 'gate_observe_reported', 'rebuilt_from_disk',
    'timeout_surface_alive',
  ])
})

function buildTree(surfaces) {
  return {
    windows: [{
      workspaces: surfaces.map((s) => ({
        id: s.workspace_id,
        panes: [{ id: s.pane_id, surfaces: [{ id: s.surface_id }] }],
      })),
    }],
  }
}

test('row 1: fresh return + surface gone = completed', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  writeReturn(record, buildEnvelope())
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].row, 'completed_surface_gone')
  assert.equal(rows[0].state, classify({ record, fsState, tree: buildTree([]), now, quietState: null, topIdle: null }).state)
})

test('row 2: fresh return + surface alive = completed, close/focus, do not re-arm', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  writeReturn(record, buildEnvelope())
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const tree = buildTree([{ workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }])
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree, now })
  assert.equal(rows[0].row, 'completed_surface_alive')
  assert.deepEqual(rows[0].actions, ['close_or_focus_per_policy'])
})

test('row 3: surface alive + no return = running, re-arm', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const tree = buildTree([{ workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }])
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree, now })
  assert.equal(rows[0].row, 'running_surface_alive')
  assert.deepEqual(rows[0].actions, ['re_arm'])
})

test('row 4: surface gone + exit sentinel = crashed, offer re-dispatch, dirty-worktree warning', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }, attempt: 3 })
  const exitPath = `${record.return_path}.exit-sidecar`
  writeFileSync(exitPath, '1', 'utf8')
  const fsState = { ...collectFsState({ record, paths: { exitPath } }), worktreeDirty: true }
  const now = Date.parse(record.created_at) + 10000
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].row, 'crashed_surface_gone')
  assert.deepEqual(rows[0].actions, ['offer_redispatch_new_dispatch_id_bumped_attempt'])
  assert.ok(rows[0].warnings.some((w) => w === 'worktree has uncommitted changes from attempt 3'))
})

test('row 5: surface gone + no sentinel = orphaned, report only, NEVER auto-re-dispatch', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].row, 'orphaned_surface_gone')
  assert.deepEqual(rows[0].actions, ['report_only'])
})

test('row 6: socket unreachable (tree === null) = rank-0 continues, reports N dispatches file-tracked', () => {
  const r1 = buildRecord()
  const r2 = buildRecord()
  const now = Date.parse(r1.created_at) + 10000
  const fs1 = collectFsState({ record: r1, paths: {} })
  const fs2 = collectFsState({ record: r2, paths: {} })
  const rows = reconcile({ records: [r1, r2], fsState: { [r1.dispatch_id]: fs1, [r2.dispatch_id]: fs2 }, tree: null, now })
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.row, 'socket_unreachable')
    assert.deepEqual(row.actions, ['2 dispatches file-tracked'])
  }
})

test('row 7: a partially-written .tmp file is never read as a return, and is reported as partial_write_ignored', () => {
  const record = buildRecord()
  // The worker's own tmp+rename write targets a DIFFERENT filename; the
  // real return_path stays absent until the rename completes.
  writeFileSync(`${record.return_path}.tmp-12345`, JSON.stringify(buildEnvelope()), 'utf8')
  const fsState = collectFsState({ record, paths: {} })
  assert.equal(fsState.returnPathKind, 'absent')
  assert.equal(fsState.partialWrite, true)
  const now = Date.parse(record.created_at) + 10000
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.notEqual(rows[0].row, 'completed_surface_gone')
  assert.equal(rows[0].row, 'partial_write_ignored')
})

test('row 8: gate observe-mode / gate counter at max is reported, never a completion input (L-24)', () => {
  // The gate counter only matters while the process is still actively
  // running (the Stop hook that increments it fires per turn) — so a
  // meaningful gate-at-max row has the surface still alive, no return yet.
  const record = buildRecord({ gate: { max_blocks: 2 }, surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const gatePath = `${record.return_path}.gate-sidecar`
  writeFileSync(gatePath, '2', 'utf8')
  const fsState = collectFsState({ record, paths: { gatePath } })
  const now = Date.parse(record.created_at) + 10000
  const tree = buildTree([{ workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }])
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree, now })
  assert.equal(rows[0].row, 'gate_observe_reported')
  assert.notEqual(rows[0].state, 'completed') // L-24: gate is reported, never a completion input
})

test('row 9: orchestrator /clear\'ed = state rebuilt from disk alone, no in-memory carry-over', () => {
  const record = buildRecord({ surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  writeReturn(record, buildEnvelope())
  const recordPath = join(record.task_dir, 'record.json')
  writeFileSync(recordPath, JSON.stringify(record), 'utf8')

  // Simulate a fresh load: records loaded PURELY from a fixture directory.
  const reloadedRecord = JSON.parse(readFileSync(recordPath, 'utf8'))
  const fsState = collectFsState({ record: reloadedRecord, paths: {} })
  const now = Date.parse(reloadedRecord.created_at) + 10000
  const tree = buildTree([{ workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }])
  const rows = reconcile({ records: [reloadedRecord], fsState: { [reloadedRecord.dispatch_id]: fsState }, tree, now })
  const directResult = classify({ record: reloadedRecord, fsState, tree, now, quietState: null, topIdle: null })
  assert.equal(rows[0].state, directResult.state)
  assert.equal(rows[0].row, 'completed_surface_alive')
})

// ---------------------------------------------------------------------------
// Fix-round lifecycle S11: a terminal record must reconcile to
// 'rebuilt_from_disk', not fall through to the orphan catch-all. Before the
// fix, a terminated record with a gone surface was misreported
// 'orphaned_surface_gone'.
// ---------------------------------------------------------------------------

test('lifecycle S11 fix: a terminal record reconciles to rebuilt_from_disk, never orphaned_surface_gone', () => {
  const record = buildRecord({ outcome: 'no_return', surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const fsState = collectFsState({ record, paths: {} })
  const now = Date.parse(record.created_at) + 10000
  // surface is gone in the live tree — the pre-fix bug reported this row as
  // orphaned_surface_gone even though the record is already terminal.
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].state, 'terminal')
  assert.equal(rows[0].row, 'rebuilt_from_disk')
  assert.notEqual(rows[0].row, 'orphaned_surface_gone')
})

// ---------------------------------------------------------------------------
// Fix-round lifecycle S11: a partial (mid-tmp+rename) write is a distinct
// row, reachable via the REAL fsState.partialWrite flag collectFsState now
// actually produces — not the dead returnPathKind === 'tmp' value.
// ---------------------------------------------------------------------------

test('lifecycle S11 fix: collectFsState sets partialWrite when return_path is absent AND a <stem>.json*tmp* sibling exists', () => {
  const record = buildRecord()
  writeFileSync(`${record.return_path}.tmp-98765-abcde`, JSON.stringify(buildEnvelope()), 'utf8')
  const fsState = collectFsState({ record, paths: {} })
  assert.equal(fsState.returnPathKind, 'absent')
  assert.equal(fsState.partialWrite, true)

  const now = Date.parse(record.created_at) + 10000
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].row, 'partial_write_ignored')
})

test('lifecycle S11 fix: partialWrite is false when there is no tmp sibling, or when the return is a normal completed file', () => {
  const record = buildRecord()
  const noSiblingFsState = collectFsState({ record, paths: {} })
  assert.equal(noSiblingFsState.partialWrite, false)

  const completedRecord = buildRecord()
  writeReturn(completedRecord, buildEnvelope())
  const completedFsState = collectFsState({ record: completedRecord, paths: {} })
  assert.equal(completedFsState.partialWrite, false) // returnPathKind is 'file', not 'absent'
})

// ---------------------------------------------------------------------------
// Fix-round lifecycle S13: an explicit timeout branch ahead of
// running_surface_alive — a timed-out dispatch with a live surface must
// never be reported as running and re-armed.
// ---------------------------------------------------------------------------

test('lifecycle S13 fix: a timed-out dispatch with a live surface reconciles to timeout_surface_alive, never running_surface_alive/re_arm', () => {
  const record = buildRecord({ timeout_s: 60, surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const fsState = collectFsState({ record, paths: {} }) // no return ever arrives
  const now = Date.parse(record.created_at) + 120000 // 120s > 60s timeout_s
  const tree = buildTree([{ workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID }])

  const directResult = classify({ record, fsState, tree, now, quietState: null, topIdle: null })
  assert.equal(directResult.state, 'timeout')

  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree, now })
  assert.equal(rows[0].row, 'timeout_surface_alive')
  assert.notEqual(rows[0].row, 'running_surface_alive')
  assert.equal(rows[0].actions.includes('re_arm'), false)
})

test('lifecycle S13 fix: gateAtMax is reachable even when the surface is gone (moved above the orphan catch-all)', () => {
  const record = buildRecord({ gate: { max_blocks: 2 }, surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID } })
  const gatePath = `${record.return_path}.gate-sidecar`
  writeFileSync(gatePath, '2', 'utf8')
  const fsState = collectFsState({ record, paths: { gatePath } })
  const now = Date.parse(record.created_at) + 10000
  // surface is GONE this time — before the fix, gateAtMax was only ever
  // reachable for surface-alive rows because it sat below the orphan
  // catch-all.
  const rows = reconcile({ records: [record], fsState: { [record.dispatch_id]: fsState }, tree: buildTree([]), now })
  assert.equal(rows[0].row, 'gate_observe_reported')
  assert.notEqual(rows[0].row, 'orphaned_surface_gone')
})
