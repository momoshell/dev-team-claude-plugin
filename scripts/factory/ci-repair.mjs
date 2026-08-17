#!/usr/bin/env node
// scripts/factory/ci-repair.mjs — the bounded repair half of the CI loop.
// The watch remains dispatch-free; this module is the only host-side surface
// that may hand a recorded, reproduced failure to the warm repair crew.
//
// REQUIRES A RATIFIED PROFILE
// Every repair cycle uses one ciShape resolved before the loop. Profile
// refusals are named by PROFILE_REFUSALS and never fall back to guessed lanes.

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ciShape, ciWatchRun } from './ci-watch.mjs'
import { openLedger } from './ledger.mjs'
import { recordCiDispatch as emitRecordCiDispatch } from './emit.mjs'
import { BriefUsageError, renderBrief, validateRequest, verifyWhere } from './make-brief.mjs'

export const MAX_CYCLES = 2
export const MAX_DISPATCHES = 1
export const DISPATCH_OUTCOMES = Object.freeze(['done', 'escalation', 'converge', 'refused', 'unreadable'])
export const REFUSAL_REASONS = Object.freeze([
  'worker-path', 'crew-dir-missing', 'bound-reached', 'bound-unverifiable',
  'scope-uninheritable', 'scope-forbidden', 'brief-refused',
])
export const FORBIDDEN_SCOPE_PREFIXES = Object.freeze(['.github/workflows/'])

function fsDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    mkdirSync: deps.mkdirSync || fsMkdirSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    statSync: deps.statSync || fsStatSync,
    writeFileSync: deps.writeFileSync || fsWriteFileSync,
  }
}

function textFromFile(d, path) {
  return String(d.readFileSync(path, 'utf8'))
}

function readJson(d, path) {
  try {
    return JSON.parse(textFromFile(d, path))
  } catch {
    return null
  }
}

function scopeFiles(scope) {
  if (Array.isArray(scope)) return scope
  if (scope && Array.isArray(scope.files)) return scope.files
  return []
}

function normalScopePath(entry) {
  return String(entry).replaceAll('\\', '/')
}

function isForbiddenScopePath(entry) {
  const normal = normalScopePath(entry).replace(/^\.\//, '')
  return FORBIDDEN_SCOPE_PREFIXES.some((prefix) => (
    normal === prefix.slice(0, -1) || normal.startsWith(prefix)
  ))
}

function validLiteralScopeEntry(entry, checkout, d) {
  if (typeof entry !== 'string' || entry.trim().length === 0) return false
  if (entry.includes('\\') || entry.includes('\0')) return false
  if (isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith('/')) return false
  if (/[?*\[\]{}]/.test(entry)) return false
  const normal = normalScopePath(entry)
  const segments = normal.split('/')
  if (segments.some((segment) => segment === '..')) return false
  const absolute = resolve(checkout, entry)
  const rel = relative(resolve(checkout), absolute).split(sep).join('/')
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return false
  try {
    if (!d.existsSync(absolute)) return false
    const stat = d.statSync(absolute)
    if (normal.endsWith('/') && !stat.isDirectory()) return false
    return stat.isFile() || stat.isDirectory()
  } catch {
    return false
  }
}

function scopeResult(ok, files, source, why = null) {
  return { ok, files, source, why }
}

export function inheritScope({ crewDir, checkout = process.cwd(), deps = {} } = {}) {
  const d = fsDeps(deps)
  const root = resolve(checkout || process.cwd())
  const dir = typeof crewDir === 'string' && crewDir.trim() ? resolve(crewDir) : null
  if (!dir) return scopeResult(false, [], null, 'scope-uninheritable')
  const envelopePath = join(dir, 'returns', 'task.json')
  const envelope = d.existsSync(envelopePath) ? readJson(d, envelopePath) : null
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !envelope.details || typeof envelope.details !== 'object') {
    return scopeResult(false, [], null, 'scope-uninheritable')
  }
  const details = envelope.details
  const hasForwardScope = Object.prototype.hasOwnProperty.call(details, 'files_in_scope')
  const source = hasForwardScope ? 'files_in_scope' : 'files_committed'
  const files = hasForwardScope ? details.files_in_scope : details.files_committed
  if (!Array.isArray(files) || files.length === 0) return scopeResult(false, [], source, 'scope-uninheritable')

  // A forbidden directory is a refusal of the whole inherited scope, even if
  // another entry in the same envelope would otherwise be valid.
  if (files.some((entry) => typeof entry === 'string' && isForbiddenScopePath(entry))) {
    return scopeResult(false, [], source, 'scope-forbidden')
  }
  if (files.some((entry) => !validLiteralScopeEntry(entry, root, d))) {
    return scopeResult(false, [], source, 'scope-uninheritable')
  }
  return scopeResult(true, [...files], source, null)
}

