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
// One typed copy, then up to SEND_RETRIES more (#759): a send whose echo never
// lands is cleared back to baseline and RETYPED rather than escalating the lane
// on its first attempt.
export const SEND_RETRIES = 2
// The escalation must show what the pane showed.
const SCREEN_TAIL_LINES = 12

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

// The line is long, and its length is what made #759 visible — but it is NOT
// shortened. Restating the return path as `<taskDir>/returns/<basename>` would
// make a seat DERIVE a path it must be given, and dropping any field breaks the
// seat contract; measured against the multi-candidate proof below, that
// contract risk is not worth the characters. Both paths stay verbatim (#759).
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

function readScreen(surfaceId, cmuxFn = cmux) {
  const res = cmuxFn('read-screen', ['--surface', surfaceId, '--lines', '40'])
  if (!res.ok) return null
  return res.stdout
}

// Every candidate is counted off ONE frame: N candidates must never cost N
// reads. Whitespace is stripped from the frame, so candidates are stripped too.
function frameNeedleCounts(surfaceId, needles, cmuxFn = cmux) {
  const stdout = readScreen(surfaceId, cmuxFn)
  if (stdout === null) return null
  const flat = stdout.replace(/\s+/g, '')
  return needles.map((needle) => flat.split(needle).length - 1)
}

function screenTail(surfaceId, cmuxFn = cmux) {
  const stdout = readScreen(surfaceId, cmuxFn)
  if (stdout === null) return '<unreadable>'
  return stdout.split('\n').slice(-SCREEN_TAIL_LINES).join(' | ')
}

const sameCounts = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])

// Verification needles must be SHORT and there must be SEVERAL (#759). The
// claude input widget renders a fixed two-line window of a long line, so the
// ~80-character return path — the longest of the last 8 tokens, and therefore
// the old single needle — is cut mid-way and never counts as present: b322
// escalated on its first send with the assignment plainly sitting in the box,
// while a sibling lane with a LONGER crew-dir path passed. Whether a needle
// survives is a function of how the line happens to wrap, so take one candidate
// from the HEAD, one from the MIDDLE (the return file's basename) and one from
// the TAIL, each <= NEEDLE_MAX_LEN characters and unique within the line, and
// let ANY of them prove the landing.
export const NEEDLE_MAX_LEN = 24

export function pickNeedles(line) {
  const squash = (s) => s.replace(/\s+/g, '')
  const flat = squash(line)
  const raw = []
  const head = line.match(/^ASSIGNMENT\s+(\S+):/)
  if (head) raw.push(`ASSIGNMENT ${head[1]}:`)
  const mid = line.match(/ReturnEnvelope to (\S+)/)
  if (mid) raw.push(mid[1].split('/').pop())
  const tail = line.match(/CREW-DONE\s+(\S+)\s+(\S+)\s*$/)
  if (tail) raw.push(`CREW-DONE ${tail[1]} ${tail[2]}`)
  const out = []
  for (const candidate of raw) {
    const needle = squash(candidate)
    if (!needle || needle.length > NEEDLE_MAX_LEN) continue
    if (flat.split(needle).length - 1 !== 1) continue
    if (!out.includes(needle)) out.push(needle)
  }
  if (out.length) return out
  // Last resort for a line that is not an assignment (the legacy handoff line):
  // the pre-#759 rule, the longest of the last 8 tokens.
  const tokens = line.split(/\s+/).filter(Boolean)
  const longest = tokens.slice(-8).reduce((a, b) => (b.length > a.length ? b : a), '')
  return longest ? [squash(longest)] : []
}

// --- submission proof (b305) --------------------------------------------------
// An echo proves CHARACTERS REACHED THE SCREEN; it does not prove the agent
// consumed them. Measured live 2026-08-29 (cmux 0.64.22 build 102, a claude
// pane in this checkout): with the line typed, the needle was on the frame
// exactly once; 200 ms after `send-key enter` it was GONE (count 1 -> 0) and
// the session transcript carried the message — the input box clearing IS the
// observable difference between a submitted line and one still sitting unsent.
// So after the enter the count must LEAVE its post-send value.
const SUBMIT_PROOF_POLL_MS = 250
// Sized against the MEASURED failure, not against convenience: the 2026-08-28
// boot race lost the first assignment for about 60 s, while the old budget was
// one enter and no proof at all (and the echo ladder's own ~9 s could not have
// covered it either). One enter waits 20 s for the box to clear — 100x the
// 200 ms measured for a healthy submit — and the whole send is capped at
// 120 000 ms, twice the measured race, after which the failure is loud.
export const SUBMIT_PROOF_WINDOW_MS = 20_000
export const SUBMIT_ENTER_ATTEMPTS = 3
export const SUBMIT_TOTAL_BUDGET_MS = 120_000

