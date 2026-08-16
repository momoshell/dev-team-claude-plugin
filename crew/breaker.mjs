import { existsSync as realExistsSync } from 'node:fs'

import { NODE_FLOOR, openLedger as realOpenLedger } from '../scripts/factory/ledger.mjs'

export const BREAKER_ENV = Object.freeze({
  threshold: 'CREW_BREAKER_THRESHOLD',
  window_ms: 'CREW_BREAKER_WINDOW_MS',
})
export const DEFAULT_BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_BREAKER_WINDOW_MS = 8_640_000_000_000_000

function parseInteger(value, name, minimum, maximum = Infinity) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer >= ${minimum} (got ${JSON.stringify(value)})`)
  }
  return parsed
}

// A configured breaker is deliberately explicit: an empty threshold means no
// policy, while every other malformed value is a boot-time configuration error.
export function breakerPolicy(env = process.env) {
  const thresholdRaw = env?.[BREAKER_ENV.threshold]
  if (thresholdRaw === undefined || thresholdRaw === '') return null
  const threshold = parseInteger(thresholdRaw, BREAKER_ENV.threshold, 1)
  const windowRaw = env?.[BREAKER_ENV.window_ms]
  const window_ms = windowRaw === undefined
    ? DEFAULT_BREAKER_WINDOW_MS
    : parseInteger(windowRaw, BREAKER_ENV.window_ms, 1, MAX_BREAKER_WINDOW_MS)
  return { threshold, window_ms }
}

function versionAtLeast(value, floor) {
  const parse = (version) => {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/)
    return match ? match.slice(1).map(Number) : null
  }
  const actual = parse(value)
  const minimum = parse(floor)
  if (!actual || !minimum) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

function baseRecord(policy, since, verdict, why, cells, dbPath = undefined) {
  const record = {
    configured: true,
    threshold: policy.threshold,
    window_ms: policy.window_ms,
    since,
    verdict,
    why,
    cells,
  }
  // The public journal shape stays compact, but an unmeasurable verdict must
  // retain the path needed by assertCellsClosed's actionable refusal.
  if (dbPath !== undefined) Object.defineProperty(record, 'dbPath', { value: dbPath })
  return record
}

function unmeasurable(policy, since, dbPath, why) {
  return baseRecord(policy, since, 'unmeasurable', String(why || 'unknown ledger error'), [], dbPath)
}

function cellKey(provider, modelId, agent, effort) {
  return [provider, modelId, agent, effort].map((value) => String(value)).join('\u001f')
}

function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function compareCell(a, b) {
  for (const field of ['provider', 'model_id', 'agent', 'effort']) {
    const left = String(a[field])
    const right = String(b[field])
    const result = left.localeCompare(right)
    if (result !== 0) return result
  }
  return 0
}

function finishCell(cell, threshold) {
  const counted = Math.max(0, cell.countedRaw)
  const by_kind = Object.fromEntries(Object.entries(cell.byKind)
    .sort(([left], [right]) => left.localeCompare(right)))
  return {
    roles: [...cell.roles].sort((left, right) => String(left).localeCompare(String(right))),
    provider: cell.provider,
    model_id: cell.model_id,
    agent: cell.agent,
    effort: cell.effort,
    failures: cell.failures,
    run_less: cell.run_less,
    counted,
    by_kind,
    verdict: counted >= threshold ? 'open' : counted > 0 ? 'degraded' : 'closed',
  }
}

// Read the ledger only after the policy and applicability checks. A fresh
// install with no database is a measured zero; an existing but unreadable
// mirror is not an empty result and must fail closed.
export function cellHealth({
  policy,
  seats,
  dbPath,
  now = Date.now,
  openLedger = realOpenLedger,
  existsSync = realExistsSync,
  nodeVersion = process.versions.node,
  stderr = { write() {} },
} = {}) {
  if (policy == null) return null

  const since = new Date(now() - policy.window_ms).toISOString()
  if (seats == null) {
    return baseRecord(policy, since, 'not-applicable', 'no roster cells (--roles boot)', [])
  }
  if (!versionAtLeast(nodeVersion, NODE_FLOOR)) {
    return unmeasurable(policy, since, dbPath,
      `node ${nodeVersion} is below NODE_FLOOR ${NODE_FLOOR}`)
  }

  let present
  try {
    present = existsSync(dbPath)
  } catch (err) {
    return unmeasurable(policy, since, dbPath, `ledger database existence check failed: ${err?.message || String(err)}`)
  }
  if (!present) return baseRecord(policy, since, 'closed', null, [])

  let handle = null
  let rows
  try {
    handle = openLedger({ dbPath, stderr })
    rows = handle.cellFailures({ since })
    // openLedger decides degradation lazily, so both checks intentionally come
    // after the real query rather than before it.
    const degraded = handle.degraded
    const mirrorErrors = Number(handle.stats()?.mirror_errors || 0)
    if (degraded || mirrorErrors > 0) {
      const reasons = []
      if (degraded) reasons.push('ledger handle reported degraded')
      if (mirrorErrors > 0) reasons.push(`ledger reported ${mirrorErrors} mirror error(s)`)
      return unmeasurable(policy, since, dbPath, reasons.join('; '))
    }
  } catch (err) {
    return unmeasurable(policy, since, dbPath, `ledger read failed: ${err?.message || String(err)}`)
  } finally {
    try { handle?.close?.() } catch { /* an already unreadable mirror stays unreadable */ }
  }

  const seated = new Map()
  for (const [role, seat] of Object.entries(seats)) {
    if (seat?.provider == null || seat?.id == null) continue
    const key = cellKey(seat.provider, seat.id, seat.agent, seat.effort)
    let cell = seated.get(key)
    if (!cell) {
      cell = {
        roles: [], provider: seat.provider, model_id: seat.id,
        agent: seat.agent, effort: seat.effort,
        failures: 0, run_less: 0, countedRaw: 0, byKind: {},
      }
      seated.set(key, cell)
    }
    cell.roles.push(role)
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue
    const cell = seated.get(cellKey(row.provider, row.model_id, row.agent, row.effort))
    if (!cell) continue
    const failures = numberValue(row.failures)
    const runLess = numberValue(row.run_less)
    const counted = failures - runLess
    cell.failures += failures
    cell.run_less += runLess
    cell.countedRaw += counted
    const kind = String(row.kind)
    cell.byKind[kind] = (cell.byKind[kind] || 0) + counted
  }

  const cells = [...seated.values()]
    .map((cell) => finishCell(cell, policy.threshold))
    .sort(compareCell)
  const verdict = cells.some((cell) => cell.verdict === 'open')
    ? 'open'
    : cells.some((cell) => cell.verdict === 'degraded') ? 'degraded' : 'closed'
  return baseRecord(policy, since, verdict, null, cells)
}

function breakerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function windowLabel(windowMs) {
  const hours = windowMs / (60 * 60 * 1000)
  if (Number.isInteger(hours)) return `${hours}h`
  const minutes = windowMs / (60 * 1000)
  if (Number.isInteger(minutes)) return `${minutes}m`
  return `${windowMs}ms`
}

// Null and non-open verdicts are deliberately no-ops. The caller invokes this
// after every boot health read, including unconfigured and not-applicable ones.
export function assertCellsClosed(record) {
  if (!record || record.verdict === 'closed' || record.verdict === 'degraded' || record.verdict === 'not-applicable') return

  if (record.verdict === 'unmeasurable') {
    throw breakerError(
      'breaker-unmeasurable',
      `cell breaker: a threshold of ${record.threshold} failures per cell in the last ${windowLabel(record.window_ms)} (window_ms=${record.window_ms}) is set but the ledger at ${record.dbPath ?? '<unknown path>'} could not be read (${record.why || 'unknown reason'}) — refusing to boot a crew whose cell health cannot be measured (repair the ledger, or unset CREW_BREAKER_THRESHOLD).`,
    )
  }

  if (record.verdict !== 'open') return
  const openCells = (record.cells || []).filter((cell) => cell.verdict === 'open')
  const details = openCells.map((cell) =>
    `${cell.provider}/${cell.model_id} agent=${cell.agent} effort=${cell.effort} roles=${cell.roles.join(',')} `
    + `counted=${cell.counted} threshold=${record.threshold} window_ms=${record.window_ms} (${windowLabel(record.window_ms)}) `
    + `since=${record.since} by_kind=${JSON.stringify(cell.by_kind)} run_less=${cell.run_less} (run-less rows are excluded from the count)`
  ).join('; ')
  throw breakerError(
    'breaker-open',
    `cell breaker: open cell(s): ${details} — refusing to boot this crew; remediate with --model-<role>, --agent-<role>, or --tier (or wait for the window to roll off).`,
  )
}
