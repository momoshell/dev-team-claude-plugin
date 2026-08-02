// The evidence layer: the single authority on whether a dispatch completed.
// Zero dependencies, node builtins only, ESM, Node 20 floor.
//
// The predicate this whole module exists to prove:
//   completed <=> isFresh(record, returnStat) AND validateReturn(record, returnText).ok
// Nothing a worker can write (the .exit sentinel, the .gate counter, a
// signals JSONL line) moves that predicate. See test/cmux-ladder.test.mjs's
// header comment for the two degenerate implementations the test suite must
// kill, and Group 5 (L-21..L-26) for the independence proof.
import { readFileSync, writeFileSync, renameSync, lstatSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename, resolve as resolvePath } from 'node:path'
import { validate, SIGNAL_LIMITS, SECTION_HEADING_RE } from './contract.mjs'
import { renderPathFor } from './resolve.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const RETURN_ENVELOPE_SCHEMA = JSON.parse(readFileSync(join(MODULE_DIR, 'return-envelope.schema.json'), 'utf8'))
const SIGNAL_SCHEMA = JSON.parse(readFileSync(join(MODULE_DIR, 'signal-record.schema.json'), 'utf8'))
const SIGNAL_LEVELS = SIGNAL_SCHEMA.properties.level.enum

// Named constant (qa L-19): step 1 (the envelope schema) puts no pattern on
// a string body, so a markdown kind with an empty body would otherwise pass
// step 2 vacuously. This is the rule that closes that hole.
const MARKDOWN_BODY_EMPTY_KEYWORD = 'markdown_body_empty'

// ---------------------------------------------------------------------------
// isFresh — PINNED DECISION U-2.
//
// STRICT and integer-millisecond: Math.floor(stat.mtimeMs) > Date.parse(record.created_at).
// This SUPERSEDES architecture-amendment-package-v2.md:259's "mtime >=
// dispatch start". Reason for the supersession: a >= comparison, combined
// with the frozen ISO pattern's OPTIONAL milliseconds group, admits a ~1s
// stale window (a created_at truncated to whole seconds would treat a
// same-second-but-earlier mtime as fresh); a same-instant legitimate return
// costs at most one poll tick under the stricter >, which is the cheaper
// failure mode. mtimeMs is a float with sub-millisecond precision on APFS;
// Math.floor before comparing keeps the sub-ms window fail-closed.
// ---------------------------------------------------------------------------
export function isFresh(record, stat) {
  if (!stat) return false
  return Math.floor(stat.mtimeMs) > Date.parse(record.created_at)
}

// checkIdentity(record, envelope) -> violations[]
// PINNED DECISION U-3: agreement is the FULL four-tuple {dispatch_id,
// slice_id, attempt, role}, each mismatch its own named violation.
// produced_at is NEVER compared here — freshness (isFresh) owns time
// ordering, and produced_at is a format-only field in the envelope schema.
export function checkIdentity(record, envelope) {
  const violations = []
  if (envelope.dispatch_id !== record.dispatch_id) {
    violations.push({ path: '$.dispatch_id', keyword: 'dispatch_id_mismatch', message: `envelope dispatch_id ${JSON.stringify(envelope.dispatch_id)} does not match record dispatch_id ${JSON.stringify(record.dispatch_id)}` })
  }
  if (envelope.slice_id !== record.slice_id) {
    violations.push({ path: '$.slice_id', keyword: 'slice_id_mismatch', message: `envelope slice_id ${JSON.stringify(envelope.slice_id)} does not match record slice_id ${JSON.stringify(record.slice_id)}` })
  }
  if (envelope.attempt !== record.attempt) {
    violations.push({ path: '$.attempt', keyword: 'attempt_mismatch', message: `envelope attempt ${JSON.stringify(envelope.attempt)} does not match record attempt ${JSON.stringify(record.attempt)}` })
  }
  if (envelope.role !== record.role) {
    violations.push({ path: '$.role', keyword: 'role_mismatch', message: `envelope role ${JSON.stringify(envelope.role)} does not match record role ${JSON.stringify(record.role)}` })
  }
  return violations
}

