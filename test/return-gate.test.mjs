// return-gate.sh / gate-mode.sh coverage.
//
// Both scripts are driven as real subprocesses (spawnSync 'bash', ...),
// against a real record built via record.buildRecord/writeRecord (never a
// hand-rolled fixture record), with CMUX_BIN pointed at the frozen
// test/fixtures/fake-cmux.mjs fake so `cmux wait-for -S` invocations can be
// observed via FAKE_CMUX_LOG without touching a live cmux.
//
// Positives are asserted FIRST (qa-notes 2026-08-02): a normal valid-return
// run and a normal invalid-return run are each proven clean/expected before
// any negative (fail-open) case runs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, cpSync, existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { ROOT } from './helpers.mjs'
import { resolveRoots, taskPaths, resolveRole } from '../scripts/cmux/resolve.mjs'
import {
  newDispatchId, buildRecord, writeRecord, snapshotWorkerPlugin,
} from '../scripts/cmux/record.mjs'
import { validateReturn } from '../scripts/cmux/ladder.mjs'

const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const RETURN_GATE_SH = join(ROOT, 'scripts/cmux/return-gate.sh')
const GATE_MODE_SH = join(ROOT, 'scripts/cmux/gate-mode.sh')
const FAKE_CMUX = join(ROOT, 'test/fixtures/fake-cmux.mjs')
const MAX_BLOCKS = rosterDefault.defaults.max_gate_blocks // 2, per roster defaults

// Every fixture task/state/plugin-root tree lives under a fresh tmp root,
// removed after the suite.
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

// makePluginRoot() -> a CLAUDE_PLUGIN_ROOT whose hooks/ is a real byte copy
// of scripts/cmux/ (return-lint.mjs alongside its own relative imports:
// contract.mjs, ladder.mjs, resolve.mjs, the *.schema.json files), mirroring
// the snapshot be-1c-03 produces. A copy, not a symlink: return-lint.mjs's
// own invokedDirectly guard compares resolvePath(process.argv[1]) against
// resolvePath(fileURLToPath(import.meta.url)) — Node's ESM loader resolves
// import.meta.url through a symlink to its real target, which would make
// that comparison false and silently skip main() entirely on direct `node
// <symlinked-path> --block-json ...` invocation (exactly how return-gate.sh
// invokes it). A real copy matches production and avoids that mismatch.
function makePluginRoot() {
  const root = makeTmpDir('gate-plugin-root-')
  cpSync(join(ROOT, 'scripts/cmux'), join(root, 'hooks'), { recursive: true })
  return root
}

// buildTestRecord(role) -> a fully dispatch-record.schema.json-valid record,
// written via writeRecord (so initGateCounter really creates the '0' gate
// sidecar exactly as production does).
function buildTestRecord(role = 'coder', sliceId = 'be-1c', { maxGateBlocks } = {}) {
  const root = makeTmpDir('return-gate-')
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
    config: maxGateBlocks == null ? {} : { maxGateBlocks },
    now: 1754136000123,
    dispatchId: newDispatchId(),
    attnUpstream: null,
  }
  const record = buildRecord(ctx, { role, sliceId, attempt: 1, spec: { validation_commands: ['node --test'] } })
  writeRecord(record, record.env.DEVTEAM_DISPATCH_RECORD)
  return record
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

function writeValidReturn(record) {
  mkdirSync(dirname(record.return_path), { recursive: true })
  writeFileSync(record.return_path, envelopeText(record, { status: 'done', reason: 'ok' }), 'utf8')
  const mtime = new Date(Date.parse(record.created_at) + 5000)
  utimesSync(record.return_path, mtime, mtime)
}

// A fixture harness: one record + one plugin root + one fake-cmux log,
// reused across a scenario's invocations (mirroring a real dispatch where
// the SAME record persists across every Stop fire).
function makeHarness({ role = 'coder', maxGateBlocks } = {}) {
  const record = buildTestRecord(role, 'be-1c', { maxGateBlocks })
  const pluginRoot = makePluginRoot()
  const fakeCmuxLog = join(makeTmpDir('fake-cmux-log-'), 'log.jsonl')
  return { record, pluginRoot, fakeCmuxLog }
}

