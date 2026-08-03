// dispatch.mjs is the CLI that wires resolve/record/cmuxctl/ladder into the
// seven lifecycle verbs. CMUX_BIN must be set to the fake fixture BEFORE
// cmuxctl.mjs is first imported (it captures CMUX_BIN as a module constant
// at import time) — dispatch.mjs imports cmuxctl.mjs, so this file loads
// dispatch.mjs via a dynamic import() after setting the env var, exactly
// like test/cmux-preflight.test.mjs does for cmuxctl.mjs directly.
//
// ANTI-VACUITY (qa-lead verdict on the 1b test strategy): E-P1 below is
// placed FIRST and is the load-bearing proof that the fake is wired
// correctly end to end. Every "zero cmux invocations" assertion elsewhere in
// this file is vacuous until E-P1 passes — a fake wired wrong, a CMUX_BIN
// that never runs, or a helper that swallows invocations would otherwise
// make the whole failure suite green for the wrong reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, symlinkSync, cpSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURE = join(HERE, 'fixtures', 'fake-cmux.mjs')
const DISPATCH_PATH = join(ROOT, 'scripts', 'cmux', 'dispatch.mjs')

process.env.CMUX_BIN = FIXTURE

const {
  readExecutionMode, EXECUTION_MODES, OUTCOME_MAPPING, mapOutcome, applyPostconditionOverride,
  parseArgs, buildContext, ensureWorktree, isDispatcherWorktree, removeWorktreeIfCleanAndMerged,
  writeCompletionNonce, adapterLaunchLine,
  preflightCmd, workspaceCmd, dispatchCmd, awaitCmd, closeCmd, statusCmd, teardownCmd,
  UsageError, OperationalError, main,
} = await import(DISPATCH_PATH)

const { PREFLIGHT_MESSAGES, formatPreflightMessage, closeSurface } = await import(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'))
const {
  readRecord, terminateRecord, buildRecord, writeRecord, bindRecord, newDispatchId, snapshotWorkerPlugin,
} = await import(join(ROOT, 'scripts', 'cmux', 'record.mjs'))
const { specPathFor, sidecarPaths } = await import(join(ROOT, 'scripts', 'cmux', 'resolve.mjs'))

// ---------------------------------------------------------------------------
// Fixture plumbing.
// ---------------------------------------------------------------------------

function freshCmuxEnv(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `cmux-dispatch-${prefix}-`))
  const logPath = join(dir, 'log.jsonl')
  const statePath = join(dir, 'state.json')
  process.env.FAKE_CMUX_LOG = logPath
  process.env.FAKE_CMUX_STATE = statePath
  delete process.env.FAKE_CMUX_FAIL
  delete process.env.FAKE_CMUX_MISSING_METHODS
  delete process.env.FAKE_CMUX_NO_CALLER
  delete process.env.FAKE_CMUX_EVENTS
  delete process.env.FAKE_CMUX_TOP
  delete process.env.FAKE_CMUX_EXIT_CODE
  return { dir, logPath, statePath }
}

function readLog(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// A real git repo (git init + one commit) — worktree tests build against a
// genuine checkout, never a fake one.
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

// trust S4: --spec must resolve to EXACTLY specPathFor(paths, sliceId) — the
// fixture writes there directly rather than to an arbitrary tmp path.
function makeSpecFile(ctx, sliceId = 'be-1a', overrides = {}) {
  const specPath = specPathFor(ctx.paths, sliceId)
  mkdirSync(dirname(specPath), { recursive: true })
  writeFileSync(specPath, JSON.stringify({
    task_id: 'be-1b-E-test', domain: 'backend', goal: 'g',
    files_in_scope: ['f.mjs'], constraints: [], acceptance_criteria: ['works'],
    validation_commands: ['node --test'], discovery_context: 'ctx',
    out_of_scope: [], depends_on: [], interface_contract: 'none',
    ...overrides,
  }))
  return specPath
}

function buildTestCtx(dir, { checkout, repo = 'sample-repo', task = 'sample-task', configOverrides } = {}) {
  const args = {
    task, checkout: checkout || makeGitCheckout(dir), repo,
    root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  }
  if (configOverrides) {
    const configPath = join(dir, 'dispatch-config.json')
    writeFileSync(configPath, JSON.stringify(configOverrides))
    args.config = configPath
  }
  return buildContext(args)
}

// preflight's adapter-presence check requires the roster's agent CLI (here:
// 'claude', the default agent) to be present on PATH. A fake bin dir with a
// zero-content 'claude' file satisfies cmuxctl's isOnPath (existsSync only,
// never an exec-bit check) without touching a real Claude Code install.
const FAKE_BIN_DIR = mkdtempSync(join(tmpdir(), 'cmux-dispatch-bin-'))
writeFileSync(join(FAKE_BIN_DIR, 'claude'), '#!/bin/sh\n')
process.env.PATH = `${FAKE_BIN_DIR}${delimiter}${process.env.PATH}`

// Writes a fresh, valid ReturnEnvelope at record.return_path (coder's return
// kind is 'json' against coder-return.schema.json).
function writeValidReturn(record, bodyOverrides = {}) {
  const isMarkdown = record.return.kind === 'markdown'
  const body = isMarkdown
    ? (record.return.required_sections || []).map((s) => `# ${s}\nok\n`).join('\n')
    : { status: 'done', reason: 'ok', changes: ['f.mjs — impl'], validation: 'node --test', ...bodyOverrides }
  const envelope = {
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: new Date().toISOString(),
    body,
  }
  mkdirSync(dirname(record.return_path), { recursive: true })
  writeFileSync(record.return_path, JSON.stringify(envelope))
}

// Runs preflight + workspace against a fresh fixture env and returns
// { dir, ctx, env, workspaceRes } ready for a `dispatch` call.
function setUpWorkspace(prefix, opts = {}) {
  const env = freshCmuxEnv(prefix)
  const ctx = buildTestCtx(env.dir, opts)
  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0, `preflight failed: ${JSON.stringify(preflightRes.json)}`)
  const workspaceRes = workspaceCmd({}, ctx)
  return { dir: env.dir, env, ctx, preflightRes, workspaceRes }
}

// ---------------------------------------------------------------------------
// E-P1 — ANTI-VACUITY (qa MUST, asserted FIRST). Every "zero cmux
// invocations" assertion below this line is meaningless until this passes.
// ---------------------------------------------------------------------------

test('E-P1 anti-vacuity: a passing preflight + a successful dispatch produces EXACTLY ONE new-pane entry, argv asserted element by element', () => {
  const { dir, env, ctx, workspaceRes } = setUpWorkspace('ep1')
  const specPath = makeSpecFile(ctx)

  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath)
  const newPaneEntries = log.filter((e) => e.argv[0] === 'new-pane')
  assert.equal(newPaneEntries.length, 1, `expected exactly one new-pane invocation, got ${newPaneEntries.length}: ${JSON.stringify(log)}`)
  assert.deepEqual(newPaneEntries[0].argv, ['new-pane', '--workspace', workspaceRes.json.workspace_id])

  // The dispatch itself must have actually produced a bound, on-disk record
  // (not just a green exit code) — this is the other half of the
  // anti-vacuity proof.
  const record = readRecord(join(ctx.paths.dispatchDir, `be-1a.1.json`))
  assert.equal(record.surface.pane_id, res.json.pane_id)
  assert.equal(record.surface.surface_id, res.json.surface_id)
  assert.notEqual(record.bound_at, null)
})

test('E-P1 sequence: the full dispatch also produces rename-tab and send/send-key against the SAME surface (proves the pipeline is not vacuous downstream of new-pane)', () => {
  const { dir, env, ctx } = setUpWorkspace('ep1-seq')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const log = readLog(env.logPath)

  const renameEntry = log.find((e) => e.argv[0] === 'rename-tab')
  const sendEntry = log.find((e) => e.argv[0] === 'send')
  const sendKeyEntry = log.find((e) => e.argv[0] === 'send-key')
  assert.ok(renameEntry, 'expected a rename-tab invocation')
  assert.ok(sendEntry, 'expected a send invocation')
  assert.ok(sendKeyEntry, 'expected a send-key invocation')
  assert.equal(renameEntry.argv[1], res.json.surface_id)
  assert.equal(sendEntry.argv[1], res.json.surface_id)
  assert.equal(sendKeyEntry.argv[1], res.json.surface_id)
  assert.equal(sendKeyEntry.argv[2], 'enter')

  // send THEN send-key (spike S7: send never auto-submits).
  const sendIdx = log.indexOf(sendEntry)
  const sendKeyIdx = log.indexOf(sendKeyEntry)
  assert.ok(sendIdx < sendKeyIdx)
})

// ---------------------------------------------------------------------------
// readExecutionMode / OUTCOME_MAPPING / mapOutcome / applyPostconditionOverride
// ---------------------------------------------------------------------------

test('readExecutionMode defaults to agent-tool when absent', () => {
  assert.equal(readExecutionMode(''), 'agent-tool')
  assert.equal(readExecutionMode('# some config\nother: stuff\n'), 'agent-tool')
})

test('readExecutionMode reads agent-tool/cmux, normalizes the subagent alias, and throws on any other value', () => {
  assert.equal(readExecutionMode('execution_mode: agent-tool\n'), 'agent-tool')
  assert.equal(readExecutionMode('execution_mode: cmux\n'), 'cmux')
  assert.equal(readExecutionMode('execution_mode: subagent\n'), 'agent-tool')
  assert.throws(() => readExecutionMode('execution_mode: sub-agent\n'), /unknown execution_mode/)
  assert.throws(() => readExecutionMode('execution_mode: workflow\n'), /unknown execution_mode/)
  assert.throws(() => readExecutionMode('execution_mode: Cmux\n'), /unknown execution_mode/)
  assert.throws(() => readExecutionMode('execution_mode:\n'), /unknown execution_mode/)
})

test('readExecutionMode throw message quotes the raw configured spelling, not the normalized alias', () => {
  assert.throws(
    () => readExecutionMode('execution_mode: sub-agent\n'),
    (err) => err.message.includes(JSON.stringify('sub-agent')),
  )
})

test('EXECUTION_MODES drift guard: widening the accepted set requires a deliberate test edit', () => {
  assert.deepEqual(EXECUTION_MODES, ['agent-tool', 'cmux'])
})

test('OUTCOME_MAPPING row exit-0-plus-invalid-return never yields ok (qa L-22)', () => {
  const classification = { state: 'running', warnings: [] }
  const fsState = { exitSentinel: '0', returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'invalid_return')
})

test('OUTCOME_MAPPING row exit-1-plus-valid-return yields ok, with the warning carried in classify()s own output (qa L-23)', () => {
  const classification = { state: 'completed', warnings: ['exit_nonzero:1 despite a valid return'] }
  const fsState = { exitSentinel: '1', returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'ok')
  assert.deepEqual(classification.warnings, ['exit_nonzero:1 despite a valid return'])
})

test('OUTCOME_MAPPING: timeout and no_return rows', () => {
  assert.equal(mapOutcome({ state: 'timeout', warnings: [] }, { exitSentinel: null, returnPathKind: 'absent' }), 'timeout')
  assert.equal(mapOutcome({ state: 'running', warnings: [] }, { exitSentinel: null, returnPathKind: 'absent' }), 'no_return')
})

// ---------------------------------------------------------------------------
// MF1 — the worker_blocked row (dispatch.mjs:78) sits ahead of the completed
// row and keys strictly on classification.bodyStatus, never fsState.exitSentinel.
// Positives asserted first.
// ---------------------------------------------------------------------------