// ---------------------------------------------------------------------------
// stripFences / checkSections — PINNED DECISION U-5.
//
// Fenced code blocks (``` and ~~~; an unclosed fence strips to EOF) are
// stripped from the body BEFORE SECTION_HEADING_RE runs. This narrows the
// frozen F-2 rule (it can only reject MORE required_sections matches, never
// accept more) and needs no change to contract.mjs — it is a consumer-side
// filter applied ahead of the shared regex.
// ---------------------------------------------------------------------------
export function stripFences(body) {
  const lines = body.split('\n')
  const out = []
  let fenceChar = null
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceChar) {
      if (m && m[1][0] === fenceChar) {
        fenceChar = null
      }
      continue
    }
    if (m) {
      fenceChar = m[1][0]
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// checkSections(body, requiredSections) -> string[] of missing section names.
// Uses SECTION_HEADING_RE from contract.mjs via [...stripFences(body).matchAll(RE)],
// capture group 1 trimmed. (Discharges A10 "markdown required_sections check
// using SECTION_HEADING_RE".)
export function checkSections(body, requiredSections) {
  const stripped = stripFences(body)
  const headings = new Set([...stripped.matchAll(SECTION_HEADING_RE)].map((m) => m[1].trim()))
  return requiredSections.filter((name) => !headings.has(name))
}

// ---------------------------------------------------------------------------
// validateReturn — the frozen TWO-STEP validation.
//
// Step 1: the envelope against return-envelope.schema.json (identity
// agreement, PINNED U-3, is part of step 1). Step 2: body against
// record.return — kind 'json' validates body as an object against
// record.return.schema_path; kind 'markdown' requires a non-empty string
// whose fence-stripped headings cover every required_sections entry.
//
// backend-notes.md: "validators throw on contract-author error, return
// violations on data error" — a malformed WORKER return is data. This
// function NEVER throws; every hostile input (unparseable JSON, a top-level
// array/string, a truncated document) is reported as a Violation[].
// ---------------------------------------------------------------------------
export function validateReturn(record, text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, violations: [{ path: '$', keyword: 'empty_return', message: 'return body is empty or unreadable' }], envelope: null }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, violations: [{ path: '$', keyword: 'invalid_json', message: `return body is not valid JSON: ${err.message}` }], envelope: null }
  }

  const envelopeViolations = validate(RETURN_ENVELOPE_SCHEMA, parsed)
  if (envelopeViolations.length > 0) {
    return { ok: false, violations: envelopeViolations, envelope: parsed }
  }

  const identityViolations = checkIdentity(record, parsed)
  if (identityViolations.length > 0) {
    return { ok: false, violations: identityViolations, envelope: parsed }
  }

  const bodyViolations = validateBody(record, parsed)
  if (bodyViolations.length > 0) {
    return { ok: false, violations: bodyViolations, envelope: parsed }
  }

  return { ok: true, violations: [], envelope: parsed }
}

// D-1 item 3 (trust M1, fix-round): a schema_path resolving inside
// dirname(dirname(record.role_prompt_path)) — the --plugin-dir tree handed
// to the worker's claude process — is worker-writable (G13). This check is
// independent of WHERE the B-slice coder repoints a legitimate
// schema_path (interface row 4: the plugin-root source path) — it only
// asks whether the given path resolves inside the worker-writable tree
// derived from THIS record's own role_prompt_path, so it holds for any
// record regardless of what a conforming schema_path value looks like.
function schemaInWorkerWritableTree(schemaPath, record) {
  if (typeof record.role_prompt_path !== 'string' || record.role_prompt_path === '') {
    return false
  }
  const workerTree = resolvePath(dirname(dirname(record.role_prompt_path)))
  const resolvedSchema = resolvePath(schemaPath)
  return resolvedSchema === workerTree || resolvedSchema.startsWith(`${workerTree}/`)
}