export function dispatchAllowed(input = {}) {
  const { cycle, priorDispatches, ledgerReadable } = input && typeof input === 'object' ? input : {}
  if (ledgerReadable !== true) return { ok: false, why: 'bound-unverifiable' }
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > MAX_CYCLES) {
    return { ok: false, why: 'bound-reached' }
  }
  if (!Number.isInteger(priorDispatches) || priorDispatches < 0 || priorDispatches >= MAX_DISPATCHES) {
    return { ok: false, why: 'bound-reached' }
  }
  return { ok: true, why: null }
}

function failureTitle(excerpt) {
  const lines = String(excerpt || '').split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*not ok \d+ - (.+?)\s*$/)
    if (match) return match[1]
  }
  return 'the recorded check failure'
}

function display(value, fallback = 'null') {
  return value == null ? fallback : String(value)
}

export function repairRequest({ cycle, row = {}, scope } = {}) {
  const files = scopeFiles(scope)
  const check = display(row.check_name, 'recorded check')
  const branch = display(row.branch, 'recorded branch')
  const excerpt = row.excerpt == null ? '' : String(row.excerpt)
  const source = display(row.excerpt_source, 'unknown')
  const lane = display(row.local_lane, '(local lane not run)')
  const exit = display(row.local_exit)
  return {
    ask: `Fix the ${check} failure on ${branch}: ${failureTitle(excerpt)}`,
    where: [...files],
    done_means: [
      `Check: ${check}`,
      `Branch: ${branch}`,
      `Head sha: ${display(row.head_sha)}`,
      `Recorded failure (${source}):`,
      '```',
      excerpt,
      '```',
      `Local lane: ${lane}`,
      `Local exit: ${exit}`,
      `Repair cycle: ${display(cycle)}`,
    ].join('\n'),
    out_of_scope: 'Never edit .github/workflows/ or an acceptance gate to make CI green; never widen the inherited scope (a wider surface is an escalation, not a re-plan); this shape declares sources: {scope:\'inherited\', lane:\'ctx\', gate:\'none\'}, so there is no plan round, no revision and no acceptance gate; one repair cycle only.',
  }
}

export function compileRepairBrief({ cycle, row, scope, crew, checkout = null, crewDir, deps = {} } = {}) {
  const d = fsDeps(deps)
  const files = scopeFiles(scope)
  const request = repairRequest({ cycle, row, scope: files })
  try {
    validateRequest(request, { taskName: crew?.task })
    const targetCheckout = resolve(checkout || crew?.checkout || process.cwd())
    const where = verifyWhere({ checkout: targetCheckout, where: request.where })
    const bytes = renderBrief({
      request,
      where,
      discovery: { candidates: [], tripwires: [], broadKeys: [] },
      baseline: {
        lane: row?.local_lane,
        pass: null,
        fail: null,
        status: 'red',
        reason: 'inherited from the failing run',
      },
      writeSurface: {
        lane: crew?.task,
        basis: 'fences',
        files: [...files],
      },
    })
    const taskDir = join(resolve(crewDir), 'task')
    if (!d.existsSync(taskDir)) d.mkdirSync(taskDir, { recursive: true })
    const path = join(taskDir, `ci-repair-cycle-${cycle}.md`)
    d.writeFileSync(path, bytes)
    return { ok: true, path, bytes, why: null }
  } catch (err) {
    if (err instanceof BriefUsageError || err?.name === 'BriefUsageError') {
      return { ok: false, path: null, bytes: null, why: `brief-refused: ${err.reason || 'usage'}` }
    }
    return { ok: false, path: null, bytes: null, why: `brief-refused: ${err?.message || String(err)}` }
  }
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Crew logs may precede the one JSON result line.
    }
  }
  return null
}

