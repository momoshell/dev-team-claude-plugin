#!/usr/bin/env node
// The single, enumerated boundary between this repo and the cmux CLI.
// Owns: invocation + error parsing, deep mixed-case-proof UUID
// normalization at ingestion, tree-diff id recovery for every created
// object, the preflight security gate (with its five verbatim remediation
// messages and their single-definition-site drift guard), and the
// two-window team seating. Nothing outside this module talks to the cmux
// binary directly, and nothing outside this module re-types a preflight
// remediation message (be-1b-E asserts against the IMPORTED constant only —
// see PREFLIGHT_MESSAGES below).
//
// Zero dependencies: node builtins only.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

// The binary is ALWAYS this constant — never a literal 'cmux' elsewhere in
// this module or in any test. Tests set CMUX_BIN to the fixture so no test
// in this repo ever touches a live cmux.
export const CMUX_BIN = process.env.CMUX_BIN || 'cmux'

// Every cmux verb this module may invoke. There is no dynamic verb
// construction anywhere: cmux() asserts membership before spawning.
export const VERBS = Object.freeze([
  'ping', 'identify', 'capabilities', 'tree', 'new-window', 'new-workspace', 'new-pane',
  'markdown', 'move-surface', 'reorder-surface', 'send', 'send-key', 'rename-tab',
  'set-status', 'close-surface', 'close-workspace', 'top', 'events', 'config', 'wait-for',
  'new-surface', 'read-screen', 'clear-progress', 'workspace-action', 'set-progress', 'browser',
])

// Live `capabilities --json` (cmux 0.64.20) returns 255 RPC-style DOTTED
// method names (system.ping, workspace.create, surface.send_text, ...) —
// NOT CLI verb names. A `VERBS ⊆ methods` check against CLI names hard-stops
// every real run. VERB_METHODS maps each CLI verb this module invokes to
// the RPC method that must be present, confidence-verified against a live
// capture (see live-capabilities.json in the 1b fix-plan package). A verb
// with NO entry here (events, config, set-status — stream/compat endpoints,
// or verbs with no confidently-known method name) is NOT gated: preflight
// records it as unverifiable-by-capabilities instead of failing on it.
export const VERB_METHODS = Object.freeze({
  ping: 'system.ping',
  identify: 'system.identify',
  capabilities: 'system.capabilities',
  tree: 'system.tree',
  top: 'system.top',
  'new-window': 'window.create',
  'new-workspace': 'workspace.create',
  'close-workspace': 'workspace.close',
  'new-pane': 'pane.create',
  send: 'surface.send_text',
  'send-key': 'surface.send_key',
  'close-surface': 'surface.close',
  'move-surface': 'surface.move',
  'reorder-surface': 'surface.reorder',
  markdown: 'markdown.open',
  'rename-tab': 'tab.action',
  // read-screen/clear-progress/workspace-action/set-progress are cosmetic/
  // diagnostic verbs (screen reads, progress pill clears/sets, tab color)
  // deliberately left OUT of this map: guessing a dotted method for them
  // (e.g. read-screen -> surface.read_text) hard-stops every real run if the
  // guess is wrong, while every test still passes against the fixture. They
  // land in UNVERIFIABLE_VERBS instead and are never capability-gated.
  //
  // browser (be-12-01, issue #12/D1) is excluded for a second, DECISIVE
  // reason beyond the cosmetic-verb policy above: this map is a one-CLI-verb
  // -> one-RPC-method mapping, and `browser` spans FIVE RPC methods
  // (browser.open, browser.goto, browser.wait_for, browser.errors,
  // browser.screenshot) behind its own frozen BROWSER_SUBVERBS allowlist —
  // no single entry here could represent the family without gating all five
  // capabilities on one guessed name. The preview is also non-load-bearing
  // (no dispatch-lifecycle decision, completion outcome, or gate verdict
  // depends on it), so it degrades loudly at the point of use — reading the
  // cached preflight.json `methods` array directly, the same shape
  // `close_workspace_available` already uses — rather than hard-stopping
  // preflight on every dispatch, including backend-only ones that will never
  // open a browser.
})

// The five remediation messages, BYTE-FOR-BYTE, single definition site.
// be-1b-E imports this object and must never re-type a literal; the drift
// guard in test/cmux-preflight.test.mjs greps this module's own source text
// to make a re-typed copy (here or in be-1b-E) fail a test.
export const PREFLIGHT_MESSAGES = Object.freeze({
  binary_missing:
    'cmux is required by execution_mode: cmux. Install: brew tap manaflow-ai/cmux && brew install --cask cmux — then start this session inside a cmux terminal.',
  not_running: 'cmux is installed but not running. Start the cmux app and retry.',
  not_in_pane:
    'This session is not running inside a cmux pane. Socket control mode is cmuxOnly by design — open a cmux terminal in this project and start Claude Code there.',
  verb_missing:
    'Installed cmux <ver> does not expose <verb>. brew upgrade --cask cmux, or set execution_mode: agent-tool in .claude/dev-team/config.md to use the legacy substrate.',
  adapter_missing: "Roster role <r> needs agent CLI '<cli>', not found on PATH.",
})

/**
 * formatPreflightMessage(key, subs) -> string
 * binary_missing/not_running/not_in_pane carry no placeholders and are
 * returned verbatim (the templates themselves ARE the byte-frozen message).
 * verb_missing/adapter_missing are interpolated at throw time — the
 * TEMPLATE (with literal `<ver>`/`<verb>`/`<r>`/`<cli>`) stays byte-frozen
 * in PREFLIGHT_MESSAGES; only the formatted, substituted string is ever
 * thrown or shown to an operator.
 */
export function formatPreflightMessage(key, subs = {}) {
  const template = PREFLIGHT_MESSAGES[key]
  if (template === undefined) throw new Error(`formatPreflightMessage: unknown key ${key}`)
  if (key === 'verb_missing') {
    return template.replace('<ver>', subs.ver ?? '<ver>').replace('<verb>', subs.verb ?? '<verb>')
  }
  if (key === 'adapter_missing') {
    return template.replace('<r>', subs.role ?? '<r>').replace('<cli>', subs.cli ?? '<cli>')
  }
  return template
}

export class PreflightError extends Error {
  constructor(key, message, diagnostics = null) {
    super(message)
    this.name = 'PreflightError'
    this.key = key
    this.code = key
    this.diagnostics = diagnostics
  }
}

// ---------------------------------------------------------------------------
// ID normalization — deep, mixed-case-proof. Every id parsed out of cmux
// output is lowercased HERE, at ingestion, and nowhere else. Live cmux
// (--id-format uuids) emits uppercase; cmux resolves targets
// case-insensitively; every frozen schema pattern in this repo is
// lowercase-only. Non-id string values (title, tty, type, name, ...) are
// left untouched — only *_id keys and *_ids array elements are lowercased.
// ---------------------------------------------------------------------------
export function normalizeId(s) {
  return typeof s === 'string' ? s.toLowerCase() : s
}