function validateBody(record, envelope) {
  const { kind, schema_path: schemaPath, required_sections: requiredSections } = record.return

  if (kind === 'json') {
    if (typeof envelope.body !== 'object' || envelope.body === null || Array.isArray(envelope.body)) {
      return [{ path: '$.body', keyword: 'type', message: 'json body must be an object' }]
    }

    if (schemaInWorkerWritableTree(schemaPath, record)) {
      return [{ path: '$.return.schema_path', keyword: 'schema_in_worker_writable_tree', message: `schema_path ${JSON.stringify(schemaPath)} resolves inside the worker-writable --plugin-dir tree` }]
    }

    // D-1 item 2 (trust M1, fix-round): the read+parse+validate of a
    // worker-reachable file must NEVER throw out of validateReturn — a
    // deleted/unreadable/non-JSON schema is `schema_unreadable`; a
    // schema validate() itself refuses (an out-of-budget key, e.g. a
    // planted $ref) is `schema_tampered`. Both are data problems, not
    // contract-author problems, so both are violations, never throws.
    let schema
    try {
      schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    } catch (err) {
      return [{ path: '$.return.schema_path', keyword: 'schema_unreadable', message: `schema_path ${JSON.stringify(schemaPath)} could not be read or parsed: ${err.message}` }]
    }
    try {
      return validate(schema, envelope.body)
    } catch (err) {
      return [{ path: '$.return.schema_path', keyword: 'schema_tampered', message: `schema at ${JSON.stringify(schemaPath)} is malformed: ${err.message}` }]
    }
  }

  if (kind === 'markdown') {
    if (typeof envelope.body !== 'string') {
      return [{ path: '$.body', keyword: 'type', message: 'markdown body must be a string' }]
    }
    if (envelope.body.trim().length === 0) {
      return [{ path: '$.body', keyword: MARKDOWN_BODY_EMPTY_KEYWORD, message: 'markdown body must be non-empty after trim' }]
    }
    const missing = checkSections(envelope.body, requiredSections)
    return missing.map((name) => ({ path: '$.body', keyword: 'missing_required_section', message: `missing required section: ${name}` }))
  }

  return [{ path: '$.return.kind', keyword: 'enum', message: `unknown return kind: ${JSON.stringify(kind)}` }]
}

