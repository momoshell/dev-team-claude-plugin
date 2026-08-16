// Read-only ledger Feed implementation. node:sqlite is loaded lazily so this
// module can be imported on older Node versions and report a degraded feed.
import { createRequire } from 'node:module'
import { createTriage } from './triage.mjs'
import { shapeRun, matchesFilters } from './shape.mjs'

const require = createRequire(import.meta.url)
const OPTIONAL_COLUMNS = { sessions: ['mode', 'engineer'] }
const OPTIONAL_TABLES = ['agent_sessions', 'gate_discriminations', 'review_outcomes', 'accept_decisions', 'cell_failures']
// Which shape fields a missing table makes unknowable. Feeding these into the
// probe reuses #48's NULL-probe path (shape.mjs) instead of inventing a second
// mechanism for the same idea.
const TABLE_FIELDS = {
  agent_sessions: ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens'],
  gate_discriminations: ['gate_discrimination', 'gate_generations'],
  review_outcomes: ['reviews'],
  accept_decisions: ['accept_decisions'],
}

export function createLedgerFeed({ ledgerDb, triageDb } = {}) {
  let db = null
  let degraded = false
  let degradedReason = null
  let closed = false
  const probe = { missing: [...OPTIONAL_COLUMNS.sessions], missing_tables: [...OPTIONAL_TABLES], latched: false, probes: 0 }
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
      const tables = new Set(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
      probe.missing = OPTIONAL_COLUMNS.sessions.filter((name) => !names.has(name))
      probe.missing_tables = OPTIONAL_TABLES.filter((name) => !tables.has(name))
      if (!probe.missing.length && !probe.missing_tables.length) probe.latched = true
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
    function optional(table, sql) {
      if (probe.missing_tables.includes(table)) return []
      try { return handle.prepare(sql).all(...ids) } catch {
        if (!probe.missing_tables.includes(table)) probe.missing_tables.push(table)
        return []
      }
    }
    const agentSessions = optional('agent_sessions', `SELECT adw_id, billed_input_tokens, billed_output_tokens, billed_cache_write_tokens, billed_cache_read_tokens FROM agent_sessions WHERE adw_id IN (${marks})`)
    const gateRows = optional('gate_discriminations', `SELECT adw_id, gate_generation, verdict, checks_total, checks_failed, checks_errored, note, created_at FROM gate_discriminations WHERE adw_id IN (${marks}) ORDER BY adw_id, gate_generation`)
    const reviewRows = optional('review_outcomes', `SELECT adw_id, dispatch_id, role, verdict, must_fix, should_fix, consider, created_at FROM review_outcomes WHERE adw_id IN (${marks}) ORDER BY adw_id, created_at, id`)
    const acceptRows = optional('accept_decisions', `SELECT adw_id, phase_id, where_at, outcome, findings_total, residual_count, refuted_count, cosmetic_count, unverified_count, invalid_reasons, created_at FROM accept_decisions WHERE adw_id IN (${marks}) ORDER BY adw_id, created_at, id`)
    const phaseMap = new Map(), eventMap = new Map(), agentSessionMap = new Map(), gateMap = new Map(), reviewMap = new Map(), acceptMap = new Map()
    for (const id of ids) {
      phaseMap.set(id, []); eventMap.set(id, []); agentSessionMap.set(id, []); gateMap.set(id, []); reviewMap.set(id, []); acceptMap.set(id, [])
    }
    for (const row of phases) phaseMap.get(row.adw_id)?.push(row)
    for (const row of agents) eventMap.get(row.adw_id)?.push(row)
    for (const row of agentSessions) agentSessionMap.get(row.adw_id)?.push(row)
    for (const row of gateRows) gateMap.get(row.adw_id)?.push(row)
    for (const row of reviewRows) reviewMap.get(row.adw_id)?.push(row)
    for (const row of acceptRows) acceptMap.get(row.adw_id)?.push(row)
    const triageRows = triage.readTriage(ids)
    const shapeProbe = { ...probe, missing: [...probe.missing, ...probe.missing_tables.flatMap((table) => TABLE_FIELDS[table] ?? [])] }
    const now = Date.now()
    const runs = sessions.map((session) => shapeRun(session, phaseMap.get(session.adw_id), eventMap.get(session.adw_id), triageRows.get(session.adw_id), shapeProbe, now,
      { agentSessions: agentSessionMap.get(session.adw_id), gateDiscriminations: gateMap.get(session.adw_id), reviewOutcomes: reviewMap.get(session.adw_id), acceptDecisions: acceptMap.get(session.adw_id) })).filter((run) => matchesFilters(run, filters))
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
  function cellFailures({ since = null, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { rows: null, absent: degradedReason || 'the ledger could not be opened' }
    if (probe.missing_tables.includes('cell_failures')) return { rows: null, absent: 'cell_failures predates this ledger mirror' }
    try {
      const rows = handle.prepare(`
      SELECT provider, model_id, agent, effort, role, kind,
        COUNT(*) AS failures, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
        SUM(CASE WHEN adw_id IS NULL THEN 1 ELSE 0 END) AS run_less
      FROM cell_failures
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY provider, model_id, agent, effort, role, kind
      ORDER BY provider, model_id, agent, effort, role, kind
    `).all(since, since, until, until)
      return { rows, absent: null }
    } catch (err) {
      if (!probe.missing_tables.includes('cell_failures')) probe.missing_tables.push('cell_failures')
      return { rows: null, absent: err?.message || String(err) }
    }
  }
  function runSet({ since, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { rows: null, absent: degradedReason || 'the ledger could not be opened' }
    const untilClause = until == null ? '' : ' AND s.started_at < ?'
    const params = until == null ? [since] : [since, until]
    const sql = probe.missing_tables.includes('agent_sessions')
      ? `
      SELECT s.adw_id, s.task_slug, s.repo_slug, s.status, s.started_at, s.ended_at,
        0 AS agent_sessions,
        NULL AS billed_input_tokens,
        NULL AS billed_output_tokens,
        NULL AS billed_cache_write_tokens,
        NULL AS billed_cache_read_tokens
      FROM sessions s
      WHERE s.started_at >= ?${untilClause}
      ORDER BY s.started_at, s.adw_id
    `
      : `
      -- Keep this in lockstep with scripts/factory/ledger.mjs:1575-1585:
      -- agent_sessions rows hold running totals, so usage is SUM over rows,
      -- never MAX or a last-row read.
      SELECT s.adw_id, s.task_slug, s.repo_slug, s.status, s.started_at, s.ended_at,
        (SELECT COUNT(*) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS agent_sessions,
        (SELECT SUM(a.billed_input_tokens)       FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_input_tokens,
        (SELECT SUM(a.billed_output_tokens)      FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_output_tokens,
        (SELECT SUM(a.billed_cache_write_tokens) FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_cache_write_tokens,
        (SELECT SUM(a.billed_cache_read_tokens)  FROM agent_sessions a WHERE a.adw_id = s.adw_id) AS billed_cache_read_tokens
      FROM sessions s
      WHERE s.started_at >= ?${untilClause}
      ORDER BY s.started_at, s.adw_id
    `
    try {
      const rows = handle.prepare(sql).all(...params)
      return { rows, absent: null }
    } catch (err) {
      if (!probe.missing_tables.includes('sessions')) probe.missing_tables.push('sessions')
      return { rows: null, absent: err?.message || String(err) }
    }
  }
  function health() {
    probeColumns()
    const triageHealth = triage.health()
    return { degraded: degraded || triageHealth.degraded, ledger_db: ledgerDb, triage_db: triageHealth.path, readonly: true, probe: { ...probe } }
  }
  return {
    listRuns,
    listEvents,
    cellFailures,
    runSet,
    setTriage: (input) => triage.setTriage(input),
    health,
    close: () => { closed = true; if (db) { try { db.close() } catch {} db = null }; triage.close() },
    _probe: probe,
    _reason: () => degradedReason,
  }
}