export function normalizeIds(value) {
  if (Array.isArray(value)) return value.map((v) => normalizeIds(v))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      if (key.endsWith('_ids') && Array.isArray(v)) {
        out[key] = v.map((x) => (typeof x === 'string' ? normalizeId(x) : normalizeIds(x)))
      } else if (key.endsWith('_id') && typeof v === 'string') {
        out[key] = normalizeId(v)
      } else if (key === 'id' && typeof v === 'string') {
        out[key] = normalizeId(v)
      } else {
        out[key] = normalizeIds(v)
      }
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Invocation.
// ---------------------------------------------------------------------------

function runVerb(verb, args, opts = {}) {
  if (!VERBS.includes(verb)) {
    throw new Error(`cmuxctl: refusing to invoke a verb outside the frozen VERBS allowlist: ${verb}`)
  }
  return spawnSync(CMUX_BIN, [verb, ...args], { encoding: 'utf8', timeout: opts.timeoutMs })
}

const ERROR_LINE_RE = /^Error:\s*([^:]+):\s*(.+)$/m

/**
 * cmux(verb, args, { json, timeoutMs }) -> { ok, code, stdout, json, error }
 * Never throws for a non-zero exit — that convention is `error`. Throws
 * only for a programmer error (spawn setup itself, or an out-of-allowlist
 * verb).
 */
export function cmux(verb, args = [], opts = {}) {
  const result = runVerb(verb, args, opts)
  if (result.error) {
    return { ok: false, code: null, stdout: '', json: null, error: { code: 'spawn_error', message: result.error.message } }
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.status === 0) {
    let json = null
    if (opts.json) {
      try {
        json = normalizeIds(JSON.parse(stdout))
      } catch (err) {
        return { ok: false, code: 0, stdout, json: null, error: { code: 'bad_json', message: `failed to parse JSON stdout: ${err.message}` } }
      }
    }
    return { ok: true, code: 0, stdout, json, error: null }
  }
  const match = stderr.match(ERROR_LINE_RE)
  const error = match
    ? { code: match[1].trim(), message: match[2].trim() }
    : { code: 'unknown', message: stderr.trim() || `exit ${result.status}` }
  return { ok: false, code: result.status, stdout, json: null, error }
}

/**
 * signalToken(token) -> boolean
 * be-1c-04's adapter-side exit handler fires this, best-effort, after claude
 * has already exited (the token then appears in the `cmux wait-for -S
 * <token>` child process's own argv, visible to `ps` for the residual
 * one-wasted-loop window ADR-003 Am.1 bounds — never before that point).
 * `wait-for` carries no VERB_METHODS entry (no confidently-known RPC method
 * name) and must never be preflight-gated on one; it is still a VERBS
 * member so runVerb's allowlist accepts it. Never throws and never logs
 * `token` — a failed signal degrades to the orchestrator's own poll cadence,
 * never a crash.
 */
export function signalToken(token) {
  if (typeof token !== 'string' || token === '') {
    return false
  }
  try {
    const res = cmux('wait-for', ['-S', token], { timeoutMs: 5000 })
    return res.ok
  } catch {
    return false
  }
}

function checkVersion() {
  const result = spawnSync(CMUX_BIN, ['--version'], { encoding: 'utf8' })
  // A present-but-broken binary (non-zero exit) reads as absent, not present
  // — checkVersion is the ONLY signal `preflight`'s binary-present step has.
  if (result.error || result.status !== 0) return { present: false, version: null }
  return { present: true, version: (result.stdout || '').trim() }
}

// ---------------------------------------------------------------------------
// Tree + id recovery.
// ---------------------------------------------------------------------------

/**
 * tree({ all, timeoutMs }) -> treeJson
 * `timeoutMs` is OPTIONAL (be-12-01, issue #12/D4): default `undefined`,
 * which spawnSync treats as unbounded — byte-for-byte today's behavior at
 * every existing call site above. It exists so a bounded caller
 * (`ensurePreviewBrowser`'s critical-section scan/after-tree reads, be-12-02)
 * can pass an explicit bound without every other `tree()` caller in this
 * module changing shape.
 */
export function tree({ all = false, timeoutMs } = {}) {
  const args = ['--json', '--id-format', 'uuids']
  if (all) args.push('--all')
  const res = cmux('tree', args, { json: true, timeoutMs })
  if (!res.ok) throw new Error(`tree: cmux tree failed: ${res.error?.message}`)
  return res.json
}

function locate(t, id) {
  const needle = (id || '').toLowerCase()
  for (const w of t.windows || []) {
    if (w.id === needle) return { window: w }
    for (const ws of w.workspaces || []) {
      if (ws.id === needle) return { window: w, workspace: ws }
      for (const p of ws.panes || []) {
        // Check the pane's own surfaces (the deeper, more specific node)
        // BEFORE matching the pane itself, so a real-world id coincidence
        // between a pane and one of its surfaces can't mask the surface.
        for (const s of p.surfaces || []) {
          if (s.id === needle) return { window: w, workspace: ws, pane: p, surface: s }
        }
        if (p.id === needle) return { window: w, workspace: ws, pane: p }
      }
    }
  }
  return null
}

export function findSurface(t, id) {
  return locate(t, id)?.surface ?? null
}

export function findWorkspace(t, id) {
  return locate(t, id)?.workspace ?? null
}

function collectIds(t, kind) {
  const ids = new Set()
  for (const w of t.windows || []) {
    if (kind === 'window') ids.add(w.id)
    for (const ws of w.workspaces || []) {
      if (kind === 'workspace') ids.add(ws.id)
      for (const p of ws.panes || []) {
        if (kind === 'pane') ids.add(p.id)
        for (const s of p.surfaces || []) {
          if (kind === 'surface') ids.add(s.id)
        }
      }
    }
  }
  return ids
}

/**
 * recoverNewId(before, after, kind) -> id
 * Diffs two `tree` snapshots for objects of `kind` present after but not
 * before. This is the single recovery path for every verb that creates an
 * object without printing its id as JSON (markdown open has no --json flag
 * at all; the others are not guaranteed to either).
 */
export function recoverNewId(before, after, kind) {
  const beforeIds = collectIds(before, kind)
  const afterIds = collectIds(after, kind)
  const created = [...afterIds].filter((id) => !beforeIds.has(id))
  if (created.length !== 1) {
    throw new Error(`recoverNewId: expected exactly 1 new ${kind}, found ${created.length}`)
  }
  return created[0]
}

function requireTargetPresent(kind, id, label) {
  const t = tree({ all: true })
  const present =
    kind === 'surface' ? !!findSurface(t, id)
    : kind === 'workspace' ? !!findWorkspace(t, id)
    : kind === 'window' ? (t.windows || []).some((w) => w.id === (id || '').toLowerCase())
    : false
  if (!present) {
    // eslint-disable-next-line no-console
    console.error(`${label}: target ${kind} ${id} is gone from the fresh tree — no-op`)
  }
  return present
}

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

function isOnPath(cli) {
  const dirs = (process.env.PATH || '').split(delimiter)
  return dirs.some((d) => {
    try {
      return existsSync(join(d, cli))
    } catch {
      return false
    }
  })
}

function isInside(parentDir, childDir) {
  const rel = relative(resolvePath(parentDir), resolvePath(childDir))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, path)
}

function collectDiagnostics() {
  try {
    const res = cmux('config', ['doctor'])
    return { ok: res.ok, stdout: res.stdout, error: res.error }
  } catch (err) {
    return { ok: false, stdout: '', error: { code: 'diagnostics_failed', message: err.message } }
  }
}

// Every VERBS entry without a VERB_METHODS mapping — recorded in
// preflight.json as unverifiable-by-capabilities, never gated.
const UNVERIFIABLE_VERBS = Object.freeze(VERBS.filter((v) => !(v in VERB_METHODS)).sort())

const STALE_MS = 24 * 60 * 60 * 1000

function warnIfStale(cached) {
  const checkedAtMs = Date.parse(cached?.checked_at)
  if (Number.isFinite(checkedAtMs) && Date.now() - checkedAtMs > STALE_MS) {
    // eslint-disable-next-line no-console
    console.error(`preflight: cached preflight.json is stale (checked_at ${cached.checked_at}, >24h old) — consider re-running with force`)
  }
}

// A worker-reachable file (S5-C): validate its SHAPE before trusting it as
// truth. A malformed cache is treated as absent — never as a throw and
// never as truth — so a corrupted/hostile preflight.json degrades to a
// fresh, verified run rather than being believed.
// Exported for be-1b-E's own direct readers of preflight.json
// (loadPreflightOrRefuse, teardownCmd) — export-only, no behavior change
// here. `preflight()` itself already uses this shape check on every
// non-force read.
export function isValidPreflightCache(obj) {
  return (
    obj !== null && typeof obj === 'object'
    && typeof obj.cmux_version === 'string'
    && typeof obj.access_mode === 'string'
    && Array.isArray(obj.methods)
    && obj.orchestrator !== null && typeof obj.orchestrator === 'object'
    && typeof obj.top_available === 'boolean'
    && typeof obj.events_available === 'boolean'
    && typeof obj.close_workspace_available === 'boolean'
    && Array.isArray(obj.unverifiable_verbs)
    && obj.adapter_present !== null && typeof obj.adapter_present === 'object'
    && typeof obj.checked_at === 'string'
  )
}

/**
 * preflight({ roster, paths, primaryCheckout, taskArtifactsRoot, force }) -> preflightJson
 * Caches to <taskArtifactsRoot>/preflight.json (tmp+rename; separate from
 * the constantly-rewritten status.json owned elsewhere). Runs the gate
 * steps in the exact order the spec requires and HARD STOPS by throwing
 * PreflightError on the first failure — it never falls back to another
 * substrate and never partially proceeds. `paths` is `{ taskDir,
 * worktreeDirs }`, already resolved by the caller — this module does not
 * itself compute task paths.
 */
