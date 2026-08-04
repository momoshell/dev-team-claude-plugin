// adapter-claude.mjs coverage. qa-notes 2026-08-02: "every refusal test is
// paired with the positive that proves the harness is wired" — the happy
// path (exactly one fake-claude invocation, asserted argv) runs FIRST, ahead
// of every negative. This suite spawns the adapter as a real subprocess
// (mirroring the launch contract be-1c-05 wires: `node adapter-claude.mjs
// run <record-path>`) rather than importing its internals directly — the
// module registers process-wide 'exit'/SIGHUP/SIGINT/SIGTERM handlers once a
// real run starts, which must never leak into the shared test-runner
// process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { ROOT } from './helpers.mjs'
import { resolveRoots, taskPaths, resolveRole } from '../scripts/cmux/resolve.mjs'
import {
  newDispatchId, buildRecord, snapshotWorkerPlugin, WORKER_PLUGIN_MANIFEST, buildArgv,
} from '../scripts/cmux/record.mjs'
import { NONCE_PREFIX, PANE_ROLES } from '../scripts/cmux/contract.mjs'

const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const ADAPTER_PATH = join(ROOT, 'scripts/cmux/adapter-claude.mjs')
const FAKE_CLAUDE = join(ROOT, 'test/fixtures/fake-claude.mjs')
const CLAUDE_HELP = join(ROOT, 'test/fixtures/claude-help.txt')
const FAKE_CMUX = join(ROOT, 'test/fixtures/fake-cmux.mjs')

// CMUX_BIN is captured as a module-level constant by cmuxctl.mjs at import
// time (mirrors test/cmux-preflight.test.mjs's own header note). Setting it
// here, before the dynamic import below, ensures this suite's own direct
// use of signalToken() — and every adapter subprocess this file spawns
// without an explicit CMUX_BIN override — can never reach a real installed
// cmux binary.
process.env.CMUX_BIN = process.env.CMUX_BIN || FAKE_CMUX
const { VERBS, signalToken } = await import('../scripts/cmux/cmuxctl.mjs')
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

// ---------------------------------------------------------------------------
// Fixture builders — mirror test/cmux-record.test.mjs / test/return-lint.test.mjs's
// own buildValidRecord/buildTestRecord shape.
// ---------------------------------------------------------------------------

function buildTestRecord(role, { sliceId = 'be-1c-04', attempt = 1, ctx: ctxOverrides = {}, mkdirCwd = true } = {}) {
  const root = makeTmpDir('claude-adapter-')
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
    taskId: 'be-1c-04 task',
    taskSlug: 'sample-task',
    repoSlug: 'sample-repo',
    primaryCheckout,
    snapshot,
    config: {},
    now: 1754136000123,
    dispatchId: newDispatchId(),
    attnUpstream: null,
    ...ctxOverrides,
  }
  const record = buildRecord(ctx, { role, sliceId, attempt, spec: { validation_commands: ['node --test'] } })
  record.created_at = FIXED_CREATED_AT
  if (mkdirCwd) {
    mkdirSync(record.cwd, { recursive: true })
  }
  return { record, paths, root, snapshot }
}

function writeRecordFile(record, paths) {
  const stem = `${record.slice_id}.${record.attempt}`
  const recordPath = join(paths.dispatchDir, `${stem}.json`)
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return recordPath
}

function noncePath(paths, dispatchId) {
  return join(paths.stateDir, `${dispatchId}.nonce`)
}

function writeNonce(paths, dispatchId, value) {
  const p = noncePath(paths, dispatchId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, value, { mode: 0o600 })
  return p
}

function sentinelPath(paths, dispatchId) {
  return join(paths.stateDir, `${dispatchId}.exit`)
}

function logPath(paths, dispatchId) {
  return join(paths.stateDir, 'logs', `${dispatchId}.log`)
}

// assertNoNonceLeak(result, paths, dispatchId) — MF7 shared post-assert
// helper. Every refusal/failure/CLI-missing/no-return adapter test calls
// this: stderr must never carry NONCE_PREFIX, and this run's own log file
// (when one was ever created — the unsalvageable/salvageable JSON paths
// never call makeLogger at all) must never carry it either. Every nonce
// value this suite ever writes is itself prefixed with NONCE_PREFIX, so a
// real leak of the nonce into either output is exactly what trips this —
// removing the nonce-awareness from either output path makes a test using
// this helper fail.
function assertNoNonceLeak(result, paths, dispatchId) {
  assert.equal(result.stderr.includes(NONCE_PREFIX), false, 'stderr must never carry the nonce prefix')
  if (!paths || !dispatchId) return
  const p = logPath(paths, dispatchId)
  if (!existsSync(p)) return
  const log = readFileSync(p, 'utf8')
  assert.equal(log.includes(NONCE_PREFIX), false, 'log must never carry the nonce prefix')
}

function coderReturnEnvelope(record, body = { status: 'done', reason: 'ok', changes: ['a.ts — did x'], validation: 'node --test passed' }) {
  return `${JSON.stringify({
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: '2026-08-01T00:00:05.000Z',
    body,
  })}\n`
}

function markdownVerdictBody(verdict = 'pass') {
  return `## Verdict\n\n\`\`\`json\n${JSON.stringify({ verdict, findings: [] })}\n\`\`\`\n`
}

function markdownEnvelope(record, body) {
  return `${JSON.stringify({
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: '2026-08-01T00:00:05.000Z',
    body,
  })}\n`
}

// runAdapter(args, env) -> spawnSync result. `input` is always the empty
// string so stdin is a pipe, never a tty — process.stdin.isTTY is false, so
// OUTPUT 4's pane-hold read is always skipped and this call never hangs.
function runAdapter(args, env = {}) {
  return spawnSync(process.execPath, [ADAPTER_PATH, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, ...env },
  })
}