// ---------------------------------------------------------------------------
// collectFsState — THE production filesystem seam (qa L-30).
//
// lstat-based: a symlink or a directory sitting at return_path is treated as
// NO return (reason 'return_path_not_regular_file'), never followed and
// never read. record.return_path and record.signals_path are the only files
// this reads for return/signal CONTENT, so a glob, a readdir or a
// newest-file scan can never sneak in here (qa L-13's "reads ONLY
// record.return_path" rule) — the ONE narrow exception is partialWrite
// below, which never reads any OTHER file's content, only lists names.
// paths carries the two sidecar files (.exit/.gate) that live outside the
// record's own fields, plus an optional worktreeDirty flag the caller
// supplies — this module never invokes git.
// ---------------------------------------------------------------------------
export function collectFsState({ record, paths = {} }) {
  let returnStat = null
  let returnText = null
  let returnPathKind = 'absent'

  try {
    const st = lstatSync(record.return_path)
    if (st.isSymbolicLink()) {
      returnPathKind = 'symlink'
    } else if (st.isDirectory()) {
      returnPathKind = 'directory'
    } else if (st.isFile()) {
      returnPathKind = 'file'
      returnStat = { mtimeMs: st.mtimeMs }
      returnText = readFileSync(record.return_path, 'utf8')
    } else {
      returnPathKind = 'other'
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    returnPathKind = 'absent'
  }

  return {
    returnStat,
    returnText,
    returnPathKind,
    // Fix-round lifecycle S11: partialWrite is set ONLY when return_path is
    // absent AND a <stem>.json*tmp* sibling exists (the worker's own
    // tmp+rename write, mid-flight). This never reads that sibling's
    // CONTENT and never treats it as return evidence — it is purely an
    // informational flag reconcile uses to name the transient state,
    // distinct from an ordinary orphan.
    partialWrite: returnPathKind === 'absent' && hasPartialWriteSibling(record.return_path),
    exitSentinel: readSidecarOrNull(paths.exitPath),
    gateCounter: readSidecarOrNull(paths.gatePath),
    signalLines: readLinesOrEmpty(record.signals_path),
    worktreeDirty: Boolean(paths.worktreeDirty),
  }
}

function hasPartialWriteSibling(returnPath) {
  const dir = dirname(returnPath)
  const base = basename(returnPath)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  return entries.some((name) => name !== base && name.startsWith(base) && name.includes('tmp'))
}

function readSidecarOrNull(path) {
  if (!path) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function readLinesOrEmpty(path) {
  if (!path) return []
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

// evaluateCompletion — the ONLY thing that decides `completed`. Reads
// exclusively record and the three fsState fields named below; a hostile
// exitSentinel/gateCounter/signalLines/tree passed alongside a legitimate
// fresh valid return must never move this verdict (qa L-26 per-call form).
function evaluateCompletion(record, fsState) {
  const kind = fsState ? fsState.returnPathKind : 'absent'

  // 'absent' (the ordinary "no return yet" case) carries no violation — it
  // is not itself hostile, just not-yet-arrived. A directory/symlink/other
  // sitting at return_path IS hostile: it gets its own named violation
  // (qa L-20, vacuity C1) so the reason surfaces precisely rather than
  // collapsing into the generic stale/absent case.
  if (kind === 'absent') {
    return { completed: false, fresh: false, validation: null }
  }
  if (kind !== 'file') {
    return {
      completed: false,
      fresh: false,
      validation: { ok: false, violations: [{ path: '$', keyword: 'return_path_not_regular_file', message: `return_path is ${kind}, not a regular file` }], envelope: null },
    }
  }
  const fresh = isFresh(record, fsState.returnStat)
  const validation = validateReturn(record, fsState.returnText)
  return { completed: fresh && validation.ok, fresh, validation }
}

// buildIncompleteReason: a concrete violation keyword (qa L-20 / vacuity C1
// — the reason must NAME the failure, not just be truthy) always wins over
// the generic staleness fallback, so a directory/symlink at return_path
// reports 'return_path_not_regular_file' rather than a vague
// 'stale_or_absent_return' even though evaluateCompletion also marks it
// not-fresh.
function buildIncompleteReason(fresh, validation) {
  if (validation && validation.violations.length > 0) return validation.violations[0].keyword
  if (!fresh) return 'stale_or_absent_return'
  return 'no_valid_return'
}

function isAttention({ now, quietState, topIdle, quietS }) {
  if (!quietState || quietState.turnEndAt == null) return false
  if (topIdle === null || topIdle === undefined) return false
  if (quietState.latched) return true
  const elapsed = now - Date.parse(quietState.turnEndAt)
  return elapsed > quietS * 1000 && topIdle === true
}

// ---------------------------------------------------------------------------
// classify — pinned evaluation order (ADR-003 Am.1): completion is ALWAYS
// re-derived from the ladder on every wake, regardless of which token or
// event caused the wake. No function in this module takes a token/event as
// completion evidence — signals and events are rescan triggers only.
//
//   (0) record.outcome !== null -> the terminal state, never re-opened.
//       Fix-round trust M4: 'ok' is the only forgeable outcome worth a
//       worker overwriting its own record for (every other value is
//       self-inflicted failure), so when outcome === 'ok' the existing
//       completion predicate is run READ-ONLY over the supplied fsState —
//       never to re-open or re-terminate (L-27/L-28 stay literal: the
//       returned state and reason are unchanged), only to append the
//       warning 'terminal_outcome_uncorroborated' when the ladder does NOT
//       independently derive completed. This exact warning string is a
//       pinned cross-slice interface — the E coder's closeCmd exits
//       non-zero on it.
//   (1) completed <=> isFresh(record, fsState.returnStat) AND
//       validateReturn(record, fsState.returnText).ok (a 'blocked'-status
//       body still counts as completed — the STATUS enum is the worker's
//       own business, not this module's).
//   (2) timeout <=> now - Date.parse(record.created_at) > timeout_s * 1000
//       (wall clock from created_at, never per-invocation).
//   (3) crashed <=> exit sentinel present AND not completed (the caller's
//       await loop supplies the "after one rescan" cadence; this module is
//       stateless per call).
//   (4) attention <=> a turn-end observation plus a quiet timer, latched
//       once per attempt, DISABLED ENTIRELY when top or events are
//       unavailable.
//   (5) otherwise running.
//
// PINNED DECISION U-4: the .exit sentinel and .gate counter are
// worker-writable (G13) and NEVER decide completion in either direction —
// they may only add warnings.
// ---------------------------------------------------------------------------
export function classify({ record, fsState, tree, now, quietState, topIdle, quietS = 45 }) {
  const warnings = []

  if (record.outcome !== null && record.outcome !== undefined) {
    const terminalWarnings = []
    if (record.outcome === 'ok') {
      const { completed: corroborated } = evaluateCompletion(record, fsState)
      if (!corroborated) {
        terminalWarnings.push('terminal_outcome_uncorroborated')
      }
    }
    return { state: 'terminal', reason: `terminal:${record.outcome}`, warnings: terminalWarnings }
  }

  const { completed, fresh, validation } = evaluateCompletion(record, fsState)

  if (fsState && fsState.exitSentinel != null && fsState.exitSentinel !== '0') {
    warnings.push(`exit_nonzero:${fsState.exitSentinel} despite a valid return`)
  }

  if (completed) {
    // bodyStatus(validation.envelope) -> MF1: thread the worker's own
    // self-reported status onto the completed classification (WORKER_BLOCKED_STATUSES,
    // defined in contract.mjs, is the OUTCOME_MAPPING row's discriminator — never
    // the .exit sentinel, per U-4). markdown bodies are strings, not objects -> null.
    const body = validation.envelope && validation.envelope.body
    const bodyStatus = body && typeof body === 'object' && typeof body.status === 'string' ? body.status : null
    return { state: 'completed', reason: 'fresh_valid_return', warnings, bodyStatus }
  }

  const createdMs = Date.parse(record.created_at)
  if (now - createdMs > record.timeout_s * 1000) {
    return { state: 'timeout', reason: 'timeout_exceeded', warnings }
  }

  if (fsState && fsState.exitSentinel != null) {
    return { state: 'crashed', reason: buildIncompleteReason(fresh, validation), warnings }
  }

  if (isAttention({ now, quietState, topIdle, quietS })) {
    return { state: 'attention', reason: 'quiet_after_turn_end', warnings }
  }

  return { state: 'running', reason: buildIncompleteReason(fresh, validation), warnings }
}

// renderReturn(record, envelope) -> path written, tmp+rename. Runs only
// AFTER validation succeeds, only for kind 'markdown'. The path comes from
// resolve.mjs's renderPathFor() — the single derivation site — never
// re-derived here. Covered by no worker grant. (Discharges the
// parent-render half of A10.)
export function renderReturn(record, envelope) {
  if (record.return.kind !== 'markdown') {
    throw new Error(`renderReturn: record.return.kind must be markdown, got ${JSON.stringify(record.return.kind)}`)
  }
  if (typeof envelope.body !== 'string') {
    throw new Error('renderReturn: envelope.body must be a string for markdown kind')
  }
  const path = renderPathFor(record)
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmpPath, envelope.body, 'utf8')
  renameSync(tmpPath, path)
  return path
}

// ---------------------------------------------------------------------------
// RECOVERY_ROWS — ordered row names, shared vocabulary with be-1b-E. The
// first nine are 1a-frozen; the 10th (timeout_surface_alive) is 1b-owned
// (fix-round lifecycle S13 — call this out in the PR body per the interface
// table, row 10).
// ---------------------------------------------------------------------------
export const RECOVERY_ROWS = [
  'completed_surface_gone',
  'completed_surface_alive',
  'running_surface_alive',
  'crashed_surface_gone',
  'orphaned_surface_gone',
  'socket_unreachable',
  'partial_write_ignored',
  'gate_observe_reported',
  'rebuilt_from_disk',
  'timeout_surface_alive',
]

// paneAlive(tree, surface) — surface identity is the (workspace_id, pane_id,
// surface_id) TRIPLE, never pane_id alone (qa L-31: a pane_id collision
// across a different workspace_id is not-my-pane). tree mirrors cmuxctl.mjs's
// `cmux tree --json` shape: { windows: [{ workspaces: [{ id, panes: [{ id,
// surfaces: [{ id }] }] }] }] }.
function paneAlive(tree, surface) {
  if (!tree || !surface) return false
  for (const w of tree.windows || []) {
    for (const ws of w.workspaces || []) {
      if (ws.id !== surface.workspace_id) continue
      for (const p of ws.panes || []) {
        if (p.id !== surface.pane_id) continue
        for (const s of p.surfaces || []) {
          if (s.id === surface.surface_id) return true
        }
      }
    }
  }
  return false
}

// reconcile({ records, fsState, tree, now }) -> the nine-row recovery
// matrix. `fsState` is an object keyed by dispatch_id (each value produced
// by collectFsState). Every row's state is read from classify() on the same
// inputs rather than duplicating the completion predicate.
//
// out of scope: this function REPORTS; the CLI decides whether to
// re-dispatch. No cmux/git/process invocation happens here — tree and
// porcelain-derived flags (fsState[id].worktreeDirty) are parameters.
export function reconcile({ records, fsState, tree, now }) {
  if (tree === null) {
    return records.map((record) => {
      const result = classify({ record, fsState: fsState[record.dispatch_id], tree: null, now, quietState: null, topIdle: null })
      return {
        dispatch_id: record.dispatch_id,
        slice_id: record.slice_id,
        attempt: record.attempt,
        row: 'socket_unreachable',
        state: result.state,
        actions: [`${records.length} dispatches file-tracked`],
        warnings: result.warnings,
      }
    })
  }

  return records.map((record) => {
    const state = fsState[record.dispatch_id]
    const result = classify({ record, fsState: state, tree, now, quietState: null, topIdle: null })
    const surfaceAlive = record.surface ? paneAlive(tree, record.surface) : false
    const worktreeDirty = Boolean(state?.worktreeDirty)
    const gateAtMax = record.gate && state?.gateCounter != null && Number(state.gateCounter) >= record.gate.max_blocks

    let row
    let actions = []
    const warnings = [...result.warnings]

    // Fix-round lifecycle S11: a terminal record (outcome already set) is
    // reported straight from its own stored fields — never re-derived, and
    // never allowed to fall through to the orphan catch-all — so this
    // branch sits AHEAD of every other row, immediately after the two
    // completed rows would otherwise apply. (Reuses 'rebuilt_from_disk'
    // because a terminal record's report is, by construction, built purely
    // from what's on disk — no live surface/tree lookup can change it.)
    if (result.state === 'completed' && !surfaceAlive) {
      row = 'completed_surface_gone'
    } else if (result.state === 'completed' && surfaceAlive) {
      row = 'completed_surface_alive'
      actions = ['close_or_focus_per_policy']
    } else if (result.state === 'terminal') {
      row = 'rebuilt_from_disk'
    } else if (state?.partialWrite) {
      // Fix-round lifecycle S11: moved BELOW both completed rows and keyed
      // off fsState.partialWrite (set by collectFsState when return_path is
      // absent AND a <stem>.json*tmp* sibling exists) rather than the dead
      // returnPathKind === 'tmp' value collectFsState never produced. A
      // worker's own tmp+rename write is never visible under
      // record.return_path until the rename completes (qa L-13's
      // return-path-only read rule) — this row merely NAMES that transient
      // state for a caller that wants to distinguish it from orphaned.
      row = 'partial_write_ignored'
    } else if (result.state === 'timeout' && surfaceAlive) {
      // Fix-round lifecycle S13: an explicit branch ahead of
      // running_surface_alive — a timed-out dispatch with a live surface
      // must never be reported as running and re-armed.
      row = 'timeout_surface_alive'
      actions = ['report_only']
    } else if (result.state === 'crashed' && !surfaceAlive) {
      row = 'crashed_surface_gone'
      actions = ['offer_redispatch_new_dispatch_id_bumped_attempt']
      if (worktreeDirty) {
        warnings.push(`worktree has uncommitted changes from attempt ${record.attempt}`)
      }
    } else if (gateAtMax) {
      // Fix-round lifecycle S13: moved ABOVE the orphan catch-all so a
      // gate-at-max report is reachable regardless of surface liveness, not
      // only for surface-alive rows.
      row = 'gate_observe_reported'
      actions = ['report_gate_at_max']
    } else if (!surfaceAlive && result.state !== 'completed' && (state == null || state.exitSentinel == null)) {
      row = 'orphaned_surface_gone'
      actions = ['report_only']
    } else if (surfaceAlive) {
      row = 'running_surface_alive'
      actions = ['re_arm']
    } else {
      row = 'orphaned_surface_gone'
      actions = ['report_only']
    }

    return { dispatch_id: record.dispatch_id, slice_id: record.slice_id, attempt: record.attempt, row, state: result.state, actions, warnings }
  })
}

// ---------------------------------------------------------------------------
// evaluatePostcondition(profile, porcelainText) -> { ok, ignored, offending }
// Filters `git status --porcelain` lines against
// profile.postcondition_ignore (repo-relative globs, no leading '/', no
// '..'). 'clean' + any offending line => not ok (caller maps to outcome
// refused_postcondition). 'changes_expected' => dirt is expected. Every
// ignored line is returned so the caller can log it (v2:373 — an ignore
// must never hide silently).
// ---------------------------------------------------------------------------
export function evaluatePostcondition(profile, porcelainText) {
  const lines = (porcelainText || '').split('\n').filter((l) => l.length > 0)
  const ignoreRes = (profile.postcondition_ignore || []).map(globToRegExp)

  const ignored = []
  const offending = []
  for (const line of lines) {
    const relPath = porcelainPath(line)
    if (ignoreRes.some((re) => re.test(relPath))) {
      ignored.push(line)
    } else {
      offending.push(line)
    }
  }

  const ok = profile.postcondition === 'changes_expected' || offending.length === 0
  return { ok, ignored, offending }
}

// porcelain --porcelain=v1 format: 2 status chars, a space, then the path
// (renames use "old -> new"; the new path is the one that matters for an
// ignore glob).
function porcelainPath(line) {
  const rest = line.slice(3)
  const arrow = rest.indexOf(' -> ')
  return arrow === -1 ? rest : rest.slice(arrow + 4)
}

// Minimal glob -> RegExp: '**' matches across path separators, '*' does not.
function globToRegExp(glob) {
  let re = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 1
      } else {
        re += '[^/]*'
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}

// ---------------------------------------------------------------------------
// relaySignals(record, lines, state) -> { relay, recorded, dropped }
// enforcing SIGNAL_LIMITS: at most 5 relayed per dispatch, at least 30s
// apart, message truncated to 200 chars AT RELAY TIME (the schema's own
// write-time bound is 2000 — never "fixed" to match). Unknown level
// defaults to 'progress'. Malformed or over-limit lines are RECORDED but NOT
// relayed. A signal line is never completion evidence (qa L-25) — this
// function has no bearing on classify()'s verdict.
//
// `state` carries prior relay bookkeeping across calls: { relayedCount,
// lastRelayAt }. Both default to "nothing relayed yet".
// ---------------------------------------------------------------------------
export function relaySignals(record, lines, state = {}, now = Date.now()) {
  const relay = []
  const recorded = []
  const dropped = []
  let relayedCount = state.relayedCount || 0
  // Defense in depth: a persisted lastRelayAt carried over from a prior call
  // is ALSO clamped to `now` — even a caller that naively persisted a
  // poisoned raw ts can never re-import a baseline further in the future
  // than the current real time.
  const initialLastRelayMs = state.lastRelayAt ? Date.parse(state.lastRelayAt) : -Infinity
  let lastRelayMs = Number.isFinite(initialLastRelayMs) ? Math.min(initialLastRelayMs, now) : -Infinity

  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      dropped.push({ line, reason: 'malformed_json' })
      continue
    }

    const violations = validate(SIGNAL_SCHEMA, parsed)
    if (violations.length > 0) {
      recorded.push(parsed)
      dropped.push({ line, reason: 'schema_invalid' })
      continue
    }
    recorded.push(parsed)

    const level = SIGNAL_LEVELS.includes(parsed.level) ? parsed.level : 'progress'
    // Fix-round trust C3: a worker-supplied `ts` is advisory, never trusted
    // outright. A non-finite parse falls back to `now`. The CURRENT entry's
    // own eligibility is still judged against its own reported ts (so an
    // isolated forged entry relays once, same as any other single relay —
    // that is not itself the hazard), but the value STORED as the new
    // interval baseline is clamped to the parent-supplied `now` before
    // assignment — so a far-future ts can never become a baseline that
    // permanently outruns real time and suppresses relay of every LATER
    // legitimate signal for the rest of the dispatch's life.
    const parsedTsMs = Date.parse(parsed.ts)
    const tsMs = Number.isFinite(parsedTsMs) ? parsedTsMs : now

    if (relayedCount >= SIGNAL_LIMITS.max_relayed_per_dispatch) {
      dropped.push({ line, reason: 'relay_limit_reached' })
      continue
    }
    if (tsMs - lastRelayMs < SIGNAL_LIMITS.min_interval_s * 1000) {
      dropped.push({ line, reason: 'relay_interval_too_short' })
      continue
    }

    const message = parsed.message.slice(0, SIGNAL_LIMITS.message_max_chars)
    relay.push({ ...parsed, level, message })
    relayedCount += 1
    lastRelayMs = Math.min(tsMs, now)
  }

  return { relay, recorded, dropped }
}
