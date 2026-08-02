// cmuxctl.mjs is the only boundary this repo has to the cmux CLI.
// CMUX_BIN must be set to test/fixtures/fake-cmux.mjs BEFORE cmuxctl.mjs is
// first imported, since CMUX_BIN is captured as a module-level constant at
// import time. Static `import` declarations always evaluate before any
// other top-level statement in the same module, so the env var is set via
// a dynamic import() inside top-level await instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'fake-cmux.mjs')
const CMUXCTL_PATH = join(HERE, '..', 'scripts', 'cmux', 'cmuxctl.mjs')

process.env.CMUX_BIN = FIXTURE

const {
  CMUX_BIN, VERBS, VERB_METHODS, PREFLIGHT_MESSAGES, formatPreflightMessage, PreflightError,
  cmux, normalizeId, normalizeIds, tree, findSurface, findWorkspace, recoverNewId,
  preflight, ensureTeamWindow, ensureWorkspace, createPane, sendLine, renameTab,
  setStatus, closeSurface, closeWorkspace, mountDocTab, topTsv, readEvents,
} = await import(CMUXCTL_PATH)

// Fixed orchestrator ids baked into the fixture's fresh topology (lowercase
// forms — the mixed-case source lives in test/fixtures/fake-cmux.mjs).
const ORCH_WINDOW = 'f1a063e8-ec2c-40d7-932c-f3610adfe581'
const ORCH_PANE = 'b3a063e8-ec2c-40d7-932c-f3610adfe583'
const ORCH_SURFACE = 'c4a063e8-ec2c-40d7-932c-f3610adfe584'

function freshEnv(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `cmuxctl-${prefix}-`))
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
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function runPreflight(dir, overrides = {}) {
  return preflight({
    roster: [{ role: 'coder', cli: 'ls' }],
    paths: { taskDir: join(dir, 'task'), worktreeDirs: [] },
    primaryCheckout: join(dir, 'primary'),
    taskArtifactsRoot: join(dir, 'artifacts'),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// cmux() invocation + error parsing.
// ---------------------------------------------------------------------------

test('CMUX_BIN is the single constant, set from the fixture', () => {
  assert.equal(CMUX_BIN, FIXTURE)
})

test('cmux() returns the ok shape on success, never throws', () => {
  freshEnv('ok')
  const res = cmux('ping', [])
  assert.deepEqual(res, { ok: true, code: 0, stdout: 'PONG\n', json: null, error: null })
})

test('cmux() parses `Error: <code>: <message>` + exit 1 into error, never throws', () => {
  freshEnv('err')
  process.env.FAKE_CMUX_FAIL = 'ping'
  const res = cmux('ping', [])
  assert.equal(res.ok, false)
  assert.equal(res.code, 1)
  assert.deepEqual(res.error, { code: 'forced_failure', message: 'forced failure for verb ping' })
  assert.equal(res.json, null)
})

test('cmux() refuses any verb outside the frozen VERBS allowlist', () => {
  freshEnv('badverb')
  assert.ok(Object.isFrozen(VERBS))
  assert.throws(() => cmux('does-not-exist', []))
})

test('every cmux(...) call site in this module uses a verb from VERBS', () => {
  const src = readFileSync(CMUXCTL_PATH, 'utf8')
  const used = new Set([...src.matchAll(/\bcmux\('([a-z-]+)'/g)].map((m) => m[1]))
  for (const verb of used) assert.ok(VERBS.includes(verb), `${verb} is invoked but not in VERBS`)
})

// ---------------------------------------------------------------------------
// ID normalization — deep, mixed-case-proof.
// ---------------------------------------------------------------------------

test('normalizeIds lowercases nested *_id/*_ids values and leaves non-id strings untouched', () => {
  const input = {
    id: 'F1A063E8-EC2C-40D7-932C-F3610ADFE581',
    title: 'F1A063E8 looks like an id but is a title',
    tty: '/dev/TTYS001',
    type: 'Terminal',
    nested: {
      workspace_id: 'Ab063e8A-ec2c-40D7-932c-f3610adfe582',
      surface_ids: ['C1a063E8-ec2C-40d7-932c-F3610adfe583', 'D1a063E8-ec2C-40d7-932c-F3610adfe584'],
      panes: [{ pane_id: 'E1a063E8-ec2C-40d7-932c-F3610adfe585', name: 'CoderPane' }],
    },
  }
  const out = normalizeIds(input)
  assert.equal(out.id, input.id.toLowerCase())
  assert.equal(out.title, input.title)
  assert.equal(out.tty, input.tty)
  assert.equal(out.type, input.type)
  assert.equal(out.nested.workspace_id, input.nested.workspace_id.toLowerCase())
  assert.deepEqual(out.nested.surface_ids, input.nested.surface_ids.map((s) => s.toLowerCase()))
  assert.equal(out.nested.panes[0].pane_id, input.nested.panes[0].pane_id.toLowerCase())
  assert.equal(out.nested.panes[0].name, input.nested.panes[0].name)
})

test('normalizeId lowercases a single string and passes non-strings through', () => {
  assert.equal(normalizeId('ABCDEF01-0000-0000-0000-000000000000'), 'abcdef01-0000-0000-0000-000000000000')
  assert.equal(normalizeId(null), null)
})

test('every id crossing cmuxctl exported surface matches ^[0-9a-f-]+$', () => {
  freshEnv('surface-lower')
  const t = tree({ all: true })
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'id' || k.endsWith('_id')) && typeof v === 'string') assert.match(v, /^[0-9a-f-]+$/)
        if (k.endsWith('_ids') && Array.isArray(v)) v.forEach((x) => assert.match(x, /^[0-9a-f-]+$/))
        walk(v)
      }
    }
  }
  walk(t)
})