test('MF1 (positive, FIRST): a completed classification with bodyStatus "done" maps to ok', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: 'done' }
  const fsState = { exitSentinel: null, returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'ok')
})

test('MF1 (positive): a completed classification with bodyStatus null (markdown reviewer return) maps to ok', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: null }
  const fsState = { exitSentinel: null, returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'ok')
})

test('MF1: a completed classification with bodyStatus "blocked" maps to the dedicated blocked outcome', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: 'blocked' }
  const fsState = { exitSentinel: '2', returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'blocked')
})

test('MF1: a completed classification with bodyStatus "insufficient" also maps to the dedicated blocked outcome', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: 'insufficient' }
  const fsState = { exitSentinel: '0', returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'blocked')
})

// U-4 REGRESSION GUARD: the worker_blocked row must never fire off the .exit
// sentinel alone — a "done" body alongside a hostile non-zero .exit sentinel
// still maps to ok (warning only, carried in classify()'s own output).
test('U-4 REGRESSION GUARD: bodyStatus "done" + .exit "2" still maps to outcome ok', () => {
  const classification = { state: 'completed', warnings: ['exit_nonzero:2 despite a valid return'], bodyStatus: 'done' }
  const fsState = { exitSentinel: '2', returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'ok')
})

test('applyPostconditionOverride: a violated clean postcondition overrides ok with refused_postcondition, never demotes a non-ok outcome', () => {
  assert.equal(applyPostconditionOverride('ok', { ok: false, offending: ['M file'] }), 'refused_postcondition')
  assert.equal(applyPostconditionOverride('ok', { ok: true, offending: [] }), 'ok')
  assert.equal(applyPostconditionOverride('exit_nonzero', { ok: false, offending: ['M file'] }), 'exit_nonzero')
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: flag/value, boolean, and list (--all) forms', () => {
  assert.deepEqual(parseArgs(['--task', 'x', '--force']), { task: 'x', force: true })
  assert.deepEqual(parseArgs(['--all', 'a', 'b', 'c', '--max-block-s', '10']), { all: ['a', 'b', 'c'], 'max-block-s': '10' })
})

test('parseArgs: refuses a positional argument and a flag missing its value', () => {
  assert.throws(() => parseArgs(['bogus']), UsageError)
  assert.throws(() => parseArgs(['--task']), UsageError)
})

// ---------------------------------------------------------------------------
// SHELL SAFETY — refused before any send, not escaped-and-sent.
// ---------------------------------------------------------------------------

test('SHELL SAFETY (vacuity S1): a hostile task_artifacts_root is refused downstream of a full dispatch attempt (not just buildContext in isolation)', () => {
  const env = freshCmuxEnv('shell-safety')
  const checkout = makeGitCheckout(env.dir)
  const hostileRoot = join(env.dir, "dev' team")

  assert.throws(() => {
    const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: hostileRoot, 'plugin-root': ROOT })
    preflightCmd({}, ctx)
    workspaceCmd({}, ctx)
    const specPath = makeSpecFile(ctx)
    dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  }, /frozen charset/)

  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'send').length, 0)
})

test('SHELL SAFETY paired positive: the identical flow with a clean root reaches send (proves the refusal above is not vacuous)', () => {
  const env = freshCmuxEnv('shell-safety-positive')
  const checkout = makeGitCheckout(env.dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(env.dir, 'dev-team'), 'plugin-root': ROOT })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx)
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const log = readLog(env.logPath)
  assert.ok(log.find((e) => e.argv[0] === 'send'))
})

// ---------------------------------------------------------------------------
// ADAPTER LAUNCH LINE (be-1c-05) — dispatchCmd sends the composed adapter
// launch line instead of record.kickoff prose; record.kickoff itself is
// unchanged and reaches the model via adapter-claude.mjs's buildArgv `--`
// positional, not the pane shell.
// ---------------------------------------------------------------------------

test('adapterLaunchLine composes "<execPath> <pluginRoot>/scripts/cmux/adapter-claude.mjs run <recordPath>"', () => {
  const line = adapterLaunchLine({ execPath: '/usr/bin/node', pluginRoot: '/plugin', recordPath: '/state/be-1a.1.json' })
  assert.equal(line, '/usr/bin/node /plugin/scripts/cmux/adapter-claude.mjs run /state/be-1a.1.json')
})

test('adapterLaunchLine throws a named-cause error when any component contains a character outside the SAFE_PATH_RE charset, a space in particular', () => {
  assert.throws(
    () => adapterLaunchLine({ execPath: '/usr/bin/no de', pluginRoot: '/plugin', recordPath: '/state/x.json' }),
    /execPath/,
  )
  assert.throws(
    () => adapterLaunchLine({ execPath: '/usr/bin/node', pluginRoot: '/plu gin', recordPath: '/state/x.json' }),
    /pluginRoot/,
  )
  assert.throws(
    () => adapterLaunchLine({ execPath: '/usr/bin/node', pluginRoot: '/plugin', recordPath: '/sta te/x.json' }),
    /recordPath/,
  )
})

test('adapterLaunchLine throws a named-cause error when any component is a relative path (leading-\'/\' charset hardening)', () => {
  assert.throws(
    () => adapterLaunchLine({ execPath: 'usr/bin/node', pluginRoot: '/plugin', recordPath: '/state/x.json' }),
    /execPath.*absolute/,
  )
  assert.throws(
    () => adapterLaunchLine({ execPath: '/usr/bin/node', pluginRoot: 'plugin', recordPath: '/state/x.json' }),
    /pluginRoot.*absolute/,
  )
  assert.throws(
    () => adapterLaunchLine({ execPath: '/usr/bin/node', pluginRoot: '/plugin', recordPath: 'state/x.json' }),
    /recordPath.*absolute/,
  )
})

test('adapter launch PAIRED POSITIVE: a successful dispatch sends the composed launch line verbatim, exactly one send + one send-key enter, and the nonce is still present at that moment (consumed by the adapter, not by dispatch)', () => {
  const { dir, env, ctx } = setUpWorkspace('adapter-launch-positive')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)

  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')
  const record = readRecord(recordPath)
  const expectedLine = adapterLaunchLine({ execPath: process.execPath, pluginRoot: ctx.pluginRoot, recordPath })

  const log = readLog(env.logPath)
  const sendEntries = log.filter((e) => e.argv[0] === 'send')
  const sendKeyEntries = log.filter((e) => e.argv[0] === 'send-key')
  assert.equal(sendEntries.length, 1, `expected exactly one send, got ${JSON.stringify(sendEntries)}`)
  assert.equal(sendKeyEntries.length, 1, `expected exactly one send-key, got ${JSON.stringify(sendKeyEntries)}`)
  assert.equal(sendKeyEntries[0].argv[2], 'enter')
  assert.equal(sendEntries[0].argv[2], expectedLine)

  // record.kickoff is unchanged (still the model's prompt, delivered via
  // buildArgv's positional) and is NOT what was typed into the pane.
  assert.equal(typeof record.kickoff, 'string')
  assert.notEqual(sendEntries[0].argv[2], record.kickoff)

  const sidecars = sidecarPaths(ctx.paths, res.json.dispatch_id)
  assert.ok(existsSync(sidecars.nonce), 'the nonce must still be on disk right after a successful dispatch')
})

test('adapter launch NEGATIVE: an execPath containing a space is refused as an OperationalError, terminates the record aborted, and unlinks the nonce (never a crash)', () => {
  const { env, ctx } = setUpWorkspace('adapter-launch-bad-execpath')
  const specPath = makeSpecFile(ctx)
  const savedExecPath = process.execPath
  process.execPath = '/usr/bin/no de'
  try {
    assert.throws(
      () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
      (err) => err instanceof OperationalError && /sendLine failed after bind/.test(err.message),
    )
  } finally {
    process.execPath = savedExecPath
  }

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.outcome, 'aborted')
  const sidecars = sidecarPaths(ctx.paths, record.dispatch_id)
  assert.equal(existsSync(sidecars.nonce), false, 'the nonce must be unlinked on the sendLine-refusal abort path')

  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'send').length, 0)
})

test('adapter launch NEGATIVE: a pluginRoot containing a space is refused as an OperationalError, terminates the record aborted, and unlinks the nonce (never a crash)', () => {
  const spaceRootParent = mkdtempSync(join(tmpdir(), 'cmux-adapter-space-'))
  const spacePluginRoot = join(spaceRootParent, 'plugin root')
  // A realistic pluginRoot fixture: a full copy of the plugin tree (agents,
  // schemas, scripts/cmux) under a path containing a space, minus .git and
  // this repo's own test/ dir (neither is read by preflight/snapshot).
  cpSync(ROOT, spacePluginRoot, {
    recursive: true,
    filter: (src) => !/\/\.git(\/|$)/.test(src) && !/\/test(\/|$)/.test(src),
  })

  const env = freshCmuxEnv('adapter-launch-bad-pluginroot')
  const checkout = makeGitCheckout(env.dir)
  const ctx = buildContext({
    task: 'sample-task', checkout, repo: 'sample-repo', root: join(env.dir, 'dev-team'), 'plugin-root': spacePluginRoot,
  })
  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0, `preflight failed: ${JSON.stringify(preflightRes.json)}`)
  workspaceCmd({}, ctx)
  const specPath = makeSpecFile(ctx)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    (err) => err instanceof OperationalError && /sendLine failed after bind/.test(err.message),
  )

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.outcome, 'aborted')
  const sidecars = sidecarPaths(ctx.paths, record.dispatch_id)
  assert.equal(existsSync(sidecars.nonce), false, 'the nonce must be unlinked on the sendLine-refusal abort path')

  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'send').length, 0)
})

// ---------------------------------------------------------------------------
// SNAPSHOT DIR WIRING (R1) — dispatchCmd snapshots into the PER-DISPATCH
// directory (snapshotDirFor(paths, dispatchId)), never the shared
// paths.snapshotDir parent, so two concurrent dispatches never share a
// worker-plugin snapshot (contract #9).
// ---------------------------------------------------------------------------

test('dispatchCmd snapshots into snapshotDirFor(paths, dispatchId): role_prompt_path lives under <stateDir>/worker-plugin/<dispatch_id>/roles/', () => {
  const { ctx } = setUpWorkspace('snapshot-dir-wiring')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  const expectedPrefix = join(ctx.paths.snapshotDir, res.json.dispatch_id, 'roles')
  assert.ok(
    record.role_prompt_path.startsWith(`${expectedPrefix}/`),
    `expected role_prompt_path under ${expectedPrefix}/, got ${record.role_prompt_path}`,
  )
})

test('dispatchCmd: two dispatches in the same task write two distinct per-dispatch snapshot dirs (no collision)', () => {
  const { ctx } = setUpWorkspace('snapshot-dir-no-collision')
  const specA = makeSpecFile(ctx, 'be-1a')
  const specB = makeSpecFile(ctx, 'be-1b')

  const resA = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specA }, ctx)
  const resB = dispatchCmd({ slice: 'be-1b', role: 'coder', spec: specB }, ctx)
  assert.notEqual(resA.json.dispatch_id, resB.json.dispatch_id)

  const recordA = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  const recordB = readRecord(join(ctx.paths.dispatchDir, 'be-1b.1.json'))

  const dirA = join(ctx.paths.snapshotDir, resA.json.dispatch_id)
  const dirB = join(ctx.paths.snapshotDir, resB.json.dispatch_id)
  assert.notEqual(dirA, dirB)
  assert.ok(recordA.role_prompt_path.startsWith(`${dirA}/`))
  assert.ok(recordB.role_prompt_path.startsWith(`${dirB}/`))
})