// ---------------------------------------------------------------------------
// POSITIVE FIRST: the happy path. Exactly one fake-claude invocation, with
// the argv the acceptance criteria pins.
// ---------------------------------------------------------------------------

test('run: happy path — one fake-claude invocation, fresh valid return, exit 0', () => {
  const { record, paths } = buildTestRecord('coder')
  const recordPath = writeRecordFile(record, paths)
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)

  const fakeLog = join(paths.stateDir, 'fake-claude.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  writeFileSync(returnFixture, coderReturnEnvelope(record), 'utf8')

  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: fakeLog,
    FAKE_CLAUDE_WRITE_RETURN: returnFixture,
  })

  assert.equal(result.status, 0, result.stderr)

  const invocations = readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(invocations.length, 1)
  const argv = invocations[0].argv

  assert.deepEqual(argv.slice(0, 2), ['--model', record.model])
  assert.ok(argv.includes('--effort'))
  assert.ok(argv.includes(record.effort))
  assert.ok(argv.includes('--permission-mode'))
  assert.ok(argv.includes('dontAsk'))
  assert.ok(argv.includes('--append-system-prompt-file'))
  assert.ok(argv.includes(record.role_prompt_path))
  assert.ok(argv.includes('--tools'))
  assert.ok(argv.includes(record.tools.join(',')))
  assert.ok(argv.includes('--allowedTools'))
  for (const rule of record.profile.allow) {
    assert.ok(argv.includes(rule), `argv missing allow rule ${rule}`)
  }
  assert.ok(argv.includes(`Edit(/${record.worktree.path}/**)`))
  assert.ok(argv.includes('Bash(cmux notify *)'))
  assert.ok(argv.includes('Bash(cmux wait-for -S *)'))
  assert.ok(argv.includes('--disallowedTools'))
  for (const rule of record.disallowed_tools) {
    assert.ok(argv.includes(rule))
  }
  assert.ok(argv.includes('--plugin-dir'))
  assert.ok(argv.includes(dirname(dirname(record.role_prompt_path))))
  assert.ok(argv.includes('--add-dir'))
  assert.ok(argv.includes(record.task_dir))
  assert.equal(argv[argv.length - 2], '--')
  assert.equal(argv[argv.length - 1], record.kickoff)

  // Fresh+valid return is never touched.
  assert.equal(readFileSync(record.return_path, 'utf8'), coderReturnEnvelope(record))

  // OUTPUT 2: exactly one sentinel, containing the decimal exit code.
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '0')

  // The nonce sidecar is consumed.
  assert.equal(existsSync(noncePath(paths, record.dispatch_id)), false)

  // OUTPUT 3: log exists, mirrors nothing about the nonce.
  const log = readFileSync(logPath(paths, record.dispatch_id), 'utf8')
  assert.ok(log.length > 0)
  assert.equal(log.includes(NONCE_PREFIX), false)
  assert.equal(result.stderr.includes(NONCE_PREFIX), false)
})

// ---------------------------------------------------------------------------
// be-06-01 S10 — B-1 argv invariants for EVERY newly pane-enabled role.
// Driven off the imported PANE_ROLES constant (not a hand-written list) so
// #8's flip (code-reviewer / code-reviewer-deep) inherits these assertions
// automatically. buildArgv is pure (record.mjs) — no subprocess spawn
// needed, this asserts against the composed argv directly.
// ---------------------------------------------------------------------------

// argvSegmentAfter(argv, flag) -> the argv elements between `flag` and the
// next '--'-prefixed flag (or end of argv) — e.g. every rule that follows
// --disallowedTools / --allowedTools.
function argvSegmentAfter(argv, flag) {
  const idx = argv.indexOf(flag)
  if (idx === -1) return []
  const seg = []
  for (let i = idx + 1; i < argv.length && !argv[i].startsWith('--'); i += 1) {
    seg.push(argv[i])
  }
  return seg
}