function outcomeForStatus(status) {
  if (status === 'done') return 'done'
  if (status === 'escalation') return 'escalation'
  if (status === 'converge' || status === 'converged') return 'converge'
  return null
}

function returnCandidates({ line, crew, crewDir, checkout }) {
  const values = []
  if (typeof line?.task_return === 'string' && line.task_return.trim()) values.push(line.task_return)
  if (typeof crew?.task_return === 'string' && crew.task_return.trim()) values.push(crew.task_return)
  if (crewDir) values.push(join(crewDir, 'returns', 'task.json'))
  const seen = new Set()
  return values.map((value) => {
    const candidate = isAbsolute(value) ? value : resolve(crewDir || checkout, value)
    return candidate
  }).filter((candidate) => {
    if (seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

export function dispatchRepair({ cycle, briefPath, crew, crewDir, checkout = null, row, lane, deps = {} } = {}) {
  const d = { spawnSync: deps.spawnSync || cpSpawnSync, ...fsDeps(deps) }
  const root = resolve(checkout || crew?.checkout || process.cwd())
  const laneValue = row?.local_lane || lane
  if (typeof laneValue !== 'string' || laneValue.trim().length === 0) {
    return {
      outcome: 'unreadable', exit: null, commit: null, escalation: null, task_return: null,
      why: 'dispatch-unreadable: lane unresolved',
    }
  }
  const argv = [
    process.execPath,
    join(root, 'crew', 'crew.mjs'),
    'run',
    '--task', crew?.task,
    '--checkout', root,
    '--brief-file', briefPath,
    '--variant', 'repair',
    '--lane', laneValue,
    '--keep',
  ]
  let result
  try {
    result = d.spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' })
  } catch (err) {
    return {
      outcome: 'unreadable', exit: null, commit: null, escalation: null, task_return: null,
      why: `dispatch-unreadable: ${err?.message || String(err)}`,
    }
  }
  const exit = result?.status ?? null
  const line = lastJsonLine(result?.stdout)
  const candidates = returnCandidates({ line, crew, crewDir, checkout: root })
  if (result?.error) {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? null, escalation: null,
      task_return: candidates[0] || null,
      why: `dispatch-unreadable: ${result.error.message || result.error}`,
    }
  }
  const lineOutcome = outcomeForStatus(line?.status)
  // A preflight failure prints an {error: ...} line and leaves the previous
  // settled envelope in place. Never let that old envelope masquerade as the
  // result of this spawn: the result line must itself carry a known crew
  // status, and its exit code must agree with that status.
  if (!lineOutcome) {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? null, escalation: null,
      task_return: candidates[0] || null,
      why: 'dispatch-unreadable: invalid-dispatch-result',
    }
  }
  if (!Number.isInteger(exit) || (lineOutcome === 'done' ? exit !== 0 : exit === 0)) {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? null, escalation: null,
      task_return: candidates[0] || null,
      why: 'dispatch-unreadable: status-exit-mismatch',
    }
  }
  let envelope = null
  let taskReturn = null
  try {
    for (const candidate of candidates) {
      if (!d.existsSync(candidate)) continue
      const value = readJson(d, candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        envelope = value
        taskReturn = candidate
        break
      }
    }
  } catch (err) {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? null, escalation: null,
      task_return: candidates[0] || null,
      why: `dispatch-unreadable: ${err?.message || String(err)}`,
    }
  }
  if (!envelope || typeof envelope.status !== 'string') {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? null, escalation: null,
      task_return: taskReturn || candidates[0] || null,
      why: 'dispatch-unreadable: task-return-unreadable',
    }
  }
  const status = outcomeForStatus(envelope.status)
  if (!status || status !== lineOutcome) {
    return {
      outcome: 'unreadable', exit, commit: line?.commit ?? envelope.details?.commit ?? null,
      escalation: null, task_return: taskReturn, why: 'dispatch-unreadable: status-envelope-mismatch',
    }
  }
  const escalation = status === 'escalation' && envelope.details?.escalation
    && typeof envelope.details.escalation === 'object'
    ? {
      where: envelope.details.escalation.where,
      why: envelope.details.escalation.why,
    }
    : null
  return {
    outcome: status,
    exit,
    commit: line?.commit ?? envelope.details?.commit ?? null,
    escalation,
    task_return: taskReturn,
    why: status === 'escalation' ? (escalation?.why || 'driver escalation') : null,
  }
}