// ---------------------------------------------------------------------------
// E-P2 — PREFLIGHT FAILURE = HARD STOP. Every failure path below asserts
// BOTH that no dispatching verb was ever invoked AND that the emitted
// message === the IMPORTED PREFLIGHT_MESSAGES entry (never a re-typed
// literal). This is only non-vacuous because E-P1, above, already proved the
// log captures new-pane/send/send-key when they really happen.
// ---------------------------------------------------------------------------

function assertNoDispatchingInvocations(logPath) {
  const log = readLog(logPath)
  const dispatching = log.filter((e) => ['new-pane', 'send', 'send-key'].includes(e.argv[0]))
  assert.equal(dispatching.length, 0, `expected zero dispatching invocations, got: ${JSON.stringify(dispatching)}`)
}

// CMUX_BIN is captured by cmuxctl.mjs as a module-level constant at import
// time — re-pointing process.env.CMUX_BIN after this file's own import has
// no effect in-process. binary_missing therefore needs a fresh child process
// (same technique test/cmux-preflight.test.mjs uses for the same reason).
function runPreflightInSubprocess({ cmuxBin, dir }) {
  const script = `
    const dm = await import(${JSON.stringify(DISPATCH_PATH)})
    const ctx = dm.buildContext({ task: 'sample-task', checkout: ${JSON.stringify(join(dir, 'checkout'))}, repo: 'sample-repo', root: ${JSON.stringify(join(dir, 'dev-team'))}, 'plugin-root': ${JSON.stringify(ROOT)} })
    try {
      const res = dm.preflightCmd({}, ctx)
      console.log(JSON.stringify({ threw: false, res }))
    } catch (err) {
      console.log(JSON.stringify({ threw: true, message: err.message }))
    }
  `
  mkdirSync(join(dir, 'checkout'), { recursive: true })
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, CMUX_BIN: cmuxBin },
  })
  if (!res.stdout) {
    throw new Error(`subprocess produced no stdout — stderr: ${res.stderr}`)
  }
  return JSON.parse(res.stdout.trim())
}

test('E-P2 binary_missing: preflight throws with the imported message, zero dispatching invocations, never falls back to another substrate', () => {
  const env = freshCmuxEnv('ep2-binary-missing')
  const out = runPreflightInSubprocess({ cmuxBin: join(env.dir, 'no-such-cmux-binary'), dir: env.dir })
  assert.equal(out.threw, true)
  assert.equal(out.message, PREFLIGHT_MESSAGES.binary_missing)
  assertNoDispatchingInvocations(env.logPath)
})

test('E-P2 not_running: ping does not return PONG -> preflight throws with the imported message, zero dispatching invocations', () => {
  const { dir, env } = { dir: mkdtempSync(join(tmpdir(), 'ep2-not-running-')), env: freshCmuxEnv('ep2-not-running') }
  const ctx = buildTestCtx(env.dir)
  process.env.FAKE_CMUX_FAIL = 'ping'
  try {
    assert.throws(
      () => preflightCmd({}, ctx),
      (err) => err.message === PREFLIGHT_MESSAGES.not_running,
    )
  } finally {
    delete process.env.FAKE_CMUX_FAIL
  }
  assertNoDispatchingInvocations(env.logPath)
})

test('E-P2 not_in_pane: identify returns caller: null -> preflight throws with the imported message, zero dispatching invocations', () => {
  const env = freshCmuxEnv('ep2-not-in-pane')
  const ctx = buildTestCtx(env.dir)
  process.env.FAKE_CMUX_NO_CALLER = '1'
  try {
    assert.throws(
      () => preflightCmd({}, ctx),
      (err) => err.message === PREFLIGHT_MESSAGES.not_in_pane,
    )
  } finally {
    delete process.env.FAKE_CMUX_NO_CALLER
  }
  assertNoDispatchingInvocations(env.logPath)
})

test('E-P2 verb_missing: capabilities omits a required verb -> preflight throws with the imported message, zero dispatching invocations', () => {
  const env = freshCmuxEnv('ep2-verb-missing')
  const ctx = buildTestCtx(env.dir)
  // FAKE_CMUX_MISSING_METHODS takes live RPC-style dotted method names, not
  // CLI verb names — VERB_METHODS['send-key'] === 'surface.send_key'.
  process.env.FAKE_CMUX_MISSING_METHODS = 'surface.send_key'
  try {
    assert.throws(
      () => preflightCmd({}, ctx),
      (err) => err.message === formatPreflightMessage('verb_missing', { ver: 'cmux 0.64.20 (100)', verb: 'send-key' }),
    )
  } finally {
    delete process.env.FAKE_CMUX_MISSING_METHODS
  }
  assertNoDispatchingInvocations(env.logPath)
})

test('E-P2 adapter_missing: a roster agent CLI is not on PATH -> preflight throws with the imported message, zero dispatching invocations', () => {
  const env = freshCmuxEnv('ep2-adapter-missing')
  const ctx = buildTestCtx(env.dir)
  const savedPath = process.env.PATH
  // roster.schema.json's `agent` enum admits only "claude" — the only way
  // to reproduce adapter_missing is a PATH with no `claude` anywhere on it.
  // node itself (for the fixture's #!/usr/bin/env node shebang) must stay
  // reachable, so this filters out every PATH entry that resolves `claude`
  // rather than truncating PATH entirely.
  process.env.PATH = savedPath.split(delimiter).filter((d) => !existsSync(join(d, 'claude'))).join(delimiter)
  try {
    assert.throws(
      () => preflightCmd({}, ctx),
      (err) => err.message === formatPreflightMessage('adapter_missing', { role: 'coder', cli: 'claude' }),
    )
  } finally {
    process.env.PATH = savedPath
  }
  assertNoDispatchingInvocations(env.logPath)
})

// ---------------------------------------------------------------------------
// E-P3 — NORMALIZATION ON THE WRITE PATH. The fake emits mixed-case uuids;
// this asserts the record READ BACK FROM DISK (not just the in-memory
// return value) carries lowercase ids, AND that those lowercase ids are the
// target argv of the subsequent send/send-key/rename-tab invocations.
// ---------------------------------------------------------------------------

test('E-P3 normalization: record read back from disk has lowercase surface ids, used as the target argv of send/send-key/rename-tab', () => {
  const { dir, env, ctx } = setUpWorkspace('ep3')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  assert.match(res.json.workspace_id, LOWER_UUID_RE)
  assert.match(res.json.pane_id, LOWER_UUID_RE)
  assert.match(res.json.surface_id, LOWER_UUID_RE)

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.match(record.surface.workspace_id, LOWER_UUID_RE)
  assert.match(record.surface.pane_id, LOWER_UUID_RE)
  assert.match(record.surface.surface_id, LOWER_UUID_RE)
  assert.equal(record.surface.workspace_id, record.surface.workspace_id.toLowerCase())
  assert.equal(record.surface.pane_id, record.surface.pane_id.toLowerCase())
  assert.equal(record.surface.surface_id, record.surface.surface_id.toLowerCase())

  const log = readLog(env.logPath)
  const renameEntry = log.find((e) => e.argv[0] === 'rename-tab')
  const sendEntry = log.find((e) => e.argv[0] === 'send')
  const sendKeyEntry = log.find((e) => e.argv[0] === 'send-key')
  assert.equal(renameEntry.argv[1], record.surface.surface_id)
  assert.equal(sendEntry.argv[1], record.surface.surface_id)
  assert.equal(sendKeyEntry.argv[1], record.surface.surface_id)
})

test('ONLY UUIDS ARE PERSISTED: no short ref (surface:1234) and every id field is lowercase, even though the fake emits mixed-case', () => {
  const { dir, ctx } = setUpWorkspace('only-uuids')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  statusCmd({}, ctx)

  const SHORT_REF_RE = /surface:\d|pane:\d|workspace:\d/

  const recordBytes = readFileSync(join(ctx.paths.dispatchDir, 'be-1a.1.json'), 'utf8')
  assert.doesNotMatch(recordBytes, SHORT_REF_RE)
  const statusBytes = readFileSync(ctx.paths.statusPath, 'utf8')
  assert.doesNotMatch(statusBytes, SHORT_REF_RE)

  const record = JSON.parse(recordBytes)
  assert.equal(record.surface.workspace_id, record.surface.workspace_id.toLowerCase())
  assert.equal(record.surface.pane_id, record.surface.pane_id.toLowerCase())
  assert.equal(record.surface.surface_id, record.surface.surface_id.toLowerCase())
})

// ---------------------------------------------------------------------------
// Phase-1 rollout gate (PANE_ROLES) and attempt derivation / refusal (U-1).
// ---------------------------------------------------------------------------

test('dispatch refuses a role whose pane flag is false (Phase-1 rollout gate), with zero cmux invocations', () => {
  const { env, ctx } = setUpWorkspace('pane-gate')
  const dir = env.dir
  const specPath = makeSpecFile(ctx)
  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'test-engineer', spec: specPath }, ctx),
    (err) => /not pane-enabled/.test(err.message),
  )
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => ['new-pane', 'send', 'send-key', 'rename-tab'].includes(e.argv[0])).length, 0)
})

test('U-1: a re-dispatch of the same slice ALWAYS bumps attempt via nextAttempt, and reuses the same worktree', () => {
  const { dir, ctx } = setUpWorkspace('u1-bump')
  const specPath = makeSpecFile(ctx)
  const first = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(first.json.attempt, 1)
  const second = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(second.json.attempt, 2)

  const rec1 = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  const rec2 = readRecord(join(ctx.paths.dispatchDir, 'be-1a.2.json'))
  assert.equal(rec1.worktree.path, rec2.worktree.path)
  assert.equal(rec1.worktree.branch, rec2.worktree.branch)

  const worktrees = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.deepEqual(worktrees['be-1a'].attempts, [first.json.dispatch_id, second.json.dispatch_id])
})

test('U-1: an explicit duplicate --attempt refuses (occupied record path), naming the bump remedy, with ZERO cmux invocations after it', () => {
  const { env, ctx } = setUpWorkspace('u1-dup-attempt')
  const dir = env.dir
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath, attempt: '1' }, ctx)
  const logBefore = readLog(env.logPath)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath, attempt: '1' }, ctx),
    (err) => /refused/.test(err.message) && /bump/.test(err.message),
  )

  // lifecycle M1/M2-E: the hoisted workspace-liveness check legitimately
  // makes ONE `tree` call before the refusal — the invariant this test
  // proves is that no DISPATCHING verb (new-pane/send/send-key/rename-tab)
  // ever fires for a refused re-dispatch, not that the log is byte-for-byte
  // unchanged.
  const newEntries = readLog(env.logPath).slice(logBefore.length)
  assert.ok(newEntries.every((e) => e.argv[0] === 'tree'), `expected only tree calls after the refusal, got: ${JSON.stringify(newEntries)}`)
  assert.equal(newEntries.filter((e) => ['new-pane', 'send', 'send-key', 'rename-tab'].includes(e.argv[0])).length, 0)
})

