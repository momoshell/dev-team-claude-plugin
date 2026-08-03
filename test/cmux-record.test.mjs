import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { ROOT } from './helpers.mjs'
import { validate, NONCE_PREFIX, OUTCOMES, CMUX_ALLOWS } from '../scripts/cmux/contract.mjs'
import { resolveRoots, taskPaths, resolveRole, snapshotDirFor } from '../scripts/cmux/resolve.mjs'
import { validateReturn } from '../scripts/cmux/ladder.mjs'
import {
  newDispatchId, attnTokenFor, isoMs,
  snapshotWorkerPlugin, composeRolePrompt, PROFILE_ADDENDA, WORKER_PLUGIN_MANIFEST,
  buildRecord, buildArgv,
  writeRecord, bindRecord, terminateRecord, readRecord, listRecords, nextAttempt,
  initGateCounter, assertNoNonce, StaleReturnError, RecordInvalidError, RecordLockError, withRecordLock,
} from '../scripts/cmux/record.mjs'

const dispatchRecordSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8'))
const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const RULE_RE = new RegExp(dispatchRecordSchema.properties.profile.properties.allow.items.pattern)

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// buildRecord() ctx fixture — a full task/state tree under a fresh tmp root,
// snapshotted worker plugin, resolved role, mirroring what be-1b-E would
// assemble before calling buildRecord.
// ---------------------------------------------------------------------------

function makeCtxAndPaths({ root, taskId = 'be-1a task', taskSlug = 'sample-task', repoSlug = 'sample-repo', now = 1754136000123 } = {}) {
  const primaryCheckout = join(root, 'checkout')
  mkdirSync(primaryCheckout, { recursive: true })
  const roots = resolveRoots({ taskArtifactsRoot: join(root, 'dev-team') })
  const paths = taskPaths({ roots, repoSlug, taskSlug })
  const dispatchId = newDispatchId()
  const snapshotDir = snapshotDirFor(paths, dispatchId)
  const snapshot = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })
  const ctx = {
    roots,
    paths,
    roster: rosterDefault,
    resolved: resolveRole('coder', { plugin: rosterDefault.roles.coder }),
    pluginRoot: ROOT,
    taskId,
    taskSlug,
    repoSlug,
    primaryCheckout,
    snapshot,
    config: {},
    now,
    dispatchId,
    attnUpstream: null,
  }
  return { ctx, paths, snapshot }
}

function buildValidRecord(overrides = {}) {
  const root = makeTmpDir('cmux-record-')
  const { ctx } = makeCtxAndPaths({ root })
  return buildRecord({ ...ctx, ...overrides.ctx }, {
    role: 'coder',
    sliceId: overrides.sliceId || 'be-1a',
    attempt: overrides.attempt || 1,
    spec: overrides.spec || { validation_commands: ['node --test'] },
  })
}

// ---------------------------------------------------------------------------
// A2 positives — asserted BEFORE any negative case (qa-notes.md): a create,
// bind and terminate state, each validating clean.
// ---------------------------------------------------------------------------

test('buildRecord: create state validates clean against dispatch-record.schema.json', () => {
  const rec = buildValidRecord()
  assert.deepEqual(validate(dispatchRecordSchema, rec), [])
  assert.equal(rec.surface, null)
  assert.equal(rec.bound_at, null)
  assert.equal(rec.ended_at, null)
  assert.equal(rec.outcome, null)
})

test('lifecycle: bind state validates clean', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  const bound = bindRecord(path, {
    workspace_id: '22222222-2222-2222-2222-222222222222',
    pane_id: '33333333-3333-3333-3333-333333333333',
    surface_id: '44444444-4444-4444-4444-444444444444',
    now: 1754136001000,
  })
  assert.deepEqual(validate(dispatchRecordSchema, bound), [])
  assert.notEqual(bound.surface, null)
  assert.notEqual(bound.bound_at, null)
  assert.equal(bound.ended_at, null)
  assert.equal(bound.outcome, null)
})

test('lifecycle: terminate state validates clean', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  bindRecord(path, {
    workspace_id: '22222222-2222-2222-2222-222222222222',
    pane_id: '33333333-3333-3333-3333-333333333333',
    surface_id: '44444444-4444-4444-4444-444444444444',
    now: 1754136001000,
  })
  const terminated = terminateRecord(path, 'ok', 1754136060000)
  assert.deepEqual(validate(dispatchRecordSchema, terminated), [])
  assert.equal(terminated.outcome, 'ok')
  assert.notEqual(terminated.ended_at, null)
})

// ---------------------------------------------------------------------------
// Hard rule tests (A10 — one per rule 1-9). Rule 7 (--append-system-prompt-file
// existence) is an adapter-init probe owned by 1c; it is not tested here.
// ---------------------------------------------------------------------------

test('hard rule 1: argv[length-2] is the bare -- immediately before the kickoff positional', () => {
  const rec = buildValidRecord()
  const argv = buildArgv(rec)
  assert.equal(argv[argv.length - 2], '--')
  assert.equal(argv[argv.length - 1], rec.kickoff)
})

test('hard rule 2: no argv element contains \\n or \\r, and the role prompt is passed as a path, not bytes', () => {
  const rec = buildValidRecord()
  const argv = buildArgv(rec)
  for (const el of argv) {
    assert.equal(/[\n\r]/.test(el), false, `argv element contains a newline: ${JSON.stringify(el)}`)
  }
  assert.ok(argv.includes(rec.role_prompt_path))
  const promptBytes = readFileSync(rec.role_prompt_path, 'utf8')
  assert.equal(argv.includes(promptBytes), false)
})

test('hard rule 3: each permission rule is its own argv element (element-count assertion)', () => {
  const rec = buildValidRecord()
  const argv = buildArgv(rec)
  const start = argv.indexOf('--allowedTools') + 1
  const end = argv.indexOf('--disallowedTools')
  assert.equal(end - start, rec.profile.allow.length)
  assert.deepEqual(argv.slice(start, end), rec.profile.allow)
})

test('hard rule 4: every path rule in profile.allow is //-anchored', () => {
  const rec = buildValidRecord()
  for (const rule of rec.profile.allow) {
    if (rule.startsWith('Edit(') || rule.startsWith('Read(')) {
      assert.ok(rule.includes('(//'), `rule not //-anchored: ${rule}`)
    }
  }
})

test('hard rule 5: every profile.allow rule matches the frozen rule-shape pattern', () => {
  const rec = buildValidRecord()
  for (const rule of rec.profile.allow) {
    assert.ok(RULE_RE.test(rule), `rule fails the frozen pattern: ${rule}`)
  }
})

test('hard rule 6: profile.allow contains both CMUX_ALLOWS literals byte-identically; disallowed_tools contains no Bash( form', () => {
  const rec = buildValidRecord()
  for (const literal of CMUX_ALLOWS) {
    assert.ok(rec.profile.allow.includes(literal))
  }
  for (const tool of rec.disallowed_tools) {
    assert.equal(tool.includes('Bash('), false)
  }
})

