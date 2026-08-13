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
const SEND_SETTLE_MS = 30
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

export function sendLine(surfaceId, line) {
  assertSafeLine(line)
  const needle = line.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '')
  if (!needle) throw new Error('sendLine: no verifiable token in line')

  const deadline = Date.now() + SEND_READY_TIMEOUT_MS
  while (frameNeedleCount(surfaceId, needle) === null) {
    if (Date.now() >= deadline) throw new Error(`sendLine: surface ${surfaceId} never became readable`)
    settle(SEND_READY_POLL_MS)
  }

  let landed = false
  let last = null
  for (let attempt = 1; attempt <= SEND_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const clear = cmux('send-key', ['--surface', surfaceId, '--', 'ctrl+u'])
      if (!clear.ok) throw new Error(`sendLine: ctrl+u failed: ${clear.error.message}`)
      settle(SEND_READY_POLL_MS)
    }
    const send = cmux('send', ['--surface', surfaceId, '--', line])
    if (!send.ok) throw new Error(`sendLine: send failed: ${send.error.message}`)
    settle(SEND_SETTLE_MS)
    last = frameNeedleCount(surfaceId, needle)
    if (last === 1) { landed = true; break }
  }
  if (!landed) throw new Error(`sendLine: echo not verified exactly once (last count ${last})`)

  const enter = cmux('send-key', ['--surface', surfaceId, '--', 'enter'])
  if (!enter.ok) throw new Error(`sendLine: enter failed: ${enter.error.message}`)
}

// --- context-aware surface ops ------------------------------------------------

export function readScreen(surfaceId, lines = 40) {
  const res = cmux('read-screen', ['--surface', surfaceId, '--lines', String(lines)])
  return res.ok ? res.stdout : null
}

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

// Mount a markdown artifact under a member's pane (PR #92 grammar: markdown
// open's --workspace/--window are TARGETS; naming them pins the mount to the
// crew workspace instead of inheriting the caller's focus).
export function mountArtifact(path, { workspaceId, windowId }) {
  const res = cmux('markdown', ['open', path, '--workspace', workspaceId, '--window', windowId, '--direction', 'down', '--focus', 'false'])
  return res.ok
}

// --- crew log ------------------------------------------------------------------
export function logLine(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(obj)}\n`)
  } catch { /* logging never throws */ }
}
