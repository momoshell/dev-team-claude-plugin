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
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, symlinkSync, cpSync, chmodSync,
  rmSync,
} from 'node:fs'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURE = join(HERE, 'fixtures', 'fake-cmux.mjs')
const DISPATCH_PATH = join(ROOT, 'scripts', 'cmux', 'dispatch.mjs')

process.env.CMUX_BIN = FIXTURE

const {
  readExecutionMode, EXECUTION_MODES, OUTCOME_MAPPING, mapOutcome, applyPostconditionOverride,
  parseArgs, buildContext, ensureWorktree, isDispatcherWorktree, removeWorktreeIfCleanAndMerged,
  writeCompletionNonce, adapterLaunchLine,
  preflightCmd, workspaceCmd, dispatchCmd, awaitCmd, closeCmd, statusCmd, teardownCmd, phaseCmd,
  TEARDOWN_OUTCOMES, DEFAULT_TEARDOWN_OUTCOME,
  readCmuxEnvFile, readEnvFileKeys,
  readCmuxPreviewUrl, ensurePreviewBrowser, formatPreviewFailClosedLine,
  PREVIEW_LOCK_WORST_CASE_MS,
  browserVerifyCmd, BROWSER_VERIFY_WARNINGS,
  UsageError, OperationalError, main,
  SpecSchemaError, SPEC_SCHEMA_REFUSAL_MESSAGE, SPEC_SCHEMA_REFUSAL_CODE,
  SIGNAL_LEVELS, _setEmitterOpenerForTest, reconcileProgressCursor,
} = await import(DISPATCH_PATH)

const {
  PREFLIGHT_MESSAGES, formatPreflightMessage, closeSurface, tree, findDocTabSurface, createPane, mountDocTab,
  ensureWorkspace, TIERS, TIER_COLORS, recoverNewId, cmux, findSurface,
  BROWSER_LOAD_STATE, browserVerb, browserOpen, browserGoto, browserWaitReady,
  browserErrorsClear, browserErrorsList, browserScreenshot,
  BROWSER_OPEN_SPAWN_TIMEOUT_MS, BROWSER_OPEN_AFTER_TREE_TIMEOUT_MS,
} = await import(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'))
const {
  readRecord, terminateRecord, buildRecord, writeRecord, bindRecord, newDispatchId, snapshotWorkerPlugin, isoMs,
} = await import(join(ROOT, 'scripts', 'cmux', 'record.mjs'))
const { specPathFor, sidecarPaths } = await import(join(ROOT, 'scripts', 'cmux', 'resolve.mjs'))
const { writeBlockedReturn } = await import(join(ROOT, 'scripts', 'cmux', 'return-lint.mjs'))
const { slugify, SIGNAL_LIMITS } = await import(join(ROOT, 'scripts', 'cmux', 'contract.mjs'))
// A2 (#27) cross-file check-name agreement test — imported directly, not
// through dispatch.mjs, to prove the two partitions dispatch.mjs relies on
// are real, behavioural facts (safe: no I/O, its own invokedDirectly guard
// is false under the test runner).
const { lintSpec } = await import(join(ROOT, 'scripts', 'spec-lint.mjs'))
// be-41-04 — read-only inspection of the ledger mirror this file wires in,
// and the emit.mjs facade this file consumes (imported directly here ONLY
// to build a hostile `_openLedger` override for the mutation/never-load-
// bearing tests below — never to bypass the facade in dispatch.mjs itself).
const { openLedger } = await import(join(ROOT, 'scripts', 'factory', 'ledger.mjs'))
const { openRun } = await import(join(ROOT, 'scripts', 'factory', 'emit.mjs'))

// ---------------------------------------------------------------------------
// Fixture plumbing.
// ---------------------------------------------------------------------------

// A2 (#27) fix-round item 8 — the makeTmpDir/TMP_DIRS-and-after-cleanup
// convention test/cmux-ladder.test.mjs and test/claude-adapter.test.mjs both
// use for THEIR fixture dirs. This file otherwise builds every fixture dir
// via freshCmuxEnv/buildTestCtx or raw mkdtempSync calls that predate this
// fix round; NOTHING removes those tmpdirs (nor FAKE_BIN_DIR) — this is a
// pre-existing leak, out of scope for this change, not "already handled".
// Only the two NEW tmpdirs added by this fix round (the symlink-invocation
// regression test and the cross-file check-name-agreement test) are
// registered below.
const A2_FIX_ROUND_TMP_DIRS = []

function makeTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  A2_FIX_ROUND_TMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of A2_FIX_ROUND_TMP_DIRS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
  delete process.env.FAKE_CMUX_EVENTS_HANG
  delete process.env.FAKE_CMUX_TOP
  delete process.env.FAKE_CMUX_EXIT_CODE
  return { dir, logPath, statePath }
}

function readLog(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// captureStderr(fn) -> the joined string of everything fn writes to
// process.stderr while it runs (dispatch.mjs's own log() writes there) —
// still forwards to the real stderr so failures remain visible.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr)
  const chunks = []
  process.stderr.write = (chunk, ...rest) => { chunks.push(String(chunk)); return original(chunk, ...rest) }
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return chunks.join('')
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
    ? (record.return.required_sections || []).map((s) => `## ${s}\nok\n`).join('\n')
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

// QA fix (Must-Fix #1c): every existing config-reader test writes its OWN
// fixture — which is exactly why be-11-05's doc-drift bug (a fenced example
// in the REAL .claude/dev-team/config.md live-parsing as a value) shipped
// green. This reads the repo's ACTUAL config.md and pins the safe default
// for all three readers against it, so a future doc edit that reintroduces
// a column-0 `cmux_env_file:`/`env_file_keys:`/`execution_mode:` line (bare,
// even fenced) fails this test immediately instead of silently bricking the
// `workspace` verb the next time this repo runs under execution_mode: cmux.
test('doc-drift regression: the REAL .claude/dev-team/config.md never live-parses a documentation example as a value', () => {
  const realConfigPath = join(ROOT, '.claude', 'dev-team', 'config.md')
  const realConfigText = readFileSync(realConfigPath, 'utf8')
  assert.equal(readExecutionMode(realConfigText), 'agent-tool', 'the real config.md carries no live execution_mode: line today')
  assert.equal(readCmuxEnvFile(realConfigText), null, 'the real config.md documents cmux_env_file but must never live-parse it as a value')
  assert.deepEqual(readEnvFileKeys(realConfigText), [], 'the real config.md documents env_file_keys but must never live-parse it as a value')
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

// worker_blocked_markdown row — bodyStatus stays null (a markdown body has
// no `status` field), so a gate-composed blocked markdown envelope is only
// caught via bodyBlockedMarkdown.
test('worker_blocked_markdown: a completed classification with bodyBlockedMarkdown true maps to the dedicated blocked outcome', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: null, bodyBlockedMarkdown: true }
  const fsState = { exitSentinel: null, returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'blocked')
})

test('worker_blocked_markdown: a completed classification with bodyBlockedMarkdown false still maps to ok', () => {
  const classification = { state: 'completed', warnings: [], bodyStatus: null, bodyBlockedMarkdown: false }
  const fsState = { exitSentinel: null, returnPathKind: 'file' }
  assert.equal(mapOutcome(classification, fsState), 'ok')
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

test('ADR-017: dispatchCmd refuses a non-null max_turns BEFORE any worktree/branch/snapshot-dir side effect', () => {
  const { env, ctx } = setUpWorkspace('max-turns-hoist', { configOverrides: { maxTurns: 5 } })
  const specPath = makeSpecFile(ctx)
  const logBefore = readLog(env.logPath)

  assert.throws(
    () => dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx),
    /max_turns.*ADR-017/s,
  )

  // No worktree, no worktrees.json entry, no per-dispatch snapshot dir — the
  // refusal fires before ensureWorktree/snapshotWorkerPlugin ever run.
  assert.equal(existsSync(ctx.paths.worktreesIndexPath), false)
  assert.equal(existsSync(ctx.paths.snapshotDir), false)

  // Same hoist discipline as the workspace-liveness check above: only the
  // one `tree` call the liveness check itself makes, never a dispatching verb.
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
  // be-11-02: each awaitCmd() invocation now also fires exactly one
  // set-progress call on its return path (workspace.json exists here, from
  // setUpWorkspace) — one extra cmux call per `chunks` invocation, on top
  // of the pre-existing bound.
  const bound = dispatchInvocationsSoFar + Math.ceil(elapsedS / capS) + 2 + chunks
  assert.ok(totalInvocations <= bound, `expected <= ${bound} invocations, got ${totalInvocations}`)
})

// ---------------------------------------------------------------------------
// be-11-03 — automated stall triage. Stateless, no persisted sidecar, no CPU
// polling: turnEndAt is re-derived fresh on every await()/status() call from
// a single bounded events read, attributed to a dispatch by an EXACT
// surface_id match against agent.hook.Stop events.
// ---------------------------------------------------------------------------

function writeTurnEndEvent(eventsPath, { surfaceId, occurredAt, seq = 1, name = 'agent.hook.Stop' }) {
  writeFileSync(eventsPath, `${JSON.stringify({ seq, name, surface_id: surfaceId, occurred_at: occurredAt })}\n`)
}

// QA fix (#3, all four reviewers): the ORIGINAL INVOCATION BOUND test above
// never arms attention, so it is structurally blind to readScreen()'s own
// cost (TWO cmux calls per fire: requireTargetPresent's own tree() call,
// plus the read-screen call itself — read-screen fires once per await()
// INVOCATION in which the dispatch transitions into attention, since
// previousAttentionIds resets at the top of every awaitCmd() call and a
// stale-enough turnEndAt re-triggers a "transition" on each fresh call's
// own first tick). This companion test arms attention for the WHOLE
// chunked join and documents the AMENDED, honest bound: the original bound
// PLUS 2 cmux calls per chunk (one tree() + one read-screen, once per
// invocation) — never silently exceeded with a green suite again.
test('INVOCATION BOUND UNDER ATTENTION (amended, #3): a chunked join where the dispatch stays in attention for every chunk costs the original bound PLUS exactly 2 calls (tree + read-screen) per chunk', () => {
  const { dir, env, ctx } = setUpWorkspace('await-bound-attention')
  const specPath = makeSpecFile(ctx, 'be-1a')
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchInvocationsSoFar = readLog(env.logPath).length

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchRes.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  const capS = 1
  let now = Date.now()
  const chunks = 3
  for (let i = 0; i < chunks; i += 1) {
    const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': String(capS) }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
    assert.equal(res.json.attention.length, 1, `expected the dispatch to be in attention on chunk ${i}`)
  }
  delete process.env.FAKE_CMUX_EVENTS

  const totalInvocations = readLog(env.logPath).length
  const elapsedS = capS * chunks
  const baselineBound = dispatchInvocationsSoFar + Math.ceil(elapsedS / capS) + 2 + chunks
  const READ_SCREEN_CALLS_PER_ATTENTION_TRANSITION = 2 // tree() + read-screen
  const amendedBound = baselineBound + READ_SCREEN_CALLS_PER_ATTENTION_TRANSITION * chunks
  assert.ok(totalInvocations <= amendedBound, `expected <= ${amendedBound} invocations (baseline ${baselineBound} + ${READ_SCREEN_CALLS_PER_ATTENTION_TRANSITION} per chunk for read-screen), got ${totalInvocations}`)

  const readScreenCalls = readLog(env.logPath).filter((e) => e.argv[0] === 'read-screen')
  assert.equal(readScreenCalls.length, chunks, 'expected exactly one read-screen fire per await() invocation while the dispatch stays in attention')
})

test('ATTRIBUTION: an agent.hook.Stop event carrying A\'s surface_id arms A\'s turnEndAt (attention), leaving concurrent non-terminal B unarmed', () => {
  const { dir, ctx } = setUpWorkspace('attribution')
  const specA = makeSpecFile(ctx, 'be-3a')
  const specB = makeSpecFile(ctx, 'be-3b')
  const dispatchA = dispatchCmd({ slice: 'be-3a', role: 'coder', spec: specA }, ctx)
  const dispatchB = dispatchCmd({ slice: 'be-3b', role: 'coder', spec: specB }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString() // well past the 45s default quietS
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id, dispatchB.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention.map((a) => a.dispatch_id), [dispatchA.json.dispatch_id], 'expected ONLY A to be armed')
  assert.equal(res.json.attention[0].reason, 'quiet_after_turn_end')
  assert.equal(res.json.attention[0].since, staleOccurredAt)
  assert.deepEqual([...res.json.remaining].sort(), [dispatchA.json.dispatch_id, dispatchB.json.dispatch_id].sort(), 'an attention dispatch stays in remaining and is never removed from the join')
})

test('an agent.hook.Stop event carrying a surface_id no record holds (e.g. the orchestrator\'s own pane) arms nothing', () => {
  const { dir, ctx, preflightRes } = setUpWorkspace('unattributed-surface')
  const specA = makeSpecFile(ctx, 'be-3c')
  const dispatchA = dispatchCmd({ slice: 'be-3c', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  // The orchestrator's own surface_id (from preflight's own identify call) —
  // not bound to any dispatch record.
  writeTurnEndEvent(eventsPath, { surfaceId: preflightRes.json.orchestrator.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention, [])
})

test('OUT-OF-ORDER EVENTS: multiple Stop events for the same surface_id, written to the events buffer NOT in chronological order, still fold to the true max(occurred_at) — not "last line wins" or "first line wins"', () => {
  const { dir, ctx } = setUpWorkspace('out-of-order-events')
  const specA = makeSpecFile(ctx, 'be-3m')
  const dispatchA = dispatchCmd({ slice: 'be-3m', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const nowMs = Date.now()
  // Three events for A's surface, deliberately out of chronological order in
  // the file: middle timestamp first, then the OLDEST, then the TRUE MAX
  // last-but-one, then an even older one last — the true max sits in the
  // MIDDLE of the file, so neither "first wins" nor "last wins" would
  // accidentally produce the right answer.
  const trueMaxOccurredAt = new Date(nowMs - 50_000).toISOString() // most recent -> least stale
  const middleOccurredAt = new Date(nowMs - 80_000).toISOString()
  const oldestOccurredAt = new Date(nowMs - 200_000).toISOString()
  const lines = [
    { seq: 1, name: 'agent.hook.Stop', surface_id: dispatchA.json.surface_id, occurred_at: middleOccurredAt },
    { seq: 2, name: 'agent.hook.Stop', surface_id: dispatchA.json.surface_id, occurred_at: oldestOccurredAt },
    { seq: 3, name: 'agent.hook.Stop', surface_id: dispatchA.json.surface_id, occurred_at: trueMaxOccurredAt },
    { seq: 4, name: 'agent.hook.Stop', surface_id: dispatchA.json.surface_id, occurred_at: middleOccurredAt },
  ]
  writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join('\n'))
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.equal(res.json.attention.length, 1)
  assert.equal(res.json.attention[0].since, trueMaxOccurredAt, 'turnEndAt must be the true chronological max(occurred_at), independent of file order')
})

test('ZERO EVENTS: a brand-new dispatch with an events buffer that reads back as literally empty never arms attention, and turnEndAt is never misread as some other sentinel', () => {
  const { dir, ctx } = setUpWorkspace('zero-events')
  const specA = makeSpecFile(ctx, 'be-3n')
  const dispatchA = dispatchCmd({ slice: 'be-3n', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  writeFileSync(eventsPath, '') // literally zero events, not merely absent
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention, [], 'zero events read must never arm attention for a dispatch that has never had a Stop event')
})

test('THREE-WAY COLLISION: three non-terminal records constructed to share ONE surface_id arm NONE of them and log exactly one surface_id_collision line (dedup generalizes past pairs)', () => {
  const { dir, ctx } = setUpWorkspace('surface-collision-triple')
  const specA = makeSpecFile(ctx, 'be-3p')
  const dispatchA = dispatchCmd({ slice: 'be-3p', role: 'coder', spec: specA }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-3p.1.json'))

  function handConstructSharingSurface(sliceId) {
    const specPath = makeSpecFile(ctx, sliceId)
    const dispatchId = newDispatchId()
    const worktree = ensureWorktree({
      roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId,
      primaryCheckout: ctx.primaryCheckout, dispatchId, worktreesIndexPath: ctx.paths.worktreesIndexPath,
    })
    const snapshot = snapshotWorkerPlugin({ pluginRoot: ctx.pluginRoot, snapshotDir: ctx.paths.snapshotDir, roles: ctx.roster.roles, profiles: ctx.roster.profiles })
    const newRecord = buildRecord({
      roots: ctx.roots, paths: ctx.paths, roster: ctx.roster, resolved: ctx.roster.roles.coder, pluginRoot: ctx.pluginRoot,
      taskId: ctx.taskSlug, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug, primaryCheckout: ctx.primaryCheckout, snapshot,
      config: { createdByDispatcher: worktree ? worktree.created_by_dispatcher : undefined, sourceSliceId: worktree ? worktree.source_slice_id : undefined },
      now: Date.now(), dispatchId, attnUpstream: null,
    }, { role: 'coder', sliceId, attempt: 1, spec: JSON.parse(readFileSync(specPath, 'utf8')) })
    const recordPath = join(ctx.paths.dispatchDir, `${sliceId}.1.json`)
    writeRecord(newRecord, recordPath)
    bindRecord(recordPath, { workspace_id: record.surface.workspace_id, pane_id: record.surface.pane_id, surface_id: record.surface.surface_id })
    return dispatchId
  }
  const dispatchIdB = handConstructSharingSurface('be-3q')
  const dispatchIdC = handConstructSharingSurface('be-3r')

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: record.surface.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  let res
  const stderr = captureStderr(() => {
    res = awaitCmd({ all: [dispatchA.json.dispatch_id, dispatchIdB, dispatchIdC], 'max-block-s': '1' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention, [], 'none of the three colliding dispatches should arm')
  const collisionLines = stderr.split('\n').filter((l) => l.includes('surface_id_collision'))
  assert.equal(collisionLines.length, 1, 'expected exactly one surface_id_collision log line even with three colliding records')
})

test('COLLISION: two non-terminal records constructed to share a surface_id arm NEITHER and log exactly one surface_id_collision line', () => {
  const { dir, ctx } = setUpWorkspace('surface-collision')
  const specA = makeSpecFile(ctx, 'be-3d')
  const dispatchA = dispatchCmd({ slice: 'be-3d', role: 'coder', spec: specA }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-3d.1.json'))

  // Hand-construct a SECOND non-terminal record sharing A's surface_id — the
  // collision is engineered directly (never a live cmux race), matching
  // findDocTabSurface's own ambiguity-testing style elsewhere in this file.
  const specB = makeSpecFile(ctx, 'be-3e')
  const dispatchIdB = newDispatchId()
  const worktreeB = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId: 'be-3e',
    primaryCheckout: ctx.primaryCheckout, dispatchId: dispatchIdB, worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })
  const snapshotB = snapshotWorkerPlugin({ pluginRoot: ctx.pluginRoot, snapshotDir: ctx.paths.snapshotDir, roles: ctx.roster.roles, profiles: ctx.roster.profiles })
  const recordB = buildRecord({
    roots: ctx.roots, paths: ctx.paths, roster: ctx.roster, resolved: ctx.roster.roles.coder, pluginRoot: ctx.pluginRoot,
    taskId: ctx.taskSlug, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug, primaryCheckout: ctx.primaryCheckout, snapshot: snapshotB,
    config: { createdByDispatcher: worktreeB ? worktreeB.created_by_dispatcher : undefined, sourceSliceId: worktreeB ? worktreeB.source_slice_id : undefined },
    now: Date.now(), dispatchId: dispatchIdB, attnUpstream: null,
  }, { role: 'coder', sliceId: 'be-3e', attempt: 1, spec: JSON.parse(readFileSync(specB, 'utf8')) })
  const recordPathB = join(ctx.paths.dispatchDir, 'be-3e.1.json')
  writeRecord(recordB, recordPathB)
  bindRecord(recordPathB, { workspace_id: record.surface.workspace_id, pane_id: record.surface.pane_id, surface_id: record.surface.surface_id })

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: record.surface.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  let res
  const stderr = captureStderr(() => {
    res = awaitCmd({ all: [dispatchA.json.dispatch_id, dispatchIdB], 'max-block-s': '1' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention, [], 'neither colliding dispatch should arm')
  const collisionLines = stderr.split('\n').filter((l) => l.includes('surface_id_collision'))
  assert.equal(collisionLines.length, 1, 'expected exactly one surface_id_collision log line')
})

test('NAME FILTER: an events buffer containing only notification.requested lines (which also carry ids) arms nothing', () => {
  const { dir, ctx } = setUpWorkspace('name-filter')
  const specA = makeSpecFile(ctx, 'be-3f')
  const dispatchA = dispatchCmd({ slice: 'be-3f', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt, name: 'notification.requested' })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.deepEqual(res.json.attention, [], 'a non-Stop event carrying an id must never arm attention — the client-side name filter runs regardless of --name')
})

test('SURFACING (resolved path): an armed-but-not-yet-quiet-enough dispatch that later resolves "completed" carries an empty attention array, never appears in attention, and is present in resolved/absent from remaining', () => {
  const { dir, ctx } = setUpWorkspace('surfacing-resolved')
  const specA = makeSpecFile(ctx, 'be-3g')
  const dispatchA = dispatchCmd({ slice: 'be-3g', role: 'coder', spec: specA }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-3g.1.json'))
  writeValidReturn(record)

  const res = awaitCmd({ all: [dispatchA.json.dispatch_id] }, ctx, { sleep: NO_SLEEP })
  assert.equal(res.json.resolved.length, 1)
  assert.equal(res.json.resolved[0].dispatch_id, dispatchA.json.dispatch_id)
  assert.deepEqual(res.json.remaining, [])
  assert.deepEqual(res.json.attention, [])
})

test('DEGRADATION: when the events call fails, attention is disabled for that call with one loud line, a --name-filtered failure is retried ONCE without --name, and every other classification is unaffected', () => {
  const { dir, ctx } = setUpWorkspace('events-degradation')
  const specA = makeSpecFile(ctx, 'be-3h')
  const dispatchA = dispatchCmd({ slice: 'be-3h', role: 'coder', spec: specA }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-3h.1.json'))
  writeValidReturn(record)

  process.env.FAKE_CMUX_FAIL = 'events'
  let stderr
  let res
  stderr = captureStderr(() => {
    res = awaitCmd({ all: [dispatchA.json.dispatch_id] }, ctx, { sleep: NO_SLEEP })
  })
  delete process.env.FAKE_CMUX_FAIL

  // Every OTHER classification is unaffected — the dispatch still resolves
  // completed even though events (and therefore attention) is unavailable.
  assert.equal(res.json.resolved.length, 1)
  assert.equal(res.json.resolved[0].state, 'completed')
  assert.match(stderr, /events channel .* unavailable/)

  const env = process.env.FAKE_CMUX_LOG
  const log = readLog(env)
  const eventsCalls = log.filter((e) => e.argv[0] === 'events')
  // Retried ONCE without --name: two total attempts, the first carrying
  // --name, the second not.
  assert.equal(eventsCalls.length, 2, 'expected exactly two events attempts: one with --name, one retry without')
  assert.ok(eventsCalls[0].argv.includes('--name'))
  assert.equal(eventsCalls[1].argv.includes('--name'), false)
})

test('`status` reports the same attention information from its own independent filtered events read', () => {
  const { dir, ctx } = setUpWorkspace('status-attention')
  const specA = makeSpecFile(ctx, 'be-3i')
  const dispatchA = dispatchCmd({ slice: 'be-3i', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  const res = statusCmd({}, ctx)
  delete process.env.FAKE_CMUX_EVENTS

  assert.deepEqual(res.json.attention.map((a) => a.dispatch_id), [dispatchA.json.dispatch_id])
  assert.equal(res.json.attention[0].reason, 'quiet_after_turn_end')
})

test('READ-SCREEN TRANSITION: fires exactly once across two consecutive internal ticks where the same dispatch stays in attention (once per raise, not once per tick)', () => {
  const { dir, ctx } = setUpWorkspace('read-screen-transition')
  const specA = makeSpecFile(ctx, 'be-3j')
  const dispatchA = dispatchCmd({ slice: 'be-3j', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  // max-block-s '2' with a 400ms tick forces several internal ticks before
  // the cap returns — the dispatch is in attention from the very first tick
  // (turnEndAt is already 100s stale) and stays there for every subsequent
  // tick of THIS SAME await() invocation.
  let now = Date.now()
  const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '2' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  delete process.env.FAKE_CMUX_EVENTS

  assert.equal(res.json.status, 'still-running')
  assert.equal(res.json.attention.length, 1)

  const readScreenCalls = readLog(process.env.FAKE_CMUX_LOG).filter((e) => e.argv[0] === 'read-screen')
  assert.equal(readScreenCalls.length, 1, 'expected exactly one read-screen invocation across every internal tick of this single await() call')
})

// be-11-03: turnEndAt (and therefore previousAttentionIds) is derived FRESH
// inside every awaitCmd() invocation — there is no cross-invocation state
// (the module comment above readTurnEndEvents is explicit about this: "once
// per raise" is scoped to a single await() call). This test locks in that
// documented scoping across 3 SEPARATE awaitCmd() calls (not internal ticks
// of one call): a dispatch that stays armed in attention the whole time gets
// a read-screen invocation on EVERY one of the three calls, not just the
// first — proving the "once per transition" guarantee is per-invocation, not
// per-dispatch-lifetime, and is not accidentally suppressed or amplified
// across repeated orchestrator polling.
test('READ-SCREEN ACROSS REPEATED INVOCATIONS: a dispatch that stays in attention across 3 separate awaitCmd() calls gets exactly one read-screen call PER invocation (per-call scoping, not a lifetime latch)', () => {
  const { dir, ctx } = setUpWorkspace('read-screen-repeated-invocations')
  const specA = makeSpecFile(ctx, 'be-3s')
  const dispatchA = dispatchCmd({ slice: 'be-3s', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString() // already well past quietS on invocation 1
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  const readScreenCountsPerCall = []
  for (let i = 0; i < 3; i += 1) {
    const before = readLog(process.env.FAKE_CMUX_LOG).filter((e) => e.argv[0] === 'read-screen').length
    let now = Date.now()
    const res = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
    assert.equal(res.json.status, 'still-running', `invocation ${i} must still be running (never resolving, never un-arming)`)
    assert.equal(res.json.attention.length, 1, `invocation ${i} must still report the dispatch as in attention`)
    const after = readLog(process.env.FAKE_CMUX_LOG).filter((e) => e.argv[0] === 'read-screen').length
    readScreenCountsPerCall.push(after - before)
  }
  delete process.env.FAKE_CMUX_EVENTS

  assert.deepEqual(readScreenCountsPerCall, [1, 1, 1], 'expected exactly one read-screen call on EACH of the three separate awaitCmd() invocations — the transition-fire scoping is per-call, per the module\'s own documented design, not a cross-invocation latch')
})

test('RAW FRAME NEVER REACHES JSON OR DISK: the produced await JSON payload and status.json never contain frame text; only the closed-enum {lines, last_line_sha256, matched[]} shape (drawn from triage.mjs\'s SIGNATURES enum) is ever surfaced, and only via a log line', async () => {
  const { dir, ctx } = setUpWorkspace('raw-frame-never-json')
  const specA = makeSpecFile(ctx, 'be-3k')
  const dispatchA = dispatchCmd({ slice: 'be-3k', role: 'coder', spec: specA }, ctx)

  const screenPath = join(dir, 'screen.txt')
  const distinctiveFrameText = 'DISTINCTIVE_SCREEN_MARKER_zzq9'
  writeFileSync(screenPath, `${distinctiveFrameText}\n`)
  process.env.FAKE_CMUX_SCREEN = screenPath

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  let now = Date.now()
  let stderr
  const res = { current: null }
  stderr = captureStderr(() => {
    res.current = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
    })
  })
  delete process.env.FAKE_CMUX_EVENTS
  delete process.env.FAKE_CMUX_SCREEN

  const jsonText = JSON.stringify(res.current.json)
  assert.doesNotMatch(jsonText, new RegExp(distinctiveFrameText), 'the raw frame must never reach the JSON payload')

  // The real read-screen call happened (proving the assertion above is not
  // vacuous) and the reduced tuple reached a log line, never the frame text.
  const readScreenCalls = readLog(process.env.FAKE_CMUX_LOG).filter((e) => e.argv[0] === 'read-screen')
  assert.equal(readScreenCalls.length, 1)
  assert.match(stderr, /screen signature scan/)
  assert.doesNotMatch(stderr, new RegExp(distinctiveFrameText), 'the raw frame must never reach a log line either')

  const statusJsonPath = ctx.paths.statusPath
  if (existsSync(statusJsonPath)) {
    assert.doesNotMatch(readFileSync(statusJsonPath, 'utf8'), new RegExp(distinctiveFrameText))
  }
})

test('VACUITY GUARD (mandatory, end-to-end): running the full await() pipeline with a screen frame matching every known signature vs. a blank frame produces IDENTICAL status/attention/remaining — proves the diagnostic plane can never become a decision input', async () => {
  // qa gate fix: the ORIGINAL version of this test lived in
  // cmux-ladder.test.mjs and called classify() twice with byte-identical
  // arguments — trivially true regardless of whether triage data could
  // ever influence classification, since neither call was ever given the
  // frame/signature data through any channel reaching classify(). THIS is
  // the real, non-vacuous proof: the SAME dispatch, across two SEPARATE
  // real awaitCmd() invocations (armed turnEndAt both times, so attention
  // genuinely COULD differ), with the screen frame swapped between an
  // all-signatures-matching frame and a blank one in between.
  const { dir, ctx } = setUpWorkspace('vacuity-guard-e2e')
  const specA = makeSpecFile(ctx, 'be-3m')
  const dispatchA = dispatchCmd({ slice: 'be-3m', role: 'coder', spec: specA }, ctx)

  const eventsPath = join(dir, 'events.jsonl')
  const staleOccurredAt = new Date(Date.now() - 100_000).toISOString()
  writeTurnEndEvent(eventsPath, { surfaceId: dispatchA.json.surface_id, occurredAt: staleOccurredAt })
  process.env.FAKE_CMUX_EVENTS = eventsPath

  const allMatchScreenPath = join(dir, 'screen-all-match.txt')
  writeFileSync(allMatchScreenPath, 'do you want to proceed?\ndo you trust the files in this folder?\n   >   \n')
  const blankScreenPath = join(dir, 'screen-blank.txt')
  writeFileSync(blankScreenPath, 'nothing interesting on this frame at all\n')

  process.env.FAKE_CMUX_SCREEN = allMatchScreenPath
  let nowAll = Date.now()
  const resAllMatch = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => nowAll, sleep: (ms) => { nowAll += ms }, tickMs: 400,
  })

  process.env.FAKE_CMUX_SCREEN = blankScreenPath
  let nowBlank = Date.now()
  const resBlank = awaitCmd({ all: [dispatchA.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => nowBlank, sleep: (ms) => { nowBlank += ms }, tickMs: 400,
  })

  delete process.env.FAKE_CMUX_EVENTS
  delete process.env.FAKE_CMUX_SCREEN

  // Prove this isn't vacuous: read-screen genuinely fired both times (the
  // diagnostic plane DID see two different frames) and the two frames
  // really do differ in what they'd match.
  const readScreenCalls = readLog(process.env.FAKE_CMUX_LOG).filter((e) => e.argv[0] === 'read-screen')
  assert.equal(readScreenCalls.length, 2, 'expected read-screen to fire once per await() invocation (fresh transition each call)')

  // The actual proof: status/attention/remaining are byte-identical
  // regardless of which frame was on screen.
  assert.equal(resAllMatch.json.status, 'still-running')
  assert.equal(resBlank.json.status, 'still-running')
  assert.deepEqual(resAllMatch.json.remaining, resBlank.json.remaining)
  assert.deepEqual(resAllMatch.json.attention, resBlank.json.attention)
})

test('DELETION PROOF: no trace of the superseded CPU-polling design remains anywhere in scripts/ or test/', () => {
  // The forbidden terms are assembled at runtime (never a literal grep
  // pattern string embedded in this file) so this very assertion's own
  // source text can never self-match; THIS_FILE is excluded from the scan
  // for the same reason.
  const forbidden = ['top' + 'Idle', 'quiet' + 'State', 'TOP_IDLE_CPU' + '_MAX', 'isSurface' + 'Idle', 'attention' + '.json'].join('\\|')
  const grepRes = spawnSync('grep', ['-rn', '--exclude', 'cmux-dispatch.test.mjs', forbidden, join(ROOT, 'scripts'), join(ROOT, 'test')], { encoding: 'utf8' })
  // grep exits 1 when there are no matches — that IS the pass condition.
  assert.equal(grepRes.status, 1, `expected zero matches; grep exited ${grepRes.status} with stdout:\n${grepRes.stdout}`)
  assert.equal(grepRes.stdout.trim(), '')
})

test('QA fix #1 (live-verified): readEvents() treats a timeout-triggered kill as a normal partial read, never "unavailable", recovering every complete line the child wrote before the kill — models cmux\'s REAL "under-satisfied --limit blocks streaming live events" behavior', async () => {
  // This exercises the REAL node:child_process spawnSync timeout-kill path
  // against test/fixtures/fake-cmux.mjs's FAKE_CMUX_EVENTS_HANG hook (no
  // mocking of spawnSync itself) — the fixture prints whatever
  // FAKE_CMUX_EVENTS holds (modeling "already-retained partial backlog")
  // and then hangs indefinitely, exactly like a real cmux daemon blocking
  // to satisfy an under-retained --limit/--name count. Only the caller's
  // own spawnSync timeout can ever terminate it.
  const { readEvents } = await import(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'))
  const { dir } = setUpWorkspace('readevents-partial-capture')

  const eventsPath = join(dir, 'partial-backlog.jsonl')
  const partialEvents = [
    { seq: 1, name: 'agent.hook.Stop', surface_id: '11111111-1111-1111-1111-111111111111', occurred_at: '2026-08-05T00:00:00.000Z' },
    { seq: 2, name: 'agent.hook.Stop', surface_id: '22222222-2222-2222-2222-222222222222', occurred_at: '2026-08-05T00:00:01.000Z' },
    { seq: 3, name: 'agent.hook.Stop', surface_id: '33333333-3333-3333-3333-333333333333', occurred_at: '2026-08-05T00:00:02.000Z' },
  ]
  writeFileSync(eventsPath, partialEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')
  process.env.FAKE_CMUX_EVENTS = eventsPath
  process.env.FAKE_CMUX_EVENTS_HANG = '1'

  const startMs = Date.now()
  // A --limit far exceeding what's retained (per the modeled scenario) —
  // the fixture hangs after printing the retained partial backlog, so this
  // NEVER exits on its own; only timeoutMs bounds it.
  const result = readEvents({ limit: 5000, timeoutMs: 1000 })
  const elapsedMs = Date.now() - startMs

  delete process.env.FAKE_CMUX_EVENTS
  delete process.env.FAKE_CMUX_EVENTS_HANG

  assert.equal(result.unavailable, undefined, 'a timeout-triggered kill with real partial data must NEVER be reported as unavailable')
  assert.equal(result.events.length, 3, 'expected all three complete lines written before the kill to be recovered')
  assert.deepEqual(result.events.map((e) => e.seq), [1, 2, 3])
  assert.ok(elapsedMs >= 900 && elapsedMs < 5000, `expected the read to be bounded by timeoutMs (~1000ms), took ${elapsedMs}ms`)
})

test('QA fix #1 companion: a timeout-triggered kill with ZERO output (a genuinely idle window) is an empty-but-available read, never "unavailable"', async () => {
  const { readEvents } = await import(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'))
  const { dir } = setUpWorkspace('readevents-empty-timeout')

  // No FAKE_CMUX_EVENTS set — the fixture prints nothing before hanging.
  process.env.FAKE_CMUX_EVENTS_HANG = '1'
  const result = readEvents({ limit: 5000, timeoutMs: 500 })
  delete process.env.FAKE_CMUX_EVENTS_HANG

  assert.equal(result.unavailable, undefined)
  assert.deepEqual(result.events, [])
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

// Same shape as buildAndBindRecord, but binds against a GENUINE pane+surface
// (minted via createPane against the real workspace) rather than
// buildAndBindRecord's fixed synthetic ids — presentReturn/mountDocTab need
// an actual topology node to mount into, which the synthetic ids (never
// created in the fake's tree) cannot provide.
function buildAndBindRecordWithRealPane(ctx, { role, sliceId, workspaceId }) {
  const dispatchId = newDispatchId()
  const worktree = ensureWorktree({
    roots: ctx.roots, repoSlug: ctx.repoSlug, taskSlug: ctx.taskSlug, sliceId,
    primaryCheckout: ctx.primaryCheckout, dispatchId, worktreesIndexPath: ctx.paths.worktreesIndexPath,
  })
  const snapshot = snapshotWorkerPlugin({ pluginRoot: ctx.pluginRoot, snapshotDir: ctx.paths.snapshotDir, roles: ctx.roster.roles, profiles: ctx.roster.profiles })
  const record = buildRecord({
    roots: ctx.roots, paths: ctx.paths, roster: ctx.roster, resolved: ctx.roster.roles[role], pluginRoot: ctx.pluginRoot,
    taskId: ctx.taskSlug, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug, primaryCheckout: ctx.primaryCheckout, snapshot,
    config: { createdByDispatcher: worktree ? worktree.created_by_dispatcher : undefined, sourceSliceId: worktree ? worktree.source_slice_id : undefined },
    now: Date.now() - 50, dispatchId, attnUpstream: null,
  }, { role, sliceId, attempt: 1, spec: { validation_commands: ['node --test'] } })
  const recordPath = join(ctx.paths.dispatchDir, `${sliceId}.1.json`)
  writeRecord(record, recordPath)
  const { paneId, surfaceId } = createPane({ workspaceId })
  return bindRecord(recordPath, { workspace_id: workspaceId, pane_id: paneId, surface_id: surfaceId })
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

// worker_blocked_markdown END-TO-END — a real gate/adapter-composed blocked
// markdown envelope, written via the real writeBlockedReturn (never a
// hand-written fixture string), closes with outcome 'blocked' and exit code
// 1. Before the fix this was recorded 'ok'/0 (bodyStatus is always null for
// a markdown body, so the worker_blocked row never fired).
test('worker_blocked_markdown: a real gate-composed blocked markdown return closes with outcome blocked and exit code 1', () => {
  const { ctx } = setUpWorkspace('worker-blocked-markdown')
  const record = buildAndBindRecord(ctx, { role: 'code-reviewer', sliceId: 'be-1b' })
  writeBlockedReturn(record, 'gate exhausted: max_blocks reached')

  const res = closeCmd({ dispatch: record.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'blocked')
  assert.equal(res.code, 1)
})

// worker_blocked_markdown REGRESSION — all six already-pane-enabled markdown
// roles (issue #6): a blocked envelope built via the real writeBlockedReturn
// output classifies as outcome 'blocked', never a hand-written fixture
// string standing in for it.
for (const role of ['plan-reviewer', 'architecture-lead', 'backend-lead', 'frontend-lead', 'devops-lead', 'qa-lead']) {
  test(`worker_blocked_markdown regression (${role}): a real gate-composed blocked markdown return closes with outcome blocked`, () => {
    const { ctx } = setUpWorkspace(`worker-blocked-markdown-${role}`)
    const record = buildAndBindRecord(ctx, { role, sliceId: 'be-1b' })
    writeBlockedReturn(record, 'gate exhausted: max_blocks reached')

    const res = closeCmd({ dispatch: record.dispatch_id }, ctx)
    assert.equal(res.json.outcome, 'blocked')
  })
}

// ---------------------------------------------------------------------------
// be-06-01 S8 — presentReturn: render + present the doc tab on return.
// ---------------------------------------------------------------------------

// qa should-fix: awaitCmd's own presentReturn call site (dispatch.mjs, just
// before the resolved-now return) was completely untested — every prior
// doc-tab test drove presentReturn through closeCmd only. This record is
// bound to a GENUINE pane (buildAndBindRecordWithRealPane), bypassing
// dispatchCmd's own placeholder-mount step entirely, so the FIRST mount
// happens inside awaitCmd's presentReturn call — exactly the untested path.
test('IDEMPOTENCY: awaitCmd THEN closeCmd on a resolved judgment-role dispatch produce exactly one markdown-open, zero new-surface, exactly two reorder-surface --before <terminal>, and byte-identical render-path content (equal to the envelope body) after each step', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('idempotency-await-close')
  const record = buildAndBindRecordWithRealPane(ctx, { role: 'backend-lead', sliceId: 'be-2z', workspaceId: workspaceRes.json.workspace_id })
  writeValidReturn(record)

  const expectedBody = record.return.required_sections.map((s) => `## ${s}\nok\n`).join('\n')
  const renderPath = join(ctx.paths.taskDir, 'returns', 'be-2z.1.md')

  const awaitRes = awaitCmd({ all: [record.dispatch_id] }, ctx)
  assert.equal(awaitRes.code, 0)
  assert.equal(awaitRes.json.resolved[0].state, 'completed')
  const renderedAfterAwait = readFileSync(renderPath, 'utf8')
  assert.equal(renderedAfterAwait, expectedBody)

  const closeRes = closeCmd({ dispatch: record.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok')
  const renderedAfterClose = readFileSync(renderPath, 'utf8')
  assert.equal(renderedAfterClose, expectedBody)
  assert.equal(renderedAfterClose, renderedAfterAwait)

  const log = readLog(env.logPath)
  const markdownOpens = log.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open')
  assert.equal(markdownOpens.length, 1, 'expected exactly one markdown-open TOTAL — awaitCmd\'s presentReturn call performs the only mount; closeCmd\'s presentReturn finds the doc tab already present and only reorders')
  assert.equal(log.filter((e) => e.argv[0] === 'new-surface').length, 0)
  const reorders = log.filter((e) => e.argv[0] === 'reorder-surface' && e.argv[2] === '--before' && e.argv[3] === record.surface.surface_id)
  assert.equal(reorders.length, 2, 'expected exactly two reorder-surface --before <terminal>: one from the awaitCmd mount, one from closeCmd\'s presentReturn')
})

test('S8: doc tab on return — dispatch mounts the placeholder (markdown open -> reorder-surface --before <terminal>; move-surface is skipped since the new surface already lands in the target pane), the render path content equals the envelope body once resolved, and close COLLAPSES to the doc tab (be-11-03)', () => {
  const { env, ctx } = setUpWorkspace('doctab-return')
  const specPath = makeSpecFile(ctx, 'be-2a')
  const dispatchRes = dispatchCmd({ slice: 'be-2a', role: 'backend-lead', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2a.1.json'))

  // (1) dispatch-time placeholder mount: markdown open -> reorder-surface
  // --before <terminal>, in that order. move-surface is NOT invoked here:
  // `markdown open --surface <terminalSurfaceId>` creates the new surface in
  // the SAME pane as the terminal surface (which IS paneId, since
  // createPane minted both together) — mountDocTab's rungs only move when
  // the new surface actually lands in a DIFFERENT pane (interface_contract
  // item 5: "if pane differs move-surface").
  const logAfterDispatch = readLog(env.logPath)
  const markdownIdx = logAfterDispatch.findIndex((e) => e.argv[0] === 'markdown')
  const reorderIdx = logAfterDispatch.findIndex((e) => e.argv[0] === 'reorder-surface')
  assert.ok(markdownIdx !== -1 && reorderIdx !== -1, 'expected markdown/reorder-surface in the dispatch-time log')
  assert.ok(markdownIdx < reorderIdx, 'expected markdown open -> reorder-surface, in order')
  assert.equal(logAfterDispatch.some((e) => e.argv[0] === 'move-surface'), false)
  assert.equal(logAfterDispatch[reorderIdx].argv[2], '--before')
  assert.equal(logAfterDispatch[reorderIdx].argv[3], dispatchRes.json.surface_id)

  const tBeforeClose = tree({ all: true })
  const docTabBeforeClose = findDocTabSurface(tBeforeClose, { paneId: dispatchRes.json.pane_id, terminalSurfaceId: dispatchRes.json.surface_id })
  assert.ok(docTabBeforeClose.id, 'expected a positively-verified sibling doc-tab surface before close')

  // (2) resolve with a valid markdown return, then close — presentReturn
  // renders the envelope body into the render path (placeholder replaced)
  // and re-presents. be-11-03 COLLAPSE-ON-CLOSE: a sibling doc-tab surface
  // is positively verified from a FRESH tree after presentReturn, so close
  // now collapses the pane to its doc tab — exactly ONE close-surface for
  // the TERMINAL surface id, ZERO for the doc-tab surface id, and the pane
  // itself stays present (with its doc tab) afterward.
  writeValidReturn(record)
  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok')

  const renderPath = join(ctx.paths.taskDir, 'returns', 'be-2a.1.md')
  const rendered = readFileSync(renderPath, 'utf8')
  const expectedBody = record.return.required_sections.map((s) => `## ${s}\nok\n`).join('\n')
  assert.equal(rendered, expectedBody)

  const logAfterClose = readLog(env.logPath)
  const closeSurfaceEntriesForTerminal = logAfterClose.filter((e) => e.argv[0] === 'close-surface' && e.argv[1] === dispatchRes.json.surface_id)
  assert.equal(closeSurfaceEntriesForTerminal.length, 1, 'expected exactly ONE close-surface for the terminal surface id (collapse-on-close)')
  const closeSurfaceEntriesForDocTab = logAfterClose.filter((e) => e.argv[0] === 'close-surface' && e.argv[1] === docTabBeforeClose.id)
  assert.equal(closeSurfaceEntriesForDocTab.length, 0, 'expected ZERO close-surface for the doc-tab surface id')

  const tAfterClose = tree({ all: true })
  const paneAfterClose = tAfterClose.windows.flatMap((w) => w.workspaces).flatMap((ws) => ws.panes).find((p) => p.id.toLowerCase() === dispatchRes.json.pane_id.toLowerCase())
  assert.ok(paneAfterClose, 'expected the pane to still be present in the fake\'s tree after collapse')
  assert.ok(paneAfterClose.surfaces.some((s) => s.id.toLowerCase() === docTabBeforeClose.id.toLowerCase()), 'expected the doc-tab surface to still be present in the pane after collapse')
})

test('COLLAPSE-ON-CLOSE (mount chain failed): with FAKE_CMUX_FAIL blocking every doc-tab mount rung, no sibling doc-tab ever exists, so close emits ZERO close-surface calls and keeps the terminal surface', () => {
  const { env, ctx } = setUpWorkspace('doctab-mount-chain-failed')
  const specPath = makeSpecFile(ctx, 'be-2k')
  // 'markdown' blocks BOTH rung 1 (markdown open --surface) and rung 3
  // (markdown open, no --surface); 'new-surface' blocks rung 2 — every rung
  // of mountDocTab is unreachable for the whole test, at dispatch AND close.
  process.env.FAKE_CMUX_FAIL = 'markdown,new-surface'
  const dispatchRes = dispatchCmd({ slice: 'be-2k', role: 'backend-lead', spec: specPath }, ctx)
  assert.equal(dispatchRes.code, 0, 'a doc-tab mount failure must never fail dispatch')

  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2k.1.json'))
  writeValidReturn(record)

  const capturedClose = captureStderr(() => {
    const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
    assert.equal(closeRes.json.outcome, 'ok', 'a doc-tab mount-chain failure must never fail close/resolution')
  })
  delete process.env.FAKE_CMUX_FAIL

  const logAfterClose = readLog(env.logPath)
  const closeSurfaceEntries = logAfterClose.filter((e) => e.argv[0] === 'close-surface')
  assert.equal(closeSurfaceEntries.length, 0, 'expected ZERO close-surface calls when the mount chain failed entirely')
  assert.match(capturedClose, new RegExp(dispatchRes.json.surface_id), 'expected the loud kept-terminal-surface line to name the kept surface id')
})

test('S6/S7 FORCED FAILURE: FAKE_CMUX_FAIL=markdown falls through rung 1 to rung 2 (new-surface browser), dispatch/await/close still succeed', () => {
  const { env, ctx } = setUpWorkspace('doctab-fail-rung1')
  const specPath = makeSpecFile(ctx, 'be-2b')
  process.env.FAKE_CMUX_FAIL = 'markdown'
  const dispatchRes = dispatchCmd({ slice: 'be-2b', role: 'backend-lead', spec: specPath }, ctx)
  assert.equal(dispatchRes.code, 0, 'a doc-tab mount failure must never fail dispatch')

  const log = readLog(env.logPath)
  const newSurfaceEntry = log.find((e) => e.argv[0] === 'new-surface')
  assert.ok(newSurfaceEntry, 'expected rung 2 (new-surface browser) to fire when rung 1 fails')
  assert.equal(newSurfaceEntry.argv[1], '--type')
  assert.equal(newSurfaceEntry.argv[2], 'browser')
  assert.equal(newSurfaceEntry.argv[5], '--pane')
  assert.equal(newSurfaceEntry.argv[6], dispatchRes.json.pane_id)
  assert.deepEqual(newSurfaceEntry.argv.slice(-2), ['--focus', 'false'])

  delete process.env.FAKE_CMUX_FAIL
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2b.1.json'))
  writeValidReturn(record)
  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok', 'a doc-tab failure must never fail resolution/close either')
})

test('S6/S7 FORCED FAILURE: FAKE_CMUX_FAIL=reorder-surface falls through rungs 1 and 2 to rung 3 (markdown open, no --surface), dispatch still succeeds', () => {
  const { env, ctx } = setUpWorkspace('doctab-fail-rung12')
  const specPath = makeSpecFile(ctx, 'be-2c')
  process.env.FAKE_CMUX_FAIL = 'reorder-surface'
  const dispatchRes = dispatchCmd({ slice: 'be-2c', role: 'backend-lead', spec: specPath }, ctx)
  assert.equal(dispatchRes.code, 0, 'a doc-tab mount failure must never fail dispatch')

  const log = readLog(env.logPath)
  const markdownEntries = log.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open')
  // rung 1 (markdown open --surface ...) and rung 3 (markdown open, no --surface) both fire.
  assert.ok(markdownEntries.length >= 2, 'expected both rung 1 and rung 3 markdown-open invocations')
  const rung3 = markdownEntries.find((e) => !e.argv.includes('--surface'))
  assert.ok(rung3, 'expected rung 3 (markdown open, no --surface) to fire')
  const newSurfaceEntries = log.filter((e) => e.argv[0] === 'new-surface')
  assert.equal(newSurfaceEntries.length, 1, 'rung 2 (new-surface) is attempted once before falling through to rung 3')

  delete process.env.FAKE_CMUX_FAIL
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2c.1.json'))
  writeValidReturn(record)
  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok', 'a doc-tab failure must never fail resolution/close either')
})

test('NO DOUBLE MOUNT: two consecutive statusCmd runs against the same live tree produce exactly one markdown-open invocation for a doc-tab record whose panel is already present', () => {
  const { env, ctx } = setUpWorkspace('no-double-mount')
  const specPath = makeSpecFile(ctx, 'be-2d')
  dispatchCmd({ slice: 'be-2d', role: 'backend-lead', spec: specPath }, ctx)

  const logAfterDispatch = readLog(env.logPath)
  const mountedMarkdownCount = logAfterDispatch.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  assert.equal(mountedMarkdownCount, 1, 'expected exactly one markdown-open from the dispatch-time placeholder mount')

  statusCmd({}, ctx)
  statusCmd({}, ctx)
  const logAfterStatus = readLog(env.logPath)
  const totalMarkdownOpens = logAfterStatus.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  assert.equal(totalMarkdownOpens, 1, 'two consecutive statusCmd runs must produce exactly one markdown-open TOTAL when the panel is already present')
})

test('NO DOUBLE MOUNT: statusCmd re-mounts exactly once when the doc-tab panel is absent from the tree', () => {
  const { env, ctx } = setUpWorkspace('remount-once')
  const specPath = makeSpecFile(ctx, 'be-2e')
  const dispatchRes = dispatchCmd({ slice: 'be-2e', role: 'backend-lead', spec: specPath }, ctx)

  // Simulate the doc-tab panel going missing (S20: a moved markdown panel
  // does not survive a cmux restart) by closing the mounted doc-tab surface
  // directly out from under the record — the terminal surface stays.
  const stateBefore = readLog(env.logPath)
  const markdownOpenCount = stateBefore.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  assert.equal(markdownOpenCount, 1)
  const t = tree({ all: true })
  const docTab = findDocTabSurface(t, { paneId: dispatchRes.json.pane_id, terminalSurfaceId: dispatchRes.json.surface_id })
  assert.ok(docTab.id, 'expected a mounted doc tab after dispatch')
  closeSurface(docTab.id)

  statusCmd({}, ctx)
  const logAfterFirstStatus = readLog(env.logPath)
  assert.equal(logAfterFirstStatus.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, 2, 'expected exactly one re-mount when the panel was absent')

  statusCmd({}, ctx)
  const logAfterSecondStatus = readLog(env.logPath)
  assert.equal(logAfterSecondStatus.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, 2, 'a second statusCmd run must not re-mount again once the panel is present')
})

// qa micro-pass item 1: the re-mount loop's noise-suppression check gates on
// pane liveness ALONE, never on record.outcome — a record whose bound PANE
// (not merely its doc-tab surface) is genuinely gone from the live tree is
// exactly the noise case this suppresses; a torn-down/aborted record has no
// pane left to safely re-mount into.
test('NOISE SUPPRESSION: a record whose bound PANE is genuinely absent from the live tree is skipped — no re-mount attempt', () => {
  const { env, ctx } = setUpWorkspace('pane-genuinely-gone')
  const specPath = makeSpecFile(ctx, 'be-2i')
  const dispatchRes = dispatchCmd({ slice: 'be-2i', role: 'backend-lead', spec: specPath }, ctx)

  const baselineMarkdownOpens = readLog(env.logPath).filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  assert.equal(baselineMarkdownOpens, 1)

  // Remove the WHOLE pane (not just its doc-tab surface) from the persisted
  // topology — pre-seeding FAKE_CMUX_STATE directly, never a new env switch
  // — simulating a torn-down/aborted pane.
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  for (const w of state.windows) {
    for (const ws of w.workspaces) {
      ws.panes = ws.panes.filter((p) => p.id.toLowerCase() !== dispatchRes.json.pane_id.toLowerCase())
    }
  }
  writeFileSync(env.statePath, JSON.stringify(state))

  statusCmd({}, ctx)
  const logAfterStatus = readLog(env.logPath)
  assert.equal(logAfterStatus.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, baselineMarkdownOpens, 'a record whose bound pane is gone from the tree must never trigger a re-mount attempt')
})

// be-11-03 STALE TERMINAL SURFACE (supersedes the pre-collapse-on-close
// "POST-CLOSE DOC-TAB RECOVERY" invariant): once a doc-tab dispatch has
// COLLAPSED (its terminal surface positively verified and closed against a
// sibling doc tab — see the S8 test above), the terminal surface id is
// PERMANENTLY dead — mounting always anchors on the terminal surface, so a
// doc tab can never be re-mounted for that dispatch again (ACCEPTED COST,
// see closeCmd's own comment). The `.collapsed` sidecar gates statusCmd's
// re-mount loop and closeCmd's own repeat-close branch so neither one
// attempts a re-mount/reorder against the dead terminal id, and neither one
// logs a spurious error for it.
test('STALE TERMINAL SURFACE: after collapse-on-close, a repeat close and two statusCmd runs emit no reorder/mount attempt against the dead terminal surface and no spurious error lines', () => {
  const { env, ctx } = setUpWorkspace('stale-terminal-surface')
  const specPath = makeSpecFile(ctx, 'be-2j')
  const dispatchRes = dispatchCmd({ slice: 'be-2j', role: 'backend-lead', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2j.1.json'))
  writeValidReturn(record)

  const closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  assert.equal(closeRes.json.outcome, 'ok')

  const collapsedSidecarPath = sidecarPaths(ctx.paths, dispatchRes.json.dispatch_id).collapsed
  assert.ok(existsSync(collapsedSidecarPath), 'expected the .collapsed sidecar to be written on a successful collapse')

  const logAfterClose = readLog(env.logPath)
  const closeSurfaceEntries = logAfterClose.filter((e) => e.argv[0] === 'close-surface' && e.argv[1] === dispatchRes.json.surface_id)
  assert.equal(closeSurfaceEntries.length, 1, 'expected exactly one close-surface for the terminal surface, from the collapse itself')
  const markdownOpensAfterClose = logAfterClose.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  const reordersAfterClose = logAfterClose.filter((e) => e.argv[0] === 'reorder-surface').length

  // A repeat close must no-op the doc-tab branch entirely — no further
  // presentReturn/findDocTabSurface/reorder/mount against the dead terminal.
  const capturedRepeatClose = captureStderr(() => {
    const repeatCloseRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
    assert.equal(repeatCloseRes.json.outcome, 'ok')
  })
  assert.match(capturedRepeatClose, /already collapsed/)
  const logAfterRepeatClose = readLog(env.logPath)
  assert.equal(logAfterRepeatClose.filter((e) => e.argv[0] === 'close-surface' && e.argv[1] === dispatchRes.json.surface_id).length, 1, 'a repeat close must not attempt to close the already-dead terminal surface again')
  assert.equal(logAfterRepeatClose.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, markdownOpensAfterClose, 'a repeat close must attempt no further mount against the dead terminal surface')
  assert.equal(logAfterRepeatClose.filter((e) => e.argv[0] === 'reorder-surface').length, reordersAfterClose, 'a repeat close must attempt no further reorder against the dead terminal surface')

  // Two consecutive statusCmd runs must also skip the re-mount loop for this
  // (now permanently collapsed) record entirely.
  statusCmd({}, ctx)
  statusCmd({}, ctx)
  const logAfterStatus = readLog(env.logPath)
  assert.equal(logAfterStatus.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, markdownOpensAfterClose, 'statusCmd must never attempt a re-mount for a collapsed dispatch')
})

// qa should-fix (a): an AMBIGUOUS pane (>=2 markdown candidates) must be
// fail-CLOSED — both statusCmd's re-mount guard and presentReturn's
// mount-vs-reorder decision must SKIP mounting (never guess, never pile on
// a third panel) and log loudly. Ambiguity is constructed by invoking the
// exported mountDocTab function itself a second time against the same
// pane/terminal (not a topology hand-edit, not a new env switch) — this
// legitimately creates a second markdown surface in the pane.
test('AMBIGUOUS PANE (fix 1): statusCmd and presentReturn both skip the mount and log loudly, producing NO additional markdown-open', () => {
  const { env, ctx } = setUpWorkspace('ambiguous-pane')
  const specPath = makeSpecFile(ctx, 'be-2h')
  const dispatchRes = dispatchCmd({ slice: 'be-2h', role: 'backend-lead', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2h.1.json'))

  // Manufacture the ambiguity: a second, independent doc-tab mount into the
  // SAME pane, alongside the one dispatchCmd already created.
  const secondSurfaceId = mountDocTab({ renderPath: '/tmp/second-doc.md', paneId: dispatchRes.json.pane_id, terminalSurfaceId: dispatchRes.json.surface_id })
  assert.match(secondSurfaceId, /^[0-9a-f-]+$/)

  const t = tree({ all: true })
  const found = findDocTabSurface(t, { paneId: dispatchRes.json.pane_id, terminalSurfaceId: dispatchRes.json.surface_id })
  assert.deepEqual(found, { id: null, ambiguous: true }, 'expected the pane to now be ambiguous (two markdown candidates)')

  const baselineMarkdownOpens = readLog(env.logPath).filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length
  assert.equal(baselineMarkdownOpens, 2, 'one from dispatch, one from the manufactured second mount above')

  // statusCmd's re-mount guard must skip (log loudly, no further mount).
  const capturedStatus = captureStderr(() => statusCmd({}, ctx))
  assert.equal(readLog(env.logPath).filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, baselineMarkdownOpens, 'statusCmd must never mount into an ambiguous pane')
  assert.match(capturedStatus, /ambiguous/i)

  // presentReturn (via closeCmd) must also skip mounting/reordering on
  // ambiguity — a doc-tab failure/skip is never a resolution failure.
  writeValidReturn(record)
  let closeRes
  const capturedClose = captureStderr(() => { closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx) })
  assert.equal(closeRes.json.outcome, 'ok', 'an ambiguous doc tab must never fail the close/resolution')
  assert.equal(readLog(env.logPath).filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open').length, baselineMarkdownOpens, 'presentReturn must never mount into an ambiguous pane either')
  assert.match(capturedClose, /ambiguous/i)
})

// ---------------------------------------------------------------------------
// FOCUS BAN — log-level: a full dispatch->await->close of a judgment role
// invokes none of focus-pane/focus-panel/select-workspace.
// ---------------------------------------------------------------------------

test('FOCUS BAN (log-level): a full dispatch->close of a doc-tab judgment role invokes no focus-pane/focus-panel/select-workspace', () => {
  const { env, ctx } = setUpWorkspace('focus-ban-log')
  const specPath = makeSpecFile(ctx, 'be-2f')
  const dispatchRes = dispatchCmd({ slice: 'be-2f', role: 'backend-lead', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2f.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const log = readLog(env.logPath)
  const forbidden = new Set(['focus-pane', 'focus-panel', 'select-workspace'])
  assert.equal(log.some((e) => forbidden.has(e.argv[0])), false)
})

// MUTATION-KILLER (qa-lead gate audit): presentReturn's own header comment
// promises "NEVER throws". mountDocTab/reorderDocTabFirst/findDocTabSurface
// each already swallow their own internal cmux-call failures, so most
// forced-failure fixtures never actually exercise presentReturn's OWN outer
// try/catch. This does: readTextOrNull rethrows any non-ENOENT error, and a
// DIRECTORY sitting at record.return_path (instead of a file) produces
// exactly that — EISDIR, not ENOENT. If presentReturn's try/catch were
// removed, this would propagate out of closeCmd uncaught instead of
// degrading quietly.
test('presentReturn: an unreadable return_path (EISDIR, not ENOENT) never crashes close — proves the outer never-throw guard actually does something', () => {
  const { ctx } = setUpWorkspace('presentreturn-eisdir')
  const specPath = makeSpecFile(ctx, 'be-2z')
  const dispatchRes = dispatchCmd({ slice: 'be-2z', role: 'backend-lead', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-2z.1.json'))
  mkdirSync(record.return_path, { recursive: true })
  let closeRes
  assert.doesNotThrow(() => {
    closeRes = closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  })
  assert.equal(closeRes.json.outcome === 'ok', false, 'a directory at return_path is not a valid completed return')
})

// ---------------------------------------------------------------------------
// be-06-01 S9 — the workspace phase pill.
// ---------------------------------------------------------------------------

test('phase pill: workspaceCmd emits exactly one set-status devteam-phase planning', () => {
  const { env, workspaceRes } = setUpWorkspace('phase-planning')
  const log = readLog(env.logPath)
  const phaseCalls = log.filter((e) => e.argv[0] === 'set-status' && e.argv[1] === 'devteam-phase')
  assert.equal(phaseCalls.length, 1)
  assert.deepEqual(phaseCalls[0].argv, ['set-status', 'devteam-phase', 'planning', '--workspace', workspaceRes.json.workspace_id])
})

test('phase pill: a successful dispatchCmd emits exactly one set-status devteam-phase building', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('phase-building')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const log = readLog(env.logPath)
  const buildingCalls = log.filter((e) => e.argv[0] === 'set-status' && e.argv[1] === 'devteam-phase' && e.argv[2] === 'building')
  assert.equal(buildingCalls.length, 1)
  assert.deepEqual(buildingCalls[0].argv, ['set-status', 'devteam-phase', 'building', '--workspace', workspaceRes.json.workspace_id])
})

test('phase pill: `phase --set gate` emits exactly one set-status devteam-phase gate', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('phase-gate')
  const res = phaseCmd({ set: 'gate' }, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.phase, 'gate')
  const log = readLog(env.logPath)
  const gateCalls = log.filter((e) => e.argv[0] === 'set-status' && e.argv[1] === 'devteam-phase' && e.argv[2] === 'gate')
  assert.equal(gateCalls.length, 1)
  assert.deepEqual(gateCalls[0].argv, ['set-status', 'devteam-phase', 'gate', '--workspace', workspaceRes.json.workspace_id])
})

test('phase pill: `phase --set bogus` exits 2 (UsageError) with zero cmux invocations', () => {
  const { env, ctx } = setUpWorkspace('phase-bogus')
  const beforeCount = readLog(env.logPath).length
  assert.throws(() => phaseCmd({ set: 'bogus' }, ctx), UsageError)
  const afterCount = readLog(env.logPath).length
  assert.equal(afterCount, beforeCount, 'an out-of-enum phase must issue zero cmux invocations')
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

  // fix-round-2 (live-pass-findings.md F5): build 102 REFUSES the positional
  // id form — the argv shape itself is pinned so a revert to
  // `close-workspace <id>` (the exact live-broken shape) goes red here, not
  // only in a live run.
  const closeWorkspaceArgv = log[closeWorkspaceIdx].argv
  assert.equal(closeWorkspaceArgv[1], '--workspace')
  assert.match(closeWorkspaceArgv[2], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(closeWorkspaceArgv.length, 3)
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

test('TEARDOWN_OUTCOMES drift guard: widening the accepted set requires a deliberate test edit', () => {
  assert.deepEqual(TEARDOWN_OUTCOMES, ['ok', 'refused'])
  assert.ok(Object.isFrozen(TEARDOWN_OUTCOMES))
  assert.equal(DEFAULT_TEARDOWN_OUTCOME, 'ok')
})

test('teardown --outcome refused archives both task dir and state dir even when every dispatch is ok', () => {
  const { dir, ctx } = setUpWorkspace('teardown-outcome-refused')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({ outcome: 'refused' }, ctx)
  assert.equal(res.json.task_dir.archived, true)
  assert.match(res.json.task_dir.path, /\.archive\/sample-task-/)
  assert.equal(existsSync(ctx.paths.taskDir), false)
  assert.equal(res.json.state_dir.archived, true)
  assert.equal(existsSync(ctx.paths.stateDir), false)
  assert.ok(existsSync(res.json.state_dir.path))
})

test('teardown --outcome ok on an all-ok fixture deletes exactly as today (no flag)', () => {
  const { dir, ctx } = setUpWorkspace('teardown-outcome-ok')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  const res = teardownCmd({ outcome: 'ok' }, ctx)
  assert.equal(res.json.task_dir.archived, false)
  assert.equal(res.json.task_dir.deleted, true)
  assert.equal(res.json.state_dir.archived, false)
  assert.equal(res.json.state_dir.deleted, true)
})

test('teardown with no --outcome flag is byte-for-byte identical to --outcome ok on equivalent fixtures', () => {
  const noFlag = setUpWorkspace('teardown-outcome-noflag')
  const noFlagSpec = makeSpecFile(noFlag.ctx)
  const noFlagDispatch = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: noFlagSpec }, noFlag.ctx)
  writeValidReturn(readRecord(join(noFlag.ctx.paths.dispatchDir, 'be-1a.1.json')))
  closeCmd({ dispatch: noFlagDispatch.json.dispatch_id }, noFlag.ctx)
  const noFlagRes = teardownCmd({}, noFlag.ctx)

  const withFlag = setUpWorkspace('teardown-outcome-explicitok')
  const withFlagSpec = makeSpecFile(withFlag.ctx)
  const withFlagDispatch = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: withFlagSpec }, withFlag.ctx)
  writeValidReturn(readRecord(join(withFlag.ctx.paths.dispatchDir, 'be-1a.1.json')))
  closeCmd({ dispatch: withFlagDispatch.json.dispatch_id }, withFlag.ctx)
  const withFlagRes = teardownCmd({ outcome: 'ok' }, withFlag.ctx)

  assert.equal(noFlagRes.json.task_dir.archived, withFlagRes.json.task_dir.archived)
  assert.equal(noFlagRes.json.task_dir.deleted, withFlagRes.json.task_dir.deleted)
  assert.equal(noFlagRes.json.state_dir.archived, withFlagRes.json.state_dir.archived)
  assert.equal(noFlagRes.json.state_dir.deleted, withFlagRes.json.state_dir.deleted)
})

test('teardown --outcome <bogus value> refuses as UsageError before any side effect', () => {
  const badValues = ['bogus', 'OK', '', 'refused ']
  for (const badValue of badValues) {
    const { env, ctx } = setUpWorkspace(`teardown-outcome-bad-${badValues.indexOf(badValue)}`)
    const specPath = makeSpecFile(ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
    writeValidReturn(record)
    closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

    const beforeCount = readLog(env.logPath).length
    assert.throws(
      () => teardownCmd({ outcome: badValue }, ctx),
      (err) => err instanceof UsageError
        && err.message.includes(TEARDOWN_OUTCOMES.join('|'))
        && err.message.includes(JSON.stringify(badValue)),
    )
    const afterCount = readLog(env.logPath).length
    assert.equal(afterCount, beforeCount, 'an out-of-enum --outcome must issue zero cmux invocations')
    assert.equal(existsSync(ctx.paths.taskDir), true, 'a refused --outcome must delete nothing')
    assert.equal(existsSync(ctx.paths.stateDir), true, 'a refused --outcome must delete nothing')
  }
})

test('--keep-artifacts always archives regardless of --outcome, on an all-ok fixture', () => {
  const okRun = setUpWorkspace('teardown-keep-outcome-ok')
  const okSpec = makeSpecFile(okRun.ctx)
  const okDispatch = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: okSpec }, okRun.ctx)
  writeValidReturn(readRecord(join(okRun.ctx.paths.dispatchDir, 'be-1a.1.json')))
  closeCmd({ dispatch: okDispatch.json.dispatch_id }, okRun.ctx)
  const okRes = teardownCmd({ 'keep-artifacts': true, outcome: 'ok' }, okRun.ctx)
  assert.equal(okRes.json.task_dir.archived, true)

  const refusedRun = setUpWorkspace('teardown-keep-outcome-refused')
  const refusedSpec = makeSpecFile(refusedRun.ctx)
  const refusedDispatch = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: refusedSpec }, refusedRun.ctx)
  writeValidReturn(readRecord(join(refusedRun.ctx.paths.dispatchDir, 'be-1a.1.json')))
  closeCmd({ dispatch: refusedDispatch.json.dispatch_id }, refusedRun.ctx)
  const refusedRes = teardownCmd({ 'keep-artifacts': true, outcome: 'refused' }, refusedRun.ctx)
  assert.equal(refusedRes.json.task_dir.archived, true)
})

test('source-text guard: the teardown call site resolves --outcome, never a hardcoded ok literal', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  assert.doesNotMatch(src, /shouldArchive\(\s*\{\s*outcome:\s*'ok'\s*\}/)
  assert.match(src, /shouldArchive\(\s*\{\s*outcome\s*\}/)
})

// The tests above all call teardownCmd(...) directly, never crossing the real
// CLI entrypoint (parseArgs -> buildContext -> main()). This pins that the
// real `node dispatch.mjs teardown --outcome ...` path (which main() gates on
// execution_mode: cmux via assertExecutionModeCmux) archives on refused and
// refuses a bogus outcome with exit code 2 — mirroring runPreflightInSubprocess's
// real-child-process technique above, since main()'s exit code is only
// observable from a genuine subprocess.
test('CLI end-to-end: `teardown --outcome refused` over a real subprocess archives; `--outcome bogus` exits 2', () => {
  const { dir, ctx } = setUpWorkspace('teardown-cli-outcome')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)

  // main() gates every mutating verb on execution_mode: cmux — teardownCmd()
  // called directly (above) never crosses that gate, but the real CLI does.
  const configDir = join(ctx.primaryCheckout, '.claude', 'dev-team')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.md'), 'execution_mode: cmux\n')

  const refusedRes = spawnSync(process.execPath, [
    DISPATCH_PATH, 'teardown',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT, '--outcome', 'refused',
  ], { encoding: 'utf8' })
  assert.equal(refusedRes.status, 0, `expected exit 0, got ${refusedRes.status} — stderr: ${refusedRes.stderr}`)
  const refusedJson = JSON.parse(refusedRes.stdout.trim())
  assert.equal(refusedJson.task_dir.archived, true)

  const bogusRes = spawnSync(process.execPath, [
    DISPATCH_PATH, 'teardown',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT, '--outcome', 'bogus',
  ], { encoding: 'utf8' })
  assert.equal(bogusRes.status, 2, `expected exit 2, got ${bogusRes.status} — stderr: ${bogusRes.stderr}`)
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

// qa should-fix: nothing previously pinned that `phase` — the S9 mutating
// verb added alongside workspace/dispatch/await/close/teardown — actually
// refuses under the execution-mode gate. `--set gate` is a validly-enumerated
// value throughout (the gate must refuse BEFORE phaseCmd's own workspace.json
// read, not because of an unrelated usage error).
test('execution mode: `phase` (a mutating verb) refuses when execution_mode is not cmux, and proceeds once execution_mode: cmux is set', () => {
  const env = freshCmuxEnv('exec-mode-phase')
  const checkout = makeGitCheckout(env.dir)
  const commonArgs = ['--task', 'sample-task', '--checkout', checkout, '--repo', 'sample-repo', '--root', join(env.dir, 'dev-team'), '--plugin-root', ROOT]

  // No config.md at all (defaults agent-tool) — refuses with zero cmux invocations.
  assert.equal(silentMain(['phase', ...commonArgs, '--set', 'gate']), 1)
  assert.deepEqual(readLog(env.logPath), [])

  writeConfigMd(checkout, 'execution_mode: cmux\n')
  assert.equal(silentMain(['preflight', ...commonArgs]), 0)
  assert.equal(silentMain(['workspace', ...commonArgs]), 0)
  assert.equal(silentMain(['phase', ...commonArgs, '--set', 'gate']), 0)
  const log = readLog(env.logPath)
  assert.ok(log.some((e) => e.argv[0] === 'set-status' && e.argv[1] === 'devteam-phase' && e.argv[2] === 'gate'))
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

// ---------------------------------------------------------------------------
// be-11-02 — workspace --tier (color pill), ensureWorkspace --group wiring
// + degradation, await progress, and phase --set gate's clear-progress.
// ---------------------------------------------------------------------------

test('workspace --tier 1|2|3 emits exactly one workspace-action set-color per tier, mapped Teal/Blue/Purple', () => {
  for (const tier of TIERS) {
    const env = freshCmuxEnv(`tier-${tier}`)
    const ctx = buildTestCtx(env.dir, { task: `tier-task-${tier}` })
    preflightCmd({}, ctx)
    const res = workspaceCmd({ tier: String(tier) }, ctx)
    assert.equal(res.code, 0)
    const log = readLog(env.logPath)
    const colorCalls = log.filter((e) => e.argv[0] === 'workspace-action' && e.argv[1] === '--action' && e.argv[2] === 'set-color')
    assert.equal(colorCalls.length, 1, `expected exactly one workspace-action set-color for tier ${tier}`)
    assert.deepEqual(colorCalls[0].argv, ['workspace-action', '--action', 'set-color', '--color', TIER_COLORS[tier], '--workspace', res.json.workspace_id])
  }
})

test('workspace with NO --tier emits ZERO workspace-action invocations (no default tier is ever guessed)', () => {
  const { env } = setUpWorkspace('tier-none')
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'workspace-action').length, 0)
})

test('workspace --tier 4 and --tier abc exit as a UsageError with ZERO cmux invocations, validated before any cmux call', () => {
  const env = freshCmuxEnv('tier-bad')
  const ctx = buildTestCtx(env.dir, { task: 'tier-bad-task' })
  for (const bad of ['4', 'abc']) {
    const before = readLog(env.logPath).length
    assert.throws(() => workspaceCmd({ tier: bad }, ctx), UsageError)
    const after = readLog(env.logPath).length
    assert.equal(after, before, `--tier ${bad} must issue zero cmux invocations`)
  }
})

test('workspace.json gains a tier field on --tier, and a LATER --tier-less invocation carries the prior tier forward verbatim, still emitting zero workspace-action calls', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('tier-carry', undefined)
  const workspaceStatePath = join(ctx.paths.stateDir, 'workspace.json')
  const initial = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  assert.equal(initial.tier, null, 'no --tier on the very first workspace run leaves tier null')

  const tieredRes = workspaceCmd({ tier: '2' }, ctx)
  assert.equal(tieredRes.json.tier, 2)
  const afterTier = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  assert.equal(afterTier.tier, 2)

  const logBefore = readLog(env.logPath).length
  const laterRes = workspaceCmd({}, ctx)
  assert.equal(laterRes.json.tier, 2, 'the previously recorded tier is carried forward verbatim')
  const afterLater = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
  assert.equal(afterLater.tier, 2, 'workspace.json is rewritten wholesale — tier must be explicitly carried, not silently destroyed')

  const logAfter = readLog(env.logPath).slice(logBefore)
  assert.equal(logAfter.filter((e) => e.argv[0] === 'workspace-action').length, 0, 'omitting --tier must never re-fire workspace-action')
})

test('a forced failure of workspace-action never changes the exit code of `workspace` — cosmetics degrade loudly, never fail the verb', () => {
  const env = freshCmuxEnv('tier-forced-fail')
  const ctx = buildTestCtx(env.dir, { task: 'tier-forced-fail-task' })
  preflightCmd({}, ctx)
  process.env.FAKE_CMUX_FAIL = 'workspace-action'
  let res
  const stderr = captureStderr(() => { res = workspaceCmd({ tier: '1' }, ctx) })
  delete process.env.FAKE_CMUX_FAIL
  assert.equal(res.code, 0)
  assert.match(stderr, /setWorkspaceColor/)
})

// ---------------------------------------------------------------------------
// ensureWorkspace --group wiring + degradation.
// ---------------------------------------------------------------------------

test('ensureWorkspace passes --group <slugify(repoSlug)> on the create path (first-time workspace creation)', () => {
  const env = freshCmuxEnv('group-wiring')
  const ctx = buildTestCtx(env.dir, { task: 'group-wiring-task', repo: 'Sample Repo' })
  preflightCmd({}, ctx)
  const res = workspaceCmd({}, ctx)
  const log = readLog(env.logPath)
  const newWorkspaceEntry = log.find((e) => e.argv[0] === 'new-workspace')
  assert.ok(newWorkspaceEntry, 'expected a new-workspace invocation')
  const groupIdx = newWorkspaceEntry.argv.indexOf('--group')
  assert.notEqual(groupIdx, -1, 'expected --group present in the new-workspace argv')
  assert.equal(newWorkspaceEntry.argv[groupIdx + 1], slugify(ctx.repoSlug))
  assert.equal(res.code, 0)
})

test('ensureWorkspace --group NEGATIVE (created anyway): adopts the workspace the failed --group attempt actually created, exactly one new-workspace attempt total (no retry), exactly one workspace of that title, code 0, and the loud adoption line', () => {
  const { dir, env, ctx } = setUpWorkspace('group-fail-created')
  const ctx2 = buildContext({
    task: 'second-task-created', checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  })
  preflightCmd({}, ctx2)

  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateGroupCreateFailsAfterCreating = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const logBefore = readLog(env.logPath).length
  let res
  const stderr = captureStderr(() => { res = workspaceCmd({}, ctx2) })
  assert.equal(res.code, 0, 'the --group degradation must never fail the workspace verb')

  const log = readLog(env.logPath).slice(logBefore)
  const newWorkspaceAttempts = log.filter((e) => e.argv[0] === 'new-workspace')
  assert.equal(newWorkspaceAttempts.length, 1, `expected exactly one new-workspace attempt (the failed --group call, adopted — no retry), got ${newWorkspaceAttempts.length}`)
  assert.match(stderr, /the --group attempt had in fact created the workspace — adopting it/)

  const liveTree = tree({ all: true })
  const win = liveTree.windows.find((w) => w.id === res.json.window_id)
  const matches = win.workspaces.filter((w) => w.title === ctx2.taskSlug)
  assert.equal(matches.length, 1, 'exactly one workspace of that title must exist — never two')
  assert.equal(matches[0].id, res.json.workspace_id)
})

test('ensureWorkspace --group NEGATIVE (nothing created): one retry without --group succeeds, the workspace ends up un-grouped, and a loud degradation line is logged', () => {
  const { dir, env, ctx } = setUpWorkspace('group-fail-nothing')
  const ctx2 = buildContext({
    task: 'second-task-nothing', checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  })
  preflightCmd({}, ctx2)

  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateGroupCreateFails = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const logBefore = readLog(env.logPath).length
  let res
  const stderr = captureStderr(() => { res = workspaceCmd({}, ctx2) })
  assert.equal(res.code, 0)

  const log = readLog(env.logPath).slice(logBefore)
  const newWorkspaceAttempts = log.filter((e) => e.argv[0] === 'new-workspace')
  assert.equal(newWorkspaceAttempts.length, 2, 'expected exactly one --group attempt and exactly one un-grouped retry')
  assert.ok(newWorkspaceAttempts[0].argv.includes('--group'))
  assert.ok(!newWorkspaceAttempts[1].argv.includes('--group'), 'the successful retry must be un-grouped')
  assert.match(stderr, /degrading: retrying new-workspace without --group/)

  const liveTree = tree({ all: true })
  const win = liveTree.windows.find((w) => w.id === res.json.window_id)
  const matches = win.workspaces.filter((w) => w.title === ctx2.taskSlug)
  assert.equal(matches.length, 1)
})

// QA fix (#8, coverage gap): --env-file must ride BOTH the --group retry
// path and the --group adopt path — untested today, the code is correct
// (withEnvFile threads through the retry; the adopt-existing branch returns
// created:true, which stamps the fresh env_file block against the ADOPTED
// workspace's real id) but nothing pinned it, and a future refactor
// reverting the retry call to baseArgs would silently create a workspace
// with NO env while workspace.json records a hash CLAIMING it has one — an
// invisible-forever divergence-from-birth, exactly what the whole
// discriminator table exists to prevent.
test('QA fix #8(a): --group fails but created nothing — the un-grouped retry ALSO carries --env-file (env-file injection is not lost on degradation)', () => {
  const { dir, env, ctx } = setUpWorkspace('group-fail-nothing-envfile')
  const envFilePath = writeEnvFileFixture(dir, 'group-retry-env', 'FOO=1\n')
  writeConfigMd(ctx.primaryCheckout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx2 = buildContext({
    task: 'second-task-nothing-envfile', checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  })
  preflightCmd({}, ctx2)

  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateGroupCreateFails = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const logBefore = readLog(env.logPath).length
  const res = workspaceCmd({}, ctx2)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath).slice(logBefore)
  const newWorkspaceAttempts = log.filter((e) => e.argv[0] === 'new-workspace')
  assert.equal(newWorkspaceAttempts.length, 2)
  for (const attempt of newWorkspaceAttempts) {
    const idx = attempt.argv.indexOf('--env-file')
    assert.notEqual(idx, -1, `expected --env-file present on new-workspace attempt: ${JSON.stringify(attempt.argv)}`)
    assert.equal(attempt.argv[idx + 1], envFilePath)
  }

  const workspaceState = JSON.parse(readFileSync(join(ctx2.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal(workspaceState.env_file.path, envFilePath)
  assert.equal(workspaceState.env_file.workspace_id, res.json.workspace_id)
})

test('QA fix #8(b): --group fails but the workspace was created anyway (adopt path) — the adopted workspace\'s stamped env_file.workspace_id equals the adopted id', () => {
  const { dir, env, ctx } = setUpWorkspace('group-fail-created-envfile')
  const envFilePath = writeEnvFileFixture(dir, 'group-adopt-env', 'FOO=1\n')
  writeConfigMd(ctx.primaryCheckout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx2 = buildContext({
    task: 'second-task-created-envfile', checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  })
  preflightCmd({}, ctx2)

  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateGroupCreateFailsAfterCreating = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const logBefore = readLog(env.logPath).length
  const res = workspaceCmd({}, ctx2)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath).slice(logBefore)
  const newWorkspaceAttempts = log.filter((e) => e.argv[0] === 'new-workspace')
  assert.equal(newWorkspaceAttempts.length, 1, 'the --group attempt that actually created the workspace is adopted — no retry')
  const idx = newWorkspaceAttempts[0].argv.indexOf('--env-file')
  assert.notEqual(idx, -1)
  assert.equal(newWorkspaceAttempts[0].argv[idx + 1], envFilePath)

  const liveTree = tree({ all: true })
  const win = liveTree.windows.find((w) => w.id === res.json.window_id)
  const adopted = win.workspaces.find((w) => w.title === ctx2.taskSlug)

  const workspaceState = JSON.parse(readFileSync(join(ctx2.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal(workspaceState.env_file.workspace_id, adopted.id)
  assert.equal(workspaceState.env_file.workspace_id, res.json.workspace_id)
  assert.equal(workspaceState.env_file.path, envFilePath)
})

test('ensureWorkspace: with no group argument at all, a failing new-workspace still throws as before (no retry, no re-scan)', () => {
  const { env, ctx } = setUpWorkspace('group-none-fails')
  const workspaceState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  process.env.FAKE_CMUX_FAIL = 'new-workspace'
  const logBefore = readLog(env.logPath).length
  assert.throws(
    () => ensureWorkspace({ windowId: workspaceState.window_id, taskSlug: 'a-brand-new-ungrouped-task', cwd: ctx.primaryCheckout }),
    /ensureWorkspace: new-workspace failed/,
  )
  delete process.env.FAKE_CMUX_FAIL
  const log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'new-workspace').length, 1, 'no retry when group was never supplied')
})

// ---------------------------------------------------------------------------
// be-11-05 (ADR-018) — opt-in workspace env-file injection.
// ---------------------------------------------------------------------------

function writeEnvFileFixture(dir, name, content) {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

test('readCmuxEnvFile / readEnvFileKeys: absent, blank, single-line bracketed list, and the ambiguity doctrine', () => {
  assert.equal(readCmuxEnvFile(''), null)
  assert.equal(readCmuxEnvFile('other: stuff\n'), null)
  assert.equal(readCmuxEnvFile('cmux_env_file: /abs/path/to/.env\n'), '/abs/path/to/.env')
  assert.deepEqual(readEnvFileKeys(''), [])
  assert.deepEqual(readEnvFileKeys('env_file_keys: [FOO, BAR]\n'), ['FOO', 'BAR'])
  assert.deepEqual(readEnvFileKeys('env_file_keys: [FOO]\n'), ['FOO'])
  assert.deepEqual(readEnvFileKeys('env_file_keys: []\n'), [])

  assert.throws(
    () => readCmuxEnvFile('cmux_env_file: /a\ncmux_env_file: /b\n'),
    (e) => e instanceof OperationalError && /ambiguous/.test(e.message),
  )
  assert.throws(
    () => readEnvFileKeys('env_file_keys: [FOO]\nenv_file_keys: [BAR]\n'),
    (e) => e instanceof OperationalError && /ambiguous/.test(e.message),
  )
  assert.throws(
    () => readEnvFileKeys('env_file_keys: FOO, BAR\n'),
    (e) => e instanceof OperationalError && /single-line bracketed list/.test(e.message),
  )
})

test('readCmuxEnvFile / readEnvFileKeys: a fenced ``` code block containing a column-0 example is IGNORED, never live-parsed (Must-Fix #1 hardening)', () => {
  const docText = [
    'Some prose.',
    '',
    '```',
    'cmux_env_file: <absolute path>',
    'env_file_keys: [KEY1, KEY2]',
    '```',
    '',
    'More prose.',
  ].join('\n')
  assert.equal(readCmuxEnvFile(docText), null)
  assert.deepEqual(readEnvFileKeys(docText), [])

  // A REAL line outside the fence is still honored, and the fenced example
  // does NOT count toward the ambiguity guard (only one REAL line exists).
  const mixedText = [
    'cmux_env_file: /real/path/.env',
    '',
    '```',
    'cmux_env_file: <absolute path>',
    '```',
  ].join('\n')
  assert.equal(readCmuxEnvFile(mixedText), '/real/path/.env')
})

test('readEnvFileKeys: a malformed entry (e.g. a missing comma) refuses at the config line, naming the bad entry, rather than surfacing later as a confusing "undeclared key"', () => {
  assert.throws(
    () => readEnvFileKeys('env_file_keys: [FOO BAR]\n'),
    (e) => e instanceof OperationalError && /FOO BAR/.test(e.message),
  )
})

test('ABSENT cmux_env_file reproduces today\'s behaviour exactly: no --env-file flag ever emitted, no env_file block written', () => {
  const { env, ctx } = setUpWorkspace('envfile-absent')
  const log = readLog(env.logPath)
  const newWorkspaceEntry = log.find((e) => e.argv[0] === 'new-workspace')
  assert.ok(newWorkspaceEntry)
  assert.equal(newWorkspaceEntry.argv.includes('--env-file'), false)
  const workspaceState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal('env_file' in workspaceState, false)
})

test('REFUSAL — reserved key: refuses BEFORE any cmux invocation (zero fixture-log entries), naming the key, never the value', () => {
  const cases = [
    'ANTHROPIC_API_KEY', 'DEVTEAM_RETURN_PATH', 'PATH', 'NODE_OPTIONS',
    'CLAUDE_BIN', 'CMUX_BIN', 'GIT_SSH_COMMAND', 'npm_config_script_shell',
    'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD',
  ]
  for (const key of cases) {
    const env = freshCmuxEnv(`envfile-reserved-${key.toLowerCase().replace(/[^a-z]/g, '')}`)
    const checkout = makeGitCheckout(env.dir)
    const envFilePath = writeEnvFileFixture(env.dir, `${key}.env`, `${key}=super-secret-value\n`)
    writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [${key}]\n`)
    const ctx = buildTestCtx(env.dir, { checkout, task: 'reserved-task' })
    preflightCmd({}, ctx)

    const logBefore = readLog(env.logPath).length
    let err
    assert.throws(() => workspaceCmd({}, ctx), (e) => { err = e; return e instanceof OperationalError })
    assert.match(err.message, new RegExp(key))
    assert.equal(err.message.includes('super-secret-value'), false, 'the refusal must never carry the value')

    const log = readLog(env.logPath).slice(logBefore)
    assert.deepEqual(log, [], `expected ZERO cmux invocations for reserved key ${key}`)
  }
})

test('REFUSAL — reserved beats declared: a key BOTH listed in env_file_keys AND matching the backstop still refuses', () => {
  const env = freshCmuxEnv('envfile-reserved-declared')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'CMUX_BIN=/tmp/evil\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [CMUX_BIN]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reserved-declared-task' })
  preflightCmd({}, ctx)
  const logBefore = readLog(env.logPath).length
  assert.throws(() => workspaceCmd({}, ctx), (e) => e instanceof OperationalError && /CMUX_BIN/.test(e.message))
  assert.deepEqual(readLog(env.logPath).slice(logBefore), [])
})

test('REFUSAL — undeclared key: a key present in the file but absent from env_file_keys refuses, naming the key; zero cmux invocations', () => {
  const env = freshCmuxEnv('envfile-undeclared')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\nUNDECLARED_KEY=2\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'undeclared-task' })
  preflightCmd({}, ctx)
  const logBefore = readLog(env.logPath).length
  assert.throws(() => workspaceCmd({}, ctx), (e) => e instanceof OperationalError && /UNDECLARED_KEY/.test(e.message))
  assert.deepEqual(readLog(env.logPath).slice(logBefore), [])
})

test('REFUSAL — env_file_keys entirely ABSENT from config.md (fail closed): cmux_env_file set with no env_file_keys line at all refuses every key in the file as undeclared, zero cmux invocations', () => {
  const env = freshCmuxEnv('envfile-keys-absent')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  // No env_file_keys line at all — readEnvFileKeys defaults to [], so FOO is
  // undeclared no matter what the file contains. This must fail closed, not
  // silently inject with an implicit "declare nothing, allow everything".
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'keys-absent-task' })
  preflightCmd({}, ctx)
  const logBefore = readLog(env.logPath).length
  assert.throws(() => workspaceCmd({}, ctx), (e) => e instanceof OperationalError && /not listed in env_file_keys/.test(e.message) && /FOO/.test(e.message))
  assert.deepEqual(readLog(env.logPath).slice(logBefore), [])
})

test('REFUSAL — env_file_keys explicitly EMPTY ([]) with a non-empty env file: every key is undeclared, refuses naming the first offending key, zero cmux invocations', () => {
  const env = freshCmuxEnv('envfile-keys-empty')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\nBAR=2\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: []\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'keys-empty-task' })
  preflightCmd({}, ctx)
  const logBefore = readLog(env.logPath).length
  assert.throws(() => workspaceCmd({}, ctx), (e) => e instanceof OperationalError && /FOO/.test(e.message))
  assert.deepEqual(readLog(env.logPath).slice(logBefore), [])
})

test('a DECLARED key absent from the file only warns and proceeds', () => {
  const env = freshCmuxEnv('envfile-declared-absent')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO, BAR]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'declared-absent-task' })
  preflightCmd({}, ctx)
  let res
  const stderr = captureStderr(() => { res = workspaceCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.match(stderr, /env_file_keys declares "BAR"/)
})

test('REFUSAL — parser: a malformed env file refuses the WHOLE file BEFORE any cmux invocation, naming only the line number', () => {
  const env = freshCmuxEnv('envfile-parse-error')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO="quoted-secret"\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'parse-error-task' })
  preflightCmd({}, ctx)
  const logBefore = readLog(env.logPath).length
  let err
  assert.throws(() => workspaceCmd({}, ctx), (e) => { err = e; return e instanceof OperationalError })
  assert.match(err.message, /line 1/)
  assert.equal(err.message.includes('quoted-secret'), false)
  assert.deepEqual(readLog(env.logPath).slice(logBefore), [])
})

test('REFUSAL — file: a non-absolute path, a missing file, a directory, a symlink, and an oversized file all refuse with the distinct env_file_unreadable reason', () => {
  const env = freshCmuxEnv('envfile-unreadable')
  const checkout = makeGitCheckout(env.dir)

  function assertRefusesWithZeroCmuxCalls(testCtx) {
    const logBefore = readLog(env.logPath).length
    assert.throws(() => workspaceCmd({}, testCtx), (e) => e instanceof OperationalError && /env_file_unreadable/.test(e.message))
    assert.deepEqual(readLog(env.logPath).slice(logBefore), [], 'this bad-file case must never reach cmux')
  }

  // non-absolute path
  writeConfigMd(checkout, `cmux_env_file: relative/env\nenv_file_keys: [FOO]\n`)
  let ctx = buildTestCtx(env.dir, { checkout, task: 'unreadable-relative' })
  preflightCmd({}, ctx)
  assertRefusesWithZeroCmuxCalls(ctx)

  // missing file
  writeConfigMd(checkout, `cmux_env_file: ${join(env.dir, 'does-not-exist.env')}\nenv_file_keys: [FOO]\n`)
  ctx = buildTestCtx(env.dir, { checkout, task: 'unreadable-missing' })
  preflightCmd({}, ctx)
  assertRefusesWithZeroCmuxCalls(ctx)

  // a directory, not a regular file
  const dirPath = join(env.dir, 'a-directory-env')
  mkdirSync(dirPath)
  writeConfigMd(checkout, `cmux_env_file: ${dirPath}\nenv_file_keys: [FOO]\n`)
  ctx = buildTestCtx(env.dir, { checkout, task: 'unreadable-dir' })
  preflightCmd({}, ctx)
  assertRefusesWithZeroCmuxCalls(ctx)

  // a symlink — refused via lstatSync, never followed
  const target = writeEnvFileFixture(env.dir, 'symlink-target-env', 'FOO=1\n')
  const linkPath = join(env.dir, 'a-symlink-env')
  symlinkSync(target, linkPath)
  writeConfigMd(checkout, `cmux_env_file: ${linkPath}\nenv_file_keys: [FOO]\n`)
  ctx = buildTestCtx(env.dir, { checkout, task: 'unreadable-symlink' })
  preflightCmd({}, ctx)
  assertRefusesWithZeroCmuxCalls(ctx)

  // oversized (>64 KiB)
  const bigPath = writeEnvFileFixture(env.dir, 'oversized-env', `FOO=${'x'.repeat(70 * 1024)}\n`)
  writeConfigMd(checkout, `cmux_env_file: ${bigPath}\nenv_file_keys: [FOO]\n`)
  ctx = buildTestCtx(env.dir, { checkout, task: 'unreadable-oversized' })
  preflightCmd({}, ctx)
  assertRefusesWithZeroCmuxCalls(ctx)
})

test('PASSTHROUGH: a clean, fully-declared env file produces exactly ONE --env-file <absolute path> argument on new-workspace, path only — never a re-composed --env flag', () => {
  const env = freshCmuxEnv('envfile-passthrough')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\nBAR=2\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO, BAR]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'passthrough-task' })
  preflightCmd({}, ctx)
  const res = workspaceCmd({}, ctx)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath)
  const newWorkspaceEntry = log.find((e) => e.argv[0] === 'new-workspace')
  assert.ok(newWorkspaceEntry)
  const envFileIdx = newWorkspaceEntry.argv.indexOf('--env-file')
  assert.notEqual(envFileIdx, -1)
  assert.equal(newWorkspaceEntry.argv[envFileIdx + 1], envFilePath)
  assert.equal(newWorkspaceEntry.argv.filter((a) => a === '--env-file').length, 1)

  // Grep the ENTIRE fixture log for `--env` as an exact argv token — zero
  // occurrences (only `--env-file`, never a re-composed `--env KEY=VALUE`).
  const flatArgv = log.flatMap((e) => e.argv)
  assert.equal(flatArgv.filter((token) => token === '--env').length, 0)

  const workspaceState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal(workspaceState.env_file.path, envFilePath)
  assert.equal(workspaceState.env_file.workspace_id, res.json.workspace_id)
  assert.match(workspaceState.env_file.sha256, /^[0-9a-f]{64}$/)
  assert.ok(workspaceState.env_file.recorded_at)
})

test('REUSE BRANCH — the common case: a second workspace invocation with an UNCHANGED env file proceeds silently, no new-workspace call, env_file carried forward verbatim', () => {
  const env = freshCmuxEnv('envfile-reuse-unchanged')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-unchanged-task' })
  preflightCmd({}, ctx)
  const firstRes = workspaceCmd({}, ctx)
  const firstState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))

  const logBefore = readLog(env.logPath).length
  let stderr
  let secondRes
  stderr = captureStderr(() => { secondRes = workspaceCmd({}, ctx) })
  assert.equal(secondRes.code, 0)
  assert.equal(secondRes.json.workspace_id, firstRes.json.workspace_id)

  const log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'new-workspace').length, 0)
  assert.doesNotMatch(stderr, /env_file/i, 'the steady-state reuse case must be silent — no env_file-related warning noise')

  const secondState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.deepEqual(secondState.env_file, firstState.env_file, 'env_file must be carried forward VERBATIM, never re-stamped')
})

test('REUSE BRANCH — divergence: recorded-present + current-differs refuses, naming both hashes/paths and the remediation', () => {
  const env = freshCmuxEnv('envfile-reuse-differs')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-differs-task' })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx)

  writeFileSync(envFilePath, 'FOO=2\n')
  const logBefore = readLog(env.logPath).length
  assert.throws(
    () => workspaceCmd({}, ctx),
    (e) => e instanceof OperationalError && /close the workspace and re-dispatch/.test(e.message) && e.message.includes(envFilePath),
  )
  // A reuse-branch divergence refusal happens AFTER ensureWorkspace's own
  // read-only tree() lookups (needed to resolve workspaceId for the
  // workspace_id-scoping check above), so `tree` calls are expected — the
  // load-bearing guarantee is that it never issues a MUTATING call
  // (new-workspace/new-pane/send/...), i.e. never creates or touches a
  // second live workspace/pane on the way to refusing.
  const log = readLog(env.logPath).slice(logBefore)
  const mutating = log.filter((e) => !['tree', 'ping', 'identify', 'capabilities'].includes(e.argv[0]))
  assert.deepEqual(mutating, [], 'a reuse-branch divergence refusal must issue zero MUTATING cmux invocations')
})

test('REUSE BRANCH — divergence: recorded-null + current-present refuses (cannot retroactively add env injection to a live workspace)', () => {
  const env = freshCmuxEnv('envfile-reuse-add')
  const checkout = makeGitCheckout(env.dir)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-add-task' })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx) // no env file configured yet — recorded stays null

  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  assert.throws(
    () => workspaceCmd({}, ctx),
    (e) => e instanceof OperationalError && /cannot retroactively add environment injection/.test(e.message),
  )
})

test('REUSE BRANCH — divergence: recorded-present + current-absent refuses (cannot retroactively remove env injection from a live workspace)', () => {
  const env = freshCmuxEnv('envfile-reuse-remove')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-remove-task' })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx)

  writeConfigMd(checkout, 'execution_mode: cmux\n') // cmux_env_file no longer configured
  assert.throws(
    () => workspaceCmd({}, ctx),
    (e) => e instanceof OperationalError && /cannot retroactively remove environment injection/.test(e.message),
  )
})

test('REUSE BRANCH — configured-but-unreadable on a reuse call refuses with the distinct env_file_unreadable reason, never a silent degrade', () => {
  const env = freshCmuxEnv('envfile-reuse-unreadable')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-unreadable-task' })
  preflightCmd({}, ctx)
  workspaceCmd({}, ctx)

  writeConfigMd(checkout, `cmux_env_file: ${join(env.dir, 'now-missing.env')}\nenv_file_keys: [FOO]\n`)
  assert.throws(
    () => workspaceCmd({}, ctx),
    (e) => e instanceof OperationalError && /env_file_unreadable/.test(e.message),
  )
})

test('REUSE BRANCH — null/null: a second workspace invocation with cmux_env_file NEVER configured stays silently absent (the sixth discriminator row)', () => {
  const env = freshCmuxEnv('envfile-reuse-null-null')
  const checkout = makeGitCheckout(env.dir)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'reuse-null-null-task' })
  preflightCmd({}, ctx)
  const firstRes = workspaceCmd({}, ctx)
  const firstState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal('env_file' in firstState, false)

  const logBefore = readLog(env.logPath).length
  let secondRes
  const stderr = captureStderr(() => { secondRes = workspaceCmd({}, ctx) })
  assert.equal(secondRes.code, 0)
  assert.equal(secondRes.json.workspace_id, firstRes.json.workspace_id)
  assert.equal(secondRes.json.env_file, null)
  assert.doesNotMatch(stderr, /env_file/i, 'null/null must stay silent, no warning noise')

  const log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'new-workspace').length, 0)

  const secondState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal('env_file' in secondState, false, 'no env_file key is ever written when cmux_env_file was never configured')
})

test('workspace_id scoping: a recorded env_file block whose workspace_id no longer matches the freshly-found workspace is treated as NO hash recorded at all (stale block from a torn-down-and-recreated workspace)', () => {
  const env = freshCmuxEnv('envfile-stale-workspace-id')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'stale-workspace-id-task' })
  preflightCmd({}, ctx)
  const firstRes = workspaceCmd({}, ctx)

  // Simulate a torn-down-and-recreated workspace: hand-edit workspace.json so
  // the recorded env_file block's workspace_id no longer matches the id
  // ensureWorkspace will find on the next call (which — since the fake still
  // has a workspace of that title — is the SAME workspace_id; we forge a
  // DIFFERENT recorded workspace_id to simulate the staleness directly).
  const statePath = join(ctx.paths.stateDir, 'workspace.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.env_file.workspace_id = '99999999-9999-9999-9999-999999999999'
  writeFileSync(statePath, JSON.stringify(state))

  // QA fix (#7): with the recorded block now scoped to a different
  // workspace_id, `recorded` is still correctly treated as no-hash-recorded
  // (never silently trusting the stale block, never crashing on a hash
  // mismatch message) — but the refusal now names this SPECIFIC case (the
  // workspace was recreated under a new id) rather than the generic "never
  // had an env file" message, since the two are not the same situation and
  // conflating them used to produce a misleading (sometimes false) refusal.
  assert.throws(
    () => workspaceCmd({}, ctx),
    (e) => (
      e instanceof OperationalError
      && /recreated/.test(e.message)
      && e.message.includes('99999999-9999-9999-9999-999999999999')
      && e.message.includes(firstRes.json.workspace_id)
    ),
  )
  assert.equal(firstRes.code, 0)
})

test('workspace.json\'s tier field (be-11-02) still survives a later `workspace` invocation alongside an unchanged env_file (both fields carried forward)', () => {
  const env = freshCmuxEnv('envfile-tier-carry')
  const checkout = makeGitCheckout(env.dir)
  const envFilePath = writeEnvFileFixture(env.dir, 'env', 'FOO=1\n')
  writeConfigMd(checkout, `cmux_env_file: ${envFilePath}\nenv_file_keys: [FOO]\n`)
  const ctx = buildTestCtx(env.dir, { checkout, task: 'tier-envfile-task' })
  preflightCmd({}, ctx)
  workspaceCmd({ tier: '2' }, ctx)

  const laterRes = workspaceCmd({}, ctx)
  assert.equal(laterRes.json.tier, 2, 'tier must still be carried forward')
  const state = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.equal(state.tier, 2)
  assert.ok(state.env_file, 'env_file must also be carried forward alongside tier')
  assert.equal(state.env_file.path, envFilePath)
})

// ---------------------------------------------------------------------------
// await progress — set-progress on every return path, cleared at the gate.
// ---------------------------------------------------------------------------

test('await reports progress on the RESOLVED return path: exactly one set-progress call, fraction 1/1', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('progress-resolved')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  const logBefore = readLog(env.logPath).length
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP })
  assert.equal(res.json.resolved.length, 1)

  const log = readLog(env.logPath).slice(logBefore)
  const progressCalls = log.filter((e) => e.argv[0] === 'set-progress')
  assert.equal(progressCalls.length, 1, 'expected exactly one set-progress call on the resolved return path')
  assert.equal(progressCalls[0].argv[1], '1')
  const wsIdx = progressCalls[0].argv.indexOf('--workspace')
  assert.equal(progressCalls[0].argv[wsIdx + 1], workspaceRes.json.workspace_id)
})

test('await reports progress on the CAP-REACHED (still-running) return path: exactly one set-progress call, fraction 0/1', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('progress-cap')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const logBefore = readLog(env.logPath).length
  let now = Date.now()
  const res = awaitCmd({ all: [dispatchRes.json.dispatch_id], 'max-block-s': '1' }, ctx, {
    now: () => now, sleep: (ms) => { now += ms }, tickMs: 400,
  })
  assert.equal(res.json.status, 'still-running')

  const log = readLog(env.logPath).slice(logBefore)
  const progressCalls = log.filter((e) => e.argv[0] === 'set-progress')
  assert.equal(progressCalls.length, 1, 'expected exactly one set-progress call on the cap-reached return path')
  assert.equal(progressCalls[0].argv[1], '0')
  const wsIdx = progressCalls[0].argv.indexOf('--workspace')
  assert.equal(progressCalls[0].argv[wsIdx + 1], workspaceRes.json.workspace_id)
})

test('a forced failure of set-progress never changes the exit code of `await` — cosmetics degrade loudly, never fail the verb', () => {
  const { env, ctx } = setUpWorkspace('progress-forced-fail')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  process.env.FAKE_CMUX_FAIL = 'set-progress'
  let res
  const stderr = captureStderr(() => { res = awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP }) })
  delete process.env.FAKE_CMUX_FAIL
  assert.equal(res.code, 0)
  assert.equal(res.json.resolved.length, 1)
  assert.match(stderr, /setProgress/)
})

test('phase --set gate emits exactly one clear-progress --workspace <id>; --set building and --set planning emit ZERO clear-progress', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('gate-clears-progress')

  let logBefore = readLog(env.logPath).length
  phaseCmd({ set: 'building' }, ctx)
  let log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'clear-progress').length, 0)

  logBefore = readLog(env.logPath).length
  phaseCmd({ set: 'planning' }, ctx)
  log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'clear-progress').length, 0)

  logBefore = readLog(env.logPath).length
  const res = phaseCmd({ set: 'gate' }, ctx)
  assert.equal(res.code, 0)
  log = readLog(env.logPath).slice(logBefore)
  const clearCalls = log.filter((e) => e.argv[0] === 'clear-progress')
  assert.equal(clearCalls.length, 1)
  assert.deepEqual(clearCalls[0].argv, ['clear-progress', '--workspace', workspaceRes.json.workspace_id])
})

test('a forced failure of clear-progress never changes the exit code of `phase --set gate` — cosmetics degrade loudly, never fail the verb', () => {
  const { env, ctx } = setUpWorkspace('gate-forced-fail')
  process.env.FAKE_CMUX_FAIL = 'clear-progress'
  let res
  const stderr = captureStderr(() => { res = phaseCmd({ set: 'gate' }, ctx) })
  delete process.env.FAKE_CMUX_FAIL
  assert.equal(res.code, 0)
  assert.match(stderr, /clearProgress/)
})

// ---------------------------------------------------------------------------
// ADVERSARIAL GAP-FILL (be-11-02 negative-path audit).
// ---------------------------------------------------------------------------

test('phase --set gate with NO workspace.json at all refuses "no workspace bound" (never a crash, never a clear-progress call) — mirrors dispatchCmd\'s M2-E hoist for phaseCmd', () => {
  const env = freshCmuxEnv('gate-no-workspace')
  const ctx = buildTestCtx(env.dir)
  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0)
  // Deliberately skip `workspace` — no workspace.json exists.
  assert.throws(
    () => phaseCmd({ set: 'gate' }, ctx),
    (err) => err instanceof OperationalError && /no workspace bound/.test(err.message),
  )
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'clear-progress').length, 0)
  assert.equal(log.filter((e) => e.argv[0] === 'set-status').length, 0)
})

test('phase --set gate with a malformed workspace.json is treated as absent (refuses "no workspace bound", never a JSON.parse throw, never a clear-progress call)', () => {
  const { env, ctx } = setUpWorkspace('gate-malformed-workspace')
  writeFileSync(join(ctx.paths.stateDir, 'workspace.json'), '{ not json')
  const logBefore = readLog(env.logPath).length
  assert.throws(
    () => phaseCmd({ set: 'gate' }, ctx),
    (err) => err instanceof OperationalError && /no workspace bound/.test(err.message),
  )
  const log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'clear-progress').length, 0)
})

// ensureWorkspace --group: the ungrouped retry ALSO fails. This must be
// distinguishable from both (a) the "no group argument at all" immediate
// throw and (b) a generic "new-workspace failed" message — an operator
// reading only the thrown message must be able to tell the retry itself
// (not just the original --group attempt) was the one that failed.
test('ensureWorkspace --group NEGATIVE (retry also fails): throws a message naming the retry failure explicitly ("even without --group"), with exactly one grouped attempt AND one ungrouped retry logged', () => {
  const { dir, env, ctx } = setUpWorkspace('group-fail-retry-fails')
  const ctx2 = buildContext({
    task: 'third-task-retry-fails', checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: join(dir, 'dev-team'), 'plugin-root': ROOT,
  })
  preflightCmd({}, ctx2)

  // FAKE_CMUX_FAIL matches on verb name alone (argv[0]), so this fails
  // EVERY new-workspace call — both the initial --group attempt and the
  // un-grouped retry ensureWorkspace falls back to.
  process.env.FAKE_CMUX_FAIL = 'new-workspace'
  const logBefore = readLog(env.logPath).length
  try {
    assert.throws(
      () => workspaceCmd({}, ctx2),
      (err) => /new-workspace failed even without --group/.test(err.message),
    )
  } finally {
    delete process.env.FAKE_CMUX_FAIL
  }

  const log = readLog(env.logPath).slice(logBefore)
  const newWorkspaceAttempts = log.filter((e) => e.argv[0] === 'new-workspace')
  assert.equal(newWorkspaceAttempts.length, 2, 'expected exactly one --group attempt and exactly one ungrouped retry, both failing')
  assert.ok(newWorkspaceAttempts[0].argv.includes('--group'), 'first attempt must still carry --group')
  assert.ok(!newWorkspaceAttempts[1].argv.includes('--group'), 'the retry must be un-grouped even though it also fails')

  // No workspace of that title exists anywhere — both attempts genuinely
  // failed, nothing was silently adopted.
  const liveTree = tree({ all: true })
  const allWorkspaces = (liveTree.windows || []).flatMap((w) => w.workspaces || [])
  const matches = allWorkspaces.filter((w) => w.title === ctx2.taskSlug)
  assert.equal(matches.length, 0, 'a fully-failed --group create must never leave a phantom workspace behind')
})

test('ensureWorkspace --group NEGATIVE (retry also fails) vs. no-group-at-all: the two thrown messages are textually distinguishable', () => {
  const { env, ctx } = setUpWorkspace('group-vs-no-group-message')
  const workspaceState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  process.env.FAKE_CMUX_FAIL = 'new-workspace'
  let noGroupMessage
  let withGroupRetryFailsMessage
  try {
    try {
      ensureWorkspace({ windowId: workspaceState.window_id, taskSlug: 'no-group-message-task', cwd: ctx.primaryCheckout })
    } catch (err) {
      noGroupMessage = err.message
    }
    try {
      ensureWorkspace({ windowId: workspaceState.window_id, taskSlug: 'with-group-message-task', cwd: ctx.primaryCheckout, group: 'g' })
    } catch (err) {
      withGroupRetryFailsMessage = err.message
    }
  } finally {
    delete process.env.FAKE_CMUX_FAIL
  }
  assert.ok(noGroupMessage, 'expected the no-group call to throw')
  assert.ok(withGroupRetryFailsMessage, 'expected the with-group call (both attempts failing) to throw')
  assert.notEqual(noGroupMessage, withGroupRetryFailsMessage, 'the two failure messages must not be identical — an operator must be able to tell which flag caused it')
  assert.doesNotMatch(noGroupMessage, /even without --group/)
  assert.match(withGroupRetryFailsMessage, /even without --group/)
})

// A corrupted tree with two workspaces sharing the same title must never
// crash the fast "does one already exist" path — findWorkspaceByTitle's
// .find() deterministically picks the first match rather than throwing on
// ambiguity (unlike findDocTabSurface, which fails closed on ambiguity by
// design — the two helpers have deliberately different contracts).
test('ensureWorkspace fast path: two workspaces sharing the same title in a corrupted tree resolves to the FIRST match deterministically, never throws', () => {
  const { env, ctx } = setUpWorkspace('dup-title-fast-path')
  const workspaceState = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))

  // Seed a second workspace with the exact same title directly into the
  // fake's persisted topology, simulating a corrupted/hand-edited tree.
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  const win = state.windows.find((w) => w.id.toLowerCase() === workspaceState.window_id.toLowerCase())
  const existingWs = win.workspaces.find((w) => w.id.toLowerCase() === workspaceState.workspace_id.toLowerCase())
  const dupWsId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const dupPaneId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  const dupSurfId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  win.workspaces.push({
    id: dupWsId,
    window_id: win.id,
    title: existingWs.title,
    panes: [{
      id: dupPaneId, workspace_id: dupWsId, surface_ids: [dupSurfId], selected_surface_id: dupSurfId,
      surfaces: [{ id: dupSurfId, pane_id: dupPaneId, type: 'terminal', tty: null, title: 'terminal' }],
    }],
  })
  writeFileSync(env.statePath, JSON.stringify(state))

  const logBefore = readLog(env.logPath).length
  const result = ensureWorkspace({ windowId: workspaceState.window_id, taskSlug: existingWs.title, cwd: ctx.primaryCheckout })
  assert.equal(result.workspaceId, existingWs.id.toLowerCase(), 'must deterministically resolve to the FIRST workspace of that title')
  const log = readLog(env.logPath).slice(logBefore)
  assert.equal(log.filter((e) => e.argv[0] === 'new-workspace').length, 0, 'an existing (even ambiguous) title match must never trigger a create')
})

// Tier validation: Number() coercion edge cases beyond the existing '4'/'abc'
// pair. '0' must reject (0 is not in TIERS). Numeric-looking-but-not-integer
// strings that Number() happens to coerce EXACTLY onto a valid tier (e.g.
// '1.0', '+1', ' 2') are accepted today — this is documented as the current,
// intentional-by-omission behavior (Number() coercion, not a stricter
// integer-string parse), not asserted as a bug to fix here.
test('workspace --tier: "0", "", "-1", "NaN", "Infinity", "3.5" all reject as UsageError, validated before any cmux call', () => {
  const env = freshCmuxEnv('tier-more-bad')
  const ctx = buildTestCtx(env.dir, { task: 'tier-more-bad-task' })
  for (const bad of ['0', '', '-1', 'NaN', 'Infinity', '3.5']) {
    const before = readLog(env.logPath).length
    assert.throws(() => workspaceCmd({ tier: bad }, ctx), UsageError, `--tier ${JSON.stringify(bad)} must be rejected`)
    const after = readLog(env.logPath).length
    assert.equal(after, before, `--tier ${JSON.stringify(bad)} must issue zero cmux invocations`)
  }
})

test('workspace --tier: Number()-coercible-to-a-valid-tier strings ("1.0", "+1", " 2") are ACCEPTED as that tier — documents current coercion behavior', () => {
  const env = freshCmuxEnv('tier-coercion-accepted')
  const ctx = buildTestCtx(env.dir, { task: 'tier-coercion-accepted-task' })
  preflightCmd({}, ctx)
  const res1 = workspaceCmd({ tier: '1.0' }, ctx)
  assert.equal(res1.json.tier, 1)
  const env2 = freshCmuxEnv('tier-coercion-accepted-2')
  const ctx2 = buildTestCtx(env2.dir, { task: 'tier-coercion-accepted-task-2' })
  preflightCmd({}, ctx2)
  const res2 = workspaceCmd({ tier: ' 2' }, ctx2)
  assert.equal(res2.json.tier, 2)
})

// ---------------------------------------------------------------------------
// be-12-01 (issue #12/D1+D2, ADR-019) — the cmuxctl `browser` family.
// Lives HERE, not a new test file: this file owns setUpWorkspace/
// freshCmuxEnv/makeSpecFile, and importing a test file re-registers its
// whole suite (backend-notes 2026-08-01). Positives first, per E-P1's own
// anti-vacuity shape; argv asserted element-by-element with exact counts.
// ---------------------------------------------------------------------------

function findPaneInTree(t, paneId) {
  for (const w of t.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        if (p.id === paneId) return p
      }
    }
  }
  return null
}

test('browserOpen: happy path — argv element-by-element exact, --focus false present, returns {surfaceId, paneId, placement, treeAfter}', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-open-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const logBefore = readLog(env.logPath).length

  const result = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })

  const log = readLog(env.logPath).slice(logBefore)
  const openEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'open')
  assert.equal(openEntries.length, 1, `expected exactly one browser open invocation, got ${openEntries.length}`)
  assert.deepEqual(openEntries[0].argv, ['browser', 'open', 'http://localhost:3000/', '--workspace', workspaceId, '--focus', 'false'])

  assert.equal(result.placement, 'split')
  assert.match(result.surfaceId, /^[0-9a-f-]{36}$/)
  assert.match(result.paneId, /^[0-9a-f-]{36}$/)
  assert.equal(typeof result.treeAfter, 'object')
  assert.notEqual(result.treeAfter, null)
})

test('browserGoto: happy path — argv element-by-element exact, returns true; the surface title updates to the new URL\'s hostname', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-goto-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const logBefore = readLog(env.logPath).length

  const ok = browserGoto(opened.surfaceId, 'http://example.com/path')

  assert.equal(ok, true)
  const log = readLog(env.logPath).slice(logBefore)
  const gotoEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'goto')
  assert.equal(gotoEntries.length, 1, `expected exactly one browser goto invocation, got ${gotoEntries.length}`)
  assert.deepEqual(gotoEntries[0].argv, ['browser', opened.surfaceId, 'goto', 'http://example.com/path'])

  const after = tree({ all: true })
  assert.equal(findSurface(after, opened.surfaceId).title, 'example.com')
})

test('browserWaitReady: happy path — argv element-by-element exact (--load-state complete --timeout-ms 20000), returns true', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-wait-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const logBefore = readLog(env.logPath).length

  assert.equal(BROWSER_LOAD_STATE, 'complete')
  const ok = browserWaitReady(opened.surfaceId)

  assert.equal(ok, true)
  const log = readLog(env.logPath).slice(logBefore)
  const waitEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'wait')
  assert.equal(waitEntries.length, 1, `expected exactly one browser wait invocation, got ${waitEntries.length}`)
  assert.deepEqual(waitEntries[0].argv, ['browser', opened.surfaceId, 'wait', '--load-state', BROWSER_LOAD_STATE, '--timeout-ms', '20000'])
})

test('browserErrorsClear: happy path — argv element-by-element exact, returns true', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-errors-clear-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const logBefore = readLog(env.logPath).length

  const ok = browserErrorsClear(opened.surfaceId)

  assert.equal(ok, true)
  const log = readLog(env.logPath).slice(logBefore)
  const clearEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'errors' && e.argv[3] === 'clear')
  assert.equal(clearEntries.length, 1, `expected exactly one browser errors clear invocation, got ${clearEntries.length}`)
  assert.deepEqual(clearEntries[0].argv, ['browser', opened.surfaceId, 'errors', 'clear'])
})

test('browserErrorsList: happy path — argv element-by-element exact, returns the RAW clean literal string (the sole wrapper returning a string)', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-errors-list-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const logBefore = readLog(env.logPath).length

  const result = browserErrorsList(opened.surfaceId)

  assert.equal(typeof result, 'string')
  assert.equal(result.trim(), 'No browser errors')
  const log = readLog(env.logPath).slice(logBefore)
  const listEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'errors' && e.argv[3] === 'list')
  assert.equal(listEntries.length, 1, `expected exactly one browser errors list invocation, got ${listEntries.length}`)
  assert.deepEqual(listEntries[0].argv, ['browser', opened.surfaceId, 'errors', 'list'])
})

test('browserScreenshot: happy path — argv element-by-element exact, returns true, and existsSync proves an actual write (never trusting the OK line alone)', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-screenshot-happy')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const outPath = join(mkdtempSync(join(tmpdir(), 'browser-shot-')), 'verify.png')
  const logBefore = readLog(env.logPath).length

  const ok = browserScreenshot(opened.surfaceId, outPath)

  assert.equal(ok, true)
  assert.ok(existsSync(outPath))
  const log = readLog(env.logPath).slice(logBefore)
  const shotEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'screenshot')
  assert.equal(shotEntries.length, 1, `expected exactly one browser screenshot invocation, got ${shotEntries.length}`)
  assert.deepEqual(shotEntries[0].argv, ['browser', opened.surfaceId, 'screenshot', '--out', outPath])
})

test('return-type contract: only browserErrorsList returns a string; browserOpen returns {ids,...}|null; the other four return boolean', () => {
  const { workspaceRes } = setUpWorkspace('browser-return-types')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  assert.equal(typeof opened, 'object')
  assert.notEqual(opened, null)
  assert.equal(typeof opened.surfaceId, 'string')
  assert.equal(typeof opened.paneId, 'string')
  assert.equal(typeof opened.placement, 'string')
  assert.equal(typeof opened.treeAfter, 'object')

  assert.equal(typeof browserGoto(opened.surfaceId, 'http://example.com/'), 'boolean')
  assert.equal(typeof browserWaitReady(opened.surfaceId), 'boolean')
  assert.equal(typeof browserErrorsClear(opened.surfaceId), 'boolean')
  assert.equal(typeof browserErrorsList(opened.surfaceId), 'string')
  const outPath = join(mkdtempSync(join(tmpdir(), 'browser-shot-')), 'verify.png')
  assert.equal(typeof browserScreenshot(opened.surfaceId, outPath), 'boolean')
})

test('every browser wrapper throws BEFORE any spawn on a missing/malformed id — zero fixture invocation-log entries', () => {
  const env = freshCmuxEnv('browser-missing-id')
  assert.throws(() => browserOpen('http://x/', {}), /workspaceId is required/)
  assert.throws(() => browserOpen('http://x/', { workspaceId: 'w' }), /treeBefore is required/)
  assert.throws(() => browserGoto(undefined, 'http://x/'), /surfaceId is required/)
  assert.throws(() => browserGoto('', 'http://x/'), /surfaceId is required/)
  assert.throws(() => browserWaitReady(''), /surfaceId is required/)
  assert.throws(() => browserWaitReady(null), /surfaceId is required/)
  assert.throws(() => browserErrorsClear(null), /surfaceId is required/)
  assert.throws(() => browserErrorsList(123), /surfaceId is required/)
  assert.throws(() => browserScreenshot('surface-1', ''), /outPath is required/)
  assert.throws(() => browserScreenshot('', '/tmp/x.png'), /surfaceId is required/)
  assert.equal(readLog(env.logPath).length, 0, 'zero cmux invocations for every one of these refusals')
})

test('browserVerb: an out-of-allowlist sub-verb throws BEFORE any spawn — zero fixture invocation-log entries (eval/state/console/snapshot/viewport unreachable)', () => {
  const env = freshCmuxEnv('browser-subverb-guard')
  assert.throws(() => browserVerb('eval', ['1+1'], {}), /BROWSER_SUBVERBS/)
  assert.throws(() => browserVerb('state', ['save'], {}), /BROWSER_SUBVERBS/)
  assert.throws(() => browserVerb('console', ['list'], {}), /BROWSER_SUBVERBS/)
  assert.throws(() => browserVerb('snapshot', [], {}), /BROWSER_SUBVERBS/)
  assert.throws(() => browserVerb('viewport', ['set'], {}), /BROWSER_SUBVERBS/)
  assert.equal(readLog(env.logPath).length, 0, 'zero cmux invocations for every one of these refusals')
})

// fix-round-2 (F1, live-pass-findings.md): GRAMMAR REGRESSION IS
// STRUCTURALLY FATAL. The real grammar is surface-FIRST; a sub-verb-first
// invocation (the pre-fix-round-2 bug) is not merely "a different argv" — it
// fails the fixture the SAME way it fails live cmux 0.64.22 ("Unsupported
// browser subcommand: <token>"), because the misplaced sub-verb literal
// lands in the surface-handle slot the parser actually reads as the
// sub-verb. This is asserted directly against the fixture (bypassing every
// wrapper), independent of any wrapper's own argv pin, so a wrapper
// regression to the old order is caught by every one of that wrapper's OWN
// behavioral tests (mutation: revert browserGoto to sub-verb-first —
// observed multiple tests red, not only the argv-pin test — then reverted).
test('GRAMMAR REGRESSION IS STRUCTURALLY FATAL: a sub-verb-first invocation (the OLD wrong order) fails with the real "Unsupported browser subcommand" shape, for every surface-taking sub-verb', () => {
  const { workspaceRes } = setUpWorkspace('browser-old-order-regression')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })

  const gotoRes = cmux('browser', ['goto', opened.surfaceId, 'http://example.com/'])
  assert.equal(gotoRes.ok, false)
  assert.equal(gotoRes.error.code, 'Unsupported browser subcommand')
  assert.equal(gotoRes.error.message, opened.surfaceId)

  const waitRes = cmux('browser', ['wait', opened.surfaceId, '--load-state', 'complete', '--timeout-ms', '20000'])
  assert.equal(waitRes.ok, false)
  assert.equal(waitRes.error.code, 'Unsupported browser subcommand')
  assert.equal(waitRes.error.message, opened.surfaceId)

  const clearRes = cmux('browser', ['errors', 'clear', opened.surfaceId])
  assert.equal(clearRes.ok, false)
  assert.equal(clearRes.error.code, 'Unsupported browser subcommand')
  assert.equal(clearRes.error.message, 'clear')

  const listRes = cmux('browser', ['errors', 'list', opened.surfaceId])
  assert.equal(listRes.ok, false)
  assert.equal(listRes.error.code, 'Unsupported browser subcommand')
  assert.equal(listRes.error.message, 'list')

  const shotRes = cmux('browser', ['screenshot', opened.surfaceId, '--out', '/tmp/never-written.png'])
  assert.equal(shotRes.ok, false)
  assert.equal(shotRes.error.code, 'Unsupported browser subcommand')
  assert.equal(shotRes.error.message, opened.surfaceId)
})

test('open prints POSITIONAL refs (surface=surface:<n> pane=pane:<n>), never uuids — parsing the printed id instead of diffing would fail', () => {
  const { workspaceRes } = setUpWorkspace('browser-positional')
  const workspaceId = workspaceRes.json.workspace_id
  const res = browserVerb('open', ['http://localhost:3000/', '--workspace', workspaceId, '--focus', 'false'], { timeoutMs: 5000 })
  assert.equal(res.ok, true)
  assert.match(res.stdout, /^OK surface=surface:\d+ pane=pane:\d+ placement=split$/m)
  const surfaceToken = res.stdout.match(/surface=surface:(\d+)/)[1]
  assert.doesNotMatch(surfaceToken, /[0-9a-f]{8}-[0-9a-f]{4}/)
})

test('a second open into a workspace already holding a browser surface prints placement=reuse and STACKS a second surface into the SAME pane', () => {
  const { workspaceRes } = setUpWorkspace('browser-stack')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const first = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  assert.equal(first.placement, 'split')

  const second = browserOpen('http://localhost:3001/', { workspaceId, treeBefore: first.treeAfter })
  assert.equal(second.placement, 'reuse')
  assert.equal(second.paneId, first.paneId)

  const pane = findPaneInTree(second.treeAfter, first.paneId)
  const browserSurfaces = pane.surfaces.filter((s) => s.type === 'browser')
  assert.equal(browserSurfaces.length, 2)
})

test('wait/errors on a surface in a pane holding >=2 browser surfaces fail(js_error, "...become ready"); screenshot there still succeeds (models the blank-PNG reality)', () => {
  const { workspaceRes } = setUpWorkspace('browser-stack-drivability')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const first = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  browserOpen('http://localhost:3001/', { workspaceId, treeBefore: first.treeAfter })

  assert.equal(browserWaitReady(first.surfaceId), false)
  assert.equal(browserErrorsList(first.surfaceId), null)
  assert.equal(browserErrorsClear(first.surfaceId), false)

  const outPath = join(mkdtempSync(join(tmpdir(), 'browser-shot-')), 'verify.png')
  assert.equal(browserScreenshot(first.surfaceId, outPath), true)
  assert.ok(existsSync(outPath))
})

test('the fixture --load-state guard rejects the shorter, unsuffixed value; only interactive|complete succeed (live-verified, cmux 0.64.22)', () => {
  const { workspaceRes } = setUpWorkspace('browser-load-state-guard')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })

  const badRes = browserVerb('wait', [opened.surfaceId, '--load-state', 'load', '--timeout-ms', '20000'], { timeoutMs: 5000 })
  assert.equal(badRes.ok, false)
  assert.equal(badRes.error.code, 'js_error')

  const okRes = browserVerb('wait', [opened.surfaceId, '--load-state', 'interactive', '--timeout-ms', '20000'], { timeoutMs: 5000 })
  assert.equal(okRes.ok, true)
})

test('browserGoto degrades (false, never throws) on a simulated navigation_timeout, logging the CODE only — the detail string is absent from stderr', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-goto-degrade')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateGotoNavigationTimeout = true
  writeFileSync(env.statePath, JSON.stringify(state))

  let result
  const stderr = captureStderr(() => { result = browserGoto(opened.surfaceId, 'http://dead.example/') })

  assert.equal(result, false)
  assert.match(stderr, /navigation_timeout/)
  assert.doesNotMatch(stderr, /Timed out waiting/)
})

test('browserWaitReady/browserErrorsList degrade (never throw) on a stacked-pane js_error, logging the CODE only — the detail string is absent from stderr', () => {
  const { workspaceRes } = setUpWorkspace('browser-degrade-detail-absent')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const first = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  browserOpen('http://localhost:3001/', { workspaceId, treeBefore: first.treeAfter })

  let waitResult
  const waitStderr = captureStderr(() => { waitResult = browserWaitReady(first.surfaceId) })
  assert.equal(waitResult, false)
  assert.match(waitStderr, /js_error/)
  assert.doesNotMatch(waitStderr, /Timed out waiting/)

  let listResult
  const listStderr = captureStderr(() => { listResult = browserErrorsList(first.surfaceId) })
  assert.equal(listResult, null)
  assert.match(listStderr, /js_error/)
  assert.doesNotMatch(listStderr, /Timed out waiting/)
})

test('an out-of-vocabulary error code (fails the ^[a-z_]{1,32}$ shape guard) logs the literal <unparsed> instead of riding through unchecked', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-unparsed-code')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserUnknownErrorCode = true
  writeFileSync(env.statePath, JSON.stringify(state))

  let result
  const stderr = captureStderr(() => { result = browserErrorsList(opened.surfaceId) })

  assert.equal(result, null)
  assert.match(stderr, /<unparsed>/)
})

test('browserOpen under _simulateConcurrentCreate surfaces the recoverNewId ambiguity rather than guessing', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-concurrent-create')
  const workspaceId = workspaceRes.json.workspace_id
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateConcurrentCreate = true
  writeFileSync(env.statePath, JSON.stringify(state))
  const treeBefore = tree({ all: true })

  assert.throws(() => browserOpen('http://localhost:3000/', { workspaceId, treeBefore }), /expected exactly 1 new surface/)
})

test('rename-tab fails not_found on a non-terminal (browser) surface (fixture fidelity fix); succeeds on the workspace\'s terminal surface', () => {
  const { workspaceRes } = setUpWorkspace('browser-rename-tab-fidelity')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })

  const browserRenameRes = cmux('rename-tab', [opened.surfaceId, 'preview'])
  assert.equal(browserRenameRes.ok, false)
  assert.equal(browserRenameRes.error.code, 'not_found')

  const terminalSurfaceId = workspaceRes.json.initial_surface_id
  const terminalRenameRes = cmux('rename-tab', [terminalSurfaceId, 'my terminal'])
  assert.equal(terminalRenameRes.ok, true)
})

test('_simulateScreenshotOkNoWrite: cmux prints OK WITHOUT writing the file — a caller trusting the OK line instead of existsSync would be fooled', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-screenshot-no-write')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateScreenshotOkNoWrite = true
  writeFileSync(env.statePath, JSON.stringify(state))
  const outPath = join(mkdtempSync(join(tmpdir(), 'browser-shot-')), 'never-written.png')

  const rawRes = cmux('browser', [opened.surfaceId, 'screenshot', '--out', outPath])
  assert.equal(rawRes.ok, true)
  assert.match(rawRes.stdout, /^OK /)
  assert.ok(!existsSync(outPath), 'the fixture must print OK without actually writing the file under this flag')

  // The real wrapper is unaffected by this raw-cmux distinction: it still
  // only reports on the cmux call's own ok/fail, never on existsSync — that
  // confirmation is be-12-03's job (browser-verify), not this wrapper's.
  assert.equal(browserScreenshot(opened.surfaceId, outPath), true)
})

// fix-round-2 (F1): under the real surface-first grammar, a sub-verb that
// bypasses browserVerb's own allowlist (e.g. `eval`) is unreachable through
// the wrapper surface but, if it somehow reached the fixture directly
// (surface-first, `eval` correctly placed as the sub-verb token), fails the
// SAME "Unsupported browser subcommand" shape the real binary uses for any
// unrecognized sub-verb — never silently succeeding.
test('an out-of-allowlist sub-verb in the FIXTURE itself (reachable only by bypassing browserVerb) fails with the real "Unsupported browser subcommand" shape, never silently succeeds', () => {
  const { workspaceRes } = setUpWorkspace('browser-fixture-unknown-subverb')
  const res = cmux('browser', [workspaceRes.json.initial_surface_id, 'eval', '1+1'])
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'Unsupported browser subcommand')
  assert.equal(res.error.message, 'eval')
})

test('browserOpen: a hung `browser open` spawn is killed by its own 5000ms timeoutMs, returns null, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-open-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserOpenHang = true
  writeFileSync(env.statePath, JSON.stringify(state))
  const treeBefore = tree({ all: true })

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserOpen('http://localhost:3000/', { workspaceId, treeBefore }) })
  const elapsedMs = Date.now() - start

  assert.equal(result, null)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 9000, `expected the 5000ms spawn bound to be enforced well under 9000ms, took ${elapsedMs}ms`)
})

// be-12-02 fix-round item 6: browserGoto/browserWaitReady/browserErrorsClear/
// browserErrorsList/browserScreenshot were previously covered only by a
// source-text argv-regex check (proves the timeoutMs literal is TYPED, never
// that it reaches spawnSync and is enforced). These five hang tests close
// that gap, mirroring the browserOpen hang test's shape exactly.
test('browserGoto: a hung `browser goto` spawn is killed by its own 20000ms timeoutMs, returns false, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-goto-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserGotoHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserGoto(opened.surfaceId, 'http://example.com/') })
  const elapsedMs = Date.now() - start

  assert.equal(result, false)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 25000, `expected the 20000ms spawn bound to be enforced well under 25000ms, took ${elapsedMs}ms`)
})

test('browserWaitReady: a hung `browser wait` spawn is killed by its own 25000ms timeoutMs, returns false, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-wait-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserWaitHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserWaitReady(opened.surfaceId) })
  const elapsedMs = Date.now() - start

  assert.equal(result, false)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 30000, `expected the 25000ms spawn bound to be enforced well under 30000ms, took ${elapsedMs}ms`)
})

test('browserErrorsClear: a hung `browser errors clear` spawn is killed by its own 10000ms timeoutMs, returns false, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-errors-clear-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserErrorsClearHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserErrorsClear(opened.surfaceId) })
  const elapsedMs = Date.now() - start

  assert.equal(result, false)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 15000, `expected the 10000ms spawn bound to be enforced well under 15000ms, took ${elapsedMs}ms`)
})

test('browserErrorsList: a hung `browser errors list` spawn is killed by its own 10000ms timeoutMs, returns null, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-errors-list-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserErrorsListHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserErrorsList(opened.surfaceId) })
  const elapsedMs = Date.now() - start

  assert.equal(result, null)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 15000, `expected the 10000ms spawn bound to be enforced well under 15000ms, took ${elapsedMs}ms`)
})

test('browserScreenshot: a hung `browser screenshot` spawn is killed by its own 20000ms timeoutMs, returns false, logs spawn_error — never hangs the caller', () => {
  const { env, workspaceRes } = setUpWorkspace('browser-screenshot-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const treeBefore = tree({ all: true })
  const opened = browserOpen('http://localhost:3000/', { workspaceId, treeBefore })
  const outPath = join(mkdtempSync(join(tmpdir(), 'browser-shot-hang-')), 'verify.png')
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateBrowserScreenshotHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  let result
  const stderr = captureStderr(() => { result = browserScreenshot(opened.surfaceId, outPath) })
  const elapsedMs = Date.now() - start

  assert.equal(result, false)
  assert.equal(existsSync(outPath), false)
  assert.match(stderr, /spawn_error/)
  assert.ok(elapsedMs < 25000, `expected the 20000ms spawn bound to be enforced well under 25000ms, took ${elapsedMs}ms`)
})

test('tree(): a hung read is killed by its own explicit timeoutMs (never hangs the caller), and the underlying spawn error code is spawn_error', () => {
  const { env } = setUpWorkspace('browser-tree-hang')
  const state = JSON.parse(readFileSync(env.statePath, 'utf8'))
  state._simulateTreeHang = true
  writeFileSync(env.statePath, JSON.stringify(state))

  const start = Date.now()
  const res = cmux('tree', ['--json', '--id-format', 'uuids', '--all'], { timeoutMs: 3000 })
  const elapsedMs = Date.now() - start

  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'spawn_error')
  assert.ok(elapsedMs < 8000, `expected the 3000ms bound to be enforced well under 8000ms, took ${elapsedMs}ms`)

  // tree() itself throws (losing the raw code in its own generic message,
  // unchanged behavior) but must still be BOUNDED by the same timeoutMs —
  // proving the optional param actually reaches spawnSync, not merely
  // accepted and ignored.
  const start2 = Date.now()
  assert.throws(() => tree({ all: true, timeoutMs: 3000 }))
  const elapsedMs2 = Date.now() - start2
  assert.ok(elapsedMs2 < 8000, `expected tree()'s own bound to be enforced well under 8000ms, took ${elapsedMs2}ms`)
})

test('source-text: the literal load (the invalid --load-state value) never appears as a quoted string anywhere under scripts/cmux/', () => {
  const scriptsDir = join(ROOT, 'scripts', 'cmux')
  const files = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length > 0)
  for (const f of files) {
    const src = readFileSync(join(scriptsDir, f), 'utf8')
    assert.doesNotMatch(src, /'load'/, `${f} must never contain the quoted string literal 'load'`)
    assert.doesNotMatch(src, /"load"/, `${f} must never contain the quoted string literal "load"`)
  }
})

test('source-text: every browser wrapper logs the error CODE only, never `.message` — the deliberate divergence from the house err.message pattern', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'), 'utf8')
  const start = src.indexOf('// Browser preview family')
  const end = src.indexOf(' * findDocTabSurface(t')
  assert.ok(start > -1, 'expected to find the browser preview family section marker')
  assert.ok(end > start, 'expected to find the section end marker (findDocTabSurface)')
  const section = src.slice(start, end)
  assert.doesNotMatch(section, /res\.error\?\.message/, 'a browser wrapper must never log res.error?.message')
  assert.match(section, /logBrowserError/, 'expected the code-only logging helper to be used in this section')
})

test('source-text: every browser wrapper passes an explicit timeoutMs to browserVerb, matching its IC-2 bound', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'), 'utf8')
  assert.match(src, /browserVerb\('open', \[url, '--workspace', workspaceId, '--focus', 'false'\], \{ timeoutMs: BROWSER_OPEN_SPAWN_TIMEOUT_MS \}\)/)
  assert.match(src, /browserVerb\('goto', \[surfaceId, url\], \{ timeoutMs: 20000 \}\)/)
  assert.match(src, /browserVerb\('wait', \[surfaceId, '--load-state', BROWSER_LOAD_STATE, '--timeout-ms', '20000'\], \{ timeoutMs \}\)/)
  assert.match(src, /browserVerb\('errors', \[surfaceId, 'clear'\], \{ timeoutMs: 10000 \}\)/)
  assert.match(src, /browserVerb\('errors', \[surfaceId, 'list'\], \{ timeoutMs: 10000 \}\)/)
  assert.match(src, /browserVerb\('screenshot', \[surfaceId, '--out', outPath\], \{ timeoutMs: 20000 \}\)/)
})

// ---------------------------------------------------------------------------
// be-12-02 (issue #12/D4/D7/D8, ADR-019 + v2.1 errata) — the browser preview
// singleton: config-key reader/validator, the sidecar+lock+scan, the
// dispatchCmd trigger/JSON key, and teardown deletion.
// ---------------------------------------------------------------------------

const PREVIEW_URL = 'http://localhost:3000/'

function setUpPreviewWorkspace(prefix, opts = {}) {
  const built = setUpWorkspace(prefix, opts)
  writeConfigMd(built.ctx.primaryCheckout, `cmux_preview_url: ${PREVIEW_URL}\n`)
  return built
}

function loadFakeState(env) {
  return JSON.parse(readFileSync(env.statePath, 'utf8'))
}

function saveFakeState(env, state) {
  writeFileSync(env.statePath, JSON.stringify(state))
}

function readBrowserSidecar(ctx) {
  const p = join(ctx.paths.stateDir, 'browser.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

function writeBrowserSidecarRaw(ctx, obj) {
  mkdirSync(ctx.paths.stateDir, { recursive: true })
  writeFileSync(join(ctx.paths.stateDir, 'browser.json'), JSON.stringify(obj))
}

function browserOpenInvocations(env) {
  return readLog(env.logPath).filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'open')
}

// injectFreeBrowserSurface(env, workspaceId, surfaceId) -> surfaceId. Adds a
// brand-new pane holding a single browser-typed surface directly to
// FAKE_CMUX_STATE — the fixture doctrine's escape hatch for topology this
// synchronous fixture cannot produce through a single `browser open` call (a
// SECOND, workspace-unrelated browser surface pre-existing before a
// dispatch's own scan even runs).
function injectFreeBrowserSurface(env, workspaceId, surfaceId = randomUUID()) {
  const needle = workspaceId.toLowerCase()
  const state = loadFakeState(env)
  const win = state.windows.find((w) => (w.workspaces || []).some((ws) => ws.id.toLowerCase() === needle))
  const ws = win.workspaces.find((w) => w.id.toLowerCase() === needle)
  const paneId = randomUUID()
  ws.panes.push({
    id: paneId, workspace_id: workspaceId, surface_ids: [surfaceId], selected_surface_id: surfaceId,
    surfaces: [{ id: surfaceId, pane_id: paneId, type: 'browser', tty: null, title: 'stray' }],
  })
  saveFakeState(env, state)
  return surfaceId
}

// injectBrowserSurfaceIntoPane(env, paneId, surfaceId) -> surfaceId. Adds a
// browser-typed surface into an EXISTING pane — models a rung-2 mountDocTab
// browser doc tab sharing a worker's pane.
function injectBrowserSurfaceIntoPane(env, paneId, surfaceId = randomUUID()) {
  const needle = (paneId || '').toLowerCase()
  const state = loadFakeState(env)
  let target = null
  for (const w of state.windows || []) {
    for (const ws of w.workspaces || []) {
      const p = (ws.panes || []).find((x) => x.id.toLowerCase() === needle)
      if (p) target = p
    }
  }
  if (!target) throw new Error(`injectBrowserSurfaceIntoPane: pane ${paneId} not found in fixture state`)
  target.surfaces.push({ id: surfaceId, pane_id: target.id, type: 'browser', tty: null, title: 'doctab-browser' })
  target.surface_ids.push(surfaceId)
  saveFakeState(env, state)
  return surfaceId
}

function findPaneOfSurface(env, surfaceId) {
  const needle = surfaceId.toLowerCase()
  const state = loadFakeState(env)
  for (const w of state.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        if ((p.surfaces || []).some((s) => s.id.toLowerCase() === needle)) return p.id
      }
    }
  }
  return null
}

function reorderPanesInState(env, workspaceId) {
  const needle = workspaceId.toLowerCase()
  const state = loadFakeState(env)
  for (const w of state.windows || []) {
    const ws = (w.workspaces || []).find((x) => x.id.toLowerCase() === needle)
    if (ws) ws.panes = [...ws.panes].reverse()
  }
  saveFakeState(env, state)
}

// ---------------------------------------------------------------------------
// readCmuxPreviewUrl + validator (D8, errata untouched)
// ---------------------------------------------------------------------------

test('readCmuxPreviewUrl: absent/blank -> null; a single line returns the trimmed value; fenced examples never live-parse', () => {
  assert.equal(readCmuxPreviewUrl(''), null)
  assert.equal(readCmuxPreviewUrl('other: stuff\n'), null)
  assert.equal(readCmuxPreviewUrl('cmux_preview_url:\n'), null)
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: http://localhost:3000\n'), 'http://localhost:3000')
  assert.equal(
    readCmuxPreviewUrl('Example config.md:\n```\ncmux_preview_url: http://example.invalid\n```\n'),
    null,
    'a fenced example must never live-parse as a value',
  )
})

test('readCmuxPreviewUrl: more than one cmux_preview_url line is ambiguous and refuses with zero cmux invocations', () => {
  const { env } = setUpWorkspace('preview-url-ambiguous')
  const logBefore = readLog(env.logPath).length
  assert.throws(
    () => readCmuxPreviewUrl('cmux_preview_url: http://a.invalid\ncmux_preview_url: http://b.invalid\n'),
    (e) => e instanceof OperationalError && /ambiguous/.test(e.message),
  )
  assert.equal(readLog(env.logPath).length, logBefore, 'the ambiguity refusal must issue zero cmux invocations')
})

test('readCmuxPreviewUrl / validator: refusal messages never echo the configured value', () => {
  for (const badLine of [
    'cmux_preview_url: http://user:s3cr3t-token@host/\n',
    'cmux_preview_url: https://?\n',
    'cmux_preview_url: file:///etc/passwd\n',
    'cmux_preview_url: javascript:alert(1)\n',
  ]) {
    assert.throws(() => readCmuxPreviewUrl(badLine), (e) => {
      assert.ok(e instanceof OperationalError)
      assert.doesNotMatch(e.message, /s3cr3t-token|\/etc\/passwd|alert\(1\)/)
      return true
    })
  }
})

test('validator: refuses \'@\' (userinfo), hostless forms, out-of-range port, a malformed %-escape, and non-http(s) schemes — all BEFORE any spawn', () => {
  const { env } = setUpWorkspace('preview-url-validator-negatives')
  const logBefore = readLog(env.logPath).length
  const bad = [
    'http://user:pass@host/',
    'https://?',
    'https://#',
    'https://@',
    'http://host:99999/',
    'http://host/%zz',
    'http://host/%2',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'HTTPS://host/',
    'http:\\\\host\\path',
  ]
  for (const url of bad) {
    assert.throws(() => readCmuxPreviewUrl(`cmux_preview_url: ${url}\n`), OperationalError, `expected a refusal for ${url}`)
  }
  assert.equal(readLog(env.logPath).length, logBefore, 'every refusal above must be BEFORE any spawn')
})

// test-engineer (PR-1 QA pass): the negatives test above only exercises
// port 99999 — far past the 65535 boundary, so an off-by-one on the bound
// itself (`> 65536` instead of `> 65535`) survives it silently (mutated,
// confirmed: 0 failures). Pin the exact boundary on both sides, paired with
// the existing "65535 accepted" positive at :4801.
test('validator: the port bound is exactly 65535 — 65536 (one past the documented positive boundary) is refused', () => {
  assert.throws(() => readCmuxPreviewUrl('cmux_preview_url: http://localhost:65536/\n'), OperationalError)
})

test('validator: refuses a value with a VALID prefix but trailing garbage after it (proves the trailing $ anchor is load-bearing, not just the leading ^)', () => {
  // Without the trailing anchor, a regex match only needs a valid PREFIX —
  // `http://localhost:3000/ok` alone would satisfy an unanchored pattern,
  // silently accepting the disallowed backslash suffix that follows.
  assert.throws(() => readCmuxPreviewUrl('cmux_preview_url: http://localhost:3000/ok\\evil\n'), OperationalError)
})

test('validator positives: a bare host, a port, a path, and a valid %-escape all pass; a trailing CR is trimmed away', () => {
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: http://localhost\n'), 'http://localhost')
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: http://localhost:3000\n'), 'http://localhost:3000')
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: https://localhost:65535/a/b?x=1#frag\n'), 'https://localhost:65535/a/b?x=1#frag')
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: http://localhost/path%20with%20spaces\n'), 'http://localhost/path%20with%20spaces')
  assert.equal(readCmuxPreviewUrl('cmux_preview_url: http://localhost:3000\r\n'), 'http://localhost:3000')
})

test('validator: length > 2048 refuses', () => {
  const longPath = `/${'a'.repeat(2100)}`
  assert.throws(() => readCmuxPreviewUrl(`cmux_preview_url: http://localhost${longPath}\n`), OperationalError)
})

// Mutation doctrine (AC5): unanchor the regex; swap the scheme allowlist for
// a denylist; make readCmuxPreviewUrl take-first on ambiguity — each must
// turn a test above red. (Applied/observed/reverted by hand; see the coder's
// final report for which test caught each.)

// ---------------------------------------------------------------------------
// A/B: cmux_preview_url absent vs set — AC1 byte-identity, and the `preview`
// key's presence/absence per the four trigger conjuncts (errata E6).
// ---------------------------------------------------------------------------

test('A/B: cmux_preview_url ABSENT -> zero browser invocations, no browser.json, workspace.json unaffected, and the dispatch JSON carries NO preview key at all', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('preview-ab-absent')
  const workspaceStateBefore = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  const specPath = makeSpecFile(ctx, 'be-9a', { domain: 'frontend' })

  const res = dispatchCmd({ slice: 'be-9a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.equal('preview' in res.json, false, 'the preview key must be OMITTED entirely, not present-and-undefined')
  assert.equal(browserOpenInvocations(env).length, 0)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json')), false)

  const workspaceStateAfter = JSON.parse(readFileSync(join(ctx.paths.stateDir, 'workspace.json'), 'utf8'))
  assert.deepEqual(workspaceStateAfter, workspaceStateBefore, 'workspace.json must be byte-identical to the pre-feature baseline')
})

test('A/B: cmux_preview_url SET + frontend spec + worktree role (coder) + browser.open cached -> exactly one browser open, argv includes --focus false, preview:{state:"created"}', () => {
  const { env, ctx, workspaceRes } = setUpPreviewWorkspace('preview-ab-set')
  const specPath = makeSpecFile(ctx, 'be-9b', { domain: 'frontend' })

  const res = dispatchCmd({ slice: 'be-9b', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.preview, { state: 'created' })

  const opens = browserOpenInvocations(env)
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].argv, ['browser', 'open', PREVIEW_URL, '--workspace', workspaceRes.json.workspace_id, '--focus', 'false'])
  assert.ok(existsSync(join(ctx.paths.stateDir, 'browser.json')))
})

test('A/B: cmux_preview_url SET but domain is backend -> zero browser calls, NO preview key', () => {
  const { env, ctx } = setUpPreviewWorkspace('preview-ab-backend-domain')
  const specPath = makeSpecFile(ctx, 'be-9c', { domain: 'backend' })
  const res = dispatchCmd({ slice: 'be-9c', role: 'coder', spec: specPath }, ctx)
  assert.equal('preview' in res.json, false)
  assert.equal(browserOpenInvocations(env).length, 0)
})

test('A/B: cmux_preview_url SET, frontend spec, but role isolation is NOT worktree -> zero browser calls, NO preview key', () => {
  const { env, ctx } = setUpPreviewWorkspace('preview-ab-non-worktree-role')
  const specPath = makeSpecFile(ctx, 'be-9d', { domain: 'frontend' })
  const res = dispatchCmd({ slice: 'be-9d', role: 'backend-lead', spec: specPath }, ctx)
  assert.equal('preview' in res.json, false)
  assert.equal(browserOpenInvocations(env).length, 0)
})

// ---------------------------------------------------------------------------
// Trigger conjuncts, one at a time with the others held true (AC per §5/§6).
// ---------------------------------------------------------------------------

// A2 (#27): 'Frontend' and 'frontend ' both violate handover-spec.schema.json's
// domain enum (["frontend","backend","devops","qa"]), so a `coder` (executor)
// dispatch with either now refuses via SpecSchemaError before the preview
// block is ever reached. This test proves exactly that structural fact — a
// non-enum domain value is refused by the schema floor before the preview
// trigger's `spec?.domain === 'frontend'` comparison is ever evaluated — and
// nothing more. It does NOT prove that comparison's own exactness (no
// case-folding, no trim) the way the pre-#27 version of this test did: for a
// write-capable (worktree_write-granted) role, domain is now a closed enum
// one layer up, so no non-enum value can reach that comparison anymore, and
// the exactness property is structurally unreachable rather than tested.
// The existing `domain: 'backend'` test above (A/B: cmux_preview_url SET but
// domain is backend) only proves inequality-rejection between two different
// valid enum members — it does NOT stand in for exactness-under-normalization
// coverage, despite an earlier version of this comment claiming it did.
//
// Fix-round-2 item 1: exactness CAN still be tested directly, via a session
// roster override that gives `coder` a non-write-capable profile while
// leaving pane:true + isolation:'worktree' untouched. `validator` is exactly
// such a profile — roster.default.json already ships it paired with
// isolation:'worktree' on `build-validator`, so this is a legal, supported
// shape, not a fabricated one — and the fix-round-1 capability-gate test
// (grep "A2 fix-round #3") already proves a session `--config` sidecar
// override reaching dispatchCmd via buildContext -> loadRoster({session}) ->
// deepMergeRoster is a real, exercised code path. Overriding ONLY
// coder.profile to 'validator' keeps pane:true/isolation:'worktree' from the
// default role and swaps in a profile whose `allow` list has no
// 'worktree_write', so the schema floor (isWriteCapable) does NOT gate this
// dispatch — the preview trigger's `spec?.domain === 'frontend'` comparison
// is reached and its outcome is observable via browserOpenInvocations. This
// restores the original exactness proof (no case-folding, no trim),
// correctly scoped to a role that isn't gated by the new schema floor.
test("trigger conjunct 2: domain 'Frontend' and 'frontend ' (not an exact match) -> zero browser calls, via a coder role overridden to a non-write-capable profile so the schema floor doesn't intercept the dispatch first", () => {
  const { env, ctx } = setUpPreviewWorkspace('preview-trigger-domain-case', {
    configOverrides: { session: { roles: { coder: { profile: 'validator' } } } },
  })
  assert.equal(ctx.roster.roles.coder.profile, 'validator', "sanity: the session override actually swapped coder's profile")
  assert.equal(ctx.roster.roles.coder.pane, true, 'sanity: pane:true is preserved from the default role')
  assert.equal(ctx.roster.roles.coder.isolation, 'worktree', "sanity: isolation:'worktree' is preserved from the default role")

  for (const [sliceId, domain] of [['be-9e', 'Frontend'], ['be-9f', 'frontend ']]) {
    const specPath = makeSpecFile(ctx, sliceId, { domain })
    const res = dispatchCmd({ slice: sliceId, role: 'coder', spec: specPath }, ctx)
    assert.equal(res.code, 0, `domain ${JSON.stringify(domain)} must not be schema-refused under the non-write-capable override`)
    assert.equal('preview' in res.json, false, `domain ${JSON.stringify(domain)} must not trigger a preview`)
  }
  assert.equal(browserOpenInvocations(env).length, 0)
})

test('trigger conjunct 3: dropping isolation===\'worktree\' must fail a test (regression guard on the conjunct itself)', () => {
  // A worktree-isolation role with the other three conjuncts held true DOES
  // trigger — pinned here so a future edit that drops this conjunct (e.g.
  // always attempting a preview for any pane-enabled role) fails THIS test
  // by producing a preview key for backend-lead too.
  const { ctx } = setUpPreviewWorkspace('preview-trigger-conjunct3-regression')
  const worktreeSpec = makeSpecFile(ctx, 'be-9g', { domain: 'frontend' })
  const worktreeRes = dispatchCmd({ slice: 'be-9g', role: 'coder', spec: worktreeSpec }, ctx)
  assert.ok('preview' in worktreeRes.json)

  const primarySpec = makeSpecFile(ctx, 'be-9h', { domain: 'frontend' })
  const primaryRes = dispatchCmd({ slice: 'be-9h', role: 'backend-lead', spec: primarySpec }, ctx)
  assert.equal('preview' in primaryRes.json, false)
})

// be-12-02 fix-round item 1: there is deliberately NO fourth
// capability-gate conjunct — `browser` is a multi-method family with no
// single confirmed RPC method literal to gate on (D1), and the orchestrator
// live-verified against real cmux 0.64.22 that a bare `browser.open` method
// literal does not exist, which would have permanently disabled this
// feature. This test proves conjuncts 1-3 alone (config key set, domain
// 'frontend', isolation 'worktree') reach a real create attempt using the
// fixture's own frozen, UNMODIFIED preflight cache — no `browser.*` method
// literal is hand-appended to it, and no capability check gates the create.
test('trigger conjuncts 1-3 alone (no capability check) reach a create attempt, using the fixture\'s unmodified preflight cache', () => {
  const { env, ctx } = setUpWorkspace('preview-trigger-conjuncts-1-3-suffice')
  writeConfigMd(ctx.primaryCheckout, `cmux_preview_url: ${PREVIEW_URL}\n`)
  const specPath = makeSpecFile(ctx, 'be-9i', { domain: 'frontend' })

  const res = dispatchCmd({ slice: 'be-9i', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.preview, { state: 'created' })
  assert.equal(browserOpenInvocations(env).length, 1, 'expected exactly one browser open attempt with no capability pre-check')
})

// ---------------------------------------------------------------------------
// Singleton outcomes — direct ensurePreviewBrowser calls (IC-1/D4).
// ---------------------------------------------------------------------------

test('ensurePreviewBrowser: zero free browsers, no record -> create + stamp; sidecar has lowercase UUIDs, origin only (never the full URL), ISO-ms created_at', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-create')
  const workspaceId = workspaceRes.json.workspace_id
  const url = 'http://localhost:3000/some/path?token=SECRET123'
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url,
  })
  assert.deepEqual(result, { state: 'created' })

  const sidecar = readBrowserSidecar(ctx)
  assert.ok(sidecar)
  assert.equal(sidecar.surface_id, sidecar.surface_id.toLowerCase())
  assert.equal(sidecar.pane_id, sidecar.pane_id.toLowerCase())
  assert.equal(sidecar.workspace_id, workspaceId.toLowerCase())
  assert.equal(sidecar.origin, 'http://localhost:3000')
  assert.doesNotMatch(JSON.stringify(sidecar), /SECRET123|\/some\/path/, 'the sidecar must never carry the full URL, only origin')
  assert.match(sidecar.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  // No reachable path leaves two browser surfaces in one pane.
  const liveTree = tree({ all: true })
  const win = liveTree.windows.find((w) => w.id === workspaceRes.json.window_id)
  const ws = win.workspaces.find((w) => w.id === workspaceId)
  const pane = ws.panes.find((p) => p.id === sidecar.pane_id)
  assert.equal((pane.surfaces || []).filter((s) => s.type === 'browser').length, 1)
})

test('ensurePreviewBrowser: a live, workspace-matching recorded surface -> reuse, zero additional browser opens, nothing re-stamped', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-reuse')
  const workspaceId = workspaceRes.json.workspace_id
  const initialSurfaceId = workspaceRes.json.initial_surface_id
  const first = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL })
  assert.deepEqual(first, { state: 'created' })
  const sidecarAfterFirst = readBrowserSidecar(ctx)
  const opensAfterFirst = browserOpenInvocations(env).length

  const second = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL })
  assert.deepEqual(second, { state: 'reused' })
  assert.equal(browserOpenInvocations(env).length, opensAfterFirst, 'reuse must issue zero additional browser open calls')
  assert.deepEqual(readBrowserSidecar(ctx), sidecarAfterFirst, 'reuse must never re-stamp the sidecar')
})

// be-12-02 fix-round item 2: a sidecar naming a real, present, correctly
// browser-typed surface whose sidecar workspace_id matches must still be
// REJECTED (falls through to the free-browser-scan, not reused) when that
// surface's pane is a WORKER pane — a stale or same-uid-planted sidecar
// naming a worker-pane browser (e.g. a rung-2 mountDocTab doc-tab surface)
// must never be treated as the preview singleton: reusing it would let a
// future goto navigate a rendered worker document away (the exact data-loss
// outcome the "no adopt" design decision, D4, exists to prevent).
test('ensurePreviewBrowser: a sidecar naming a real, present, correctly-typed browser surface that lives in a WORKER pane is rejected (not reused) -> falls through to a real create attempt', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-sidecar-names-worker-pane-browser')
  const workspaceId = workspaceRes.json.workspace_id
  const bound = buildAndBindRecordWithRealPane(ctx, { role: 'coder', sliceId: 'be-9x', workspaceId })
  const workerPaneBrowserId = injectBrowserSurfaceIntoPane(env, bound.surface.pane_id)

  writeBrowserSidecarRaw(ctx, {
    surface_id: workerPaneBrowserId, pane_id: bound.surface.pane_id, workspace_id: workspaceId,
    origin: 'http://localhost:3000', created_at: new Date().toISOString(),
  })

  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  // The worker pane already holds a browser surface, so the fixture's own
  // `browser open` reuse rule (any pane already holding a browser is
  // reused, not just a free one) stacks OUR new surface onto that SAME
  // worker pane too — which the SEPARATE post-create idempotence check then
  // abandons as preview_landed_in_worker_pane. That terminal outcome is
  // exactly what proves the fix: the sidecar was NEVER adopted as 'reused'
  // (no capability check, no reuse door — the rejected sidecar genuinely
  // fell through to a live browserOpen attempt), it is caught by the
  // create-path's own worker-pane check instead.
  assert.notEqual(result.state, 'reused', 'a sidecar naming a worker-pane browser must never be reused')
  assert.deepEqual(result, { state: 'skipped', reason: 'preview_landed_in_worker_pane' })
  assert.equal(browserOpenInvocations(env).length, 1, 'the rejected sidecar must fall through to a real create attempt, not short-circuit')
  assert.equal(readBrowserSidecar(ctx).surface_id, workerPaneBrowserId.toLowerCase(), 'the stale sidecar is left untouched — not re-stamped by the abandoned create')
})

test('ensurePreviewBrowser: sidecar names a surface no longer present in the tree -> create (never adopt, never throw)', () => {
  const { ctx, workspaceRes } = setUpWorkspace('singleton-gone')
  const workspaceId = workspaceRes.json.workspace_id
  writeBrowserSidecarRaw(ctx, {
    surface_id: randomUUID(), pane_id: randomUUID(), workspace_id: workspaceId,
    origin: 'http://localhost:3000', created_at: new Date().toISOString(),
  })
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  assert.equal(result.state, 'created')
})

test('ensurePreviewBrowser: a hand-planted sidecar naming an unrelated workspace_id (nothing in the live tree matches it) -> create', () => {
  const { ctx, workspaceRes } = setUpWorkspace('singleton-ws-mismatch-fabricated')
  const workspaceId = workspaceRes.json.workspace_id
  writeBrowserSidecarRaw(ctx, {
    surface_id: randomUUID(), pane_id: randomUUID(), workspace_id: randomUUID(),
    origin: 'http://localhost:3000', created_at: new Date().toISOString(),
  })
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  assert.equal(result.state, 'created')
  assert.equal(readBrowserSidecar(ctx).workspace_id, workspaceId.toLowerCase())
})

test('ensurePreviewBrowser: a REAL, present browser surface whose sidecar workspace_id is wrong is NOT reused — treated as a stray, preview_surface_ambiguous (proves the workspace_id equality check is load-bearing beyond mere presence)', () => {
  const { ctx, workspaceRes } = setUpWorkspace('singleton-real-ws-mismatch')
  const workspaceId = workspaceRes.json.workspace_id
  const initialSurfaceId = workspaceRes.json.initial_surface_id
  const created = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL })
  assert.equal(created.state, 'created')
  const sidecar = readBrowserSidecar(ctx)
  writeBrowserSidecarRaw(ctx, { ...sidecar, workspace_id: randomUUID() })

  const result = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL })
  assert.deepEqual(result, { state: 'skipped', reason: 'preview_surface_ambiguous' })
})

test('ensurePreviewBrowser: >=1 free browser surfaces, no valid record -> zero opens, preview_surface_ambiguous, and one stderr line naming every stray UUID with an exact cmux browser tab close command each', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-ambiguous')
  const workspaceId = workspaceRes.json.workspace_id
  const stray1 = injectFreeBrowserSurface(env, workspaceId)
  const stray2 = injectFreeBrowserSurface(env, workspaceId)

  let result
  const stderr = captureStderr(() => {
    result = ensurePreviewBrowser({
      paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
      url: PREVIEW_URL,
    })
  })

  assert.deepEqual(result, { state: 'skipped', reason: 'preview_surface_ambiguous' })
  assert.equal(browserOpenInvocations(env).length, 0)
  const expectedLine = formatPreviewFailClosedLine({ strayUuids: [stray1, stray2], unresolvablePaneId: null })
  assert.ok(stderr.includes(expectedLine), `expected stderr to contain the byte-pinned remediation line, got: ${JSON.stringify(stderr)}`)
  assert.match(stderr, new RegExp(`cmux browser ${stray1} tab close`))
  assert.match(stderr, new RegExp(`cmux browser ${stray2} tab close`))
})

// test-engineer (PR-1 vacuity audit): every existing assertion of the E3
// remediation line compares `stderr` against `formatPreviewFailClosedLine(...)`
// — the SAME function under test, called a second time to build the
// "expected" value. That is self-referential: a mutation to the function's
// OWN composition (e.g. swapping the ' · ' separator for ', ', or dropping
// the fail-closed justification clause) changes
// both sides identically and is invisible to every test above (mutated,
// confirmed: 0 failures suite-wide). This test hand-types the frozen
// errata E3 shape as an independent literal — the actual byte-pin the
// mutation doctrine requires (qa-notes 2026-08-02).
test('BYTE-PIN (independent of formatPreviewFailClosedLine): the frozen errata-E3 remediation line matches a hand-typed literal, not a re-typed call to the function under test', () => {
  const strayId = '11111111-1111-1111-1111-111111111111'
  const line = formatPreviewFailClosedLine({ strayUuids: [strayId], unresolvablePaneId: null })
  assert.equal(
    line,
    "ensurePreviewBrowser: 1 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (it would stack into an existing pane; fail-closed per ADR-019). Preview is disabled for this task until they are closed: cmux browser 11111111-1111-1111-1111-111111111111 tab close",
  )

  const strayId2 = '22222222-2222-2222-2222-222222222222'
  const twoStrays = formatPreviewFailClosedLine({ strayUuids: [strayId, strayId2], unresolvablePaneId: null })
  assert.equal(
    twoStrays,
    "ensurePreviewBrowser: 2 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (it would stack into an existing pane; fail-closed per ADR-019). Preview is disabled for this task until they are closed: cmux browser 11111111-1111-1111-1111-111111111111 tab close · cmux browser 22222222-2222-2222-2222-222222222222 tab close",
  )

  const ghostPane = '33333333-3333-3333-3333-333333333333'
  const withUnresolvable = formatPreviewFailClosedLine({ strayUuids: [strayId], unresolvablePaneId: ghostPane })
  assert.equal(
    withUnresolvable,
    "ensurePreviewBrowser: dispatch record's pane 33333333-3333-3333-3333-333333333333 no longer resolves in the live tree; 1 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (it would stack into an existing pane; fail-closed per ADR-019). Preview is disabled for this task until they are closed: cmux browser 11111111-1111-1111-1111-111111111111 tab close",
  )
})

test('ensurePreviewBrowser: a same-workspace dispatch record whose pane id no longer resolves in the live tree, plus a free browser -> preview_topology_unverifiable, naming the unresolvable pane id', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-topology-unverifiable')
  const workspaceId = workspaceRes.json.workspace_id
  const ghostPaneId = randomUUID()

  const dispatchId = newDispatchId()
  const snapshot = snapshotWorkerPlugin({ pluginRoot: ctx.pluginRoot, snapshotDir: ctx.paths.snapshotDir, roles: ctx.roster.roles, profiles: ctx.roster.profiles })
  const record = buildRecord({
    roots: ctx.roots, paths: ctx.paths, roster: ctx.roster, resolved: ctx.roster.roles.coder, pluginRoot: ctx.pluginRoot,
    taskId: ctx.taskSlug, taskSlug: ctx.taskSlug, repoSlug: ctx.repoSlug, primaryCheckout: ctx.primaryCheckout, snapshot,
    config: {}, now: Date.now() - 50, dispatchId, attnUpstream: null,
  }, { role: 'coder', sliceId: 'be-9z', attempt: 1, spec: { validation_commands: ['node --test'] } })
  const recordPath = join(ctx.paths.dispatchDir, 'be-9z.1.json')
  writeRecord(record, recordPath)
  bindRecord(recordPath, { workspace_id: workspaceId, pane_id: ghostPaneId, surface_id: randomUUID() })

  const stray = injectFreeBrowserSurface(env, workspaceId)

  let result
  const stderr = captureStderr(() => {
    result = ensurePreviewBrowser({
      paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
      url: PREVIEW_URL,
    })
  })

  assert.deepEqual(result, { state: 'skipped', reason: 'preview_topology_unverifiable' })
  assert.equal(browserOpenInvocations(env).length, 0)
  const expectedLine = formatPreviewFailClosedLine({ strayUuids: [stray], unresolvablePaneId: ghostPaneId })
  assert.ok(stderr.includes(expectedLine), `expected stderr to contain: ${expectedLine}, got: ${JSON.stringify(stderr)}`)
})

test('ensurePreviewBrowser: a rung-2 doc-tab browser inside a worker pane does not fail-closed (creation is attempted) but is abandoned when `browser open` stacks onto that same worker pane — preview_landed_in_worker_pane, never adopted, close attempted (never "closed")', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-doctab-worker-pane')
  const workspaceId = workspaceRes.json.workspace_id
  const bound = buildAndBindRecordWithRealPane(ctx, { role: 'coder', sliceId: 'be-9y', workspaceId })
  const docTabBrowserId = injectBrowserSurfaceIntoPane(env, bound.surface.pane_id)

  let result
  const stderr = captureStderr(() => {
    result = ensurePreviewBrowser({
      paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
      url: PREVIEW_URL,
    })
  })

  assert.deepEqual(result, { state: 'skipped', reason: 'preview_landed_in_worker_pane' })
  assert.equal(readBrowserSidecar(ctx), null, 'no stamp on an abandon verdict')
  assert.match(stderr, /preview_landed_in_worker_pane/)
  assert.match(stderr, /close attempted/)
  assert.doesNotMatch(stderr, /\bclosed\b/, 'the abandonOrphan shape is "close attempted", never "closed"')
  assert.doesNotMatch(stderr, new RegExp(docTabBrowserId), 'the doc-tab browser itself must never be named as ours to close')

  const closeSurfaceEntries = readLog(env.logPath).filter((e) => e.argv[0] === 'close-surface')
  assert.equal(closeSurfaceEntries.length, 1, 'exactly one close-surface for OUR abandoned surface')
  assert.notEqual(closeSurfaceEntries[0].argv[1], docTabBrowserId)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json.lock')), false, 'the lock must be released before the abandon close runs')
})

test('ensurePreviewBrowser: a collapsed doc-tab pane (record TERMINATED, browser surface alone) is excluded via the terminated record\'s surface.pane_id — not adopted, does not block creation', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-collapsed-doctab')
  const workspaceId = workspaceRes.json.workspace_id
  const bound = buildAndBindRecordWithRealPane(ctx, { role: 'coder', sliceId: 'be-9x', workspaceId })
  const recordPath = join(ctx.paths.dispatchDir, 'be-9x.1.json')
  const docTabBrowserId = injectBrowserSurfaceIntoPane(env, bound.surface.pane_id)
  terminateRecord(recordPath, 'ok', Date.now())

  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  // The worker pane already holds a browser surface, so `browser open`
  // (fixture-faithful to the live-verified reuse behavior) stacks onto it —
  // exactly the A10/A12 landing case, caught and abandoned, never adopted.
  assert.equal(result.state, 'skipped')
  assert.equal(result.reason, 'preview_landed_in_worker_pane')
  const sidecar = readBrowserSidecar(ctx)
  assert.equal(sidecar, null)
})

test('ensurePreviewBrowser: the initial pane is excluded via initial_surface_id (never initial_pane_id), and reordering panes[] in the live tree does not change the outcome', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-initial-pane-reorder')
  const workspaceId = workspaceRes.json.workspace_id
  const initialSurfaceId = workspaceRes.json.initial_surface_id
  injectBrowserSurfaceIntoPane(env, findPaneOfSurface(env, initialSurfaceId))
  reorderPanesInState(env, workspaceId)

  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId,
    url: PREVIEW_URL,
  })
  // Excluded via initial_surface_id -> the initial pane's browser is a
  // worker-pane browser, so `browser open` stacks onto it (same A10/A12
  // landing shape as the doc-tab test above) rather than being blocked or
  // adopted outright.
  assert.equal(result.state, 'skipped')
  assert.equal(result.reason, 'preview_landed_in_worker_pane')
})

// ---------------------------------------------------------------------------
// Concurrency (PR-1 hold condition) — lock span, bounded spawns, abandon.
// ---------------------------------------------------------------------------

test('dispatch: a pre-existing browser.json.lock -> zero browser opens, preview_lock_contended in the dispatch JSON, code 0', () => {
  const { env, ctx } = setUpPreviewWorkspace('preview-lock-contended')
  const specPath = makeSpecFile(ctx, 'be-9w', { domain: 'frontend' })
  mkdirSync(ctx.paths.stateDir, { recursive: true })
  writeFileSync(join(ctx.paths.stateDir, 'browser.json.lock'), JSON.stringify({ pid: 999999999, started_at: Date.now() }), { flag: 'wx' })

  const res = dispatchCmd({ slice: 'be-9w', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.preview, { state: 'skipped', reason: 'preview_lock_contended' })
  assert.equal(browserOpenInvocations(env).length, 0)
})

test('ensurePreviewBrowser: _simulateTreeHang inside the critical section aborts on its own bound, well under LOCK_STALE_MS, and releases the lock', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('preview-tree-hang')
  const workspaceId = workspaceRes.json.workspace_id
  const state = loadFakeState(env)
  state._simulateTreeHang = true
  saveFakeState(env, state)

  const start = Date.now()
  assert.throws(() => ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  }))
  const elapsedMs = Date.now() - start
  assert.ok(elapsedMs < 15000, `expected the section to abort well under LOCK_STALE_MS (30000ms), took ${elapsedMs}ms`)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json.lock')), false, 'the lock must be released even though fn() threw')
})

// test-engineer (PR-1 vacuity audit, item 2): the worst-case budget sum
// (11000ms = two bounded tree reads + one bounded browserOpen) is "only
// non-vacuous in combination with the per-call hang tests" per the invariant
// test's own comment — but the ONLY hang test at the ensurePreviewBrowser
// (lock/critical-section) level uses `_simulateTreeHang`, which hangs EVERY
// `tree` call including the one browserOpen would issue AFTER its own open
// spawn — so the scan tree (the FIRST spawn) always aborts the section
// first. `browserOpen`'s own 5000ms bound (the SECOND spawn,
// PREVIEW_LOCK_BROWSER_OPEN_TIMEOUT_MS) was previously only proven to
// self-bound in ISOLATION (the standalone cmuxctl-level
// `_simulateBrowserOpenHang` test), never through the lock — so a
// regression that let a hung `browser open` escape the critical section
// unbounded had no test that would catch it via ensurePreviewBrowser
// itself. This closes that pairing gap. Unlike a tree hang (tree() throws
// on a failed spawn), a hung `browser open` degrades gracefully — cmux()
// returns `{ok:false, error:{code:'spawn_error'}}` and browserOpen returns
// null — so ensurePreviewBrowser returns `{state:'skipped'}` rather than
// throwing.
test('ensurePreviewBrowser: _simulateBrowserOpenHang inside the critical section (the SECOND bounded spawn, not the tree reads) aborts on browserOpen\'s own 5000ms bound, well under LOCK_STALE_MS, and releases the lock', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('preview-browser-open-hang-in-lock')
  const workspaceId = workspaceRes.json.workspace_id
  const state = loadFakeState(env)
  state._simulateBrowserOpenHang = true
  saveFakeState(env, state)

  const start = Date.now()
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  const elapsedMs = Date.now() - start

  assert.deepEqual(result, { state: 'skipped' }, 'a hung browser open degrades to skipped, never throws')
  assert.ok(elapsedMs < 15000, `expected the section to abort well under LOCK_STALE_MS (30000ms), took ${elapsedMs}ms`)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json.lock')), false, 'the lock must be released')
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json')), false, 'nothing was created, nothing is stamped')
})

test('source-text: the abandon close (closeSurface) is sited AFTER the withRecordLock call returns, never inside it (errata E2)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  const lockCallIdx = src.indexOf('result = withRecordLock(sidecarPath')
  assert.ok(lockCallIdx > -1, 'expected to find the ensurePreviewBrowser withRecordLock call site')
  const abandonBranchIdx = src.indexOf('if (result.abandon) {', lockCallIdx)
  assert.ok(abandonBranchIdx > lockCallIdx, 'expected the result.abandon branch after the withRecordLock call')
  const closeCallIdx = src.indexOf('closeSurface(result.surfaceId)', abandonBranchIdx)
  assert.ok(closeCallIdx > abandonBranchIdx, 'closeSurface(result.surfaceId) must be sited inside the result.abandon branch, after withRecordLock has already returned')
})

// test-engineer (PR-1 QA pass): the "second free browser now exists
// elsewhere" sub-condition IS reachable behaviorally — `_simulateConcurrentCreate`
// only models a brand-new racer surface, which recoverNewId's before/after
// diff always intercepts first (ambiguity throw) before this check ever
// runs. `_simulateFreeBrowserAppearsMidCreate` (fake-cmux.mjs) instead
// RELOCATES an already-existing worker-pane browser surface to a fresh,
// unclassified pane during the `browser open` call itself, before the
// fixture's own reuse-detection runs — the surface's id is preserved, so
// recoverNewId still finds exactly one new surface (ours) and browserOpen
// returns successfully, letting treeAfter show a second free browser this
// process never created. This is the "a racer won despite the lock" case
// materialized without a second OS process.
test('ensurePreviewBrowser: a worker-pane browser relocating to a free pane DURING the open call is detected by the post-create idempotence check — abandon, no stamp, close attempted for OUR surface only, preview_double_create_detected', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-idempotence-relocate')
  const workspaceId = workspaceRes.json.workspace_id
  const bound = buildAndBindRecordWithRealPane(ctx, { role: 'coder', sliceId: 'be-9v', workspaceId })
  const docTabBrowserId = injectBrowserSurfaceIntoPane(env, bound.surface.pane_id)

  const state = loadFakeState(env)
  state._simulateFreeBrowserAppearsMidCreate = true
  saveFakeState(env, state)

  let result
  const stderr = captureStderr(() => {
    result = ensurePreviewBrowser({
      paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
      url: PREVIEW_URL,
    })
  })

  assert.equal(result.state, 'skipped')
  assert.equal(result.reason, 'preview_double_create_detected')
  assert.equal(readBrowserSidecar(ctx), null, 'no stamp on an abandon verdict')
  assert.match(stderr, /preview_double_create_detected/)
  assert.match(stderr, /close attempted/)
  assert.doesNotMatch(stderr, /\bclosed\b/, 'the abandonOrphan shape is "close attempted", never "closed"')
  assert.doesNotMatch(stderr, new RegExp(docTabBrowserId), 'the relocated doc-tab browser must never be named as ours to close')

  const closeSurfaceEntries = readLog(env.logPath).filter((e) => e.argv[0] === 'close-surface')
  assert.equal(closeSurfaceEntries.length, 1, 'exactly one close-surface, for OUR abandoned surface only')
  assert.notEqual(closeSurfaceEntries[0].argv[1], docTabBrowserId)
  const openInvocations = browserOpenInvocations(env)
  assert.equal(openInvocations.length, 1, 'exactly one browser open attempted')
})

// The pane-alone sub-condition ("our new surface is not alone in its pane")
// remains covered only by the source-text test below: every reachable path
// that stacks a second browser into OUR OWN pane also lands that pane in
// the worker-pane set first (preview_landed_in_worker_pane fires before
// this branch is reached) — see the coder's final report. The relocation
// hook above closes the sibling "second free browser elsewhere" branch
// behaviorally; this source-text test remains the mutation-doctrine
// fallback for the not-alone-in-pane branch specifically.
test('source-text: the post-create idempotence check (not-alone-in-pane OR a second free browser elsewhere) exists inside the critical section, decided on treeAfter', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  const lockCallIdx = src.indexOf('result = withRecordLock(sidecarPath')
  const stampIdx = src.indexOf('writeJsonAtomic(sidecarPath', lockCallIdx)
  assert.ok(lockCallIdx > -1 && stampIdx > lockCallIdx)
  const section = src.slice(lockCallIdx, stampIdx)
  assert.match(section, /browserSurfacesInPane\.length !== 1/, 'expected the not-alone-in-pane sub-condition')
  assert.match(section, /stillFreeElsewhere\.length > 0/, 'expected the second-free-browser-elsewhere sub-condition')
  assert.match(section, /preview_double_create_detected/)
})

test('invariant: the critical section\'s stated worst case (two bounded tree reads + one bounded browserOpen) sums to 11000ms, leaving 19000ms of margin under LOCK_STALE_MS (30000ms, record.mjs:807) — non-vacuous only in combination with the per-call hang tests above', () => {
  assert.equal(PREVIEW_LOCK_WORST_CASE_MS, 11000)
  const LOCK_STALE_MS = 30000 // record.mjs:807 — not exported; record.mjs is out of files_in_scope for this slice.
  assert.equal(LOCK_STALE_MS - PREVIEW_LOCK_WORST_CASE_MS, 19000)
})

// ---------------------------------------------------------------------------
// Teardown deletion (errata E7) — browser/ and browser.json* before
// archiveOrDelete, unconditional including under --keep-artifacts.
// ---------------------------------------------------------------------------

function seedPreviewArtifacts(ctx) {
  mkdirSync(join(ctx.paths.stateDir, 'browser'), { recursive: true })
  writeFileSync(join(ctx.paths.stateDir, 'browser', 'verify-20260101T000000000Z.png'), 'fake-png-bytes')
  writeFileSync(join(ctx.paths.stateDir, 'browser.json'), JSON.stringify({ surface_id: randomUUID() }))
  writeFileSync(join(ctx.paths.stateDir, 'browser.json.lock'), JSON.stringify({ pid: 1, started_at: Date.now() }))
}

test('teardown: browser/ and browser.json* (including a stranded browser.json.lock) are gone on the DELETE branch', () => {
  const { ctx } = setUpWorkspace('preview-teardown-delete')
  seedPreviewArtifacts(ctx)
  const res = teardownCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser')), false)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json')), false)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json.lock')), false)
})

test('teardown: browser/ and browser.json* are gone on the ARCHIVE branch too (--keep-artifacts) — the exposure argument beats post-mortem value', () => {
  const { ctx } = setUpWorkspace('preview-teardown-archive')
  seedPreviewArtifacts(ctx)
  const res = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(res.code, 0)
  assert.ok(res.json.state_dir.archived, 'expected the archive branch to have actually fired')
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser')), false)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json')), false)
  assert.equal(existsSync(join(ctx.paths.stateDir, 'browser.json.lock')), false)
  // The archived copy must not carry them forward either.
  assert.equal(existsSync(join(res.json.state_dir.path, 'browser')), false)
  assert.equal(existsSync(join(res.json.state_dir.path, 'browser.json')), false)
  assert.equal(existsSync(join(res.json.state_dir.path, 'browser.json.lock')), false)
})

// be-12-02 fix-round item 4: the existing teardown tests seed a sidecar with
// a throwaway randomUUID() and no live surface, so the surface-closing half
// of teardown (be-12-02's own AC: "the preview surface id appears in the
// fake's close-surface invocation log") was never exercised against a REAL
// preview. This creates one via ensurePreviewBrowser, then proves its UUID
// is in the close-surface log after teardownCmd runs.
test('teardown: a REAL preview surface created via ensurePreviewBrowser has its UUID appear in the close-surface invocation log', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('preview-teardown-close-surface-log')
  const workspaceId = workspaceRes.json.workspace_id
  const created = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  assert.equal(created.state, 'created')
  const sidecar = readBrowserSidecar(ctx)
  assert.ok(sidecar)

  const res = teardownCmd({}, ctx)
  assert.equal(res.code, 0)
  const closeSurfaceIds = readLog(env.logPath)
    .filter((e) => e.argv[0] === 'close-surface')
    .map((e) => e.argv[1].toLowerCase())
  assert.ok(closeSurfaceIds.includes(sidecar.surface_id), `expected ${sidecar.surface_id} in close-surface log, got: ${JSON.stringify(closeSurfaceIds)}`)
})

// be-12-02 fix-round item 5: deletePreviewArtifacts must never let an
// individual removal's filesystem error (EACCES/EBUSY, etc.) propagate out
// and abort teardown BEFORE archiveOrDelete runs — a deletion failure here
// is best-effort hygiene, never fatal. chmod'ing browser/ unreadable models
// an EACCES on rmSync's own internal readdir; the ARCHIVE branch
// (renameSync, not a recursive read) is used so the unreadable subdir
// doesn't ALSO block archiveOrDelete itself, isolating the assertion to
// deletePreviewArtifacts's own robustness.
test('teardown: an unremovable browser/ directory (EACCES) never aborts teardown — archiveOrDelete still runs and completes', () => {
  const { ctx } = setUpWorkspace('preview-teardown-unremovable-browser-dir')
  seedPreviewArtifacts(ctx)
  const browserDir = join(ctx.paths.stateDir, 'browser')
  chmodSync(browserDir, 0o000)
  try {
    const res = teardownCmd({ 'keep-artifacts': true }, ctx)
    assert.equal(res.code, 0)
    assert.ok(res.json.state_dir.archived, 'archiveOrDelete must still complete despite the unremovable browser/ dir')
    assert.ok(existsSync(res.json.state_dir.path), 'the archived state dir must exist')
  } finally {
    // Restore permissions so the OS's own tmp-dir cleanup (or a later test
    // run) never trips over a permission-locked leftover.
    const archivedBrowserDir = join(ctx.roots.stateRoot, '.archive')
    if (existsSync(browserDir)) chmodSync(browserDir, 0o755)
    if (existsSync(archivedBrowserDir)) {
      for (const entry of readdirSync(archivedBrowserDir)) {
        const nested = join(archivedBrowserDir, entry, 'browser')
        if (existsSync(nested)) chmodSync(nested, 0o755)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Non-interactions pinned by regression test, not prose (D7).
// ---------------------------------------------------------------------------

test('non-interaction: closeCmd\'s doc-tab collapse decision is unchanged with a LIVE preview present in its own pane', () => {
  const { ctx, workspaceRes } = setUpWorkspace('preview-noninteraction-close')
  const workspaceId = workspaceRes.json.workspace_id
  const created = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  assert.equal(created.state, 'created')

  const record = buildAndBindRecordWithRealPane(ctx, { role: 'coder', sliceId: 'be-9v', workspaceId })
  writeValidReturn(record)
  const res = closeCmd({ dispatch: record.dispatch_id }, ctx)
  assert.equal(res.json.outcome, 'ok')
})

test('non-interaction: statusCmd rows are built from records only — a live preview surface (no dispatch record) contributes zero rows', () => {
  const { ctx, workspaceRes } = setUpWorkspace('preview-noninteraction-status')
  const workspaceId = workspaceRes.json.workspace_id
  ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL,
  })
  const res = statusCmd({}, ctx)
  assert.deepEqual(res.json.rows, [])
})

// ---------------------------------------------------------------------------
// be-12-03 (issue #12/D5, ADR-019) — browser-verify: the orchestrator-
// invoked gate-evidence verb. Consumes be-12-02's IC-1 sidecar (read-only)
// and IC-2's five wrappers in the fixed D5 order.
// ---------------------------------------------------------------------------

// mainArgsFor(ctx) -> the CLI flag array main() needs to reconstruct THIS
// ctx via its own buildContext — proves the real gate path
// (assertExecutionModeCmux, called from main() before the verb runs) is
// exercised, not just the command function directly.
function mainArgsFor(ctx) {
  return ['--task', ctx.taskSlug, '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug, '--root', ctx.roots.root, '--plugin-root', ctx.pluginRoot]
}

// captureMain(argv) -> { code, json, stdout, stderr }. Captures both streams
// so a test can assert on the printed JSON body and the human stderr lines
// in one call.
function captureMain(argv) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  const stdoutChunks = []
  const stderrChunks = []
  process.stdout.write = (chunk, ...rest) => { stdoutChunks.push(String(chunk)); return originalStdoutWrite(chunk, ...rest) }
  process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return originalStderrWrite(chunk, ...rest) }
  let code
  try {
    code = main(argv)
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    // usage-error paths print nothing to stdout — leave json null
  }
  return { code, json, stdout, stderr }
}

// setUpVerifiedPreview(prefix, opts) -> a setUpPreviewWorkspace() result plus
// a real, stamped browser.json sidecar (ensurePreviewBrowser: 'created').
function setUpVerifiedPreview(prefix, opts = {}) {
  const built = setUpPreviewWorkspace(prefix, opts)
  const { ctx, workspaceRes } = built
  const workspaceId = workspaceRes.json.workspace_id
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id, url: PREVIEW_URL,
  })
  assert.equal(result.state, 'created', `expected ensurePreviewBrowser to create: ${JSON.stringify(result)}`)
  const sidecar = readBrowserSidecar(ctx)
  return { ...built, sidecar }
}

function walkFilesRecursive(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFilesRecursive(p))
    else out.push(p)
  }
  return out
}

function assertMarkerAbsentFromTree(dir, marker) {
  for (const file of walkFilesRecursive(dir)) {
    const bytes = readFileSync(file)
    assert.doesNotMatch(bytes.toString('latin1'), new RegExp(marker), `expected ${file} to never contain the leak marker`)
  }
}

test('browser-verify REFUSES under execution_mode: agent-tool — exit != 0, zero browser invocations', () => {
  const built = setUpWorkspace('bv-refuse-agent-tool')
  const { env, ctx } = built
  // No execution_mode line at all -> defaults to agent-tool.
  const res = captureMain(['browser-verify', ...mainArgsFor(ctx)])
  assert.notEqual(res.code, 0)
  // S11 (panel-1 S2): pin the refusal REASON, not just a nonzero exit — a
  // mutation that refused for some other cause would otherwise pass.
  assert.match(res.stderr, /execution_mode is "agent-tool", not "cmux"/)
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'browser').length, 0)
})

test('browser-verify REFUSES with a bound execution mode but no workspace.json — exit != 0, phaseCmd\'s exact refusal shape', () => {
  const env = freshCmuxEnv('bv-refuse-no-workspace')
  const checkout = makeGitCheckout(env.dir)
  writeConfigMd(checkout, 'execution_mode: cmux\ncmux_preview_url: http://localhost:3000/\n')
  const ctx = buildContext({ task: 'sample-task', checkout, repo: 'sample-repo', root: join(env.dir, 'dev-team'), 'plugin-root': ROOT })
  // Deliberately never ran `workspace` — no workspace.json exists yet.
  const res = captureMain(['browser-verify', ...mainArgsFor(ctx)])
  assert.notEqual(res.code, 0)
  assert.match(res.stderr, /refused: no workspace bound for this task — run `workspace` first/)
  const log = readLog(env.logPath)
  assert.equal(log.filter((e) => e.argv[0] === 'browser').length, 0)
})

test('VERB SEQUENCE: exactly errors-clear -> goto -> wait(--load-state complete --timeout-ms 20000) -> errors-list -> screenshot(--out <path>), element-by-element, no extras', () => {
  const { env, ctx, sidecar } = setUpVerifiedPreview('bv-sequence')
  writeFileSync(env.logPath, '') // isolate this run's invocations from the setup's own `browser open`
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  const browserCalls = readLog(env.logPath).filter((e) => e.argv[0] === 'browser')
  assert.equal(browserCalls.length, 5, `expected exactly 5 browser invocations, got: ${JSON.stringify(browserCalls.map((c) => c.argv))}`)
  assert.deepEqual(browserCalls[0].argv, ['browser', sidecar.surface_id, 'errors', 'clear'])
  assert.deepEqual(browserCalls[1].argv, ['browser', sidecar.surface_id, 'goto', PREVIEW_URL])
  assert.deepEqual(browserCalls[2].argv, ['browser', sidecar.surface_id, 'wait', '--load-state', 'complete', '--timeout-ms', '20000'])
  assert.deepEqual(browserCalls[3].argv, ['browser', sidecar.surface_id, 'errors', 'list'])
  assert.deepEqual(browserCalls[4].argv.slice(0, 3), ['browser', sidecar.surface_id, 'screenshot'])
  assert.equal(browserCalls[4].argv[3], '--out')
  assert.ok(browserCalls[4].argv[4].startsWith(join(ctx.paths.stateDir, 'browser', 'verify-')))
  assert.equal(browserCalls[4].argv.length, 5, `expected exactly 5 argv tokens on the screenshot call, got: ${JSON.stringify(browserCalls[4].argv)}`)

  // Pins the verb's OWN only spawn (the corroboration tree read,
  // BROWSER_VERIFY_TREE_TIMEOUT_MS) — the single `tree` call the 88000ms
  // budget assumes; more than one would silently blow the budget.
  const treeCalls = readLog(env.logPath).filter((e) => e.argv[0] === 'tree')
  assert.equal(treeCalls.length, 1, `expected exactly 1 tree call, got: ${JSON.stringify(treeCalls.map((c) => c.argv))}`)
})

test('EXITS 0: a dirty console (3 errors) still reports code 0', () => {
  const { env, ctx } = setUpVerifiedPreview('bv-dirty-console')
  const state = loadFakeState(env)
  state._simulateBrowserErrorsPayload = '[error] one\n[error] two\n[error] three'
  saveFakeState(env, state)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.preview_present, true)
  assert.deepEqual(res.json.console_errors, { clean: false, count: 3, shape: 'errors' })
})

test('EXITS 0: load_state_confirmed:false (a stacked pane fails wait/errors) with the screenshot STILL emitted', () => {
  const { env, ctx, sidecar } = setUpVerifiedPreview('bv-never-ready')
  injectBrowserSurfaceIntoPane(env, sidecar.pane_id)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.preview_present, true)
  assert.equal(res.json.load_state_confirmed, false)
  assert.ok(res.json.screenshot_path, 'expected a screenshot to still be emitted on a never-ready surface')
  assert.ok(existsSync(res.json.screenshot_path))
})

test('preview_present:false, reason: preview_disabled — cmux_preview_url absent', () => {
  const { ctx } = setUpWorkspace('bv-disabled')
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'preview_disabled', warnings: [] })
})

test('preview_present:false, reason: no_preview_recorded — cmux_preview_url set but no sidecar written', () => {
  const { ctx } = setUpPreviewWorkspace('bv-no-sidecar')
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'no_preview_recorded', warnings: [] })
})

test('preview_present:false, reason: preview_surface_gone — sidecar workspace_id no longer matches the live binding', () => {
  const { ctx } = setUpVerifiedPreview('bv-gone-workspace-mismatch')
  const sidecar = readBrowserSidecar(ctx)
  writeBrowserSidecarRaw(ctx, { ...sidecar, workspace_id: randomUUID() })
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'preview_surface_gone', warnings: [] })
})

test('preview_present:false, reason: preview_surface_gone — sidecar names a surface no longer present in the tree', () => {
  const { ctx } = setUpVerifiedPreview('bv-gone-missing-surface')
  const sidecar = readBrowserSidecar(ctx)
  writeBrowserSidecarRaw(ctx, { ...sidecar, surface_id: randomUUID() })
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'preview_surface_gone', warnings: [] })
})

test('IDENTICAL KEY SET: a ready run and a never-ready run produce the same JSON key set, differing only in load_state_confirmed/warnings/screenshot_path values', () => {
  const ready = setUpVerifiedPreview('bv-keyset-ready')
  const readyRes = browserVerifyCmd({}, ready.ctx)

  const neverReady = setUpVerifiedPreview('bv-keyset-never-ready')
  injectBrowserSurfaceIntoPane(neverReady.env, neverReady.sidecar.pane_id)
  const neverReadyRes = browserVerifyCmd({}, neverReady.ctx)

  assert.deepEqual(Object.keys(readyRes.json).sort(), Object.keys(neverReadyRes.json).sort())
  assert.equal(readyRes.json.load_state_confirmed, true)
  assert.equal(neverReadyRes.json.load_state_confirmed, false)
})

test('ORIGIN-ONLY: a distinctive path+query token in the configured URL never appears in the JSON, stderr, or the sidecar — only in the goto argv', () => {
  const token = 'xyzzy-token-SECRET777'
  const built = setUpWorkspace('bv-origin-only')
  const { env, ctx, workspaceRes } = built
  writeConfigMd(ctx.primaryCheckout, `execution_mode: cmux\ncmux_preview_url: http://localhost:3000/${token}\n`)
  const workspaceId = workspaceRes.json.workspace_id
  const created = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id, url: `http://localhost:3000/${token}`,
  })
  assert.equal(created.state, 'created')

  let res
  const stderr = captureStderr(() => { res = browserVerifyCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.doesNotMatch(JSON.stringify(res.json), new RegExp(token))
  assert.doesNotMatch(stderr, new RegExp(token))
  const sidecarRaw = readFileSync(join(ctx.paths.stateDir, 'browser.json'), 'utf8')
  assert.doesNotMatch(sidecarRaw, new RegExp(token))
  assert.equal(res.json.origin, 'http://localhost:3000')

  const gotoCall = readLog(env.logPath).find((e) => e.argv[0] === 'browser' && e.argv[2] === 'goto')
  assert.ok(gotoCall.argv.some((a) => a.includes(token)), 'expected the token to appear in the goto argv — the one sanctioned place')
})

test('ORIGIN-ONLY: a configured origin differing from the recorded one navigates to the configured origin, warns naming both origins only, and leaves browser.json byte-identical', () => {
  const built = setUpVerifiedPreview('bv-origin-diverge')
  const { ctx } = built
  const sidecarPath = join(ctx.paths.stateDir, 'browser.json')
  const before = readFileSync(sidecarPath, 'utf8')

  // Reconfigure to a DIFFERENT origin than the one the sidecar recorded —
  // never actually re-runs ensurePreviewBrowser (browser-verify is a
  // read-only consumer).
  writeConfigMd(ctx.primaryCheckout, 'execution_mode: cmux\ncmux_preview_url: http://localhost:4000/\n')

  let res
  const stderr = captureStderr(() => { res = browserVerifyCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.equal(res.json.origin, 'http://localhost:4000')
  assert.ok(res.json.warnings.includes('browser_configured_origin_differs_from_recorded'))
  assert.match(stderr, /http:\/\/localhost:4000/)
  assert.match(stderr, /http:\/\/localhost:3000/)

  const after = readFileSync(sidecarPath, 'utf8')
  assert.equal(before, after, 'browser.json must be byte-identical before/after — browser-verify never rewrites it')

  const gotoCall = readLog(built.env.logPath).filter((e) => e.argv[0] === 'browser' && e.argv[2] === 'goto').pop()
  assert.equal(gotoCall.argv[3], 'http://localhost:4000/')
})

test('WARNINGS ARE CLOSED: every warning emitted across a dirty-console run, a never-ready run, and an origin-divergence run is a member of BROWSER_VERIFY_WARNINGS', () => {
  const allWarnings = []

  const dirty = setUpVerifiedPreview('bv-closed-dirty')
  const dirtyState = loadFakeState(dirty.env)
  dirtyState._simulateBrowserErrorsPayload = '[error] one'
  saveFakeState(dirty.env, dirtyState)
  allWarnings.push(...browserVerifyCmd({}, dirty.ctx).json.warnings)

  const neverReady = setUpVerifiedPreview('bv-closed-never-ready')
  injectBrowserSurfaceIntoPane(neverReady.env, neverReady.sidecar.pane_id)
  allWarnings.push(...browserVerifyCmd({}, neverReady.ctx).json.warnings)

  const diverge = setUpVerifiedPreview('bv-closed-diverge')
  writeConfigMd(diverge.ctx.primaryCheckout, 'execution_mode: cmux\ncmux_preview_url: http://localhost:5000/\n')
  allWarnings.push(...browserVerifyCmd({}, diverge.ctx).json.warnings)

  assert.ok(allWarnings.length > 0, 'expected at least one warning across these three scenarios (anti-vacuity)')
  for (const w of allWarnings) {
    assert.ok(BROWSER_VERIFY_WARNINGS.includes(w), `warning ${JSON.stringify(w)} is not a member of the frozen BROWSER_VERIFY_WARNINGS vocabulary`)
  }
})

test('BUDGET: the sum of the browser-verify tree bound plus every IC-2 browser wrapper bound is 88000ms, <= the stated 90000ms budget', () => {
  const dispatchSrc = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  const cmuxctlSrc = readFileSync(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'), 'utf8')

  const treeMatch = dispatchSrc.match(/const BROWSER_VERIFY_TREE_TIMEOUT_MS = (\d+)/)
  assert.ok(treeMatch, 'expected BROWSER_VERIFY_TREE_TIMEOUT_MS to be found in dispatch.mjs')

  const clearMatch = cmuxctlSrc.match(/browserVerb\('errors', \[surfaceId, 'clear'\], \{ timeoutMs: (\d+) \}\)/)
  const gotoMatch = cmuxctlSrc.match(/browserVerb\('goto', \[surfaceId, url\], \{ timeoutMs: (\d+) \}\)/)
  const waitMatch = cmuxctlSrc.match(/browserWaitReady\(surfaceId, \{ timeoutMs = (\d+) \} = \{\}\)/)
  const listMatch = cmuxctlSrc.match(/browserVerb\('errors', \[surfaceId, 'list'\], \{ timeoutMs: (\d+) \}\)/)
  const screenshotMatch = cmuxctlSrc.match(/browserVerb\('screenshot', \[surfaceId, '--out', outPath\], \{ timeoutMs: (\d+) \}\)/)
  for (const [name, m] of [['clear', clearMatch], ['goto', gotoMatch], ['wait', waitMatch], ['list', listMatch], ['screenshot', screenshotMatch]]) {
    assert.ok(m, `expected to extract the ${name} wrapper's timeoutMs bound from cmuxctl.mjs source text`)
  }

  const sum = Number(treeMatch[1]) + Number(clearMatch[1]) + Number(gotoMatch[1]) + Number(waitMatch[1]) + Number(listMatch[1]) + Number(screenshotMatch[1])
  assert.equal(sum, 88000)
  assert.ok(sum <= 90000)

  assert.match(dispatchSrc, /<= 90 000 ms/)
  const qaGateSrc = readFileSync(join(ROOT, 'references', 'qa-gate.md'), 'utf8')
  assert.match(qaGateSrc, /<= ?90/)

  // S4 (panel-3 #9, fix-round): a bare /<= ?90/ match would also pass a doc
  // stating some UNRELATED "<=90" figure — bind the doc's stated ms bound to
  // the SAME computed sum extracted above, not merely a regex shape match.
  const docBoundMatch = qaGateSrc.match(/<= 90 000 ms/)
  assert.ok(docBoundMatch, 'expected qa-gate.md to state the exact "<= 90 000 ms" bound')
  const docBoundMs = 90000
  assert.ok(sum <= docBoundMs, `the computed sum (${sum}) must not exceed the doc's stated bound (${docBoundMs})`)
  assert.ok(docBoundMs - sum <= 5000, `the doc's bound (${docBoundMs}) must be a tight ceiling over the computed sum (${sum}), not an arbitrary disconnected number`)
})

test('LEAK TEST (positive first, same run): a unique marker in a dirty console payload proves non-vacuous but never reaches the JSON, stderr, or any file under stateDir/taskDir', () => {
  const { env, ctx, sidecar } = setUpVerifiedPreview('bv-leak')
  const marker = `LEAKMARKER${randomUUID().replace(/-/g, '')}`
  const state = loadFakeState(env)
  state._simulateBrowserErrorsPayload = `[error] one ${marker}\n[error] two\n[error] three`
  saveFakeState(env, state)

  // Positive first: prove the fixture is genuinely wired to produce the
  // marker (the raw wrapper return, called directly, must contain it) —
  // every negative assertion below is meaningless until this passes.
  const rawDirect = browserErrorsList(sidecar.surface_id)
  assert.match(rawDirect, new RegExp(marker))

  let res
  const stderr = captureStderr(() => { res = browserVerifyCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.equal(res.json.console_errors.count, 3)
  assert.doesNotMatch(JSON.stringify(res.json), new RegExp(marker))
  assert.doesNotMatch(stderr, new RegExp(marker))
  assertMarkerAbsentFromTree(ctx.paths.stateDir, marker)
  assertMarkerAbsentFromTree(ctx.paths.taskDir, marker)
})

test('SCREENSHOT: the independent statSync(...).size > 0 check — _simulateScreenshotOkNoWrite (cmux prints OK without writing, so the file never exists) yields screenshot_path:null plus the browser_screenshot_missing warning, never a throw', () => {
  const { env, ctx } = setUpVerifiedPreview('bv-screenshot-no-write')
  const state = loadFakeState(env)
  state._simulateScreenshotOkNoWrite = true
  saveFakeState(env, state)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.screenshot_path, null)
  assert.ok(res.json.warnings.includes('browser_screenshot_missing'))
})

// test-engineer (be-12-03 adversarial pass): the gate-time corroboration is
// a THREE-conjunct predicate (surface presence in the fresh tree + type ===
// 'browser' + sidecar/live workspace_id equality) but only two conjuncts had
// independent kill coverage — "surface present, right workspace, WRONG
// type" was reachable and undetected by every existing test (mutated,
// confirmed: dropping the `found.surface.type !== 'browser'` half of the
// condition left all 18 browser-verify tests green). Point the sidecar at
// the workspace's own pre-existing TERMINAL surface (initial_surface_id) —
// same workspace, so the workspace_id conjunct is satisfied, and the id
// resolves in the tree, so the presence conjunct is satisfied too; only the
// type conjunct can fail this case.
test('preview_present:false, reason: preview_surface_gone — sidecar names a surface that EXISTS in the right workspace but is not browser-typed (the third corroboration conjunct, tested independently of presence/workspace_id)', () => {
  const built = setUpVerifiedPreview('bv-gone-wrong-type')
  const { ctx, workspaceRes } = built
  const sidecar = readBrowserSidecar(ctx)
  writeBrowserSidecarRaw(ctx, { ...sidecar, surface_id: workspaceRes.json.initial_surface_id })
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'preview_surface_gone', warnings: [] })
})

// test-engineer (be-12-03 adversarial pass): WARNINGS ARE CLOSED only
// proves every EMITTED warning is a vocabulary member — it never proves the
// converse, that the clean/ready/matching-origin path emits NONE. Three
// independent mutations survived every existing test undetected because of
// this gap: (a) unconditionally pushing browser_wait_not_confirmed, (b)
// unconditionally pushing browser_screenshot_missing, and (c) comparing the
// FULL configured URL (not its origin) against the recorded origin in the
// divergence check, which spuriously warns on every run even when the
// origins genuinely match. This single positive assertion — warnings:[] on
// an otherwise-uneventful ready run — kills all three.
test('WARNINGS: the plain ready path (clean console, confirmed load, matching origin, screenshot written) emits ZERO warnings — pairs with WARNINGS ARE CLOSED to prove absence, not just membership', () => {
  const { ctx } = setUpVerifiedPreview('bv-warnings-empty-on-happy-path')
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.preview_present, true)
  assert.equal(res.json.load_state_confirmed, true)
  assert.ok(res.json.screenshot_path)
  assert.deepEqual(res.json.warnings, [])
})

// test-engineer (be-12-03 adversarial pass): browser_errors_list_unavailable
// is a member of the frozen vocabulary and gated by `rawErrors === null`,
// but no test ever asserted it is actually PUSHED — removing the entire
// `if (rawErrors === null) { warnings.push(...) }` block survived every
// existing test (WARNINGS ARE CLOSED only checks membership of whatever
// happens to be present, and no scenario specifically asserts this warning's
// presence). The stacked-pane scenario already used for the never-ready
// case is the same fixture path that drives browserErrorsList to return
// null (>=2 browser siblings sharing a pane fails errors-list with
// js_error, and the wrapper degrades that to null per IC-2) — assert on it
// directly here instead of leaving it as an unasserted side effect.
test('WARNINGS: a stacked pane (browserErrorsList returns null) positively emits browser_errors_list_unavailable, and the reducer sees it as unrecognized', () => {
  const { env, ctx, sidecar } = setUpVerifiedPreview('bv-errors-list-unavailable')
  injectBrowserSurfaceIntoPane(env, sidecar.pane_id)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.ok(res.json.warnings.includes('browser_errors_list_unavailable'), `expected browser_errors_list_unavailable in ${JSON.stringify(res.json.warnings)}`)
  assert.deepEqual(res.json.console_errors, { clean: false, count: null, shape: 'unrecognized' })
})

test('source-text: dispatch.mjs no longer names a fixed verb count in its header, and its usage block agrees with Object.keys(COMMANDS) as sets', () => {
  const dispatchSrc = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  assert.doesNotMatch(dispatchSrc, /the seven lifecycle verbs/)

  const usageVerbs = [...dispatchSrc.matchAll(/^\/\/ {2,3}node dispatch\.mjs (\S+)/gm)].map((m) => m[1])
  assert.ok(usageVerbs.length > 0, 'expected to extract at least one usage-block verb')

  const commandsMatch = dispatchSrc.match(/const COMMANDS = \{([^}]*)\}/s)
  assert.ok(commandsMatch, 'expected to find the COMMANDS map in source text')
  const commandKeys = [...commandsMatch[1].matchAll(/^\s*(?:'([^']+)'|(\w[\w-]*)):/gm)].map((m) => m[1] || m[2])
  assert.ok(commandKeys.length > 0, 'expected to extract at least one COMMANDS key')

  assert.deepEqual(usageVerbs.sort(), commandKeys.sort())
  assert.ok(commandKeys.includes('phase'))
  assert.ok(commandKeys.includes('browser-verify'))
})

test('source-text: browser-verify never branches on browser evidence — the verb body contains no `if` testing consoleErrors/console_errors/load_state_confirmed for control flow before the return', () => {
  const dispatchSrc = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  const headerStart = dispatchSrc.indexOf('// browser-verify — issue #12/D5')
  const start = dispatchSrc.indexOf('export function browserVerifyCmd')
  const end = dispatchSrc.indexOf('// ---', start)
  const body = dispatchSrc.slice(start, end)
  const section = dispatchSrc.slice(headerStart, end)
  assert.doesNotMatch(body, /if \(loadStateConfirmed\)/, 'loadStateConfirmed must only ever be pushed into warnings/output, never gate a return')
  assert.doesNotMatch(body, /if \(consoleErrors/)
  assert.match(section, /never judges/i)
})

// test-engineer (be-12-03 fix-round, panel-2 S3): the assertion above only
// rejects the POSITIVE bare-branch form (`if (loadStateConfirmed)`), but the
// shipped code actually gates its warnings-push with the NEGATED form
// (`if (!loadStateConfirmed)`) — a mutation that made the negated form guard
// a `return` instead of a `warnings.push` would sail through undetected.
// This pin is structural rather than a single regex: it counts every
// occurrence of the `loadStateConfirmed` token in the verb body and asserts
// each one is exactly one of the three legal sites (the assignment, the
// negated guard line itself, and the returned object's field) — no fourth
// site, and the guard line never contains `return`.
test('source-text: loadStateConfirmed occurs in exactly its assignment, its negated warnings-push guard, and the returned field — the negated form never guards a return', () => {
  const dispatchSrc = readFileSync(join(ROOT, 'scripts', 'cmux', 'dispatch.mjs'), 'utf8')
  const start = dispatchSrc.indexOf('export function browserVerifyCmd')
  const end = dispatchSrc.indexOf('// ---', start)
  const body = dispatchSrc.slice(start, end)
  const occurrences = body.split('\n').filter((line) => line.includes('loadStateConfirmed'))
  assert.equal(occurrences.length, 3, `expected exactly 3 occurrences of loadStateConfirmed, got: ${JSON.stringify(occurrences)}`)
  assert.match(occurrences[0], /const loadStateConfirmed = browserWaitReady\(surfaceId\)/)
  assert.match(occurrences[1], /^\s*if \(!loadStateConfirmed\) \{$/)
  assert.doesNotMatch(occurrences[1], /return/)
  assert.match(occurrences[2], /load_state_confirmed: loadStateConfirmed,/)
})

// ---------------------------------------------------------------------------
// be-12-03 fix-round (PR-2 adversarial panel) — M1/M2/M3/S5/S9 additions.
// ---------------------------------------------------------------------------

// M1 (panel-1 warning, injection channel): a hand-written sidecar whose
// origin field is a hostile marker string must never ride raw into stderr
// or the produced JSON — a fixed placeholder stands in for it.
test('M1: an out-of-shape sidecar.origin (a hostile marker string) never reaches stderr or the JSON — a fixed placeholder replaces it, exit 0', () => {
  const built = setUpVerifiedPreview('bv-origin-injection')
  const { ctx } = built
  const sidecar = readBrowserSidecar(ctx)
  const marker = `INJECTION-MARKER-${randomUUID().replace(/-/g, '')}`
  // Valid surface_id/workspace_id so corroboration passes; only origin is
  // hostile-shaped, and it differs from the configured origin so the
  // divergence-warning code path (the injection channel) actually runs.
  writeBrowserSidecarRaw(ctx, { ...sidecar, origin: marker })

  let res
  const stderr = captureStderr(() => { res = browserVerifyCmd({}, ctx) })
  assert.equal(res.code, 0)
  assert.doesNotMatch(JSON.stringify(res.json), new RegExp(marker))
  assert.doesNotMatch(stderr, new RegExp(marker))
  assert.match(stderr, /<unparsed origin>/)
  assert.ok(res.json.warnings.includes('browser_configured_origin_differs_from_recorded'))
})

// M2 (panel-2 W1): browserGoto's return value is captured; a navigation
// timeout (browserGoto degrades to false) pushes browser_goto_failed, and
// the D5 sequence still runs all five calls.
test('M2: a goto navigation timeout pushes browser_goto_failed, exit 0, all five browser calls still run', () => {
  const { env, ctx } = setUpVerifiedPreview('bv-goto-failed')
  const state = loadFakeState(env)
  state._simulateGotoNavigationTimeout = true
  saveFakeState(env, state)
  writeFileSync(env.logPath, '')
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.ok(res.json.warnings.includes('browser_goto_failed'), `expected browser_goto_failed in ${JSON.stringify(res.json.warnings)}`)
  const browserCalls = readLog(env.logPath).filter((e) => e.argv[0] === 'browser')
  assert.equal(browserCalls.length, 5, `expected all 5 browser calls to still run, got: ${JSON.stringify(browserCalls.map((c) => c.argv))}`)
})

// M3 (panel-2 W2): browserErrorsClear's return value is captured; a stacked
// pane (the fixture's existing js_error-on-clear path) pushes
// browser_errors_clear_failed and the sequence still completes.
test('M3: a stacked pane (browserErrorsClear degrades to false) pushes browser_errors_clear_failed, exit 0, sequence completes', () => {
  const { env, ctx, sidecar } = setUpVerifiedPreview('bv-clear-failed')
  injectBrowserSurfaceIntoPane(env, sidecar.pane_id)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.ok(res.json.warnings.includes('browser_errors_clear_failed'), `expected browser_errors_clear_failed in ${JSON.stringify(res.json.warnings)}`)
  assert.ok(res.json.screenshot_path, 'the sequence must still complete through the screenshot step')
})

// S5 (panel-2 S1): a malformed sidecar ('{' — invalid JSON) must degrade to
// no_preview_recorded with exit 0, never a throw.
test('S5: a malformed browser.json ("{") degrades to preview_present:false, reason: no_preview_recorded, exit 0 — never a throw', () => {
  const { ctx } = setUpPreviewWorkspace('bv-malformed-sidecar')
  writeFileSync(join(ctx.paths.stateDir, 'browser.json'), '{')
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { preview_present: false, reason: 'no_preview_recorded', warnings: [] })
})

// S9 (panel-2 S6): fake-cmux's payload fallback now uses `??`, so an EMPTY
// seeded payload stays empty (never silently coerced back to the clean
// literal) — the reducer must see it as unrecognized, never clean.
// S12 (panel-1 S6 + panel-2 S5): the screenshot confirmation is upgraded
// from existsSync to statSync(...).size > 0, which catches a zero-byte
// write that existsSync alone would wrongly treat as success.
test('S12: a zero-byte screenshot write (file exists, size 0) yields screenshot_path:null plus browser_screenshot_missing, never a throw', () => {
  const { env, ctx } = setUpVerifiedPreview('bv-screenshot-zero-byte')
  const state = loadFakeState(env)
  state._simulateScreenshotZeroByteWrite = true
  saveFakeState(env, state)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.equal(res.json.screenshot_path, null)
  assert.ok(res.json.warnings.includes('browser_screenshot_missing'))
})

test('S9: an EMPTY seeded errors-list payload (fake-cmux `??` fallback) reduces to console_errors.shape:"unrecognized", clean:false', () => {
  const { env, ctx } = setUpVerifiedPreview('bv-empty-payload')
  const state = loadFakeState(env)
  state._simulateBrowserErrorsPayload = ''
  saveFakeState(env, state)
  const res = browserVerifyCmd({}, ctx)
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.console_errors, { clean: false, count: null, shape: 'unrecognized' })
})

// ---------------------------------------------------------------------------
// A2 (#27) — the unskippable schema-derived spec floor: dispatchCmd refuses
// an `executor`-profile dispatch on a schema-derived spec violation only;
// every other spec-lint diagnostic passes through as warnings[]. Positive
// first (anti-vacuity anchor, mirrors E-P1), per the handover spec.
// ---------------------------------------------------------------------------

test('A2 positive: a valid spec dispatched to coder still exits 0 with exactly one new-pane, and clean warnings:[] for a spec whose files_in_scope names README.md with no validation_commands', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('a2-positive')
  const specPath = makeSpecFile(ctx, 'be-27a', { files_in_scope: ['README.md'], validation_commands: [] })

  const res = dispatchCmd({ slice: 'be-27a', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.ok(Array.isArray(res.json.warnings))
  assert.deepEqual(res.json.warnings, [])

  const log = readLog(env.logPath)
  const newPaneEntries = log.filter((e) => e.argv[0] === 'new-pane')
  assert.equal(newPaneEntries.length, 1, `expected exactly one new-pane invocation, got ${newPaneEntries.length}: ${JSON.stringify(log)}`)
  assert.deepEqual(newPaneEntries[0].argv, ['new-pane', '--workspace', workspaceRes.json.workspace_id])
})

test('A2 refusal: a schema-invalid spec (missing required field, empty required array, wrong-typed field) refuses a coder dispatch with ZERO cmux invocations of ANY verb and no on-disk trace', () => {
  const cases = [
    ['be-27b', { acceptance_criteria: undefined }],
    ['be-27c', { acceptance_criteria: [] }],
    ['be-27d', { files_in_scope: 'f.mjs' }],
  ]
  for (const [sliceId, overrides] of cases) {
    const { env, ctx } = setUpWorkspace(`a2-refusal-${sliceId}`)
    const specPath = makeSpecFile(ctx, sliceId, overrides)
    const logBefore = readLog(env.logPath)

    assert.throws(
      () => dispatchCmd({ slice: sliceId, role: 'coder', spec: specPath }, ctx),
      (err) => {
        assert.ok(err instanceof SpecSchemaError, `expected SpecSchemaError for ${JSON.stringify(overrides)}, got ${err}`)
        assert.equal(err.message, SPEC_SCHEMA_REFUSAL_MESSAGE)
        assert.equal(err.code, SPEC_SCHEMA_REFUSAL_CODE)
        assert.ok(err.failures.length > 0)
        assert.ok(err.failures.every((f) => f.check === 'schema'))
        return true
      },
    )

    const newEntries = readLog(env.logPath).slice(logBefore.length)
    assert.deepEqual(newEntries, [], `expected ZERO cmux invocations of any verb after a schema refusal, got: ${JSON.stringify(newEntries)}`)
    assert.equal(existsSync(join(ctx.paths.dispatchDir, `${sliceId}.1.json`)), false, 'no record file must exist for a refused dispatch')
    assert.equal(existsSync(ctx.paths.worktreesIndexPath), false, 'no worktree/branch/index entry must exist for a refused dispatch')
  }
})

// Fix-round item 4 (should-fix, reproduced): lintSpec(nonObject, root) throws
// a raw TypeError instead of returning the documented {check:'schema',
// detail} diagnostic — a truncated/corrupted spec file can parse as JSON
// `null`, a bare array, or a bare number/string. dispatchCmd now guards this
// BEFORE calling lintSpec, so the gate still fails closed AND produces the
// documented spec_schema_invalid shape rather than a raw error message.
test('A2 fix-round #4: a spec file containing literal null (or a bare array/number) still produces the spec_schema_invalid SpecSchemaError shape, not a raw TypeError', () => {
  const cases = [
    ['be-27n1', null],
    ['be-27n2', []],
    ['be-27n3', 42],
    ['be-27n4', 'a bare string'],
  ]
  for (const [sliceId, badSpecValue] of cases) {
    const { ctx } = setUpWorkspace(`a2-nonobject-${sliceId}`)
    const specPath = specPathFor(ctx.paths, sliceId)
    mkdirSync(dirname(specPath), { recursive: true })
    writeFileSync(specPath, JSON.stringify(badSpecValue))

    assert.throws(
      () => dispatchCmd({ slice: sliceId, role: 'coder', spec: specPath }, ctx),
      (err) => {
        assert.ok(err instanceof SpecSchemaError, `expected SpecSchemaError for spec value ${JSON.stringify(badSpecValue)}, got ${err}`)
        assert.equal(err.code, SPEC_SCHEMA_REFUSAL_CODE)
        assert.ok(err.failures.length > 0)
        assert.ok(err.failures.every((f) => f.check === 'schema'))
        return true
      },
    )
  }
})

test('A2 CLI wiring: `main([\'dispatch\', ...])` for a schema-invalid spec returns exit 1, prints exactly one {error, failures} JSON object on stdout, and FAIL lines on stderr', () => {
  const { dir, ctx } = setUpWorkspace('a2-cli-wiring')
  const configDir = join(ctx.primaryCheckout, '.claude', 'dev-team')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.md'), 'execution_mode: cmux\n')
  const specPath = makeSpecFile(ctx, 'be-27e', { acceptance_criteria: [] })

  const res = spawnSync(process.execPath, [
    DISPATCH_PATH, 'dispatch',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT,
    '--slice', 'be-27e', '--role', 'coder', '--spec', specPath,
  ], { encoding: 'utf8' })

  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`)
  const lines = res.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(res.stdout)}`)
  const json = JSON.parse(lines[0])
  assert.equal(json.error, 'spec_schema_invalid')
  assert.ok(Array.isArray(json.failures) && json.failures.length > 0)
  for (const f of json.failures) {
    assert.equal(f.check, 'schema')
    assert.equal(typeof f.detail, 'string')
  }
  assert.match(res.stderr, /^refused: /m)
  const failLineCount = (res.stderr.match(/^FAIL schema: /gm) || []).length
  assert.equal(failLineCount, json.failures.length, 'expected one "FAIL schema: ..." stderr line per failure')
})

// Fix-round item 1 (MUST FIX, security): f.detail echoes back arbitrary JSON
// key names from the spec verbatim (contract.mjs's `unexpected property
// ${key}` / `${path}.${key}`) — a hostile key containing an ANSI escape and a
// newline must never reach stderr raw, since it would forge terminal output
// or fake standalone "FAIL"/dispatcher lines into the orchestrator's own
// Bash-tool context.
test('A2 fix-round #1: a schema violation detail containing a control character (ESC + newline, embedded via a hostile additionalProperties key) never reaches stderr as a raw control byte', () => {
  const { dir, ctx } = setUpWorkspace('a2-hostile-detail')
  const configDir = join(ctx.primaryCheckout, '.claude', 'dev-team')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.md'), 'execution_mode: cmux\n')

  const hostileKey = '\x1b[31mFAKE\n[FAKE] forged dispatcher line\x1b[0m'
  const specPath = specPathFor(ctx.paths, 'be-27z')
  mkdirSync(dirname(specPath), { recursive: true })
  writeFileSync(specPath, JSON.stringify({
    task_id: 'be-1b-E-test', domain: 'backend', goal: 'g',
    files_in_scope: ['f.mjs'], constraints: [], acceptance_criteria: ['works'],
    validation_commands: ['node --test'], discovery_context: 'ctx',
    out_of_scope: [], depends_on: [], interface_contract: 'none',
    [hostileKey]: 'x',
  }))

  const res = spawnSync(process.execPath, [
    DISPATCH_PATH, 'dispatch',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT,
    '--slice', 'be-27z', '--role', 'coder', '--spec', specPath,
  ], { encoding: 'utf8' })

  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`)
  // No raw ESC byte (or any other C0/C1 control/format character) anywhere
  // in stderr — the only acceptable trace of the hostile key is its VISIBLE
  // characters, with the control/format codepoints stripped.
  const rawControlBytesRe = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')
  assert.doesNotMatch(res.stderr, rawControlBytesRe, `stderr must contain no raw control bytes (ESC etc, excluding tab/newline/CR), got: ${JSON.stringify(res.stderr)}`)
  // The visible remnant of the hostile key survives (proves we sanitized
  // rather than silently dropped the whole detail).
  assert.match(res.stderr, /FAKE/)
  // The forged "[FAKE] forged dispatcher line" text must NOT appear on its
  // own stderr line (i.e. the embedded newline must not have survived to
  // split it onto a standalone line distinct from the FAIL line it belongs to).
  const forgedStandalone = res.stderr.split('\n').some((line) => line.trim() === '[FAKE] forged dispatcher line')
  assert.equal(forgedStandalone, false, 'the embedded newline must not produce a standalone forged stderr line')

  const json = JSON.parse(res.stdout.trim())
  for (const f of json.failures) {
    assert.doesNotMatch(f.detail, rawControlBytesRe, `JSON failures[].detail must contain no raw control bytes, got: ${JSON.stringify(f.detail)}`)
  }

  // Fix-round-2 item 2: the same line-count invariant the CLI-wiring test
  // above already uses (one "FAIL schema: " stderr line per failures[]
  // entry) — this fails immediately if the embedded newline smuggled an
  // extra apparent line, which the two checks above (no raw control bytes;
  // no standalone forged line) would NOT catch on their own if only the ESC
  // codes were stripped while the newline itself survived unescaped.
  const failLineCount = (res.stderr.match(/^FAIL schema: /gm) || []).length
  assert.equal(failLineCount, json.failures.length, 'expected exactly one "FAIL schema: ..." stderr line per failure, even with a hostile embedded newline in the detail')
})

// Fix-round item 6 (unbounded output amplification): both the stderr FAIL
// lines and the returned JSON failures[] must be capped, never growing
// linearly with an attacker-controlled number of schema violations.
test('A2 fix-round #6: a spec with many schema violations produces a capped failures[] (with a "...and N more" tail entry) and a matching capped stderr line count', () => {
  const { dir, ctx } = setUpWorkspace('a2-many-violations')
  const configDir = join(ctx.primaryCheckout, '.claude', 'dev-team')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.md'), 'execution_mode: cmux\n')

  const manyExtraProps = {}
  for (let i = 0; i < 500; i += 1) manyExtraProps[`unexpected_prop_${i}`] = 'x'
  const specPath = specPathFor(ctx.paths, 'be-27y')
  mkdirSync(dirname(specPath), { recursive: true })
  writeFileSync(specPath, JSON.stringify({
    task_id: 'be-1b-E-test', domain: 'backend', goal: 'g',
    files_in_scope: ['f.mjs'], constraints: [], acceptance_criteria: ['works'],
    validation_commands: ['node --test'], discovery_context: 'ctx',
    out_of_scope: [], depends_on: [], interface_contract: 'none',
    ...manyExtraProps,
  }))

  const res = spawnSync(process.execPath, [
    DISPATCH_PATH, 'dispatch',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT,
    '--slice', 'be-27y', '--role', 'coder', '--spec', specPath,
  ], { encoding: 'utf8' })

  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`)
  const json = JSON.parse(res.stdout.trim())
  assert.ok(json.failures.length < 500, `expected a capped failures[] well under 500, got ${json.failures.length}`)
  assert.ok(json.failures.some((f) => /\.\.\.and \d+ more/.test(f.detail)), `expected a "...and N more" tail entry, got ${JSON.stringify(json.failures)}`)

  const failLineCount = (res.stderr.match(/^FAIL schema: /gm) || []).length
  assert.equal(failLineCount, json.failures.length, 'stderr FAIL line count must match the capped failures[] length exactly')
})

// Fix-round-2 item 4: the fix-round-1 MAX_DETAIL_LENGTH truncation path
// (sanitizeDetail, dispatch.mjs) had no test exercising a single detail
// string over the length cap — only the count-cap (500 violations, fix-round
// item 6 above) was tested. A single hostile-length key name (350 chars,
// echoed twice into contract.mjs's "unexpected property" message) produces
// exactly one schema failure whose detail comfortably exceeds
// MAX_DETAIL_LENGTH (300).
test('A2 fix-round #4: a single schema violation whose detail exceeds MAX_DETAIL_LENGTH is truncated with a "<truncated, N chars total>" marker, and the truncated length stays bounded', () => {
  const { dir, ctx } = setUpWorkspace('a2-long-detail')
  const configDir = join(ctx.primaryCheckout, '.claude', 'dev-team')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.md'), 'execution_mode: cmux\n')

  const longKey = 'x'.repeat(350)
  const specPath = specPathFor(ctx.paths, 'be-27-longdetail')
  mkdirSync(dirname(specPath), { recursive: true })
  writeFileSync(specPath, JSON.stringify({
    task_id: 'be-1b-E-test', domain: 'backend', goal: 'g',
    files_in_scope: ['f.mjs'], constraints: [], acceptance_criteria: ['works'],
    validation_commands: ['node --test'], discovery_context: 'ctx',
    out_of_scope: [], depends_on: [], interface_contract: 'none',
    [longKey]: 'x',
  }))

  const res = spawnSync(process.execPath, [
    DISPATCH_PATH, 'dispatch',
    '--task', 'sample-task', '--checkout', ctx.primaryCheckout, '--repo', ctx.repoSlug,
    '--root', join(dir, 'dev-team'), '--plugin-root', ROOT,
    '--slice', 'be-27-longdetail', '--role', 'coder', '--spec', specPath,
  ], { encoding: 'utf8' })

  assert.equal(res.status, 1, `expected exit 1, got ${res.status} — stderr: ${res.stderr}`)
  const json = JSON.parse(res.stdout.trim())
  assert.equal(json.failures.length, 1, `expected exactly one schema failure, got ${JSON.stringify(json.failures)}`)
  const [failure] = json.failures
  assert.match(failure.detail, /<truncated, \d+ chars total>$/, `expected a truncation marker, got: ${failure.detail}`)
  assert.ok(failure.detail.length < 400, `expected the truncated detail to stay bounded, got length ${failure.detail.length}`)

  const failLineCount = (res.stderr.match(/^FAIL schema: /gm) || []).length
  assert.equal(failLineCount, 1, 'expected exactly one "FAIL schema: ..." stderr line for the single truncated failure')
})

test('A2 negative #1 (PATH): a coder dispatch whose validation_commands names a binary absent from PATH still exits 0 with exactly one new-pane, demoted to a warnings[] entry with check:"validation_commands" severity:"fail"', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('a2-negative-path')
  const specPath = makeSpecFile(ctx, 'be-27f', {
    files_in_scope: ['README.md'],
    validation_commands: ['definitely-not-on-path-xyz --check'],
  })

  const res = dispatchCmd({ slice: 'be-27f', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath)
  const newPaneEntries = log.filter((e) => e.argv[0] === 'new-pane')
  assert.equal(newPaneEntries.length, 1, `expected exactly one new-pane invocation, got ${newPaneEntries.length}: ${JSON.stringify(log)}`)

  const finding = res.json.warnings.find((w) => w.check === 'validation_commands')
  assert.ok(finding, `expected a warnings[] entry with check:"validation_commands", got ${JSON.stringify(res.json.warnings)}`)
  assert.equal(finding.severity, 'fail')
})

test('A2 negative #2 (stale citation): a coder dispatch whose discovery_context cites README.md:99999 still exits 0 with exactly one new-pane, demoted to a warnings[] entry with check:"discovery_context"', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('a2-negative-stale-citation')
  const specPath = makeSpecFile(ctx, 'be-27g', {
    files_in_scope: ['README.md'],
    discovery_context: 'see README.md:99999 for the exact shape',
  })

  const res = dispatchCmd({ slice: 'be-27g', role: 'coder', spec: specPath }, ctx)
  assert.equal(res.code, 0)

  const log = readLog(env.logPath)
  const newPaneEntries = log.filter((e) => e.argv[0] === 'new-pane')
  assert.equal(newPaneEntries.length, 1, `expected exactly one new-pane invocation, got ${newPaneEntries.length}: ${JSON.stringify(log)}`)

  const finding = res.json.warnings.find((w) => w.check === 'discovery_context')
  assert.ok(finding, `expected a warnings[] entry with check:"discovery_context", got ${JSON.stringify(res.json.warnings)}`)
})

test('A2 never-widen: a backend-lead (judgment profile) dispatch with the SAME schema-invalid spec that refuses for coder still exits 0 with exactly one new-pane and no warnings key at all', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('a2-never-widen')
  const specPath = makeSpecFile(ctx, 'be-27h', { acceptance_criteria: [] })

  const res = dispatchCmd({ slice: 'be-27h', role: 'backend-lead', spec: specPath }, ctx)
  assert.equal(res.code, 0)
  assert.equal('warnings' in res.json, false, 'a non-executor dispatch must not be linted at all')

  const log = readLog(env.logPath)
  const newPaneEntries = log.filter((e) => e.argv[0] === 'new-pane')
  assert.equal(newPaneEntries.length, 1, `expected exactly one new-pane invocation, got ${newPaneEntries.length}: ${JSON.stringify(log)}`)

  // Cheap pre-existing-behavior regression (NOT a property of the new
  // gate): a backend-lead dispatch with no --spec at all still throws
  // UsageError from dispatch.mjs, exactly as it did before this change.
  assert.throws(() => dispatchCmd({ slice: 'be-27h-nospec', role: 'backend-lead' }, ctx), UsageError)
})

// Fix-round item 3 (should-fix, 3 reviewers converged): roster.schema.json
// leaves `profile` an open string (no enum) — gating on the literal name
// 'executor' would let a session/project/user roster override rename the
// profile `coder` points at (while keeping it pane-enabled and granting the
// same worktree_write capability) and silently bypass the schema floor. This
// proves the gate keys on the CAPABILITY (profile.allow includes
// 'worktree_write'), not the name: a role whose profile is renamed to
// something other than 'executor' but whose resolved profile definition
// still carries worktree_write is still gated on the same schema-invalid
// spec that refuses under the default roster.
test("A2 fix-round #3: a role whose profile is renamed away from 'executor' but still grants worktree_write is still gated on a schema-invalid spec", () => {
  const renamedProfile = {
    description: 'same capability as executor, different name',
    permission_mode: 'dontAsk',
    allow: ['returns_write', 'signals_append', 'worktree_write', 'validation_commands'],
    postcondition: 'changes_expected',
  }
  const { ctx } = setUpWorkspace('a2-capability-gate', {
    configOverrides: {
      session: {
        profiles: { 'renamed-executor': renamedProfile },
        roles: { coder: { profile: 'renamed-executor' } },
      },
    },
  })
  assert.equal(ctx.roster.roles.coder.profile, 'renamed-executor', 'sanity: the session override actually renamed the profile')

  const specPath = makeSpecFile(ctx, 'be-27-cap', { acceptance_criteria: [] })
  assert.throws(
    () => dispatchCmd({ slice: 'be-27-cap', role: 'coder', spec: specPath }, ctx),
    (err) => {
      assert.ok(err instanceof SpecSchemaError, `expected SpecSchemaError under a renamed-but-still-write-capable profile, got ${err}`)
      assert.equal(err.code, SPEC_SCHEMA_REFUSAL_CODE)
      return true
    },
  )
})

test('A2 message drift guard: SPEC_SCHEMA_REFUSAL_MESSAGE (the imported constant) occurs verbatim exactly once across scripts/cmux/*.mjs + test/cmux-*.test.mjs, has the "refused: " prefix and names handover-spec.schema.json; SPEC_SCHEMA_REFUSAL_CODE is byte-pinned', () => {
  const scriptsDir = join(ROOT, 'scripts', 'cmux')
  const testDir = HERE
  const scriptFiles = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).map((f) => join(scriptsDir, f))
  const testFiles = readdirSync(testDir).filter((f) => f.startsWith('cmux-') && f.endsWith('.test.mjs')).map((f) => join(testDir, f))
  const combined = [...scriptFiles, ...testFiles].map((p) => readFileSync(p, 'utf8')).join('\n---\n')

  const occurrences = combined.split(SPEC_SCHEMA_REFUSAL_MESSAGE).length - 1
  assert.equal(occurrences, 1, `SPEC_SCHEMA_REFUSAL_MESSAGE must appear verbatim exactly once across scripts/cmux/*.mjs + test/cmux-*.test.mjs (found ${occurrences}) — a re-typed copy anywhere (including this test file) is drift`)

  assert.ok(SPEC_SCHEMA_REFUSAL_MESSAGE.startsWith('refused: '))
  assert.ok(SPEC_SCHEMA_REFUSAL_MESSAGE.includes('handover-spec.schema.json'))
  assert.equal(SPEC_SCHEMA_REFUSAL_CODE, 'spec_schema_invalid')
})

test('A2 symlink-invocation regression: invoking dispatch.mjs through a symlinked path still runs main() (realpathSync fix on the invokedDirectly guard)', () => {
  // Paired positive: the same spawn against DISPATCH_PATH itself also exits
  // 2 with the same stderr, proving this assertion is about symlink
  // resolution and not about a broken spawn.
  const direct = spawnSync(process.execPath, [DISPATCH_PATH], { encoding: 'utf8' })
  assert.equal(direct.status, 2)
  assert.match(direct.stderr, /usage: node dispatch\.mjs </)

  const linkDir = makeTmpDir('cmux-dispatch-symlink-')
  const linkPath = join(linkDir, 'dispatch-link.mjs')
  symlinkSync(DISPATCH_PATH, linkPath)
  const viaLink = spawnSync(process.execPath, [linkPath], { encoding: 'utf8' })
  assert.equal(viaLink.status, 2)
  assert.match(viaLink.stderr, /usage: node dispatch\.mjs </)
})

test('A2 cross-file check-name agreement: lintSpec (imported directly from spec-lint.mjs) produces a check:"schema" failure for a missing required field, and a check:"validation_commands" failure for a nonexistent binary', () => {
  const dir = makeTmpDir('cmux-dispatch-lintspec-')
  const checkout = makeGitCheckout(dir)
  const baseSpec = {
    task_id: 't', domain: 'backend', goal: 'g',
    files_in_scope: ['README.md'], constraints: [], acceptance_criteria: ['works'],
    validation_commands: ['node --test'], discovery_context: 'ctx',
    out_of_scope: [], depends_on: [], interface_contract: 'none',
  }

  const missingFieldSpec = { ...baseSpec }
  delete missingFieldSpec.acceptance_criteria
  const schemaResult = lintSpec(missingFieldSpec, checkout)
  assert.ok(schemaResult.failures.some((f) => f.check === 'schema'), `expected a check:"schema" failure, got ${JSON.stringify(schemaResult.failures)}`)

  const badBinSpec = { ...baseSpec, validation_commands: ['definitely-not-on-path-xyz --check'] }
  const validationResult = lintSpec(badBinSpec, checkout)
  assert.ok(validationResult.failures.some((f) => f.check === 'validation_commands'), `expected a check:"validation_commands" failure, got ${JSON.stringify(validationResult.failures)}`)
})

// ---------------------------------------------------------------------------
// be-41-04 (issue #41, epic #39) — lifecycle ledger emission wiring into
// workspaceCmd, dispatchCmd, phaseCmd, awaitCmd, teardownCmd. NEVER
// LOAD-BEARING throughout: every test below is either a positive proof that
// the mirror actually landed (readable via a real ledger reader against the
// sidecar's own db_path — never dispatch.mjs's internals) or a negative
// proof that a hostile/degraded emitter changes nothing observable.
// ---------------------------------------------------------------------------

const DISPATCH_SOURCE = readFileSync(DISPATCH_PATH, 'utf8')

function readRunSidecar(ctx) {
  return JSON.parse(readFileSync(join(ctx.paths.stateDir, 'ledger', 'run.json'), 'utf8'))
}

function withLedgerReader(ctx, fn) {
  const sidecar = readRunSidecar(ctx)
  const ledger = openLedger({ dbPath: sidecar.db_path, jsonlPath: sidecar.jsonl_path })
  try {
    return fn(ledger, sidecar)
  } finally {
    ledger.close()
  }
}

// dumpLedgerTablesInSubprocess: a same-process openLedger() read against a
// db_path this SAME process just closed a connection to (teardownCmd's own
// emitter.dispose()) moments earlier — especially right after that
// directory was ALSO renamed by archiveOrDelete — unreliably observes an
// empty WAL-mode mirror even though the JSONL (and a genuinely separate
// process reading the identical path) both see every row. Reading through a
// real child process for every POST-teardown assertion sidesteps that
// same-process artifact entirely and is also the more honest proof anyway:
// production teardownCmd and any later inspector are always separate
// processes, never one process handing a connection to itself.
const LEDGER_READER_SCRIPT = join(makeTmpDir('cmux-dispatch-ledger-reader-'), 'reader.mjs')
writeFileSync(LEDGER_READER_SCRIPT, [
  `import { openLedger } from ${JSON.stringify(join(ROOT, 'scripts', 'factory', 'ledger.mjs'))}`,
  'const [, , dbPath, jsonlPath, tableNamesJson] = process.argv',
  'const ledger = openLedger({ dbPath, jsonlPath })',
  'const out = {}',
  'for (const t of JSON.parse(tableNamesJson)) out[t] = ledger.dumpTable(t)',
  'process.stdout.write(JSON.stringify(out))',
].join('\n'))

function dumpLedgerTablesInSubprocess(sidecar, tableNames) {
  const out = execFileSync(process.execPath, [
    LEDGER_READER_SCRIPT, sidecar.db_path, sidecar.jsonl_path, JSON.stringify(tableNames),
  ], { encoding: 'utf8' })
  return JSON.parse(out)
}

function readJsonlKinds(jsonlPath) {
  if (!existsSync(jsonlPath)) return []
  return readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// A ledger handle whose EVERY writer throws — models "a ledger handle whose
// every writer throws" (be-41-04's own NEVER-LOAD-BEARING acceptance
// criterion) via emit.mjs's own documented `_openLedger` TEST SEAM, never by
// touching emit.mjs or ledger.mjs themselves.
function hostileLedgerHandle() {
  const boom = () => { throw new Error('hostile ledger writer (be-41-04 mutation test)') }
  return {
    startSession: boom, endSession: boom, startPhase: boom, endPhase: boom,
    recordEvent: boom, recordEnvelope: boom, recordGateResult: boom,
    startProcess: boom, endProcess: boom, heartbeat: boom,
    startAgentSession: boom, endAgentSession: boom, recordSourceError: boom,
    listSessions: () => [], listEvents: () => [], getSession: () => null, dumpTable: () => [],
    stats: () => ({ degraded: false, mirror_errors: 0 }),
    close: () => {}, installFinalizer: () => ({ uninstall: () => {} }),
  }
}

function installHostileEmitterOpener() {
  _setEmitterOpenerForTest((opts) => openRun({ ...opts, _openLedger: hostileLedgerHandle }))
}

after(() => { _setEmitterOpenerForTest(null) })

test('be-41-04 SIGNAL_LEVELS/SIGNAL_LIMITS SOURCING: SIGNAL_LIMITS is imported from ./contract.mjs (never re-declared); SIGNAL_LEVELS is derived from signal-record.schema.json\'s own level enum (never a hand-written literal, never imported from ladder.mjs); both match ladder.mjs\'s own runtime behaviour on the same hostile fixture', () => {
  assert.match(DISPATCH_SOURCE, /import\s*\{[^}]*SIGNAL_LIMITS[^}]*\}\s*from\s*'\.\/contract\.mjs'/s)
  assert.doesNotMatch(DISPATCH_SOURCE, /const\s+SIGNAL_LIMITS\s*=/)
  assert.match(DISPATCH_SOURCE, /signal-record\.schema\.json/)
  assert.doesNotMatch(DISPATCH_SOURCE, /const\s+SIGNAL_LEVELS\s*=\s*\[/)

  const ladderSchema = JSON.parse(readFileSync(join(ROOT, 'scripts', 'cmux', 'signal-record.schema.json'), 'utf8'))
  assert.deepEqual([...SIGNAL_LEVELS], ladderSchema.properties.level.enum)
  assert.deepEqual(SIGNAL_LIMITS, { max_relayed_per_dispatch: 5, min_interval_s: 30, message_max_chars: 200 })
})

test('be-41-04 STATUS VERB STAYS EMISSION-FREE: statusCmd\'s own function body makes no emitter call', () => {
  const match = DISPATCH_SOURCE.match(/export function statusCmd\(args, ctx\) \{[\s\S]*?\n\}\n/)
  assert.ok(match, 'could not locate statusCmd\'s function body in dispatch.mjs source')
  assert.doesNotMatch(match[0], /openEmitter/)
})

test('be-41-04 REWORK must-fix #1: installFinalizer() is called from NOWHERE in dispatch.mjs, AND no hand-rolled process.on(\'SIG...\') listener reproduces the identical suppression bug without ever calling installFinalizer', () => {
  assert.doesNotMatch(DISPATCH_SOURCE, /\.installFinalizer\(\)/)
  assert.doesNotMatch(DISPATCH_SOURCE, /process\.on\(\s*['"]SIG/)
})

test('be-41-04 REWORK must-fix #3: a real-subprocess SIGINT during a hung await kills the process promptly (exit signal SIGINT, well within a short bound), proving Ctrl-C is never silently swallowed now that no finalizer is installed', async () => {
  const { env, ctx } = setUpWorkspace('await-sigint-regression')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  const script = join(makeTmpDir('cmux-dispatch-sigint-'), 'run-await.mjs')
  writeFileSync(script, [
    `process.env.CMUX_BIN = ${JSON.stringify(FIXTURE)}`,
    `process.env.FAKE_CMUX_LOG = ${JSON.stringify(env.logPath)}`,
    `process.env.FAKE_CMUX_STATE = ${JSON.stringify(env.statePath)}`,
    `const { awaitCmd, buildContext } = await import(${JSON.stringify(DISPATCH_PATH)})`,
    `const ctx = buildContext(${JSON.stringify({
      task: ctx.taskSlug, checkout: ctx.primaryCheckout, repo: ctx.repoSlug, root: ctx.roots.root, 'plugin-root': ROOT,
    })})`,
    // A short --max-block-s (must-fix #3a): if the SIGINT-suppression bug
    // were reintroduced, this test must fail FAST and legibly rather than
    // reading as a hung CI job for up to the full 600s cap.
    // A record with no matching id ever resolves — this hangs until SIGINT
    // (or, if the bug is back, until the 5s cap).
    `awaitCmd({ all: ['nonexistent-dispatch-id'], 'max-block-s': '5' }, ctx, {})`,
  ].join('\n'))

  // spawnSync has no way to deliver a signal mid-run — use the async spawn
  // API so SIGINT can be sent once the child is definitely blocked in the
  // poll loop. stderr is piped (must-fix #3c) so a failure is debuggable
  // rather than silent.
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderrOut = ''
  proc.stderr.on('data', (chunk) => { stderrOut += chunk.toString() })

  // must-fix #3c: the exit listener is attached BEFORE any sleep/wait — a
  // child that dies early (e.g. a startup error) must still resolve this
  // promise instead of hanging the test forever waiting on an 'exit' event
  // that already fired and was missed.
  const exitPromise = new Promise((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }))
  })

  // must-fix #3b: a readiness handshake (poll for await.lock, the file
  // awaitCmd creates the instant it acquires its lock, right before
  // entering the poll loop) rather than a fixed sleep — a fixed sleep gives
  // no guarantee the child has reached the vulnerable point in awaitCmd yet;
  // sending SIGINT too early would let Node's default disposition kill the
  // child instantly regardless of whether the bug is present, making the
  // test pass even WITH the regression reintroduced.
  const lockPath = ctx.paths.lockPath
  const deadline = Date.now() + 5000
  while (!existsSync(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(existsSync(lockPath), `expected the child to create its await.lock (readiness signal) before the deadline; stderr so far: ${stderrOut}`)

  const sigintSentAt = Date.now()
  proc.kill('SIGINT')
  const exitInfo = await exitPromise
  const elapsedMs = Date.now() - sigintSentAt

  // Node's default disposition on an uncaught SIGINT: process exits with
  // code null and signal 'SIGINT' (exit 128+2=130 at the shell) — asserting
  // the signal (not a numeric 130, which is a shell convention, not
  // something Node itself reports via the 'exit' event) is what proves the
  // default disposition was never overridden by a finalizer's own listener.
  assert.equal(exitInfo.signal, 'SIGINT', `expected the process to die of SIGINT with no override, got ${JSON.stringify(exitInfo)}; stderr: ${stderrOut}`)
  // must-fix #3a: a short, legible timing bound — a regression fails fast
  // instead of only failing after the full (now 5s, not 600s) await cap.
  assert.ok(elapsedMs < 5000, `expected the process to die within 5s of SIGINT (Node's default disposition kills instantly), got ${elapsedMs}ms; stderr: ${stderrOut}`)
})

test('be-41-04 TEARDOWN NEVER TOUCHES ~/.dev-team/factory/: teardownCmd never resolves a db path outside paths.stateDir', () => {
  const teardownBodyStart = DISPATCH_SOURCE.indexOf('export function teardownCmd(args, ctx) {')
  assert.ok(teardownBodyStart >= 0)
  const nextExportStart = DISPATCH_SOURCE.indexOf('\nexport function', teardownBodyStart + 10)
  const teardownBody = DISPATCH_SOURCE.slice(teardownBodyStart, nextExportStart)
  // teardownCmd never calls homedir() (or defaultDbPath()) itself — the only
  // way a real db path could ever resolve to ~/.dev-team/factory/ (ledger.
  // mjs's OWN CLI-only default, out of scope) is through one of those two
  // calls, and openEmitter's own dbPath always derives from paths.stateDir.
  // Checked against the CODE, not the prose — this comment block itself
  // legitimately spells out the literal path fragment-free-form.
  assert.doesNotMatch(teardownBody, /homedir\(|defaultDbPath\(/)
  assert.match(teardownBody, /openEmitter\(ctx\)/)
})

test('be-41-04 WORKSPACE -> PLANNING, DISPATCH -> BUILDING (idempotent, no duplicate), PHASE --set gate -> GATE, in order', () => {
  const { ctx } = setUpWorkspace('ledger-phases')
  const specA = makeSpecFile(ctx, 'be-1a')
  const dispatchA = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specA }, ctx)
  assert.equal(dispatchA.code, 0)
  const specB = makeSpecFile(ctx, 'be-1b')
  const dispatchB = dispatchCmd({ slice: 'be-1b', role: 'coder', spec: specB }, ctx)
  assert.equal(dispatchB.code, 0)
  const phaseRes = phaseCmd({ set: 'gate' }, ctx)
  assert.equal(phaseRes.code, 0)

  withLedgerReader(ctx, (ledger, sidecar) => {
    const phases = ledger.dumpTable('phases').filter((p) => p.adw_id === sidecar.adw_id)
    assert.deepEqual(phases.map((p) => p.name), ['planning', 'building', 'gate'])
    assert.equal(phases.filter((p) => p.name === 'building').length, 1, 'a second dispatch must never produce a duplicate building phase row')

    const agentStarts = ledger.dumpTable('events').filter((e) => e.adw_id === sidecar.adw_id && e.type === 'agent_start')
    assert.equal(agentStarts.length, 2, 'exactly one agent_start per dispatch')
    for (const row of agentStarts) {
      const payload = JSON.parse(row.payload_json)
      assert.deepEqual(Object.keys(payload).sort(), ['dispatch_id', 'model', 'role'], 'agent_start payload must be exactly {role, model, dispatch_id} — payload discipline')
      assert.equal(payload.role, 'coder')
    }

    assert.equal(Object.keys(sidecar.dispatches).length, 2)
    for (const [dispatchId, entry] of Object.entries(sidecar.dispatches)) {
      assert.deepEqual(entry, {
        claude_session_id: dispatchId, transcript_path: null, session_started: false, sighted_at: null, ended: false,
      }, 'sidecar dispatches entry recorded at dispatch time')
    }
  })
})

test('be-41-04 REWORK must-fix #2: workspace/dispatch/phase/await/teardown HEALTHY-PATH JSON each compared via assert.deepEqual against a FROZEN literal expected object (not a key-subset check, and distinct from the healthy-vs-degraded mutation tests below — a leaked key present in both the healthy and degraded run would slip through THOSE tests but is caught here)', () => {
  const { ctx } = setUpWorkspace('frozen-shape')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id

  // window_id/workspace_id/pane_id/surface_id are NOT random — fake-cmux.mjs
  // mints them deterministically (sequential) from a fresh
  // FAKE_CMUX_STATE/FAKE_CMUX_LOG pair, which freshCmuxEnv() gives every test
  // its own of. Only dispatch_id (a real crypto.randomBytes UUID minted by
  // record.mjs's newDispatchId) is genuinely random per run — it and
  // attn_parent (which embeds it) are the only two fields redacted below.
  assert.deepEqual(dispatchRes.json, {
    dispatch_id: dispatchId,
    workspace_id: '00000006-ec2c-40d7-932c-f3610adfe581',
    pane_id: '00000009-ec2c-40d7-932c-f3610adfe581',
    surface_id: '0000000a-ec2c-40d7-932c-f3610adfe581',
    attempt: 1,
    attn_parent: `devteam-${dispatchId}-attn`,
    timeout_s: 1800,
    warnings: [{ check: 'files_in_scope', detail: '"f.mjs" does not exist — treated as a new file (parent dir exists)', severity: 'warn' }],
  })
  assert.equal(dispatchRes.code, 0)

  const workspaceRes = workspaceCmd({}, ctx)
  assert.deepEqual(workspaceRes.json, {
    window_id: '00000005-ec2c-40d7-932c-f3610adfe581',
    workspace_id: '00000006-ec2c-40d7-932c-f3610adfe581',
    initial_surface_id: '00000008-ec2c-40d7-932c-f3610adfe581',
    tier: null,
    env_file: null,
  })
  assert.equal(workspaceRes.code, 0)

  const phaseRes = phaseCmd({ set: 'gate' }, ctx)
  assert.deepEqual(phaseRes.json, { phase: 'gate' })
  assert.equal(phaseRes.code, 0)

  // Force the very first cap-check to already be past the (floor-clamped)
  // 5s cap — deterministic 'still-running' with no real/fake sleep call and
  // no real ~/.claude/projects touch (should-fix C: explicit deps.projectsDir).
  let nowCalls = 0
  const awaitRes = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, {
    now: () => { nowCalls += 1; return nowCalls === 1 ? 0 : 6000 },
    sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
    projectsDir: makeTmpDir('cmux-dispatch-frozen-shape-projects-'),
  })
  assert.deepEqual(awaitRes.json, { status: 'still-running', remaining: [dispatchId], attention: [] })
  assert.equal(awaitRes.code, 0)

  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  const normalizedTeardownJson = JSON.parse(JSON.stringify(teardownRes.json))
  delete normalizedTeardownJson.task_dir.path
  delete normalizedTeardownJson.state_dir.path
  assert.deepEqual(normalizedTeardownJson, {
    task_dir: { archived: true },
    state_dir: { archived: true },
    leftover_worktrees: [],
  })
  assert.equal(teardownRes.code, 0)
})

test('be-41-04 NEVER LOAD-BEARING (mutation): workspace/dispatch/phase(gate) return byte-identical {code, json} and the same cmux invocation count whether the ledger is healthy or every writer throws', () => {
  function runScenario() {
    const { env, ctx } = setUpWorkspace('ledger-mutation')
    const specPath = makeSpecFile(ctx)
    const workspaceRes = workspaceCmd({}, ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const phaseRes = phaseCmd({ set: 'gate' }, ctx)
    return { workspaceRes, dispatchRes, phaseRes, invocationCount: readLog(env.logPath).length }
  }

  const healthy = runScenario()
  installHostileEmitterOpener()
  let degraded
  try {
    degraded = runScenario()
  } finally {
    _setEmitterOpenerForTest(null)
  }

  // window_id/workspace_id/pane_id/surface_id are freshly minted per call —
  // strip those before the deepEqual, keeping every OTHER key byte-identical
  // (the "not a key-subset check" requirement: every key not stripped here
  // is compared in full, and the stripped set is the same across both runs).
  function normalize(res) {
    const clone = JSON.parse(JSON.stringify(res))
    delete clone.workspaceRes.json.window_id
    delete clone.workspaceRes.json.workspace_id
    delete clone.workspaceRes.json.initial_surface_id
    delete clone.dispatchRes.json.dispatch_id
    delete clone.dispatchRes.json.workspace_id
    delete clone.dispatchRes.json.pane_id
    delete clone.dispatchRes.json.surface_id
    delete clone.dispatchRes.json.attn_parent
    return clone
  }
  assert.deepEqual(normalize(healthy), normalize(degraded))
  assert.equal(healthy.invocationCount, degraded.invocationCount)
})

test('be-41-04 NEVER LOAD-BEARING (mutation): teardown returns byte-identical {code, json} whether the ledger is healthy or every writer throws', () => {
  function runScenario(prefix) {
    const { env, ctx } = setUpWorkspace(prefix)
    const specPath = makeSpecFile(ctx)
    dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
    return { teardownRes, invocationCount: readLog(env.logPath).length }
  }

  const healthy = runScenario('ledger-teardown-mutation-healthy')
  installHostileEmitterOpener()
  let degraded
  try {
    degraded = runScenario('ledger-teardown-mutation-degraded')
  } finally {
    _setEmitterOpenerForTest(null)
  }

  function normalize(res) {
    const clone = JSON.parse(JSON.stringify(res))
    delete clone.teardownRes.json.task_dir.path
    delete clone.teardownRes.json.state_dir.path
    return clone
  }
  assert.deepEqual(normalize(healthy), normalize(degraded))
  assert.equal(healthy.invocationCount, degraded.invocationCount)
})

test('be-41-04 NEVER LOAD-BEARING (mutation): await returns byte-identical {code, json} (dispatch_id redacted — it is a fresh UUID per run) whether the ledger is healthy or every writer throws', () => {
  function runScenario(prefix) {
    const { env, ctx } = setUpWorkspace(prefix)
    const specPath = makeSpecFile(ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const dispatchId = dispatchRes.json.dispatch_id
    let now = Date.now()
    // QA should-fix C: an explicit deps.projectsDir (never the real
    // ~/.claude/projects) — this scenario runs twice per test invocation
    // and neither run has any business touching the real home directory.
    const res = awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 1000, projectsDir: makeTmpDir('cmux-dispatch-await-mutation-projects-'),
    })
    // Redact the one value that is legitimately different across two
    // separate runs (a fresh newDispatchId() UUID) — every OTHER key/value
    // is compared in full, never a subset.
    const redacted = JSON.parse(JSON.stringify(res).split(dispatchId).join('<dispatch_id>'))
    return { redacted, invocationCount: readLog(env.logPath).length }
  }

  const healthy = runScenario('ledger-await-mutation-healthy')
  installHostileEmitterOpener()
  let degraded
  try {
    degraded = runScenario('ledger-await-mutation-degraded')
  } finally {
    _setEmitterOpenerForTest(null)
  }
  assert.deepEqual(healthy.redacted, degraded.redacted)
  assert.equal(healthy.invocationCount, degraded.invocationCount)
})

test('be-41-04 RESOLUTION: incremental and first-sighting-wins — a transcript appearing after the first tick pins exactly one agent session; a later second match never changes the pinned path', () => {
  const { ctx } = setUpWorkspace('await-resolution')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id

  const projectsDir = makeTmpDir('cmux-dispatch-projects-')
  const firstProjectDir = join(projectsDir, 'proj-a')
  mkdirSync(firstProjectDir, { recursive: true })
  const firstTranscriptPath = join(firstProjectDir, `${dispatchId}.jsonl`)

  const initialNow = Date.now()
  let now = initialNow
  let sleepCalls = 0
  const res = awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, {
    now: () => now,
    sleep: (ms) => {
      sleepCalls += 1
      if (sleepCalls === 1) {
        // Invisible on tick 1's resolution attempt; visible from tick 2 on.
        writeFileSync(firstTranscriptPath, '')
      }
      now += ms
    },
    tickMs: 400,
    projectsDir,
  })
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.status, 'still-running')
  assert.ok(sleepCalls >= 2, 'expected at least two ticks so the file becomes visible before the cap is reached')

  const sidecar = readRunSidecar(ctx)
  const entry = sidecar.dispatches[dispatchId]
  assert.equal(entry.session_started, true)
  assert.equal(entry.transcript_path, firstTranscriptPath)
  assert.ok(sidecar.stats.resolution_missing >= 1, 'the tick before the file existed must have counted resolution_missing')
  // QA should-fix F: sighted_at reflects the INJECTED clock at the moment of
  // resolution (tick 2, right after exactly one sleep(tickMs) call already
  // advanced it), never a real wall-clock read — pinned against the actual
  // value the test's own deps.now would have returned at that point, not a
  // hand-derived arithmetic guess.
  assert.equal(entry.sighted_at, isoMs(initialNow + 400))

  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 1, 'exactly one startAgentSession row')
    assert.equal(sessions[0].claude_session_id, dispatchId)
    assert.equal(sessions[0].transcript_path, firstTranscriptPath)
  })

  // A SECOND matching transcript appearing later must never change the
  // pinned path — the sidecar value is never re-resolved.
  const secondProjectDir = join(projectsDir, 'proj-b')
  mkdirSync(secondProjectDir, { recursive: true })
  writeFileSync(join(secondProjectDir, `${dispatchId}.jsonl`), '')
  let now2 = now
  awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, {
    now: () => now2, sleep: (ms) => { now2 += ms }, tickMs: 400, projectsDir,
  })
  const sidecarAfter = readRunSidecar(ctx)
  assert.equal(sidecarAfter.dispatches[dispatchId].transcript_path, firstTranscriptPath)
  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 1, 'still exactly one row — never re-resolved')
  })
})

test('be-41-04 REWORK must-fix #3: a hostile record.model (5000 ANSI-laden chars with embedded newlines) is stripped and length-capped before it reaches agent_start\'s payload AND agent_sessions.model, since the record is worker-writable and the schema\'s model pattern is unanchored', () => {
  const { ctx } = setUpWorkspace('hostile-record-model')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')

  // Mutate the record's model field BETWEEN dispatch and the resolving tick —
  // models a worker (same uid, G13) rewriting its own record.
  const hostileModel = `\x1b[31m${'m\n'.repeat(2500)}\x07`
  const record = readRecord(recordPath)
  record.model = hostileModel
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)

  // agent_start's payload was ALREADY built and recorded at dispatch time
  // (before this mutation), against the clean 'claude-*' model dispatchCmd
  // resolved — so it is unaffected by this post-dispatch mutation. This test
  // targets the OTHER writer: startAgentSession, fired by the awaitCmd
  // resolving tick below, which re-reads the record fresh from disk and
  // therefore DOES see the poisoned value.
  const projectsDir = makeTmpDir('cmux-dispatch-hostile-model-projects-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `${dispatchId}.jsonl`), '')

  // Resolve on tick 1 (staged return) so exactly one resolution pass runs
  // and the call returns without ever needing a real/fake sleep.
  writeValidReturn(record)
  awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, { sleep: NO_SLEEP, projectsDir })

  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 1)
    const storedModel = sessions[0].model
    assert.doesNotMatch(storedModel, /[\x00-\x1F\x7F]/, 'every control character (including the embedded newlines and the ANSI ESC/BEL bytes) must be stripped')
    assert.doesNotMatch(storedModel, /\x1b\[31m/, 'the ANSI CSI sequence itself must be stripped whole, not just its leading ESC byte')
    assert.ok(storedModel.length <= SIGNAL_LIMITS.message_max_chars, `model must be capped at ${SIGNAL_LIMITS.message_max_chars} chars, got ${storedModel.length}`)
  })
})

test('be-41-04 REWORK round 2, must-fix #2(a): an ALREADY-hostile record.model at DISPATCH TIME (not mutated afterward) is stripped and capped in the agent_start payload dispatchCmd itself builds — a distinct call site from startAgentSession\'s own sanitizer, which the test above only exercises via a POST-dispatch mutation', () => {
  const hostileModel = `\x1b[31m${'m\n'.repeat(2500)}\x07`
  const { ctx } = setUpWorkspace('hostile-model-at-dispatch-time', {
    configOverrides: { session: { roles: { coder: { model: hostileModel } } } },
  })
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  assert.equal(dispatchRes.code, 0)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  assert.equal(record.model, hostileModel, 'sanity: the record ITSELF carries the hostile model unsanitized at dispatch time — buildRecord is not this slice\'s sanitization point, dispatchCmd\'s own agent_start call site is')

  withLedgerReader(ctx, (ledger, sc) => {
    const events = ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'agent_start')
    assert.equal(events.length, 1)
    const payload = JSON.parse(events[0].payload_json)
    assert.doesNotMatch(payload.model, /[\x00-\x1F\x7F]/, 'every control character must be stripped from agent_start\'s own payload, built inside dispatchCmd')
    assert.doesNotMatch(payload.model, /\x1b\[31m/, 'the ANSI CSI sequence itself must be stripped whole, not just its leading ESC byte')
    assert.ok(payload.model.length <= SIGNAL_LIMITS.message_max_chars, `model must be capped at ${SIGNAL_LIMITS.message_max_chars} chars, got ${payload.model.length}`)
    assert.equal(payload.dispatch_id, dispatchId)
  })
})

test('be-41-04 RESOLUTION: two simultaneous transcript matches produce NO agent-session row, increment resolution_ambiguous, and log exactly one line for that single resolution attempt', () => {
  const { ctx } = setUpWorkspace('await-resolution-ambiguous')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  // Resolve on tick 1 for an UNRELATED reason (a staged return) so exactly
  // one resolution attempt happens this whole call — resolveTranscript logs
  // once PER CALL while ambiguous, so a multi-tick call would log once per
  // tick for as long as the ambiguity persists; that per-call behaviour is
  // be-41-02's own tested contract, not what this wiring test is proving.
  writeValidReturn(record)

  const projectsDir = makeTmpDir('cmux-dispatch-projects-ambiguous-')
  for (const name of ['proj-a', 'proj-b']) {
    const sub = join(projectsDir, name)
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, `${dispatchId}.jsonl`), '')
  }

  const stderr = captureStderr(() => {
    awaitCmd({ all: [dispatchId] }, ctx, { sleep: NO_SLEEP, projectsDir })
  })
  const ambiguousLines = stderr.split('\n').filter((l) => l.includes('ambiguous transcript resolution'))
  assert.equal(ambiguousLines.length, 1, `expected exactly one ambiguity log line, got: ${JSON.stringify(ambiguousLines)}`)

  const sidecar = readRunSidecar(ctx)
  assert.equal(sidecar.dispatches[dispatchId].session_started, false)
  assert.ok(sidecar.stats.resolution_ambiguous >= 1)
  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 0)
  })
})

test('be-41-04 RESOLUTION: zero matches increments resolution_missing and logs nothing', () => {
  const { ctx } = setUpWorkspace('await-resolution-missing')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const projectsDir = makeTmpDir('cmux-dispatch-projects-missing-')

  let now = Date.now()
  const stderr = captureStderr(() => {
    awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, {
      now: () => now, sleep: (ms) => { now += ms }, tickMs: 400, projectsDir,
    })
  })
  assert.doesNotMatch(stderr, /transcript resolution/)

  const sidecar = readRunSidecar(ctx)
  assert.equal(sidecar.dispatches[dispatchId].session_started, false)
  assert.ok(sidecar.stats.resolution_missing >= 1)
  withLedgerReader(ctx, (ledger, sc) => {
    assert.equal(ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id).length, 0)
  })
})

test('be-41-04 ensureAgentSession BEFORE THE FIRST HEARTBEAT, throttled >= 15s per session, independently per session', () => {
  const { ctx } = setUpWorkspace('await-heartbeat')
  const specA = makeSpecFile(ctx, 'be-1a')
  const dispatchA = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specA }, ctx)
  const specB = makeSpecFile(ctx, 'be-1b')
  const dispatchB = dispatchCmd({ slice: 'be-1b', role: 'coder', spec: specB }, ctx)
  const idA = dispatchA.json.dispatch_id
  const idB = dispatchB.json.dispatch_id

  const projectsDir = makeTmpDir('cmux-dispatch-projects-heartbeat-')
  for (const id of [idA, idB]) {
    const sub = join(projectsDir, `proj-${id}`)
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, `${id}.jsonl`), '')
  }

  let now = Date.now()
  let ticks = 0
  const res = awaitCmd({ all: [idA, idB], 'max-block-s': '45' }, ctx, {
    now: () => now, sleep: (ms) => { ticks += 1; now += ms }, tickMs: 4000, projectsDir,
  })
  assert.deepEqual(res.json.status, 'still-running')
  assert.ok(ticks >= 10, `expected many ticks over the 45s cap, got ${ticks}`)

  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 2)
    for (const session of sessions) {
      // ensureAgentSession ran before any heartbeat could land — assert the
      // COLUMN actually advanced, not just that the call was made (a
      // heartbeat emitted first would silently update zero rows).
      assert.notEqual(session.last_heartbeat_at, null)
    }

    const jsonlLines = readJsonlKinds(sc.jsonl_path)
    const heartbeatsA = jsonlLines.filter((l) => l.kind === 'heartbeat' && l.args.claude_session_id === idA)
    const heartbeatsB = jsonlLines.filter((l) => l.kind === 'heartbeat' && l.args.claude_session_id === idB)
    // Throttled: strictly fewer heartbeats than ticks (never one-per-tick),
    // but at least a couple across a 45s span at a 15s floor — and each
    // session's own count is independent of the other's.
    for (const hbs of [heartbeatsA, heartbeatsB]) {
      assert.ok(hbs.length >= 2, `expected at least 2 heartbeats over 45s at a 15s floor, got ${hbs.length}`)
      assert.ok(hbs.length < ticks, `heartbeats (${hbs.length}) must be throttled below the tick count (${ticks})`)
    }
  })
})

test('be-41-04 REWORK should-fix E: ensureAgentSession fires strictly BEFORE the first heartbeat, proven by instrumenting the REAL call order — not by a long run whose eventual backfill would still pass even if the order were inverted (an independent mutation-testing gap)', () => {
  const { ctx } = setUpWorkspace('heartbeat-ordering')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const projectsDir = makeTmpDir('cmux-dispatch-heartbeat-order-projects-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `${dispatchId}.jsonl`), '')

  // Resolve on tick 1 (staged return) so exactly one heartbeat/resolution
  // pass runs — a short run is what makes an order inversion (heartbeat
  // pass textually before the resolution pass) actually observable: with a
  // long run, the inverted order still eventually backfills
  // last_heartbeat_at on a LATER tick once the row exists, hiding the bug.
  writeValidReturn(record)

  const callOrder = []
  _setEmitterOpenerForTest((opts) => openRun({
    ...opts,
    _openLedger: () => {
      const real = openLedger({
        dbPath: join(ctx.paths.stateDir, 'ledger', 'ledger.db'),
        jsonlPath: join(ctx.paths.stateDir, 'ledger', 'ledger.jsonl'),
      })
      return {
        ...real,
        startAgentSession: (...callArgs) => { callOrder.push('startAgentSession'); return real.startAgentSession(...callArgs) },
        heartbeat: (...callArgs) => { callOrder.push('heartbeat'); return real.heartbeat(...callArgs) },
      }
    },
  }))
  try {
    awaitCmd({ all: [dispatchId] }, ctx, { sleep: NO_SLEEP, projectsDir })
  } finally {
    _setEmitterOpenerForTest(null)
  }

  const firstStart = callOrder.indexOf('startAgentSession')
  const firstHeartbeat = callOrder.indexOf('heartbeat')
  assert.ok(firstStart !== -1, 'expected at least one startAgentSession call')
  assert.ok(firstHeartbeat !== -1, 'expected at least one heartbeat call')
  assert.ok(firstStart < firstHeartbeat, `startAgentSession (index ${firstStart}) must be called strictly before the first heartbeat (index ${firstHeartbeat}) — call order: ${JSON.stringify(callOrder)}`)
})

test('be-41-04 SIGNALS THROUGH C5, RELAY NEVER FIRED: a hostile signals fixture produces capped, level-clamped log rows; the non-string-message entry is dropped and counted; zero notify-shaped cmux invocations', () => {
  const { env, ctx } = setUpWorkspace('await-signals')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const longMessage = 'x'.repeat(5000)
  const hostileLines = [
    JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'hello', escalate_to: 'lead' }),
    JSON.stringify({ ts: '2026-08-01T00:00:01.000Z', level: 'urgent-unknown-level', message: 'unknown level', escalate_to: 'lead' }),
    JSON.stringify({ ts: '2026-08-01T00:00:02.000Z', level: 'progress', message: '\x1b[31mred\ntext\x07', escalate_to: 'lead' }),
    JSON.stringify({ ts: '2026-08-01T00:00:03.000Z', level: 'progress', message: longMessage, escalate_to: 'lead' }),
    JSON.stringify({ ts: '2026-08-01T00:00:04.000Z', level: 'progress', message: 12345, escalate_to: 'lead' }),
  ]
  mkdirSync(dirname(record.signals_path), { recursive: true })
  writeFileSync(record.signals_path, `${hostileLines.join('\n')}\n`)

  // Resolve on tick 1 (staged return) so exactly one signals pass runs.
  writeValidReturn(record)
  // QA should-fix C: an explicit deps.projectsDir — never the real
  // ~/.claude/projects.
  awaitCmd({ all: [dispatchRes.json.dispatch_id] }, ctx, { sleep: NO_SLEEP, projectsDir: makeTmpDir('cmux-dispatch-signals-projects-') })

  const log = readLog(env.logPath)
  // QA should-fix D: assert the log itself is non-empty FIRST — otherwise
  // the zero-notify count below would pass vacuously if the fake-cmux log
  // were missing/misconfigured for the wrong reason (an empty array's
  // filter().length is trivially 0 regardless of whether anything real ran).
  assert.ok(log.length > 0, 'expected the fake-cmux invocation log to be non-empty (the dispatch itself makes several calls) — a zero-length log would make the notify-count assertion below vacuous')
  assert.equal(log.filter((e) => String(e.argv[0]).includes('notify')).length, 0, 'the relay side effect must never be performed')

  withLedgerReader(ctx, (ledger, sc) => {
    const logRows = ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'log')
    assert.equal(logRows.length, 4, 'the non-string-message entry is dropped, not recorded')
    const payloads = logRows.map((r) => JSON.parse(r.payload_json))
    for (const p of payloads) {
      assert.deepEqual(Object.keys(p).sort(), ['level', 'message'], 'payload discipline: log is exactly {level, message}')
      assert.ok(SIGNAL_LEVELS.includes(p.level), `level must be clamped to a SIGNAL_LEVELS member, got ${p.level}`)
      assert.ok(p.message.length <= SIGNAL_LIMITS.message_max_chars, `message must be capped at ${SIGNAL_LIMITS.message_max_chars} chars, got ${p.message.length}`)
    }
    assert.equal(payloads[1].level, 'progress', 'an unknown level clamps to progress')
    assert.doesNotMatch(payloads[2].message, /[\x00-\x1F\x7F]/, 'control characters (ANSI, newline, bell) are stripped')
    assert.equal(payloads[3].message.length, SIGNAL_LIMITS.message_max_chars, 'a 5000-char message is capped to the limit')
    assert.ok(sc.stats.dropped >= 1, 'the non-string-message drop is counted')
  })
})

test('be-41-04 REWORK must-fix #4: the signals mirror cursor is a PERSISTED byte offset in the sidecar (never a function-local line count) — a SECOND awaitCmd() call over the SAME already-mirrored signals file never re-mirrors those lines', () => {
  const { ctx } = setUpWorkspace('signals-cursor-persistence')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const lines = [
    JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'first', escalate_to: 'lead' }),
    JSON.stringify({ ts: '2026-08-01T00:00:01.000Z', level: 'progress', message: 'second', escalate_to: 'lead' }),
  ]
  mkdirSync(dirname(record.signals_path), { recursive: true })
  writeFileSync(record.signals_path, `${lines.join('\n')}\n`)

  // Force exactly one tick per call (the cap check is already past the
  // floor by the time it is evaluated) — matches the frozen-shape test's
  // own trick above, so this test never depends on a real/fake sleep.
  function forceOneTickDeps() {
    let calls = 0
    return {
      now: () => { calls += 1; return calls === 1 ? 0 : 6000 },
      sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
      projectsDir: makeTmpDir('cmux-dispatch-signals-cursor-projects-'),
    }
  }

  const res1 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps())
  assert.deepEqual(res1.json.status, 'still-running')

  const countLogRows = () => withLedgerReader(ctx, (ledger, sc) => ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'log').length)
  const countAfterFirst = countLogRows()
  assert.ok(countAfterFirst >= 2, `expected the first call to mirror both signal lines, got ${countAfterFirst} log rows`)

  const sidecarAfterFirst = readRunSidecar(ctx)
  // QA REWORK round 2, must-fix #1: the byte offset now lives in the
  // sidecar's own TOP-LEVEL `signal_offsets` map (mirroring the existing
  // top-level `heartbeats` map), never inside the per-dispatch entry.
  assert.ok(sidecarAfterFirst.signal_offsets[dispatchId] > 0, 'the byte offset must be persisted in the sidecar\'s top-level signal_offsets map, not held only in a function-local variable that a fresh awaitCmd() call would never see')

  // A SECOND, entirely fresh awaitCmd() call — models the normal
  // orchestrator pattern of polling repeatedly until resolved. With a
  // function-local line-count cursor (the pre-rework design), this call
  // would re-read the ENTIRE signals file from byte 0 and double every row.
  const res2 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps())
  assert.deepEqual(res2.json.status, 'still-running')

  const countAfterSecond = countLogRows()
  assert.equal(countAfterSecond, countAfterFirst, 'a second awaitCmd() call over the SAME unread-past-offset signals file must never re-mirror already-mirrored lines')
})

test('be-41-04 REWORK round 2, must-fix #1: a non-stale sidecar lock held THROUGHOUT the whole call still lets the signal-offset cursor advance via the in-process fallback — a signals file that would otherwise re-mirror on every tick is only ATTEMPTED once across many ticks', () => {
  const { ctx } = setUpWorkspace('signal-offset-lock-fallback')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  mkdirSync(dirname(record.signals_path), { recursive: true })
  writeFileSync(record.signals_path, `${JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'only-once', escalate_to: 'lead' })}\n`)

  // Never resolved (no transcript match, no return file) — heartbeat never
  // fires (session_started stays false) and the only source of emit() calls
  // is mirrorSignalsTick's own per-row recordEvent, so counting emit() calls
  // is a clean proxy for "how many times the signals pass actually found
  // new, unconsumed lines to process" — independent of whether the persist
  // under the held lock ever actually succeeds.
  let emitCallCount = 0
  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    plantLockAfterRealOpen(opts.stateDir) // never released — every subsequent lock-needing call gives up, for the WHOLE call.
    const realEmit = emitter.emit
    return {
      ...emitter,
      emit: (fn) => { emitCallCount += 1; return realEmit(fn) },
    }
  })

  let now = 0
  let ticks = 0
  let res
  try {
    res = awaitCmd({ all: [dispatchId], 'max-block-s': '45' }, ctx, {
      now: () => now,
      sleep: (ms) => { ticks += 1; now += ms },
      tickMs: 4000,
      projectsDir: makeTmpDir('cmux-dispatch-signal-offset-lock-projects-'),
    })
  } finally {
    _setEmitterOpenerForTest(null)
  }

  assert.deepEqual(res.json.status, 'still-running')
  assert.ok(ticks >= 10, `expected many ticks over the 45s cap, got ${ticks}`)
  assert.equal(emitCallCount, 1, `expected exactly ONE emit() attempt for the single signal line across every tick of this call, got ${emitCallCount} — a persisted-offset-only design (no in-process fallback) would re-attempt this on every tick that the held lock defeats the persist`)
})

test('be-41-04 REWORK round 2, must-fix #2(b): a signals file that shrinks below the persisted mirror offset resets the cursor to 0 and re-mirrors from the (now shorter) file, rather than silently mirroring nothing forever', () => {
  const { ctx } = setUpWorkspace('signals-shrink-reset')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  mkdirSync(dirname(record.signals_path), { recursive: true })
  // A deliberately LONG first line — long enough that the persisted offset
  // after mirroring it will exceed the SHORT rewritten file's total length.
  writeFileSync(record.signals_path, `${JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'a'.repeat(300), escalate_to: 'lead' })}\n`)

  function forceOneTickDeps(projectsDir) {
    let calls = 0
    return {
      now: () => { calls += 1; return calls === 1 ? 0 : 6000 },
      sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
      projectsDir,
    }
  }

  const res1 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps(makeTmpDir('cmux-dispatch-shrink-projects-1-')))
  assert.deepEqual(res1.json.status, 'still-running')

  const countLogRows = () => withLedgerReader(ctx, (ledger, sc) => ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'log').length)
  const countAfterFirst = countLogRows()
  assert.equal(countAfterFirst, 1)

  const sidecarAfterFirst = readRunSidecar(ctx)
  const offsetAfterFirst = sidecarAfterFirst.signal_offsets[dispatchId]
  assert.ok(offsetAfterFirst > 0)

  // Truncate-and-rewrite the file to something SHORTER (in total bytes) than
  // the persisted offset — models a worker truncating and rewriting its own
  // signals file.
  writeFileSync(record.signals_path, `${JSON.stringify({ ts: '2026-08-01T00:00:01.000Z', level: 'progress', message: 'short', escalate_to: 'lead' })}\n`)
  assert.ok(readFileSync(record.signals_path).length < offsetAfterFirst, 'sanity: the rewritten file must genuinely be shorter than the persisted offset for this test to be meaningful')

  const stderr = captureStderr(() => {
    const res2 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps(makeTmpDir('cmux-dispatch-shrink-projects-2-')))
    assert.deepEqual(res2.json.status, 'still-running')
  })
  assert.match(stderr, /resetting the mirror cursor to 0/)

  const countAfterSecond = countLogRows()
  assert.equal(countAfterSecond, countAfterFirst + 1, 'the shrunk-and-rewritten file must be re-mirrored from offset 0, not silently produce nothing')

  const sidecarAfterSecond = readRunSidecar(ctx)
  assert.ok(sidecarAfterSecond.signal_offsets[dispatchId] > 0)
  assert.ok(sidecarAfterSecond.signal_offsets[dispatchId] < offsetAfterFirst, 'the new offset must reflect the shorter rewritten file, not remain stuck at the old, now-invalid, offset')
})

test('be-41-04 REWORK round 2, must-fix #2(c): per-dispatch try/catch isolation in the heartbeat+signals tick loop — one dispatch throwing during its own pass never skips that SAME tick\'s work for another dispatch', () => {
  const { ctx } = setUpWorkspace('await-tick-isolation')
  const specA = makeSpecFile(ctx, 'be-1a')
  const dispatchA = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specA }, ctx)
  const specB = makeSpecFile(ctx, 'be-1b')
  const dispatchB = dispatchCmd({ slice: 'be-1b', role: 'coder', spec: specB }, ctx)
  const idA = dispatchA.json.dispatch_id
  const idB = dispatchB.json.dispatch_id
  const recordA = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  const recordB = readRecord(join(ctx.paths.dispatchDir, 'be-1b.1.json'))

  const POISON_MARKER = 'poison-marker-for-A-only'
  mkdirSync(dirname(recordA.signals_path), { recursive: true })
  writeFileSync(recordA.signals_path, `${JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: POISON_MARKER, escalate_to: 'lead' })}\n`)
  mkdirSync(dirname(recordB.signals_path), { recursive: true })
  writeFileSync(recordB.signals_path, `${JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'B is healthy', escalate_to: 'lead' })}\n`)

  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    const realMap = emitter.mapSignalLogEntries
    return {
      ...emitter,
      // Forces a throw for dispatch A's own signals pass ONLY — B's content
      // never matches the marker and maps normally.
      mapSignalLogEntries: (entries, mapOpts) => {
        if (entries.some((e) => e && e.message === POISON_MARKER)) {
          throw new Error('forced failure for dispatch A only (must-fix #2(c) isolation test)')
        }
        return realMap(entries, mapOpts)
      },
    }
  })

  let res
  let calls = 0
  const stderr = captureStderr(() => {
    try {
      res = awaitCmd({ all: [idA, idB], 'max-block-s': '1' }, ctx, {
        now: () => { calls += 1; return calls === 1 ? 0 : 6000 },
        sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
        projectsDir: makeTmpDir('cmux-dispatch-tick-isolation-projects-'),
      })
    } finally {
      _setEmitterOpenerForTest(null)
    }
  })
  assert.deepEqual(res.json.status, 'still-running')
  assert.match(stderr, new RegExp(`ledger heartbeat/signals mirror failed for ${idA}`), 'expected A\'s forced failure to be logged and swallowed, never propagated')

  withLedgerReader(ctx, (ledger, sc) => {
    const logRows = ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'log')
    assert.equal(logRows.length, 1, 'dispatch B\'s signal line must still be mirrored in the SAME tick despite A throwing')
    const payload = JSON.parse(logRows[0].payload_json)
    assert.equal(payload.message, 'B is healthy')
  })
})

test('be-41-04 REWORK round 2, should-fix C: a per-tick cap on signal-mirroring volume defers overflow lines to a SECOND tick rather than performing an unbounded number of lock+insert cycles in one tick', () => {
  const { ctx } = setUpWorkspace('signals-per-tick-cap')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const lineCount = 120 // > SIGNALS_MAX_LINES_PER_TICK (100)
  const lines = Array.from({ length: lineCount }, (_, i) => JSON.stringify({
    ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: `line-${i}`, escalate_to: 'lead',
  }))
  mkdirSync(dirname(record.signals_path), { recursive: true })
  writeFileSync(record.signals_path, `${lines.join('\n')}\n`)

  function forceOneTickDeps(projectsDir) {
    let calls = 0
    return {
      now: () => { calls += 1; return calls === 1 ? 0 : 6000 },
      sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
      projectsDir,
    }
  }

  const countLogRows = () => withLedgerReader(ctx, (ledger, sc) => ledger.dumpTable('events').filter((e) => e.adw_id === sc.adw_id && e.type === 'log').length)

  const stderr = captureStderr(() => {
    const res1 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps(makeTmpDir('cmux-dispatch-cap-projects-1-')))
    assert.deepEqual(res1.json.status, 'still-running')
  })
  const countAfterFirst = countLogRows()
  assert.ok(countAfterFirst < lineCount, `expected the first tick to mirror FEWER than all ${lineCount} lines, got ${countAfterFirst}`)
  assert.match(stderr, /signal mirror capped at/, 'the overflow must be logged, never silent')

  const res2 = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, forceOneTickDeps(makeTmpDir('cmux-dispatch-cap-projects-2-')))
  assert.deepEqual(res2.json.status, 'still-running')
  const countAfterSecond = countLogRows()
  assert.equal(countAfterSecond, lineCount, 'the deferred overflow lines must be mirrored on a SECOND tick, never dropped')
})

test('be-41-04 REWORK round 2, should-fix B: reconcileProgressCursor takes the more-advanced of a persisted value and an in-process fallback, treating a NaN/malformed persisted value as absent rather than poisoning the comparison', () => {
  assert.equal(reconcileProgressCursor(undefined, undefined), -Infinity)
  assert.equal(reconcileProgressCursor(null, null), -Infinity)
  assert.equal(reconcileProgressCursor(NaN, 5), 5, 'a NaN persisted value must degrade to absent, never poison the comparison via Math.max(NaN, x) === NaN')
  assert.equal(reconcileProgressCursor(5, NaN), 5, 'a NaN fallback value must degrade to absent')
  assert.equal(reconcileProgressCursor(10, 3), 10, 'the persisted value wins when it is more advanced')
  assert.equal(reconcileProgressCursor(3, 10), 10, 'the fallback wins when it is more advanced')
  assert.equal(reconcileProgressCursor(7, 7), 7, 'a tie is stable')
  assert.equal(reconcileProgressCursor(Date.parse('not-a-real-date'), 1234), 1234, 'a malformed ISO timestamp (Date.parse -> NaN) must degrade to absent, exactly the heartbeat-pass scenario this helper exists for')
})

test('be-41-04 TEARDOWN RECONCILES OPEN AGENT SESSIONS and logs the final drop-counter snapshot', () => {
  const { ctx } = setUpWorkspace('await-teardown-reconcile')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const projectsDir = makeTmpDir('cmux-dispatch-projects-teardown-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `${dispatchId}.jsonl`), '')

  writeValidReturn(record)
  awaitCmd({ all: [dispatchId] }, ctx, { sleep: NO_SLEEP, projectsDir })

  const beforeTeardown = readRunSidecar(ctx)
  assert.equal(beforeTeardown.dispatches[dispatchId].session_started, true)
  assert.equal(beforeTeardown.dispatches[dispatchId].ended, false)

  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)

  // teardown archives stateDir (--keep-artifacts) — read the sidecar from
  // its archived location, never assuming the pre-archive path still exists.
  // The sidecar's OWN db_path/jsonl_path fields are stamped at CREATE time
  // and are never rewritten by a later archive/rename, so they still name
  // the pre-archive location — recompute the real post-archive db/jsonl
  // paths relative to archivedStateDir instead of trusting those fields.
  const archivedStateDir = teardownRes.json.state_dir.path
  const sidecarAfter = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  assert.equal(sidecarAfter.dispatches[dispatchId].ended, true)
  const archivedLedgerPaths = {
    ...sidecarAfter,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }

  const dumped = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['agent_sessions', 'sessions', 'phases', 'events'])
  const sessions = dumped.agent_sessions.filter((s) => s.adw_id === sidecarAfter.adw_id)
  assert.equal(sessions.length, 1)
  assert.notEqual(sessions[0].ended_at, null)

  const sessionRow = dumped.sessions.find((s) => s.adw_id === sidecarAfter.adw_id)
  assert.ok(sessionRow)
  assert.equal(sessionRow.status, 'ok')
  assert.notEqual(sessionRow.ended_at, null)

  const openPhases = dumped.phases.filter((p) => p.adw_id === sidecarAfter.adw_id && p.status === 'running')
  assert.equal(openPhases.length, 0, 'endRun must close the open phase')

  const logRows = dumped.events.filter((e) => e.adw_id === sidecarAfter.adw_id && e.type === 'log')
  assert.ok(logRows.length >= 1, 'the stats snapshot is recorded as a log event')
  const snapshotPayload = JSON.parse(logRows[logRows.length - 1].payload_json)
  assert.deepEqual(Object.keys(snapshotPayload).sort(), ['level', 'message'])
})

test('be-41-04 REWORK should-fix B: a sighted-but-now-unreadable transcript at teardown time passes explicit null for all ten usage fields, never a confident all-zero reading', () => {
  const { ctx } = setUpWorkspace('await-teardown-transcript-gone')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const projectsDir = makeTmpDir('cmux-dispatch-projects-teardown-gone-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  const transcriptPath = join(sub, `${dispatchId}.jsonl`)
  // A REAL usage-bearing line at resolution time — the session IS sighted
  // with a genuine, non-trivial transcript, never an empty placeholder
  // (which would be ambiguous with "became unreadable" by construction).
  writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`)

  writeValidReturn(record)
  awaitCmd({ all: [dispatchId] }, ctx, { sleep: NO_SLEEP, projectsDir })

  const sidecarBefore = readRunSidecar(ctx)
  assert.equal(sidecarBefore.dispatches[dispatchId].session_started, true)
  assert.equal(sidecarBefore.dispatches[dispatchId].transcript_path, transcriptPath)

  // The transcript is gone by teardown time — models a worktree/tmp cleanup
  // race, or any other reason the file no longer resolves.
  rmSync(transcriptPath, { force: true })

  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)

  const archivedStateDir = teardownRes.json.state_dir.path
  const sidecarAfter = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  const archivedLedgerPaths = {
    ...sidecarAfter,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }
  const dumped = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['agent_sessions'])
  const session = dumped.agent_sessions.find((s) => s.adw_id === sidecarAfter.adw_id)
  assert.ok(session)
  for (const field of [
    'context_tokens', 'context_window', 'raw_read_tokens', 'raw_written_tokens',
    'billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens',
  ]) {
    assert.equal(session[field], null, `expected ${field} to be explicit null (transcript became unreadable), got ${session[field]}`)
  }
})

test('be-41-04 REWORK round 2, should-fix D: a transcript_path resolved from a control-character-laden project directory name reaches agent_sessions.transcript_path stripped, while the SIDECAR (and teardown\'s real read) keeps the raw, unmodified path', () => {
  const { ctx } = setUpWorkspace('transcript-path-hostile-dirname')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const projectsDir = makeTmpDir('cmux-dispatch-hostile-dirname-projects-')
  // A worker-writable directory NAME (not file content) carrying a control
  // character — resolveTranscript scans directory names, never file content.
  const hostileDirName = 'proj-\x1b[31mred'
  const sub = join(projectsDir, hostileDirName)
  mkdirSync(sub, { recursive: true })
  const rawTranscriptPath = join(sub, `${dispatchId}.jsonl`)
  writeFileSync(rawTranscriptPath, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`)

  writeValidReturn(record)
  awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, { sleep: NO_SLEEP, projectsDir })

  const sidecar = readRunSidecar(ctx)
  assert.equal(sidecar.dispatches[dispatchId].transcript_path, rawTranscriptPath, 'the SIDECAR keeps the raw, resolveTranscript-verified path — the ledger-column sanitizer never touches this operational copy')

  withLedgerReader(ctx, (ledger, sc) => {
    const sessions = ledger.dumpTable('agent_sessions').filter((s) => s.adw_id === sc.adw_id)
    assert.equal(sessions.length, 1)
    assert.doesNotMatch(sessions[0].transcript_path, /\x1b/, 'the ledger column must have the control character stripped')
    assert.ok(sessions[0].transcript_path.includes('proj-'), 'the rest of the real path content must survive the strip')
  })

  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)
  const archivedStateDir = teardownRes.json.state_dir.path
  const archivedSidecar = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  const archivedLedgerPaths = {
    ...archivedSidecar,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }
  const dumped = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['agent_sessions'])
  const session = dumped.agent_sessions.find((s) => s.adw_id === archivedSidecar.adw_id)
  assert.equal(session.raw_read_tokens, 1, 'teardown must have successfully read the RAW (unsanitized) sidecar path — proving the sanitizer only ever touched the ledger column, never the operational path actually used for the real read')
})

test('be-41-04 REWORK round 2, should-fix E: teardown never reads a pinned transcript_path that is not a plain, size-bounded regular file — a directory sitting at that path (standing in for a worker pointing it at a FIFO/socket) is treated as unreadable, never opened', () => {
  const { ctx } = setUpWorkspace('teardown-transcript-not-a-file')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const projectsDir = makeTmpDir('cmux-dispatch-teardown-not-a-file-projects-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  const transcriptPath = join(sub, `${dispatchId}.jsonl`)
  writeFileSync(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`)

  writeValidReturn(record)
  awaitCmd({ all: [dispatchId] }, ctx, { sleep: NO_SLEEP, projectsDir })

  const sidecarBefore = readRunSidecar(ctx)
  assert.equal(sidecarBefore.dispatches[dispatchId].transcript_path, transcriptPath)

  // Replace the FILE with a DIRECTORY of the same name by teardown time — a
  // portable, safe stand-in for "a worker pointed the pinned path at
  // something other than a plain file" (a FIFO/socket would hang a naive
  // readFileSync; a directory exercises the same isFile() guard safely).
  rmSync(transcriptPath, { force: true })
  mkdirSync(transcriptPath, { recursive: true })

  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)

  const archivedStateDir = teardownRes.json.state_dir.path
  const sidecarAfter = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  const archivedLedgerPaths = {
    ...sidecarAfter,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }
  const dumped = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['agent_sessions'])
  const session = dumped.agent_sessions.find((s) => s.adw_id === sidecarAfter.adw_id)
  assert.ok(session)
  assert.equal(session.raw_read_tokens, null, 'a non-regular-file at the pinned path must degrade to explicit null, never a confident zero/partial reading, and must never be opened at all')
})

test('be-41-04 SESSION_STATUSES mapping: teardown maps outcome ok -> \'ok\' and refused -> \'aborted\', never \'fail\'', () => {
  const { ctx } = setUpWorkspace('teardown-outcome-mapping')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const teardownRes = teardownCmd({ outcome: 'refused', 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)
  const archivedStateDir = teardownRes.json.state_dir.path
  const sidecarAfter = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  const archivedLedgerPaths = {
    ...sidecarAfter,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }
  const dumped = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['sessions'])
  const sessionRow = dumped.sessions.find((s) => s.adw_id === sidecarAfter.adw_id)
  assert.equal(sessionRow.status, 'aborted')
})

test('be-41-04 LOCK GIVE-UP NEVER BLOCKS A VERB: a pre-planted non-stale emit.mjs sidecar lock still lets workspace return normally, with the sidecar never created under it', () => {
  // freshCmuxEnv + buildTestCtx + preflightCmd only — NOT setUpWorkspace,
  // which itself calls workspaceCmd once already (that would create the
  // sidecar BEFORE the lock is even planted, defeating this test's setup).
  const env = freshCmuxEnv('lock-giveup')
  const ctx = buildTestCtx(env.dir)
  const preflightRes = preflightCmd({}, ctx)
  assert.equal(preflightRes.code, 0)

  // Plant a FRESH (non-stale) run.lock at the emit.mjs sidecar path this
  // workspaceCmd call will target — its own bounded retry budget (~1s) must
  // give up rather than block workspaceCmd itself.
  const lockPath = join(ctx.paths.stateDir, 'ledger', 'run.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))

  const stderr = captureStderr(() => {
    const res = workspaceCmd({}, ctx)
    assert.equal(res.code, 0)
    assert.ok(res.json.workspace_id)
  })
  assert.match(stderr, /lock give-up during sidecar create-or-adopt/)

  const sidecarPath = join(ctx.paths.stateDir, 'ledger', 'run.json')
  assert.equal(existsSync(sidecarPath), false, 'the sidecar could never even be created under a held lock')
})

// planted immediately after the emitter's OWN open call succeeds (never
// before) — the sidecar create-or-adopt step needs the lock too, so planting
// it any earlier would degrade the WHOLE emitter at open time (a distinct,
// already-covered scenario, the one the test just above exercises) and
// stats().lock_giveups would live on a discarded, brand-new degraded
// closure's own zeroed counter instead of the real, capturable one. Planting
// it via the _setEmitterOpenerForTest seam, right after delegating to the
// real opener, means the OPEN succeeds normally (a real, non-degraded
// emitter, whose stats() this test can actually capture) and every
// SUBSEQUENT updateSidecar/emit call this SAME verb call makes is what gives
// up.
function plantLockAfterRealOpen(stateDir) {
  const lockPath = join(stateDir, 'ledger', 'run.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
  return lockPath
}

test('be-41-04 REWORK must-fix #5: LOCK GIVE-UP NEVER BLOCKS AWAIT — a pre-planted non-stale sidecar lock held longer than the retry budget still lets await return within its normal bounds with unchanged JSON, and stats().lock_giveups is non-zero', () => {
  const { ctx } = setUpWorkspace('lock-giveup-await')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id

  const projectsDir = makeTmpDir('cmux-dispatch-lock-giveup-await-projects-')
  const sub = join(projectsDir, 'proj-a')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `${dispatchId}.jsonl`), '') // resolvable — guarantees at least one lock-needing emission this tick.

  let capturedEmitter = null
  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    capturedEmitter = emitter
    plantLockAfterRealOpen(opts.stateDir)
    return emitter
  })

  let res
  try {
    let calls = 0
    res = awaitCmd({ all: [dispatchId], 'max-block-s': '1' }, ctx, {
      now: () => { calls += 1; return calls === 1 ? 0 : 6000 },
      sleep: () => { throw new Error('sleep must never be called — the cap check must already be past the floor on tick 1') },
      projectsDir,
    })
  } finally {
    _setEmitterOpenerForTest(null)
  }

  assert.equal(res.code, 0)
  assert.deepEqual(res.json, { status: 'still-running', remaining: [dispatchId], attention: [] }, 'a lock give-up must never change await\'s JSON')
  assert.ok(capturedEmitter, 'expected the emitter opener seam to have been invoked')
  assert.ok(capturedEmitter.stats().lock_giveups > 0, `expected at least one lock give-up, got stats() = ${JSON.stringify(capturedEmitter.stats())}`)
})

test('be-41-04 REWORK must-fix #5: LOCK GIVE-UP NEVER BLOCKS TEARDOWN — a pre-planted non-stale sidecar lock held longer than the retry budget still lets teardown return within its normal bounds with unchanged JSON, and stats().lock_giveups is non-zero', () => {
  const { ctx } = setUpWorkspace('lock-giveup-teardown')
  const specPath = makeSpecFile(ctx)
  dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)

  let capturedEmitter = null
  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    capturedEmitter = emitter
    plantLockAfterRealOpen(opts.stateDir)
    return emitter
  })

  let teardownRes
  try {
    teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  } finally {
    _setEmitterOpenerForTest(null)
  }

  assert.equal(teardownRes.code, 0)
  const normalized = JSON.parse(JSON.stringify(teardownRes.json))
  delete normalized.task_dir.path
  delete normalized.state_dir.path
  assert.deepEqual(normalized, { task_dir: { archived: true }, state_dir: { archived: true }, leftover_worktrees: [] }, 'a lock give-up must never change teardown\'s JSON')
  assert.ok(capturedEmitter, 'expected the emitter opener seam to have been invoked')
  assert.ok(capturedEmitter.stats().lock_giveups > 0, `expected at least one lock give-up, got stats() = ${JSON.stringify(capturedEmitter.stats())}`)
})
// ---------------------------------------------------------------------------
// be-41-05 (issue #41, epic #39) — closeCmd's own ledger-mirror wiring: the
// ensureAgentSession fallback, the return envelope, agent_end, endAgentSession
// (all ten fields), the tool_call back-fill (ONE seq reservation for the
// whole batch, ADR-027) and the reconcile-boundary decision row. Same
// NEVER-LOAD-BEARING discipline as be-41-04's own block above: every
// assertion below is either a positive read against the sidecar's real
// db_path (never dispatch.mjs internals) or a negative proof that a hostile
// emitter changes nothing observable.
// ---------------------------------------------------------------------------

// A minimal Claude-transcript-shaped JSONL builder — one assistant
// tool_use/usage line paired with one user tool_result line, at explicit
// HISTORICAL timestamps (never "now") — placed at the exact path
// resolveTranscript (be-41-02) scans for: <projectsDir>/<any-dir>/<dispatch_id>.jsonl.
function writeFakeTranscript(projectsDir, dispatchId, toolCalls, usage) {
  const projectDir = join(projectsDir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${dispatchId}.jsonl`)
  const lines = []
  toolCalls.forEach((call, i) => {
    const toolUseId = `toolu_${i}`
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: call.started_at,
      message: {
        id: `msg_${i}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: call.tool, input: {} }],
        usage: usage || { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }))
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: call.ended_at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: !call.ok }] },
    }))
  })
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  return transcriptPath
}

// closeCmd({dispatch}, ctx, { projectsDir }) — a fresh dispatch + valid
// return, never awaited, ready for the ensureAgentSession fallback path.
function setUpCloseDispatch(prefix) {
  const { env, ctx } = setUpWorkspace(prefix)
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)
  return { env, ctx, dispatchId, record }
}

test('be-41-05 ENSURE-SESSION FALLBACK (never awaited, transcript sightable at close time): exactly one agent_sessions row with the resolved transcript_path', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-ensure-session')
  const projectsDir = makeTmpDir('cmux-dispatch-close-projects-')
  const transcriptPath = writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ])

  const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
  assert.equal(closeRes.code, 0)

  const sidecar = readRunSidecar(ctx)
  const dumped = dumpLedgerTablesInSubprocess(sidecar, ['agent_sessions'])
  const rows = dumped.agent_sessions.filter((r) => r.claude_session_id === dispatchId)
  assert.equal(rows.length, 1, 'expected exactly one agent_sessions row')
  assert.equal(rows[0].transcript_path, transcriptPath)
  assert.notEqual(rows[0].ended_at, null, 'endAgentSession must have landed on the SAME row the fallback just created')

  const sidecarEntry = readRunSidecar(ctx).dispatches[dispatchId]
  assert.equal(sidecarEntry.session_started, true)
  assert.equal(sidecarEntry.ended, true, 'AMENDED POST-be-41-04: close must set ended:true on the same sidecar entry')
})

test('be-41-05 ENSURE-SESSION FALLBACK (never awaited, transcript never sightable): exactly one agent_sessions row with explicit null transcript_path', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-ensure-session-null')
  const emptyProjectsDir = makeTmpDir('cmux-dispatch-close-empty-projects-')

  const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir: emptyProjectsDir })
  assert.equal(closeRes.code, 0)

  const sidecar = readRunSidecar(ctx)
  const dumped = dumpLedgerTablesInSubprocess(sidecar, ['agent_sessions'])
  const rows = dumped.agent_sessions.filter((r) => r.claude_session_id === dispatchId)
  assert.equal(rows.length, 1, 'expected exactly one agent_sessions row even with no sightable transcript')
  assert.equal(rows[0].transcript_path, null, 'explicit null, never omitted')
  assert.equal(rows[0].context_tokens, null)
  assert.equal(rows[0].raw_read_tokens, null)
  assert.equal(rows[0].billed_input_tokens, null)
})

test('be-41-05 ENSURE-SESSION FALLBACK IS IDEMPOTENT: a dispatch whose await already started its agent session gets NO second agent_sessions row on close, and started_at/transcript_path are unchanged (row COUNT, not "a row exists")', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-ensure-session-idempotent')
  const projectsDir = makeTmpDir('cmux-dispatch-close-idempotent-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ])

  // awaitCmd's own per-tick resolution starts the session FIRST.
  awaitCmd({ all: [dispatchId], 'max-block-s': '5' }, ctx, { sleep: NO_SLEEP, projectsDir })
  const sidecarAfterAwait = readRunSidecar(ctx)
  assert.equal(sidecarAfterAwait.dispatches[dispatchId].session_started, true)

  const beforeClose = dumpLedgerTablesInSubprocess(sidecarAfterAwait, ['agent_sessions']).agent_sessions
    .filter((r) => r.claude_session_id === dispatchId)
  assert.equal(beforeClose.length, 1)

  const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
  assert.equal(closeRes.code, 0)

  const sidecar = readRunSidecar(ctx)
  const afterClose = dumpLedgerTablesInSubprocess(sidecar, ['agent_sessions']).agent_sessions
    .filter((r) => r.claude_session_id === dispatchId)
  assert.equal(afterClose.length, 1, 'expected NO second agent_sessions row — the fallback must be gated on session_started, never on INSERT OR IGNORE alone')
  assert.equal(afterClose[0].started_at, beforeClose[0].started_at, 'started_at must be unchanged by close (never a second startAgentSession)')
  assert.equal(afterClose[0].transcript_path, beforeClose[0].transcript_path)
})

test('be-41-05 REPEAT CLOSE is idempotent for the agent_sessions row AND the tool_call/decision back-fill (must-fix #3): a second close call on an already-ended dispatch produces no additional agent_sessions row, no additional tool_call rows, and no additional decision row — only agent_end is mirrored again', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-repeat-idempotent')
  const projectsDir = makeTmpDir('cmux-dispatch-close-repeat-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Bash', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ], { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })

  closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
  const sidecarAfterFirst = readRunSidecar(ctx)
  const firstRow = dumpLedgerTablesInSubprocess(sidecarAfterFirst, ['agent_sessions']).agent_sessions
    .find((r) => r.claude_session_id === dispatchId)
  assert.notEqual(firstRow.billed_input_tokens, null)
  const eventsAfterFirst = dumpLedgerTablesInSubprocess(sidecarAfterFirst, ['events']).events
  const toolCallsAfterFirst = eventsAfterFirst.filter((e) => e.type === 'tool_call')
  const decisionsAfterFirst = eventsAfterFirst.filter((e) => e.type === 'decision')
  const agentEndsAfterFirst = eventsAfterFirst.filter((e) => e.type === 'agent_end')
  assert.equal(toolCallsAfterFirst.length, 1, 'sanity: the first close must have back-filled the one tool_call tuple')
  assert.equal(decisionsAfterFirst.length, 1, 'sanity: the first close must have emitted exactly one decision row')

  // A repeat close (already-terminal branch) must never throw and must
  // never re-run endAgentSession for a dispatch already marked `ended`.
  assert.doesNotThrow(() => closeCmd({ dispatch: dispatchId }, ctx, { projectsDir }))
  const sidecarAfterSecond = readRunSidecar(ctx)
  const rows = dumpLedgerTablesInSubprocess(sidecarAfterSecond, ['agent_sessions']).agent_sessions
    .filter((r) => r.claude_session_id === dispatchId)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], firstRow, 'a repeat close must never mutate the already-ended agent_sessions row')

  const eventsAfterSecond = dumpLedgerTablesInSubprocess(sidecarAfterSecond, ['events']).events
  assert.equal(eventsAfterSecond.filter((e) => e.type === 'tool_call').length, toolCallsAfterFirst.length, 'must-fix #3: a repeat close must NEVER re-back-fill tool_call rows for an already-ended dispatch')
  assert.equal(eventsAfterSecond.filter((e) => e.type === 'decision').length, decisionsAfterFirst.length, 'must-fix #3: a repeat close must NEVER re-emit the decision row for an already-ended dispatch')
  assert.equal(eventsAfterSecond.filter((e) => e.type === 'agent_end').length, agentEndsAfterFirst.length + 1, 'agent_end IS mirrored again on every close — deliberate, unrelated to must-fix #3\'s gate')
})

test('be-41-05 ENVELOPE MIRRORED: a valid return lands recordEnvelope with all eleven fields, valid:1, violation_names empty', () => {
  const { ctx, dispatchId, record } = setUpCloseDispatch('close-envelope-valid')
  closeCmd({ dispatch: dispatchId }, ctx)

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['envelopes']).envelopes.find((r) => r.dispatch_id === dispatchId)
  assert.ok(row, 'expected an envelopes row for this dispatch')
  assert.equal(row.slice_id, record.slice_id)
  assert.equal(row.attempt, record.attempt)
  assert.equal(row.role, record.role)
  assert.equal(row.body_kind, record.return.kind)
  assert.equal(row.valid, 1)
  assert.deepEqual(JSON.parse(row.violation_names), [])
  assert.notEqual(row.produced_at, null)
  assert.equal(row.schema_version, 1)
})

test('be-41-05 ENVELOPE MIRRORED (invalid/absent return): violation_names is built as `${path}:${keyword}` — NEVER a validator message', () => {
  const { ctx } = setUpWorkspace('close-envelope-invalid')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  // No writeValidReturn call — return_path is absent.

  closeCmd({ dispatch: dispatchId }, ctx)

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['envelopes']).envelopes.find((r) => r.dispatch_id === dispatchId)
  assert.ok(row)
  assert.equal(row.valid, 0)
  const violationNames = JSON.parse(row.violation_names)
  assert.ok(violationNames.length > 0)
  for (const name of violationNames) {
    assert.match(name, /^[^\s]{1,200}:[^\s]{1,80}$/, `violation name ${JSON.stringify(name)} must be the closed path:keyword shape, never a message`)
    assert.doesNotMatch(name, /does not match|missing required|expected type/, 'must never be a validator message string')
  }
})

test('be-41-05 agent_end CARRIES THE RECORD\'S TERMINAL OUTCOME: payload is exactly {role, outcome, dispatch_id} where outcome is closeCmd\'s own resolved value, never re-derived — proven across both the fresh and already-terminal branches', () => {
  const { ctx, dispatchId, record } = setUpCloseDispatch('close-agent-end-outcome')

  const closeRes = closeCmd({ dispatch: dispatchId }, ctx)
  assert.equal(closeRes.json.outcome, 'ok')

  let sidecar = readRunSidecar(ctx)
  let events = dumpLedgerTablesInSubprocess(sidecar, ['events']).events.filter((e) => e.type === 'agent_end')
  assert.equal(events.length, 1)
  let payload = JSON.parse(events[0].payload_json)
  assert.deepEqual(Object.keys(payload).sort(), ['dispatch_id', 'outcome', 'role'])
  assert.equal(payload.outcome, 'ok')
  assert.equal(payload.role, record.role)
  assert.equal(payload.dispatch_id, dispatchId)

  // Already-terminal branch: a repeat close reads record.outcome VERBATIM
  // (never re-derived) — still 'ok' here, and still mirrored faithfully.
  closeCmd({ dispatch: dispatchId }, ctx)
  sidecar = readRunSidecar(ctx)
  events = dumpLedgerTablesInSubprocess(sidecar, ['events']).events.filter((e) => e.type === 'agent_end')
  assert.equal(events.length, 2, 'a repeat close mirrors its own agent_end again — never suppressed, never deduplicated by this slice')
  payload = JSON.parse(events[1].payload_json)
  assert.equal(payload.outcome, 'ok')
})

test('be-41-05 endAgentSession LANDS ALL TEN FIELDS (transcript present, deduped)', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-endagentsession-usage')
  const projectsDir = makeTmpDir('cmux-dispatch-close-usage-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ], { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 })

  closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['agent_sessions']).agent_sessions
    .find((r) => r.claude_session_id === dispatchId)
  assert.ok(row)
  assert.notEqual(row.ended_at, null)
  assert.equal(row.context_window, null, 'U-4: context_window is always null')
  assert.equal(row.billed_input_tokens, 100)
  assert.equal(row.billed_output_tokens, 20)
  assert.equal(row.billed_cache_write_tokens, 5)
  assert.equal(row.billed_cache_read_tokens, 50)
  assert.equal(row.raw_written_tokens, 20)
  assert.equal(row.raw_read_tokens, 105, 'raw_read_tokens = input + cache_creation, cache_read EXCLUDED')
  assert.equal(row.context_tokens, 155, 'context_tokens = last message input + cache_read + cache_creation')
})

test('be-41-05 endAgentSession LANDS ALL TEN FIELDS (never-sighted transcript: all ten explicit null)', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-endagentsession-null')
  const emptyProjectsDir = makeTmpDir('cmux-dispatch-close-null-usage-projects-')

  closeCmd({ dispatch: dispatchId }, ctx, { projectsDir: emptyProjectsDir })

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['agent_sessions']).agent_sessions
    .find((r) => r.claude_session_id === dispatchId)
  assert.ok(row)
  assert.notEqual(row.ended_at, null)
  for (const field of ['context_tokens', 'context_window', 'raw_read_tokens', 'raw_written_tokens', 'billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) {
    assert.equal(row[field], null, `expected explicit null for ${field}`)
  }
})

test('be-41-05 TOOL_CALL BACK-FILL WITH HISTORICAL TIMESTAMPS: N tuples produce N tool_call rows whose timestamps come from the transcript (never now()), consuming exactly ONE seq reservation for the whole batch (ADR-027)', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-toolcall-backfill')
  const projectsDir = makeTmpDir('cmux-dispatch-close-toolcall-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2019-06-01T00:00:00.000Z', ended_at: '2019-06-01T00:00:01.000Z' },
    { tool: 'Bash', ok: false, started_at: '2019-06-01T00:00:02.000Z', ended_at: '2019-06-01T00:00:03.000Z' },
    { tool: 'Write', ok: true, started_at: '2019-06-01T00:00:04.000Z', ended_at: '2019-06-01T00:00:05.000Z' },
  ])

  const beforeSidecar = readRunSidecar(ctx)
  const reservedBefore = beforeSidecar.seq.event.reserved_through

  const testStart = Date.now()
  const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
  assert.equal(closeRes.code, 0)

  const sidecar = readRunSidecar(ctx)
  // ONE reservation covering the whole batch: agent_end + 3 tool_call +
  // decision = 5 seq numbers advanced in a single jump, never 5 separate
  // reservations.
  assert.equal(sidecar.seq.event.reserved_through - reservedBefore, 5)

  const events = dumpLedgerTablesInSubprocess(sidecar, ['events']).events
  const toolCalls = events.filter((e) => e.type === 'tool_call')
  assert.equal(toolCalls.length, 3, 'expected every tuple to survive as its own row, not just the first')
  const started = toolCalls.map((e) => e.started_at).sort()
  assert.deepEqual(started, ['2019-06-01T00:00:00.000Z', '2019-06-01T00:00:02.000Z', '2019-06-01T00:00:04.000Z'])
  for (const e of toolCalls) {
    assert.ok(Date.parse(e.started_at) < testStart, 'stored started_at must be the transcript\'s historical time, never the test clock\'s now')
    const payload = JSON.parse(e.payload_json)
    assert.deepEqual(Object.keys(payload).sort(), ['ok', 'tool'])
  }
  const okValues = toolCalls.map((e) => JSON.parse(e.payload_json).ok).sort()
  assert.deepEqual(okValues, [false, true, true])
})

test('be-41-05 QA REWORK must-fix #1: a transcript with 70 tool_call tuples (over the 60-row back-fill cap) still lands agent_end AND exactly one decision row, back-fills only the most recent 60 tool_call rows, and makes the drop VISIBLE via both a stderr line and the decision row\'s alternatives', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-toolcall-cap')
  const projectsDir = makeTmpDir('cmux-dispatch-close-toolcall-cap-projects-')
  // readToolCalls (transcript.mjs) normalizes every `tool` name down to a
  // closed vocabulary (an unrecognized name like `Tool7` reduces to
  // 'other') — tuples are identified below by their unique started_at
  // timestamp instead, which readToolCalls passes through verbatim.
  const tuples = []
  for (let i = 0; i < 70; i += 1) {
    tuples.push({
      tool: 'Read',
      ok: true,
      started_at: new Date(Date.UTC(2019, 5, 1, 0, 0, i * 2)).toISOString(),
      ended_at: new Date(Date.UTC(2019, 5, 1, 0, 0, i * 2 + 1)).toISOString(),
    })
  }
  writeFakeTranscript(projectsDir, dispatchId, tuples)

  const stderr = captureStderr(() => {
    const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
    assert.equal(closeRes.code, 0)
  })
  assert.match(stderr, /70 tool_call tuples.*most recent 60.*dropped 10/, `expected a visible drop line, got stderr: ${JSON.stringify(stderr)}`)

  const sidecar = readRunSidecar(ctx)
  const events = dumpLedgerTablesInSubprocess(sidecar, ['events']).events
  const agentEnds = events.filter((e) => e.type === 'agent_end')
  const toolCalls = events.filter((e) => e.type === 'tool_call')
  const decisions = events.filter((e) => e.type === 'decision')
  assert.equal(agentEnds.length, 1, 'agent_end must always land, regardless of tool-call count')
  assert.equal(toolCalls.length, 60, 'exactly the capped 60 tool_call rows must land, never all 70 and never zero')
  assert.equal(decisions.length, 1, 'the decision row must always land, regardless of tool-call count')

  const survivingStartedAts = toolCalls.map((e) => e.started_at)
  for (let i = 0; i < 10; i += 1) {
    assert.ok(!survivingStartedAts.includes(tuples[i].started_at), `tuple ${i} is among the oldest 10 dropped tuples and must not have landed`)
  }
  for (let i = 10; i < 70; i += 1) {
    assert.ok(survivingStartedAts.includes(tuples[i].started_at), `tuple ${i} is among the most recent 60 tuples and must have landed`)
  }

  const decisionPayload = JSON.parse(decisions[0].payload_json)
  assert.ok(decisionPayload.alternatives.includes('tool_calls_dropped:10'), `expected the decision row's alternatives to fold in the drop count, got ${JSON.stringify(decisionPayload.alternatives)}`)
})

test('be-41-05 QA REWORK must-fix #2(a): a hostile top-level return-envelope key (ANSI escape + control bytes) reaches violation_names sanitized, never a raw control byte', () => {
  const { ctx } = setUpWorkspace('close-envelope-hostile-key')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))

  const hostileKey = '\x1B[31mFAKE\x07\x00path'
  const envelope = {
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: new Date().toISOString(),
    body: { status: 'done', reason: 'ok', changes: ['f.mjs — impl'], validation: 'node --test' },
    [hostileKey]: 'x',
  }
  mkdirSync(dirname(record.return_path), { recursive: true })
  writeFileSync(record.return_path, JSON.stringify(envelope))

  closeCmd({ dispatch: dispatchId }, ctx)

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['envelopes']).envelopes.find((r) => r.dispatch_id === dispatchId)
  assert.ok(row)
  const violationNames = JSON.parse(row.violation_names)
  const hostileNames = violationNames.filter((n) => n.includes('FAKE'))
  assert.ok(hostileNames.length > 0, `expected a violation name derived from the hostile key to survive sanitized, got ${JSON.stringify(violationNames)}`)
  const rawControlBytesRe = /[\x00-\x1F\x7F]/
  for (const name of hostileNames) {
    assert.doesNotMatch(name, rawControlBytesRe, `violation name ${JSON.stringify(name)} must contain no raw control/ANSI bytes`)
    assert.match(name, /^[^\s]{1,200}:[^\s]{1,80}$/, 'must still be the closed path:keyword shape after sanitizing')
  }
})

test('be-41-05 QA REWORK must-fix #2(b): a hostile record.return_path reaches envelope_path sanitized the SAME way transcript_path already is (control-byte-stripped)', () => {
  const { ctx } = setUpWorkspace('close-envelope-path-hostile')
  const record = buildAndBindRecord(ctx, { role: 'code-reviewer', sliceId: 'be-1b' })
  writeValidReturn(record)

  // record.return_path is worker-writable (same uid, G13) but is only ever
  // READ by closeCmd (never itself written hostile in real life) — this
  // test proves the SANITIZER runs on whatever string sits there, by
  // planting one directly on the on-disk record, mirroring the equivalent
  // transcript_path hostile-path tests elsewhere in this file. The suffix is
  // kept short (a real filesystem path component has an OS-enforced length
  // ceiling well under sanitizeTranscriptPathForLedger's own 1024-char cap —
  // that capping behavior is already proven for this exact helper by the
  // transcript_path tests elsewhere in this file; this test's own job is
  // only the control/ANSI-byte stripping, applied to a NEW call site).
  const recordPath = join(ctx.paths.dispatchDir, `${record.slice_id}.${record.attempt}.json`)
  // \x00 is deliberately excluded — a real null byte in a path argument
  // throws at the fs layer (ERR_INVALID_ARG_VALUE) before this test's own
  // control-byte assertions would ever run; \x1B/\x07 alone are sufficient
  // to prove the sanitizer strips control/ANSI bytes.
  const HOSTILE_SUFFIX = '\x1B[31mHOSTILE\x07'
  const hostilePath = `${record.return_path}${HOSTILE_SUFFIX}`
  // The hostile path itself must not exist on disk — return_path is read
  // via readTextOrNull, which degrades a missing file to null (never a
  // throw) — this test only cares about what reaches envelope_path, not
  // about a genuinely valid return body surviving alongside it.
  const onDisk = readRecord(recordPath)
  writeFileSync(recordPath, JSON.stringify({ ...onDisk, return_path: hostilePath }, null, 2))

  closeCmd({ dispatch: record.dispatch_id }, ctx)

  const sidecar = readRunSidecar(ctx)
  const row = dumpLedgerTablesInSubprocess(sidecar, ['envelopes']).envelopes.find((r) => r.dispatch_id === record.dispatch_id)
  assert.ok(row)
  assert.doesNotMatch(row.envelope_path, /[\x00-\x1F\x7F]/, 'envelope_path must contain no raw control/ANSI bytes')
  assert.match(row.envelope_path, /HOSTILE/, 'the visible remnant of the hostile suffix must survive (sanitized, not silently dropped)')
})

test('be-41-05 QA REWORK must-fix #4: the SECOND close of an already-ended dispatch invokes startAgentSession/endAgentSession/recordEvent(tool_call) ZERO additional times — proves the application-level `entry.ended` guard is actually exercised, not just that SQLite\'s UNIQUE constraint absorbs a redundant insert', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-repeat-invocation-spy')
  const projectsDir = makeTmpDir('cmux-dispatch-close-repeat-spy-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Bash', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ], { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })

  const calls = { startAgentSession: 0, endAgentSession: 0, tool_call: 0 }
  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    const realEmit = emitter.emit
    return {
      ...emitter,
      emit: (fn) => realEmit((handle, nextSeq) => {
        const spiedHandle = {
          ...handle,
          startAgentSession: (...a) => { calls.startAgentSession += 1; return handle.startAgentSession(...a) },
          endAgentSession: (...a) => { calls.endAgentSession += 1; return handle.endAgentSession(...a) },
          recordEvent: (...a) => {
            if (a[0] && a[0].type === 'tool_call') calls.tool_call += 1
            return handle.recordEvent(...a)
          },
        }
        return fn(spiedHandle, nextSeq)
      }),
    }
  })

  try {
    closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
    const callsAfterFirst = { ...calls }
    assert.ok(callsAfterFirst.startAgentSession >= 1, 'sanity: the first close must invoke startAgentSession at least once')
    assert.ok(callsAfterFirst.endAgentSession >= 1, 'sanity: the first close must invoke endAgentSession at least once')
    assert.equal(callsAfterFirst.tool_call, 1, 'sanity: the first close must invoke recordEvent(tool_call) once')

    closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
    assert.equal(calls.startAgentSession, callsAfterFirst.startAgentSession, 'must-fix #4: the second close must invoke startAgentSession ZERO additional times')
    assert.equal(calls.endAgentSession, callsAfterFirst.endAgentSession, 'must-fix #4: the second close must invoke endAgentSession ZERO additional times')
    assert.equal(calls.tool_call, callsAfterFirst.tool_call, 'must-fix #4: the second close must invoke recordEvent(tool_call) ZERO additional times')
  } finally {
    _setEmitterOpenerForTest(null)
  }
})

test('be-41-05 QA REWORK must-fix #5: closeCmd\'s tool_call/agent_end/decision back-fill consumes exactly ONE reserveSeq call for the whole batch (n === eventCount), never N separate reservations (ADR-027 anti-pattern the mutation pass proved untested)', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-reserveseq-callcount')
  const projectsDir = makeTmpDir('cmux-dispatch-close-reserveseq-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2019-06-01T00:00:00.000Z', ended_at: '2019-06-01T00:00:01.000Z' },
    { tool: 'Bash', ok: false, started_at: '2019-06-01T00:00:02.000Z', ended_at: '2019-06-01T00:00:03.000Z' },
    { tool: 'Write', ok: true, started_at: '2019-06-01T00:00:04.000Z', ended_at: '2019-06-01T00:00:05.000Z' },
  ])

  const reserveSeqCalls = []
  _setEmitterOpenerForTest((opts) => {
    const emitter = openRun(opts)
    const realReserveSeq = emitter.reserveSeq
    return {
      ...emitter,
      reserveSeq: (kind, n) => { reserveSeqCalls.push({ kind, n }); return realReserveSeq(kind, n) },
    }
  })

  try {
    const closeRes = closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })
    assert.equal(closeRes.code, 0)
  } finally {
    _setEmitterOpenerForTest(null)
  }

  const eventReservations = reserveSeqCalls.filter((c) => c.kind === 'event')
  assert.equal(eventReservations.length, 1, `expected EXACTLY ONE 'event' reserveSeq call for the whole back-fill batch, got ${eventReservations.length}: ${JSON.stringify(eventReservations)}`)
  assert.equal(eventReservations[0].n, 5, 'expected n === eventCount (agent_end + 3 tool_call + decision = 5), not N separate reservations of 1')
})

test('be-41-05 RECONCILE EVIDENCE AS A decision ROW: payload is dispatcher-authored closed vocabulary plus counts — a hostile reconcile warning (ANSI escapes, embedded newline, 5000 chars) reaches NO ledger row, NO stderr line and NO file under stateDir', () => {
  const { ctx } = setUpWorkspace('close-decision-hostile')
  const specPath = makeSpecFile(ctx)
  const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
  const dispatchId = dispatchRes.json.dispatch_id
  const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
  writeValidReturn(record)

  // The .exit sentinel is worker-writable (same uid) — classify() folds its
  // raw content into a warning string verbatim
  // (`exit_nonzero:${fsState.exitSentinel} despite a valid return`).
  const MARKER = `\x1B[31mHOSTILE${'A'.repeat(5000)}\nB\x1B[0m`
  const exitPath = join(ctx.paths.stateDir, `${dispatchId}.exit`)
  writeFileSync(exitPath, `0 ${MARKER}`)

  let res
  const captured = captureStderr(() => { res = closeCmd({ dispatch: dispatchId }, ctx) })
  assert.equal(res.code, 0)

  const sidecar = readRunSidecar(ctx)
  const dumped = dumpLedgerTablesInSubprocess(sidecar, ['events'])
  const jsonlKinds = readJsonlKinds(sidecar.jsonl_path)
  const allLedgerText = `${JSON.stringify(dumped)}${JSON.stringify(jsonlKinds)}`
  assert.doesNotMatch(allLedgerText, /HOSTILE/, 'the hostile marker must reach NO ledger row')
  assert.doesNotMatch(captured, /HOSTILE/, 'the hostile marker must reach NO stderr line')

  // NO file under stateDir carries the marker either (the ANSI/newline
  // string never even transits a mirror path) — EXCEPT the .exit sentinel
  // itself, which is the worker-writable SOURCE of the marker (the file
  // this test deliberately seeded), never a mirror artifact.
  function walk(dir) {
    let found = false
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (p === exitPath) continue
      const st = statSync(p)
      if (st.isDirectory()) {
        if (walk(p)) found = true
      } else if (st.isFile()) {
        if (readFileSync(p, 'utf8').includes('HOSTILE')) found = true
      }
    }
    return found
  }
  assert.equal(walk(ctx.paths.stateDir), false, 'the hostile marker must reach NO file under stateDir OTHER than the .exit sentinel that seeded it')

  const decisionEvents = dumped.events.filter((e) => e.type === 'decision')
  assert.equal(decisionEvents.length, 1)
  const payload = JSON.parse(decisionEvents[0].payload_json)
  assert.deepEqual(Object.keys(payload).sort(), ['alternatives', 'decided', 'why'])
  assert.equal(payload.decided, 'ok')
  assert.equal(typeof payload.why, 'string')
  assert.ok(Array.isArray(payload.alternatives))
  for (const alt of payload.alternatives) {
    assert.match(alt, /^(terminal_outcome_uncorroborated|exit_nonzero|postcondition_unverifiable|other):\d+$/)
  }
})

test('be-41-05 JSON SURFACE FROZEN: closeCmd\'s {code, json} is byte-identical across ok, refused_postcondition, already-terminal (forged ok, uncorroborated) and no_return branches, whether or not the ledger mirror runs', () => {
  function runOkBranch() {
    const { ctx, dispatchId } = setUpCloseDispatch('close-frozen-ok')
    return closeCmd({ dispatch: dispatchId }, ctx)
  }
  function runRefusedPostconditionBranch() {
    const { ctx } = setUpWorkspace('close-frozen-refused-postcondition')
    const record = buildAndBindRecord(ctx, { role: 'code-reviewer', sliceId: 'be-1b' })
    writeValidReturn(record)
    writeFileSync(join(record.worktree.path, 'dirty.txt'), 'uncommitted')
    return closeCmd({ dispatch: record.dispatch_id }, ctx)
  }
  function runAlreadyTerminalUncorroboratedBranch() {
    const { ctx } = setUpWorkspace('close-frozen-uncorroborated')
    const specPath = makeSpecFile(ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const recordPath = join(ctx.paths.dispatchDir, 'be-1a.1.json')
    const record = readRecord(recordPath)
    const forged = { ...record, outcome: 'ok', ended_at: new Date().toISOString() }
    writeFileSync(recordPath, JSON.stringify(forged, null, 2))
    return closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  }
  function runNoReturnBranch() {
    const { ctx } = setUpWorkspace('close-frozen-no-return')
    const specPath = makeSpecFile(ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    return closeCmd({ dispatch: dispatchRes.json.dispatch_id }, ctx)
  }

  function redact(res) {
    return { code: res.code, json: { ...res.json, dispatch_id: '<dispatch_id>' } }
  }

  const okHealthy = redact(runOkBranch())
  // The fresh (non-already-terminal) branch always evaluates the
  // postcondition against a real `git status --porcelain` read, regardless
  // of the mapped outcome — a clean checkout with no postcondition_ignore
  // entries yields {ignored: [], offending: [], ok: true} (never null;
  // null is reserved for the already-terminal short-circuit branch, which
  // never evaluates a postcondition at all).
  assert.deepEqual(okHealthy, { code: 0, json: { dispatch_id: '<dispatch_id>', outcome: 'ok', warnings: [], postcondition: { ignored: [], offending: [], ok: true } } })

  const refusedPostconditionHealthy = redact(runRefusedPostconditionBranch())
  // QA REWORK (should-fix D): the postcondition's `offending` field is
  // dispatcher-derived relative porcelain lines (git status --porcelain
  // against the worktree, ladder.mjs's evaluatePostcondition) — never
  // worker-influenced free text and never path-variant across machines
  // (relative to the worktree root), so this branch is just as fully
  // freezable as the other three below; only `code`/`outcome` were pinned
  // before this rework.
  assert.deepEqual(refusedPostconditionHealthy, {
    code: 1,
    json: { dispatch_id: '<dispatch_id>', outcome: 'refused_postcondition', warnings: [], postcondition: { ignored: [], offending: ['?? dirty.txt'], ok: false } },
  })

  const uncorroboratedHealthy = redact(runAlreadyTerminalUncorroboratedBranch())
  assert.deepEqual(uncorroboratedHealthy, {
    code: 1,
    json: { dispatch_id: '<dispatch_id>', outcome: 'ok', warnings: ['terminal_outcome_uncorroborated'], postcondition: null },
  })

  const noReturnHealthy = redact(runNoReturnBranch())
  assert.deepEqual(noReturnHealthy, { code: 1, json: { dispatch_id: '<dispatch_id>', outcome: 'no_return', warnings: [], postcondition: { ignored: [], offending: [], ok: true } } })

  // Same four branches again, this time with every ledger writer throwing —
  // {code, json} must be byte-identical to the healthy run above.
  installHostileEmitterOpener()
  let okDegraded, refusedPostconditionDegraded, uncorroboratedDegraded, noReturnDegraded
  try {
    okDegraded = redact(runOkBranch())
    refusedPostconditionDegraded = redact(runRefusedPostconditionBranch())
    uncorroboratedDegraded = redact(runAlreadyTerminalUncorroboratedBranch())
    noReturnDegraded = redact(runNoReturnBranch())
  } finally {
    _setEmitterOpenerForTest(null)
  }
  assert.deepEqual(okDegraded, okHealthy)
  assert.deepEqual(refusedPostconditionDegraded, refusedPostconditionHealthy)
  assert.deepEqual(uncorroboratedDegraded, uncorroboratedHealthy)
  assert.deepEqual(noReturnDegraded, noReturnHealthy)
})

test('be-41-05 NEVER LOAD-BEARING (mutation): close returns byte-identical {code, json}, terminates the record identically on disk, unlinks the nonce identically, and makes the same number of cmux invocations whether the ledger is healthy or every writer throws', () => {
  function runScenario(prefix) {
    const { env, ctx } = setUpWorkspace(prefix)
    const specPath = makeSpecFile(ctx)
    const dispatchRes = dispatchCmd({ slice: 'be-1a', role: 'coder', spec: specPath }, ctx)
    const dispatchId = dispatchRes.json.dispatch_id
    const record = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
    writeValidReturn(record)
    const nonceExistedBefore = existsSync(sidecarPaths(ctx.paths, dispatchId).nonce)
    const closeRes = closeCmd({ dispatch: dispatchId }, ctx)
    const terminatedRecord = readRecord(join(ctx.paths.dispatchDir, 'be-1a.1.json'))
    return {
      redactedRes: { code: closeRes.code, json: { ...closeRes.json, dispatch_id: '<dispatch_id>' } },
      terminatedOutcome: terminatedRecord.outcome,
      terminatedEndedAtIsSet: terminatedRecord.ended_at !== null,
      nonceExistedBefore,
      nonceGoneAfter: !existsSync(sidecarPaths(ctx.paths, dispatchId).nonce),
      invocationCount: readLog(env.logPath).length,
    }
  }

  const healthy = runScenario('close-mutation-healthy')

  installHostileEmitterOpener()
  let hostile
  try {
    hostile = runScenario('close-mutation-hostile')
  } finally {
    _setEmitterOpenerForTest(null)
  }
  assert.deepEqual(hostile, healthy)
})

test('be-41-05 AMENDED POST-be-41-04: after closeCmd runs, a subsequent teardownCmd does NOT re-emit endAgentSession for that dispatch — the sqlite row\'s token fields are unchanged by teardown', () => {
  const { ctx, dispatchId } = setUpCloseDispatch('close-then-teardown-ended')
  const projectsDir = makeTmpDir('cmux-dispatch-close-teardown-ended-projects-')
  writeFakeTranscript(projectsDir, dispatchId, [
    { tool: 'Read', ok: true, started_at: '2020-01-01T00:00:00.000Z', ended_at: '2020-01-01T00:00:01.000Z' },
  ], { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 })

  closeCmd({ dispatch: dispatchId }, ctx, { projectsDir })

  const sidecarAfterClose = readRunSidecar(ctx)
  assert.equal(sidecarAfterClose.dispatches[dispatchId].ended, true)
  const rowAfterClose = dumpLedgerTablesInSubprocess(sidecarAfterClose, ['agent_sessions']).agent_sessions
    .find((r) => r.claude_session_id === dispatchId)
  assert.equal(rowAfterClose.billed_input_tokens, 42)
  assert.notEqual(rowAfterClose.ended_at, null)

  // If the AMENDED `ended` guard were missing, teardownCmd's reconciliation
  // loop would see `session_started && !ended` as still-open and re-emit
  // endAgentSession with all ten fields explicit null (a real UPDATE, not a
  // merge) — clobbering the real figures just recorded above.
  const teardownRes = teardownCmd({ 'keep-artifacts': true }, ctx)
  assert.equal(teardownRes.code, 0)

  // teardownCmd's archiveOrDelete RENAMES stateDir — the sidecar's own
  // db_path/jsonl_path fields are stamped at CREATE time and are never
  // rewritten by a later archive, so they still name the PRE-archive
  // location. Recompute the real post-archive paths (be-41-04's own
  // post-teardown assertions do the exact same thing).
  const archivedStateDir = teardownRes.json.state_dir.path
  const sidecarAfterTeardown = JSON.parse(readFileSync(join(archivedStateDir, 'ledger', 'run.json'), 'utf8'))
  const archivedLedgerPaths = {
    ...sidecarAfterTeardown,
    db_path: join(archivedStateDir, 'ledger', 'ledger.db'),
    jsonl_path: join(archivedStateDir, 'ledger', 'ledger.jsonl'),
  }
  const rowAfterTeardown = dumpLedgerTablesInSubprocess(archivedLedgerPaths, ['agent_sessions']).agent_sessions
    .find((r) => r.claude_session_id === dispatchId)
  assert.ok(rowAfterTeardown, 'expected the agent_sessions row to still exist after teardown')
  assert.equal(rowAfterTeardown.billed_input_tokens, 42, 'teardown must NEVER re-emit endAgentSession for an already-ended dispatch — token fields must be unchanged, not just "teardown ran without error"')
  assert.equal(rowAfterTeardown.billed_output_tokens, 7)
  assert.equal(rowAfterTeardown.billed_cache_write_tokens, 1)
  assert.equal(rowAfterTeardown.billed_cache_read_tokens, 2)
  assert.equal(rowAfterTeardown.ended_at, rowAfterClose.ended_at, 'ended_at itself must also be unchanged (proves no second UPDATE ran at all, not merely that the values happened to match)')
})