test('hard rule 8: worktree.path !== primary_checkout, task_dir is outside every checkout, no path field contains a .. segment', () => {
  const rec = buildValidRecord()
  assert.notEqual(rec.worktree.path, rec.primary_checkout)
  assert.equal(rec.task_dir.startsWith(rec.primary_checkout), false)
  assert.equal(rec.primary_checkout.startsWith(rec.task_dir), false)
  const pathFields = [rec.task_dir, rec.spec_path, rec.return_path, rec.signals_path, rec.primary_checkout, rec.role_prompt_path, rec.cwd, rec.worktree.path]
  for (const p of pathFields) {
    assert.equal(p.split('/').includes('..'), false, `path field contains a traversal segment: ${p}`)
  }
})

test('hard rule 9: NONCE_PREFIX appears nowhere in JSON.stringify(record)', () => {
  const rec = buildValidRecord()
  assert.equal(JSON.stringify(rec).includes(NONCE_PREFIX), false)
  assert.doesNotThrow(() => assertNoNonce(rec))
})

// ---------------------------------------------------------------------------
// Rule-9 scan scope: RECORD bytes only, never schema bytes (the schema's own
// description embeds the literal nonce prefix, documenting the prohibition).
// ---------------------------------------------------------------------------

test('rule-9 scan scope: assertNoNonce rejects a record containing the prefix', () => {
  const rec = buildValidRecord()
  rec.kickoff = `${rec.kickoff.slice(0, 20)} ${NONCE_PREFIX}abc123`
  assert.throws(() => assertNoNonce(rec))
})

test('rule-9 scan scope: the schema file itself contains the literal prefix (sanity — proves why a schema-spanning scan would self-trip) yet a clean record never does', () => {
  const schemaText = readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8')
  assert.ok(schemaText.includes(NONCE_PREFIX), 'expected the schema description to embed the literal nonce prefix')
  const rec = buildValidRecord()
  assert.doesNotThrow(() => assertNoNonce(rec))
})

// ---------------------------------------------------------------------------
// U-1 attempt uniqueness — nextAttempt
// ---------------------------------------------------------------------------

test('nextAttempt: returns 1 over an empty (nonexistent) dispatch dir', () => {
  const dir = join(makeTmpDir('cmux-record-'), 'dispatch')
  assert.equal(nextAttempt(dir, 'be-1a'), 1)
})

test('nextAttempt: returns 1 + max over existing attempts [1, 2]', () => {
  const dir = makeTmpDir('cmux-record-')
  writeFileSync(join(dir, 'be-1a.1.json'), '{}')
  writeFileSync(join(dir, 'be-1a.2.json'), '{}')
  assert.equal(nextAttempt(dir, 'be-1a'), 3)
})

test('nextAttempt: ignores another slice\'s records in the same dir', () => {
  const dir = makeTmpDir('cmux-record-')
  writeFileSync(join(dir, 'be-1a.1.json'), '{}')
  writeFileSync(join(dir, 'be-1b.7.json'), '{}')
  assert.equal(nextAttempt(dir, 'be-1a'), 2)
  assert.equal(nextAttempt(dir, 'be-1b'), 8)
})

test('nextAttempt: throws when the next attempt would exceed the frozen maximum of 99', () => {
  const dir = makeTmpDir('cmux-record-')
  writeFileSync(join(dir, 'be-1a.99.json'), '{}')
  assert.throws(() => nextAttempt(dir, 'be-1a'))
})

// ---------------------------------------------------------------------------
// writeRecord exclusivity (U-1) and L-15 stale-return refusal
// ---------------------------------------------------------------------------

test('writeRecord: exclusive create — the second call at the same stem throws and the first file is byte-identical afterwards', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  const before = readFileSync(path, 'utf8')
  assert.throws(() => writeRecord(rec, path))
  const after = readFileSync(path, 'utf8')
  assert.equal(before, after)
})

test('writeRecord: throws StaleReturnError when return_path is already occupied, without touching that file, creating no record, and creating no gate counter', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  mkdirSync(paths.returnsDir, { recursive: true })
  writeFileSync(rec.return_path, 'PRE-EXISTING-EVIDENCE')
  const before = readFileSync(rec.return_path, 'utf8')

  let caught = null
  try {
    writeRecord(rec, join(paths.dispatchDir, 'be-1a.1.json'))
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof StaleReturnError)
  assert.equal(caught.path, rec.return_path)
  assert.ok(caught.message.includes(rec.return_path))
  assert.ok(caught.message.includes('bump'))

  assert.equal(readFileSync(rec.return_path, 'utf8'), before)
  assert.equal(existsSync(join(paths.dispatchDir, 'be-1a.1.json')), false)
  assert.equal(existsSync(rec.env.DEVTEAM_GATE_COUNTER), false)
})

// ---------------------------------------------------------------------------
// initGateCounter (A10)
// ---------------------------------------------------------------------------

test('writeRecord: creates the gate counter containing \'0\' at record-create time', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  writeRecord(rec, join(paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(readFileSync(rec.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0')
})

test('initGateCounter: writes \'0\' at the sidecar gate path and returns it', () => {
  const root = makeTmpDir('cmux-record-')
  const { paths } = makeCtxAndPaths({ root })
  const dispatchId = newDispatchId()
  const gatePath = initGateCounter(paths, dispatchId)
  assert.equal(readFileSync(gatePath, 'utf8'), '0')
  assert.ok(gatePath.endsWith(`${dispatchId}.gate`))
})

// ---------------------------------------------------------------------------
// L-32 listRecords ignores interrupted writes
// ---------------------------------------------------------------------------

test('listRecords: ignores *.tmp entries and non-<slice>.<n>.json entries, throwing nothing', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: ['node --test'] } })
  writeRecord(rec, join(paths.dispatchDir, 'be-1a.1.json'))
  writeFileSync(join(paths.dispatchDir, 'be-1a.1.json.tmp'), '{ truncated')
  writeFileSync(join(paths.dispatchDir, '.hidden.json'), '{}')
  mkdirSync(join(paths.dispatchDir, 'be-1a.2.json'))

  const records = listRecords(paths.dispatchDir)
  assert.equal(records.length, 1)
  assert.equal(records[0].slice_id, 'be-1a')
})

test('listRecords: returns [] for a nonexistent dispatch dir', () => {
  assert.deepEqual(listRecords(join(makeTmpDir('cmux-record-'), 'nope')), [])
})

// ---------------------------------------------------------------------------
// env — exactly the eight frozen keys with the frozen values
// ---------------------------------------------------------------------------

test('env: exactly the eight frozen keys with the frozen values', () => {
  const rec = buildValidRecord()
  assert.deepEqual(Object.keys(rec.env).sort(), [
    'DEVTEAM_DISPATCH_ID', 'DEVTEAM_DISPATCH_RECORD', 'DEVTEAM_GATE_COUNTER',
    'DEVTEAM_ROLE', 'DEVTEAM_SIGNAL_LOG', 'DEVTEAM_TASK_DIR', 'DEVTEAM_TASK_ID', 'DEVTEAM_WORKER',
  ].sort())
  assert.equal(rec.env.DEVTEAM_WORKER, '1')
  assert.equal(rec.env.DEVTEAM_ROLE, rec.role)
  assert.equal(rec.env.DEVTEAM_TASK_ID, rec.task_id)
  assert.equal(rec.env.DEVTEAM_DISPATCH_ID, rec.dispatch_id)
  assert.equal(rec.env.DEVTEAM_TASK_DIR, rec.task_dir)
  assert.notEqual(rec.env.DEVTEAM_SIGNAL_LOG, rec.signals_path)
  assert.ok(rec.env.DEVTEAM_SIGNAL_LOG.endsWith('.signal-log'))
  assert.ok(rec.env.DEVTEAM_GATE_COUNTER.endsWith('.gate'))
})

