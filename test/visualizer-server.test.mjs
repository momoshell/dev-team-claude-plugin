import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawn as spawnProcess } from 'node:child_process'
import { openLedger, NODE_FLOOR } from '../scripts/factory/ledger.mjs'
import { createLedgerFeed } from '../visualizer/server/ledger-feed.mjs'

const require = createRequire(import.meta.url)
function sqliteAvailable() { try { require('node:sqlite'); return true } catch { return false } }
const SKIP = sqliteAvailable() ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`
const children = new Set()
after(() => { for (const child of children) { try { child.kill('SIGKILL') } catch {} } })

function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function treeDigest(root) {
  const hash = createHash('sha256')
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = statSync(path)
      hash.update(name)
      if (stat.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}
async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  return { status: response.status, body: text, json: JSON.parse(text) }
}
function announce(child) {
  return new Promise((resolve, reject) => {
    let output = '', error = ''
    const timer = setTimeout(() => reject(new Error(`server did not announce a port: ${error}`)), 10000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve(`http://127.0.0.1:${value.port}`); return } } catch {}
      }
    })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('exit', (code) => { children.delete(child); clearTimeout(timer); reject(new Error(`server exited ${code}: ${error}`)) })
  })
}
function startServer(ledgerDb, triageDb, crewRoot, rosterPath, environment = null) {
  const args = ['visualizer/server/server.mjs', '--port', '0', '--ledger-db', ledgerDb, '--triage-db', triageDb]
  if (crewRoot) args.push('--crew-root', crewRoot)
  if (rosterPath) args.push('--roster', rosterPath)
  const child = spawnProcess(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment ? { ...process.env, ...environment } : process.env })
  children.add(child)
  return announce(child).then((base) => ({ child, base }))
}
async function stopServer(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}
function returnsFixture(root, adwId) {
  const dir = join(root, 'repo', 'finished'), returns = join(dir, 'returns'), ledger = join(dir, 'ledger')
  mkdirSync(returns, { recursive: true }); mkdirSync(ledger, { recursive: true })
  writeFileSync(join(ledger, 'run.json'), JSON.stringify({ adw_id: adwId, repo_slug: 'repo', task_slug: 'finished' }))
  const envelope = (id, role) => JSON.stringify({ assignment_id: id, role, status: 'done', summary: `${role} ${id}`, artifacts: [], details: {} })
  writeFileSync(join(returns, 'd1.planner.json'), envelope('d1', 'planner'))
  writeFileSync(join(returns, 'd2.builder.json'), envelope('d2', 'builder'))
  writeFileSync(join(returns, 'task.json'), JSON.stringify({ status: 'done' }))
}
function fixture(path, { filler = 0 } = {}) {
  const ledger = openLedger({ dbPath: path })
  const done = 'test-done-0000-0000-000000000001'
  const live = 'test-live-0000-0000-000000000002'
  const pane = 'test-pane-0000-0000-000000000003'
  ledger.startSession({ adw_id: done, repo_slug: 'repo', task_slug: 'finished' })
  for (const [seq, name] of ['plan', 'build', 'review'].entries()) { ledger.startPhase({ adw_id: done, seq: seq + 1, name }); ledger.endPhase({ adw_id: done, seq: seq + 1, status: 'ok' }) }
  ledger.recordEvent({ adw_id: done, type: 'agent_start', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_end', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1', outcome: 'done' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_start', phase_id: 2, payload: { role: 'builder', dispatch_id: 'd2' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_end', phase_id: 2, payload: { role: 'builder', dispatch_id: 'd2', outcome: 'done' } })
  for (let i = 0; i < filler; i += 1) ledger.recordEvent({ adw_id: done, type: 'log', payload: { level: 'info', message: `filler ${i}` } })
  for (const [index, claudeSessionId] of ['claude-done-1', 'claude-done-2'].entries()) {
    const dispatchId = `agent-done-${index + 1}`
    ledger.startAgentSession({ adw_id: done, dispatch_id: dispatchId, role: 'builder', model: 'test-model', claude_session_id: claudeSessionId, transcript_path: `/tmp/${claudeSessionId}.jsonl` })
    ledger.endAgentSession({ adw_id: done, claude_session_id: claudeSessionId, context_tokens: 100, context_window: 200, raw_read_tokens: 20, raw_written_tokens: 10,
      billed_input_tokens: index === 0 ? 10 : 5, billed_output_tokens: index === 0 ? 4 : 6,
      billed_cache_write_tokens: index === 0 ? 2 : 3, billed_cache_read_tokens: index === 0 ? 1 : 7 })
  }
  ledger.recordGateDiscrimination({ adw_id: done, phase_id: 3, gate_generation: 1, verdict: 'failed', checks_total: 2, checks_failed: 2, checks_errored: 0, created_at: '2024-01-01T00:00:01.000Z' })
  ledger.recordGateDiscrimination({ adw_id: done, phase_id: 3, gate_generation: 2, verdict: 'proven', checks_total: 2, checks_failed: 0, checks_errored: 0, created_at: '2024-01-01T00:00:02.000Z' })
  ledger.recordReviewOutcome({ adw_id: done, phase_id: 3, dispatch_id: 'd1', role: 'reviewer', verdict: 'changes-needed', must_fix: 1, should_fix: 2, consider: 0, created_at: '2024-01-01T00:00:03.000Z' })
  ledger.recordReviewOutcome({ adw_id: done, phase_id: 3, dispatch_id: 'd2', role: 'reviewer', verdict: 'pass', must_fix: 0, should_fix: 0, consider: 0, created_at: '2024-01-01T00:00:04.000Z' })
  ledger.recordAcceptDecision({ adw_id: done, phase_id: 3, where_at: 'review-exhausted', outcome: 'accepted', findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 0, unverified_count: 0, invalid_reasons: '', created_at: '2024-01-01T00:00:05.000Z' })
  ledger.recordAcceptDecision({ adw_id: done, phase_id: 3, where_at: 'review-exhausted', outcome: 'escalated', findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 0, unverified_count: 0, invalid_reasons: 'f1: unresolved', created_at: '2024-01-01T00:00:06.000Z' })
  const recentFailure = new Date(Date.now() - 3600e3).toISOString()
  ledger.recordCellFailure({ provider: 'anthropic', model_id: 'viz-cell-a', agent: 'claude', effort: 'high', role: 'planner', kind: 'boot-refusal', adw_id: null, created_at: recentFailure })
  ledger.recordCellFailure({ provider: 'anthropic', model_id: 'viz-cell-a', agent: 'claude', effort: 'high', role: 'planner', kind: 'timeout', adw_id: done, created_at: recentFailure })
  ledger.recordCellFailure({ provider: 'anthropic', model_id: 'viz-cell-a', agent: 'claude', effort: 'high', role: 'builder', kind: 'seat-died', adw_id: done, created_at: new Date(Date.now() - 30 * 24 * 3600e3).toISOString() })
  ledger.recordCellFailure({ provider: 'openai', model_id: 'viz-cell-b', agent: 'pi', effort: 'max', role: 'reviewer', kind: 'no-envelope', adw_id: null, created_at: recentFailure })
  ledger.endSession({ adw_id: done, status: 'ok' })
  ledger.startSession({ adw_id: live, repo_slug: 'repo', task_slug: 'live' })
  ledger.startPhase({ adw_id: live, seq: 1, name: 'plan' })
  ledger.recordEvent({ adw_id: live, type: 'agent_start', payload: { role: 'planner', dispatch_id: 'l1' } })
  ledger.startSession({ adw_id: pane, repo_slug: 'repo', task_slug: 'pane', started_at: new Date(Date.now() - 2 * 3600e3).toISOString() })
  ledger.endSession({ adw_id: pane, status: 'aborted', ended_at: new Date(Date.now() - 3600e3).toISOString() })
  ledger.close()
  return { done, live, pane }
}

