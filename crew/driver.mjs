// crew/driver.mjs — the crew's own minimal cmux driver. Self-contained by
// design: node builtins only, zero imports from the legacy dev-team runtime.
// Every argv shape here is the build-102 flag grammar live-verified across
// PRs #79/#87/#92 (flag-form targets; per-verb TARGET vs CONTEXT semantics;
// close-surface and doc mounts are window-scoped, send/send-key resolve
// globally; `send` never auto-submits — send-key enter does).
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CMUX_BIN = process.env.CMUX_BIN || 'cmux'
const SPAWN_TIMEOUT_MS = 10_000

export function cmux(verb, args = [], { timeoutMs = SPAWN_TIMEOUT_MS, json = false } = {}) {
  const res = spawnSync(CMUX_BIN, [verb, ...args], { encoding: 'utf8', timeout: timeoutMs })
  const ok = res.status === 0
  const out = {
    ok,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: ok ? null : { message: (res.stderr || res.stdout || `exit ${res.status}`).trim() },
  }
  if (ok && json) {
    try { out.json = JSON.parse(out.stdout) } catch (err) { out.ok = false; out.error = { message: `bad JSON from ${verb}: ${err.message}` } }
  }
  return out
}

export function tree() {
  const res = cmux('tree', ['--json', '--id-format', 'uuids', '--all'], { json: true })
  if (!res.ok) throw new Error(`tree failed: ${res.error.message}`)
  return normalizeTree(res.json)
}

// lowercase every id once at ingestion (cmux emits uppercase, resolves
// case-insensitively; records stay lowercase).
function normalizeTree(t) {
  for (const w of t.windows || []) {
    w.id = (w.id || '').toLowerCase()
    for (const ws of w.workspaces || []) {
      ws.id = (ws.id || '').toLowerCase()
      for (const p of ws.panes || []) {
        p.id = (p.id || '').toLowerCase()
        for (const s of p.surfaces || []) { s.id = (s.id || '').toLowerCase(); s.pane_id = (s.pane_id || '').toLowerCase() }
      }
    }
  }
  return t
}

export function locate(t, id) {
  const needle = (id || '').toLowerCase()
  for (const w of t.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        for (const s of p.surfaces || []) if (s.id === needle) return { window: w, workspace: ws, pane: p, surface: s }
        if (p.id === needle) return { window: w, workspace: ws, pane: p }
      }
      if (ws.id === needle) return { window: w, workspace: ws }
    }
  }
  return null
}