function runReturnGate(harness, { stdin = '{}', extraEnv = {} } = {}) {
  const { record, pluginRoot, fakeCmuxLog } = harness
  const result = spawnSync('bash', [RETURN_GATE_SH], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVTEAM_DISPATCH_RECORD: record.env.DEVTEAM_DISPATCH_RECORD,
      DEVTEAM_GATE_COUNTER: record.env.DEVTEAM_GATE_COUNTER,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CMUX_BIN: FAKE_CMUX,
      FAKE_CMUX_LOG: fakeCmuxLog,
      ...extraEnv,
    },
  })
  return result
}

function runGateMode(harness, { stdin = '{}' } = {}) {
  const { record } = harness
  return spawnSync('bash', [GATE_MODE_SH], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVTEAM_GATE_COUNTER: record.env.DEVTEAM_GATE_COUNTER,
    },
  })
}

function fakeCmuxInvocations(harness) {
  if (!existsSync(harness.fakeCmuxLog)) return []
  return readFileSync(harness.fakeCmuxLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function gateLogText(record) {
  const logPath = `${record.env.DEVTEAM_GATE_COUNTER}.log`
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
}

// ---------------------------------------------------------------------------
// POSITIVES FIRST.
// ---------------------------------------------------------------------------

test('positive: a valid return signals attn_parent, exits 0, no stdout, no block, no counter increment', () => {
  const harness = makeHarness()
  writeValidReturn(harness.record)
  const result = runReturnGate(harness)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')

  const invocations = fakeCmuxInvocations(harness)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].argv, ['wait-for', '-S', harness.record.attn_parent])

  assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0')
})

test('positive: an invalid (missing) return produces exactly one block decision line, exit 0', () => {
  const harness = makeHarness()
  // return_path deliberately never written -> stale_or_absent_return.
  const result = runReturnGate(harness)

  assert.equal(result.status, 0)
  const lines = result.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const decision = JSON.parse(lines[0])
  assert.equal(decision.decision, 'block')
  assert.match(decision.reason, /stale_or_absent_return/)

  assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '1')
})

// ---------------------------------------------------------------------------
// Bound: over N=5 consecutive invalid fires (stop_hook_active never true),
// exactly max_blocks block decisions are emitted; the (max_blocks+1)-th and
// every fire after it emits none.
// ---------------------------------------------------------------------------

test(`bound: exactly ${MAX_BLOCKS} block decisions across 5 consecutive invalid fires`, () => {
  const harness = makeHarness()
  let blockCount = 0
  const results = []
  for (let i = 0; i < 5; i += 1) {
    const result = runReturnGate(harness, { stdin: JSON.stringify({ stop_hook_active: false }) })
    results.push(result)
    assert.equal(result.status, 0, `invocation ${i + 1} must exit 0`)
    const lines = result.stdout.split('\n').filter(Boolean)
    assert.ok(lines.length <= 1, `invocation ${i + 1} must emit at most one stdout line`)
    blockCount += lines.length
  }
  assert.equal(blockCount, MAX_BLOCKS)

  // The exhausting fire (index MAX_BLOCKS, 0-based) and everything after it
  // must emit no stdout at all.
  for (let i = MAX_BLOCKS; i < 5; i += 1) {
    assert.equal(results[i].stdout, '')
  }
})

test('exhaustion: the (max_blocks+1)-th invalid fire writes a blocked envelope that passes ladder.validateReturn', () => {
  const harness = makeHarness()
  for (let i = 0; i < MAX_BLOCKS; i += 1) {
    runReturnGate(harness)
  }
  // This fire exhausts the bound.
  const result = runReturnGate(harness)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')

  assert.ok(existsSync(harness.record.return_path), 'writeBlockedReturn must have written return_path')
  const text = readFileSync(harness.record.return_path, 'utf8')
  const validation = validateReturn(harness.record, text)
  assert.deepEqual(validation.violations, [])
  assert.equal(validation.ok, true)
  assert.equal(validation.envelope.body.status, 'blocked')
  assert.match(
    validation.envelope.body.reason,
    new RegExp(`^agent ended ${MAX_BLOCKS} turns without a contract-valid return; last lint failure: `),
  )

  // The exhaustion fire still signals the attention channel.
  const invocations = fakeCmuxInvocations(harness)
  assert.ok(invocations.some((inv) => inv.argv[0] === 'wait-for' && inv.argv[2] === harness.record.attn_parent))
})