export function preflight({ roster = [], paths = {}, primaryCheckout, taskArtifactsRoot, force = false } = {}) {
  const cachePath = join(taskArtifactsRoot, 'preflight.json')
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (isValidPreflightCache(cached)) {
        warnIfStale(cached)
        return cached
      }
      // Malformed shape: fall through to a full run rather than trust it.
    } catch {
      // no usable cache — fall through to a full run
    }
  }

  try {
    // 1) binary present; 5) --version recorded (same underlying call).
    const version = checkVersion()
    if (!version.present) {
      throw new PreflightError('binary_missing', PREFLIGHT_MESSAGES.binary_missing)
    }

    // 2) ping -> PONG
    const pingRes = cmux('ping', [])
    if (!pingRes.ok || pingRes.stdout.trim() !== 'PONG') {
      throw new PreflightError('not_running', PREFLIGHT_MESSAGES.not_running)
    }

    // 3) identify --json --id-format uuids -> non-null caller
    const identifyRes = cmux('identify', ['--json', '--id-format', 'uuids'], { json: true })
    if (!identifyRes.ok || !identifyRes.json?.caller) {
      throw new PreflightError('not_in_pane', PREFLIGHT_MESSAGES.not_in_pane)
    }
    const caller = identifyRes.json.caller
    const socketPath = identifyRes.json.socket_path ?? null

    // 4) capabilities --json -> access_mode + methods; every VERB_METHODS
    // entry must be present. Live capabilities.methods are RPC-style dotted
    // names (system.ping, workspace.create, ...), NOT CLI verb names — the
    // gate gets checked against VERB_METHODS[verb], never against `verb`
    // itself. Verbs with no mapping (UNVERIFIABLE_VERBS) are never gated.
    const capsRes = cmux('capabilities', ['--json'], { json: true })
    if (!capsRes.ok) {
      throw new PreflightError('not_running', PREFLIGHT_MESSAGES.not_running)
    }
    const accessMode = capsRes.json?.access_mode ?? null
    const methods = Array.isArray(capsRes.json?.methods) ? capsRes.json.methods : []
    const missingVerb = Object.keys(VERB_METHODS).find((v) => !methods.includes(VERB_METHODS[v]))
    if (missingVerb) {
      throw new PreflightError(
        'verb_missing',
        formatPreflightMessage('verb_missing', { ver: version.version, verb: missingVerb }),
      )
    }

    // 6) per distinct roster agent, assert the agent CLI is on PATH
    const seen = new Set()
    const adapterPresent = {}
    for (const entry of roster) {
      const cli = entry?.cli
      if (!cli || seen.has(cli)) continue
      seen.add(cli)
      if (!isOnPath(cli)) {
        throw new PreflightError(
          'adapter_missing',
          formatPreflightMessage('adapter_missing', { role: entry?.role, cli }),
        )
      }
      adapterPresent[cli] = true
    }

    // 7) containment: task_dir is inside no created worktree and not inside primary_checkout
    if (paths.taskDir) {
      for (const wt of paths.worktreeDirs || []) {
        if (isInside(wt, paths.taskDir)) {
          throw new PreflightError('containment', `task_dir ${paths.taskDir} is inside worktree ${wt}`)
        }
      }
      if (primaryCheckout && isInside(primaryCheckout, paths.taskDir)) {
        throw new PreflightError('containment', `task_dir ${paths.taskDir} is inside primary_checkout ${primaryCheckout}`)
      }
    }

    const topAvailable = methods.includes(VERB_METHODS.top)
    const closeWorkspaceAvailable = methods.includes(VERB_METHODS['close-workspace'])
    // `events` has no confidently-known method name (stream/compat
    // endpoint) — it is unverifiable via capabilities, not gated, and not
    // asserted false; it is recorded in UNVERIFIABLE_VERBS instead. Runtime
    // availability is whatever readEvents() itself observes.
    const eventsAvailable = true
    if (!topAvailable) {
      // be-11-03: the automated quiet/attention timer is driven entirely by
      // agent.hook.Stop events (exact surface_id attribution), never by
      // `top` — top_available:false no longer disables anything automated.
      // eslint-disable-next-line no-console
      console.error('preflight: top is unavailable — top_available:false; only the orchestrator\'s manual triage rung 1 (top) is affected, the automated quiet/attention timer does not depend on it')
    }

    const preflightJson = {
      cmux_version: version.version,
      access_mode: accessMode,
      socket_path: socketPath,
      methods,
      orchestrator: {
        window_id: caller.window_id ?? null,
        workspace_id: caller.workspace_id ?? null,
        pane_id: caller.pane_id ?? null,
        surface_id: caller.surface_id ?? null,
      },
      team_window_id: null,
      top_available: topAvailable,
      events_available: eventsAvailable,
      close_workspace_available: closeWorkspaceAvailable,
      unverifiable_verbs: UNVERIFIABLE_VERBS,
      adapter_present: adapterPresent,
      checked_at: new Date().toISOString(),
    }
    writeJsonAtomic(cachePath, preflightJson)
    return preflightJson
  } catch (err) {
    if (err instanceof PreflightError) {
      err.diagnostics = collectDiagnostics()
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Two-window team seating.
// ---------------------------------------------------------------------------

/**
 * ensureTeamWindow(preflightJson) -> windowId
 * The team window is NEVER the orchestrator's own window. Locates the
 * orchestrator's window by finding identify's caller surface id in the
 * tree; reuses the recorded team_window_id if it still exists; else
 * creates a fresh window and returns its id. If the orchestrator's window
 * cannot be derived, a fresh window is still created unconditionally.
 */
export function ensureTeamWindow(preflightJson) {
  const before = tree({ all: true })
  const orchestratorSurfaceId = preflightJson?.orchestrator?.surface_id ?? null
  const orchestratorLoc = orchestratorSurfaceId ? locate(before, orchestratorSurfaceId) : null
  const orchestratorWindowId = orchestratorLoc?.window?.id ?? null

  // S5-C: a recorded team_window_id is only trustworthy when the
  // orchestrator's own window is independently derivable. Without a known
  // orchestrator.surface_id there is no way to verify "the team window is
  // never the orchestrator's own window" against a (possibly tampered)
  // cached id — so NEVER reuse a recorded id in that state; always mint a
  // fresh window instead.
  const recorded = preflightJson?.team_window_id
  if (orchestratorSurfaceId && recorded && recorded !== orchestratorWindowId) {
    const stillExists = (before.windows || []).some((w) => w.id === recorded)
    if (stillExists) return recorded
  }

  const res = cmux('new-window', [])
  if (!res.ok) throw new Error(`ensureTeamWindow: new-window failed: ${res.error?.message}`)
  const after = tree({ all: true })
  const newWindowId = recoverNewId(before, after, 'window')
  if (orchestratorWindowId && newWindowId === orchestratorWindowId) {
    throw new Error('ensureTeamWindow: invariant violated — new window equals orchestrator window')
  }
  return newWindowId
}

// findWorkspaceByTitle(t, windowId, taskSlug) -> workspace|undefined
// Single definition site for the "does a workspace with this title already
// exist in this window" scan — used by BOTH ensureWorkspace's fast path and
// its --group-failure retry path (see ensureWorkspace's own comment for why
// the retry must re-scan rather than blind-retry).
function findWorkspaceByTitle(t, windowId, taskSlug) {
  const win = (t.windows || []).find((w) => w.id === windowId)
  return win?.workspaces?.find((ws) => ws.title === taskSlug)
}

/**
 * ensureWorkspace({ windowId, taskSlug, cwd, group, envFile }) ->
 * { workspaceId, initialSurfaceId, created }
 * `cmux workspace create` does not exist; new-workspace is the real verb.
 * Reuses an existing workspace of the same name in the team window so no
 * duplicate is created across repeated dispatches. `created` (be-11-05)
 * lets the caller distinguish a fresh stamp from a carry-forward — it is
 * true on every path that actually invokes `new-workspace`, false on the
 * fast reuse path.
 *
 * --group degradation (be-11-02): a `--group <slug>` new-workspace call can
 * fail for reasons unrelated to the workspace object itself (e.g. the group
 * itself is rejected after the workspace was already created) — a naive
 * blind retry in that case would create a SECOND workspace and turn
 * recoverNewId's own "expected exactly 1 new workspace" ambiguity into a
 * hard chain abort. On a --group failure this re-snapshots the tree FRESH
 * (never diffs against the stale pre-attempt `before`) and re-scans by
 * title FIRST — adopting the workspace if the failed attempt actually
 * created it, and only retrying `new-workspace` WITHOUT --group if it did
 * not. A failure with no `group` argument at all still throws as before —
 * no retry, no re-scan.
 *
 * envFile (be-11-05, ADR-018): an absolute path or null/undefined. Passed
 * through VERBATIM as a single `--env-file <path>` argument — NEVER
 * re-composed KEY=VALUE pairs (conventions.md 2026-08-01: argv is ps-visible
 * on the local machine). Supplied ONLY on the new-workspace call(s) that
 * create the task workspace (including the un-grouped retry, which is still
 * a create) — the fast reuse path never touches it, matching the "supplied
 * only at creation" contract.
 */
export function ensureWorkspace({ windowId, taskSlug, cwd, group, envFile } = {}) {
  const before = tree({ all: true })
  const existing = findWorkspaceByTitle(before, windowId, taskSlug)
  if (existing) {
    const initialSurfaceId = existing.panes?.[0]?.surfaces?.[0]?.id ?? null
    return { workspaceId: existing.id, initialSurfaceId, created: false }
  }

  const baseArgs = ['--window', windowId, '--name', taskSlug, '--cwd', cwd]
  const withEnvFile = envFile ? [...baseArgs, '--env-file', envFile] : baseArgs
  const args = group ? [...withEnvFile, '--group', group] : withEnvFile
  const res = cmux('new-workspace', args)
  if (res.ok) {
    const after = tree({ all: true })
    const workspaceId = recoverNewId(before, after, 'workspace')
    const initialSurfaceId = recoverNewId(before, after, 'surface')
    return { workspaceId, initialSurfaceId, created: true }
  }

  if (!group) {
    throw new Error(`ensureWorkspace: new-workspace failed: ${res.error?.message}`)
  }

  // eslint-disable-next-line no-console
  console.error(`ensureWorkspace: new-workspace --group ${group} failed (${res.error?.message}) — re-checking a fresh tree for whether it created the workspace anyway before retrying anything`)
  const freshAfterFailure = tree({ all: true })
  const adopted = findWorkspaceByTitle(freshAfterFailure, windowId, taskSlug)
  if (adopted) {
    // eslint-disable-next-line no-console
    console.error(`ensureWorkspace: the --group attempt had in fact created the workspace — adopting it (workspace ${adopted.id}), un-grouped retry skipped`)
    const initialSurfaceId = adopted.panes?.[0]?.surfaces?.[0]?.id ?? null
    return { workspaceId: adopted.id, initialSurfaceId, created: true }
  }

  // eslint-disable-next-line no-console
  console.error(`ensureWorkspace: --group ${group} was not applied and no workspace was created — degrading: retrying new-workspace without --group`)
  const retryRes = cmux('new-workspace', withEnvFile)
  if (!retryRes.ok) {
    throw new Error(`ensureWorkspace: new-workspace failed even without --group: ${retryRes.error?.message}`)
  }
  const afterRetry = tree({ all: true })
  const workspaceId = recoverNewId(freshAfterFailure, afterRetry, 'workspace')
  const initialSurfaceId = recoverNewId(freshAfterFailure, afterRetry, 'surface')
  return { workspaceId, initialSurfaceId, created: true }
}

export function createPane({ workspaceId } = {}) {
  if (!requireTargetPresent('workspace', workspaceId, 'createPane')) {
    throw new Error(`createPane: workspace ${workspaceId} is gone from the fresh tree`)
  }
  const before = tree({ all: true })
  const res = cmux('new-pane', ['--workspace', workspaceId])
  if (!res.ok) throw new Error(`createPane: new-pane failed: ${res.error?.message}`)
  const after = tree({ all: true })
  const paneId = recoverNewId(before, after, 'pane')
  const surfaceId = recoverNewId(before, after, 'surface')
  return { paneId, surfaceId }
}

// ---------------------------------------------------------------------------
// Pane control. SHELL-INJECTION BOUNDARY: sendLine types `line` into a live
// shell via `cmux send`. Refusal throws; it never escapes-and-continues.
// ---------------------------------------------------------------------------

const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/
// ALLOWLIST, not a denylist: the whole line must be built entirely from
// this charset. Excludes backtick, $, backslash, double-quote, every C0
// control character (including \r — in a PTY, CR IS Enter: a mid-line CR
// submits early and the remainder becomes a second shell command) and the
// broader shell-metacharacter set (; & | > < ( ) { } ~ * ?). A single
// quote is allowed (it appears in ordinary prose/paths) but nothing else
// outside this set is.
const SAFE_LINE_RE = /^[A-Za-z0-9 _.,:;=/@'+-]+$/
const SEND_SETTLE_MS = 30

function assertSafeLine(line) {
  if (typeof line !== 'string' || line.length === 0) {
    throw new Error('sendLine: refused — line must be a non-empty string')
  }
  if (!SAFE_LINE_RE.test(line)) {
    throw new Error('sendLine: refused — line contains a character outside the allowed charset (quotes/backtick/$/backslash/control characters/shell metacharacters)')
  }
  for (const token of line.split(' ')) {
    if (!token) continue
    // Strip a `key=` prefix (every interpolated path in the real kickoff is
    // `task_dir=/…`, `spec_path=/…`, ...) before the path-charset test, and
    // apply it to every token containing '/' — not just ones starting with
    // it, so a stripped value is caught too.
    const eqIdx = token.indexOf('=')
    const value = eqIdx >= 0 ? token.slice(eqIdx + 1) : token
    if (value.includes('/') && !SAFE_PATH_RE.test(value)) {
      throw new Error(`sendLine: refused — interpolated path failed the ^/[A-Za-z0-9._/-]+$ charset check: ${value}`)
    }
  }
}

function settle(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * sendLine(surfaceId, line) -> void
 * `send` does NOT auto-submit even with a trailing newline (spike S7) — a
 * `send-key <surface> enter` after a settle delay is required to submit.
 */
export function sendLine(surfaceId, line) {
  if (!requireTargetPresent('surface', surfaceId, 'sendLine')) return
  assertSafeLine(line)
  const sendRes = cmux('send', [surfaceId, line])
  if (!sendRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`sendLine: send failed: ${sendRes.error?.message}`)
    return
  }
  settle(SEND_SETTLE_MS)
  const enterRes = cmux('send-key', [surfaceId, 'enter'])
  if (!enterRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`sendLine: send-key enter failed: ${enterRes.error?.message}`)
  }
}

export function renameTab(surfaceId, title) {
  if (!requireTargetPresent('surface', surfaceId, 'renameTab')) return
  cmux('rename-tab', [surfaceId, title])
}

export function setStatus(key, value, opts = {}) {
  const args = [key, value]
  if (opts.icon) args.push('--icon', opts.icon)
  if (opts.color) args.push('--color', opts.color)
  if (opts.priority) args.push('--priority', opts.priority)
  if (opts.workspaceId) args.push('--workspace', opts.workspaceId)
  const res = cmux('set-status', args)
  if (!res.ok) {
    // A wedged status pill was previously invisible (the result was
    // discarded outright) — log one loud line naming the key/value so a
    // stuck phase pill (or any other status) surfaces somewhere.
    // eslint-disable-next-line no-console
    console.error(`setStatus: set-status ${key} ${value} failed: ${res.error?.message}`)
  }
}

// be-06-01 S9 — the workspace phase pill.
export const PHASES = Object.freeze(['planning', 'building', 'gate'])

/**
 * setPhase(phase, { workspaceId }) -> void
 * `set-status` targets $CMUX_WORKSPACE_ID by default (live-verified via
 * `cmux set-status --help`), but this always passes --workspace explicitly
 * — the dispatcher has the persisted workspace uuid in workspace.json and
 * must never rely on the env default. Refuses (throws) BEFORE any spawn for
 * an out-of-enum phase or a missing workspaceId. The key literal
 * 'devteam-phase' is frozen.
 */
export function setPhase(phase, { workspaceId } = {}) {
  if (!PHASES.includes(phase)) {
    throw new Error(`setPhase: phase must be one of ${PHASES.join('|')}, got ${JSON.stringify(phase)}`)
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('setPhase: workspaceId is required')
  }
  setStatus('devteam-phase', phase, { workspaceId })
}

// be-11-01 — the workspace-color tier signal and the progress-pill clear.
export const TIERS = Object.freeze([1, 2, 3])
// Named colors live-verified via `cmux workspace-action --help`. Red,
// Crimson and Amber are deliberately reserved for a future failure-state
// color and must never be assigned to a tier.
export const TIER_COLORS = Object.freeze({ 1: 'Teal', 2: 'Blue', 3: 'Purple' })

/**
 * clearProgress({ workspaceId }) -> void
 * Mirrors setPhase's throw-before-spawn half and setStatus's degrade-loudly
 * half: refuses (throws) BEFORE any spawn when workspaceId is missing, and
 * NEVER throws on the underlying `clear-progress` call failing — a failure
 * logs one loud line instead. Always passes --workspace explicitly (never
 * the $CMUX_WORKSPACE_ID default) — dispatch.mjs runs in the orchestrator's
 * own pane, and a defaulted call would decorate the orchestrator's
 * workspace instead of the task's.
 */
export function clearProgress({ workspaceId } = {}) {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('clearProgress: workspaceId is required')
  }
  const res = cmux('clear-progress', ['--workspace', workspaceId])
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`clearProgress: clear-progress --workspace ${workspaceId} failed: ${res.error?.message}`)
  }
}