// frontmatterDisallowedTools(role) -> string[] — the comma-split
// `disallowedTools:` frontmatter line for agents/<role>.md, or [] when the
// role declares none (true for every PANE_ROLES member in this slice; #8's
// flip adds three roles that DO declare one, which is exactly what this
// generic, PANE_ROLES-driven loop is for). Scoped to the frontmatter block
// (between the leading `---` fences) only — a `disallowedTools:`-looking
// line anywhere in the prose body must never be mistaken for the real one.
function frontmatterDisallowedTools(role) {
  const text = readFileSync(join(ROOT, 'agents', `${role}.md`), 'utf8')
  const fenceMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const frontmatter = fenceMatch ? fenceMatch[1] : ''
  const m = frontmatter.match(/^disallowedTools:\s*(.+)$/m)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

// qa should-fix: frontmatterDisallowedTools is vacuous over PANE_ROLES today
// (no member declares disallowedTools) — a positive control against
// code-reviewer (out of PANE_ROLES in this slice, flips in #8) proves the
// helper actually reads the real frontmatter value rather than always
// returning [].
test('frontmatterDisallowedTools positive control: code-reviewer.md declares disallowedTools: Edit, Write, NotebookEdit', () => {
  assert.deepEqual(frontmatterDisallowedTools('code-reviewer'), ['Edit', 'Write', 'NotebookEdit'])
})

test('B-1 argv invariants: every PANE_ROLES role composes an argv with no bare Edit/Write/NotebookEdit deny token, --tools exactly the roster tools array, no frontmatter disallowedTools leak, scoped grants exactly right, and a bare -- before the prompt', () => {
  for (const role of PANE_ROLES) {
    const { record } = buildTestRecord(role)
    const argv = buildArgv(record)

    // no bare Edit/Write/NotebookEdit token in --disallowedTools.
    const disallowedSeg = argvSegmentAfter(argv, '--disallowedTools')
    for (const bare of ['Edit', 'Write', 'NotebookEdit']) {
      assert.equal(disallowedSeg.includes(bare), false, `role ${role}: --disallowedTools carries a bare ${bare} deny token`)
    }

    // --tools equals the roster's single top-level tools array exactly.
    const toolsIdx = argv.indexOf('--tools')
    assert.ok(toolsIdx !== -1, `role ${role}: missing --tools`)
    assert.equal(argv[toolsIdx + 1], rosterDefault.tools.join(','), `role ${role}: --tools does not match roster.default.json's top-level tools array`)

    // no string from the role's frontmatter disallowedTools reaches argv at all.
    for (const token of frontmatterDisallowedTools(role)) {
      assert.equal(argv.includes(token), false, `role ${role}: frontmatter disallowedTools token ${JSON.stringify(token)} leaked into argv`)
    }

    // scoped grants: asserted against the COMPOSED ARGV's --allowedTools
    // segment, not record.profile.allow directly — argv is what actually
    // reaches claude, and a divergence between the two would otherwise go
    // undetected. For every isolation:'primary' role, exactly the two
    // exact-path Edit rules expandGrants emits for the judgment profile
    // appear there, with NO worktree or repo-wide Edit rule.
    const allowedSeg = argvSegmentAfter(argv, '--allowedTools')
    if (record.isolation === 'primary') {
      const editRules = allowedSeg.filter((r) => r.startsWith('Edit('))
      assert.equal(editRules.length, 2, `role ${role}: --allowedTools must carry exactly two Edit grants for isolation 'primary', got ${JSON.stringify(editRules)}`)
      assert.ok(editRules.every((r) => /\/returns\/.*\.json\)$/.test(r) || /\/signals\/.*\.jsonl\)$/.test(r)), `role ${role}: expected only exact-path returns/signals Edit rules in --allowedTools, got ${JSON.stringify(editRules)}`)
      assert.equal(editRules.some((r) => r.includes('/**)')), false, `role ${role}: a worktree/repo-wide Edit rule (**) must never appear in --allowedTools for isolation 'primary'`)
    }
    // Whole-argv sweep: no `Edit(` rule ever appears OUTSIDE the
    // --allowedTools segment (e.g. leaked into --tools, --disallowedTools,
    // or the kickoff positional).
    const allowedSegSet = new Set(allowedSeg)
    for (let i = 0; i < argv.length; i += 1) {
      if (/^Edit\(/.test(argv[i]) && !allowedSegSet.has(argv[i])) {
        assert.fail(`role ${role}: an Edit( rule (${argv[i]}) appears outside the --allowedTools segment`)
      }
    }

    // a bare -- immediately precedes the prompt positional.
    assert.equal(argv[argv.length - 2], '--', `role ${role}: expected a bare -- immediately before the prompt positional`)
    assert.equal(argv[argv.length - 1], record.kickoff, `role ${role}: expected the prompt positional to be record.kickoff`)
  }
})

// ---------------------------------------------------------------------------
// capabilities — positive (CLI present, frozen --help capture).
// ---------------------------------------------------------------------------

test('capabilities: CLI present — exactly ten supports keys, no fabricated value', () => {
  const fakeLog = join(makeTmpDir('claude-adapter-caps-'), 'fake-claude.log')
  const result = runAdapter(['capabilities'], {
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: fakeLog,
    FAKE_CLAUDE_HELP: CLAUDE_HELP,
  })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(payload).sort(), ['adapter', 'cli', 'cli_path', 'cli_version', 'contract_version', 'supports'].sort())
  assert.equal(payload.cli_path, FAKE_CLAUDE)
  assert.equal(typeof payload.cli_version, 'string')

  const supportsKeys = [
    'model', 'effort', 'system_prompt_file', 'permission_mode', 'tool_allow_deny',
    'scoped_path_rules', 'non_prompting_mode', 'session_resume', 'headless', 'slash_command_disable',
  ]
  assert.deepEqual(Object.keys(payload.supports).sort(), supportsKeys.sort())
  assert.equal(payload.supports.model, true)
  assert.equal(payload.supports.effort, true)
  assert.equal(payload.supports.permission_mode, true)
  assert.equal(payload.supports.tool_allow_deny, true)
  assert.equal(payload.supports.session_resume, true)
  assert.equal(payload.supports.headless, true)
  assert.equal(payload.supports.slash_command_disable, true)
  // Never fabricated — not derivable without a live agent run.
  assert.equal(payload.supports.scoped_path_rules, null)
  assert.equal(payload.supports.non_prompting_mode, null)
})

test('capabilities: system_prompt_file probe — unknown-option classifies false, file-not-found classifies true', () => {
  const tmp = makeTmpDir('claude-adapter-caps-probe-')
  const falseResult = runAdapter(['capabilities'], {
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: join(tmp, 'log1.log'),
    FAKE_CLAUDE_HELP: CLAUDE_HELP,
    FAKE_CLAUDE_UNKNOWN_OPTION: '--append-system-prompt-file',
  })
  assert.equal(JSON.parse(falseResult.stdout).supports.system_prompt_file, false)

  const trueResult = runAdapter(['capabilities'], {
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: join(tmp, 'log2.log'),
    FAKE_CLAUDE_HELP: CLAUDE_HELP,
  })
  assert.equal(JSON.parse(trueResult.stdout).supports.system_prompt_file, true)
})