// A resend loop is a cost surface, so every attempt and its outcome is
// journalled. Callers that pass no deps — every production caller today —
// still journal: to CREW_SEND_JOURNAL when it is set, and a LOUD row to stderr
// for any attempt that failed to prove, because a swallowed assignment that
// nobody records is the defect this lane removes.
function sendJournal(deps) {
  const sink = typeof deps.log === 'function' ? deps.log : null
  const file = process.env.CREW_SEND_JOURNAL || null
  return (row, loud = false) => {
    try { if (sink) sink(row) } catch { /* the journal is diagnostics, never load-bearing */ }
    try { if (file) logLine(file, row) } catch { /* the journal is diagnostics */ }
    try { if (loud && !sink) process.stderr.write(`${JSON.stringify(row)}\n`) } catch { /* the journal is diagnostics */ }
  }
}

export function sendLine(surfaceId, line, deps = {}) {
  const cmuxFn = deps.cmux || cmux
  const settleFn = deps.settle || settle
  const now = deps.now || Date.now
  const journal = sendJournal(deps)
  assertSafeLine(line)
  const needles = pickNeedles(line)
  if (!needles.length) throw new Error('sendLine: no verifiable token in line')

  // Verify against a BASELINE, not an absolute count of 1: a needle may
  // already be on screen (the same brief path assigned twice, the seat's own
  // transcript quoting a path it read) and a correct send must still verify.
  // Each candidate carries its OWN baseline.
  const startedAt = now()
  const deadline = startedAt + SEND_READY_TIMEOUT_MS
  let before = frameNeedleCounts(surfaceId, needles, cmuxFn)
  while (before === null) {
    if (now() >= deadline) throw new Error(`sendLine: surface ${surfaceId} never became readable`)
    settleFn(SEND_READY_POLL_MS)
    before = frameNeedleCounts(surfaceId, needles, cmuxFn)
  }

  const afterSend = before.map((count) => count + 1)
  const budgetEnd = startedAt + SUBMIT_TOTAL_BUDGET_MS
  let everLanded = false
  let submitted = false
  let enters = 0
  let last = null
  for (let attempt = 1; attempt <= SEND_RETRIES + 1; attempt += 1) {
    if (attempt > 1) {
      // Clearing a TUI input box is NOT one ctrl+u (live-hit 2026-08-13):
      // in the claude TUI ctrl+u deletes to the start of the VISUAL line and
      // then no-ops, leaving a truncated tail of any wrapped line. ctrl+u
      // first (harmless everywhere), then ONE ctrl+c (claude's full input
      // clear; on an already-empty box it only arms an exit warning, which
      // the retype immediately disarms — never send it twice in a row).
      // Refuse to retype into a box that still shows ANY candidate.
      cmuxFn('send-key', ['--surface', surfaceId, '--', 'ctrl+u'])
      settleFn(SEND_READY_POLL_MS)
      if (!sameCounts(frameNeedleCounts(surfaceId, needles, cmuxFn), before)) {
        cmuxFn('send-key', ['--surface', surfaceId, '--', 'ctrl+c'])
        settleFn(SEND_READY_POLL_MS)
      }
      if (!sameCounts(frameNeedleCounts(surfaceId, needles, cmuxFn), before)) {
        throw new Error('sendLine: could not clear the pane input back to baseline before retype')
      }
      settleFn(SEND_READY_POLL_MS)
    }
    const send = cmuxFn('send', ['--surface', surfaceId, '--', line])
    if (!send.ok) throw new Error(`sendLine: send failed: ${send.error.message}`)
    // POLL for the echo rather than reading once: a TUI seat right after
    // boot can take a second-plus to render typed input, and a single fast
    // read here mistakes slow rendering for a lost send (live-hit 2026-08-13:
    // both crews' first assignment landed but verified 0, killing the run).
    const verifyDeadline = now() + SEND_VERIFY_WINDOW_MS
    let landed = -1
    do {
      settleFn(SEND_SETTLE_MS)
      last = frameNeedleCounts(surfaceId, needles, cmuxFn)
      if (last !== null) {
        const hit = last.findIndex((count, index) => count === afterSend[index])
        if (hit >= 0) { landed = hit; break }
      }
    } while (now() < verifyDeadline)
    journal({
      at: new Date(now()).toISOString(),
      event: 'send-echo-attempt',
      surface_id: surfaceId,
      attempt,
      candidates: needles,
      counts: last,
      needle: landed >= 0 ? needles[landed] : null,
      outcome: landed >= 0 ? 'landed' : 'not-landed',
    }, landed < 0)
    if (landed < 0) continue
    everLanded = true

    // The line is on the screen and intact. Press enter, then PROVE the box
    // let it go, counting the SAME candidate that proved the landing. A
    // re-press is the cheapest recovery and the safest one: on an
    // already-submitted box it submits nothing, so it cannot double an
    // assignment. Only when the re-presses are spent does the outer attempt
    // fall back to the clear-and-retype ladder above.
    for (let enter = 1; enter <= SUBMIT_ENTER_ATTEMPTS && !submitted; enter += 1) {
      const key = cmuxFn('send-key', ['--surface', surfaceId, '--', 'enter'])
      if (!key.ok) throw new Error(`sendLine: enter failed: ${key.error.message}`)
      enters += 1
      const proofEnd = Math.min(now() + SUBMIT_PROOF_WINDOW_MS, budgetEnd)
      let seen = null
      do {
        settleFn(SUBMIT_PROOF_POLL_MS)
        seen = frameNeedleCounts(surfaceId, needles, cmuxFn)
        if (seen !== null && seen[landed] !== afterSend[landed]) { submitted = true; break }
      } while (now() < proofEnd)
      journal({
        at: new Date(now()).toISOString(),
        event: 'send-submit-attempt',
        surface_id: surfaceId,
        attempt,
        enter,
        needle: needles[landed],
        needle_count: seen === null ? null : seen[landed],
        expected_in_box: afterSend[landed],
        outcome: submitted ? 'submitted' : (seen === null ? 'unreadable' : 'unproved'),
      }, !submitted)
      if (!submitted && now() >= budgetEnd) break
    }
    if (submitted || now() >= budgetEnd) break
  }
  if (!everLanded) {
    throw new Error(`sendLine: echo not verified exactly once over baseline (before ${before.join(',')}, last ${last === null ? 'unreadable' : last.join(',')}) — candidates ${needles.join(' | ')} — last ${SCREEN_TAIL_LINES} screen lines: ${screenTail(surfaceId, cmuxFn)}`)
  }

  journal({
    at: new Date(now()).toISOString(),
    event: 'send-submit',
    surface_id: surfaceId,
    enters,
    elapsed_ms: now() - startedAt,
    outcome: submitted ? 'submitted' : 'not-submitted',
  }, !submitted)
  if (!submitted) {
    const err = new Error(`sendLine: submit not proved — the line never left the input box on surface ${surfaceId} after ${enters} enters over ${now() - startedAt}ms`)
    err.code = 'send-not-submitted'
    throw err
  }
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

// --- surface -> process tree (read-only observability, #149) -----------------
// ADR-029:68 said the pane transport owns no process handle. `cmux top
// --processes --json --all` falsifies the observability half: it attributes pids
// to a surface and to their descendants. This resolves a retained (lowercased
// UUID) surface id to that attributed forest -- a POINT-IN-TIME snapshot.
//
// `cmux top` prints positional refs only, so the retained UUID is translated
// with `cmux tree --json --id-format both --all`, which carries id and ref on
// one surface object. A ref is valid only inside a single invocation
// (docs/conventions.md:78, docs/trd-cmux-execution-mode.md:199-200), so the top
// read is BRACKETED by two tree reads and the mapping must be identical in
// both; if it moved, this returns unknown rather than another pane's processes.
//
// Read-only: the three operations it performs are `cmux tree`, `cmux top`,
// `cmux tree`. It sends nothing, closes nothing, signals nothing, mutates
// nothing, and makes no process state authoritative for any crew decision --
// the envelope stays the outcome.
export function surfaceProcessTree(surfaceId, deps = {}) {
  const id = typeof surfaceId === 'string' ? surfaceId.toLowerCase() : ''
  const unknown = (reason) => ({
    status: 'unknown',
    surface_id: id,
    surface_ref: null,
    self: null,
    self_by: 'none',
    roots: [],
    reason,
  })

  try {
    const { cmux: cmuxFn = cmux } = deps
    if (!id) return unknown('surfaceProcessTree: surfaceId must be a non-empty string')

    const refFor = (label) => {
      const result = cmuxFn('tree', ['--json', '--id-format', 'both', '--all'], { json: true })
      if (!result?.ok) return { err: `tree (${label}) failed: ${result?.error?.message || 'unknown error'}` }
      if (!Array.isArray(result.json?.windows)) return { err: `tree (${label}): unexpected shape` }

      const matches = []
      for (const window of result.json.windows) {
        if (!window || typeof window !== 'object') continue
        for (const workspace of Array.isArray(window.workspaces) ? window.workspaces : []) {
          if (!workspace || typeof workspace !== 'object') continue
          for (const pane of Array.isArray(workspace.panes) ? workspace.panes : []) {
            if (!pane || typeof pane !== 'object') continue
            for (const surface of Array.isArray(pane.surfaces) ? pane.surfaces : []) {
              if (surface && typeof surface === 'object' && String(surface.id).toLowerCase() === id) matches.push(surface)
            }
          }
        }
      }
      if (matches.length !== 1) return { err: `tree (${label}) lists ${matches.length} surfaces with id ${id}` }
      if (typeof matches[0].ref !== 'string' || matches[0].ref.length === 0) return { err: `tree (${label}) gives no ref for ${id}` }
      return { ref: matches[0].ref }
    }

    const first = refFor('before')
    if (first.err) return unknown(`surfaceProcessTree: ${first.err}`)

    const top = cmuxFn('top', ['--processes', '--json', '--all'], { json: true })
    if (!top?.ok) return unknown(`surfaceProcessTree: top failed: ${top?.error?.message || 'unknown error'}`)
    if (!Array.isArray(top.json?.windows)) return unknown('surfaceProcessTree: top: unexpected shape')

    const second = refFor('after')
    if (second.err) return unknown(`surfaceProcessTree: ${second.err}`)
    if (second.ref !== first.ref) return unknown(`surfaceProcessTree: ${id} moved between snapshots: ${first.ref} then ${second.ref}`)

    const nodes = []
    for (const window of top.json.windows) {
      if (!window || typeof window !== 'object') continue
      for (const workspace of Array.isArray(window.workspaces) ? window.workspaces : []) {
        if (!workspace || typeof workspace !== 'object') continue
        for (const pane of Array.isArray(workspace.panes) ? workspace.panes : []) {
          if (!pane || typeof pane !== 'object') continue
          for (const surface of Array.isArray(pane.surfaces) ? pane.surfaces : []) {
            if (surface && typeof surface === 'object' && surface.ref === first.ref) nodes.push(surface)
          }
        }
      }
    }
    if (nodes.length !== 1) return unknown(`surfaceProcessTree: top lists ${nodes.length} surfaces with ref ${first.ref}`)
    if (!Array.isArray(nodes[0].processes)) return unknown('surfaceProcessTree: top surface has unexpected processes shape')

    const foreground = Array.isArray(nodes[0].foreground_pgids) ? nodes[0].foreground_pgids : []
    const candidates = []
    const normalize = (p) => {
      if (!p || typeof p !== 'object') return { err: 'malformed process node' }
      const rawId = p.cmux_surface_id
      const own = rawId == null ? null : String(rawId).toLowerCase()
      if (own !== null && own !== id) return { err: `pid ${p.pid} is attributed to ${rawId}, not ${id}` }

      let children = []
      if (Object.hasOwn(p, 'children') && p.children !== null) {
        if (!Array.isArray(p.children)) return { err: `pid ${p.pid} has malformed children` }
        children = []
        for (const child of p.children) {
          const normalized = normalize(child)
          if (normalized.err) return normalized
          children.push(normalized.node)
        }
      }

      const node = {
        pid: p.pid,
        pgid: p.pgid,
        ppid: p.ppid,
        name: p.name,
        reason: p.attribution_reason,
        children,
      }
      if (own === id && foreground.includes(p.pgid) && p.pid === p.pgid) candidates.push(node)
      return { node }
    }

    const roots = []
    for (const p of nodes[0].processes) {
      const normalized = normalize(p)
      if (normalized.err) return unknown(`surfaceProcessTree: ${normalized.err}`)
      roots.push(normalized.node)
    }
    if (roots.length === 0) return { status: 'empty', surface_id: id, surface_ref: first.ref, self: null, self_by: 'none', roots: [], reason: null }

    const self = candidates.length === 1
      ? { pid: candidates[0].pid, pgid: candidates[0].pgid, ppid: candidates[0].ppid, name: candidates[0].name, reason: candidates[0].reason }
      : null
    const self_by = self ? 'foreground-group-leader' : 'none'
    return { status: 'measured', surface_id: id, surface_ref: first.ref, self, self_by, roots, reason: null }
  } catch (error) {
    return unknown(`surfaceProcessTree: ${error?.message || 'unexpected error'}`)
  }
}
// --- end surfaceProcessTree ---
