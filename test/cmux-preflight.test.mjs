// cmuxctl.mjs is the only boundary this repo has to the cmux CLI.
// CMUX_BIN must be set to test/fixtures/fake-cmux.mjs BEFORE cmuxctl.mjs is
// first imported, since CMUX_BIN is captured as a module-level constant at
// import time. Static `import` declarations always evaluate before any
// other top-level statement in the same module, so the env var is set via
// a dynamic import() inside top-level await instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
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
  setStatus, closeSurface, closeWorkspace, mountDocTab, findDocTabSurface, reorderDocTabFirst,
  PHASES, setPhase, topTsv, readEvents,
  TURN_END_EVENT_NAME, parseTurnEndEvent, TIERS, TIER_COLORS, clearProgress, setWorkspaceColor, readScreen,
} = await import(CMUXCTL_PATH)

// Fixed orchestrator ids baked into the fixture's fresh topology (lowercase
// forms — the mixed-case source lives in test/fixtures/fake-cmux.mjs).
const ORCH_WINDOW = 'f1a063e8-ec2c-40d7-932c-f3610adfe581'
const ORCH_WORKSPACE = 'a2a063e8-ec2c-40d7-932c-f3610adfe582'
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

// FOCUS BAN (be-06-01, acceptance criteria) — source-level guard: no
// scripts/cmux/*.mjs file may invoke focus-pane, focus-panel or
// select-workspace as a verb/argv literal. `--focus false` is the opposite
// of focusing and is exempt because it never matches these literals. The
// guard matches only a QUOTED occurrence (the shape every real verb/argv
// literal takes in this codebase, e.g. `'focus-pane'`) so a prose comment
// merely discussing the ban (e.g. dispatch.mjs's "never focus-pane / window
// focus") is not itself a false positive.
test('FOCUS BAN: no scripts/cmux/*.mjs file invokes focus-pane, focus-panel or select-workspace as a quoted literal', () => {
  const scriptsDir = join(HERE, '..', 'scripts', 'cmux')
  const scriptFiles = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs')).map((f) => join(scriptsDir, f))
  const forbidden = ['focus-pane', 'focus-panel', 'select-workspace']
  for (const path of scriptFiles) {
    const src = readFileSync(path, 'utf8')
    for (const token of forbidden) {
      // Backtick included alongside '/" — a template-literal verb argument
      // (e.g. `` `focus-pane` ``) must not slip past a quote class that only
      // covered single/double quotes.
      const quotedRe = new RegExp(`['"\`]${token}['"\`]`)
      assert.equal(quotedRe.test(src), false, `${path} invokes forbidden focus verb ${token} as a quoted literal`)
    }
  }
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

test('be-11-01: VERBS gains read-screen/clear-progress/workspace-action; VERB_METHODS gains NO new entry', () => {
  assert.ok(['read-screen', 'clear-progress', 'workspace-action'].every((v) => VERBS.includes(v)))
  assert.deepEqual(
    Object.keys(VERB_METHODS).sort(),
    [
      'capabilities', 'close-surface', 'close-workspace', 'identify', 'markdown', 'move-surface',
      'new-pane', 'new-window', 'new-workspace', 'ping', 'rename-tab', 'reorder-surface',
      'send', 'send-key', 'top', 'tree',
    ].sort(),
  )
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
  // unverifiable-by-capabilities, never gated (qa-lead addendum). wait-for
  // joined VERBS at 1c with deliberately no VERB_METHODS entry (never
  // preflight-gated), so it lands in the same unverifiable set. new-surface
  // joins at be-06-01 S6: the live capabilities capture is 255 dotted RPC
  // names and inventing one hard-stops every real run — it too gets no
  // VERB_METHODS entry (list order is whatever UNVERIFIABLE_VERBS's own
  // derivation — VERBS.filter(...).sort() — actually produces).
  // be-11-01 adds read-screen/clear-progress/workspace-action to VERBS with
  // deliberately no VERB_METHODS entry (cosmetic/diagnostic verbs — see the
  // comment at VERB_METHODS's definition site), so they join this same
  // unverifiable set. be-11-02 adds set-progress alongside them for the same
  // reason. be-12-01 adds `browser` for a second, DECISIVE reason on top of
  // the cosmetic-verb policy: VERB_METHODS is a one-verb-to-one-RPC-method
  // map and `browser` spans five methods, so no single entry could
  // represent the family — it lands in this same unverifiable set (this
  // deepEqual going red on the `browser` addition is expected and tracked,
  // not a regression).
  assert.deepEqual(
    result.unverifiable_verbs,
    ['browser', 'clear-progress', 'config', 'events', 'new-surface', 'read-screen', 'set-progress', 'set-status', 'wait-for', 'workspace-action'],
  )

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
// setPhase — the workspace phase pill (be-06-01 S9).
// ---------------------------------------------------------------------------

test('PHASES is frozen and exactly [planning, building, gate]', () => {
  assert.ok(Object.isFrozen(PHASES))
  assert.deepEqual(PHASES, ['planning', 'building', 'gate'])
})

test('setPhase issues `set-status devteam-phase <phase> --workspace <workspaceId>`, explicit target every time', () => {
  const { logPath } = freshEnv('set-phase-ok')
  setPhase('planning', { workspaceId: ORCH_WINDOW })
  const invocations = readLog(logPath)
  const call = invocations.find((e) => e.argv[0] === 'set-status')
  assert.deepEqual(call.argv, ['set-status', 'devteam-phase', 'planning', '--workspace', ORCH_WINDOW])
})

test('setPhase throws before any spawn for an out-of-enum phase', () => {
  const { logPath } = freshEnv('set-phase-bad-enum')
  assert.throws(() => setPhase('bogus', { workspaceId: ORCH_WINDOW }))
  assert.equal(existsSync(logPath), false)
})

test('setPhase throws before any spawn when workspaceId is missing', () => {
  const { logPath } = freshEnv('set-phase-no-workspace')
  assert.throws(() => setPhase('gate', {}))
  assert.equal(existsSync(logPath), false)
})

// ---------------------------------------------------------------------------
// clearProgress / setWorkspaceColor — be-11-01. Mirror setPhase's
// throw-before-spawn half and setStatus's degrade-loudly half.
// ---------------------------------------------------------------------------

test('clearProgress throws before any spawn when workspaceId is missing/empty', () => {
  const { logPath } = freshEnv('clear-progress-no-workspace')
  assert.throws(() => clearProgress({}))
  assert.throws(() => clearProgress({ workspaceId: '' }))
  assert.equal(existsSync(logPath), false)
})

test('clearProgress invokes exactly `clear-progress --workspace <id>`', () => {
  const { logPath } = freshEnv('clear-progress-ok')
  clearProgress({ workspaceId: ORCH_WINDOW })
  const call = readLog(logPath).find((e) => e.argv[0] === 'clear-progress')
  assert.deepEqual(call.argv, ['clear-progress', '--workspace', ORCH_WINDOW])
})

test('clearProgress never throws on a forced cmux failure — logs one loud line instead', () => {
  const { logPath } = freshEnv('clear-progress-fail')
  process.env.FAKE_CMUX_FAIL = 'clear-progress'
  assert.doesNotThrow(() => clearProgress({ workspaceId: ORCH_WINDOW }))
  const call = readLog(logPath).find((e) => e.argv[0] === 'clear-progress')
  assert.ok(call)
})

test('TIERS is frozen [1,2,3] and TIER_COLORS maps 1/2/3 to Teal/Blue/Purple', () => {
  assert.ok(Object.isFrozen(TIERS))
  assert.deepEqual(TIERS, [1, 2, 3])
  assert.ok(Object.isFrozen(TIER_COLORS))
  assert.deepEqual(TIER_COLORS, { 1: 'Teal', 2: 'Blue', 3: 'Purple' })
})

test('setWorkspaceColor throws before any spawn for an out-of-TIERS tier or a missing workspaceId', () => {
  const { logPath } = freshEnv('set-color-bad')
  assert.throws(() => setWorkspaceColor(4, { workspaceId: ORCH_WINDOW }))
  assert.throws(() => setWorkspaceColor(1, {}))
  assert.equal(existsSync(logPath), false)
})

test('setWorkspaceColor invokes exactly `workspace-action --action set-color --color <TIER_COLORS[tier]> --workspace <id>`', () => {
  const { logPath } = freshEnv('set-color-ok')
  setWorkspaceColor(2, { workspaceId: ORCH_WINDOW })
  const call = readLog(logPath).find((e) => e.argv[0] === 'workspace-action')
  assert.deepEqual(call.argv, ['workspace-action', '--action', 'set-color', '--color', 'Blue', '--workspace', ORCH_WINDOW])
})

test('setWorkspaceColor never throws on a forced cmux failure — logs one loud line instead', () => {
  const { logPath } = freshEnv('set-color-fail')
  process.env.FAKE_CMUX_FAIL = 'workspace-action'
  assert.doesNotThrow(() => setWorkspaceColor(3, { workspaceId: ORCH_WINDOW }))
  const call = readLog(logPath).find((e) => e.argv[0] === 'workspace-action')
  assert.ok(call)
})

test('clearProgress/setWorkspaceColor throw for a non-string workspaceId (number or object) — the typeof guard catches these, not just == null', () => {
  assert.throws(() => clearProgress({ workspaceId: 42 }))
  assert.throws(() => clearProgress({ workspaceId: { id: ORCH_WINDOW } }))
  assert.throws(() => setWorkspaceColor(1, { workspaceId: 42 }))
  assert.throws(() => setWorkspaceColor(1, { workspaceId: { id: ORCH_WINDOW } }))
})

test('GAP: a whitespace-only workspaceId ("   ") is NOT caught by the `typeof !== \'string\' || === \'\'` precondition — it spawns the call unchanged', () => {
  // Documents an actual precondition gap rather than papering over it: the
  // guard is `typeof workspaceId !== 'string' || workspaceId === ''`, which
  // rejects '' but not whitespace-only strings. This test pins today's
  // real (arguably wrong) behavior so a future tightening of the guard is a
  // deliberate, visible test change rather than a silent regression either
  // way.
  const { logPath } = freshEnv('clear-progress-whitespace-workspace')
  assert.doesNotThrow(() => clearProgress({ workspaceId: '   ' }))
  const call = readLog(logPath).find((e) => e.argv[0] === 'clear-progress')
  assert.deepEqual(call.argv, ['clear-progress', '--workspace', '   '])
})

test('setWorkspaceColor never coerces tier — a string "1", a fractional 1.5, and out-of-range -1/0 are all rejected', () => {
  assert.throws(() => setWorkspaceColor('1', { workspaceId: ORCH_WINDOW })) // string, not number — TIERS.includes uses ===
  assert.throws(() => setWorkspaceColor(1.5, { workspaceId: ORCH_WINDOW }))
  assert.throws(() => setWorkspaceColor(-1, { workspaceId: ORCH_WINDOW }))
  assert.throws(() => setWorkspaceColor(0, { workspaceId: ORCH_WINDOW }))
})

// ---------------------------------------------------------------------------
// readScreen — be-11-01. Callable through the frozen VERBS allowlist,
// re-resolves the surface first, never throws.
// ---------------------------------------------------------------------------

test('readScreen is callable through the frozen VERBS allowlist and returns the fake read-screen output', () => {
  freshEnv('read-screen-ok')
  const out = readScreen(ORCH_SURFACE, { lines: 20 })
  assert.equal(typeof out, 'string')
  assert.ok(out.length > 0)
})

test('readScreen no-ops loudly (returns null, never throws) when the surface is gone from a fresh tree', () => {
  freshEnv('read-screen-gone')
  assert.equal(readScreen('00000000-0000-0000-0000-000000000000', {}), null)
})

test('readScreen never throws when the underlying `tree` call itself fails (substrate wedged — rung 2 of the triage ladder is invoked precisely in this state) — degrades to null', () => {
  freshEnv('read-screen-tree-fails')
  process.env.FAKE_CMUX_FAIL = 'tree' // requireTargetPresent's tree() call throws on this
  assert.doesNotThrow(() => readScreen(ORCH_SURFACE, {}))
  assert.equal(readScreen(ORCH_SURFACE, {}), null)
})

test('readScreen never throws on a forced cmux failure — returns null instead', () => {
  freshEnv('read-screen-fail')
  process.env.FAKE_CMUX_FAIL = 'read-screen'
  assert.equal(readScreen(ORCH_SURFACE, {}), null)
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

// qa should-fix: the move-surface branch (the one place --focus false
// actually lives) was unreachable in every prior test — `markdown open
// --surface <terminal>` always lands the new surface in the SAME pane as
// the terminal surface. Force a FOREIGN target pane (a genuine second pane,
// created via createPane — never a topology hand-edit) so the new surface
// lands in ORCH_PANE while the requested target is elsewhere, and
// move-surface must fire.
test('mountDocTab: the created surface landing in a FOREIGN pane triggers move-surface <id> --pane <pane> --focus false, then reorder-surface', () => {
  const { logPath } = freshEnv('mount-doc-tab-foreign-pane')
  const { paneId: foreignPaneId } = createPane({ workspaceId: ORCH_WORKSPACE })
  const surfaceId = mountDocTab({ renderPath: '/tmp/foreign.md', paneId: foreignPaneId, terminalSurfaceId: ORCH_SURFACE })
  assert.match(surfaceId, /^[0-9a-f-]+$/)
  const invocations = readLog(logPath)
  const moveCall = invocations.find((e) => e.argv[0] === 'move-surface')
  assert.ok(moveCall, 'expected move-surface — the new surface landed in ORCH_PANE, not the requested foreign pane')
  assert.deepEqual(moveCall.argv, ['move-surface', surfaceId, '--pane', foreignPaneId, '--focus', 'false'])
  const reorderCall = invocations.find((e) => e.argv[0] === 'reorder-surface')
  assert.deepEqual(reorderCall.argv, ['reorder-surface', surfaceId, '--before', ORCH_SURFACE])
  // move-surface strictly precedes reorder-surface.
  assert.ok(invocations.indexOf(moveCall) < invocations.indexOf(reorderCall))
})

// be-06-01 S6/S7: mountDocTab is now a three-rung fallback chain. Rung 1
// (markdown open --surface) failing falls through to rung 2 (new-surface
// browser) rather than returning null outright — the forced-failure
// exercise of the FULL chain (all three rungs) lives in
// test/cmux-dispatch.test.mjs per the acceptance criteria.
test('mountDocTab falls through to rung 2 (new-surface) when rung 1 (markdown open) fails, and never throws', () => {
  const { logPath } = freshEnv('mount-doc-tab-fail')
  process.env.FAKE_CMUX_FAIL = 'markdown'
  let surfaceId
  assert.doesNotThrow(() => {
    surfaceId = mountDocTab({ renderPath: '/tmp/x.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  })
  assert.match(surfaceId, /^[0-9a-f-]+$/)
  const invocations = readLog(logPath)
  const newSurfaceCall = invocations.find((e) => e.argv[0] === 'new-surface')
  assert.ok(newSurfaceCall, 'new-surface must be invoked as rung 2')
  assert.deepEqual(newSurfaceCall.argv, ['new-surface', '--type', 'browser', '--url', 'file:///tmp/x.md', '--pane', ORCH_PANE, '--focus', 'false'])
  assert.equal(invocations.some((e) => e.argv[0] === 'focus-pane'), false)
})

test('mountDocTab returns null and never throws when all three rungs fail', () => {
  freshEnv('mount-doc-tab-all-fail')
  process.env.FAKE_CMUX_FAIL = 'markdown,new-surface'
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

// MUTATION-KILLER (qa-lead gate audit): mountDocTab's own header comment
// promises "NEVER throws". tree() itself THROWS when `cmux tree` fails
// (cmuxctl.mjs:221 — "tree: cmux tree failed: ..."), and mountDocTab's very
// first line is `const before = tree({ all: true })` — a total cmux/tree
// outage (not merely "the terminal surface is gone from a successful
// tree", which every other never-throw fixture here exercises) is the one
// failure mode none of those fixtures reach. Without mountDocTab's OWN
// outer try/catch, this propagates straight out of a dispatch.
test('mountDocTab never throws even when the underlying `tree` call itself fails (total cmux outage, not just a missing surface)', () => {
  freshEnv('mount-doc-tab-tree-fails')
  process.env.FAKE_CMUX_FAIL = 'tree'
  let result
  assert.doesNotThrow(() => {
    result = mountDocTab({ renderPath: '/tmp/x.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  })
  assert.equal(result, null)
})

// qa should-fix (b): a post-creation placement failure (move-surface or
// reorder-surface) must never abandon the surface it created silently —
// closeSurface is attempted best-effort and the rung still falls through to
// the next one. FAKE_CMUX_FAIL=reorder-surface makes rung 1 and rung 2 BOTH
// create a surface and then fail to place it; rung 3 (which never calls
// reorder-surface) still succeeds.
test('mountDocTab: FAKE_CMUX_FAIL=reorder-surface — rung 1 and rung 2 orphans are each closed (best-effort) before falling through, and rung 3 still succeeds', () => {
  const { logPath } = freshEnv('mount-doc-tab-orphan-close')
  process.env.FAKE_CMUX_FAIL = 'reorder-surface'
  const surfaceId = mountDocTab({ renderPath: '/tmp/orphan.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  assert.match(surfaceId, /^[0-9a-f-]+$/)

  const invocations = readLog(logPath)
  const closeSurfaceCalls = invocations.filter((e) => e.argv[0] === 'close-surface')
  assert.equal(closeSurfaceCalls.length, 2, `expected exactly two close-surface calls (rung 1's orphan + rung 2's orphan), got ${JSON.stringify(closeSurfaceCalls)}`)
  // The final, successfully-returned rung-3 surface must never itself be closed.
  assert.equal(closeSurfaceCalls.some((c) => c.argv[1] === surfaceId), false)
})

// qa should-fix (c): an id-recovery ambiguity (concurrent creation racing a
// rung's own tree-diff) must ABORT the whole chain — exactly one creation
// attempt, never advancing to rung 2/3. Constructed via a PRE-SEEDED
// FAKE_CMUX_STATE flag (never a new env switch) that makes the fixture's own
// `markdown open --surface` handler create a SECOND, "racing" surface
// alongside the real one — see fake-cmux.mjs's `_simulateConcurrentCreate`.
test('mountDocTab: a recoverNewId ambiguity (concurrent creation) ABORTS the whole chain — exactly one creation attempt, no fallthrough to rung 2/3', () => {
  const { logPath, statePath } = freshEnv('mount-doc-tab-concurrent-abort')
  writeFileSync(statePath, JSON.stringify({
    _seq: 4,
    _simulateConcurrentCreate: true,
    windows: [{
      id: ORCH_WINDOW,
      title: 'orchestrator',
      workspaces: [{
        id: ORCH_WORKSPACE,
        window_id: ORCH_WINDOW,
        title: 'main',
        panes: [{
          id: ORCH_PANE,
          workspace_id: ORCH_WORKSPACE,
          surface_ids: [ORCH_SURFACE],
          selected_surface_id: ORCH_SURFACE,
          surfaces: [{ id: ORCH_SURFACE, pane_id: ORCH_PANE, type: 'agent-session', tty: '/dev/ttys001', title: 'orchestrator' }],
        }],
      }],
    }],
  }))

  const result = mountDocTab({ renderPath: '/tmp/concurrent.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  assert.equal(result, null, 'a recoverNewId ambiguity must abort to null, never a fallback surface id')

  const invocations = readLog(logPath)
  const markdownOpens = invocations.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open')
  assert.equal(markdownOpens.length, 1, 'expected exactly ONE creation attempt — the abort must not advance to rung 2/3')
  assert.equal(invocations.some((e) => e.argv[0] === 'new-surface'), false, 'rung 2 must never fire after an id-recovery abort')
})

// qa should-fix (d): rung 2's post-mount placement verification failing must
// be an ORDINARY rung failure (falls through to rung 3, with orphan
// handling per fix 2), never an abort — only an id-recovery ambiguity
// aborts. Rung 1 is forced to fail via FAKE_CMUX_FAIL='markdown' (which
// blanket-fails every `markdown` verb invocation, rung 1 AND rung 3 alike —
// that is deliberate here: it lets this test observe rung 3 being REACHED
// (the fallthrough itself) without needing rung 3 to also succeed, which is
// already covered by the "all three rungs fail" test). Rung 2's own
// reorder-surface is made to silently relocate the surface away from the
// target pane via the PRE-SEEDED `_simulateBrowserSurfaceRelocateOnReorder`
// state flag (never a new env switch, and gated on type === 'browser' so it
// can only ever affect rung 2's own surface) — mountDocTab's own post-mount
// re-read then finds it absent from the target pane and must fall through,
// not abort.
test('mountDocTab: rung 2 post-mount placement-verification failure is an ORDINARY rung failure (falls through, orphan closed) — not an abort', () => {
  const { logPath, statePath } = freshEnv('mount-doc-tab-rung2-placement-fail')
  const { paneId: foreignPaneId } = createPane({ workspaceId: ORCH_WORKSPACE })
  const seeded = JSON.parse(readFileSync(statePath, 'utf8'))
  seeded._simulateBrowserSurfaceRelocateOnReorder = true
  writeFileSync(statePath, JSON.stringify(seeded))
  process.env.FAKE_CMUX_FAIL = 'markdown'

  const result = mountDocTab({ renderPath: '/tmp/placement.md', paneId: foreignPaneId, terminalSurfaceId: ORCH_SURFACE })
  // rung 3 also fails here (FAKE_CMUX_FAIL='markdown' blanket-fails it too)
  // — the point of this test is that the chain ADVANCES to rung 3 rather
  // than aborting, not that rung 3 itself succeeds.
  assert.equal(result, null)

  const invocations = readLog(logPath)
  const newSurfaceCall = invocations.find((e) => e.argv[0] === 'new-surface')
  assert.ok(newSurfaceCall, 'rung 2 must have been attempted')
  const closeSurfaceCalls = invocations.filter((e) => e.argv[0] === 'close-surface')
  assert.ok(closeSurfaceCalls.length >= 1, 'expected at least one close-surface call for rung 2\'s verification-failed (orphaned) surface — fix 2')
  const markdownOpens = invocations.filter((e) => e.argv[0] === 'markdown' && e.argv[1] === 'open')
  assert.ok(markdownOpens.some((e) => !e.argv.includes('--surface')), 'expected the chain to ADVANCE to rung 3 (markdown open, no --surface) rather than abort after rung 2\'s verification failure')
})

// ---------------------------------------------------------------------------
// findDocTabSurface / reorderDocTabFirst — isolated unit coverage.
// ---------------------------------------------------------------------------

test('findDocTabSurface: returns the sole non-terminal surface in the pane, not ambiguous', () => {
  freshEnv('find-doc-tab-solo')
  const surfaceId = mountDocTab({ renderPath: '/tmp/x.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  assert.match(surfaceId, /^[0-9a-f-]+$/)
  const t = tree({ all: true })
  assert.deepEqual(findDocTabSurface(t, { paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE }), { id: surfaceId, ambiguous: false })
})

test('findDocTabSurface: restricts to markdown-typed candidates when more than one non-terminal surface exists', () => {
  // A synthetic tree, not a live fixture round-trip: two non-terminal
  // surfaces share the pane (a stray 'terminal'-typed one plus the real
  // 'markdown' doc tab) — the lookup must narrow to the markdown-typed
  // candidate rather than reporting ambiguity.
  const t = {
    windows: [{
      workspaces: [{
        panes: [{
          id: ORCH_PANE,
          surfaces: [
            { id: ORCH_SURFACE, type: 'agent-session' },
            { id: 'stray-terminal-surface', type: 'terminal' },
            { id: 'the-doc-tab-surface', type: 'markdown' },
          ],
        }],
      }],
    }],
  }
  assert.deepEqual(findDocTabSurface(t, { paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE }), { id: 'the-doc-tab-surface', ambiguous: false })
})

test('findDocTabSurface: ambiguous:true (id:null) when more than one candidate remains and none is markdown-typed — a DISTINCT outcome from "no doc tab"', () => {
  const t = {
    windows: [{
      workspaces: [{
        panes: [{
          id: ORCH_PANE,
          surfaces: [
            { id: ORCH_SURFACE, type: 'agent-session' },
            { id: 'a', type: 'terminal' },
            { id: 'b', type: 'terminal' },
          ],
        }],
      }],
    }],
  }
  assert.deepEqual(findDocTabSurface(t, { paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE }), { id: null, ambiguous: true })
})

test('findDocTabSurface: ambiguous:true (>=2 markdown candidates) is fail-CLOSED, distinct from "no doc tab"', () => {
  const t = {
    windows: [{
      workspaces: [{
        panes: [{
          id: ORCH_PANE,
          surfaces: [
            { id: ORCH_SURFACE, type: 'agent-session' },
            { id: 'md-a', type: 'markdown' },
            { id: 'md-b', type: 'markdown' },
          ],
        }],
      }],
    }],
  }
  assert.deepEqual(findDocTabSurface(t, { paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE }), { id: null, ambiguous: true })
})

test('findDocTabSurface: never throws for an unknown pane id, and reports id:null, ambiguous:false ("no doc tab", not "ambiguous")', () => {
  freshEnv('find-doc-tab-unknown-pane')
  const t = tree({ all: true })
  assert.deepEqual(findDocTabSurface(t, { paneId: 'nope', terminalSurfaceId: ORCH_SURFACE }), { id: null, ambiguous: false })
})

test('reorderDocTabFirst: issues reorder-surface --before and never focuses; returns false when no doc tab is present', () => {
  const { logPath } = freshEnv('reorder-doc-tab-first')
  assert.equal(reorderDocTabFirst({ paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE }), false)

  const surfaceId = mountDocTab({ renderPath: '/tmp/x.md', paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  const ok = reorderDocTabFirst({ paneId: ORCH_PANE, terminalSurfaceId: ORCH_SURFACE })
  assert.equal(ok, true)
  const invocations = readLog(logPath)
  const reorderCalls = invocations.filter((e) => e.argv[0] === 'reorder-surface')
  assert.ok(reorderCalls.some((c) => c.argv[1] === surfaceId && c.argv[2] === '--before' && c.argv[3] === ORCH_SURFACE))
  assert.equal(invocations.some((e) => e.argv[0] === 'focus-pane'), false)
})

// ---------------------------------------------------------------------------
// Degraded-capability readers.
// ---------------------------------------------------------------------------

test('topTsv parses the real HEADERLESS 7-column `top --format tsv` shape positionally — the first line is DATA, never consumed as a header', () => {
  const { dir } = freshEnv('top-tsv')
  const topFile = join(dir, 'top.tsv')
  // `top` emits no header row at all; a header-consuming parser fed this
  // 3-row fixture (first row a `total` rollup, not a header) would drop it
  // and return only 2 rows.
  writeFileSync(
    topFile,
    '0.0\t0\t0\ttotal\ttotal\t\t\n'
    + '0.1\t245760000\t2\twindow\twindow:1\t\torchestrator\n'
    + '18.2\t517574328\t8\tsurface\tsurface:1\tpane:1\t<spinner> Claude Code\n',
  )
  process.env.FAKE_CMUX_TOP = topFile
  const rows = topTsv()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { cpu_pct: '0.0', mem_bytes: '0', proc_count: '0', kind: 'total', id: 'total', parent_id: '', title_or_status: '' })
  // `top` has no --id-format flag — ids are positional refs (surface:1),
  // never UUIDs, so there is nothing to normalize: normalizeIds is NOT
  // applied here. surface:1 comes back unchanged, not lowercased-through-a-
  // normalizer (it already is lowercase, but a normalizer would also have
  // been a no-op-shaped hole for a mixed-case positional ref).
  assert.deepEqual(rows[2], { cpu_pct: '18.2', mem_bytes: '517574328', proc_count: '8', kind: 'surface', id: 'surface:1', parent_id: 'pane:1', title_or_status: '<spinner> Claude Code' })

  process.env.FAKE_CMUX_FAIL = 'top'
  assert.equal(topTsv(), null)
})

test('topTsv threads its timeout into cmux(top, ..., {timeoutMs}), defaulting to 2000ms', () => {
  // spawnSync's timeout is not observable through the fixture log (it is a
  // child_process option, not an argv entry) — assert the default value
  // itself, since that is the only thing this fixture can prove.
  assert.equal(topTsv.length, 0) // ({ timeoutMs = 2000 } = {}) — no required arg
  const src = readFileSync(CMUXCTL_PATH, 'utf8')
  assert.match(src, /timeoutMs\s*=\s*2000/)
})

test('topTsv on a truncated row (fewer than 7 tab-separated fields) leaves the missing trailing fields undefined rather than shifting columns', () => {
  const { dir } = freshEnv('top-tsv-truncated')
  const topFile = join(dir, 'top.tsv')
  // Real cmux truncation would drop trailing columns, not leading ones —
  // a parser that silently reindexed would misassign kind/id and could
  // make a `total` rollup row look like a `surface` row.
  writeFileSync(topFile, '1.0\t100\t2\n')
  process.env.FAKE_CMUX_TOP = topFile
  const rows = topTsv()
  assert.deepEqual(rows, [{ cpu_pct: '1.0', mem_bytes: '100', proc_count: '2', kind: undefined, id: undefined, parent_id: undefined, title_or_status: undefined }])
})

test('topTsv on a row with MORE than 7 tab-separated fields keeps the first 7 positionally and drops the rest — never shifts or throws', () => {
  const { dir } = freshEnv('top-tsv-extra-fields')
  const topFile = join(dir, 'top.tsv')
  writeFileSync(topFile, '1.0\t100\t2\tsurface\tsurface:1\tpane:1\ttitle\tEXTRA1\tEXTRA2\n')
  process.env.FAKE_CMUX_TOP = topFile
  const rows = topTsv()
  assert.deepEqual(rows, [{ cpu_pct: '1.0', mem_bytes: '100', proc_count: '2', kind: 'surface', id: 'surface:1', parent_id: 'pane:1', title_or_status: 'title' }])
})

test('topTsv on completely empty stdout, a single blank line, and multiple trailing blank lines all return [] / skip the blanks — never a [""]-shaped row', () => {
  const { dir } = freshEnv('top-tsv-blank')
  const emptyFile = join(dir, 'empty.tsv')
  writeFileSync(emptyFile, '')
  process.env.FAKE_CMUX_TOP = emptyFile
  assert.deepEqual(topTsv(), [])

  const singleBlankFile = join(dir, 'single-blank.tsv')
  writeFileSync(singleBlankFile, '\n')
  process.env.FAKE_CMUX_TOP = singleBlankFile
  assert.deepEqual(topTsv(), [])

  const trailingBlanksFile = join(dir, 'trailing-blanks.tsv')
  writeFileSync(trailingBlanksFile, '0.1\t245760000\t2\twindow\twindow:1\t\torchestrator\n\n\n')
  process.env.FAKE_CMUX_TOP = trailingBlanksFile
  const rows = topTsv()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'window')
})

test('topTsv passes non-numeric cpu_pct/mem_bytes/proc_count through unchanged as raw strings — it never coerces or NaNs them', () => {
  const { dir } = freshEnv('top-tsv-non-numeric')
  const topFile = join(dir, 'top.tsv')
  writeFileSync(topFile, 'N/A\tnot-a-number\t\tsurface\tsurface:9\tpane:9\tweird row\n')
  process.env.FAKE_CMUX_TOP = topFile
  const rows = topTsv()
  assert.deepEqual(rows, [{ cpu_pct: 'N/A', mem_bytes: 'not-a-number', proc_count: '', kind: 'surface', id: 'surface:9', parent_id: 'pane:9', title_or_status: 'weird row' }])
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

// ---------------------------------------------------------------------------
// TURN_END_EVENT_NAME / parseTurnEndEvent — be-11-01. The turn-end event is
// `agent.hook.Stop`, NOT `notification.requested` (the TRD/ADR-003's stale
// assumption — see the Superseded-since-ratification errata).
// ---------------------------------------------------------------------------

test('TURN_END_EVENT_NAME is the frozen string agent.hook.Stop', () => {
  assert.equal(TURN_END_EVENT_NAME, 'agent.hook.Stop')
})

test('POSITIVE mutation-proof: parseTurnEndEvent arms on the live-captured agent.hook.Stop fixture, keyed to TURN_END_EVENT_NAME (not to any event name literal), and lowercases surfaceId even fed the raw mixed-case fixture directly', () => {
  const raw = readFileSync(join(HERE, 'fixtures', 'live-agent-hook-stop.jsonl'), 'utf8').trim()
  const rawEvent = JSON.parse(raw)
  assert.equal(rawEvent.name, TURN_END_EVENT_NAME) // fixture-keyed: arms because the value matches, not because the name literal matches
  assert.equal(rawEvent.surface_id, '5859A559-6B87-4206-A2E2-DCBC1E7B8753') // fixture is genuinely mixed-case, uncoerced
  const parsed = parseTurnEndEvent(rawEvent)
  // parseTurnEndEvent normalizes surfaceId itself (via normalizeId), so its
  // output is idempotently lowercase regardless of caller — this is fed
  // the raw fixture directly (bypassing readEvents' own normalizeIds pass)
  // and must still come back lowercase.
  assert.deepEqual(parsed, {
    surfaceId: '5859a559-6b87-4206-a2e2-dcbc1e7b8753',
    occurredAt: '2026-08-05T09:19:12.190Z',
    seq: 18338,
  })
})

test('normalization boundary: the committed agent.hook.Stop fixture run through the REAL readEvents path (normalizeIds) still comes back lowercase from parseTurnEndEvent', () => {
  const { dir } = freshEnv('turn-end-via-read-events')
  const eventsFile = join(dir, 'agent-hook-stop.jsonl')
  writeFileSync(eventsFile, readFileSync(join(HERE, 'fixtures', 'live-agent-hook-stop.jsonl'), 'utf8'))
  process.env.FAKE_CMUX_EVENTS = eventsFile
  const { events } = readEvents({ afterSeq: 0, limit: 10 })
  assert.equal(events.length, 1)
  // readEvents' own normalizeIds pass has already lowercased the top-level
  // surface_id by the time it reaches parseTurnEndEvent.
  assert.equal(events[0].surface_id, '5859a559-6b87-4206-a2e2-dcbc1e7b8753')
  const parsed = parseTurnEndEvent(events[0])
  assert.deepEqual(parsed, {
    surfaceId: '5859a559-6b87-4206-a2e2-dcbc1e7b8753',
    occurredAt: '2026-08-05T09:19:12.190Z',
    seq: 18338,
  })
})

test('NEGATIVE: a fixture containing only notification.requested lines produces zero parseTurnEndEvent arms', () => {
  const { dir } = freshEnv('turn-end-negative')
  const notifyOnly = join(dir, 'notify-only.jsonl')
  writeFileSync(
    notifyOnly,
    `${JSON.stringify({ name: 'notification.requested', seq: 1, occurred_at: '2026-08-05T00:00:00.000Z', surface_id: '11111111-0000-0000-0000-000000000000' })}\n`,
  )
  process.env.FAKE_CMUX_EVENTS = notifyOnly
  const { events } = readEvents({ afterSeq: 0, limit: 10 })
  assert.equal(events.length, 1)
  const armed = events.map(parseTurnEndEvent).filter((e) => e !== null)
  assert.deepEqual(armed, [])
})

test('parseTurnEndEvent returns null (never a defaulted value) when surface_id or occurred_at is missing/unparseable', () => {
  assert.equal(parseTurnEndEvent(null), null)
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME }), null) // no surface_id anywhere
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME, surface_id: 'abc' }), null) // no occurred_at
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME, surface_id: 'abc', occurred_at: 'not-a-date' }), null) // unparseable
  // falls back to payload.surface_id only when the top-level key is absent
  const viaPayload = parseTurnEndEvent({ name: TURN_END_EVENT_NAME, occurred_at: '2026-08-05T00:00:00.000Z', payload: { surface_id: 'xyz' } })
  assert.deepEqual(viaPayload, { surfaceId: 'xyz', occurredAt: '2026-08-05T00:00:00.000Z', seq: undefined })
})

test('parseTurnEndEvent returns null when payload is explicitly null (not just absent) and no top-level surface_id exists — optional chaining must not throw', () => {
  assert.doesNotThrow(() => parseTurnEndEvent({ name: TURN_END_EVENT_NAME, occurred_at: '2026-08-05T00:00:00.000Z', payload: null }))
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME, occurred_at: '2026-08-05T00:00:00.000Z', payload: null }), null)
})

test('parseTurnEndEvent returns null when occurred_at is a non-string (a number, or null) even though a naive Date.parse would coerce a number', () => {
  // Date.parse(1234567890000) would actually succeed if occurred_at were
  // passed through un-type-checked — the typeof guard must reject it
  // before Date.parse ever runs, not rely on Date.parse to reject it.
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME, surface_id: 'abc', occurred_at: 1770000000000 }), null)
  assert.equal(parseTurnEndEvent({ name: TURN_END_EVENT_NAME, surface_id: 'abc', occurred_at: null }), null)
})

test('parseTurnEndEvent passes seq through unvalidated — a negative or extremely large seq is neither rejected nor clamped', () => {
  const base = { name: TURN_END_EVENT_NAME, surface_id: 'abc', occurred_at: '2026-08-05T00:00:00.000Z' }
  assert.equal(parseTurnEndEvent({ ...base, seq: -5 }).seq, -5)
  assert.equal(parseTurnEndEvent({ ...base, seq: Number.MAX_SAFE_INTEGER }).seq, Number.MAX_SAFE_INTEGER)
})

test('mutation check: changing TURN_END_EVENT_NAME breaks the positive fixture-arming test (documented, not re-executed here)', () => {
  // This test documents the required manual mutation-proof: editing
  // TURN_END_EVENT_NAME's value in cmuxctl.mjs to 'notification.requested'
  // and re-running this file must fail the POSITIVE test above, because
  // that test's assertion is fixture-keyed (rawEvent.name === TURN_END_EVENT_NAME)
  // rather than name-keyed to a re-typed literal. Verified manually per the
  // handover spec; not re-executed automatically to avoid mutating source
  // at test time.
  assert.ok(true)
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