test('visualizer server never writes to the ledger', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-server-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db'), crewRoot = join(dir, 'crew')
  const { done, live } = fixture(ledgerDb, { filler: 201 })
  returnsFixture(crewRoot, done)
  // Baseline must precede spawn and every endpoint, otherwise a ledger write can be included in it.
  const before = digest(ledgerDb)
  const crewBefore = treeDigest(crewRoot)
  let child, base
  try {
    child = spawn(process.execPath, ['visualizer/server/server.mjs', '--port', '0', '--ledger-db', ledgerDb, '--triage-db', triageDb, '--crew-root', crewRoot], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    base = await announce(child)
    const sessions = await json(base, '/api/sessions')
    const runs = sessions.json.runs
    const historical = runs.find((run) => run.adw_id === done), running = runs.find((run) => run.adw_id === live)
    assert.ok(historical && running)
    assert.equal(historical.phases.length, 3)
    assert.equal(historical.agents.find((agent) => agent.dispatch_id === 'd2').outcome, 'done')
    assert.equal(running.agents.find((agent) => agent.dispatch_id === 'l1').outcome, null)
    assert.deepEqual(Object.keys(historical).sort(), Object.keys(running).sort())
    const first = await json(base, `/api/events?adw_id=${done}&after=0&limit=100`)
    const second = await json(base, `/api/events?adw_id=${done}&after=${first.json.cursor}&limit=100`)
    const third = await json(base, `/api/events?adw_id=${done}&after=${second.json.cursor}&limit=100`)
    assert.equal(first.json.events.length, 100)
    assert.equal(second.json.events.length, 100)
    assert.equal(third.json.events.length, 5)
    assert.ok(third.json.events.every((event) => event.id > second.json.cursor))
    assert.equal(first.json.cursor, first.json.events.at(-1).id)
    const returns = await json(base, `/api/returns?repo_slug=repo&task_slug=finished&adw_id=${done}`)
    assert.equal(returns.status, 200); assert.equal(returns.json.envelopes.length, 2); assert.equal(returns.json.task.status, 'done')
    assert.equal((await json(base, '/api/returns')).status, 400)
    const escapedReturns = await json(base, '/api/returns?repo_slug=../&task_slug=finished')
    assert.equal(escapedReturns.status, 200); assert.ok(escapedReturns.json.error); assert.equal(escapedReturns.json.envelopes.length, 0)
    const logs = await json(base, `/api/events?adw_id=${done}&type=log&limit=10`)
    assert.ok(logs.json.events.every((event) => event.type === 'log')); assert.ok(Number.isFinite(logs.json.cursor))
    const builders = await json(base, `/api/events?adw_id=${done}&role=builder`)
    assert.ok(builders.json.events.every((event) => JSON.parse(event.payload_json).role === 'builder')); assert.ok(Number.isFinite(builders.json.cursor))
    const byPhase = await json(base, `/api/events?adw_id=${done}&phase_id=1`)
    assert.ok(byPhase.json.events.length > 0); assert.ok(byPhase.json.events.every((event) => event.phase_id === 1)); assert.ok(Number.isFinite(byPhase.json.cursor))
    assert.equal((await json(base, `/api/events?adw_id=${live}&limit=50`)).json.events.length, 1)
    await json(base, '/api/health'); await json(base, '/api/health')
    await json(base, '/api/cell-health')
    await json(base, '/api/run-set')
    assert.equal((await json(base, '/api/events?adw_id=x&after=bad')).status, 400)
    assert.equal((await json(base, '/api/events?adw_id=x&limit=wat')).status, 400)
    assert.equal((await json(base, '/api/nope')).status, 404)
    assert.equal((await json(base, '/api/sessions', { method: 'POST' })).status, 405)
    const traversal = await fetch(`${base}/../../etc/passwd`)
    assert.equal(traversal.status, 200)
    assert.doesNotMatch(await traversal.text(), /root:[^<\n]*:0:0/)
    const triage = await json(base, '/api/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adw_id: done, reviewed: true }) })
    assert.equal(triage.status, 200)
    assert.ok((await json(base, '/api/sessions')).json.runs.find((run) => run.adw_id === done).triage.reviewed_at)
    assert.ok(existsSync(triageDb))
    await stopServer(child); child = null
    // Compare to the pre-spawn baseline after triage: this is the acceptance line.
    assert.equal(digest(ledgerDb), before)
    assert.equal(treeDigest(crewRoot), crewBefore)
    const readonly = new (require('node:sqlite').DatabaseSync)(ledgerDb, { readOnly: true })
    assert.throws(() => readonly.exec('CREATE TABLE visualizer_write_probe (x)'))
    readonly.close()
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions expose token, gate, and review measurements while live runs stay pending', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-measurements-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done, live } = fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const runs = (await json(base, '/api/sessions')).json.runs
    const historical = runs.find((run) => run.adw_id === done), running = runs.find((run) => run.adw_id === live)
    assert.equal(historical.metrics.billed_input_tokens, 15)
    assert.equal(historical.metrics.billed_output_tokens, 10)
    assert.equal(historical.metrics.billed_cache_write_tokens, 5)
    assert.equal(historical.metrics.billed_cache_read_tokens, 8)
    assert.equal(historical.gate_generations.length, 2)
    assert.equal(historical.gate_discrimination, 'proven')
    assert.equal(historical.reviews.length, 2)
    assert.equal(historical.accept_decisions.length, 2)
    assert.deepEqual(historical.accept_decisions.map((row) => row.outcome), ['accepted', 'escalated'])
    for (const field of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) {
      assert.equal(running.metrics[field], null)
      assert.ok(running.pending[field])
      assert.notEqual(running.metrics[field], 0)
    }
    for (const field of ['gate_discrimination', 'reviews', 'accept_decisions']) {
      assert.equal(running[field], null)
      assert.ok(running.pending[field])
    }
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing measurement tables do not break the read-only feed', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-missing-tables-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done } = fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  for (const table of ['agent_sessions', 'gate_discriminations', 'review_outcomes', 'accept_decisions']) writable.exec(`DROP TABLE ${table}`)
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    let result
    assert.doesNotThrow(() => { result = feed.listRuns({}) })
    const run = result.runs.find((candidate) => candidate.adw_id === done)
    assert.ok(run)
    assert.ok(run.pending.billed_input_tokens)
    assert.ok(run.pending.gate_discrimination)
    assert.ok(run.pending.reviews)
    assert.equal(run.accept_decisions, null)
    assert.equal(run.pending.accept_decisions, 'predates this measurement')
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cell health reports a stated window, run-less rows and kinds without a verdict', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-health-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const response = await json(base, '/api/cell-health')
    assert.equal(response.status, 200)
    assert.ok(Number.isFinite(Date.parse(response.json.window.since)))
    const cellA = response.json.cells.find((cell) => cell.model_id === 'viz-cell-a')
    assert.ok(cellA)
    assert.equal(cellA.failures, 2)
    assert.equal(cellA.run_less, 1)
    assert.equal(cellA.in_run, 1)
    assert.deepEqual(cellA.by_kind.map((kind) => kind.kind), ['boot-refusal', 'timeout'])
    const cellB = response.json.cells.find((cell) => cell.model_id === 'viz-cell-b')
    assert.equal(cellB.state, 'run-less-only')
    assert.ok(response.json.cells.some((cell) => cell.state === 'silent'))

    const wide = await json(base, `/api/cell-health?since=${encodeURIComponent(new Date(0).toISOString())}`)
    assert.equal(wide.status, 200)
    assert.equal(wide.json.cells.find((cell) => cell.model_id === 'viz-cell-a').failures, 3)
    assert.equal((await json(base, '/api/cell-health', { method: 'POST' })).status, 405)
    assert.equal((await json(base, '/api/cell-health?since=not-a-date')).status, 400)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-set states its window and lists every run in it', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done } = fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const since = new Date(0).toISOString()
    const response = await json(base, `/api/run-set?since=${encodeURIComponent(since)}`)
    assert.equal(response.status, 200)
    assert.ok(Number.isFinite(Date.parse(response.json.window.since)))
    assert.ok(response.json.window.label)
    assert.equal(response.json.rows.length, response.json.runs)
    const tally = { running: 0, ok: 0, fail: 0, aborted: 0 }
    for (const row of response.json.rows) if (row.status in tally) tally[row.status] += 1
    assert.deepEqual(response.json.settled, tally)
    assert.equal(response.json.rows.find((row) => row.adw_id === done).billed_input_tokens, 15)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-set refuses a malformed or inverted window and rejects non-GET', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-window-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    assert.equal((await json(base, '/api/run-set?since=not-a-date')).status, 400)
    const since = encodeURIComponent('2024-01-02T00:00:00.000Z'), until = encodeURIComponent('2024-01-01T00:00:00.000Z')
    assert.equal((await json(base, `/api/run-set?since=${since}&until=${until}`)).status, 400)
    assert.equal((await json(base, '/api/run-set', { method: 'POST' })).status, 405)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mirror without agent_sessions still lists runs with usage unmeasured', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-partial-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('DROP TABLE agent_sessions')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    let result
    assert.doesNotThrow(() => { result = feed.runSet({ since: new Date(0).toISOString() }) })
    assert.ok(result.rows.length > 0)
    for (const row of result.rows) for (const field of ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']) assert.equal(row[field], null)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mirror without sessions makes the window unanswerable, not empty', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-absent-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('DROP TABLE sessions')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    let result
    assert.doesNotThrow(() => { result = feed.runSet({ since: new Date(0).toISOString() }) })
    assert.equal(result.rows, null)
    assert.ok(result.absent)
    assert.doesNotMatch(JSON.stringify(result), /"runs":\s*0/)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mirror without cell_failures renders the panel absent, not zero', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-health-absent-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('DROP TABLE cell_failures')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    let result
    assert.doesNotThrow(() => { result = feed.cellFailures({}) })
    assert.ok(result.absent)
    assert.equal(result.rows, null)
    assert.doesNotMatch(JSON.stringify(result), /"(failures|run_less|in_run)":\s*0/)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken ledger reports degraded without throwing', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-degraded-'))
  const feed = createLedgerFeed({ ledgerDb: join(dir, 'missing', 'ledger.db'), triageDb: join(dir, 'visualizer.db') })
  try {
    let result
    assert.doesNotThrow(() => { result = feed.listRuns({}) })
    assert.deepEqual(result.runs, [])
    assert.equal(result.degraded, true)
    assert.ok(result.probe)
    assert.equal(feed.health().degraded, true)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('roster endpoint serves the runtime roster read-only and degrades honestly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-roster-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const missing = join(dir, 'missing-roster.json'), malformed = join(dir, 'malformed-roster.json')
  writeFileSync(malformed, '{ this is not json')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const response = await json(base, '/api/roster')
    assert.equal(response.status, 200)
    const roster = response.json
    assert.equal(roster.path.endsWith('crew/roster.json'), true)
    assert.equal(roster.degraded, false)
    const onDisk = JSON.parse(readFileSync(roster.path, 'utf8'))
    assert.deepEqual(roster.tiers.map((tier) => tier.tier), Object.keys(onDisk.tiers))
    const buildReviewer = roster.tiers.find((tier) => tier.tier === 'build').seats.find((seat) => seat.role === 'reviewer')
    assert.equal(buildReviewer.effort, 'max')
    for (const field of ['provider', 'id', 'agent', 'effort']) assert.ok(buildReviewer[field])
    const mechanical = roster.tiers.find((tier) => tier.tier === 'mechanical')
    assert.equal(mechanical.seats.some((seat) => seat.role === 'lead'), false)
    assert.ok(mechanical.unseated.includes('lead'))
    const models = new Map(roster.models.map((model) => [model.key, model]))
    for (const tier of roster.tiers) for (const seat of tier.seats) {
      assert.ok(models.has(seat.model_key))
      assert.equal(typeof models.get(seat.model_key).cost_in_per_mtok, 'number')
      assert.equal(typeof models.get(seat.model_key).cost_out_per_mtok, 'number')
      assert.equal(typeof models.get(seat.model_key).last_verified, 'string')
    }
    assert.equal((await json(base, '/api/roster', { method: 'POST' })).status, 405)
    assert.equal((await json(base, '/api/roster', { method: 'PUT' })).status, 405)
    await stopServer(child); child = null;

    ({ child, base } = await startServer(ledgerDb, triageDb, null, missing))
    const absent = (await json(base, '/api/roster')).json
    assert.equal(absent.degraded, true)
    assert.ok(absent.error.includes(missing))
    assert.equal(absent.tiers, null)
    assert.notDeepEqual(absent.tiers, [])
    await stopServer(child); child = null;

    ({ child, base } = await startServer(ledgerDb, triageDb, null, malformed))
    const broken = (await json(base, '/api/roster')).json
    assert.equal(broken.degraded, true)
    assert.ok(broken.error.includes(malformed))
    assert.equal(broken.tiers, null)
    assert.equal(broken.models, null)
    assert.doesNotMatch(JSON.stringify(broken), /claude-|gpt-/)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('roster proposals validate, refuse safely, and never write the roster', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-roster-propose-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db'), crewRoot = join(dir, 'crew')
  const { done } = fixture(ledgerDb)
  returnsFixture(crewRoot, done)
  const rosterPath = join(process.cwd(), 'crew', 'roster.json')
  const rosterBefore = digest(rosterPath)
  const crewBefore = treeDigest(crewRoot)
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, crewRoot))
    assert.equal((await json(base, '/api/roster/propose')).status, 405)
    assert.equal((await json(base, '/api/roster/propose', { method: 'PUT' })).status, 405)
    assert.equal((await json(base, '/api/roster/propose', { method: 'POST', body: '{ not json' })).status, 400)
    assert.equal((await json(base, '/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
    assert.equal((await json(base, '/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'build', role: 'reviewer', cell: 'opus' }) })).status, 400)
    const legal = await json(base, '/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: 'high' } }) })
    assert.equal(legal.status, 200)
    assert.equal(legal.json.ok, true)
    assert.match(legal.json.diff, /^--- a\/crew\/roster\.json$/m)
    assert.match(legal.json.diff, /^\+\+\+ b\/crew\/roster\.json$/m)
    const cross = await json(base, '/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'build', role: 'reviewer', cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' } }) })
    assert.equal(cross.status, 200)
    assert.equal(cross.json.ok, false)
    assert.equal(cross.json.diff, null)
    assert.match(JSON.stringify(cross.json.refusals), /cross-vendor/)
    assert.match(JSON.stringify(cross.json.refusals), /planner/)
    assert.doesNotMatch(JSON.stringify(legal.json), /cost_in_per_mtok|cost_out_per_mtok|usd|spend/i)
    const read = await json(base, '/api/roster')
    assert.equal(read.status, 200)
    assert.equal(read.json.degraded, false)
    assert.equal(read.json.tiers.find((tier) => tier.tier === 'build').seats.find((seat) => seat.role === 'reviewer').effort, 'max')
    assert.equal((await json(base, '/api/roster', { method: 'POST' })).status, 405)
    await stopServer(child); child = null

    const missing = join(dir, 'missing-roster.json');
    ({ child, base } = await startServer(ledgerDb, triageDb, crewRoot, missing))
    const absent = await json(base, '/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'build', role: 'reviewer', cell: roster.tiers.build.reviewer }) })
    assert.equal(absent.status, 200)
    assert.equal(absent.json.ok, false)
    assert.equal(absent.json.diff, null)
    assert.match(JSON.stringify(absent.json.refusals), /missing-roster\.json/)
  } finally {
    if (child) await stopServer(child)
    assert.equal(digest(rosterPath), rosterBefore)
    assert.equal(treeDigest(crewRoot), crewBefore)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('budgetWindow sums all running-total agent session rows', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-budget-window-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done } = fixture(ledgerDb)
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    const result = feed.budgetWindow({ since: new Date(0).toISOString(), until: null })
    assert.equal(result.measured, true)
    assert.equal(result.total, 38)
    assert.equal(result.sessions, 2)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('budgetWindow refuses a mirror without agent_sessions', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-budget-window-absent-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('DROP TABLE agent_sessions')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    const result = feed.budgetWindow({ since: new Date(0).toISOString(), until: null })
    assert.equal(result.measured, false)
    assert.ok(result.absent)
    assert.equal(result.total, null)
    assert.notEqual(result.total, 0)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-set exposes a declared budget only when the view environment opts in', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-budget-server-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, null, null, { DEVTEAM_BUDGET_MAX_TOKENS: '', DEVTEAM_BUDGET_WINDOW_MS: '' }))
    const undeclared = (await json(base, '/api/run-set')).json.budget
    assert.equal(undeclared.ceiling_tokens, null)
    assert.equal(undeclared.headroom_tokens, null)
    await stopServer(child); child = null;

    ({ child, base } = await startServer(ledgerDb, triageDb, null, null, { DEVTEAM_BUDGET_MAX_TOKENS: '1000' }))
    const declared = (await json(base, '/api/run-set')).json.budget
    assert.equal(declared.ceiling_tokens, 1000)
    assert.match(declared.provenance, /daemon/i)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-set and cell-health reject every non-GET method', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-readonly-views-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    assert.equal((await json(base, '/api/run-set', { method: 'POST' })).status, 405)
    assert.equal((await json(base, '/api/cell-health', { method: 'POST' })).status, 405)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('optional-column probe latches after both columns land', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-probe-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const p1 = (await json(base, '/api/health')).json.probe
    const p2 = (await json(base, '/api/health')).json.probe
    assert.equal(p1.latched, false); assert.ok(p2.probes > p1.probes)
    const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
    writable.exec('ALTER TABLE sessions ADD COLUMN mode TEXT')
    writable.exec('ALTER TABLE sessions ADD COLUMN engineer TEXT')
    writable.close()
    const p3 = (await json(base, '/api/health')).json.probe
    const p4 = (await json(base, '/api/health')).json.probe
    assert.equal(p3.latched, true); assert.equal(p4.probes, p3.probes)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})