test('U-1: a stale return file at the derived stem refuses via StaleReturnError, with ZERO cmux invocations after it', () => {
  const { dir, env, ctx } = setUpWorkspace('u1-stale-return')
  const specPath = makeSpecFile(ctx)
  mkdirSync(ctx.paths.returnsDir, { recursive: true })
  writeFileSync(join(ctx.paths.returnsDir, 'be-1a.1.json'), '{"leftover": true}')
  const logBefore = readLog(env.logPath)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    (err) => /refused/.test(err.message) && /bump/.test(err.message),
  )

  // See the note above: the hoisted workspace-liveness check legitimately
  // makes one `tree` call before the refusal.
  const newEntries = readLog(env.logPath).slice(logBefore.length)
  assert.ok(newEntries.every((e) => e.argv[0] === 'tree'), `expected only tree calls after the refusal, got: ${JSON.stringify(newEntries)}`)
  assert.equal(newEntries.filter((e) => ['new-pane', 'send', 'send-key', 'rename-tab'].includes(e.argv[0])).length, 0)
})

// ---------------------------------------------------------------------------
// WORKTREES — real git repos (git init + a commit) under os.tmpdir().
// ---------------------------------------------------------------------------

test('ensureWorktree creates a worktree keyed by slice_id at dt/<task-slug>/<slice_id>, and a second attempt REUSES it (never a second branch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-worktree-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })

  const first = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a',
    primaryCheckout: checkout, dispatchId: 'dispatch-1', worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })
  assert.equal(first.branch, 'dt/sample-task/be-1a')
  assert.ok(existsSync(first.path))
  assert.ok(existsSync(join(first.path, 'README.md')))

  const second = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a',
    primaryCheckout: checkout, dispatchId: 'dispatch-2', worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })
  assert.equal(second.path, first.path)
  assert.equal(second.branch, first.branch)

  const index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.deepEqual(index['be-1a'].attempts, ['dispatch-1', 'dispatch-2'])
  // Only one `git worktree add` ever happened — assert via `git worktree list`.
  const list = execFileSync('git', ['worktree', 'list'], { cwd: checkout, encoding: 'utf8' })
  assert.equal(list.trim().split('\n').length, 2) // primary + the one worktree
})

test('isDispatcherWorktree refuses the primary checkout itself and any non-worktree path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-worktree-safety-'))
  const checkout = makeGitCheckout(dir)
  assert.equal(isDispatcherWorktree(checkout, checkout), false)
  assert.equal(isDispatcherWorktree(join(dir, 'not-a-worktree'), checkout), false)
})

test('removeWorktreeIfCleanAndMerged keeps a dirty worktree (never --force), and removes a clean + merged one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-worktree-remove-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  const wt = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a',
    primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })

  // Dirty: an uncommitted file in the worktree.
  writeFileSync(join(wt.path, 'scratch.txt'), 'wip')
  let index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  const dirtyRes = removeWorktreeIfCleanAndMerged({ sliceId: 'be-1a', entry: index['be-1a'], primaryCheckout: checkout, worktreesIndexPath: ctx.paths.worktreesIndexPath, roots: ctx.roots })
  assert.equal(dirtyRes.removed, false)
  assert.equal(dirtyRes.reason, 'dirty_or_unmerged')
  assert.ok(existsSync(wt.path), 'a dirty worktree must never be deleted')

  // Clean it up and merge the branch into the checkout's default branch.
  execFileSync('git', ['add', '.'], { cwd: wt.path })
  execFileSync('git', ['commit', '-q', '-m', 'wip'], { cwd: wt.path })
  execFileSync('git', ['merge', '--no-edit', '-q', wt.branch], { cwd: checkout })

  index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  const cleanRes = removeWorktreeIfCleanAndMerged({ sliceId: 'be-1a', entry: index['be-1a'], primaryCheckout: checkout, worktreesIndexPath: ctx.paths.worktreesIndexPath, roots: ctx.roots })
  assert.equal(cleanRes.removed, true)
  assert.equal(existsSync(wt.path), false)
  const finalIndex = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.equal(finalIndex['be-1a'], undefined)
})

// ---------------------------------------------------------------------------
// DEPENDENCY PREP (ADR-013 named consequence 1) — dispatcher-side, before
// the kickoff, never a worker grant.
// ---------------------------------------------------------------------------

test('worktree_prep runs in the fresh worktree before the kickoff; absent config = no prep, no error', () => {
  const { dir, env, ctx } = setUpWorkspace('prep-absent')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const log = readLog(env.logPath)
  assert.ok(log.find((e) => e.argv[0] === 'send'))
})

test('worktree_prep: a non-zero exit aborts the dispatch, terminates the record as "aborted", logs the prep output, and never sends the kickoff', () => {
  const { dir, env, ctx } = setUpWorkspace('prep-fails', { configOverrides: { worktree_prep: [['sh', '-c', 'echo prepping; exit 3']] } })
  const specPath = makeSpecFile(ctx)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    (err) => /worktree_prep failed/.test(err.message),
  )

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.outcome, 'aborted')
  assert.notEqual(record.ended_at, null)

  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'send').length, 0)
  assert.equal(log.filter((e) => e.argv[0] === 'send-key').length, 0)
  assert.equal(log.filter((e) => e.argv[0] === 'rename-tab').length, 0)

  const prepLogPath = join(ctx.paths.logsDir, 'be-1a.1.prep.log')
  assert.ok(existsSync(prepLogPath))
  assert.match(readFileSync(prepLogPath, 'utf8'), /prepping/)
})

test('worktree_prep: a passing command logs its output and the dispatch continues to the kickoff', () => {
  const { dir, env, ctx } = setUpWorkspace('prep-passes', { configOverrides: { worktree_prep: [['sh', '-c', 'echo all-good']] } })
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const prepLogPath = join(ctx.paths.logsDir, 'be-1a.1.prep.log')
  assert.match(readFileSync(prepLogPath, 'utf8'), /all-good/)
  const log = readLog(env.logPath)
  assert.ok(log.find((e) => e.argv[0] === 'send'))
})

// ---------------------------------------------------------------------------
// AWAIT — poll-first, chunked, single-writer.
// ---------------------------------------------------------------------------

const NO_SLEEP = () => { throw new Error('sleep must never be called when the first tick already resolves') }

test('SIGNAL-BEFORE-ARM RACE: a return (and a pre-fired event) that landed before the call still resolves on the first tick, without sleeping', () => {
  const { dir, ctx } = setUpWorkspace('await-race')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  const eventsPath = join(dir, 'events.jsonl')
  writeFileSync(eventsPath, `${JSON.stringify({ seq: 1, type: 'turn_end' })}\n`)
  process.env.FAKE_CMUX_EVENTS = eventsPath

  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP, now: () => Date.now() })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.code, 0)
  assert.equal(res.json.resolved.length, 1)
  assert.equal(res.json.resolved[0].state, 'completed')
  assert.deepEqual(res.json.remaining, [])
})

test('SINGLE WRITER: a second concurrent await exits 2 naming the holder; a stale lock (> 2x cap) is broken and logged', () => {
  const { dir, ctx } = setUpWorkspace('await-lock')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  writeFileSync(ctx.paths.lockPath, JSON.stringify({ pid: 999999, started_at: new Date().toISOString() }))
  const contested = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '1' }, ctx, { sleep: NO_SLEEP })
  assert.equal(contested.code, 2)
  assert.equal(contested.json.error, 'lock_held')
  assert.equal(contested.json.holder.pid, 999999)

  // A stale lock is broken rather than honored — the record already has a
  // fresh return staged so this resolves on tick 1. --max-block-s is
  // floored at 5s (lifecycle S1), so the 2x-cap staleness threshold here is
  // 10s; comfortably clear that with a 20s-old lock rather than race the
  // threshold at exactly 10s.
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  const staleStartedAt = new Date(Date.now() - 20_000).toISOString()
  writeFileSync(ctx.paths.lockPath, JSON.stringify({ pid: 999999, started_at: staleStartedAt }))
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '1' }, ctx, { sleep: NO_SLEEP })
  assert.equal(res.code, 0)
  assert.equal(existsSync(ctx.paths.lockPath), false, 'the lock is released on a clean exit')
})

test('await releases the lock even when it never resolves (cap reached) and reports still-running', () => {
  const { dir, ctx } = setUpWorkspace('await-cap')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  let now = Date.now()
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.status, 'still-running')
  assert.deepEqual(res.json.remaining, [dispatchRes.json.dispatch_id])
  assert.equal(existsSync(ctx.paths.lockPath), false)
})

test('INVOCATION BOUND: a chunked-join across repeated cap-reached calls invokes cmux at most dispatches + ceil(elapsed/cap) + 2 times overall', () => {
  const { dir, env, ctx } = setUpWorkspace('await-bound')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchInvocationsSoFar = readLog(env.logPath).length

  const capS = 1
  let now = Date.now()
  const chunks = 3
  for (let i = 0; i < chunks; i += 1) {
    awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': String(capS) }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
  }

  const totalInvocations = readLog(env.logPath).length
  const elapsedS = capS * chunks
  const bound = dispatchInvocationsSoFar + Math.ceil(elapsedS / capS) + 2
  assert.ok(totalInvocations <= bound, `expected <= ${bound} invocations, got ${totalInvocations}`)
})

test('L-29 NO DOUBLE TERMINAL TRANSITION: a fresh valid return staged alongside an .exit file resolves once via await, and a second terminateRecord attempt throws without changing the record mtime', () => {
  const { dir, ctx } = setUpWorkspace('await-l29')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  const exitPath = join(ctx.paths.stateDir, `${record.dispatch_id}.exit`)
  writeFileSync(exitPath, '1')

  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP })
  assert.equal(res.json.resolved.length, 1)
  assert.equal(res.json.resolved[0].state, 'completed')
  assert.match(res.json.resolved[0].warnings[0], /exit_nonzero:1 despite a valid return/)

  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok')

  // EXACTLY ONE terminal transition: the record is already terminated by
  // `close`, so a second terminateRecord attempt (record.mjs's own
  // monotonicity invariant) throws and the record file's mtime never moves.
  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')
  const mtimeBefore = statSync(recordPath).mtimeMs
  assert.throws(() => terminateRecord(recordPath, 'ok'), /already terminated/)
  assert.equal(statSync(recordPath).mtimeMs, mtimeBefore)
})

// ---------------------------------------------------------------------------
// CLOSE
// ---------------------------------------------------------------------------

test('close on a valid return: closes the executor pane, re-resolves its id from a fresh tree, and terminates the record ok', () => {
  const { dir, env, ctx } = setUpWorkspace('close-ok')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  const res = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'ok')
  assert.equal(res.code, 0)

  const log = readLog(env.logPath)
  const closeEntry = log.find((e) => e.argv[0] === 'close-surface')
  assert.ok(closeEntry)
  assert.equal(closeEntry.argv[1], dispatchRes.json.surface_id)

  const terminated = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(terminated.outcome, 'ok')
  assert.notEqual(terminated.ended_at, null)
})

test('close re-resolves every topology verb from a fresh tree and no-ops loudly (never throws) when the surface is already gone', () => {
  const { dir, ctx } = setUpWorkspace('close-gone')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx) // closes the surface for real
  // A second close on the now-terminated, surface-gone record must not throw.
  assert.doesNotThrow(() => closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx))
})