// --- verified-send (the PR #79 discipline, vendored) -------------------------
// Type into a live pane, confirm the echo landed EXACTLY once, clear with
// ctrl+u before any retype, throw on every failure. Assignment lines obey the
// allowlist charset; content travels in files, never in the line.
const SAFE_LINE_RE = /^[A-Za-z0-9 _.,:;=/@'+-]+$/
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/
const SEND_SETTLE_MS = 250
const SEND_VERIFY_WINDOW_MS = 3000
const SEND_READY_TIMEOUT_MS = 60_000
const SEND_READY_POLL_MS = 250
const SEND_VERIFY_ATTEMPTS = 3

function settle(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

export function assertSafeLine(line) {
  if (typeof line !== 'string' || line.length === 0) throw new Error('sendLine: empty line')
  if (!SAFE_LINE_RE.test(line)) throw new Error('sendLine: line contains a character outside the allowed charset')
  for (const token of line.split(' ')) {
    if (!token) continue
    const eq = token.indexOf('=')
    const value = eq >= 0 ? token.slice(eq + 1) : token
    if (value.includes('/') && !SAFE_PATH_RE.test(value)) {
      throw new Error(`sendLine: path token must be absolute and charset-clean: ${value}`)
    }
  }
}

// --- assignment composition ----------------------------------------------------
// The assignment LINE is typed into a live shell, so it must stay inside
// SAFE_LINE_RE; rich content travels in a brief FILE and the line only points at
// it. Each field is checked as a WHOLE value here because assertSafeLine walks
// space-split tokens and skips any token without a '/': a relative brief path
// ('brief.md') or a path split in half by an embedded space would pass it unseen.
const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/
// Path separators are already outside SAFE_TOKEN_RE; dot-only tokens ('.', '..')
// are not, and they are the ones that turn into traversal when a caller joins an
// id or role into a filesystem path.
const DOTS_ONLY_RE = /^\.+$/

function assertToken(name, value) {
  if (typeof value !== 'string' || !SAFE_TOKEN_RE.test(value) || DOTS_ONLY_RE.test(value)) {
    throw new Error(`assignmentLine: ${name} must be a single safe token: ${value}`)
  }
}

function assertPathValue(name, value) {
  if (typeof value !== 'string' || !SAFE_PATH_RE.test(value)) {
    throw new Error(`assignmentLine: ${name} must be an absolute charset-clean path: ${value}`)
  }
}

export function assignmentLine({ id, role, briefFile, returnPath, taskDir }) {
  assertToken('id', id)
  assertToken('role', role)
  assertPathValue('briefFile', briefFile)
  assertPathValue('taskDir', taskDir)
  assertPathValue('returnPath', returnPath)
  const line = `ASSIGNMENT ${id}: read your brief at ${briefFile}. Task dir: ${taskDir}. Write your ReturnEnvelope to ${returnPath} then print exactly: CREW-DONE ${role} ${id}`
  assertSafeLine(line)
  return line
}

function frameNeedleCount(surfaceId, needle) {
  const res = cmux('read-screen', ['--surface', surfaceId, '--lines', '40'])
  if (!res.ok) return null
  return res.stdout.replace(/\s+/g, '').split(needle).length - 1
}

// The verification needle must come from the line's TAIL: a long line wraps
// in the seat's input box, and the box viewport scrolls to keep the cursor
// (at the END) visible — the head is genuinely absent from read-screen even
// though the buffer content is intact (live-hit 2026-08-13: two clean boots
// showed the identical "truncation", which was viewport scroll, not loss).
// Longest of the last 8 tokens = the return path on assignment lines.
export function pickNeedle(line) {
  const tokens = line.split(/\s+/).filter(Boolean)
  return tokens.slice(-8).reduce((a, b) => (b.length > a.length ? b : a), '')
}

export function sendLine(surfaceId, line) {
  assertSafeLine(line)
  const needle = pickNeedle(line)
  if (!needle) throw new Error('sendLine: no verifiable token in line')

  // Verify against a BASELINE, not an absolute count of 1: the needle may
  // already be on screen (the same brief path assigned twice, the seat's own
  // transcript quoting a path it read) and a correct send must still verify.
  const deadline = Date.now() + SEND_READY_TIMEOUT_MS
  let before = frameNeedleCount(surfaceId, needle)
  while (before === null) {
    if (Date.now() >= deadline) throw new Error(`sendLine: surface ${surfaceId} never became readable`)
    settle(SEND_READY_POLL_MS)
    before = frameNeedleCount(surfaceId, needle)
  }

  let landed = false
  let last = null
  for (let attempt = 1; attempt <= SEND_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      // Clearing a TUI input box is NOT one ctrl+u (live-hit 2026-08-13):
      // in the claude TUI ctrl+u deletes to the start of the VISUAL line and
      // then no-ops, leaving a truncated tail of any wrapped line. ctrl+u
      // first (harmless everywhere), then ONE ctrl+c (claude's full input
      // clear; on an already-empty box it only arms an exit warning, which
      // the retype immediately disarms — never send it twice in a row).
      // Refuse to retype into a box that still shows the needle.
      cmux('send-key', ['--surface', surfaceId, '--', 'ctrl+u'])
      settle(SEND_READY_POLL_MS)
      if (frameNeedleCount(surfaceId, needle) !== before) {
        cmux('send-key', ['--surface', surfaceId, '--', 'ctrl+c'])
        settle(SEND_READY_POLL_MS)
      }
      if (frameNeedleCount(surfaceId, needle) !== before) {
        throw new Error('sendLine: could not clear the pane input back to baseline before retype')
      }
    }
    const send = cmux('send', ['--surface', surfaceId, '--', line])
    if (!send.ok) throw new Error(`sendLine: send failed: ${send.error.message}`)
    // POLL for the echo rather than reading once: a TUI seat right after
    // boot can take a second-plus to render typed input, and a single fast
    // read here mistakes slow rendering for a lost send (live-hit 2026-08-13:
    // both crews' first assignment landed but verified 0, killing the run).
    const verifyDeadline = Date.now() + SEND_VERIFY_WINDOW_MS
    do {
      settle(SEND_SETTLE_MS)
      last = frameNeedleCount(surfaceId, needle)
      if (last === before + 1) { landed = true; break }
    } while (Date.now() < verifyDeadline)
    if (landed) break
  }
  if (!landed) throw new Error(`sendLine: echo not verified exactly once over baseline (before ${before}, last ${last})`)

  const enter = cmux('send-key', ['--surface', surfaceId, '--', 'enter'])
  if (!enter.ok) throw new Error(`sendLine: enter failed: ${enter.error.message}`)
}

// --- context-aware surface ops ------------------------------------------------


export function renameTab(surfaceId, title) {
  cmux('rename-tab', ['--surface', surfaceId, '--', title])
}

export function closeSurface(id) {
  // window-scoped UUID resolution on build 102 — resolve context first.
  const found = locate(tree(), id)
  if (!found?.surface) return false
  return cmux('close-surface', ['--surface', id, '--window', found.window.id]).ok
}

export function closeWorkspace(id) {
  return cmux('close-workspace', ['--workspace', id]).ok
}


// --- crew log ------------------------------------------------------------------
export function logLine(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(obj)}\n`)
  } catch { /* logging never throws */ }
}