/**
 * setWorkspaceColor(tier, { workspaceId }) -> void
 * Same throw-before-spawn / degrade-loudly split as clearProgress. Refuses
 * before any spawn for a tier outside TIERS or a missing workspaceId; a
 * failed `workspace-action` call logs one loud line and never throws.
 * Always passes --workspace explicitly.
 */
export function setWorkspaceColor(tier, { workspaceId } = {}) {
  if (!TIERS.includes(tier)) {
    throw new Error(`setWorkspaceColor: tier must be one of ${TIERS.join('|')}, got ${JSON.stringify(tier)}`)
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('setWorkspaceColor: workspaceId is required')
  }
  const res = cmux('workspace-action', ['--action', 'set-color', '--color', TIER_COLORS[tier], '--workspace', workspaceId])
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`setWorkspaceColor: workspace-action set-color tier ${tier} --workspace ${workspaceId} failed: ${res.error?.message}`)
  }
}

/**
 * setProgress(fraction, { workspaceId, label }) -> void
 * Same throw-before-spawn / degrade-loudly split as clearProgress and
 * setWorkspaceColor: refuses (throws) BEFORE any spawn for a fraction
 * outside [0, 1] or a missing workspaceId; a failed `set-progress` call logs
 * one loud line and never throws. `label`, when given, is passed through
 * verbatim as `--label` — callers own keeping it composed only from
 * enum/charset-constrained values, never worker-authored text. Always
 * passes --workspace explicitly (never the $CMUX_WORKSPACE_ID default).
 */