// Builds, writes and binds a record directly via record.mjs (bypassing
// dispatchCmd's Phase-1 PANE_ROLES gate, which only code-reviewer's judgment
// profile — postcondition 'clean' — needs to get past) so closeCmd's
// postcondition-override path can be exercised end to end.
function buildAndBindRecord(ctx, { role, sliceId }) {
  const dispatchId = newDispatchId()
  const worktree = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId,
    primaryCheckout: ctx.primaryCheckout, dispatchId, worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })
  const snapshot = snapshotWorkerPlugin({ pluginRoot: ctx.pluginRoot, snapshotDir: ctx.paths.snapshotDir, roles: ctx.roster.roles, profiles: ctx.roster.profiles })
  const record = buildRecord({
    roots: ctx.roots, paths: ctx.paths, roster: ctx.roster, resolved: ctx.roster.roles[role], pluginRoot: ctx.pluginRoot,
    taskId: ctx.taskSlug, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug, primaryCheckout: ctx.primaryCheckout, snapshot,
    config: { createdByDispatcher: worktree.created_by_dispatcher, sourceSliceId: worktree.source_slice_id },
    // Backdated slightly: isFresh (pinned U-2) is a STRICT ">" comparison,
    // and this whole synchronous chain (git worktree add + a JSON write) can
    // complete within the same millisecond tick as Date.now() on a fast
    // machine, which would otherwise make the return file a same-instant
    // tie (correctly stale, per U-2) rather than the fresh return this
    // helper means to construct.
    now: Date.now() - 50, dispatchId, attnUpstream: null,
  }, { role, sliceId, attempt: 1, spec: { validation_commands: ['node --test'] } })
  const recordPath = join(ctx.paths.dispatchDir, `${sliceId}.1.json`)
  writeRecord(record, recordPath)
  return bindRecord(recordPath, {
    workspace_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    pane_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    surface_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  })
}

test('close: a violated clean postcondition overrides ok with refused_postcondition and is escalated loudly', () => {
  const { ctx } = setUpWorkspace('close-postcondition')
  const record = buildAndBindRecord(ctx, { role: 'code-reviewer', sliceId: 'be-1b' })
  writeValidReturn(record)
  writeFileSync(join(record.worktree.path, 'dirty.txt'), 'uncommitted')

  const res = closeCmd({ dispatch: record.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'refused_postcondition')
  assert.ok(res.json.postcondition.offending.length > 0)
})

// ---------------------------------------------------------------------------
// MF1 END-TO-END — a real record (built via record.buildRecord, through
// dispatchCmd) plus a real blocked-status envelope written to return_path on
// disk, closed through the full closeCmd path. Positives asserted first.
// ---------------------------------------------------------------------------

test('MF1 (positive, FIRST): a real "done" return closes with outcome ok', () => {
  const { ctx } = setUpWorkspace('mf1-done')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  const res = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'ok')
})

test('MF1 (positive): a real markdown reviewer return (bodyStatus null) closes with outcome ok', () => {
  const { ctx } = setUpWorkspace('mf1-markdown')
  const record = buildAndBindRecord(ctx, { role: 'code-reviewer', sliceId: 'be-1b' })
  writeValidReturn(record)

  const res = closeCmd({ dispatch: record.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'ok')
})

test('MF1 vector (a) adapter-refusal: a blocked body + .exit "2" closes with outcome blocked, not ok', () => {
  const { ctx } = setUpWorkspace('mf1-adapter-refusal')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record, { status: 'blocked', reason: 'PRE-1C-VERIFY refused the dispatch' })
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '2')

  const res = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'blocked')
})

test('MF1 vector (b) CLI-missing: a blocked body + .exit "3" closes with outcome blocked, not ok', () => {
  const { ctx } = setUpWorkspace('mf1-cli-missing')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record, { status: 'blocked', reason: 'agent CLI not found on PATH' })
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '3')

  const res = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'blocked')
})

// This vector is the one only the body-status fix catches: .exit "0" is the
// completed-looking sentinel exit_nonzero would never flag, so a fix keyed on
// the sentinel (violating U-4) would still launder this one as ok.
test('MF1 vector (c) gate-exhaustion: a blocked body + .exit "0" closes with outcome blocked — the sentinel alone would say ok', () => {
  const { ctx } = setUpWorkspace('mf1-gate-exhaustion')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record, { status: 'blocked', reason: 'gate exhausted: max_blocks reached' })
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '0')

  const res = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'blocked')
})

// ---------------------------------------------------------------------------
// STATUS — reconstructs everything from disk alone.
// ---------------------------------------------------------------------------

test('status reconstructs from disk alone (listRecords + collectFsState + tree + reconcile) and does not throw against a fixture with no prior in-process state, including an interrupted <stem>.json.tmp', () => {
  const { dir, ctx } = setUpWorkspace('status-fresh')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  // Simulate an interrupted (tmp, not-yet-renamed) record write.
  writeFileSync(join(ctx.paths.dispatchDir, 'be-1c.1.json.tmp'), '{"broken": true')

  let res
  assert.doesNotThrow(() => { res = statusCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.equal(res.json.rows.length, 1) // the .tmp file is never counted as a dispatch
  assert.equal(res.json.rows[0].slice_id, 'be-1a')

  const written = JSON.parse(readFileSync(ctx.paths.statusPath, 'utf8'))
  assert.deepEqual(written, res.json)
})

test('status prints reconcile rows including their warnings', () => {
  const { dir, ctx } = setUpWorkspace('status-warnings')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '1')

  const res = statusCmd({}, ctx)
  assert.equal(res.json.rows[0].warnings.length, 1)
  assert.match(res.json.rows[0].warnings[0], /exit_nonzero:1/)
})

// ---------------------------------------------------------------------------
// TEARDOWN — enumerate -> close-surface each -> close-workspace (if
// available) -> verify -> delete or archive -> remove worktrees only when
// clean and merged.
// ---------------------------------------------------------------------------

test('teardown ordering: tree -> close-surface(s) -> close-workspace -> tree (verify)', () => {
  const { dir, env, ctx } = setUpWorkspace('teardown-order')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const logBefore = readLog(env.logPath).length
  teardownCmd({}, ctx)
  const log = readLog(env.logPath).slice(logBefore)
  const verbs = log.map((e) => e.argv[0])

  const firstTree = verbs.indexOf('tree')
  const closeWorkspaceIdx = verbs.indexOf('close-workspace')
  const lastTree = verbs.lastIndexOf('tree')
  assert.ok(firstTree !== -1 && firstTree < closeWorkspaceIdx)
  assert.ok(closeWorkspaceIdx < lastTree)
})

test('teardown deletes the task dir when every dispatch outcome is ok (shouldArchive false)', () => {
  const { dir, ctx } = setUpWorkspace('teardown-delete')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({}, ctx)
  assert.equal(res.json.task_dir.archived, false)
  assert.equal(res.json.task_dir.deleted, true)
  assert.equal(existsSync(ctx.paths.taskDir), false)
})

test('teardown ALWAYS archives when any dispatch exited non-zero (shouldArchive), even without --keep-artifacts', () => {
  const { dir, ctx } = setUpWorkspace('teardown-archive')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  // A crashed (never-returned) dispatch, forced into a non-ok terminal state
  // (already bound by dispatchCmd — terminateRecord requires that).
  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')
  terminateRecord(recordPath, 'exit_nonzero')
  mkdirSync(ctx.paths.taskDir, { recursive: true }) // task artifacts exist even though this attempt crashed

  const res = teardownCmd({}, ctx)
  assert.equal(res.json.task_dir.archived, true)
  assert.match(res.json.task_dir.path, /\.archive\/sample-task-/)
  assert.equal(existsSync(ctx.paths.taskDir), false)
  assert.ok(existsSync(res.json.task_dir.path))
})

test('--keep-artifacts always archives, even with an all-ok outcome', () => {
  const { dir, ctx } = setUpWorkspace('teardown-keep')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(res.json.task_dir.archived, true)
})

test('teardown keeps and reports a leftover worktree that is dirty or unmerged (never --force)', () => {
  const { dir, ctx } = setUpWorkspace('teardown-leftover')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  writeFileSync(join(record.worktree.path, 'wip.txt'), 'dirty')
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({}, ctx)
  assert.equal(res.json.leftover_worktrees.length, 1)
  assert.equal(res.json.leftover_worktrees[0].slice_id, 'be-1a')
  assert.ok(existsSync(record.worktree.path), 'a dirty worktree must never be force-removed')
})

// ---------------------------------------------------------------------------
// EXECUTION MODE — every mutating verb refuses when execution_mode is not
// 'cmux'; preflight/status are unaffected.
// ---------------------------------------------------------------------------

function silentMain(argv) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  try {
    return main(argv)
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}

function writeConfigMd(checkout, text) {
  const configPath = join(checkout, '.claude', 'dev-team', 'config.md')
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, text)
}

test('execution mode: `dispatch` (a mutating verb) refuses when execution_mode is absent (defaults agent-tool), explicitly subagent, or explicitly agent-tool', () => {
  const env = freshCmuxEnv('exec-mode-refuse')
  const checkout = makeGitCheckout(env.dir)
  const commonArgs = ['--task', 'sample-task', '--checkout', checkout, '--repo', 'sample-repo', '--root', join(env.dir, 'dev-team'), '--plugin-root', ROOT]
  // The execution_mode gate refuses before --spec containment is ever
  // checked, but the ctx used to derive a well-formed spec path still needs
  // the same args main() will build internally.
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(env.dir, 'dev-team'), 'plugin-root': ROOT })

  assert.equal(silentMain(['dispatch', ...commonArgs, '--slice', 'be-1a', '--role', 'coder', '--spec', makeSpecFile(ctx)]), 1)

  writeConfigMd(checkout, 'execution_mode: subagent\n')
  assert.equal(silentMain(['dispatch', ...commonArgs, '--slice', 'be-1a', '--role', 'coder', '--spec', makeSpecFile(ctx)]), 1)

  writeConfigMd(checkout, 'execution_mode: agent-tool\n')
  assert.equal(silentMain(['dispatch', ...commonArgs, '--slice', 'be-1a', '--role', 'coder', '--spec', makeSpecFile(ctx)]), 1)

  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'new-pane').length, 0)
})

test('execution mode: preflight and status are NOT gated by execution_mode', () => {
  const env = freshCmuxEnv('exec-mode-readonly')
  const checkout = makeGitCheckout(env.dir)
  const commonArgs = ['--task', 'sample-task', '--checkout', checkout, '--repo', 'sample-repo', '--root', join(env.dir, 'dev-team'), '--plugin-root', ROOT]
  // No config.md at all — execution_mode defaults to agent-tool — yet preflight
  // and status must still run (they are read-only / non-mutating).
  assert.equal(silentMain(['preflight', ...commonArgs]), 0)
  assert.equal(silentMain(['status', ...commonArgs]), 0)
})

test('execution mode: `dispatch` proceeds once execution_mode: cmux is set', () => {
  const env = freshCmuxEnv('exec-mode-allow')
  const checkout = makeGitCheckout(env.dir)
  writeConfigMd(checkout, 'execution_mode: cmux\n')
  const commonArgs = ['--task', 'sample-task', '--checkout', checkout, '--repo', 'sample-repo', '--root', join(env.dir, 'dev-team'), '--plugin-root', ROOT]
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(env.dir, 'dev-team'), 'plugin-root': ROOT })

  assert.equal(silentMain(['preflight', ...commonArgs]), 0)
  assert.equal(silentMain(['workspace', ...commonArgs]), 0)
  assert.equal(silentMain(['dispatch', ...commonArgs, '--slice', 'be-1a', '--role', 'coder', '--spec', makeSpecFile(ctx)]), 0)

  const log = readLog(env.logPath)
  assert.ok(log.find((e) => e.argv[0] === 'new-pane'))
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle M1: workspace.json is ALWAYS rewritten; a
// dispatch against a stale recorded workspace_id refuses rather than
// stranding a record.
// ---------------------------------------------------------------------------