test('negative: a ninth env key fails schema validation', () => {
  const rec = buildValidRecord()
  rec.env.DEVTEAM_EXTRA = 'x'
  const violations = validate(dispatchRecordSchema, rec)
  assert.ok(violations.some((v) => v.path === '$.env.DEVTEAM_EXTRA' && v.keyword === 'additionalProperties'))
})

// ---------------------------------------------------------------------------
// kickoff
// ---------------------------------------------------------------------------

test('kickoff: single line, <= 4000 chars, carries all seven literals, and never embeds NONCE_PREFIX', () => {
  const rec = buildValidRecord()
  assert.equal(/[\n\r]/.test(rec.kickoff), false)
  assert.ok(rec.kickoff.length <= 4000)
  for (const lit of [rec.dispatch_id, rec.task_dir, rec.spec_path, rec.return_path, rec.signals_path, rec.attn_parent, rec.attn_upstream]) {
    assert.ok(rec.kickoff.includes(lit), `kickoff missing literal: ${lit}`)
  }
  assert.equal(rec.kickoff.includes(NONCE_PREFIX), false)
})

test('kickoff: attn_upstream === attn_parent for an orchestrator-initiated dispatch (no null branch)', () => {
  const rec = buildValidRecord()
  assert.equal(rec.attn_upstream, rec.attn_parent)
  assert.equal(rec.attn_parent, `devteam-${rec.dispatch_id}-attn`)
})

// ---------------------------------------------------------------------------
// dispatch_id / lowercase-id defence in depth
// ---------------------------------------------------------------------------

test('newDispatchId: returns a lowercase uuid', () => {
  const id = newDispatchId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('negative: buildRecord refuses an uppercase-hex dispatch_id', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx } = makeCtxAndPaths({ root })
  ctx.dispatchId = ctx.dispatchId.toUpperCase()
  assert.throws(() => buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } }))
})

test('negative: bindRecord throws when passed an uppercase workspace/pane/surface id', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  assert.throws(() => bindRecord(path, {
    workspace_id: 'aabb2222-2222-2222-2222-222222222222'.toUpperCase(),
    pane_id: 'aabb3333-3333-3333-3333-333333333333',
    surface_id: 'aabb4444-4444-4444-4444-444444444444',
  }))
  assert.throws(() => bindRecord(path, {
    workspace_id: 'aabb2222-2222-2222-2222-222222222222',
    pane_id: 'aabb3333-3333-3333-3333-333333333333'.toUpperCase(),
    surface_id: 'aabb4444-4444-4444-4444-444444444444',
  }))
  assert.throws(() => bindRecord(path, {
    workspace_id: 'aabb2222-2222-2222-2222-222222222222',
    pane_id: 'aabb3333-3333-3333-3333-333333333333',
    surface_id: 'aabb4444-4444-4444-4444-444444444444'.toUpperCase(),
  }))
})

// ---------------------------------------------------------------------------
// L-16 millisecond timestamps ALWAYS — 100 records over randomised clock
// values, including whole-second instants.
// ---------------------------------------------------------------------------

test('isoMs: matches /\\.\\d{3}Z$/ for 100 randomised clock values, including whole-second instants', () => {
  const clocks = [1754136000000, 0, 1]
  for (let i = 0; i < 97; i += 1) {
    clocks.push(Math.floor(Math.random() * 2_000_000_000_000))
  }
  for (const t of clocks) {
    assert.match(isoMs(t), /\.\d{3}Z$/, `isoMs(${t}) did not carry milliseconds`)
    assert.match(isoMs(new Date(t)), /\.\d{3}Z$/)
  }
})

test('negative: isoMs refuses a pre-formatted string argument', () => {
  assert.throws(() => isoMs('2026-08-01T00:00:00.000Z'))
})

test('buildRecord/bindRecord/terminateRecord: created_at/bound_at/ended_at all carry milliseconds across 100 randomised clock values', () => {
  for (let i = 0; i < 100; i += 1) {
    const now = i < 3 ? [1754136000000, 0, 1][i] : Math.floor(Math.random() * 2_000_000_000_000)
    const root = makeTmpDir('cmux-record-')
    const { ctx, paths } = makeCtxAndPaths({ root, now })
    const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
    assert.match(rec.created_at, /\.\d{3}Z$/)
    const path = join(paths.dispatchDir, 'be-1a.1.json')
    writeRecord(rec, path)
    const bound = bindRecord(path, {
      workspace_id: 'aabb2222-2222-2222-2222-222222222222',
      pane_id: 'aabb3333-3333-3333-3333-333333333333',
      surface_id: 'aabb4444-4444-4444-4444-444444444444',
      now,
    })
    assert.match(bound.bound_at, /\.\d{3}Z$/)
    const terminated = terminateRecord(path, 'ok', now)
    assert.match(terminated.ended_at, /\.\d{3}Z$/)
  }
})

// ---------------------------------------------------------------------------
// Lifecycle negatives — monotonicity
// ---------------------------------------------------------------------------

function makeBoundRecord(root) {
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  return path
}

test('negative: bind twice throws', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  bindRecord(path, ids)
  assert.throws(() => bindRecord(path, ids))
})

test('negative: terminate before bind throws', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  assert.throws(() => terminateRecord(path, 'ok'))
})

test('negative: terminate twice throws', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  bindRecord(path, ids)
  terminateRecord(path, 'ok')
  assert.throws(() => terminateRecord(path, 'ok'))
})

test('negative: setting a transitioned field back to null throws (terminateRecord with outcome null)', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  bindRecord(path, ids)
  assert.throws(() => terminateRecord(path, null))
})

test('lifecycle: atomic transitions leave every other field byte-identical (deepStrictEqual after deleting the transitioned fields)', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const created = readRecord(path)
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  const bound = bindRecord(path, ids)

  const createdForCompare = { ...created }
  const boundForCompare = { ...bound }
  delete createdForCompare.surface
  delete createdForCompare.bound_at
  delete boundForCompare.surface
  delete boundForCompare.bound_at
  assert.deepEqual(createdForCompare, boundForCompare)

  const terminated = terminateRecord(path, 'ok')
  const boundForCompare2 = { ...bound }
  const terminatedForCompare = { ...terminated }
  delete boundForCompare2.outcome
  delete boundForCompare2.ended_at
  delete terminatedForCompare.outcome
  delete terminatedForCompare.ended_at
  assert.deepEqual(boundForCompare2, terminatedForCompare)
})

test('lifecycle: writeRecord/bindRecord/terminateRecord each write via tmp+rename (no stray .tmp file left behind)', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const dir = dirname(path)
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  bindRecord(path, ids)
  terminateRecord(path, 'ok')
  const leftoverTmp = readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftoverTmp, [])
})