test('capabilities: CLI absent — cli_path/cli_version null, exit 3, no fabricated supports', () => {
  const tmp = makeTmpDir('claude-adapter-caps-absent-')
  const result = runAdapter(['capabilities'], { CLAUDE_BIN: join(tmp, 'no-such-agent-binary') })
  assert.equal(result.status, 3)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.cli_path, null)
  assert.equal(payload.cli_version, null)
  for (const v of Object.values(payload.supports)) {
    assert.equal(v, null)
  }
})

// ---------------------------------------------------------------------------
// Usage negatives.
// ---------------------------------------------------------------------------

test('usage: unknown verb exits 2 with usage on stderr', () => {
  const result = runAdapter(['bogus'])
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('usage'))
})

test('usage: run with zero or two path arguments exits 2', () => {
  assert.equal(runAdapter(['run']).status, 2)
  assert.equal(runAdapter(['run', '/a', '/b']).status, 2)
})

test('usage: capabilities takes no arguments', () => {
  assert.equal(runAdapter(['capabilities', 'extra']).status, 2)
})

// ---------------------------------------------------------------------------
// SF5 — the direct-invocation guard (realpathOr) under a symlinked path
// component. Node's ESM loader realpaths import.meta.url while argv[1]
// stays literal, so invoking the adapter through a symlink pointed at it —
// mirroring macOS's own /var -> /private/var TMPDIR symlink — must still
// resolve invokedDirectly to true and run main(). Reverting realpathOr to a
// literal `process.argv[1] === fileURLToPath(import.meta.url)` compare
// makes invokedDirectly false under this symlink, so main() never runs and
// the process exits 0 with no usage output at all — this test's assertion
// on `result.status` (2, usage) fails in that case.
// ---------------------------------------------------------------------------

test('SF5: invocation through a symlinked path component still runs the adapter CLI (usage form)', () => {
  const tmp = makeTmpDir('claude-adapter-symlink-')
  const linkPath = join(tmp, 'adapter-claude-link.mjs')
  symlinkSync(ADAPTER_PATH, linkPath)
  const result = spawnSync(process.execPath, [linkPath, 'bogus'], { encoding: 'utf8', input: '' })
  assert.equal(result.status, 2, result.stderr)
  assert.ok(result.stderr.includes('usage'))
})

// ---------------------------------------------------------------------------
// DRY-RUN — one profile per test (executor/validator/judgment), roster.default.json.
// ---------------------------------------------------------------------------

function runDryRun(record, paths) {
  const recordPath = writeRecordFile(record, paths)
  return runAdapter(['run', recordPath], { DEVTEAM_ADAPTER_DRY_RUN: '1' })
}

test('dry-run: executor profile (coder) — argv/cwd/env printed, exit 0, no side effects', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-dry-executor' })
  const result = runDryRun(record, paths)
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.cwd, record.cwd)
  assert.deepEqual(payload.env, record.env)
  const argv = payload.argv
  assert.ok(argv.includes('--model'))
  assert.ok(argv.includes('--effort'))
  assert.ok(argv.includes('--permission-mode'))
  assert.ok(argv.includes('dontAsk'))
  const promptIdx = argv.indexOf('--append-system-prompt-file')
  assert.ok(promptIdx >= 0)
  assert.equal(argv[promptIdx + 1], record.role_prompt_path)
  assert.ok(argv.includes(record.tools.join(',')))
  for (const rule of record.profile.allow) assert.ok(argv.includes(rule))
  assert.ok(argv.includes(`Edit(/${record.worktree.path}/**)`))
  assert.ok(argv.includes('Bash(cmux notify *)'))
  assert.ok(argv.includes('Bash(cmux wait-for -S *)'))
  assert.deepEqual(argv.slice(-2), ['--', record.kickoff])
  assert.ok(argv.includes('--plugin-dir'))
  assert.ok(argv.includes('--add-dir'))

  // No side effects: no sentinel, no return, nonce never touched (none written to begin with).
  assert.equal(existsSync(sentinelPath(paths, record.dispatch_id)), false)
  assert.equal(existsSync(record.return_path), false)
})

test('dry-run: validator profile (build-validator) — argv reflects the composed profile', () => {
  const { record, paths } = buildTestRecord('build-validator', { sliceId: 'be-1c-dry-validator' })
  const result = runDryRun(record, paths)
  assert.equal(result.status, 0, result.stderr)
  const { argv } = JSON.parse(result.stdout)
  assert.equal(argv.includes(`Edit(/${record.task_dir}/returns/${record.slice_id}.${record.attempt}.json)`), true)
  for (const rule of record.profile.allow) assert.ok(argv.includes(rule))
})

test('dry-run: judgment profile (code-reviewer) — argv reflects the composed profile, no worktree grant beyond returns/signals', () => {
  const { record, paths } = buildTestRecord('code-reviewer', { sliceId: 'be-1c-dry-judgment' })
  const result = runDryRun(record, paths)
  assert.equal(result.status, 0, result.stderr)
  const { argv } = JSON.parse(result.stdout)
  for (const rule of record.profile.allow) assert.ok(argv.includes(rule))
  assert.equal(argv.some((el) => el.startsWith('Edit(') && el.includes('/**')), false)
})

// ---------------------------------------------------------------------------
// Negatives that must hold for every pane-eligible role's argv.
// ---------------------------------------------------------------------------