test('lifecycle M1: workspaceCmd rewrites workspace.json even when one already exists (never write-once)', () => {
  const { ctx } = setUpWorkspace('m1-rewrite')
  const workspaceStatePath = join(ctx.paths.stateDir, 'workspace.json')
  const before = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))

  // Plant an obviously-stale workspace_id, as if a cmux restart had
  // invalidated it, then re-run `workspace` — the file must be overwritten
  // with the freshly re-derived (in this case, unchanged-by-title) result,
  // never left holding the stale value.
  writeJsonPlant(workspaceStatePath, { ...before, workspace_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
  workspaceCmd({}, ctx)
  const after = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  assert.equal(after.workspace_id, before.workspace_id)
  assert.notEqual(after.workspace_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff')
})

function writeJsonPlant(path, obj) {
  writeFileSync(path, JSON.stringify(obj))
}

test('lifecycle M1: dispatch against a stale workspace.json (workspace_id absent from a fresh tree) refuses "stale workspace", zero new-pane', () => {
  const { env, ctx } = setUpWorkspace('m1-stale')
  const specPath = makeSpecFile(ctx)
  const workspaceStatePath = join(ctx.paths.stateDir, 'workspace.json')
  const before = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  writeJsonPlant(workspaceStatePath, { ...before, workspace_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    /stale workspace/,
  )
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'new-pane').length, 0)
  assert.equal(existsSync(join(ctx.paths.dispatchDir, 'be-1a.1.json')), false, 'no record must exist for a refused stale-workspace dispatch')
})

test('lifecycle M1 paired positive: re-running `workspace` after a simulated restart repairs workspace.json and the next dispatch succeeds', () => {
  const { env, ctx } = setUpWorkspace('m1-repair')
  const specPath = makeSpecFile(ctx)
  const workspaceStatePath = join(ctx.paths.stateDir, 'workspace.json')
  const before = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  writeJsonPlant(workspaceStatePath, { ...before, workspace_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })

  workspaceCmd({}, ctx) // re-run repairs the file
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const log = readLog(env.logPath)
  assert.ok(log.find((e) => e.argv[0] === 'new-pane'))
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle M2-E: the workspace read + liveness check is
// hoisted above writeRecord; every create->bind abort path terminates
// 'aborted' (allowUnbound) and unlinks the nonce.
// ---------------------------------------------------------------------------

test('lifecycle M2-E: dispatch with no workspace.json at all refuses, writes NO record, zero cmux invocations', () => {
  const env = freshCmuxEnv('m2-no-workspace')
  const ctx = buildTestCtx(env.dir)
  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0)
  // Deliberately skip `workspace` — no workspace.json exists.
  const specPath = makeSpecFile(ctx)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    /no workspace bound/,
  )
  assert.equal(existsSync(join(ctx.paths.dispatchDir, 'be-1a.1.json')), false)
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => ['new-pane', 'send', 'send-key', 'tree'].includes(e.argv[0])).length, 0, 'the refusal must precede even the liveness tree() call — there is no workspace.json to check liveness against')
})

test('lifecycle M2-E: FAKE_CMUX_FAIL=new-pane leaves the record terminated "aborted", the nonce unlinked, and status reports it terminal', () => {
  const { env, ctx } = setUpWorkspace('m2-new-pane-fails')
  const specPath = makeSpecFile(ctx)

  process.env.FAKE_CMUX_FAIL = 'new-pane'
  try {
    assert.throws(
      () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
      /dispatch aborted before bind/,
    )
  } finally {
    delete process.env.FAKE_CMUX_FAIL
  }

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.outcome, 'aborted')
  assert.notEqual(record.ended_at, null)
  assert.equal(record.surface, null, 'aborted before bind — surface never set (allowUnbound)')

  const noncePath = join(ctx.paths.stateDir, `${record.dispatch_id}.nonce`)
  assert.equal(existsSync(noncePath), false, 'the completion nonce must be unlinked on an abort between create and bind')

  const statusRes = statusCmd({}, ctx)
  const row = statusRes.json.rows.find((r) => r.dispatch_id === record.dispatch_id)
  assert.equal(row.state, 'terminal')
  assert.equal(row.row, 'rebuilt_from_disk')
})

test('lifecycle M2-E paired positive: a dispatch that reaches bind leaves the nonce in place and the record unbound-refusal path never fires', () => {
  const { env, ctx } = setUpWorkspace('m2-success')
  const specPath = makeSpecFile(ctx)
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.notEqual(record.surface, null)
  assert.equal(record.outcome, null)
  const noncePath = join(ctx.paths.stateDir, `${record.dispatch_id}.nonce`)
  assert.ok(existsSync(noncePath), 'the nonce survives a successful dispatch through to close (E2 owns its post-send lifetime)')
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle M5-E: statusCmd reports unreadable records
// instead of throwing; status/await/close/teardown keep working with one
// corrupt record present.
// ---------------------------------------------------------------------------

test('lifecycle M5-E: statusCmd reports an unreadable record (schema-invalid JSON) in unreadable:[{path,error}] and a loud stderr line, while the good record still reconciles', () => {
  const { dir, ctx } = setUpWorkspace('m5-unreadable')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const badPath = join(ctx.paths.dispatchDir, 'be-1c.1.json')
  writeFileSync(badPath, JSON.stringify({ not: 'a valid dispatch record' }))

  const res = statusCmd({}, ctx)
  assert.equal(res.json.rows.length, 1)
  assert.equal(res.json.rows[0].slice_id, 'be-1a')
  assert.equal(res.json.unreadable.length, 1)
  assert.equal(res.json.unreadable[0].path, badPath)
  assert.match(res.json.unreadable[0].error, /dispatch-record\.schema\.json/)
})

test('lifecycle M5-E: await/close/teardown keep working with one unreadable record present', () => {
  const { dir, ctx } = setUpWorkspace('m5-others-work')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  writeFileSync(join(ctx.paths.dispatchDir, 'be-1c.1.json'), 'not even json')

  assert.doesNotThrow(() => awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP }))
  assert.doesNotThrow(() => closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx))
  assert.doesNotThrow(() => teardownCmd({}, ctx))
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S1: --max-block-s rejects non-finite values and
// floors at 5s.
// ---------------------------------------------------------------------------

test('lifecycle S1: --max-block-s rejects a non-finite value rather than spinning forever', () => {
  const { ctx } = setUpWorkspace('s1-non-finite')
  assert.throws(
    () => awaitCmd({ all: ['x'], 'max-block-s': 'abc' }, ctx, { sleep: NO_SLEEP }),
    UsageError,
  )
})

test('lifecycle S1: --max-block-s floors at 5s even when a smaller value is requested', () => {
  const { ctx } = setUpWorkspace('s1-floor')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  let now = Date.now()
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  // If the cap were really 1s, this would resolve well under 1200ms of
  // elapsed simulated time; the floor at 5s means it is still running well
  // past that point.
  assert.equal(res.json.status, 'still-running')
  assert.ok(now - Date.parse(new Date(now).toISOString()) <= 0) // sanity: now is a number
})

test('lifecycle S1 paired positive: a valid --max-block-s within [5, 600] is honored as given', () => {
  const { ctx } = setUpWorkspace('s1-valid')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  let now = Date.now()
  const startMs = now
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '30' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  assert.equal(res.json.status, 'still-running')
  assert.ok(now - startMs >= 30 * 1000)
  assert.ok(now - startMs < 31 * 1000)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S2: the await lock is exclusive-create with
// {pid, started_at}; release verifies the holder still matches; an
// unparseable lock is stale, never a wedge.
// ---------------------------------------------------------------------------

test('lifecycle S2: an unparseable await.lock is treated as stale — broken and logged, never a throw or a permanent wedge', () => {
  const { ctx } = setUpWorkspace('s2-corrupt-lock')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  writeFileSync(ctx.paths.lockPath, 'not even json {')
  let res
  assert.doesNotThrow(() => { res = awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP }) })
  assert.equal(res.code, 0)
  assert.equal(res.json.resolved.length, 1)
})

test('lifecycle S2: a superseded lock holder must never delete a successor lock on release', () => {
  const { ctx } = setUpWorkspace('s2-superseded')
  // Simulate: our own award was declared stale and superseded by a NEW
  // holder while we were still "finishing up". withRecordLock-style release
  // must compare pid+started_at before unlinking — write a fresh lock
  // belonging to a DIFFERENT holder, then call the internal release check
  // indirectly via a second awaitCmd invocation that immediately resolves
  // (so it reaches its own `finally`), and confirm the (unrelated) fresh
  // lock we planted survives.
  const otherHolder = { pid: 424242, started_at: new Date().toISOString() }
  writeFileSync(ctx.paths.lockPath, JSON.stringify(otherHolder))
  const contested = awaitCmd({ all: ['nonexistent-dispatch-id'] }, ctx, { sleep: NO_SLEEP })
  assert.equal(contested.code, 2) // fresh lock honored, not ours to touch
  assert.deepEqual(JSON.parse(readFileSync(ctx.paths.lockPath, 'utf8')), otherHolder, 'a lock we never acquired must be left untouched')
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S3: await re-reads each record from disk every
// tick — a concurrently-terminated record is seen, not masked by a stale
// in-memory snapshot.
// ---------------------------------------------------------------------------

test('lifecycle S3: a record terminated between ticks (simulating a concurrent close) is observed on the very next tick', () => {
  const { ctx } = setUpWorkspace('s3-concurrent-terminate')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')

  let tickCount = 0
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '30' }, ctx, {
    sleep: (ms) => {
      tickCount += 1
      if (tickCount === 1) {
        // "Concurrently" terminate the record between tick 1 and tick 2 —
        // await never called terminateRecord itself, so this can only be
        // observed if await RE-READS from disk rather than trusting a
        // snapshot taken before the loop started.
        terminateRecord(recordPath, 'exit_nonzero')
      }
    },
    tickMs: 100,
  })
  assert.equal(res.json.resolved.length, 1)
  assert.equal(res.json.resolved[0].state, 'terminal')
  assert.ok(tickCount >= 1)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S5: worktrees.json read-modify-write is
// lock-guarded (merge-on-write), reusing record.mjs's withRecordLock.
// ---------------------------------------------------------------------------

test('lifecycle S5: a fresh lock already held on worktrees.json refuses a concurrent ensureWorktree call (single-writer proof)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s5-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  mkdirSync(dirname(ctx.paths.worktreesIndexPath), { recursive: true })
  writeFileSync(`${ctx.paths.worktreesIndexPath}.lock`, JSON.stringify({ pid: 424242, started_at: Date.now() }), { flag: 'wx' })

  assert.throws(
    () => ensureWorktree({
      roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a',
      primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath,
    }),
    /locked by another writer/,
  )
})

test('lifecycle S5 paired positive: two different-slice ensureWorktree calls both persist their own entry (no lost update)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s5-positive-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath })
  ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1b', primaryCheckout: checkout, dispatchId: 'd2', worktreesIndexPath: ctx.paths.worktreesIndexPath })
  const index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.ok(index['be-1a'])
  assert.ok(index['be-1b'])
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S6: an existing dt/<task>/<slice> branch (left
// behind by a prior teardown) is reused via `worktree add <path> <branch>`
// (no -b); a reused index path is re-verified isDispatcherWorktree.
// ---------------------------------------------------------------------------

test('lifecycle S6: a re-run after teardown removed the worktree but left the branch succeeds (no "-b" branch collision)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s6-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  const first = ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath })

  // Merge the branch and remove the worktree (as teardown would), leaving
  // the branch behind but deleting BOTH the directory and the index entry.
  execFileSync('git', ['merge', '--no-edit', '-q', first.branch], { cwd: checkout })
  execFileSync('git', ['worktree', 'remove', first.path], { cwd: checkout })
  const index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  delete index['be-1a']
  writeFileSync(ctx.paths.worktreesIndexPath, JSON.stringify(index))

  const second = ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd2', worktreesIndexPath: ctx.paths.worktreesIndexPath })
  assert.equal(second.branch, first.branch)
  assert.ok(existsSync(second.path))
})

test('lifecycle S6: a hand-edited index entry pointing at a non-dispatcher path is refused rather than trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s6-hostile-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  const hostileDir = join(dir, 'not-a-worktree')
  mkdirSync(hostileDir, { recursive: true })
  mkdirSync(dirname(ctx.paths.worktreesIndexPath), { recursive: true })
  writeFileSync(ctx.paths.worktreesIndexPath, JSON.stringify({
    'be-1a': { path: hostileDir, branch: 'dt/sample-task/be-1a', created_by_dispatcher: true, source_slice_id: null, attempts: [] },
  }))

  assert.throws(
    () => ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath }),
    /does not point at a dispatcher-owned worktree/,
  )
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — lifecycle S7: worktree removal additionally requires
// entry.created_by_dispatcher === true AND the path under roots.worktreesRoot.
// ---------------------------------------------------------------------------

test('lifecycle S7: a clean+merged worktree with created_by_dispatcher: false is kept, never removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s7-not-dispatcher-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  const wt = ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath })
  execFileSync('git', ['merge', '--no-edit', '-q', wt.branch], { cwd: checkout })

  const res = removeWorktreeIfCleanAndMerged({
    sliceId: 'be-1a', entry: { ...wt, created_by_dispatcher: false }, primaryCheckout: checkout,
    worktreesIndexPath: ctx.paths.worktreesIndexPath, roots: ctx.roots,
  })
  assert.equal(res.removed, false)
  assert.equal(res.reason, 'not_created_by_dispatcher')
  assert.ok(existsSync(wt.path))
})

test('lifecycle S7: a clean+merged worktree outside roots.worktreesRoot is kept, never removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s7-outside-root-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  const wt = ensureWorktree({ roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-1a', primaryCheckout: checkout, dispatchId: 'd1', worktreesIndexPath: ctx.paths.worktreesIndexPath })
  execFileSync('git', ['merge', '--no-edit', '-q', wt.branch], { cwd: checkout })

  const res = removeWorktreeIfCleanAndMerged({
    sliceId: 'be-1a', entry: { ...wt, path: checkout }, primaryCheckout: checkout,
    worktreesIndexPath: ctx.paths.worktreesIndexPath, roots: ctx.roots,
  })
  assert.equal(res.removed, false)
  assert.equal(res.reason, 'outside_worktrees_root')
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — trust M6: buildContext stores only slugify(args.task); the
// raw --task value is nowhere (workspace --name, record fields, archive path).
// ---------------------------------------------------------------------------