test('a lowercase id is accepted as a command target (identify caller resolves in the tree)', () => {
  freshEnv('lowercase-target')
  const t = tree({ all: true })
  assert.ok(findSurface(t, ORCH_SURFACE))
})

// ---------------------------------------------------------------------------
// recoverNewId.
// ---------------------------------------------------------------------------

test('recoverNewId finds exactly one new object of a kind, or throws a loud named error', () => {
  freshEnv('recover')
  const before = tree({ all: true })
  const res = cmux('new-window', [])
  assert.ok(res.ok)
  const after = tree({ all: true })
  const id = recoverNewId(before, after, 'window')
  assert.match(id, /^[0-9a-f-]+$/)
  assert.throws(() => recoverNewId(before, before, 'window'), /expected exactly 1 new window, found 0/)
})

// ---------------------------------------------------------------------------
// VERB_METHODS — live capabilities.methods are RPC-dotted names, not CLI
// verb names; the gate must check the MAPPED method, never the verb itself.
// ---------------------------------------------------------------------------

test('VERB_METHODS maps every gated verb to a dotted RPC method name, never a CLI verb name', () => {
  assert.ok(Object.isFrozen(VERB_METHODS))
  for (const [verb, method] of Object.entries(VERB_METHODS)) {
    assert.ok(VERBS.includes(verb), `${verb} is in VERB_METHODS but not VERBS`)
    assert.match(method, /^[a-z_]+\.[a-z_.]+$/, `${verb} -> ${method} does not look like a dotted RPC method`)
    assert.notEqual(method, verb) // never gate on the CLI verb name itself
  }
})

// ---------------------------------------------------------------------------
// Preflight — order, caching, and the five remediation messages.
// ---------------------------------------------------------------------------

test('preflight succeeds end-to-end and caches to <taskArtifactsRoot>/preflight.json via tmp+rename', () => {
  const { dir } = freshEnv('preflight-ok')
  const result = runPreflight(dir)
  assert.equal(result.cmux_version, 'cmux 0.64.20 (100)')
  assert.equal(result.access_mode, 'cmuxOnly')
  assert.ok(Array.isArray(result.methods))
  assert.equal(result.top_available, true)
  assert.equal(result.events_available, true)
  assert.equal(result.close_workspace_available, true)
  assert.equal(result.adapter_present.ls, true)
  assert.match(result.orchestrator.surface_id, /^[0-9a-f-]+$/)
  assert.equal(result.team_window_id, null)
  assert.ok(result.checked_at)
  // events/config/set-status have no confidently-known RPC method name —
  // unverifiable-by-capabilities, never gated (qa-lead addendum).
  assert.deepEqual(result.unverifiable_verbs, ['config', 'events', 'set-status'])

  const artifactsRoot = join(dir, 'artifacts')
  const cachedRaw = readFileSync(join(artifactsRoot, 'preflight.json'), 'utf8')
  assert.deepEqual(JSON.parse(cachedRaw), result)
  assert.deepEqual(readdirSync(artifactsRoot), ['preflight.json']) // no leftover .tmp file
})

test('preflight reuses the cache unless force is set', () => {
  const { dir } = freshEnv('preflight-cache')
  const first = runPreflight(dir)
  process.env.FAKE_CMUX_FAIL = 'ping' // would fail a fresh run
  const second = runPreflight(dir)
  assert.deepEqual(second, first) // cache hit, no re-run
  assert.throws(() => runPreflight(dir, { force: true }), PreflightError)
})