export function setProgress(fraction, { workspaceId, label } = {}) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error(`setProgress: fraction must be a finite number in [0, 1], got ${JSON.stringify(fraction)}`)
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('setProgress: workspaceId is required')
  }
  const args = [String(fraction)]
  if (label) args.push('--label', label)
  args.push('--workspace', workspaceId)
  const res = cmux('set-progress', args)
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`setProgress: set-progress ${fraction} --workspace ${workspaceId} failed: ${res.error?.message}`)
  }
}

/**
 * readScreen(surfaceId, { lines = 40 }) -> string | null
 * NEVER throws. Re-resolves the surface via requireTargetPresent first and
 * no-ops loudly (returns null) when it is gone from a fresh tree, mirroring
 * sendLine/renameTab. A failed `read-screen` call also degrades to null
 * with one loud line rather than throwing. requireTargetPresent's own
 * `tree()` call can itself throw (a failed `cmux tree` invocation) — this is
 * rung 2 of the triage ladder, invoked precisely when the substrate is
 * suspected wedged, i.e. exactly the state most likely to make `tree` fail
 * — so that call is wrapped too, degrading to null with one loud line
 * rather than letting the throw escape.
 */
export function readScreen(surfaceId, { lines = 40 } = {}) {
  let present
  try {
    present = requireTargetPresent('surface', surfaceId, 'readScreen')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`readScreen: requireTargetPresent failed (substrate likely wedged): ${err.message}`)
    return null
  }
  if (!present) return null
  const res = cmux('read-screen', ['--surface', surfaceId, '--lines', String(lines)])
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`readScreen: read-screen --surface ${surfaceId} failed: ${res.error?.message}`)
    return null
  }
  return res.stdout
}

export function closeSurface(id) {
  if (!requireTargetPresent('surface', id, 'closeSurface')) return
  cmux('close-surface', [id])
}

export function closeWorkspace(id) {
  if (!requireTargetPresent('workspace', id, 'closeWorkspace')) return
  cmux('close-workspace', [id])
}

// ---------------------------------------------------------------------------
// Browser preview family (be-12-01, issue #12/D1 + D2, ADR-019).
//
// `browser` is ONE `VERBS` entry; its five sub-verbs ride as argv tokens
// (`cmux browser <sub> ...`, the `markdown open` shape already precedented
// above) and are guarded one level down by a MODULE-PRIVATE frozen
// allowlist. browserVerb() throws BEFORE any spawn on anything outside it —
// the same shape runVerb() applies to VERBS itself — so `eval`, `state`,
// `console`, `snapshot`, `viewport` and every interaction verb are
// structurally unreachable from this module, regardless of what a caller
// asks for.
// ---------------------------------------------------------------------------
const BROWSER_SUBVERBS = Object.freeze(['open', 'goto', 'wait', 'errors', 'screenshot'])

// The only accepted --load-state value on cmux 0.64.22 — the shorter,
// unsuffixed alternative is INVALID, live-verified (see
// architecture-package-v2.md §2.1). Frozen single definition site: no
// caller ever supplies its own load-state value, and that shorter,
// four-letter alternative must never appear as a string literal anywhere
// else in this directory.
export const BROWSER_LOAD_STATE = 'complete'

// The two real spawn bounds `browserOpen` enforces internally — exported so
// dispatch.mjs's PREVIEW_LOCK_WORST_CASE_MS invariant reads THESE, never a
// re-typed literal (be-12-02 fix-round item 3): a change to either bound here
// must move the invariant, never silently desync from it.
export const BROWSER_OPEN_SPAWN_TIMEOUT_MS = 5000
export const BROWSER_OPEN_AFTER_TREE_TIMEOUT_MS = 3000

// Exported ONLY so the frozen-allowlist guard itself is directly testable —
// every wrapper below calls this with its OWN hardcoded sub literal
// (never a caller-supplied one), so `eval`/`state`/`console`/`snapshot`/
// `viewport`/every interaction verb is structurally unreachable through the
// public wrapper surface regardless of this export; BROWSER_SUBVERBS stays
// the module-private frozen constant.
export function browserVerb(sub, args, opts) {
  if (!BROWSER_SUBVERBS.includes(sub)) {
    throw new Error(`browserVerb: refusing to invoke a browser sub-verb outside the frozen BROWSER_SUBVERBS allowlist: ${sub}`)
  }
  return cmux('browser', [sub, ...args], opts)
}

// Deliberate divergence from this module's house `err.message` logging
// pattern (setStatus, clearProgress, setWorkspaceColor, setProgress,
// readScreen, sendLine, renameTab, mountDocTab, ...): every browser sub-verb
// failure's DETAIL is page-influenced (it is the content of whatever the
// previewed app rendered/threw), and dispatch.mjs's stderr is an
// orchestrator-context ingress — a hostile page could smuggle a
// prompt-injection payload into an orchestrator's transcript via
// `error.message` alone. Only the cmux-authored error CODE is logged, and
// only after it is shape-checked against a closed pattern, so the
// closed-vocabulary claim is structural rather than trusted: an out-of-shape
// code (never observed live, but not provably impossible) logs the literal
// `<unparsed>` instead of riding through unchecked.
const BROWSER_ERROR_CODE_RE = /^[a-z_]{1,32}$/

function logBrowserError(subLabel, surfaceId, code) {
  const safeCode = typeof code === 'string' && BROWSER_ERROR_CODE_RE.test(code) ? code : '<unparsed>'
  // eslint-disable-next-line no-console
  console.error(`browser ${subLabel}: ${surfaceId}: ${safeCode}`)
}

/**
 * browserOpen(url, { workspaceId, treeBefore }) ->
 * { surfaceId, paneId, placement, treeAfter } | null
 * Spawn bound 5 000 ms (measured live 0.06 s; 80x headroom). Throws BEFORE
 * any spawn on a missing workspaceId/treeBefore. `--focus false` always —
 * no browser wrapper ever issues a focus verb. The printed line
 * (`OK surface=surface:N pane=pane:N placement=split|reuse`) carries
 * POSITIONAL refs, which this repo never persists and which renumber
 * mid-session — only `placement=(\w+)` is parsed from stdout, and only to be
 * logged; `surface=`/`pane=` tokens are never read, not even as a
 * cross-check. The real id comes from a tree diff instead: this wrapper
 * takes the caller's own `treeBefore` (its scan tree, already bounded) and
 * performs exactly ONE bounded tree read of its own (3 000 ms) as
 * `treeAfter`, then recovers the surface via `recoverNewId` and locates its
 * pane in `treeAfter`. `treeAfter` is returned to the caller for the
 * post-create idempotence and pane checks — two `tree` spawns per create,
 * total, across caller + this wrapper (errata E1). An id-recovery ambiguity
 * (`recoverNewId`, e.g. under `_simulateConcurrentCreate`) is surfaced by
 * throwing rather than guessed at — this is NOT the "never throw on a cmux
 * failure" degrade path; it is the same id-recovery-ambiguity class that
 * aborts mountDocTab's rung chain.
 */