function parkDispatch(dispatch, briefPath) {
  if (!dispatch) return null
  return {
    outcome: dispatch.outcome ?? null,
    exit: dispatch.exit ?? null,
    escalation: dispatch.escalation ?? null,
    task_return: dispatch.task_return ?? null,
    brief_path: briefPath ?? null,
  }
}

export function parkRecord({ crew, crewDir, row = {}, cycle, why, dispatch = null, briefPath = null, deps = {} } = {}) {
  const d = fsDeps(deps)
  const path = typeof crewDir === 'string' && crewDir.trim()
    ? join(resolve(crewDir), 'task', `ci-park-cycle-${cycle}.json`)
    : null
  const effectiveWhy = why || dispatch?.escalation?.why || dispatch?.why || row.reason || 'recorded CI failure'
  const record = {
    schema: 1,
    task: crew?.task ?? null,
    branch: row.branch ?? null,
    head_sha: row.head_sha ?? null,
    check_name: row.check_name ?? null,
    cycle,
    cycles_bound: MAX_CYCLES,
    dispatches_bound: MAX_DISPATCHES,
    classification: row.classification ?? null,
    decision: row.decision ?? null,
    reason: row.reason ?? null,
    why: effectiveWhy,
    excerpt: row.excerpt ?? null,
    excerpt_source: row.excerpt_source ?? null,
    local_lane: row.local_lane ?? null,
    local_exit: row.local_exit ?? null,
    dispatch: parkDispatch(dispatch, briefPath),
    residuals: [{
      id: `ci-red-cycle-${cycle}`,
      severity: 'must-fix',
      summary: `${row.check_name || 'CI check'} remains red at cycle ${cycle}: ${effectiveWhy}`,
    }],
    next: 'human',
  }
  if (!path) return { ok: false, path: null, record, why: 'crew-dir-missing' }
  try {
    const taskDir = join(resolve(crewDir), 'task')
    if (!d.existsSync(taskDir)) d.mkdirSync(taskDir, { recursive: true })
    d.writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
    return { ok: true, path, record, why: null }
  } catch (err) {
    return { ok: false, path, record, why: `park-write-failed: ${err?.message || String(err)}` }
  }
}

function crewIdentity(crewDir, d) {
  if (!crewDir) return null
  try {
    const path = join(crewDir, 'crew.json')
    if (!d.existsSync(path)) return null
    const value = readJson(d, path)
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.task !== 'string' || !value.task.trim()) return null
    return value
  } catch {
    return null
  }
}

function ledgerState({ dbPath, branch, task, deps = {} } = {}) {
  if (!dbPath) return { readable: false, priorDispatches: 0 }
  const open = deps.openLedger || openLedger
  let ledger = null
  try {
    ledger = open({
      dbPath,
      nodeVersion: deps.nodeVersion,
      stderr: deps.stderr || { write() {} },
    })
    const stats = typeof ledger.stats === 'function' ? ledger.stats() : null
    if (stats?.degraded === true) return { readable: false, priorDispatches: 0 }
    const rows = ledger.dumpTable('ci_dispatches')
    const after = typeof ledger.stats === 'function' ? ledger.stats() : stats
    if (after?.degraded === true || Number(after?.mirror_errors || 0) > 0) {
      return { readable: false, priorDispatches: 0 }
    }
    const matching = Array.isArray(rows) ? rows.filter((row) => (
      row.branch === branch && row.task_slug === task && row.variant === 'repair'
    )) : null
    if (!matching) return { readable: false, priorDispatches: 0 }
    const priorDispatches = matching.filter((row) => row.outcome !== 'refused').length
    return { readable: true, priorDispatches }
  } catch {
    return { readable: false, priorDispatches: 0 }
  } finally {
    try { ledger?.close?.() } catch { /* instrumentation read is best effort */ }
  }
}

