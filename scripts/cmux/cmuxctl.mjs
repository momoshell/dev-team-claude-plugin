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

// The binary is ALWAYS this constant — never a literal 'cmux' elsewhere in
// this module or in any test. Tests set CMUX_BIN to the fixture so no test
// in this repo ever touches a live cmux.
export const CMUX_BIN = process.env.CMUX_BIN || 'cmux'

// Every cmux verb this module may invoke. There is no dynamic verb
// construction anywhere: cmux() asserts membership before spawning.
export const VERBS = Object.freeze([
  'ping', 'identify', 'capabilities', 'tree', 'new-window', 'new-workspace', 'new-pane',
  'markdown', 'move-surface', 'reorder-surface', 'send', 'send-key', 'rename-tab',
  'set-status', 'close-surface', 'close-workspace', 'top', 'events', 'config',
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

export function tree({ all = false } = {}) {
  const args = ['--json', '--id-format', 'uuids']
  if (all) args.push('--all')
  const res = cmux('tree', args, { json: true })
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
      // eslint-disable-next-line no-console
      console.error('preflight: top is unavailable — top_available:false, the quiet timer is disabled downstream')
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

/**
 * ensureWorkspace({ windowId, taskSlug, cwd, group }) -> { workspaceId, initialSurfaceId }
 * `cmux workspace create` does not exist; new-workspace is the real verb.
 * Reuses an existing workspace of the same name in the team window so no
 * duplicate is created across repeated dispatches.
 */
export function ensureWorkspace({ windowId, taskSlug, cwd, group } = {}) {
  const before = tree({ all: true })
  const win = (before.windows || []).find((w) => w.id === windowId)
  const existing = win?.workspaces?.find((ws) => ws.title === taskSlug)
  if (existing) {
    const initialSurfaceId = existing.panes?.[0]?.surfaces?.[0]?.id ?? null
    return { workspaceId: existing.id, initialSurfaceId }
  }

  const args = ['--window', windowId, '--name', taskSlug, '--cwd', cwd]
  if (group) args.push('--group', group)
  const res = cmux('new-workspace', args)
  if (!res.ok) throw new Error(`ensureWorkspace: new-workspace failed: ${res.error?.message}`)
  const after = tree({ all: true })
  const workspaceId = recoverNewId(before, after, 'workspace')
  const initialSurfaceId = recoverNewId(before, after, 'surface')
  return { workspaceId, initialSurfaceId }
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
  cmux('set-status', args)
}

export function closeSurface(id) {
  if (!requireTargetPresent('surface', id, 'closeSurface')) return
  cmux('close-surface', [id])
}

export function closeWorkspace(id) {
  if (!requireTargetPresent('workspace', id, 'closeWorkspace')) return
  cmux('close-workspace', [id])
}

/**
 * mountDocTab({ renderPath, paneId, terminalSurfaceId }) -> surfaceId | null
 * NEVER throws, NEVER focuses. On any failure returns null and logs one
 * loud line — a doc-tab failure must not fail a dispatch.
 */
export function mountDocTab({ renderPath, paneId, terminalSurfaceId } = {}) {
  try {
    const before = tree({ all: true })
    if (!findSurface(before, terminalSurfaceId)) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: terminal surface ${terminalSurfaceId} is gone from the fresh tree — no-op`)
      return null
    }
    const openRes = cmux('markdown', ['open', renderPath, '--surface', terminalSurfaceId])
    if (!openRes.ok) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: markdown open failed: ${openRes.error?.message}`)
      return null
    }
    const after = tree({ all: true })
    const surfaceId = recoverNewId(before, after, 'surface')
    const loc = locate(after, surfaceId)
    if (loc?.pane?.id !== paneId) {
      const moveRes = cmux('move-surface', [surfaceId, '--pane', paneId])
      if (!moveRes.ok) {
        // eslint-disable-next-line no-console
        console.error(`mountDocTab: move-surface failed: ${moveRes.error?.message}`)
        return null
      }
    }
    const reorderRes = cmux('reorder-surface', [surfaceId, '--before', terminalSurfaceId])
    if (!reorderRes.ok) {
      // eslint-disable-next-line no-console
      console.error(`mountDocTab: reorder-surface failed: ${reorderRes.error?.message}`)
      return null
    }
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

export function topTsv() {
  const res = cmux('top', ['--format', 'tsv'])
  if (!res.ok) return null
  const lines = res.stdout.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const headers = lines[0].split('\t')
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('\t')
    const row = {}
    headers.forEach((h, i) => {
      row[h] = cells[i]
    })
    return row
  })
  // Ingestion happens here too — normalizeIds is applied in this module and
  // nowhere else, and topTsv is a parse path `cmux()` doesn't cover itself.
  return normalizeIds(rows)
}

/**
 * readEvents({ afterSeq, limit, timeoutMs }) -> { events, seq } | { unavailable: true }
 * A single bounded call — the reconnect/await loop itself belongs to
 * be-1b-E, not this module.
 */
export function readEvents({ afterSeq, limit, timeoutMs } = {}) {
  const args = []
  if (afterSeq != null) args.push('--after', String(afterSeq))
  if (limit != null) args.push('--limit', String(limit))
  // Live-verified working combination (`cmux events --after 0 --limit 3
  // --no-ack --no-heartbeat` exits 0): this is a single bounded call, not a
  // subscription, so neither ack-tracking nor the heartbeat channel apply.
  args.push('--no-ack', '--no-heartbeat')
  const res = cmux('events', args, { timeoutMs })
  if (!res.ok) return { unavailable: true }
  const events = []
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(normalizeIds(JSON.parse(trimmed)))
    } catch {
      // skip a malformed line rather than fail the whole read
    }
  }
  const seq = events.length ? events[events.length - 1].seq : (afterSeq ?? 0)
  return { events, seq }
}