// ---------------------------------------------------------------------------
// snapshotWorkerPlugin / composeRolePrompt
// ---------------------------------------------------------------------------

test('snapshotWorkerPlugin: writes roles/<role>.txt (frontmatter-stripped body + profile addendum) and copies referenced return schemas', () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  const snapshot = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  for (const role of Object.keys(rosterDefault.roles)) {
    assert.ok(snapshot.roles[role], `missing snapshot entry for role ${role}`)
    assert.ok(existsSync(snapshot.roles[role].path))
    assert.match(snapshot.roles[role].sha256, /^[0-9a-f]{64}$/)
    const text = readFileSync(snapshot.roles[role].path, 'utf8')
    assert.equal(text.startsWith('---'), false, `role prompt for ${role} still carries frontmatter`)
  }

  assert.ok(snapshot.schemas['coder-return.schema.json'])
  assert.ok(existsSync(snapshot.schemas['coder-return.schema.json']))
  // D-1 (trust M1 fix): schemas[filename] is the PLUGIN-ROOT source path, not
  // the copy inside the snapshot — the copy still lands in the snapshot for
  // 1c's self-containment, but nothing on the record points a completion
  // decision back at worker-writable bytes.
  assert.equal(snapshot.schemas['coder-return.schema.json'], join(ROOT, 'coder-return.schema.json'))
  assert.equal(snapshot.schemas['coder-return.schema.json'].startsWith(snapshotDir), false)
  assert.ok(existsSync(join(snapshotDir, 'coder-return.schema.json')), 'expected the snapshot copy to still be written for 1c self-containment')
})

test('snapshotWorkerPlugin: idempotent — running twice yields byte-identical files and identical sha256', () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  const first = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })
  const firstBytes = readFileSync(first.roles.coder.path, 'utf8')
  const second = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })
  const secondBytes = readFileSync(second.roles.coder.path, 'utf8')
  assert.equal(firstBytes, secondBytes)
  assert.equal(first.roles.coder.sha256, second.roles.coder.sha256)
  assert.equal(first.roles.coder.path, second.roles.coder.path)
})

test('composeRolePrompt: strips YAML frontmatter from the agent body', () => {
  const text = composeRolePrompt(ROOT, 'coder', 'executor', rosterDefault.roles.coder.return)
  assert.equal(text.startsWith('---'), false)
  assert.ok(text.includes('You are a code implementation agent'))
})

test('negative: composeRolePrompt throws for an unknown profile name', () => {
  assert.throws(() => composeRolePrompt(ROOT, 'coder', 'bogus-profile', rosterDefault.roles.coder.return))
})

test('negative: composeRolePrompt throws for an unknown return kind', () => {
  assert.throws(() => composeRolePrompt(ROOT, 'coder', 'executor', { kind: 'bogus-kind' }))
})

test('composeRolePrompt: appends the JSON return-contract addendum for a json-kind role', () => {
  const text = composeRolePrompt(ROOT, 'coder', 'executor', rosterDefault.roles.coder.return)
  assert.ok(text.includes('Return contract (JSON)'))
  assert.ok(text.includes('exactly these keys'))
})

test('composeRolePrompt: appends the markdown return-contract addendum plus the required_sections/verdict-block line for a markdown-kind role', () => {
  const text = composeRolePrompt(ROOT, 'code-reviewer', 'judgment', rosterDefault.roles['code-reviewer'].return)
  assert.ok(text.includes('Return contract (Markdown)'))
  assert.ok(text.includes('Required sections for this role: Verdict, Must-fix, Notes.'))
  assert.ok(text.includes('fenced json block matching {verdict, findings}'))
})

test('composeRolePrompt: a markdown role without verdict_block gets no verdict-block sentence', () => {
  const text = composeRolePrompt(ROOT, 'plan-reviewer', 'judgment', rosterDefault.roles['plan-reviewer'].return)
  assert.ok(text.includes('Required sections for this role: Must Fix, Should Fix.'))
  assert.equal(text.includes('fenced json block matching'), false)
})

// ---------------------------------------------------------------------------
// A10 role_prompt_sha256 cross-dispatch stability
// ---------------------------------------------------------------------------

test('A10: two records built for the same role in the same task carry identical role_prompt_sha256 and role_prompt_path', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx } = makeCtxAndPaths({ root })
  const recA = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const recB = buildRecord(ctx, { role: 'coder', sliceId: 'be-1b', attempt: 1, spec: { validation_commands: [] } })
  assert.equal(recA.role_prompt_sha256, recB.role_prompt_sha256)
  assert.equal(recA.role_prompt_path, recB.role_prompt_path)
})

// ---------------------------------------------------------------------------
// PROFILE_ADDENDA — static text substring assertions
// ---------------------------------------------------------------------------

test('PROFILE_ADDENDA: all three variants carry the ReturnEnvelope key list, the U-3 agreement tuple, the kickoff/stem derivation, single-file-at-return_path, the two cmux verbs, and the postcondition expectation', () => {
  const envelopeKeys = ['schema_version', 'dispatch_id', 'slice_id', 'attempt', 'role', 'produced_at', 'body']
  for (const [name, text] of Object.entries(PROFILE_ADDENDA)) {
    for (const key of envelopeKeys) {
      assert.ok(text.includes(key), `${name} addendum missing envelope key: ${key}`)
    }
    assert.ok(/dispatch_id.*slice_id.*attempt.*role|dispatch_id, slice_id, attempt, or role/s.test(text), `${name} addendum missing the four-field agreement`)
    assert.ok(text.includes('dispatch_id arrives in your kickoff'), `${name} addendum missing kickoff/stem derivation`)
    assert.ok(text.includes('return_path'), `${name} addendum missing return_path`)
    assert.ok(text.includes('Write exactly one file'), `${name} addendum missing single-file assertion`)
    assert.ok(text.includes('cmux notify'), `${name} addendum missing cmux notify`)
    assert.ok(text.includes('cmux wait-for -S'), `${name} addendum missing cmux wait-for -S`)
    assert.ok(text.includes('Postcondition'), `${name} addendum missing postcondition section`)
  }
  assert.ok(PROFILE_ADDENDA.executor.includes('changes_expected'))
  assert.ok(PROFILE_ADDENDA.validator.includes('clean'))
  assert.ok(PROFILE_ADDENDA.judgment.includes('clean'))
})

// ---------------------------------------------------------------------------
// buildArgv — --max-turns and --effort emission rules
// ---------------------------------------------------------------------------

test('buildArgv: emits --max-turns only when max_turns is non-null (Phase 1 never emits it)', () => {
  const rec = buildValidRecord()
  assert.equal(rec.max_turns, null)
  const argv = buildArgv(rec)
  assert.equal(argv.includes('--max-turns'), false)

  const withMaxTurns = { ...rec, max_turns: 20 }
  const argv2 = buildArgv(withMaxTurns)
  const idx = argv2.indexOf('--max-turns')
  assert.notEqual(idx, -1)
  assert.equal(argv2[idx + 1], '20')
})

