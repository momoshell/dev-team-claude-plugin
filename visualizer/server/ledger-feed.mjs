// Read-only ledger Feed implementation. node:sqlite is loaded lazily so this
// module can be imported on older Node versions and report a degraded feed.
import { createRequire } from 'node:module'
import { createTriage } from './triage.mjs'
import { shapeRun, matchesFilters } from './shape.mjs'

const require = createRequire(import.meta.url)
const OPTIONAL_COLUMNS = { sessions: ['mode', 'engineer'] }

export function createLedgerFeed({ ledgerDb, triageDb } = {}) {
  let db = null
  let degraded = false
  let degradedReason = null
  let closed = false
  const probe = { missing: [...OPTIONAL_COLUMNS.sessions], latched: false, probes: 0 }
  let json1 = null
  const triage = createTriage({ ledgerDb, triageDb })

  function open() {
    if (db || degraded || closed) return db
    try {
      const { DatabaseSync } = require('node:sqlite')
      db = new DatabaseSync(ledgerDb, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      return db
    } catch (err) {
      degraded = true
      degradedReason = err?.message || String(err)
      return null
    }
  }
  function probeColumns() {
    const handle = open()
    if (!handle || probe.latched) return
    probe.probes += 1
    try {
      const names = new Set(handle.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name))
      probe.missing = OPTIONAL_COLUMNS.sessions.filter((name) => !names.has(name))
      if (!probe.missing.length) probe.latched = true
    } catch (err) { degradedReason = err?.message || String(err) }
  }
  function listRuns(filters = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { runs: [], degraded: true, probe: { ...probe } }
    const where = [], args = []
    if (filters.status) { where.push('status = ?'); args.push(filters.status) }
    if (filters.since) { where.push('started_at >= ?'); args.push(filters.since) }
    if (filters.until) { where.push('started_at < ?'); args.push(filters.until) }
    const sql = `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC`
    const sessions = handle.prepare(sql).all(...args)
    const ids = sessions.map((row) => row.adw_id)
    if (!ids.length) return { runs: [], degraded, probe: { ...probe } }
    const marks = ids.map(() => '?').join(',')
    const phases = handle.prepare(`SELECT * FROM phases WHERE adw_id IN (${marks}) ORDER BY adw_id, seq`).all(...ids)
    const agents = handle.prepare(`SELECT id, adw_id, type, phase_id, payload_json, started_at, ended_at FROM events WHERE adw_id IN (${marks}) AND type IN ('agent_start','agent_end') ORDER BY id`).all(...ids)
    const phaseMap = new Map(), eventMap = new Map()
    for (const id of ids) { phaseMap.set(id, []); eventMap.set(id, []) }
    for (const row of phases) phaseMap.get(row.adw_id)?.push(row)
    for (const row of agents) eventMap.get(row.adw_id)?.push(row)
    const triageRows = triage.readTriage(ids)
    const now = Date.now()
    const runs = sessions.map((session) => shapeRun(session, phaseMap.get(session.adw_id), eventMap.get(session.adw_id), triageRows.get(session.adw_id), probe, now)).filter((run) => matchesFilters(run, filters))
    return { runs, degraded: degraded || triage.health().degraded, probe: { ...probe } }
  }
  function listEvents({ adw_id, after = 0, limit = 200, type, role, phase_id } = {}) {
    const handle = open()
    if (!handle) return { events: [], cursor: after }
    const filters = type != null || role != null || phase_id != null
    const where = ['adw_id = ?', 'id > ?'], args = [adw_id, after], unsupported_filters = []
    if (type != null) { where.push('type = ?'); args.push(type) }
    if (phase_id != null) { where.push('phase_id = ?'); args.push(phase_id) }
    if (role != null) {
      if (json1 === null) {
        try { handle.prepare(`SELECT json_extract('{"a":1}','$.a') AS value`).get(); json1 = true } catch { json1 = false }
      }
      if (json1) { where.push("json_extract(payload_json,'$.role') = ?"); args.push(role) } else unsupported_filters.push('role')
    }
    const events = handle.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...args, limit)
    if (!filters) return { events, cursor: events.length ? events[events.length - 1].id : after }
    const max = handle.prepare('SELECT max(id) AS max_id FROM events WHERE adw_id = ?').get(adw_id)?.max_id
    return { events, cursor: events.length === limit ? events.at(-1).id : (max ?? after), ...(unsupported_filters.length ? { unsupported_filters } : {}) }
  }
  function health() {
    probeColumns()
    const triageHealth = triage.health()
    return { degraded: degraded || triageHealth.degraded, ledger_db: ledgerDb, triage_db: triageHealth.path, readonly: true, probe: { ...probe } }
  }
  return {
    listRuns,
    listEvents,
    setTriage: (input) => triage.setTriage(input),
    health,
    close: () => { closed = true; if (db) { try { db.close() } catch {} db = null }; triage.close() },
    _probe: probe,
    _reason: () => degradedReason,
  }
}