export function browserOpen(url, { workspaceId, treeBefore } = {}) {
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new Error('browserOpen: workspaceId is required')
  }
  if (treeBefore === null || typeof treeBefore !== 'object') {
    throw new Error('browserOpen: treeBefore is required')
  }
  const res = browserVerb('open', [url, '--workspace', workspaceId, '--focus', 'false'], { timeoutMs: BROWSER_OPEN_SPAWN_TIMEOUT_MS })
  if (!res.ok) {
    logBrowserError('open', workspaceId, res.error?.code)
    return null
  }
  const match = res.stdout.match(/placement=(\w+)/)
  const placement = match ? match[1] : null
  const treeAfter = tree({ all: true, timeoutMs: BROWSER_OPEN_AFTER_TREE_TIMEOUT_MS })
  const surfaceId = recoverNewId(treeBefore, treeAfter, 'surface')
  const paneId = locate(treeAfter, surfaceId)?.pane?.id ?? null
  return { surfaceId, paneId, placement, treeAfter }
}

/**
 * browserGoto(surfaceId, url) -> boolean
 * Spawn bound 20 000 ms — cmux self-bounds a dead-port navigation at ~15.5 s
 * (`navigation_timeout`), so this exceeds that bound and stays
 * distinguishable from our own spawn kill (`spawn_error`). Throws before any
 * spawn on a missing surfaceId; degrades loudly (code-only stderr line,
 * `false`) on a cmux failure — never throws on one.
 */
export function browserGoto(surfaceId, url) {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new Error('browserGoto: surfaceId is required')
  }
  const res = browserVerb('goto', [surfaceId, url], { timeoutMs: 20000 })
  if (!res.ok) {
    logBrowserError('goto', surfaceId, res.error?.code)
    return false
  }
  return true
}

/**
 * browserWaitReady(surfaceId, { timeoutMs = 25000 }) -> boolean
 * cmux-side `--load-state complete --timeout-ms 20000` (BROWSER_LOAD_STATE —
 * the shorter, unsuffixed value is invalid on 0.64.22 and never supplied by
 * any caller); the
 * wrapper's OWN spawn bound defaults to 25 000 ms, exceeding cmux's own
 * 20 000 ms bound, so a spawn kill stays distinguishable from cmux's own
 * timeout. `timeoutMs` is overridable only for bounded testing of the spawn
 * bound itself (the `topTsv` shape) — no production caller supplies one.
 * Throws before any spawn on a missing surfaceId; degrades loudly on a cmux
 * failure, never throws on one.
 */
export function browserWaitReady(surfaceId, { timeoutMs = 25000 } = {}) {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new Error('browserWaitReady: surfaceId is required')
  }
  const res = browserVerb('wait', [surfaceId, '--load-state', BROWSER_LOAD_STATE, '--timeout-ms', '20000'], { timeoutMs })
  if (!res.ok) {
    logBrowserError('wait', surfaceId, res.error?.code)
    return false
  }
  return true
}

/**
 * browserErrorsClear(surfaceId) -> boolean
 * Spawn bound 10 000 ms. Throws before any spawn on a missing surfaceId;
 * degrades loudly on a cmux failure, never throws on one.
 */
export function browserErrorsClear(surfaceId) {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new Error('browserErrorsClear: surfaceId is required')
  }
  const res = browserVerb('errors', ['clear', surfaceId], { timeoutMs: 10000 })
  if (!res.ok) {
    logBrowserError('errors_clear', surfaceId, res.error?.code)
    return false
  }
  return true
}

/**
 * browserErrorsList(surfaceId) -> string | null
 * Spawn bound 10 000 ms. Returns RAW page bytes — the sole wrapper in this
 * family that does — with `reduceBrowserErrors` (be-12-03) as its single
 * legal consumer; this module never inspects the payload itself. Throws
 * before any spawn on a missing surfaceId; degrades loudly on a cmux
 * failure, never throws on one.
 */
export function browserErrorsList(surfaceId) {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new Error('browserErrorsList: surfaceId is required')
  }
  const res = browserVerb('errors', ['list', surfaceId], { timeoutMs: 10000 })
  if (!res.ok) {
    logBrowserError('errors_list', surfaceId, res.error?.code)
    return null
  }
  return res.stdout
}

/**
 * browserScreenshot(surfaceId, outPath) -> boolean
 * Spawn bound 20 000 ms. Returns only whether the cmux call itself
 * succeeded — cmux's own `OK <path>` line is NEVER trusted as proof of a
 * write (0.64.22 prints `OK` and a full-size blank PNG even on a surface
 * that never became ready); the caller confirms via an independent
 * `existsSync` (be-12-03). Throws before any spawn on a missing
 * surfaceId/outPath; degrades loudly on a cmux failure, never throws on one.
 */
export function browserScreenshot(surfaceId, outPath) {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new Error('browserScreenshot: surfaceId is required')
  }
  if (typeof outPath !== 'string' || outPath === '') {
    throw new Error('browserScreenshot: outPath is required')
  }
  const res = browserVerb('screenshot', [surfaceId, '--out', outPath], { timeoutMs: 20000 })
  if (!res.ok) {
    logBrowserError('screenshot', surfaceId, res.error?.code)
    return false
  }
  return true
}

/**
 * findDocTabSurface(t, { paneId, terminalSurfaceId }) -> { id: string|null, ambiguous: boolean }
 * Candidates are the given pane's surfaces other than terminalSurfaceId; if
 * any candidate carries type === 'markdown', the candidate set narrows to
 * those. `id` is set iff exactly one candidate remains. `ambiguous` is true
 * iff MORE THAN ONE candidate remains after narrowing (never true when
 * `id` is set, never true when zero candidates remain — "no doc tab" and
 * "can't tell which" are DISTINCT outcomes; treating both as "not mounted"
 * is exactly the fail-open hole that let an ambiguous pane accumulate
 * panels forever). NEVER throws.
 */
export function findDocTabSurface(t, { paneId, terminalSurfaceId } = {}) {
  try {
    const pane = locate(t, paneId)?.pane
    if (!pane) return { id: null, ambiguous: false }
    let candidates = (pane.surfaces || []).filter((s) => s.id !== terminalSurfaceId)
    if (candidates.length === 0) return { id: null, ambiguous: false }
    const markdownCandidates = candidates.filter((s) => s.type === 'markdown')
    if (markdownCandidates.length > 0) candidates = markdownCandidates
    if (candidates.length === 1) return { id: candidates[0].id, ambiguous: false }
    return { id: null, ambiguous: true }
  } catch {
    return { id: null, ambiguous: false }
  }
}

/**
 * reorderDocTabFirst({ paneId, terminalSurfaceId }) -> boolean
 * Fetches a FRESH tree, resolves the doc tab via findDocTabSurface, and on a
 * hit issues `reorder-surface <docId> --before <terminalSurfaceId>` and
 * nothing else. An AMBIGUOUS pane (>=2 markdown candidates) is refused
 * loudly — there is no way to know which surface to reorder, so this never
 * guesses. NEVER throws, NEVER focuses.
 */
export function reorderDocTabFirst({ paneId, terminalSurfaceId } = {}) {
  try {
    const t = tree({ all: true })
    const found = findDocTabSurface(t, { paneId, terminalSurfaceId })
    if (found.ambiguous) {
      // eslint-disable-next-line no-console
      console.error(`reorderDocTabFirst: pane ${paneId} has more than one doc-tab candidate — ambiguous, refusing to guess`)
      return false
    }
    if (!found.id) return false
    const res = cmux('reorder-surface', [found.id, '--before', terminalSurfaceId])
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`reorderDocTabFirst: reorder-surface failed: ${res.error?.message}`)
      return false
    }
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`reorderDocTabFirst: unexpected failure: ${err.message}`)
    return false
  }
}