test('buildArgv: never emits an --allowedTools entry not present in record.profile.allow', () => {
  const rec = buildValidRecord()
  const argv = buildArgv(rec)
  const start = argv.indexOf('--allowedTools') + 1
  const end = argv.indexOf('--disallowedTools')
  for (const el of argv.slice(start, end)) {
    assert.ok(rec.profile.allow.includes(el))
  }
})

test('buildArgv: omits --effort when record.effort is null', () => {
  const rec = buildValidRecord()
  const withNullEffort = { ...rec, effort: null }
  const argv = buildArgv(withNullEffort)
  assert.equal(argv.includes('--effort'), false)
})

// ---------------------------------------------------------------------------
// Fix round (post-panel, backend-lead 2026-08-02) — B packet.
// ---------------------------------------------------------------------------

// trust M2 (D-3): the snapshot inventory is closed & enumerable — exactly
// roles/<role>.txt per roster role plus one file per distinct referenced
// return schema, nothing else.
test('trust M2: snapshot inventory over the full roster is closed & enumerable — exactly the enumerated files, zero extras', () => {
  const root = makeTmpDir('cmux-record-')
  const roots = resolveRoots({ taskArtifactsRoot: join(root, 'dev-team') })
  const paths = taskPaths({ roots, repoSlug: 'sample-repo', taskSlug: 'sample-task' })
  const snapshotDir = snapshotDirFor(paths, newDispatchId())
  snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  function deepList(dir, prefix = '') {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...deepList(join(dir, entry.name), rel))
      } else {
        out.push(rel)
      }
    }
    return out.sort()
  }

  const distinctSchemas = new Set()
  for (const roleDef of Object.values(rosterDefault.roles)) {
    if (roleDef.return && roleDef.return.kind === 'json' && roleDef.return.schema) {
      distinctSchemas.add(roleDef.return.schema)
    }
  }
  const expected = [
    ...Object.keys(rosterDefault.roles).map((role) => `roles/${role}.txt`),
    ...distinctSchemas,
    ...Object.keys(WORKER_PLUGIN_MANIFEST),
  ].sort()

  assert.deepEqual(deepList(snapshotDir), expected)
})

// ---------------------------------------------------------------------------
// Import-closure — every copied .mjs must resolve its static imports and
// module-load-time reads INSIDE the snapshot, or the worker-side hook chain
// (return-lint.mjs -> ladder.mjs -> resolve.mjs / contract.mjs, plus the
// three module-load-time schema reads) breaks on import. The required set is
// DERIVED FROM A SOURCE-TEXT SCAN of the copied bytes, never re-typed from
// WORKER_PLUGIN_MANIFEST — a re-typed list is circular and would have missed
// exactly the dispatch-record.schema.json gap this manifest entry closes
// (backend-notes.md 2026-08-01: source-text regex, never import).
// ---------------------------------------------------------------------------

// scanRequiredRefs(destRel, text) -> Set<snapshot-relative dest> of every
// static `import ... from './x'` specifier and every module-load-time
// join(MODULE_DIR, 'y') read found in `text`, resolved relative to destRel's
// own directory (every .mjs in the manifest lives in hooks/, so this is
// always another hooks/* destination).
function scanRequiredRefs(destRel, text) {
  const refs = new Set()
  const dir = dirname(destRel)
  const importRe = /import\s+[^'"]*from\s+'\.\/([^']+)'/g
  let m
  while ((m = importRe.exec(text))) {
    refs.add(join(dir, m[1]))
  }
  const joinRe = /join\(MODULE_DIR,\s*'([^']+)'\)/g
  while ((m = joinRe.exec(text))) {
    refs.add(join(dir, m[1]))
  }
  return refs
}

// CLOSURE-TEST ANTI-VACUITY (placed first, ahead of the positive): proves the
// closure check actually bites — deleting the manifest's newest entry from a
// built snapshot makes (i) the scan-derived requirement report it missing
// and (ii) import()ing the copied return-lint.mjs from that scratch snapshot
// reject.
test('closure-test anti-vacuity: deleting hooks/dispatch-record.schema.json from a built snapshot makes the closure check report it missing and makes import() of the copied return-lint.mjs reject', async () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  const returnLintText = readFileSync(join(snapshotDir, 'hooks/return-lint.mjs'), 'utf8')
  const required = scanRequiredRefs('hooks/return-lint.mjs', returnLintText)
  assert.ok(required.has('hooks/dispatch-record.schema.json'), 'expected the scan to require hooks/dispatch-record.schema.json')

  unlinkSync(join(snapshotDir, 'hooks/dispatch-record.schema.json'))

  // (i) the closure check reports the destination as missing.
  const stillMissing = [...required].filter((ref) => !existsSync(join(snapshotDir, ref)))
  assert.deepEqual(stillMissing, ['hooks/dispatch-record.schema.json'])

  // (ii) import() of the copied return-lint.mjs rejects.
  await assert.rejects(() => import(pathToFileURL(join(snapshotDir, 'hooks/return-lint.mjs')).href))
})

test('import-closure: every copied .mjs\'s scan-derived static imports and module-load-time reads resolve to another manifest destination present in the same snapshot', () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  const destinations = new Set(Object.keys(WORKER_PLUGIN_MANIFEST))
  let scannedAny = false
  let totalRequired = 0

  for (const destRel of destinations) {
    if (!destRel.endsWith('.mjs')) continue
    scannedAny = true
    const text = readFileSync(join(snapshotDir, destRel), 'utf8')
    const required = scanRequiredRefs(destRel, text)
    totalRequired += required.size
    for (const ref of required) {
      assert.ok(destinations.has(ref), `${destRel} requires ${ref} at import/module-load time but it is not a manifest destination`)
      assert.ok(existsSync(join(snapshotDir, ref)), `${destRel} requires ${ref} but it is missing from the snapshot`)
    }
  }
  assert.ok(scannedAny, 'expected at least one copied .mjs to be scanned')
  // At least one required ref must have been found across the whole closure
  // (return-lint.mjs -> ladder.mjs/contract.mjs + dispatch-record.schema.json,
  // ladder.mjs -> contract.mjs/resolve.mjs + two schema reads) — otherwise
  // the scan itself would be vacuous.
  assert.ok(totalRequired > 0, 'expected the source-text scan to find at least one required reference across the copied .mjs files')
})

// SMOKE (module surface only — no argv[1] assumptions; the ESM loader
// realpaths import.meta.url, so comparing it against process.argv[1] is
// unreliable under a symlinked TMPDIR such as macOS's, which is exactly why
// 02a switched the gate to import() + main() rather than a direct-invocation
// check).
test('SMOKE: import()ing the snapshot copy of hooks/return-lint.mjs resolves, and its exported writeBlockedReturn produces bytes that pass ladder.validateReturn', async () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  const mod = await import(pathToFileURL(join(snapshotDir, 'hooks/return-lint.mjs')).href)
  assert.equal(typeof mod.writeBlockedReturn, 'function')

  const returnPath = join(root, 'returns', 'be-1a.1.json')
  const record = {
    dispatch_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    slice_id: 'be-1a',
    attempt: 1,
    role: 'build-validator',
    return: { kind: 'markdown', required_sections: ['Verdict'], verdict_block: true },
    task_dir: root,
    return_path: returnPath,
  }

  const writtenPath = mod.writeBlockedReturn(record, 'smoke test')
  assert.equal(writtenPath, returnPath)
  const text = readFileSync(returnPath, 'utf8')
  const result = validateReturn(record, text)
  assert.deepEqual(result.violations, [])
  assert.ok(result.ok)
})