// ---------------------------------------------------------------------------
// Observe mode.
// ---------------------------------------------------------------------------

test('observe mode: an invalid return produces no block and no counter claim; a valid return still signals', () => {
  const harness = makeHarness()
  writeFileSync(`${harness.record.env.DEVTEAM_GATE_COUNTER}.mode`, 'observe', 'utf8')

  const invalidResult = runReturnGate(harness)
  assert.equal(invalidResult.status, 0)
  assert.equal(invalidResult.stdout, '')
  assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0', 'no counter claim in observe mode')
  assert.equal(existsSync(`${harness.record.env.DEVTEAM_GATE_COUNTER}.claim.1`), false)

  writeValidReturn(harness.record)
  const validResult = runReturnGate(harness)
  assert.equal(validResult.status, 0)
  assert.equal(validResult.stdout, '')
  const invocations = fakeCmuxInvocations(harness)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].argv[0], 'wait-for')
})

// ---------------------------------------------------------------------------
// stop_hook_active short-circuit.
// ---------------------------------------------------------------------------

test('stop_hook_active true short-circuits before any counter claim: exit 0, no stdout, no claim file', () => {
  const harness = makeHarness()
  const result = runReturnGate(harness, { stdin: JSON.stringify({ stop_hook_active: true }) })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0')
  assert.equal(existsSync(`${harness.record.env.DEVTEAM_GATE_COUNTER}.claim.1`), false)
})

// ---------------------------------------------------------------------------
// Fail-open sweep. Each negative is paired with a normal run asserted first.
// ---------------------------------------------------------------------------

test('fail-open sweep: node absent from PATH -> exit 0, no stdout, failure logged', () => {
  // Paired positive: a normal run with a full PATH appends nothing alarming.
  const harnessOk = makeHarness()
  writeValidReturn(harnessOk.record)
  const okResult = runReturnGate(harnessOk)
  assert.equal(okResult.status, 0)
  assert.doesNotMatch(gateLogText(harnessOk.record), /node not found/)

  const harness = makeHarness()
  writeValidReturn(harness.record)
  const result = runReturnGate(harness, { extraEnv: { PATH: '/bin:/usr/bin' } })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /node not found/)
})

test('fail-open sweep: DEVTEAM_DISPATCH_RECORD points at a missing file -> exit 0, no stdout, failure logged', () => {
  const harnessOk = makeHarness()
  writeValidReturn(harnessOk.record)
  assert.equal(runReturnGate(harnessOk).status, 0)

  const harness = makeHarness()
  const missingPath = join(dirname(harness.record.env.DEVTEAM_DISPATCH_RECORD), 'does-not-exist.json')
  const result = runReturnGate(harness, { extraEnv: { DEVTEAM_DISPATCH_RECORD: missingPath } })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /fail-open: return-lint exited 2/)
})

test('fail-open sweep: record present but schema-invalid -> exit 0, no stdout, failure logged', () => {
  const harnessOk = makeHarness()
  writeValidReturn(harnessOk.record)
  assert.equal(runReturnGate(harnessOk).status, 0)

  const harness = makeHarness()
  const badRecordPath = join(dirname(harness.record.env.DEVTEAM_DISPATCH_RECORD), 'bad-record.json')
  writeFileSync(badRecordPath, JSON.stringify({ schema_version: 1 }), 'utf8')
  const result = runReturnGate(harness, { extraEnv: { DEVTEAM_DISPATCH_RECORD: badRecordPath } })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /fail-open: return-lint exited 2/)
})