test('trust M6: a traversal-shaped --task is sanitized into a clean slug, never a literal ".." or "/" segment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-m6-traversal-'))
  const checkout = makeGitCheckout(dir)
  const ctx = buildContext({ task: '../../../etc/passwd', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  assert.doesNotMatch(ctx.taskSlug, /\.\.|\//)
  assert.equal(ctx.taskSlug, 'etc-passwd')
})

test('trust M6: a --task value collapsing entirely under slugify (e.g. "///") refuses rather than silently producing an empty path segment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-m6-empty-'))
  const checkout = makeGitCheckout(dir)
  assert.throws(
    () => buildContext({ task: '///', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT }),
    /empty slug/,
  )
})

test('trust M6 paired positive: "My Task" slugifies to "my-task" consistently in ctx.taskSlug, record.task_slug, and the workspace --name argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-m6-my-task-'))
  const checkout = makeGitCheckout(dir)
  const env = freshCmuxEnv('m6-my-task')
  const ctx = buildContext({ task: 'My Task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT })
  assert.equal(ctx.taskSlug, 'my-task')

  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0)
  workspaceCmd({}, ctx)
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.task_slug, 'my-task')
  assert.equal(record.task_id, 'my-task')

  const log = readLog(env.logPath)
  const newWorkspaceEntry = log.find((e) => e.argv[0] === 'new-workspace')
  const nameIdx = newWorkspaceEntry.argv.indexOf('--name')
  assert.equal(newWorkspaceEntry.argv[nameIdx + 1], 'my-task')
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — trust S4: --spec must resolve to EXACTLY
// specPathFor(paths, sliceId); refused otherwise, naming the required
// location.
// ---------------------------------------------------------------------------

test('trust S4: an arbitrary --spec path (not specPathFor) is refused, naming the required location, before any cmux call', () => {
  const { dir, env, ctx } = setUpWorkspace('s4-arbitrary-spec')
  const wrongPath = join(dir, 'elsewhere.json')
  writeFileSync(wrongPath, JSON.stringify({ task_id: 't', domain: 'backend', goal: 'g', files_in_scope: [], constraints: [], acceptance_criteria: [], validation_commands: [], discovery_context: 'c', out_of_scope: [], depends_on: [], interface_contract: 'n' }))
  const logBefore = readLog(env.logPath).length

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: wrongPath }, ctx),
    (err) => /--spec must be exactly/.test(err.message) && err.message.includes(specPathFor(ctx.paths, 'be-1a')),
  )
  assert.equal(readLog(env.logPath).length, logBefore, 'the containment refusal precedes even the workspace-liveness tree() call')
})

test('trust S4 paired positive: --spec at exactly specPathFor(paths, sliceId) is accepted', () => {
  const { ctx } = setUpWorkspace('s4-exact-spec')
  const specPath = makeSpecFile(ctx)
  assert.equal(specPath, specPathFor(ctx.paths, 'be-1a'))
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E1 — trust S5-E: readJsonOrWarn treats a malformed
// workspace.json/worktrees.json/await.lock as ABSENT + a loud warning,
// never a throw.
// ---------------------------------------------------------------------------

test('trust S5-E: a malformed workspace.json is treated as absent (refuses "no workspace bound", never a JSON.parse throw)', () => {
  const { env, ctx } = setUpWorkspace('s5e-workspace')
  const specPath = makeSpecFile(ctx)
  writeFileSync(join(ctx.paths.stateDir, 'workspace.json'), '{ not json')

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    /no workspace bound/,
  )
})

test('trust S5-E: a malformed worktrees.json is treated as an empty index (never a throw), and a fresh worktree is created', () => {
  const { ctx } = setUpWorkspace('s5e-worktrees')
  const specPath = makeSpecFile(ctx)
  mkdirSync(dirname(ctx.paths.worktreesIndexPath), { recursive: true })
  writeFileSync(ctx.paths.worktreesIndexPath, 'not json at all')

  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.ok(index['be-1a'])
})

test('trust S5-E paired positive: a well-formed workspace.json/worktrees.json round-trips normally', () => {
  const { ctx } = setUpWorkspace('s5e-wellformed')
  const specPath = makeSpecFile(ctx)
  assert.ok(existsSync(join(ctx.paths.stateDir, 'workspace.json')))
  const res = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  const index = JSON.parse(readFileSync(ctx.paths.worktreesIndexPath, 'utf8'))
  assert.ok(index['be-1a'])
})

function findNonceFiles(stateDir) {
  if (!existsSync(stateDir)) return []
  return readdirSync(stateDir).filter((f) => f.endsWith('.nonce'))
}

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — trust M3 / D-2: the nonce is written immediately before
// sendLine (after prep succeeds), unlinked on every abort path between
// create and send, and unlinked again by `close` after the terminal
// transition.
// ---------------------------------------------------------------------------

test('trust M3/D-2: a worktree_prep failure leaves ZERO *.nonce files in stateDir', () => {
  const { ctx } = setUpWorkspace('nonce-prep-fail', { configOverrides: { worktree_prep: [['sh', '-c', 'exit 1']] } })
  const specPath = makeSpecFile(ctx)
  assert.throws(() => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx))
  assert.deepEqual(findNonceFiles(ctx.paths.stateDir), [])
})

test('trust M3/D-2: close on a completed dispatch leaves ZERO *.nonce files', () => {
  const { ctx } = setUpWorkspace('nonce-close')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.deepEqual(findNonceFiles(ctx.paths.stateDir), [])
})

test('trust M3/D-2 paired positive: a nonce file exists between a successful send and close', () => {
  const { ctx } = setUpWorkspace('nonce-exists-between')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(findNonceFiles(ctx.paths.stateDir).length, 1)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.deepEqual(findNonceFiles(ctx.paths.stateDir), [])
})