// D-1 GUARD: hooks/dispatch-record.schema.json is copied for worker-side
// self-containment only — it is referenced by NO record field.
// record.return.schema_path still names the plugin-root source, and no
// path-valued record field other than role_prompt_path itself (which is,
// by definition, the snapshot artifact --plugin-dir points at) resolves
// inside dirname(dirname(role_prompt_path)).
test('D-1 guard: no record field other than role_prompt_path resolves inside the snapshot tree; return.schema_path still names the plugin-root source', () => {
  const rec = buildValidRecord()
  const workerTree = resolvePath(dirname(dirname(rec.role_prompt_path)))
  assert.equal(rec.return.schema_path, join(ROOT, 'coder-return.schema.json'))

  const otherPathFields = [
    rec.task_dir, rec.spec_path, rec.return_path, rec.signals_path,
    rec.primary_checkout, rec.cwd, rec.worktree.path, rec.return.schema_path,
  ]
  for (const p of otherPathFields) {
    const resolved = resolvePath(p)
    assert.notEqual(resolved, workerTree, `path field resolves to the snapshot tree itself: ${p}`)
    assert.equal(resolved.startsWith(`${workerTree}/`), false, `path field resolves inside the snapshot tree: ${p}`)
  }
})

// BYTE-STABILITY (extends the roles.coder-only check above): two snapshots
// into two DIFFERENT directories, built from two ctx objects differing only
// in dispatch_id/paths/now, produce byte-identical roles/<role>.txt and
// identical sha256 for every role and every WORKER_PLUGIN_MANIFEST file.
test('byte-stability: two snapshots in two different directories from ctx objects differing only in dispatch_id/paths/now are byte-identical for every role and every manifest file', () => {
  const { paths: pathsA } = makeCtxAndPaths({ root: makeTmpDir('cmux-record-'), now: 1754136000123 })
  const { paths: pathsB } = makeCtxAndPaths({ root: makeTmpDir('cmux-record-'), now: 1754999999999 })
  const snapA = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir: pathsA.snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })
  const snapB = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir: pathsB.snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  for (const role of Object.keys(rosterDefault.roles)) {
    const textA = readFileSync(snapA.roles[role].path, 'utf8')
    const textB = readFileSync(snapB.roles[role].path, 'utf8')
    assert.equal(textA, textB, `role prompt differs for role ${role}`)
    assert.equal(snapA.roles[role].sha256, snapB.roles[role].sha256, `sha256 differs for role ${role}`)
  }
  for (const destRel of Object.keys(WORKER_PLUGIN_MANIFEST)) {
    const bytesA = readFileSync(snapA.plugin[destRel].path)
    const bytesB = readFileSync(snapB.plugin[destRel].path)
    assert.ok(bytesA.equals(bytesB), `bytes differ for manifest file ${destRel}`)
    assert.equal(snapA.plugin[destRel].sha256, snapB.plugin[destRel].sha256, `sha256 differs for manifest file ${destRel}`)
  }
})

// R1 (contract #9): a long-lived executor worker's snapshot must never share
// a directory with a concurrent reviewer dispatch's snapshot. This is the
// explicit, named byte-stability test across two per-dispatch dirs differing
// ONLY in dispatch_id (same task, same paths, same roster) — the prior
// byte-stability test above varies paths/now too; this one isolates
// dispatch_id as the sole variable and additionally checks the root schema
// copies written INTO each per-dispatch dir (closes consider-item C3).
test('byte-stability across dispatches: two per-dispatch snapshot dirs differing ONLY in dispatch_id are byte-identical for every role, every manifest file, and every schema copy', () => {
  const root = makeTmpDir('cmux-record-')
  const roots = resolveRoots({ taskArtifactsRoot: join(root, 'dev-team') })
  const paths = taskPaths({ roots, repoSlug: 'sample-repo', taskSlug: 'sample-task' })
  const dirA = snapshotDirFor(paths, newDispatchId())
  const dirB = snapshotDirFor(paths, newDispatchId())
  assert.notEqual(dirA, dirB)

  const snapA = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir: dirA, roles: rosterDefault.roles, profiles: rosterDefault.profiles })
  const snapB = snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir: dirB, roles: rosterDefault.roles, profiles: rosterDefault.profiles })

  for (const role of Object.keys(rosterDefault.roles)) {
    const textA = readFileSync(snapA.roles[role].path, 'utf8')
    const textB = readFileSync(snapB.roles[role].path, 'utf8')
    assert.equal(textA, textB, `role prompt differs for role ${role}`)
    assert.equal(snapA.roles[role].sha256, snapB.roles[role].sha256, `sha256 differs for role ${role}`)
    assert.notEqual(snapA.roles[role].path, snapB.roles[role].path)
  }
  for (const destRel of Object.keys(WORKER_PLUGIN_MANIFEST)) {
    const bytesA = readFileSync(snapA.plugin[destRel].path)
    const bytesB = readFileSync(snapB.plugin[destRel].path)
    assert.ok(bytesA.equals(bytesB), `bytes differ for manifest file ${destRel}`)
    assert.equal(snapA.plugin[destRel].sha256, snapB.plugin[destRel].sha256, `sha256 differs for manifest file ${destRel}`)
  }
  for (const filename of Object.keys(snapA.schemas)) {
    // schemas[filename] is the PLUGIN-ROOT source path (D-1) — identical
    // across dispatches by construction — the snapshot COPY written into
    // each per-dispatch dir must also be byte-identical.
    const copyA = readFileSync(join(dirA, filename))
    const copyB = readFileSync(join(dirB, filename))
    assert.ok(copyA.equals(copyB), `root schema copy differs for ${filename}`)
  }
})

// Snapshot files must never carry a dispatch_id, an absolute state path, or a
// timestamp — every snapshot file is a pure function of on-disk plugin
// source, never of a particular dispatch.
test('snapshot files carry no dispatch_id, no absolute state path, and no timestamp (regex sweep over every written file)', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const snapshotDir = paths.snapshotDir

  const dispatchIdRe = new RegExp(escapeRegExp(ctx.dispatchId))
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/
  const absPathRe = new RegExp(escapeRegExp(paths.taskDir))

  function walk(dir) {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else out.push(full)
    }
    return out
  }

  for (const file of walk(snapshotDir)) {
    const text = readFileSync(file, 'utf8')
    assert.equal(dispatchIdRe.test(text), false, `${file} contains the dispatch_id`)
    assert.equal(uuidRe.test(text), false, `${file} contains a uuid-shaped literal`)
    assert.equal(isoRe.test(text), false, `${file} contains an ISO timestamp`)
    assert.equal(absPathRe.test(text), false, `${file} contains an absolute state path`)
  }
})