// RungAbortError — an id-recovery ambiguity (concurrent creation: "expected
// exactly 1 new surface") is NOT a rung capability failure; it is thrown to
// ABORT THE WHOLE CHAIN rather than advance to the next rung, since
// advancing would create yet another surface on top of an already-ambiguous
// set, amplifying orphan creation under wave dispatch. mountDocTab's own
// try/catch turns this into a single null return — it never re-throws past
// this module's public surface (NEVER throws stays true for every export).
class RungAbortError extends Error {}

// abandonOrphan(surfaceId, paneId, rungLabel, reason) — a surface was
// created by a rung but could not be placed (move-surface or reorder-surface
// failed, or rung 2's post-mount placement verification failed). Best-effort
// closeSurface in a try/catch (never throws either way — closeSurface's own
// never-throw behavior is untouched), then ONE loud line naming the
// orphaned id, the rung, the reason, and the pane it was in. The line says
// "close attempted", never "closed" — closeSurface itself no-ops silently
// when the target is already gone (requireTargetPresent), so this function
// cannot truthfully claim the surface WAS closed, only that closing it was
// attempted.
function abandonOrphan(surfaceId, paneId, rungLabel, reason) {
  try {
    closeSurface(surfaceId)
  } catch {
    // best-effort only — never throw out of orphan handling
  }
  // eslint-disable-next-line no-console
  console.error(`mountDocTab: ${rungLabel} created ${surfaceId} but could not place it (${reason}) — close attempted, pane ${paneId}`)
}

// attemptOpenRung: shared shape for rungs 1 and 2 of mountDocTab — run the
// creation call, tree-diff to recover the new surface id, move it into
// paneId if it landed elsewhere (--focus false, never focusing), then
// reorder it ahead of terminalSurfaceId. Returns surfaceId on full success,
// null on an ORDINARY rung failure (the caller falls through to the next
// rung, after this function has already abandoned any surface it created).
// Throws RungAbortError on an id-recovery ambiguity — see that class's own
// comment for why that case must not simply return null.
function attemptOpenRung(before, openFn, { paneId, terminalSurfaceId, rungLabel }) {
  const openRes = openFn()
  if (!openRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`mountDocTab: ${rungLabel} failed: ${openRes.error?.message}`)
    return null
  }
  const after = tree({ all: true })
  let surfaceId
  try {
    surfaceId = recoverNewId(before, after, 'surface')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`mountDocTab: ${rungLabel} id-recovery ambiguity — ABORTING the whole fallback chain (not advancing to the next rung): ${err.message}`)
    throw new RungAbortError(err.message)
  }
  const loc = locate(after, surfaceId)
  const landedPaneId = loc?.pane?.id ?? null
  if (landedPaneId !== paneId) {
    const moveRes = cmux('move-surface', [surfaceId, '--pane', paneId, '--focus', 'false'])
    if (!moveRes.ok) {
      abandonOrphan(surfaceId, landedPaneId ?? paneId, rungLabel, `move-surface failed: ${moveRes.error?.message}`)
      return null
    }
  }
  const reorderRes = cmux('reorder-surface', [surfaceId, '--before', terminalSurfaceId])
  if (!reorderRes.ok) {
    abandonOrphan(surfaceId, paneId, rungLabel, `reorder-surface failed: ${reorderRes.error?.message}`)
    return null
  }
  return surfaceId
}

/**
 * mountDocTab({ renderPath, paneId, terminalSurfaceId }) -> surfaceId | null
 * NEVER throws, NEVER focuses. Three-rung fallback chain, each rung
 * attempted only if the previous failed:
 *   r1 `markdown open <renderPath> --surface <terminalSurfaceId>`
 *   r2 `new-surface --type browser --url <pathToFileURL(renderPath).href> --pane <paneId> --focus false`,
 *      then a post-mount tree re-read verifies the surface actually landed
 *      in <paneId> before trusting success (file:// acceptance is
 *      live-unverified) — a verification failure falls through to rung 3.
 *   r3 `markdown open <renderPath>` (no --surface, left in its own pane)
 * An id-recovery ambiguity inside ANY rung (RungAbortError) aborts the
 * whole chain immediately rather than advancing — see that class's comment.
 * Failure of all three returns null and logs one loud line — a doc-tab
 * failure must not fail a dispatch.
 */
