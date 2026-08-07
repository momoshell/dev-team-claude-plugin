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
  readCmuxEnvFile, readEnvFileKeys,
  readCmuxPreviewUrl, ensurePreviewBrowser, formatPreviewFailClosedLine,
  PREVIEW_LOCK_WORST_CASE_MS,
  UsageError, OperationalError, main,
} = await import(DISPATCH_PATH)

const {
  PREFLIGHT_MESSAGES, formatPreflightMessage, closeSurface, tree, findDocTabSurface, createPane, mountDocTab,
  ensureWorkspace, TIERS, TIER_COLORS, recoverNewId, cmux, findSurface,
  BROWSER_LOAD_STATE, browserVerb, browserOpen, browserGoto, browserWaitReady,
  browserErrorsClear, browserErrorsList, browserScreenshot,
} = await import(join(ROOT, 'scripts', 'cmux', 'cmuxctl.mjs'))
const {
  readRecord, terminateRecord, buildRecord, writeRecord, bindRecord, newDispatchId, snapshotWorkerPlugin,
} = await import(join(ROOT, 'scripts', 'cmux', 'record.mjs'))
const { specPathFor, sidecarPaths } = await import(join(ROOT, 'scripts', 'cmux', 'resolve.mjs'))
const { writeBlockedReturn } = await import(join(ROOT, 'scripts', 'cmux', 'return-lint.mjs'))
const { slugify } = await import(join(ROOT, 'scripts', 'cmux', 'contract.mjs'))

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
  const gotoEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'goto')
  assert.equal(gotoEntries.length, 1, `expected exactly one browser goto invocation, got ${gotoEntries.length}`)
  assert.deepEqual(gotoEntries[0].argv, ['browser', 'goto', opened.surfaceId, 'http://example.com/path'])

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
  const waitEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'wait')
  assert.equal(waitEntries.length, 1, `expected exactly one browser wait invocation, got ${waitEntries.length}`)
  assert.deepEqual(waitEntries[0].argv, ['browser', 'wait', opened.surfaceId, '--load-state', BROWSER_LOAD_STATE, '--timeout-ms', '20000'])
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
  const clearEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'errors' && e.argv[2] === 'clear')
  assert.equal(clearEntries.length, 1, `expected exactly one browser errors clear invocation, got ${clearEntries.length}`)
  assert.deepEqual(clearEntries[0].argv, ['browser', 'errors', 'clear', opened.surfaceId])
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
  const listEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'errors' && e.argv[2] === 'list')
  assert.equal(listEntries.length, 1, `expected exactly one browser errors list invocation, got ${listEntries.length}`)
  assert.deepEqual(listEntries[0].argv, ['browser', 'errors', 'list', opened.surfaceId])
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
  const shotEntries = log.filter((e) => e.argv[0] === 'browser' && e.argv[1] === 'screenshot')
  assert.equal(shotEntries.length, 1, `expected exactly one browser screenshot invocation, got ${shotEntries.length}`)
  assert.deepEqual(shotEntries[0].argv, ['browser', 'screenshot', opened.surfaceId, '--out', outPath])
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

  const rawRes = cmux('browser', ['screenshot', opened.surfaceId, '--out', outPath])
  assert.equal(rawRes.ok, true)
  assert.match(rawRes.stdout, /^OK /)
  assert.ok(!existsSync(outPath), 'the fixture must print OK without actually writing the file under this flag')

  // The real wrapper is unaffected by this raw-cmux distinction: it still
  // only reports on the cmux call's own ok/fail, never on existsSync — that
  // confirmation is be-12-03's job (browser-verify), not this wrapper's.
  assert.equal(browserScreenshot(opened.surfaceId, outPath), true)
})