// trust M4: readRecord validates against dispatch-record.schema.json and
// throws a named RecordInvalidError carrying the violations.
test('trust M4: readRecord throws RecordInvalidError for a hand-edited record with a bogus outcome enum value', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const rec = buildValidRecord()
  writeFileSync(path, JSON.stringify({ ...rec, outcome: 'not-a-real-outcome' }))
  let caught = null
  try {
    readRecord(path)
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof RecordInvalidError)
  assert.equal(caught.path, path)
  assert.ok(caught.violations.some((v) => v.path === '$.outcome'))
})

test('trust M4: readRecord throws RecordInvalidError for a hand-edited record missing created_at', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const rec = buildValidRecord()
  delete rec.created_at
  writeFileSync(path, JSON.stringify(rec))
  assert.throws(() => readRecord(path), RecordInvalidError)
})

test('trust M4: readRecord throws RecordInvalidError when profile.allow contains a non-RULE string', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const rec = buildValidRecord()
  rec.profile.allow.push('rm -rf /')
  writeFileSync(path, JSON.stringify(rec))
  let caught = null
  try {
    readRecord(path)
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof RecordInvalidError)
  assert.ok(caught.violations.some((v) => v.path.startsWith('$.profile.allow[')))
})

// trust M5-B: every derived snapshot path goes through a containment
// assertion (assertWithinDir) before any mkdir/write. Construct a traversal
// role key directly (loadRoster rejects such a key upstream — this test
// proves the builder's OWN gate, defense-in-depth independent of that).
// path.join() normalizes '..' away at call time, so the traversal must be
// embedded in the ROLE KEY itself (mirroring the review's verified
// join('<pluginRoot>','agents','../../../../tmp/evil.md') example) — a
// post-join scan for a literal '..' segment would never see it.
test('trust M5-B: a traversal role key throws before any filesystem effect', () => {
  const root = makeTmpDir('cmux-record-')
  const snapshotDir = join(root, 'worker-plugin')
  const evilStem = join(tmpdir(), `cmux-m5b-pwn-${process.pid}-${Date.now()}`)
  const evilTarget = `${evilStem}.txt`
  assert.equal(existsSync(evilTarget), false)

  const traversal = '../'.repeat(20)
  const hostileRole = `${traversal}${evilStem.slice(1)}`
  const hostileRoles = { [hostileRole]: { profile: 'executor', return: { kind: 'markdown' } } }

  assert.throws(() => snapshotWorkerPlugin({ pluginRoot: ROOT, snapshotDir, roles: hostileRoles, profiles: rosterDefault.profiles }))
  assert.equal(existsSync(evilTarget), false)
  assert.equal(existsSync(snapshotDir), false, 'expected no filesystem effect at all before the throw')
})

// lifecycle M2-B: terminateRecord(path, outcome, now, { allowUnbound })
// permits 'aborted' on an unbound record; all other outcomes on unbound
// still refuse.
test('lifecycle M2-B: terminateRecord permits \'aborted\' on an unbound record when { allowUnbound: true }', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)

  const created = readRecord(path)
  assert.equal(created.surface, null)

  const terminated = terminateRecord(path, 'aborted', Date.now(), { allowUnbound: true })
  assert.equal(terminated.outcome, 'aborted')
  assert.notEqual(terminated.ended_at, null)
  assert.equal(terminated.surface, null)
  assert.deepEqual(validate(dispatchRecordSchema, terminated), [])
})

test('lifecycle M2-B: every outcome other than \'aborted\' still refuses on an unbound record, even with { allowUnbound: true }', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)

  for (const outcome of OUTCOMES.filter((o) => o !== 'aborted')) {
    assert.throws(() => terminateRecord(path, outcome, Date.now(), { allowUnbound: true }), `expected outcome ${outcome} to still refuse unbound`)
  }
})

test('lifecycle M2-B: without { allowUnbound: true }, \'aborted\' on an unbound record still refuses (backward compatible default)', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  assert.throws(() => terminateRecord(path, 'aborted'))
})

// lifecycle M3: genuine exclusive create — writeFileSync(tmp) -> linkSync ->
// unlink(tmp), replacing the existsSync+rename pair.
test('lifecycle M3: writeRecord refuses a pre-created destination, leaves it byte-identical, and leaves no .tmp behind', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const recA = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'PRE-EXISTING-NOT-A-RECORD')
  const before = readFileSync(path, 'utf8')

  assert.throws(() => writeRecord(recA, path), /already exists/)
  assert.equal(readFileSync(path, 'utf8'), before)
  const leftoverTmp = readdirSync(dirname(path)).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftoverTmp, [])
})

test('lifecycle M3: two-writer simulation for the same stem — exactly one record survives, byte-identical to the winner', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const path = join(paths.dispatchDir, 'be-1a.1.json')

  // Two "writers" building genuinely different record payloads for the same
  // stem (different dispatch_id), simulating a concurrent same-slice
  // dispatch race rather than a single writer calling writeRecord twice.
  const recA = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const { ctx: ctxB } = makeCtxAndPaths({ root, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug })
  const recB = buildRecord(ctxB, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  assert.notEqual(recA.dispatch_id, recB.dispatch_id)

  writeRecord(recA, path)
  assert.throws(() => writeRecord(recB, path))

  const survivor = readRecord(path)
  assert.equal(survivor.dispatch_id, recA.dispatch_id)
  assert.notEqual(survivor.dispatch_id, recB.dispatch_id)
  const leftoverTmp = readdirSync(dirname(path)).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftoverTmp, [])
})

// lifecycle M4: withRecordLock — exclusive-create <path>.lock ('wx') carrying
// {pid, started_at}, released in finally only when pid+started_at still
// match; stale = older than 30s; corrupt lock file = stale, not a wedge.
test('lifecycle M4: withRecordLock runs fn and releases the lock on success', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const result = withRecordLock(path, () => 'ran')
  assert.equal(result, 'ran')
  assert.equal(existsSync(`${path}.lock`), false)
})

test('lifecycle M4: withRecordLock releases the lock even when fn throws', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  assert.throws(() => withRecordLock(path, () => { throw new Error('boom') }), /boom/)
  assert.equal(existsSync(`${path}.lock`), false)
})

test('lifecycle M4: a nested/concurrent call on the same path throws RecordLockError while the lock is fresh', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  assert.throws(() => {
    withRecordLock(path, () => {
      withRecordLock(path, () => {})
    })
  }, RecordLockError)
})

test('lifecycle M4: a lock older than 30s is stolen as stale, not treated as a wedge', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: Date.now() - 40_000 }))
  const result = withRecordLock(path, () => 'ran')
  assert.equal(result, 'ran')
})

test('lifecycle M4: a corrupt lock file is treated as stale (stolen), not a wedge', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(lockPath, '{ not valid json')
  const result = withRecordLock(path, () => 'ran')
  assert.equal(result, 'ran')
})

test('lifecycle M4: a superseded holder does not delete a new holder\'s lock (released only if pid+started_at still match)', () => {
  const path = join(makeTmpDir('cmux-record-'), 'be-1a.1.json')
  const lockPath = `${path}.lock`
  withRecordLock(path, () => {
    // Simulate a new holder stealing the (now-stale-looking) lock mid-flight.
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, started_at: Date.now() }))
  })
  const remaining = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(remaining.pid, 424242)
})