function dispatchLedgerRow({ row, crew, repoSlug, dispatch, outcome, reason, briefPath, scope, parkPath, dbPath, deps }) {
  const escalationReason = dispatch?.escalation
    ? JSON.stringify({ where: dispatch.escalation.where, why: dispatch.escalation.why })
    : null
  const fields = {
    adw_id: row.adw_id ?? null,
    task_slug: crew?.task ?? null,
    repo_slug: repoSlug ?? null,
    branch: row.branch,
    head_sha: row.head_sha,
    check_name: row.check_name,
    cycle: row.cycle,
    variant: 'repair',
    outcome,
    reason: escalationReason || reason || dispatch?.why || null,
    commit: dispatch?.commit ?? null,
    brief_path: briefPath ?? null,
    scope_source: scope?.source ?? null,
    scope_count: scope && Array.isArray(scope.files) ? scope.files.length : null,
    task_return: dispatch?.task_return ?? crew?.task_return ?? null,
    park_path: parkPath ?? null,
    exit_code: dispatch?.exit ?? null,
    created_at: row.created_at,
  }
  let recorded = false
  try {
    recorded = emitRecordCiDispatch({
      dbPath,
      stderr: deps.stderr,
      _openLedger: deps.openLedger,
      ...fields,
    })
  } catch {
    recorded = false
  }
  return {
    ...fields,
    exit: dispatch?.exit ?? null,
    why: dispatch?.why || reason || null,
    escalation: dispatch?.escalation ?? null,
    recorded,
  }
}

function resultBase(cycles, dispatches, parked, reason, ok = false) {
  return { ok, cycles, dispatches, parked, reason }
}