test('S5-C: a malformed preflight.json cache is treated as absent (re-run), never trusted or thrown on', () => {
  const { dir } = freshEnv('preflight-cache-shape')
  const artifactsRoot = join(dir, 'artifacts')
  mkdirSync(artifactsRoot, { recursive: true })
  writeFileSync(join(artifactsRoot, 'preflight.json'), JSON.stringify({ cmux_version: 'not even close to the real shape' }))
  const result = runPreflight(dir)
  assert.equal(result.cmux_version, 'cmux 0.64.20 (100)') // recomputed from a real run, not the malformed cache
  assert.ok(Array.isArray(result.methods)) // full valid shape written back over the malformed cache
})

test('lifecycle S14-partial: a cached preflight.json older than 24h logs a loud staleness warning on reuse', () => {
  const { dir } = freshEnv('preflight-stale')
  const first = runPreflight(dir)
  const artifactsRoot = join(dir, 'artifacts')
  const stale = { ...first, checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }
  writeFileSync(join(artifactsRoot, 'preflight.json'), `${JSON.stringify(stale, null, 2)}\n`)

  const originalError = console.error
  const logged = []
  console.error = (...args) => logged.push(args.join(' '))
  try {
    const result = runPreflight(dir)
    assert.deepEqual(result, stale) // still the (stale) cache — a warning, not a refusal
  } finally {
    console.error = originalError
  }
  assert.ok(logged.some((l) => /stale/i.test(l)), 'expected a loud staleness warning on stdout/stderr')
})