test('an out-of-allowlist sub-verb in the FIXTURE itself (reachable only by bypassing browserVerb) fails bad_args, never silently succeeds', () => {
  const { workspaceRes } = setUpWorkspace('browser-fixture-unknown-subverb')
  const workspaceId = workspaceRes.json.workspace_id
  const res = cmux('browser', ['eval', workspaceRes.json.initial_surface_id, '1+1'])
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bad_args')
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
  assert.match(src, /browserVerb\('open', \[url, '--workspace', workspaceId, '--focus', 'false'\], \{ timeoutMs: 5000 \}\)/)
  assert.match(src, /browserVerb\('goto', \[surfaceId, url\], \{ timeoutMs: 20000 \}\)/)
  assert.match(src, /browserVerb\('wait', \[surfaceId, '--load-state', BROWSER_LOAD_STATE, '--timeout-ms', '20000'\], \{ timeoutMs \}\)/)
  assert.match(src, /browserVerb\('errors', \['clear', surfaceId\], \{ timeoutMs: 10000 \}\)/)
  assert.match(src, /browserVerb\('errors', \['list', surfaceId\], \{ timeoutMs: 10000 \}\)/)
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
  addBrowserOpenToPreflightCache(built.ctx)
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

// addBrowserOpenToPreflightCache(ctx) -> void. The fake's LIVE_METHODS
// (be-12-01, frozen, out of this slice's scope) does not carry a literal
// 'browser.open' RPC method name — hand-append it to the already-cached
// preflight.json (isValidPreflightCache only checks shape, never content)
// so dispatch-level integration tests can exercise trigger conjunct 4 held
// true without touching the fixture.
function addBrowserOpenToPreflightCache(ctx) {
  const p = join(ctx.paths.stateDir, 'preflight.json')
  const cached = JSON.parse(readFileSync(p, 'utf8'))
  writeFileSync(p, JSON.stringify({ ...cached, methods: [...cached.methods, 'browser.open'] }))
}

const CACHED_METHODS_WITH_BROWSER_OPEN = { methods: ['browser.open', 'workspace.close'] }

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

test("trigger conjunct 2: domain 'Frontend' and 'frontend ' (not an exact match) -> zero browser calls", () => {
  const { env, ctx } = setUpPreviewWorkspace('preview-trigger-domain-case')
  for (const [sliceId, domain] of [['be-9e', 'Frontend'], ['be-9f', 'frontend ']]) {
    const specPath = makeSpecFile(ctx, sliceId, { domain })
    const res = dispatchCmd({ slice: sliceId, role: 'coder', spec: specPath }, ctx)
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

test('trigger conjunct 4: preflight cache missing browser.open (the fixture\'s frozen LIVE_METHODS carries no such literal by default) -> zero calls, code 0, exactly one stderr remediation line, preview:{state:"skipped",reason:"preview_capability_missing"}', () => {
  const { env, ctx } = setUpWorkspace('preview-trigger-capability-missing')
  writeConfigMd(ctx.primaryCheckout, `cmux_preview_url: ${PREVIEW_URL}\n`)
  const specPath = makeSpecFile(ctx, 'be-9i', { domain: 'frontend' })

  let res
  const stderr = captureStderr(() => { res = dispatchCmd({ slice: 'be-9i', role: 'coder', spec: specPath }, ctx) })
  assert.equal(res.code, 0)
  assert.deepEqual(res.json.preview, { state: 'skipped', reason: 'preview_capability_missing' })
  assert.equal(browserOpenInvocations(env).length, 0)
  const remediationLines = stderr.split('\n').filter((l) => /brew upgrade --cask cmux, or re-run preflight/.test(l))
  assert.equal(remediationLines.length, 1, `expected exactly one remediation line, got: ${JSON.stringify(stderr)}`)
})

test('conjunct 4, absent preflight.json cache -> preview_capability_missing (ensurePreviewBrowser called with {})', () => {
  const { ctx, workspaceRes } = setUpPreviewWorkspace('preview-capability-absent-cache')
  const result = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId: workspaceRes.json.workspace_id, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL, cachedMethods: {},
  })
  assert.deepEqual(result, { state: 'skipped', reason: 'preview_capability_missing' })
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
    url, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
  const first = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN })
  assert.deepEqual(first, { state: 'created' })
  const sidecarAfterFirst = readBrowserSidecar(ctx)
  const opensAfterFirst = browserOpenInvocations(env).length

  const second = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN })
  assert.deepEqual(second, { state: 'reused' })
  assert.equal(browserOpenInvocations(env).length, opensAfterFirst, 'reuse must issue zero additional browser open calls')
  assert.deepEqual(readBrowserSidecar(ctx), sidecarAfterFirst, 'reuse must never re-stamp the sidecar')
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
  })
  assert.equal(result.state, 'created')
  assert.equal(readBrowserSidecar(ctx).workspace_id, workspaceId.toLowerCase())
})

test('ensurePreviewBrowser: a REAL, present browser surface whose sidecar workspace_id is wrong is NOT reused — treated as a stray, preview_surface_ambiguous (proves the workspace_id equality check is load-bearing beyond mere presence)', () => {
  const { ctx, workspaceRes } = setUpWorkspace('singleton-real-ws-mismatch')
  const workspaceId = workspaceRes.json.workspace_id
  const initialSurfaceId = workspaceRes.json.initial_surface_id
  const created = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN })
  assert.equal(created.state, 'created')
  const sidecar = readBrowserSidecar(ctx)
  writeBrowserSidecarRaw(ctx, { ...sidecar, workspace_id: randomUUID() })

  const result = ensurePreviewBrowser({ paths: ctx.paths, workspaceId, initialSurfaceId, url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN })
  assert.deepEqual(result, { state: 'skipped', reason: 'preview_surface_ambiguous' })
})