export function ciRepairRun({ checkout = null, branch, crewDir = null, dbPath = null, crewRoot, profilePath, repoKey, factoryRoot, deps = {} } = {}) {
  const d = fsDeps(deps)
  const rawDeps = { ...deps, ...d }
  const resolvedCrewDir = typeof crewDir === 'string' && crewDir.trim() ? resolve(crewDir) : null
  // Resolve the crew before the first watch: a missing identity parks a repair
  // decision, but it must never prevent the watch from recording its cycle.
  const crew = crewIdentity(resolvedCrewDir, d)
  const root = resolve(checkout || crew?.checkout || process.cwd())
  const shape = ciShape({ checkout: root, profilePath, repoKey, factoryRoot, deps: rawDeps })
  if (!shape.ok) {
    return {
      ...resultBase([], [], null, shape.reason, false),
      profilePath: shape.profilePath ?? null,
    }
  }
  const finish = (cycles, dispatches, parked, reason, ok = false) => ({
    ...resultBase(cycles, dispatches, parked, reason, ok),
    profilePath: shape.profilePath ?? null,
  })
  const taskSlug = crew?.task ?? null
  const repoSlug = crew?.repo_slug ?? null
  const cycles = []
  const dispatches = []

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
    const watched = ciWatchRun({
      checkout: root,
      branch,
      cycle,
      dbPath,
      crewRoot,
      taskSlug,
      repoSlug,
      shape,
      deps: rawDeps,
    })
    if (!watched.ok) {
      return finish(cycles, dispatches, null, watched.reason, false)
    }
    cycles.push(...watched.cycles)
    if (watched.cycles.length === 0) return finish(cycles, dispatches, null, watched.reason || 'watch-empty', false)
    if (watched.cycles.every((row) => row.decision === 'none')) {
      return finish(cycles, dispatches, null, null, true)
    }
    const parkingRow = watched.cycles.find((row) => row.decision === 'park')
    if (parkingRow) {
      const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row: parkingRow, cycle, deps: rawDeps })
      return finish(cycles, dispatches, parked, parked.why || parkingRow.reason, false)
    }
    const row = watched.cycles.find((candidate) => candidate.decision === 'repair')
    if (!row) return finish(cycles, dispatches, null, 'watch-unadjudicable', false)

    if (!crew) {
      const refusal = { outcome: 'refused', exit: null, commit: null, escalation: null, task_return: null, why: 'crew-dir-missing' }
      const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row, cycle, why: refusal.why, deps: rawDeps })
      const event = dispatchLedgerRow({
        row, crew, repoSlug, dispatch: refusal, outcome: refusal.outcome, reason: refusal.why,
        briefPath: null, scope: null, parkPath: parked.path, dbPath, deps,
      })
      dispatches.push(event)
      return finish(cycles, dispatches, parked, refusal.why, false)
    }

    const ledger = ledgerState({ dbPath, branch: row.branch, task: crew.task, deps })
    const allowed = dispatchAllowed({
      cycle,
      priorDispatches: ledger.priorDispatches,
      ledgerReadable: ledger.readable,
    })
    if (!allowed.ok) {
      const refusal = { outcome: 'refused', exit: null, commit: null, escalation: null, task_return: crew.task_return ?? null, why: allowed.why }
      const parkWhy = cycle === MAX_CYCLES && allowed.why === 'bound-reached' ? 'cycle-bound-reached' : allowed.why
      const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row, cycle, why: parkWhy, deps: rawDeps })
      const event = dispatchLedgerRow({
        row, crew, repoSlug, dispatch: refusal, outcome: refusal.outcome, reason: allowed.why,
        briefPath: null, scope: null, parkPath: parked.path, dbPath, deps,
      })
      dispatches.push(event)
      return finish(cycles, dispatches, parked, parkWhy, false)
    }

    const scope = inheritScope({ crewDir: resolvedCrewDir, checkout: root, deps: rawDeps })
    if (!scope.ok) {
      const refusal = { outcome: 'refused', exit: null, commit: null, escalation: null, task_return: crew.task_return ?? null, why: scope.why }
      const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row, cycle, why: scope.why, deps: rawDeps })
      const event = dispatchLedgerRow({
        row, crew, repoSlug, dispatch: refusal, outcome: refusal.outcome, reason: scope.why,
        briefPath: null, scope, parkPath: parked.path, dbPath, deps,
      })
      dispatches.push(event)
      return finish(cycles, dispatches, parked, scope.why, false)
    }

    const brief = compileRepairBrief({
      cycle, row, scope, crew, checkout: root, crewDir: resolvedCrewDir, deps: rawDeps,
    })
    if (!brief.ok) {
      const refusal = { outcome: 'refused', exit: null, commit: null, escalation: null, task_return: crew.task_return ?? null, why: 'brief-refused' }
      const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row, cycle, why: brief.why, deps: rawDeps })
      const event = dispatchLedgerRow({
        row, crew, repoSlug, dispatch: refusal, outcome: refusal.outcome, reason: 'brief-refused',
        briefPath: null, scope, parkPath: parked.path, dbPath, deps,
      })
      dispatches.push(event)
      return finish(cycles, dispatches, parked, brief.why, false)
    }

    const dispatch = dispatchRepair({
      cycle, briefPath: brief.path, crew, crewDir: resolvedCrewDir, checkout: root, row,
      lane: shape.laneLabel, deps: rawDeps,
    })
    if (dispatch.outcome === 'escalation' || dispatch.outcome === 'unreadable') {
      const parked = parkRecord({
        crew, crewDir: resolvedCrewDir, row, cycle, dispatch, briefPath: brief.path,
        why: dispatch.escalation?.why || dispatch.why, deps: rawDeps,
      })
      const event = dispatchLedgerRow({
        row, crew, repoSlug, dispatch, outcome: dispatch.outcome, reason: dispatch.why,
        briefPath: brief.path, scope, parkPath: parked.path, dbPath, deps,
      })
      dispatches.push(event)
      return finish(cycles, dispatches, parked, dispatch.why, false)
    }
    const event = dispatchLedgerRow({
      row, crew, repoSlug, dispatch, outcome: dispatch.outcome, reason: dispatch.why,
      briefPath: brief.path, scope, parkPath: null, dbPath, deps,
    })
    dispatches.push(event)
  }

  const row = cycles[cycles.length - 1] || null
  if (row) {
    const parked = parkRecord({ crew, crewDir: resolvedCrewDir, row, cycle: MAX_CYCLES, why: 'cycle-bound-reached', deps: rawDeps })
    return finish(cycles, dispatches, parked, 'cycle-bound-reached', false)
  }
  return finish(cycles, dispatches, null, 'cycle-bound-reached', false)
}