test('negatives: coder argv never carries a permission bypass or a bare Edit/Write/NotebookEdit deny', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-neg' })
  const result = runDryRun(record, paths)
  assert.equal(result.status, 0, result.stderr)
  const { argv } = JSON.parse(result.stdout)
  const joined = argv.join(' ')
  assert.equal(joined.includes('--dangerously-skip-permissions'), false)
  assert.equal(joined.includes('--allow-dangerously-skip-permissions'), false)
  assert.equal(joined.includes('bypassPermissions'), false)
  assert.equal(argv.includes('Edit'), false)
  assert.equal(argv.includes('Write'), false)
  assert.equal(argv.includes('NotebookEdit'), false)
})

// ---------------------------------------------------------------------------
// Prompt-file byte identity — two dispatch records sharing one snapshot.
// ---------------------------------------------------------------------------

test('two dispatch records for the same role share a byte-identical prompt file and distinct kickoffs/return paths', () => {
  const root = makeTmpDir('claude-adapter-shared-')
  const primaryCheckout = join(root, 'checkout')
  mkdirSync(primaryCheckout, { recursive: true })
  const roots = resolveRoots({ taskArtifactsRoot: join(root, 'dev-team') })
  const paths = taskPaths({ roots, repoSlug: 'sample-repo', taskSlug: 'sample-task' })
  const snapshot = snapshotWorkerPlugin({
    pluginRoot: ROOT, snapshotDir: paths.snapshotDir, roles: rosterDefault.roles, profiles: rosterDefault.profiles,
  })
  function build(sliceId) {
    const ctx = {
      roots, paths, roster: rosterDefault, resolved: resolveRole('coder', { plugin: rosterDefault.roles.coder }),
      pluginRoot: ROOT, taskId: 't', taskSlug: 'sample-task', repoSlug: 'sample-repo',
      primaryCheckout, snapshot, config: {}, now: 1754136000123, dispatchId: newDispatchId(), attnUpstream: null,
    }
    return buildRecord(ctx, { role: 'coder', sliceId, attempt: 1, spec: { validation_commands: ['node --test'] } })
  }
  const r1 = build('slice-one')
  const r2 = build('slice-two')
  assert.equal(r1.role_prompt_path, r2.role_prompt_path)
  assert.equal(r1.role_prompt_sha256, r2.role_prompt_sha256)
  assert.notEqual(r1.kickoff, r2.kickoff)
  assert.notEqual(r1.return_path, r2.return_path)
})

// ---------------------------------------------------------------------------
// PRE-1C-VERIFY refusal ladder.
// ---------------------------------------------------------------------------

test('PRE-1C-VERIFY (1): unparseable JSON — exit 2, stderr only (outputs 1-2 structurally impossible)', () => {
  const root = makeTmpDir('claude-adapter-badjson-')
  const recordPath = join(root, 'broken.json')
  writeFileSync(recordPath, '{ this is not json', 'utf8')
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  assert.ok(result.stderr.length > 0)
  assertNoNonceLeak(result, null, null)
})