export function mountDocTab({ renderPath, paneId, terminalSurfaceId } = {}) {
  try {
    const before = tree({ all: true })
    if (!findSurface(before, terminalSurfaceId)) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: terminal surface ${terminalSurfaceId} is gone from the fresh tree — no-op`)
      return null
    }

    let rung1
    try {
      rung1 = attemptOpenRung(
        before,
        () => cmux('markdown', ['open', renderPath, '--surface', terminalSurfaceId]),
        { paneId, terminalSurfaceId, rungLabel: 'rung 1 (markdown open --surface)' },
      )
    } catch (err) {
      if (err instanceof RungAbortError) return null
      throw err
    }
    if (rung1) return rung1

    // Rung 2 (browser file://) is the one live-unverified rung — logged
    // loudly on every use so a live acceptance run surfaces it regardless
    // of eventual success.
    // eslint-disable-next-line no-console
    console.error('mountDocTab: attempting rung 2 (new-surface browser file://) — file:// acceptance is live-unverified')
    const beforeR2 = tree({ all: true })
    const fileUrl = pathToFileURL(renderPath).href
    let rung2
    try {
      rung2 = attemptOpenRung(
        beforeR2,
        () => cmux('new-surface', ['--type', 'browser', '--url', fileUrl, '--pane', paneId, '--focus', 'false']),
        { paneId, terminalSurfaceId, rungLabel: 'rung 2 (new-surface browser)' },
      )
    } catch (err) {
      if (err instanceof RungAbortError) return null
      throw err
    }
    if (rung2) {
      // Post-mount placement verification (fix for rung 2's live-unverified
      // file:// acceptance): re-read the tree and require the surface to
      // actually be present in the target pane before trusting success. A
      // verification failure is an ORDINARY rung failure (falls through to
      // rung 3), not an abort — only an id-recovery ambiguity aborts.
      const verifyTree = tree({ all: true })
      const stillPresent = (locate(verifyTree, paneId)?.pane?.surfaces || []).some((s) => s.id === rung2)
      if (stillPresent) return rung2
      abandonOrphan(rung2, paneId, 'rung 2 (new-surface browser)', 'post-mount placement verification failed')
    }

    const beforeR3 = tree({ all: true })
    const openRes = cmux('markdown', ['open', renderPath])
    if (!openRes.ok) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: rung 3 (markdown open, no --surface) failed — all three rungs exhausted: ${openRes.error?.message}`)
      return null
    }
    let surfaceId
    try {
      const afterR3 = tree({ all: true })
      surfaceId = recoverNewId(beforeR3, afterR3, 'surface')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: rung 3 (markdown open, no --surface) succeeded but id recovery failed: ${err.message}`)
      return null
    }
    // eslint-disable-next-line no-console
    console.error('mountDocTab: rung 3 (markdown open, no --surface) succeeded — doc tab left in its own pane, not moved or reordered')
    return surfaceId
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`mountDocTab: unexpected failure: ${err.message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Degraded-capability readers.
// ---------------------------------------------------------------------------

/**
 * topTsv({ timeoutMs = 2000 }) -> Array<{cpu_pct, mem_bytes, proc_count,
 * kind, id, parent_id, title_or_status}> | null
 * Diagnostics only — never an input to any classification. Live `cmux top
 * --format tsv` (cmux 0.64.22, live-verified 2026-08-05) is HEADERLESS: 7
 * positional tab-separated columns, no header row to consume. `kind` is a
 * hierarchical rollup (total, window, workspace, tag, pane, surface), not a
 * flat surface list. `top` has NO --id-format flag — every id/parent_id is
 * a positional ref (e.g. surface:1), never a UUID, which is why
 * normalizeIds is deliberately NOT applied here and why this output must
 * never be joined to a UUID-keyed record. After be-11-03 this function has
 * no automated caller; it exists for the orchestrator's manual triage
 * rung 1.
 */
export function topTsv({ timeoutMs = 2000 } = {}) {
  const res = cmux('top', ['--format', 'tsv'], { timeoutMs })
  if (!res.ok) return null
  const lines = res.stdout.split('\n').filter((l) => l.length > 0)
  return lines.map((line) => {
    const [cpu_pct, mem_bytes, proc_count, kind, id, parent_id, title_or_status] = line.split('\t')
    return { cpu_pct, mem_bytes, proc_count, kind, id, parent_id, title_or_status }
  })
}

// Live-verified cmux 0.64.22, captured 2026-08-05 via a real Claude Code
// turn ending inside a cmux pane and reading the resulting line from
// `cmux events --after <seq> --limit N --no-ack --no-heartbeat`. This is
// the turn-end event — NOT `notification.requested`, which the TRD and
// ADR-003 baseline assumed and which is actually a narrower event reserved
// for explicit `cmux notify` calls. See docs/trd-cmux-execution-mode.md's
// '## Superseded since ratification' table and architecture-notes.md's
// ADR-003 Amended-by pointer for the errata this corrects.
export const TURN_END_EVENT_NAME = 'agent.hook.Stop'

/**
 * parseTurnEndEvent(rawEvent) -> { surfaceId, occurredAt, seq } | null
 * Arms ONLY on rawEvent.name === TURN_END_EVENT_NAME — filtering on any
 * wider "event carrying a surface_id" shape would silently accept unrelated
 * events. Reads event.surface_id ?? event.payload?.surface_id (both are
 * populated live, but only the top-level key is guaranteed) and
 * event.occurred_at, nothing wider. Returns null — never a defaulted value
 * — when surfaceId or occurredAt is missing or unparseable. readEvents()
 * already runs every parsed line through normalizeIds, so ids arriving via
 * that path are already lowercased — but this function runs surfaceId
 * through normalizeId() itself regardless of caller, so its output is
 * idempotently lowercase even when fed a raw, un-normalized event directly
 * (be-11-03 joins this against lowercase-persisted dispatch record UUIDs;
 * an uppercase mismatch there would silently break attribution). The
 * payload.surface_id fallback is intentional (be-11-01's interface
 * contract) but is a silent degradation from the authoritative top-level
 * field to a less-trusted one when it's the ONLY source — one loud log
 * line names it when actually taken (QA fix #10), never on the common
 * top-level-present path. QA fix #9: occurredAt is re-serialized through
 * `new Date(...).toISOString()` (the same normalize-at-ingestion treatment
 * already given to surfaceId via normalizeId) rather than passed through
 * verbatim — Date.parse is lenient about garbage-adjacent text, and a
 * malformed-but-parseable value must never ride verbatim into `await`/
 * `status` JSON or status.json on disk.
 */
export function parseTurnEndEvent(rawEvent) {
  if (!rawEvent || rawEvent.name !== TURN_END_EVENT_NAME) return null
  const topLevelSurfaceId = rawEvent.surface_id
  const surfaceId = topLevelSurfaceId ?? rawEvent.payload?.surface_id
  const occurredAt = rawEvent.occurred_at
  if (typeof surfaceId !== 'string' || surfaceId === '') return null
  if (typeof occurredAt !== 'string' || occurredAt === '' || Number.isNaN(Date.parse(occurredAt))) return null
  if (topLevelSurfaceId == null) {
    // eslint-disable-next-line no-console
    console.error(`parseTurnEndEvent: top-level surface_id absent — falling back to the less-trusted payload.surface_id for event seq ${rawEvent.seq}`)
  }
  return { surfaceId: normalizeId(surfaceId), occurredAt: new Date(occurredAt).toISOString(), seq: rawEvent.seq }
}

/**
 * readEvents({ afterSeq, limit, timeoutMs, name }) -> { events, seq } | { unavailable: true }
 *
 * QA-fix (be-11-03 gate): `cmux events` is a STREAMING primitive, NOT a
 * bounded-snapshot primitive — there is no CLI flag that means "give me
 * what's retained now, don't wait for more." Live-verified against a real
 * cmux 0.64.22 daemon (2026-08-05):
 *   - `cmux events --after 0 --limit 1000/2000/4000 --no-ack --no-heartbeat`
 *     (unfiltered) returned in well under a second, satisfied entirely from
 *     retained backlog (~4096-event retention window observed).
 *   - `cmux events --after 0 --limit 5000 ...` (unfiltered, exceeding that
 *     retention window) BLOCKED for 2+ minutes waiting for enough LIVE
 *     events to accumulate — it does not return early with a partial
 *     snapshot.
 *   - `cmux events --after 0 --name agent.hook.Stop --limit 40 ...`
 *     BLOCKED after ~28 lines: `--limit` counts POST-FILTER matches, and
 *     agent.hook.Stop (once per worker turn) is far rarer than the general
 *     event stream, so a --name-filtered --limit is blocked-by-default in
 *     practice, not an edge case.
 *   - `cmux events --after <cursor> ...` with NOTHING new since <cursor>
 *     also blocks (there is no seq-scoped equivalent of "return empty
 *     immediately") — confirmed via a direct `--after <current-head>` read.
 *   - `cmux events --after <cursor> --no-ack --no-heartbeat` with NEITHER
 *     --limit nor --reconnect still never exits on its own once retained
 *     backlog is exhausted — it keeps streaming live frames forever.
 * The ONLY reliable bound is therefore the CALLER'S OWN spawnSync timeout,
 * not `--limit`. Live-verified (Node 24, macOS) that when spawnSync's own
 * `timeout` option kills the child, `result.error.code` is set to
 * `'ETIMEDOUT'` specifically (a controlled --name-filtered read under a
 * 1500ms timeout: signal 'SIGTERM', error.code 'ETIMEDOUT', 20 complete
 * lines still recovered from stdout) and `result.stdout` STILL carries
 * every complete line the child wrote before the kill. A timeout-triggered
 * kill is therefore an EXPECTED, NORMAL termination path for this call,
 * not a failure — this function bypasses the generic cmux() wrapper (which
 * discards stdout on any spawn error) and parses result.stdout directly,
 * keyed SPECIFICALLY on `result.error?.code === 'ETIMEDOUT'` (QA-fix round
 * 2: the broader `result.signal != null` also conflated a genuine crash or
 * an external kill — OOM SIGKILL, some other process's SIGTERM — with our
 * own bound) to distinguish "our own timeout fired" (valid, possibly
 * empty, partial read) from a genuine spawn failure (binary missing, a bad
 * exit unrelated to our own timeout, a crash) — only the latter is
 * `unavailable`.
 * `--limit` is still passed as a soft cap (self-limiting memory/output, and
 * lets a well-satisfied read exit early rather than waiting the full
 * timeout) but is no longer load-bearing for correctness. `name`, when
 * given, is passed as `--name <name>` — the fixture ignores it entirely
 * (matching a genuinely unfiltered read for the "backlog satisfies the
 * limit fast" case), which is exactly why every caller filtering on
 * TURN_END_EVENT_NAME also re-filters client-side (parseTurnEndEvent
 * already does, by construction) rather than trusting the server-side flag
 * alone.
 */
export function readEvents({ afterSeq, limit, timeoutMs, name } = {}) {
  const args = []
  if (afterSeq != null) args.push('--after', String(afterSeq))
  if (limit != null) args.push('--limit', String(limit))
  if (name != null) args.push('--name', name)
  args.push('--no-ack', '--no-heartbeat')
  const result = runVerb('events', args, { timeoutMs })
  const stdout = result.stdout ?? ''
  const events = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(normalizeIds(JSON.parse(trimmed)))
    } catch {
      // A partial trailing line from a timeout-triggered kill mid-write,
      // or any other malformed line — skipped rather than failing the
      // whole read.
    }
  }
  // QA-fix round 2 (#2): result.signal != null was too broad — it also
  // conflates a genuine crash or an EXTERNAL kill (OOM SIGKILL, some other
  // process's SIGTERM) with "our own timeout fired," silently turning a
  // real failure into a fake "valid empty read". Node sets
  // result.error.code === 'ETIMEDOUT' SPECIFICALLY when spawnSync's own
  // `timeout` option is what triggered the kill (live-verified against
  // real cmux 0.64.22: a controlled --name-filtered read under a 1500ms
  // timeout came back with signal 'SIGTERM' AND error.code 'ETIMEDOUT',
  // with 20 complete partial lines still recovered from stdout) — that
  // specific code is the only thing this treats as a normal, bounded
  // termination, never "unavailable" on its own, even when it produced
  // zero events (a genuinely idle window with nothing new looks identical
  // to a timeout-with-partial-data, and both are valid empty/partial
  // reads). Anything else non-zero/erroring WITHOUT that specific code
  // (cmux not running, an unsupported flag, a crash, an external kill,
  // ...) is a genuine failure.
  const killedByOwnTimeout = result.error?.code === 'ETIMEDOUT'
  if (!killedByOwnTimeout && (result.error || result.status !== 0)) {
    return { unavailable: true }
  }
  const seq = events.length ? events[events.length - 1].seq : (afterSeq ?? 0)
  return { events, seq }
}