test('lifecycle M4: bindRecord throws RecordLockError when the record is locked by another fresh writer', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, started_at: Date.now() }), { flag: 'wx' })

  assert.throws(() => bindRecord(path, {
    workspace_id: 'aabb2222-2222-2222-2222-222222222222',
    pane_id: 'aabb3333-3333-3333-3333-333333333333',
    surface_id: 'aabb4444-4444-4444-4444-444444444444',
  }), RecordLockError)
})

test('lifecycle M4: terminateRecord throws RecordLockError when the record is locked by another fresh writer', () => {
  const path = makeBoundRecord(makeTmpDir('cmux-record-'))
  const ids = { workspace_id: 'aabb2222-2222-2222-2222-222222222222', pane_id: 'aabb3333-3333-3333-3333-333333333333', surface_id: 'aabb4444-4444-4444-4444-444444444444' }
  bindRecord(path, ids)
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, started_at: Date.now() }), { flag: 'wx' })

  assert.throws(() => terminateRecord(path, 'ok'), RecordLockError)
})

// lifecycle M5: listRecords(dir, { onUnreadable }) per-entry try/catch —
// unreadable entries invoke the callback and are skipped; signature is
// backward-compatible (the earlier "ignores *.tmp" test omits the option).
test('lifecycle M5: one valid record + one schema-invalid record yields one record, one onUnreadable callback, and never throws', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  writeRecord(rec, join(paths.dispatchDir, 'be-1a.1.json'))
  writeFileSync(join(paths.dispatchDir, 'be-1b.1.json'), '{ truncated garbage, not json')

  const unreadable = []
  const records = listRecords(paths.dispatchDir, { onUnreadable: (entry) => unreadable.push(entry) })

  assert.equal(records.length, 1)
  assert.equal(records[0].slice_id, 'be-1a')
  assert.equal(unreadable.length, 1)
  assert.ok(unreadable[0].path.endsWith('be-1b.1.json'))
  assert.ok(unreadable[0].error instanceof Error)
})

test('lifecycle M5: an onUnreadable callback fires for a schema-invalid (but syntactically valid JSON) committed record', () => {
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  writeRecord(rec, join(paths.dispatchDir, 'be-1a.1.json'))
  const badRec = { ...rec, outcome: 'not-a-real-outcome' }
  writeFileSync(join(paths.dispatchDir, 'be-1b.1.json'), JSON.stringify(badRec))

  const unreadable = []
  const records = listRecords(paths.dispatchDir, { onUnreadable: (entry) => unreadable.push(entry) })
  assert.equal(records.length, 1)
  assert.equal(unreadable.length, 1)
  assert.ok(unreadable[0].error instanceof RecordInvalidError)
})

// trust S2-B: buildArgv sweeps every argv element for \n or \r and throws.
test('trust S2-B: buildArgv throws when an argv element (model) contains a newline', () => {
  const rec = buildValidRecord()
  const hostile = { ...rec, model: 'sonn\net' }
  assert.throws(() => buildArgv(hostile), /newline or carriage return/)
})

test('trust S2-B: buildArgv throws when an argv element contains a carriage return', () => {
  const rec = buildValidRecord()
  const hostile = { ...rec, model: 'sonn\ret' }
  assert.throws(() => buildArgv(hostile), /newline or carriage return/)
})

// vacuity S7: pin the FULL composed kickoff shape, not just the presence of
// its seven values — the key spellings and the trailing cmux notify
// instruction are the contract a renamed key or a dropped trailer would
// silently break.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('vacuity S7: the composed kickoff pins the full shape (key spellings + trailing cmux notify instruction), not just value presence', () => {
  const rec = buildValidRecord()
  const expected = new RegExp(
    '^Dispatch '
    + `${escapeRegExp(rec.dispatch_id)}\\. `
    + `task_dir=${escapeRegExp(rec.task_dir)} `
    + `spec_path=${escapeRegExp(rec.spec_path)} `
    + `return_path=${escapeRegExp(rec.return_path)} `
    + `signals_path=${escapeRegExp(rec.signals_path)} `
    + `attn_parent=${escapeRegExp(rec.attn_parent)} `
    + `attn_upstream=${escapeRegExp(rec.attn_upstream)}\\. `
    + 'Read spec_path, do the work, write your ReturnEnvelope to return_path, then run: '
    + `cmux notify --title ${escapeRegExp(rec.attn_parent)} -- done$`,
  )
  assert.match(rec.kickoff, expected)
})

// vacuity S10: make the atomicity assertion real — "no leftover .tmp" alone
// is vacuous (a plain writeFileSync(path, data) replacement, no tmp, no
// atomic link, would also leave no stray .tmp). Runtime interception was the
// fix-plan's suggested approach ("spy the rename"), but Node's builtin
// `node:fs` ESM named imports are bound at the IMPORTING module's own
// evaluation time — mutating `fs.linkSync` afterwards (verified empirically:
// re-importing record.mjs via a fresh cache-busted URL after patching still
// does not observe the patch) does not intercept record.mjs's own bound
// `linkSync`/`writeFileSync` references. A source-level structural pin is
// the honest alternative here, in the same spirit as this file's own
// BUDGET/PROTECTED_PATH_COMPONENTS drift guards (test/cmux-contract.test.mjs)
// — it directly falsifies the exact regression named: a plain overwrite (no
// tmp, `renameSync`-only, or no `linkSync` at all) would still pass every
// OTHER test in this suite while losing exclusivity/atomicity.
test('vacuity S10: writeRecord\'s create path is a genuine exclusive hard-link (not a plain overwrite), with a same-directory-by-construction tmp name', () => {
  const src = readFileSync(join(ROOT, 'scripts/cmux/record.mjs'), 'utf8')
  const fnMatch = src.match(/export function writeRecord\(record, path\) \{[\s\S]*?\n\}\n/)
  assert.ok(fnMatch, 'expected to locate the writeRecord function body in scripts/cmux/record.mjs')
  const body = fnMatch[0]

  // The tmp path is built from `path` itself via a template literal — this
  // makes dirname(tmp) === dirname(path) BY CONSTRUCTION, not by convention.
  assert.match(body, /const tmp = `\$\{path\}\./)
  // The create transition must go through linkSync (fails EEXIST atomically)
  // — not renameSync (which unconditionally clobbers an existing file, the
  // exact TOCTOU lifecycle M3 fixed) and not a bare writeFileSync(path, …).
  assert.match(body, /linkSync\(tmp, path\)/)
  assert.doesNotMatch(body, /renameSync\(/)
  assert.doesNotMatch(body, /writeFileSync\(path,/)

  // Runtime sanity: a real write leaves the destination fully parseable and
  // no tmp debris — necessary (if not sufficient on its own) alongside the
  // structural pin above.
  const root = makeTmpDir('cmux-record-')
  const { ctx, paths } = makeCtxAndPaths({ root })
  const rec = buildRecord(ctx, { role: 'coder', sliceId: 'be-1a', attempt: 1, spec: { validation_commands: [] } })
  const path = join(paths.dispatchDir, 'be-1a.1.json')
  writeRecord(rec, path)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).dispatch_id, rec.dispatch_id)
  assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.includes('.tmp')), [])
})