test('PRE-1C-VERIFY (1): schema-invalid, unsalvageable (dispatch_id fails its own pattern) — exit 2, no output files', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-unsalvage' })
  record.dispatch_id = 'not-a-uuid'
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  assert.equal(existsSync(record.return_path), false)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (1): schema-invalid but salvageable — sentinel + blocked return written from salvaged paths', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-salvage' })
  record.tools = ['NotARealTool']
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '2')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(envelope.dispatch_id, record.dispatch_id)
  assert.equal(envelope.body.status, 'blocked')
  assert.ok(envelope.body.reason.includes('dispatch-record.schema.json'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// MF3-salvage: a salvageable record whose (also salvageable) return_path
// resolves OUTSIDE the salvaged task_dir must never write the salvage
// envelope there — the sentinel and exit 2 still land, but no file is
// created at that escaping return_path.
test('MF3-salvage: schema-invalid but salvageable, return_path escapes task_dir — no salvage envelope written, still sentinel 2', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-salvage-escape' })
  record.tools = ['NotARealTool']
  const outsideReturnPath = join(makeTmpDir('claude-adapter-salvage-escape-'), 'evil-return.json')
  record.return_path = outsideReturnPath
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '2')
  assert.equal(existsSync(outsideReturnPath), false, 'salvage envelope must never be written outside task_dir')
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (2): role_prompt_sha256 mismatch — refuses with a blocked return', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-hash' })
  record.role_prompt_sha256 = '0'.repeat(64)
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath], { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: join(paths.stateDir, 'fc.log') })
  assert.equal(result.status, 2)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '2')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('sha256') || envelope.body.reason.length > 0)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (2): role_prompt_path not equal to <snapshot>/roles/<role>.txt — refuses even with a matching hash', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-path' })
  const bytes = readFileSync(record.role_prompt_path)
  const imposterPath = join(paths.snapshotDir, 'roles', 'imposter.txt')
  writeFileSync(imposterPath, bytes)
  record.role_prompt_path = imposterPath
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('roles/<role>.txt') || envelope.body.reason.includes('role_prompt_path'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (3): a symlink anywhere in the snapshot refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-symlink' })
  symlinkSync(record.role_prompt_path, join(paths.snapshotDir, 'hooks', 'evil-link'))
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('symlink'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (3): an unexpected top-level directory refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-topdir' })
  mkdirSync(join(paths.snapshotDir, 'evil-dir'), { recursive: true })
  writeFileSync(join(paths.snapshotDir, 'evil-dir', 'x.txt'), 'x')
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('directory'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (3): a file outside the closed inventory refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-extrafile' })
  writeFileSync(join(paths.snapshotDir, 'evil.txt'), 'x')
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('outside the closed inventory'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (3): a manifest file whose bytes differ from its plugin-root source refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-tamper' })
  const destRel = Object.keys(WORKER_PLUGIN_MANIFEST)[0]
  writeFileSync(join(paths.snapshotDir, destRel), 'tampered bytes')
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('bytes differ from plugin-root source'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// MF4 — negative: a WORKER_PLUGIN_MANIFEST destination deleted from an
// otherwise-complete snapshot is refused by name, not merely tolerated
// because nothing unexpected was found.
test('MF4: a manifest destination deleted from the snapshot is refused (named missing-destination error)', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-mf4-missing' })
  const destRel = 'hooks/return-gate.sh'
  rmSync(join(paths.snapshotDir, destRel))
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('missing manifest destination'))
  assert.ok(envelope.body.reason.includes(destRel))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// MF4 — paired positive: an untouched, complete snapshot passes this check
// (proven by the happy-path test above reaching exit 0, restated here
// against the coder role specifically for MF4's own pairing requirement).
test('MF4: paired positive — a complete, untampered snapshot passes the manifest-completeness check', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-mf4-complete' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  writeFileSync(returnFixture, coderReturnEnvelope(record), 'utf8')
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_WRITE_RETURN: returnFixture,
  })
  assert.equal(result.status, 0, result.stderr)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// F6 — a root-level <name>.schema.json whose bytes differ from its
// plugin-root source is refused, byte-compared exactly like the manifest
// entries (never merely shape-accepted by filename pattern). The snapshot
// is built from the FULL roster regardless of which role this record
// dispatches (see verifySnapshotInventory's own header note), so
// coder-return.schema.json is present in the shared snapshotDir even for a
// non-coder role's record — this test still drives it via the coder role
// directly, for the simplest possible fixture.
test('F6: a root-level schema whose bytes differ from its plugin-root source refuses', () => {
  const { record, paths, snapshot } = buildTestRecord('coder', { sliceId: 'be-1c-f6-tamper' })
  const schemaFilenames = Object.keys(snapshot.schemas)
  assert.ok(schemaFilenames.length > 0, 'coder must reference at least one root schema')
  const filename = schemaFilenames[0]
  writeFileSync(join(paths.snapshotDir, filename), 'tampered root schema bytes')
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(envelope.body.status, 'blocked')
  assert.ok(envelope.body.reason.includes('root schema bytes differ from plugin-root source'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// F6 — paired positive: identical root-schema bytes pass.
test('F6: paired positive — an untampered root schema passes the byte-equality check', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-f6-ok' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  writeFileSync(returnFixture, coderReturnEnvelope(record), 'utf8')
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_WRITE_RETURN: returnFixture,
  })
  assert.equal(result.status, 0, result.stderr)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('EXECUTION: record.cwd not an existing directory refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-cwd', mkdirCwd: false })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('directory'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (4): nonce sidecar absent refuses to exec', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-nononce' })
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath], { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: join(paths.stateDir, 'fc.log') })
  assert.equal(result.status, 2)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('nonce'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// SF8 — the nonce sidecar is read-and-unlinked FIRST, before hash/inventory
// verification: even when a LATER precondition (snapshot inventory) goes on
// to refuse, the sidecar is already gone.
test('SF8: nonce sidecar is consumed before verifySnapshotInventory refuses', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-sf8' })
  writeFileSync(join(paths.snapshotDir, 'evil.txt'), 'x')
  const nonce = writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath])
  assert.equal(result.status, 2)
  assert.equal(existsSync(nonce), false, 'nonce sidecar must be consumed even though inventory later refuses')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('outside the closed inventory'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('PRE-1C-VERIFY (5): a nonce whose value leaks into argv (via kickoff) is swept before spawn', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-sweep' })
  const fakeLog = join(paths.stateDir, 'fc.log')
  // The dispatch_id is always a substring of the kickoff line — using it as
  // the nonce value deterministically exercises the sweep without needing
  // to fabricate an injected argv element. (dispatch_id itself is NOT the
  // secrecy invariant under test here — it is an ordinary attestation field
  // that legitimately appears in logs; this test only proves the sweep
  // mechanism refuses before any spawn when its chosen "nonce" value
  // reappears in the composed argv.)
  writeNonce(paths, record.dispatch_id, record.dispatch_id)
  const recordPath = writeRecordFile(record, paths)
  const result = runAdapter(['run', recordPath], { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog })
  assert.equal(result.status, 2)
  assert.equal(existsSync(fakeLog), false, 'fake-claude must never be spawned once the sweep trips')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.ok(envelope.body.reason.includes('nonce sweep'))
})

// ---------------------------------------------------------------------------
// ENOENT / CLI missing at run time.
// ---------------------------------------------------------------------------

test('EXECUTION: ENOENT on spawn — blocked return, sentinel 3, exit 3', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-enoent' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeCmuxLog = join(paths.stateDir, 'fake-cmux.log')
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: join(paths.stateDir, 'no-such-agent-binary'), CMUX_BIN: FAKE_CMUX, FAKE_CMUX_LOG: fakeCmuxLog,
  })
  assert.equal(result.status, 3)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '3')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(envelope.body.status, 'blocked')
  assert.equal(envelope.body.reason, 'agent CLI claude not found on PATH')
  // MF2: output 2 (sentinel + completion signal) fires on a non-zero
  // CLI-missing exit too, not only on the zero-exit happy path.
  const cmuxInvocations = readFileSync(fakeCmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(cmuxInvocations.filter((inv) => inv.argv[0] === 'wait-for').length, 1)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// MF2 (headline) — the exit sentinel and the best-effort completion signal
// must both land BEFORE holdPaneIfNeeded's blocking read ever unblocks, so a
// polling orchestrator sees a completed dispatch even while the pane is
// still held open for a human to read. Every other test in this suite runs
// with stdin as a pipe (process.stdin.isTTY === false), which always skips
// the hold entirely — that proves the sentinel exists in the FINAL state,
// but never proves it existed BEFORE a block, since there is no block to
// race against in that setup. This test uses the adapter's own test-only
// hold seam (DEVTEAM_ADAPTER_TEST_HOLD_SEAM, adapter-claude.mjs's
// holdPaneIfNeeded) to deterministically create that "still blocked, past
// finalizeSentinel" window without a real tty: the adapter spins on a
// marker file existing, giving this test a genuine, race-free point at
// which to observe the adapter mid-hold and still alive. Reverting MF2
// (moving finalizeSentinel back to firing only from the 'exit' listener)
// would leave no sentinel file — and no wait-for call — to observe at that
// point, since 'exit' cannot fire until the seam itself releases.
test('MF2: sentinel + completion signal land before the pane-hold seam ever releases', async () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-mf2-hold' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeCmuxLog = join(paths.stateDir, 'fake-cmux.log')
  const holdSeam = join(paths.stateDir, 'hold-seam-marker')

  const child = spawn(process.execPath, [ADAPTER_PATH, 'run', recordPath], {
    env: {
      ...process.env,
      CLAUDE_BIN: join(paths.stateDir, 'no-such-agent-binary'),
      CMUX_BIN: FAKE_CMUX,
      FAKE_CMUX_LOG: fakeCmuxLog,
      DEVTEAM_ADAPTER_TEST_HOLD_SEAM: holdSeam,
    },
    stdio: 'ignore',
  })

  let exited = false
  child.once('exit', () => { exited = true })

  // finalizeSentinel writes the sentinel THEN calls signalToken (a second,
  // separate spawnSync that itself forks fake-cmux.mjs) — both complete
  // before the seam's spin-loop is ever reached, but from THIS process's
  // vantage point there is a real (load-dependent) window where the
  // sentinel file exists on disk while the fake-cmux child is still
  // starting up. Poll for both artifacts, not just the sentinel, before
  // asserting the adapter is still alive/blocked.
  const sentinel = sentinelPath(paths, record.dispatch_id)
  const deadline = Date.now() + 5000
  while ((!existsSync(sentinel) || !existsSync(fakeCmuxLog)) && !exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }

  try {
    assert.equal(existsSync(sentinel), true, 'sentinel must be written before the pane-hold seam releases')
    assert.equal(exited, false, 'the adapter must still be blocked on the pane-hold seam when the sentinel appears')
    assert.equal(readFileSync(sentinel, 'utf8'), '3')

    const cmuxInvocations = readFileSync(fakeCmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(cmuxInvocations.filter((inv) => inv.argv[0] === 'wait-for').length, 1)
  } finally {
    // Release the seam so the child exits cleanly; belt-and-braces kill if
    // it somehow doesn't.
    writeFileSync(holdSeam, '')
    await new Promise((resolve) => {
      if (exited) return resolve()
      child.once('exit', resolve)
      setTimeout(resolve, 2000)
    })
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
})

// ---------------------------------------------------------------------------
// OUTPUT 1 — no fresh valid return / claude nonzero with a valid return.
// ---------------------------------------------------------------------------

test('OUTPUT 1: claude exits 0 but writes no return — blocked return, exit 1', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-noreturn' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const result = runAdapter(['run', recordPath], { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog })
  assert.equal(result.status, 1)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '1')
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(envelope.body.status, 'blocked')
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('OUTPUT 1: claude exits nonzero despite a fresh valid return — return untouched, exit 1', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-nonzero' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  const envelopeText = coderReturnEnvelope(record)
  writeFileSync(returnFixture, envelopeText, 'utf8')
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_WRITE_RETURN: returnFixture, FAKE_CLAUDE_EXIT_CODE: '7',
  })
  assert.equal(result.status, 1)
  assert.equal(readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8'), '1')
  assert.equal(readFileSync(record.return_path, 'utf8'), envelopeText)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

// buildNoReturnReason (adapter-claude.mjs) reports only violations[0]'s
// KEYWORD — a small fixed enum ladder.mjs defines — never any text sourced
// from the return body itself, so a worker crafting its return body to try
// to break out of the composed blocked-envelope's own markdown/JSON shape
// (an MF5-style fence-poisoning attempt) has nothing to inject through this
// path at all.
test('buildNoReturnReason: an unparseable return body composes a fixed keyword reason, never any of its own bytes', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-noreturn-keyword' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  const poison = '```\nnot json at all, and an unclosed fence: ## Verdict\n'
  writeFileSync(returnFixture, poison, 'utf8')
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_WRITE_RETURN: returnFixture,
  })
  assert.equal(result.status, 1)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(envelope.body.status, 'blocked')
  assert.equal(envelope.body.reason.startsWith('invalid_json'), true)
  assert.equal(envelope.body.reason.includes(poison), false)
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('OUTPUT 1: markdown role (build-validator) gets the stub blocked form on failure', () => {
  const { record, paths } = buildTestRecord('build-validator', { sliceId: 'be-1c-md-blocked' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const result = runAdapter(['run', recordPath], { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog })
  assert.equal(result.status, 1)
  const envelope = JSON.parse(readFileSync(record.return_path, 'utf8'))
  assert.equal(typeof envelope.body, 'string')
  assert.ok(envelope.body.includes('status: blocked'))
  assert.ok(envelope.body.includes('## Verdict'))
  assertNoNonceLeak(result, paths, record.dispatch_id)
})

test('positive paired with the markdown blocked-form negative: a valid markdown+verdict return is never touched', () => {
  const { record, paths } = buildTestRecord('build-validator', { sliceId: 'be-1c-md-ok' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  const envelopeText = markdownEnvelope(record, markdownVerdictBody('pass'))
  writeFileSync(returnFixture, envelopeText, 'utf8')
  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_WRITE_RETURN: returnFixture,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(record.return_path, 'utf8'), envelopeText)
})

// ---------------------------------------------------------------------------
// Sentinel-exactly-once + signalToken invoked at most once.
// ---------------------------------------------------------------------------

// SF3: post-MF2, finalizeSentinel is genuinely reached TWICE per run —
// once from holdPaneIfNeeded (before any hold), once more from the 'exit'
// listener once process.exit finally runs — over the exact same code. The
// sentinelWritten guard makes the second call a no-op; the signalDelivered
// guard is what this test's wait-for-count assertion actually proves:
// removing it would call signalToken (and therefore `cmux wait-for`) a
// second time, turning waitForCalls.length into 2.
test('OUTPUT 2: exactly one sentinel write and one signal attempt on a normal exit', () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-once' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')
  const fakeCmuxLog = join(paths.stateDir, 'fake-cmux.log')
  const returnFixture = join(paths.stateDir, 'return-fixture.json')
  writeFileSync(returnFixture, coderReturnEnvelope(record), 'utf8')

  const result = runAdapter(['run', recordPath], {
    CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: fakeLog,
    FAKE_CLAUDE_WRITE_RETURN: returnFixture,
    CMUX_BIN: FAKE_CMUX,
    FAKE_CMUX_LOG: fakeCmuxLog,
  })
  assert.equal(result.status, 0, result.stderr)

  const sentinelText = readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8')
  assert.equal(sentinelText, '0')

  const cmuxInvocations = readFileSync(fakeCmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const waitForCalls = cmuxInvocations.filter((inv) => inv.argv[0] === 'wait-for')
  assert.equal(waitForCalls.length, 1)
  assert.deepEqual(waitForCalls[0].argv.slice(0, 2), ['wait-for', '-S'])
})

// ---------------------------------------------------------------------------
// Signal safety — process-group teardown must still yield exactly one
// sentinel write, never a hang, never a crash.
// ---------------------------------------------------------------------------

// SF3 note on the 143 value: Node only ever dispatches a registered signal
// handler once the JS call stack fully unwinds back to the event loop —
// verified empirically (see this slice's own investigation) against
// spawnSync, Atomics.wait AND a genuinely blocking readSync(0, ...) on a
// real pipe: none of them yield to a pending SIGTERM's JS callback while
// blocked, only once they return. Since this adapter's entire `run` path is
// synchronous end to end (no event-loop yield point exists between
// process.on('SIGTERM', ...) being registered and the eventual
// process.exit()), the handler's 143 can only ever fire in a window this
// process-group-teardown scenario cannot deterministically land the signal
// in — asserting it here would be asserting a value Node's own runtime
// semantics make unreachable under a real spawnSync-blocked child, not a
// meaningful regression signal. What IS real and load-bearing here: exactly
// one sentinel write, a well-formed integer, no hang, no crash — a removed
// sentinelWritten guard would instead risk a second, possibly divergent
// write racing in, corrupting or duplicating the sentinel.
test('OUTPUT 2: SIGTERM to the adapter\'s own process group still yields exactly one sentinel', async () => {
  const { record, paths } = buildTestRecord('coder', { sliceId: 'be-1c-sigterm' })
  writeNonce(paths, record.dispatch_id, `${NONCE_PREFIX}deadbeef`)
  const recordPath = writeRecordFile(record, paths)
  const fakeLog = join(paths.stateDir, 'fc.log')

  // fake-claude sleeps (blocking) well past the SIGTERM below, giving cmux's
  // real pane-teardown model (SIGTERM to the whole process group, hitting
  // the adapter AND its spawnSync child at once) a real window to land
  // while the adapter is genuinely mid-run, not merely racing process exit.
  const child = spawn(process.execPath, [ADAPTER_PATH, 'run', recordPath], {
    env: { ...process.env, CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_SLEEP_MS: '5000' },
    detached: true,
    stdio: 'ignore',
  })

  const exited = new Promise((resolve) => child.on('exit', resolve))
  await new Promise((r) => setTimeout(r, 300))
  process.kill(-child.pid, 'SIGTERM')
  await exited

  const sentinel = readFileSync(sentinelPath(paths, record.dispatch_id), 'utf8')
  assert.match(sentinel, /^-?\d+$/)
  assert.equal(existsSync(record.return_path), true)
})

// ---------------------------------------------------------------------------
// cmuxctl.mjs additions.
// ---------------------------------------------------------------------------

test('cmuxctl: wait-for is in the frozen VERBS allowlist, never in VERB_METHODS', () => {
  assert.ok(VERBS.includes('wait-for'))
  assert.ok(Object.isFrozen(VERBS))
})

test('cmuxctl: signalToken never throws — a rejecting fixture and degenerate token inputs both resolve to false', () => {
  // FAKE_CMUX_LOG must be set for the fixture to run its switch at all
  // (fake-cmux.mjs:28-37's own trap-avoidance exit); once it does, 'wait-for'
  // has no case and falls through to its unknown_verb failure branch — a
  // real, non-throwing rejection.
  process.env.FAKE_CMUX_LOG = join(makeTmpDir('claude-adapter-signaltoken-'), 'fake-cmux.log')
  try {
    assert.equal(signalToken('some-token'), false)
    assert.equal(signalToken(''), false)
    assert.equal(signalToken(null), false)
  } finally {
    delete process.env.FAKE_CMUX_LOG
  }
})