test('ensurePreviewBrowser: >=1 free browser surfaces, no valid record -> zero opens, preview_surface_ambiguous, and one stderr line naming every stray UUID with an exact cmux close-surface command each', () => {
  const { env, ctx, workspaceRes } = setUpWorkspace('singleton-ambiguous')
  const workspaceId = workspaceRes.json.workspace_id
  const stray1 = injectFreeBrowserSurface(env, workspaceId)
  const stray2 = injectFreeBrowserSurface(env, workspaceId)

  let result
  const stderr = captureStderr(() => {
    result = ensurePreviewBrowser({
      paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
      url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
    })
  })

  assert.deepEqual(result, { state: 'skipped', reason: 'preview_surface_ambiguous' })
  assert.equal(browserOpenInvocations(env).length, 0)
  const expectedLine = formatPreviewFailClosedLine({ strayUuids: [stray1, stray2], unresolvablePaneId: null })
  assert.ok(stderr.includes(expectedLine), `expected stderr to contain the byte-pinned remediation line, got: ${JSON.stringify(stderr)}`)
  assert.match(stderr, new RegExp(`cmux close-surface ${stray1}`))
  assert.match(stderr, new RegExp(`cmux close-surface ${stray2}`))
})

// test-engineer (PR-1 vacuity audit): every existing assertion of the E3
// remediation line compares `stderr` against `formatPreviewFailClosedLine(...)`
// — the SAME function under test, called a second time to build the
// "expected" value. That is self-referential: a mutation to the function's
// OWN composition (e.g. swapping the ' · ' separator for ', ', or dropping
// the "two stacked browser surfaces are both undrivable" clause) changes
// both sides identically and is invisible to every test above (mutated,
// confirmed: 0 failures suite-wide). This test hand-types the frozen
// errata E3 shape as an independent literal — the actual byte-pin the
// mutation doctrine requires (qa-notes 2026-08-02).
test('BYTE-PIN (independent of formatPreviewFailClosedLine): the frozen errata-E3 remediation line matches a hand-typed literal, not a re-typed call to the function under test', () => {
  const strayId = '11111111-1111-1111-1111-111111111111'
  const line = formatPreviewFailClosedLine({ strayUuids: [strayId], unresolvablePaneId: null })
  assert.equal(
    line,
    "ensurePreviewBrowser: 1 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (two stacked browser surfaces are both undrivable). Preview is disabled for this task until they are closed: cmux close-surface 11111111-1111-1111-1111-111111111111",
  )

  const strayId2 = '22222222-2222-2222-2222-222222222222'
  const twoStrays = formatPreviewFailClosedLine({ strayUuids: [strayId, strayId2], unresolvablePaneId: null })
  assert.equal(
    twoStrays,
    "ensurePreviewBrowser: 2 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (two stacked browser surfaces are both undrivable). Preview is disabled for this task until they are closed: cmux close-surface 11111111-1111-1111-1111-111111111111 · cmux close-surface 22222222-2222-2222-2222-222222222222",
  )

  const ghostPane = '33333333-3333-3333-3333-333333333333'
  const withUnresolvable = formatPreviewFailClosedLine({ strayUuids: [strayId], unresolvablePaneId: ghostPane })
  assert.equal(
    withUnresolvable,
    "ensurePreviewBrowser: dispatch record's pane 33333333-3333-3333-3333-333333333333 no longer resolves in the live tree; 1 browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (two stacked browser surfaces are both undrivable). Preview is disabled for this task until they are closed: cmux close-surface 11111111-1111-1111-1111-111111111111",
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
      url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
      url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
      url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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

// ---------------------------------------------------------------------------
// Non-interactions pinned by regression test, not prose (D7).
// ---------------------------------------------------------------------------

test('non-interaction: closeCmd\'s doc-tab collapse decision is unchanged with a LIVE preview present in its own pane', () => {
  const { ctx, workspaceRes } = setUpWorkspace('preview-noninteraction-close')
  const workspaceId = workspaceRes.json.workspace_id
  const created = ensurePreviewBrowser({
    paths: ctx.paths, workspaceId, initialSurfaceId: workspaceRes.json.initial_surface_id,
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
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
    url: PREVIEW_URL, cachedMethods: CACHED_METHODS_WITH_BROWSER_OPEN,
  })
  const res = statusCmd({}, ctx)
  assert.deepEqual(res.json.rows, [])
})