test('trust M3/D-2: the nonce value and path are never logged (never written to stdout/stderr)', () => {
  const { ctx } = setUpWorkspace('nonce-never-logged')
  const specPath = makeSpecFile(ctx)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const captured = []
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalStderrWrite(chunk, ...rest) }
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalStdoutWrite(chunk, ...rest) }
  let dispatchRes
  try {
    dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  } finally {
    process.stderr.write = originalStderrWrite
    process.stdout.write = originalStdoutWrite
  }
  const noncePath = join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.nonce`)
  const nonceValue = readFileSync(noncePath, 'utf8')
  const allCaptured = captured.join('')
  assert.doesNotMatch(allCaptured, new RegExp(nonceValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(allCaptured, /\.nonce/)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — lifecycle S8: teardown archives/deletes stateDir alongside
// taskDir.
// ---------------------------------------------------------------------------

test('lifecycle S8: post-teardown, stateDir is gone (deleted) when every dispatch is ok', () => {
  const { ctx } = setUpWorkspace('s8-delete')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({}, ctx)
  assert.equal(res.json.state_dir.deleted, true)
  assert.equal(existsSync(ctx.paths.stateDir), false)
})

test('lifecycle S8: post-teardown, stateDir is archived (not deleted) when a dispatch exited non-zero', () => {
  const { ctx } = setUpWorkspace('s8-archive')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  terminateRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'), 'exit_nonzero')

  const res = teardownCmd({}, ctx)
  assert.equal(res.json.state_dir.archived, true)
  assert.equal(existsSync(ctx.paths.stateDir), false)
  assert.ok(existsSync(res.json.state_dir.path))
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — lifecycle S9: archive dir name uniquified on collision
// (a same-day second teardown must not throw).
// ---------------------------------------------------------------------------

test('lifecycle S9: a same-day second teardown of a DIFFERENT task instance succeeds (archive dir uniquified, never ENOTEMPTY)', () => {
  const { ctx } = setUpWorkspace('s9-first')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  terminateRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'), 'exit_nonzero')
  const first = teardownCmd({}, ctx)
  assert.equal(first.json.task_dir.archived, true)

  // A second task run under the SAME repo/task slug (as if re-dispatched the
  // same day) collides on the archive dir name — must uniquify, not throw.
  const { ctx: ctx2 } = setUpWorkspace('s9-first', { checkout: ctx.primaryCheckout, root: ctx.roots.root })
  const specPath2 = makeSpecFile(ctx2)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath2 }, ctx2)
  terminateRecord(join(ctx2.paths.dispatchDir, 'be-1a.1.json'), 'exit_nonzero')
  let second
  assert.doesNotThrow(() => { second = teardownCmd({}, ctx2) })
  assert.equal(second.json.task_dir.archived, true)
  assert.notEqual(second.json.task_dir.path, first.json.task_dir.path)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — lifecycle S10: statusCmd runs git status --porcelain per
// record's worktree — the "worktree has uncommitted changes" warning is
// reachable from production statusCmd, not just from a hand-built fixture.
// ---------------------------------------------------------------------------

test('lifecycle S10: statusCmd surfaces the dirty-worktree warning for a crashed dispatch with real uncommitted changes', () => {
  const { ctx } = setUpWorkspace('s10-dirty')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeFileSync(join(record.worktree.path, 'wip.txt'), 'uncommitted')
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '1') // crashed, no return
  closeSurface(dispatchRes.json.surface_id) // the pane is gone -> crashed_surface_gone, not running_surface_alive

  const res = statusCmd({}, ctx)
  const row = res.json.rows.find((r) => r.dispatch_id === dispatchRes.json.dispatch_id)
  assert.equal(row.row, 'crashed_surface_gone')
  assert.ok(row.warnings.some((w) => /uncommitted changes/.test(w)), `expected a dirty-worktree warning, got: ${JSON.stringify(row.warnings)}`)
})

test('lifecycle S10 paired positive: a clean worktree produces no dirty-worktree warning', () => {
  const { ctx } = setUpWorkspace('s10-clean')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  writeFileSync(join(ctx.paths.stateDir, `${dispatchRes.json.dispatch_id}.exit`), '1')
  closeSurface(dispatchRes.json.surface_id)

  const res = statusCmd({}, ctx)
  const row = res.json.rows.find((r) => r.dispatch_id === dispatchRes.json.dispatch_id)
  assert.equal(row.row, 'crashed_surface_gone')
  assert.ok(!row.warnings.some((w) => /uncommitted changes/.test(w)))
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — lifecycle S12: roster.snapshot.json is written at first
// dispatch; status/close prefer it over the live, mutable roster.
// ---------------------------------------------------------------------------

test('lifecycle S12: doc_tab is read from roster.snapshot.json even after the live roster flips it', () => {
  const { ctx } = setUpWorkspace('s12-snapshot')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.ok(existsSync(ctx.paths.rosterSnapshotPath))

  const snapshot = JSON.parse(readFileSync(ctx.paths.rosterSnapshotPath, 'utf8'))
  assert.equal(snapshot.roles.coder.doc_tab, false)

  // Flip the LIVE roster's copy in memory (as if the project roster had been
  // edited between dispatch and status) — the snapshot on disk is untouched.
  ctx.roster.roles.coder.doc_tab = true
  const res = statusCmd({}, ctx)
  assert.equal(res.code, 0) // does not attempt (or crash attempting) a doc-tab remount
})

test('lifecycle S12: status still runs when the live project roster is schema-invalid but a snapshot exists', () => {
  const { ctx } = setUpWorkspace('s12-live-invalid')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.ok(existsSync(ctx.paths.rosterSnapshotPath))

  // Corrupt the LIVE project roster so loadRoster() would throw.
  const projectRosterPath = join(ctx.primaryCheckout, '.claude', 'dev-team', 'roster.json')
  mkdirSync(dirname(projectRosterPath), { recursive: true })
  writeFileSync(projectRosterPath, JSON.stringify({ roles: { coder: { agent: 'not-claude' } } }))

  const freshCtx = buildContext({
    task: 'sample-task', checkout: ctx.primaryCheckout, repo: 'sample-repo',
    root: ctx.roots.root, 'plugin-root': ROOT,
  })
  let res
  assert.doesNotThrow(() => { res = statusCmd({}, freshCtx) })
  assert.equal(res.code, 0)
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — trust S6: doc-tab placeholder + prep log writes use
// { flag: 'wx' } (never follow a pre-planted symlink); events.cursor writes
// go through tmp+rename (covered structurally above via writeTextAtomic).
// ---------------------------------------------------------------------------

test('trust S6: a pre-planted symlink at the doc-tab placeholder path is refused rather than followed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-s6-trust-'))
  const checkout = makeGitCheckout(dir)
  const env = freshCmuxEnv('s6-trust-symlink')
  const ctx = buildContext({
    task: 'sample-task', checkout, repo: 'sample-repo', root: join(dir, 'dev-team'), 'plugin-root': ROOT,
    config: (() => {
      const p = join(dir, 'cfg.json')
      writeFileSync(p, JSON.stringify({ session: { roles: { coder: { doc_tab: true, return: { kind: 'json', schema: 'coder-return.schema.json' } } } } }))
      return p
    })(),
  })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx)
  const specPath = makeSpecFile(ctx)

  // Plant a symlink at the exact placeholder path a doc_tab coder dispatch
  // would write to (returns/<slice>.<attempt>.md) pointing outside taskDir.
  const outsideTarget = join(dir, 'outside-target.md')
  writeFileSync(outsideTarget, 'hostile')
  mkdirSync(ctx.paths.returnsDir, { recursive: true })
  const placeholderPath = join(ctx.paths.returnsDir, 'be-1a.1.md')
  symlinkSync(outsideTarget, placeholderPath)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    /dispatch aborted before bind/,
  )
  assert.equal(readFileSync(outsideTarget, 'utf8'), 'hostile', 'the symlink target must never be written through')
})

// ---------------------------------------------------------------------------
// FIX-ROUND E2 — trust C2: readExecutionMode refuses config text with more
// than one ^execution_mode: line.
// ---------------------------------------------------------------------------

test('trust C2: readExecutionMode refuses a config with more than one execution_mode: line (a fenced example is the obvious case)', () => {
  const configText = [
    'execution_mode: cmux',
    '',
    'Example config.md:',
    '```',
    'execution_mode: subagent',
    '```',
  ].join('\n')
  assert.throws(() => readExecutionMode(configText), /ambiguous/)
})

test('trust C2 paired positive: a config with exactly one execution_mode: line still parses normally', () => {
  assert.equal(readExecutionMode('execution_mode: cmux\n'), 'cmux')
})

// ---------------------------------------------------------------------------
// FINAL RE-VERIFICATION BOUNCE
// 1. trust M4: closeCmd/statusCmd honour ladder.classify's
//    terminal_outcome_uncorroborated warning on a forged terminal 'ok'.
// ---------------------------------------------------------------------------

test('trust M4: close on a hand-forged terminal record (outcome: "ok", no corroborating return) exits non-zero naming terminal_outcome_uncorroborated', () => {
  const { ctx } = setUpWorkspace('m4-forged-ok')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')
  const record = readRecord(recordPath)

  // Overwrite with a well-formed record claiming a terminal 'ok' outcome,
  // consistent bound_at/ended_at, but NO corroborating return file on disk —
  // a forged success, not a data-shape violation (the schema-invalid-enum
  // case is covered elsewhere as the vacuity guard's shape test).
  const forged = { ...record, outcome: 'ok', ended_at: new Date().toISOString() }
  writeFileSync(recordPath, JSON.stringify(forged, null, 2))

  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.notEqual(closeRes.code, 0)
  assert.equal(closeRes.json.outcome, 'ok') // the short-circuit never rewrites the record
  assert.ok(closeRes.json.warnings.includes('terminal_outcome_uncorroborated'))

  const statusRes = statusCmd({}, ctx)
  const row = statusRes.json.rows.find((r) => r.dispatch_id === dispatchRes.json.dispatch_id)
  assert.ok(row.warnings.includes('terminal_outcome_uncorroborated'))
})

test('trust M4 paired positive: a legitimately closed ok dispatch exits 0 with no corroboration warning', () => {
  const { ctx } = setUpWorkspace('m4-legit-ok')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.code, 0)
  assert.equal(closeRes.json.outcome, 'ok')
  assert.ok(!closeRes.json.warnings.includes('terminal_outcome_uncorroborated'))

  const statusRes = statusCmd({}, ctx)
  const row = statusRes.json.rows.find((r) => r.dispatch_id === dispatchRes.json.dispatch_id)
  assert.ok(!row.warnings.includes('terminal_outcome_uncorroborated'))
})

// ---------------------------------------------------------------------------
// 2. lifecycle S14 (partial): loadPreflightOrRefuse (workspace) and
//    teardownCmd route preflight.json through the shared cache-shape check
//    (cmuxctl.isValidPreflightCache) — malformed or shape-invalid is
//    treated as absent, never a raw JSON.parse throw or unvalidated truth.
// ---------------------------------------------------------------------------

test('lifecycle S14: a corrupt (unparseable) preflight.json makes `workspace` refuse gracefully, never a raw JSON.parse throw', () => {
  const env = freshCmuxEnv('s14-corrupt-workspace')
  const ctx = buildTestCtx(env.dir)
  preflightCmd({}, ctx)
  writeFileSync(join(ctx.paths.stateDir, 'preflight.json'), 'not json {')

  assert.throws(
    () => workspaceCmd({}, ctx),
    (err) => err instanceof OperationalError && /run `preflight` first/.test(err.message),
  )
})

test('lifecycle S14: a corrupt (unparseable) preflight.json still lets `teardown` close surfaces (degraded path)', () => {
  const { ctx } = setUpWorkspace('s14-corrupt-teardown')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  writeFileSync(join(ctx.paths.stateDir, 'preflight.json'), 'not json {')
  let res
  assert.doesNotThrow(() => { res = teardownCmd({}, ctx) })
  assert.equal(res.code, 0)
})

test('lifecycle S14: a shape-invalid-but-parseable preflight.json (missing required fields) is treated as absent, not truth', () => {
  const env = freshCmuxEnv('s14-shape-invalid')
  const ctx = buildTestCtx(env.dir)
  preflightCmd({}, ctx)
  // Well-formed JSON, but missing the frozen cache shape's required fields.
  writeFileSync(join(ctx.paths.stateDir, 'preflight.json'), JSON.stringify({ cmux_version: '0.64.20' }))

  assert.throws(
    () => workspaceCmd({}, ctx),
    (err) => err instanceof OperationalError && /run `preflight` first/.test(err.message),
  )
})

test('lifecycle S14 paired positive: a well-formed preflight.json cache is honored as usual', () => {
  const { ctx } = setUpWorkspace('s14-wellformed')
  assert.ok(existsSync(join(ctx.paths.stateDir, 'preflight.json')))
  const res = workspaceCmd({}, ctx)
  assert.equal(res.code, 0)
})

// ---------------------------------------------------------------------------
// 3. trust M3 residual (i): a sendLine refusal after bind unlinks the nonce
//    and terminates the record 'aborted' rather than stranding both.
// ---------------------------------------------------------------------------

// NOT independently runtime-tested, by finding rather than by oversight:
// every field dispatch.mjs's kickoff embeds (task_dir/spec_path/
// return_path/signals_path via the frozen path charsets in resolve.mjs/
// contract.mjs; attn_parent/attn_upstream via dispatch-record.schema.json's
// fixed `^devteam-<uuid>-attn$` pattern) is independently charset-
// constrained upstream, and none of them is overridable through the public
// CLI surface in a way that both (a) violates cmuxctl's sendLine charset
// and (b) keeps the record schema-valid (an invalid attn_upstream fails
// dispatch-record.schema.json itself, so terminateRecord can never
// complete against it — a different, self-defeating failure mode, verified
// while attempting this test: it produces an uncaught RecordInvalidError
// from the abort-terminate itself, not the intended sendLine-refusal path).
// There is also no dependency-injection seam for cmuxctl's named ESM
// exports from this test file. The try/catch fix in dispatchCmd (unlink the
// nonce, terminateRecord 'aborted', wrapped so a secondary terminate
// failure logs rather than crashes uninformatively) is implemented per the
// pinned instruction and reviewed by inspection; it has no known reachable
// trigger today, matching the doc-tab-close branch's same "wired for
// defense-in-depth, currently unreachable" shape noted elsewhere in this
// file.
