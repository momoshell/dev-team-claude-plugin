// Read-only factory-ledger Feed implementation. scripts/factory/ledger.mjs
// owns its only factory-ledger database door; triage.mjs separately owns the
// writable visualizer.db sidecar. An unavailable ledger handle degrades the
// feed rather than throwing.
import { openLedger } from '../../scripts/factory/ledger.mjs'
import { createTriage } from './triage.mjs'
import { shapeRun, matchesFilters } from './shape.mjs'
// A failed open is a MOMENT, not a verdict. A read-only database handle cannot
// create a missing file, so a visualizer started before the first crew run
// used to answer empty for the rest of its life (#536/F8). The latch now
// holds only for `closed`; a degraded open is re-attempted, at most once per
// cooldown so a hot read loop cannot construct a handle per read.
export const FEED_REOPEN_COOLDOWN_MS = 2000
const OPTIONAL_COLUMNS = { sessions: ['mode', 'engineer'] }
const OPTIONAL_TABLES = ['agent_sessions', 'gate_discriminations', 'gate_results', 'review_outcomes', 'accept_decisions', 'cell_failures', 'intake_sweeps', 'intake_refusals', 'seat_teardowns']
// Which shape fields a missing table makes unknowable. Feeding these into the
// probe reuses #48's NULL-probe path (shape.mjs) instead of inventing a second
// mechanism for the same idea.
const TABLE_FIELDS = {
  agent_sessions: ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens'],
  gate_discriminations: ['gate_discrimination', 'gate_generations'],
  gate_results: ['gate_checks'],
  review_outcomes: ['reviews'],
  accept_decisions: ['accept_decisions'],
}