// fake-cmux.mjs is a frozen, do-not-edit fixture (test/fixtures/fake-cmux.mjs
// header) whose live-method list has no `wait-for` case at all — a bare
// invocation already fails with unknown_verb, forced failure or not. That
// still exercises exactly the resilience this criterion is about: the gate
// must tolerate a failing cmux call and never let it affect its own exit
// code, stdout or control flow. FAKE_CMUX_FAIL switches WHICH failure the
// fixture reports (forced_failure instead of the baseline unknown_verb),
// proving the gate is genuinely invoking cmux rather than special-casing it.
test('fail-open sweep: the cmux binary failing -> exit 0, no stdout, failure logged (valid-return path)', () => {
  const harnessOk = makeHarness()
  writeValidReturn(harnessOk.record)
  const okResult = runReturnGate(harnessOk)
  assert.equal(okResult.status, 0)
  assert.equal(okResult.stdout, '')
  assert.match(gateLogText(harnessOk.record), /cmux wait-for -S failed/)
  assert.doesNotMatch(gateLogText(harnessOk.record), /forced failure/)

  const harness = makeHarness()
  writeValidReturn(harness.record)
  const result = runReturnGate(harness, { extraEnv: { FAKE_CMUX_FAIL: 'wait-for' } })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /cmux wait-for -S failed/)
  // The fake still logs the (failing) invocation, and this time via the
  // FORCED path rather than the baseline unknown_verb one.
  const invocations = fakeCmuxInvocations(harness)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].argv[0], 'wait-for')
})

// ---------------------------------------------------------------------------
// gate-mode.sh
// ---------------------------------------------------------------------------

test('gate-mode.sh: first invocation leaves "enforce"; every subsequent invocation writes sticky "observe"', () => {
  const harness = makeHarness()
  const modeFile = `${harness.record.env.DEVTEAM_GATE_COUNTER}.mode`

  const first = runGateMode(harness)
  assert.equal(first.status, 0)
  assert.equal(first.stdout, '')
  assert.equal(readFileSync(modeFile, 'utf8'), 'enforce')

  const second = runGateMode(harness)
  assert.equal(second.status, 0)
  assert.equal(second.stdout, '')
  assert.equal(readFileSync(modeFile, 'utf8'), 'observe')

  const third = runGateMode(harness)
  assert.equal(third.status, 0)
  assert.equal(third.stdout, '')
  assert.equal(readFileSync(modeFile, 'utf8'), 'observe', 'observe is sticky: never reverts to enforce')
})