test('binary missing -> PREFLIGHT_MESSAGES.binary_missing (byte-for-byte, ===)', () => {
  const { dir } = freshEnv('binary-missing')
  const script = `
    const { preflight, PREFLIGHT_MESSAGES } = await import(${JSON.stringify(CMUXCTL_PATH)})
    try {
      preflight({ roster: [], paths: {}, primaryCheckout: '/x', taskArtifactsRoot: ${JSON.stringify(join(dir, 'artifacts'))} })
      console.log(JSON.stringify({ threw: false }))
    } catch (err) {
      console.log(JSON.stringify({ threw: true, code: err.code, matches: err.message === PREFLIGHT_MESSAGES.binary_missing }))
    }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, CMUX_BIN: join(dir, 'no-such-cmux-binary') },
  })
  const out = JSON.parse(child.stdout.trim())
  assert.equal(out.threw, true)
  assert.equal(out.code, 'binary_missing')
  assert.equal(out.matches, true)
})

test('cmux not running (ping fails) -> PREFLIGHT_MESSAGES.not_running (byte-for-byte, ===)', () => {
  const { dir } = freshEnv('not-running')
  process.env.FAKE_CMUX_FAIL = 'ping'
  try {
    runPreflight(dir)
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err instanceof PreflightError)
    assert.equal(err.code, 'not_running')
    assert.equal(err.message, PREFLIGHT_MESSAGES.not_running)
  }
})

test('not running inside a cmux pane (identify caller null) -> PREFLIGHT_MESSAGES.not_in_pane (byte-for-byte, ===)', () => {
  const { dir } = freshEnv('not-in-pane')
  process.env.FAKE_CMUX_NO_CALLER = '1'
  try {
    runPreflight(dir)
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err instanceof PreflightError)
    assert.equal(err.code, 'not_in_pane')
    assert.equal(err.message, PREFLIGHT_MESSAGES.not_in_pane)
  }
})

test('a required RPC method missing from capabilities.methods -> formatted verb_missing (never the raw <ver>/<verb> template)', () => {
  const { dir } = freshEnv('verb-missing')
  // Dotted RPC method name (pane.create, mapped from CLI verb new-pane) —
  // NOT the CLI verb name; the live methods list never contains 'new-pane'
  // at all, so gating on the CLI name would never fire against reality.
  process.env.FAKE_CMUX_MISSING_METHODS = 'pane.create'
  try {
    runPreflight(dir)
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err instanceof PreflightError)
    assert.equal(err.code, 'verb_missing')
    assert.equal(err.key, 'verb_missing')
    assert.equal(err.message, formatPreflightMessage('verb_missing', { ver: 'cmux 0.64.20 (100)', verb: 'new-pane' }))
    assert.match(err.message, /new-pane/)
    assert.doesNotMatch(err.message, /<ver>|<verb>/)
  }
})

test('a roster agent CLI missing from PATH -> formatted adapter_missing (never the raw <r>/<cli> template)', () => {
  const { dir } = freshEnv('adapter-missing')
  try {
    preflight({
      roster: [{ role: 'coder', cli: 'definitely-not-a-real-cli-2026' }],
      paths: { taskDir: join(dir, 'task'), worktreeDirs: [] },
      primaryCheckout: join(dir, 'primary'),
      taskArtifactsRoot: join(dir, 'artifacts'),
    })
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err instanceof PreflightError)
    assert.equal(err.code, 'adapter_missing')
    assert.equal(err.key, 'adapter_missing')
    assert.equal(err.message, formatPreflightMessage('adapter_missing', { role: 'coder', cli: 'definitely-not-a-real-cli-2026' }))
    assert.match(err.message, /definitely-not-a-real-cli-2026/)
    assert.doesNotMatch(err.message, /<r>|<cli>/)
  }
})

test('formatPreflightMessage returns the raw byte-frozen constant for the three non-templated messages', () => {
  assert.equal(formatPreflightMessage('binary_missing'), PREFLIGHT_MESSAGES.binary_missing)
  assert.equal(formatPreflightMessage('not_running'), PREFLIGHT_MESSAGES.not_running)
  assert.equal(formatPreflightMessage('not_in_pane'), PREFLIGHT_MESSAGES.not_in_pane)
})

test('preflight containment gate rejects a task_dir inside a dispatcher worktree or inside primary_checkout', () => {
  const { dir } = freshEnv('containment')
  const worktree = join(dir, 'worktrees', 'wt1')
  assert.throws(
    () => preflight({
      roster: [{ role: 'coder', cli: 'ls' }],
      paths: { taskDir: join(worktree, 'task'), worktreeDirs: [worktree] },
      primaryCheckout: join(dir, 'primary'),
      taskArtifactsRoot: join(dir, 'artifacts1'),
    }),
    PreflightError,
  )
  const primary = join(dir, 'primary')
  assert.throws(
    () => preflight({
      roster: [{ role: 'coder', cli: 'ls' }],
      paths: { taskDir: join(primary, 'task'), worktreeDirs: [] },
      primaryCheckout: primary,
      taskArtifactsRoot: join(dir, 'artifacts2'),
    }),
    PreflightError,
  )
})

test('on any preflight failure, `cmux config doctor` output is attached as diagnostics only', () => {
  const { dir } = freshEnv('diagnostics')
  process.env.FAKE_CMUX_FAIL = 'ping'
  try {
    runPreflight(dir)
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err.diagnostics)
    assert.equal(err.diagnostics.ok, true)
    assert.match(err.diagnostics.stdout, /cmux config doctor/)
  }
})

// ---------------------------------------------------------------------------
// Message drift guard (qa-lead E-P2). Placed here because cmuxctl.mjs is
// the definition site. be-1b-E imports PREFLIGHT_MESSAGES and asserts
// against the IMPORTED constant only — never a re-typed literal.
// ---------------------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url)

test('drift guard: each of the five PREFLIGHT_MESSAGES occurs verbatim exactly once across scripts/cmux/*.mjs and sibling test/cmux-*.test.mjs', () => {
  // Widened per qa-lead vacuity S5: the old guard read cmuxctl.mjs only, so
  // a re-typed literal anywhere else (dispatch.mjs, its test file, ...)
  // went undetected. THIS file is excluded from the scan: it deliberately
  // carries exactly one independently-re-typed "byte pin" per message
  // (below) to catch a typo at the definition site itself, which the
  // duplicate-counting guard structurally cannot see (the definition site
  // supplies the one required occurrence). That is intentional, singular,
  // per-message duplication — not drift — so it is excluded here and
  // verified instead by the dedicated byte-pin tests below.
  const scriptsDir = join(HERE, '..', 'scripts', 'cmux')
  const scriptFiles = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).map((f) => join(scriptsDir, f))
  const testFiles = readdirSync(HERE)
    .filter((f) => f.startsWith('cmux-') && f.endsWith('.test.mjs'))
    .map((f) => join(HERE, f))
    .filter((p) => p !== THIS_FILE)
  const combined = [...scriptFiles, ...testFiles].map((p) => readFileSync(p, 'utf8')).join('\n---\n')

  const keys = Object.keys(PREFLIGHT_MESSAGES)
  assert.equal(keys.length, 5)
  for (const key of keys) {
    const message = PREFLIGHT_MESSAGES[key]
    const occurrences = combined.split(message).length - 1
    assert.equal(occurrences, 1, `PREFLIGHT_MESSAGES.${key} must appear verbatim exactly once across scripts/cmux/*.mjs + test/cmux-*.test.mjs (found ${occurrences}) — a second copy is drift`)
  }
})

// The drift guard above can only catch DUPLICATES — the definition site
// itself supplies the one required occurrence, so a typo in the definition
// passes it silently. These byte pins are re-typed independently of
// PREFLIGHT_MESSAGES (the "CMUX_ALLOWS pattern") to catch that class too.
test('byte pin: PREFLIGHT_MESSAGES.binary_missing matches the spec text exactly', () => {
  assert.equal(
    PREFLIGHT_MESSAGES.binary_missing,
    'cmux is required by execution_mode: cmux. Install: brew tap manaflow-ai/cmux && brew install --cask cmux — then start this session inside a cmux terminal.',
  )
})

test('byte pin: PREFLIGHT_MESSAGES.not_running matches the spec text exactly', () => {
  assert.equal(PREFLIGHT_MESSAGES.not_running, 'cmux is installed but not running. Start the cmux app and retry.')
})

test('byte pin: PREFLIGHT_MESSAGES.not_in_pane matches the spec text exactly', () => {
  assert.equal(
    PREFLIGHT_MESSAGES.not_in_pane,
    'This session is not running inside a cmux pane. Socket control mode is cmuxOnly by design — open a cmux terminal in this project and start Claude Code there.',
  )
})

test('byte pin: PREFLIGHT_MESSAGES.verb_missing matches the spec template exactly', () => {
  assert.equal(
    PREFLIGHT_MESSAGES.verb_missing,
    'Installed cmux <ver> does not expose <verb>. brew upgrade --cask cmux, or set execution_mode: agent-tool in .claude/dev-team/config.md to use the legacy substrate.',
  )
})

test('byte pin: PREFLIGHT_MESSAGES.adapter_missing matches the spec template exactly', () => {
  assert.equal(PREFLIGHT_MESSAGES.adapter_missing, "Roster role <r> needs agent CLI '<cli>', not found on PATH.")
})

// ---------------------------------------------------------------------------
// Two-window seating.
// ---------------------------------------------------------------------------

test('ensureTeamWindow never returns the orchestrator window, and reuses a recorded team_window_id', () => {
  const { dir, logPath } = freshEnv('team-window')
  const pf = runPreflight(dir)
  const windowId1 = ensureTeamWindow(pf)
  assert.notEqual(windowId1, ORCH_WINDOW)
  assert.notEqual(windowId1, pf.orchestrator.window_id)

  const windowId2 = ensureTeamWindow({ ...pf, team_window_id: windowId1 })
  assert.equal(windowId2, windowId1)

  const invocations = readLog(logPath)
  const newWindowCalls = invocations.filter((e) => e.argv[0] === 'new-window')
  assert.equal(newWindowCalls.length, 1) // second call reused, did not create another
})

test('ensureTeamWindow still creates a fresh window when the orchestrator window cannot be derived', () => {
  const { dir } = freshEnv('team-window-no-orch')
  const pf = runPreflight(dir, {})
  const brokenPf = { ...pf, orchestrator: { ...pf.orchestrator, surface_id: null } }
  const windowId = ensureTeamWindow(brokenPf)
  assert.match(windowId, /^[0-9a-f-]+$/)
  assert.notEqual(windowId, ORCH_WINDOW)
})

test('S5-C: ensureTeamWindow refuses a recorded team_window_id when orchestrator.surface_id is null, even if the recorded id equals the operator\'s own window', () => {
  const { dir, logPath } = freshEnv('team-window-tampered')
  const pf = runPreflight(dir)
  // Simulate a tampered/corrupted cache: no known orchestrator surface, but
  // a recorded team_window_id that happens to be the operator's OWN
  // window. Without the guard, this would make ensureTeamWindow seat a
  // dispatch pane in the human's own session.
  const tamperedPf = { ...pf, orchestrator: { ...pf.orchestrator, surface_id: null }, team_window_id: ORCH_WINDOW }
  const windowId = ensureTeamWindow(tamperedPf)
  assert.notEqual(windowId, ORCH_WINDOW)
  const newWindowCalls = readLog(logPath).filter((e) => e.argv[0] === 'new-window')
  assert.equal(newWindowCalls.length, 1) // a fresh window was minted, the tampered id was never trusted
})

test('ensureWorkspace creates once and reuses an existing workspace of the same name', () => {
  const { dir, logPath } = freshEnv('workspace')
  const pf = runPreflight(dir)
  const windowId = ensureTeamWindow(pf)

  const first = ensureWorkspace({ windowId, taskSlug: 'be-1b-c', cwd: '/tmp/repo' })
  assert.match(first.workspaceId, /^[0-9a-f-]+$/)
  assert.match(first.initialSurfaceId, /^[0-9a-f-]+$/)

  const second = ensureWorkspace({ windowId, taskSlug: 'be-1b-c', cwd: '/tmp/repo' })
  assert.equal(second.workspaceId, first.workspaceId)
  assert.equal(second.initialSurfaceId, first.initialSurfaceId)

  const invocations = readLog(logPath)
  assert.equal(invocations.filter((e) => e.argv[0] === 'new-workspace').length, 1)
})

test('createPane recovers both the new pane id and its surface id via tree diff', () => {
  const { dir } = freshEnv('create-pane')
  const pf = runPreflight(dir)
  const windowId = ensureTeamWindow(pf)
  const { workspaceId } = ensureWorkspace({ windowId, taskSlug: 'be-1b-c', cwd: '/tmp/repo' })
  const { paneId, surfaceId } = createPane({ workspaceId })
  assert.match(paneId, /^[0-9a-f-]+$/)
  assert.match(surfaceId, /^[0-9a-f-]+$/)
})

test('createPane throws a loud error when the target workspace is gone', () => {
  freshEnv('create-pane-gone')
  assert.throws(() => createPane({ workspaceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }))
})

// Regression (be-1b-E blocker): the fake used to mint paneId === surfaceId
// (and workspaceId === paneId === surfaceId on new-workspace) because
// nextId() derived its seed from a live object count that hadn't changed
// yet between two calls in the same handler. A colliding id made
// locate()'s first-match-wins walk resolve a fresh surface at the PANE
// level, so findSurface() returned null and renameTab/sendLine/closeSurface
// silently no-op'd against every dynamically created pane — making
// non-vacuous assertions about them impossible.
test('regression: ids minted within one invocation are pairwise distinct, so a fresh surface is actually findable and actionable', () => {
  const { dir, logPath } = freshEnv('id-collision-regression')
  const pf = runPreflight(dir)
  const windowId = ensureTeamWindow(pf)

  const { workspaceId, initialSurfaceId } = ensureWorkspace({ windowId, taskSlug: 'be-1b-c', cwd: '/tmp/repo' })
  const workspaceInitialPaneId = (() => {
    const t = tree({ all: true })
    const win = t.windows.find((w) => w.id === windowId)
    const ws = win.workspaces.find((w) => w.id === workspaceId)
    return ws.panes[0].id
  })()
  assert.notEqual(workspaceId, workspaceInitialPaneId)
  assert.notEqual(workspaceId, initialSurfaceId)
  assert.notEqual(workspaceInitialPaneId, initialSurfaceId)

  const { paneId, surfaceId } = createPane({ workspaceId })
  assert.notEqual(paneId, surfaceId)
  assert.notEqual(paneId, workspaceInitialPaneId)
  assert.notEqual(surfaceId, initialSurfaceId)

  const t = tree({ all: true })
  const located = findSurface(t, surfaceId)
  assert.ok(located, 'findSurface must resolve the freshly created surface, not the pane it lives in')
  assert.equal(located.id, surfaceId)

  renameTab(surfaceId, 'coder')
  sendLine(surfaceId, 'echo hi')
  const invocations = readLog(logPath)
  assert.ok(invocations.some((e) => e.argv[0] === 'rename-tab' && e.argv[1] === surfaceId), 'renameTab must not silently no-op against the fresh surface')
  assert.ok(invocations.some((e) => e.argv[0] === 'send' && e.argv[1] === surfaceId), 'sendLine must not silently no-op against the fresh surface')
})

// ---------------------------------------------------------------------------
// sendLine — the shell-injection boundary.
// ---------------------------------------------------------------------------

test('sendLine performs send then send-key enter, in that order', () => {
  const { logPath } = freshEnv('sendline-order')
  sendLine(ORCH_SURFACE, 'echo hello')
  const invocations = readLog(logPath).filter((e) => e.argv[0] === 'send' || e.argv[0] === 'send-key')
  assert.equal(invocations.length, 2)
  assert.equal(invocations[0].argv[0], 'send')
  assert.equal(invocations[1].argv[0], 'send-key')
  assert.equal(invocations[1].argv[2], 'enter')
})

test('sendLine allowlist refuses backtick, $, backslash, double-quote, and newline — refusal throws, never escapes-and-continues', () => {
  const { logPath } = freshEnv('sendline-refuse-chars')
  const dangerous = ['echo `whoami`', 'echo $HOME', 'echo \\x41', 'echo "hi"', 'echo\nhi']
  for (const line of dangerous) {
    assert.throws(() => sendLine(ORCH_SURFACE, line), /refused/)
  }
  const invocations = readLog(logPath)
  assert.equal(invocations.filter((e) => e.argv[0] === 'send').length, 0)
})

test('sendLine refuses a mid-line carriage return — in a PTY, CR IS Enter, so a bare denylist gap here is a live submit-early hole', () => {
  freshEnv('sendline-refuse-cr')
  assert.throws(() => sendLine(ORCH_SURFACE, 'echo hi\rrm -rf /'), /refused/)
})

test('sendLine refuses every shell metacharacter outside the allowlist (& | > < ( ) { } ~ * ?)', () => {
  freshEnv('sendline-refuse-metachars')
  // ';' and ':' ARE allowlisted (the review's own suggested charset admits
  // them — ordinary prose/kv content uses both); every other classic shell
  // metacharacter is refused.
  for (const ch of ['&', '|', '>', '<', '(', ')', '{', '}', '~', '*', '?']) {
    assert.throws(() => sendLine(ORCH_SURFACE, `echo hi${ch}`), /refused/, `expected refusal for character ${JSON.stringify(ch)}`)
  }
})

test('sendLine accepts an ordinary line containing a lone apostrophe (allowlisted prose/path character)', () => {
  const { logPath } = freshEnv('sendline-allow-apostrophe')
  sendLine(ORCH_SURFACE, "echo it's fine")
  const invocations = readLog(logPath).filter((e) => e.argv[0] === 'send')
  assert.equal(invocations.length, 1)
})

test('sendLine refuses an interpolated path that does not match ^/[A-Za-z0-9._/-]+$', () => {
  freshEnv('sendline-refuse-path')
  assert.throws(() => sendLine(ORCH_SURFACE, 'cat /tmp/foo:bar.txt'), /interpolated path failed/)
})

test('sendLine strips a `key=` prefix before the path-token charset test (every real kickoff path is `task_dir=/...`)', () => {
  const { logPath } = freshEnv('sendline-key-prefix')
  sendLine(ORCH_SURFACE, 'task_dir=/tmp/x spec_path=/tmp/y.md')
  const invocations = readLog(logPath).filter((e) => e.argv[0] === 'send')
  assert.equal(invocations.length, 1)
  assert.throws(() => sendLine(ORCH_SURFACE, 'task_dir=/tmp/x:bad'), /interpolated path failed/)
})

test('sendLine no-ops loudly when the target surface is gone from a fresh tree', () => {
  const { logPath } = freshEnv('sendline-gone')
  sendLine('ffffffff-ffff-ffff-ffff-ffffffffffff', 'echo hi')
  const invocations = readLog(logPath)
  assert.equal(invocations.filter((e) => e.argv[0] === 'send').length, 0)
})

// ---------------------------------------------------------------------------
// mountDocTab — never throws, never focuses.
// ---------------------------------------------------------------------------

test('mountDocTab mounts a doc tab, recovers its id via diff (never from stdout — markdown open prints nothing), moves + reorders it with --before, and never focuses', () => {
  const { logPath } = freshEnv('mount-doc-tab')
  const surfaceId = mountDocTab({ renderPath: '/tmp/render.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  assert.match(surfaceId, /^[0-9a-f-]+$/)
  const invocations = readLog(logPath)
  assert.equal(invocations.some((e) => e.argv[0] === 'focus-pane'), false)
  const markdownCall = invocations.find((e) => e.argv[0] === 'markdown')
  assert.deepEqual(markdownCall.argv, ['markdown', 'open', '/tmp/render.md', '--surface', ORCH_SURFACE])
  const reorderCall = invocations.find((e) => e.argv[0] === 'reorder-surface')
  assert.ok(reorderCall, 'reorder-surface must be invoked')
  assert.deepEqual(reorderCall.argv, ['reorder-surface', surfaceId, '--before', ORCH_SURFACE])
})

test('mountDocTab returns null and never throws when markdown open fails', () => {
  freshEnv('mount-doc-tab-fail')
  process.env.FAKE_CMUX_FAIL = 'markdown'
  assert.doesNotThrow(() => {
    const result = mountDocTab({ renderPath: '/tmp/x.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
    assert.equal(result, null)
  })
})

test('mountDocTab returns null loudly when the terminal surface is already gone, and does not throw', () => {
  freshEnv('mount-doc-tab-gone')
  const result = mountDocTab({ renderPath: '/tmp/x.md', paneId: 'irrelevant', terminalSurfaceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// Degraded-capability readers.
// ---------------------------------------------------------------------------

test('topTsv parses TSV rows, normalizes ids at ingestion (mixed-case fixture), and returns null when top is unavailable', () => {
  const { dir } = freshEnv('top-tsv')
  const topFile = join(dir, 'top.tsv')
  // Mixed-case on purpose — live `top` emits uppercase; a lowercase-only
  // fixture would hide topTsv failing to normalize (qa-lead vacuity C3).
  writeFileSync(topFile, 'surface_id\ttitle\nCcCcCcCc-0000-0000-0000-000000000000\thello\n')
  process.env.FAKE_CMUX_TOP = topFile
  const rows = topTsv()
  assert.deepEqual(rows, [{ surface_id: 'cccccccc-0000-0000-0000-000000000000', title: 'hello' }])

  process.env.FAKE_CMUX_FAIL = 'top'
  assert.equal(topTsv(), null)
})

test('checkVersion (via preflight) treats a non-zero --version exit as absent, not present', () => {
  const { dir } = freshEnv('version-nonzero-exit')
  process.env.FAKE_CMUX_FAIL = '--version'
  try {
    runPreflight(dir)
    assert.fail('expected preflight to throw')
  } catch (err) {
    assert.ok(err instanceof PreflightError)
    assert.equal(err.code, 'binary_missing')
    assert.equal(err.message, PREFLIGHT_MESSAGES.binary_missing)
  }
})

test('readEvents returns { unavailable: true } when the verb fails, sends --after/--no-ack/--no-heartbeat, and normalizes ids in parsed events', () => {
  const { dir, logPath } = freshEnv('read-events')
  process.env.FAKE_CMUX_FAIL = 'events'
  assert.deepEqual(readEvents({}), { unavailable: true })

  delete process.env.FAKE_CMUX_FAIL
  const eventsFile = join(dir, 'events.jsonl')
  writeFileSync(
    eventsFile,
    `${JSON.stringify({ seq: 1, name: 'dispatch', category: 'lifecycle', payload: { surface_id: 'ABCDEF01-0000-0000-0000-000000000000' } })}\n`,
  )
  process.env.FAKE_CMUX_EVENTS = eventsFile
  const result = readEvents({ afterSeq: 0, limit: 3 })
  assert.equal(result.seq, 1)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].payload.surface_id, 'abcdef01-0000-0000-0000-000000000000')

  // Live-verified working combination: --after --limit --no-ack --no-heartbeat.
  const eventsCall = readLog(logPath).filter((e) => e.argv[0] === 'events').at(-1)
  assert.deepEqual(eventsCall.argv, ['events', '--after', '0', '--limit', '3', '--no-ack', '--no-heartbeat'])
})

test('the fake rejects an events call missing both --after and --limit (an unbounded replay must not go unnoticed)', () => {
  const { dir } = freshEnv('read-events-underspecified')
  const eventsFile = join(dir, 'events.jsonl')
  writeFileSync(eventsFile, '')
  process.env.FAKE_CMUX_EVENTS = eventsFile
  const res = cmux('events', [])
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'bad_args')
})

test('the fake rejects a tree call missing --json or --id-format', () => {
  freshEnv('tree-underspecified')
  assert.equal(cmux('tree', []).ok, false)
  assert.equal(cmux('tree', ['--json']).ok, false)
  assert.equal(cmux('tree', ['--id-format', 'uuids']).ok, false)
  assert.equal(cmux('tree', ['--json', '--id-format', 'uuids']).ok, true)
})

test('tree() always sends --json --id-format uuids (asserted from the log, not just verb invocation)', () => {
  const { logPath } = freshEnv('tree-argv')
  tree({ all: true })
  const treeCall = readLog(logPath).find((e) => e.argv[0] === 'tree')
  assert.deepEqual(treeCall.argv, ['tree', '--json', '--id-format', 'uuids', '--all'])
})

// ---------------------------------------------------------------------------
// The fake fixture itself: every invocation is logged, including failures.
// ---------------------------------------------------------------------------

test('the fake logs every invocation, including a failing one, in order', () => {
  const { logPath } = freshEnv('fake-log')
  process.env.FAKE_CMUX_FAIL = 'ping'
  cmux('ping', [])
  cmux('tree', ['--json', '--id-format', 'uuids'], { json: true })
  const invocations = readLog(logPath)
  assert.equal(invocations.length, 2)
  assert.equal(invocations[0].argv[0], 'ping')
  assert.equal(invocations[1].argv[0], 'tree')
  assert.ok(invocations[0].ts)
})