export function createLedgerFeed({ ledgerDb, triageDb, stderr = { write() {} }, reopenCooldownMs = FEED_REOPEN_COOLDOWN_MS, now = () => Date.now() } = {}) {
  let ledger = null
  let db = null
  let degraded = false
  let degradedReason = null
  let closed = false
  let nextOpenAt = 0
  const probe = { missing: [...OPTIONAL_COLUMNS.sessions], missing_tables: [...OPTIONAL_TABLES], latched: false, probes: 0, open_attempts: 0, reopens: 0 }
  let json1 = null
  const triage = createTriage({ ledgerDb, triageDb })
  const seenNotices = new Set()
  const ledgerStderr = { write(chunk) {
    const text = String(chunk)
    if (seenNotices.has(text)) return true
    if (seenNotices.size < 32) seenNotices.add(text)
    return stderr.write(text)
  } }

  function mirrorErrorReason(errors) {
    return errors.first_message || errors.first_code || 'mirror read failed'
  }

  function open() {
    if (closed) return db
    if (ledger && db) return db
    if (degraded && now() < nextOpenAt) return null
    const reopening = degraded
    nextOpenAt = now() + reopenCooldownMs
    probe.open_attempts += 1
    if (ledger) { try { ledger.close() } catch { /* a handle we are replacing */ } }
    ledger = null
    db = null
    try {
      ledger = openLedger({ dbPath: ledgerDb, readOnly: true, stderr: ledgerStderr })
      db = ledger.readConnection()
      if (!db) {
        degraded = true
        degradedReason = ledger.stats().degraded_message || 'the ledger could not be opened'
        ledger = null
        return null
      }
      if (reopening) {
        // The database that just opened is not the one the old probe
        // described: re-probe it rather than carrying a stale absence.
        probe.reopens += 1
        probe.latched = false
        probe.missing = [...OPTIONAL_COLUMNS.sessions]
        probe.missing_tables = [...OPTIONAL_TABLES]
        json1 = null
      }
      degraded = false
      degradedReason = null
      return db
    } catch (err) {
      degraded = true
      degradedReason = ledger?.stats().degraded_message || err?.message || String(err)
      ledger = null
      db = null
      return null
    }
  }
  function probeColumns() {
    const handle = open()
    if (!handle || probe.latched) return
    probe.probes += 1
    const { value, errors } = ledger.captureMirrorErrors(() => ({
      names: ledger.columnNames('sessions'),
      tables: ledger.tableNames(),
    }))
    if (errors.count > 0) {
      degradedReason = mirrorErrorReason(errors)
      return
    }
    const names = new Set(value.names), tables = new Set(value.tables)
    probe.missing = OPTIONAL_COLUMNS.sessions.filter((name) => !names.has(name))
    probe.missing_tables = OPTIONAL_TABLES.filter((name) => !tables.has(name))
    if (!probe.missing.length && !probe.missing_tables.length) probe.latched = true
  }
  function listRuns(filters = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { runs: [], degraded: true, probe: { ...probe } }
    const sessionsRead = ledger.captureMirrorErrors(() => ledger.sessionsFiltered(filters))
    if (sessionsRead.errors.count > 0) {
      return { runs: [], degraded: true, absent: mirrorErrorReason(sessionsRead.errors), probe: { ...probe } }
    }
    const sessions = sessionsRead.value
    const ids = sessions.map((row) => row.adw_id)
    if (!ids.length) return { runs: [], degraded, probe: { ...probe } }
    const phasesRead = ledger.captureMirrorErrors(() => ledger.phasesFor(ids))
    if (phasesRead.errors.count > 0) {
      return { runs: [], degraded: true, absent: mirrorErrorReason(phasesRead.errors), probe: { ...probe } }
    }
    const agentsRead = ledger.captureMirrorErrors(() => ledger.agentEventsFor(ids))
    if (agentsRead.errors.count > 0) {
      return { runs: [], degraded: true, absent: mirrorErrorReason(agentsRead.errors), probe: { ...probe } }
    }
    const phases = phasesRead.value
    const agents = agentsRead.value
    function optional(table, fn) {
      if (probe.missing_tables.includes(table)) return []
      const { value, errors } = ledger.captureMirrorErrors(fn)
      if (errors.count > 0) {
        if (!probe.missing_tables.includes(table)) probe.missing_tables.push(table)
        return []
      }
      return value
    }
    const agentSessions = optional('agent_sessions', () => ledger.agentSessionsFor(ids))
    const gateRows = optional('gate_discriminations', () => ledger.gateDiscriminationsFor(ids))
    const gateResults = optional('gate_results', () => ledger.gateResultsFor(ids))
    const reviewRows = optional('review_outcomes', () => ledger.reviewOutcomesFor(ids))
    const acceptRows = optional('accept_decisions', () => ledger.acceptDecisionsFor(ids))
    const phaseMap = new Map(), eventMap = new Map(), agentSessionMap = new Map(), gateMap = new Map(), gateResultsMap = new Map(), reviewMap = new Map(), acceptMap = new Map()
    for (const id of ids) {
      phaseMap.set(id, []); eventMap.set(id, []); agentSessionMap.set(id, []); gateMap.set(id, []); gateResultsMap.set(id, []); reviewMap.set(id, []); acceptMap.set(id, [])
    }
    for (const row of phases) phaseMap.get(row.adw_id)?.push(row)
    for (const row of agents) eventMap.get(row.adw_id)?.push(row)
    for (const row of agentSessions) agentSessionMap.get(row.adw_id)?.push(row)
    for (const row of gateRows) gateMap.get(row.adw_id)?.push(row)
    for (const row of gateResults) gateResultsMap.get(row.adw_id)?.push(row)
    for (const row of reviewRows) reviewMap.get(row.adw_id)?.push(row)
    for (const row of acceptRows) acceptMap.get(row.adw_id)?.push(row)
    const triageRows = triage.readTriage(ids)
    const shapeProbe = { ...probe, missing: [...probe.missing, ...probe.missing_tables.flatMap((table) => TABLE_FIELDS[table] ?? [])] }
    const now = Date.now()
    const runs = sessions.map((session) => shapeRun(session, phaseMap.get(session.adw_id), eventMap.get(session.adw_id), triageRows.get(session.adw_id), shapeProbe, now,
      { agentSessions: agentSessionMap.get(session.adw_id), gateDiscriminations: gateMap.get(session.adw_id), gateResults: gateResultsMap.get(session.adw_id), reviewOutcomes: reviewMap.get(session.adw_id), acceptDecisions: acceptMap.get(session.adw_id) })).filter((run) => matchesFilters(run, filters))
    return { runs, degraded: degraded || triage.health().degraded, probe: { ...probe } }
  }
  function listEvents({ adw_id, after = 0, limit = 200, type, role, phase_id } = {}) {
    const handle = open()
    if (!handle) return { events: [], cursor: after }
    const filters = type != null || role != null || phase_id != null
    const unsupported_filters = []
    let eventRole = role
    if (role != null) {
      if (json1 === null) json1 = ledger.captureMirrorErrors(() => ledger.supportsJson1()).value
      if (json1) { eventRole = role } else { eventRole = null; unsupported_filters.push('role') }
    }
    const eventsRead = ledger.captureMirrorErrors(() => ledger.eventsPage({ adw_id, after, limit, type, phase_id, role: eventRole }))
    if (eventsRead.errors.count > 0) {
      return { events: [], cursor: after, degraded: true, absent: mirrorErrorReason(eventsRead.errors) }
    }
    const events = eventsRead.value
    if (!filters) return { events, cursor: events.length ? events[events.length - 1].id : after }
    const maxRead = ledger.captureMirrorErrors(() => ledger.maxEventId(adw_id))
    if (maxRead.errors.count > 0) {
      return { events, cursor: after, degraded: true, absent: mirrorErrorReason(maxRead.errors), ...(unsupported_filters.length ? { unsupported_filters } : {}) }
    }
    const max = maxRead.value
    return { events, cursor: events.length === limit ? events.at(-1).id : (max ?? after), ...(unsupported_filters.length ? { unsupported_filters } : {}) }
  }
  function cellFailures({ since = null, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { rows: null, absent: degradedReason || 'the ledger could not be opened' }
    if (probe.missing_tables.includes('cell_failures')) return { rows: null, absent: 'cell_failures predates this ledger mirror' }
    const { value: rows, errors } = ledger.captureMirrorErrors(() => ledger.cellFailures({ since, until }))
    if (errors.count > 0) return { rows: null, absent: errors.first_code || 'mirror read failed' }
    return { rows, absent: null }
  }
  function cellAttribution({ since = null, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { runs: null, rows: null, unattributable: null, absent: degradedReason || 'the ledger could not be opened' }
    if (probe.missing_tables.includes('cell_failures')) return { runs: null, rows: null, unattributable: null, absent: 'cell_failures predates this ledger mirror' }
    const { value, errors } = ledger.captureMirrorErrors(() => {
      const runs = ledger.runsStartedWithin({ since, until })
      const ids = runs.map((row) => row.adw_id)
      const rows = ledger.cellFailureRowsFor(ids)
      const unattributable = ledger.unattributableCellFailures({ since, until })
      return { runs, rows, unattributable }
    })
    if (errors.count > 0) {
      if (!probe.missing_tables.includes('cell_failures')) probe.missing_tables.push('cell_failures')
      return { runs: null, rows: null, unattributable: null, absent: mirrorErrorReason(errors) }
    }
    return { ...value, absent: null }
  }
  function seatTeardowns({ since = null, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { runs: null, rows: null, absent: degradedReason || 'the ledger could not be opened' }
    if (probe.missing_tables.includes('seat_teardowns')) return { runs: null, rows: null, absent: 'seat_teardowns predates this ledger mirror' }
    const { value, errors } = ledger.captureMirrorErrors(() => {
      const runs = ledger.runsStartedWithin({ since, until })
      const ids = runs.map((row) => row.adw_id)
      const rows = ledger.seatTeardownRowsFor(ids)
      return { runs, rows }
    })
    if (errors.count > 0) {
      if (!probe.missing_tables.includes('seat_teardowns')) probe.missing_tables.push('seat_teardowns')
      return { runs: null, rows: null, absent: mirrorErrorReason(errors) }
    }
    return { ...value, absent: null }
  }
  function intake({ since = null, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return {
      sweeps: null, refusals: null, picks: null, ever: null,
      candidate_refusals: null, candidate_picks: null, candidates_absent: null,
      absent: degradedReason || 'the ledger could not be opened',
    }
    if (probe.missing_tables.includes('intake_sweeps')) return {
      sweeps: null, refusals: null, picks: null, ever: null,
      candidate_refusals: null, candidate_picks: null, candidates_absent: null,
      absent: 'intake_sweeps predates this ledger mirror',
    }

    let sweeps, picks, ever
    const sweepsRead = ledger.captureMirrorErrors(() => ledger.intakeSweeps({ since, until }))
    sweeps = sweepsRead.value
    if (sweepsRead.errors.count > 0) return {
      sweeps: null, refusals: null, picks: null, ever: null,
      candidate_refusals: null, candidate_picks: null, candidates_absent: null,
      absent: sweepsRead.errors.first_code || 'mirror read failed',
    }
    const sweepDetailsRead = ledger.captureMirrorErrors(() => ({
      picks: ledger.intakePicks({ since, until }),
      ever: ledger.intakeSweepTotals(),
    }))
    if (sweepDetailsRead.errors.count > 0) {
      if (!probe.missing_tables.includes('intake_sweeps')) probe.missing_tables.push('intake_sweeps')
      return {
        sweeps: null, refusals: null, picks: null, ever: null,
        candidate_refusals: null, candidate_picks: null, candidates_absent: null,
        absent: mirrorErrorReason(sweepDetailsRead.errors),
      }
    }
    picks = sweepDetailsRead.value.picks
    ever = sweepDetailsRead.value.ever

    let refusals = null, refusals_absent = null
    let candidate_refusals = null, candidate_picks = null, candidates_absent = null
    if (probe.missing_tables.includes('intake_refusals')) {
      refusals_absent = 'intake_refusals predates this ledger mirror'
      candidates_absent = refusals_absent
    } else {
      const refusalsRead = ledger.captureMirrorErrors(() => ledger.intakeRefusals({ since, until }))
      refusals = refusalsRead.value
      if (refusalsRead.errors.count > 0) return {
        sweeps: null, refusals: null, picks: null, ever: null,
        candidate_refusals: null, candidate_picks: null, candidates_absent: null,
        absent: refusalsRead.errors.first_code || 'mirror read failed',
      }
      const candidatesRead = ledger.captureMirrorErrors(() => ({
        candidate_refusals: ledger.intakeCandidateRefusals({ since, until }),
        candidate_picks: ledger.intakeCandidatePicks({ since, until }),
      }))
      if (candidatesRead.errors.count > 0) {
        if (!probe.missing_tables.includes('intake_refusals')) probe.missing_tables.push('intake_refusals')
        refusals_absent = mirrorErrorReason(candidatesRead.errors)
        candidates_absent = refusals_absent
      } else {
        candidate_refusals = candidatesRead.value.candidate_refusals
        candidate_picks = candidatesRead.value.candidate_picks
      }
    }
    return {
      sweeps, refusals, refusals_absent, picks, ever,
      candidate_refusals, candidate_picks, candidates_absent, absent: null,
    }
  }
  function runSet({ since, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { rows: null, transports: [], absent: degradedReason || 'the ledger could not be opened' }
    const { value, errors } = ledger.captureMirrorErrors(() => {
      const rows = ledger.runSet({ since, until })
      return { rows, transportRows: ledger.transportsFor(rows.map((row) => row.adw_id)) }
    })
    if (errors.count > 0) return { rows: null, transports: [], absent: errors.first_code || 'mirror read failed' }
    const transports = [...value.transportRows.values()].flatMap((values) => [...values])
    return { rows: value.rows, transports, absent: null }
  }
  function budgetWindow({ since, until = null } = {}) {
    probeColumns()
    const handle = open()
    if (!handle) return { measured: false, total: null, sessions: null, absent: degradedReason || 'the ledger could not be opened' }
    if (probe.missing_tables.includes('agent_sessions')) {
      return { measured: false, total: null, sessions: null, absent: 'agent_sessions predates this ledger mirror' }
    }
    const { value: row, errors } = ledger.captureMirrorErrors(() => ledger.agentSessionTokenTotals({ since, until }))
    if (errors.count > 0) {
      if (!probe.missing_tables.includes('agent_sessions')) probe.missing_tables.push('agent_sessions')
      return { measured: false, total: null, sessions: null, absent: mirrorErrorReason(errors) }
    }
    const total = ['input', 'output', 'cache_write', 'cache_read']
      .reduce((sum, key) => sum + Number(row?.[key] ?? 0), 0)
    return { measured: true, total, sessions: Number(row?.sessions ?? 0), absent: null }
  }
  function health() {
    probeColumns()
    const triageHealth = triage.health()
    return { degraded: degraded || triageHealth.degraded, ledger_db: ledgerDb, triage_db: triageHealth.path, ledger_feed_readonly: true, triage_sidecar_writable: true, probe: { ...probe } }
  }
  return {
    listRuns,
    listEvents,
    cellFailures,
    cellAttribution,
    seatTeardowns,
    intake,
    runSet,
    budgetWindow,
    setTriage: (input) => triage.setTriage(input),
    health,
    close: () => { closed = true; if (ledger) { try { ledger.close() } catch {} }; ledger = null; db = null; triage.close() },
    _probe: probe,
    _reason: () => degradedReason,
  }
}