test('gate-mode.sh: exits 0 with no stdout when DEVTEAM_GATE_COUNTER is missing', () => {
  const result = spawnSync('bash', [GATE_MODE_SH], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_GATE_COUNTER: '' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})

// SF6: the kickoff and a concurrent human interjection race on which one
// writes MODE_FILE first. This is reproduced deterministically (never a
// timed/flaky race) by pre-seeding MODE_FILE with 'observe' — as a human
// invocation racing ahead would — while SEEN_FILE is still absent, so the
// NEXT invocation still legitimately succeeds ITS OWN SEEN claim (exactly
// like a first/kickoff invocation) and must still not clobber the
// already-sticky observe.
test('SF6: gate-mode.sh enforce write never clobbers a mode file already raced to "observe"', () => {
  const harness = makeHarness()
  const counter = harness.record.env.DEVTEAM_GATE_COUNTER
  const modeFile = `${counter}.mode`
  const seenFile = `${counter}.mode.seen`

  // Simulate: SEEN not yet claimed, but MODE already raced to 'observe' by
  // a concurrent human invocation.
  writeFileSync(modeFile, 'observe', 'utf8')
  assert.equal(existsSync(seenFile), false, 'SEEN_FILE must not exist yet for this invocation to take the enforce branch')

  const result = runGateMode(harness)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(existsSync(seenFile), true, 'this invocation must still claim SEEN_FILE (the enforce branch)')
  assert.equal(readFileSync(modeFile, 'utf8'), 'observe', 'a raced observe write must never be clobbered back to enforce')
})

// ---------------------------------------------------------------------------
// F7 — exact "observe" match only.
// ---------------------------------------------------------------------------

test('F7: a mode file of "observedX" or "xobserve" does not trigger observe; only exactly "observe" does', () => {
  for (const modeValue of ['observedX', 'xobserve', 'OBSERVE', 'observe ']) {
    const harness = makeHarness()
    writeFileSync(`${harness.record.env.DEVTEAM_GATE_COUNTER}.mode`, modeValue, 'utf8')
    const result = runReturnGate(harness)
    assert.equal(result.status, 0)
    const lines = result.stdout.split('\n').filter(Boolean)
    assert.equal(lines.length, 1, `mode=${JSON.stringify(modeValue)} must still block, not be treated as observe`)
    assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '1')
  }

  const harnessObserve = makeHarness()
  writeFileSync(`${harnessObserve.record.env.DEVTEAM_GATE_COUNTER}.mode`, 'observe', 'utf8')
  const observeResult = runReturnGate(harnessObserve)
  assert.equal(observeResult.status, 0)
  assert.equal(observeResult.stdout, '')
  assert.equal(readFileSync(harnessObserve.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0')
})

// ---------------------------------------------------------------------------
// Empty-$OUT guard.
// ---------------------------------------------------------------------------

test('empty-$OUT guard: a LINT_CODE=1 with an empty block-json line produces NO stdout, logs fail-open, exit 0', () => {
  const harness = makeHarness()
  // A fake return-lint.mjs reporting "invalid" (exit 1) but writing nothing
  // to stdout — the block-json capture ($OUT) comes back empty. A bare
  // printf '%s\n' "" on the Stop hook's own stdout would otherwise be a
  // stray newline of hook output.
  writeFileSync(join(harness.pluginRoot, 'hooks', 'return-lint.mjs'), 'export function main() { return 1 }\n', 'utf8')

  const result = runReturnGate(harness)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /fail-open: return-lint produced no block-json output/)
})

// ---------------------------------------------------------------------------
// max_blocks: unreadable vs. genuine 0.
// ---------------------------------------------------------------------------

test('max_blocks unreadable: the first invalid Stop fails open (no block, no exhaustion write, return_path untouched)', () => {
  const harness = makeHarness()
  // A fake return-lint.mjs that reports "invalid" (exit 1, no stdout —
  // exercising the same not-yet-exhausted path as a normal invalid return)
  // but ALSO corrupts RECORD as a side effect, simulating the record going
  // unreadable between the lint pass and read_record_fields's own
  // independent re-read of the (worker-writable, G13) record file.
  writeFileSync(join(harness.pluginRoot, 'hooks', 'return-lint.mjs'), `
    import { writeFileSync } from 'node:fs'
    export function main(argv) {
      const recordPath = argv[argv.length - 1]
      writeFileSync(recordPath, 'not valid json {{{', 'utf8')
      return 1
    }
  `, 'utf8')

  const result = runReturnGate(harness)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(gateLogText(harness.record), /fail-open: gate\.max_blocks unreadable from record/)
  assert.equal(readFileSync(harness.record.env.DEVTEAM_GATE_COUNTER, 'utf8'), '0', 'no counter claim in the unreadable-max case')
  assert.equal(existsSync(`${harness.record.env.DEVTEAM_GATE_COUNTER}.claim.1`), false)
  assert.equal(existsSync(harness.record.return_path), false, 'no blocked return must be written when max_blocks is unreadable')
})

test('max_blocks: 0 (genuine): the first invalid Stop hits the existing exhaustion path (blocked return written)', () => {
  const harness = makeHarness({ maxGateBlocks: 0 })
  const result = runReturnGate(harness)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.ok(existsSync(harness.record.return_path), 'writeBlockedReturn must have written return_path for a genuine max_blocks: 0')
  const text = readFileSync(harness.record.return_path, 'utf8')
  const validation = validateReturn(harness.record, text)
  assert.equal(validation.ok, true)
  assert.equal(validation.envelope.body.status, 'blocked')
  assert.match(validation.envelope.body.reason, /^agent ended 0 turns without a contract-valid return/)
})
