import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn, spawn as spawnProcess, spawnSync } from 'node:child_process'
import { openLedger, NODE_FLOOR, replayJsonl, WRITERS } from '../scripts/factory/ledger.mjs'
import { parseCliArgs, ServerUsageError, startServer as startVisualizerServer } from '../visualizer/server/server.mjs'
import { createLedgerFeed } from '../visualizer/server/ledger-feed.mjs'
import { shapeIntake } from '../visualizer/server/shape.mjs'

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
function announceDetails(child) {
  return new Promise((resolve, reject) => {
    let output = '', error = ''
    const timer = setTimeout(() => reject(new Error(`server did not announce a port: ${error}`)), 10000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.listening) { clearTimeout(timer); resolve(value); return } } catch {}
      }
    })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('exit', (code) => { children.delete(child); clearTimeout(timer); reject(new Error(`server exited ${code}: ${error}`)) })
  })
}
const SERVER_SCRIPT = join(process.cwd(), 'visualizer', 'server', 'server.mjs')
function runServerCli(args, opts = {}) {
  return spawnSync(process.execPath, [SERVER_SCRIPT, ...args], { encoding: 'utf8', ...opts })
}
function startServer(ledgerDb, triageDb, crewRoot, rosterPath, environment = null, ladderPath = null, referencePath = null) {
  const args = ['visualizer/server/server.mjs', '--port', '0', '--ledger-db', ledgerDb, '--triage-db', triageDb]
  if (crewRoot) args.push('--crew-root', crewRoot)
  if (rosterPath) args.push('--roster', rosterPath)
  if (ladderPath) args.push('--ladder', ladderPath)
  if (referencePath) args.push('--model-reference', referencePath)
  const child = spawnProcess(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment ? { ...process.env, ...environment } : process.env })
  children.add(child)
  return announce(child).then((base) => ({ child, base }))
}
async function stopServer(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}
async function startInProcess(feed, options) {
  const handles = startVisualizerServer({ port: 0, host: '127.0.0.1', feed, ...options })
  await new Promise((resolve, reject) => {
    handles.server.once('error', reject)
    handles.server.once('listening', resolve)
  })
  return { ...handles, base: `http://127.0.0.1:${handles.server.address().port}` }
}
async function stopInProcess(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
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

test('cell attribution names a run\'s failed seats', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done } = fixture(ledgerDb)
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const response = await json(started.base, '/api/cell-attribution')
    assert.equal(response.status, 200)
    const run = response.json.runs.find((candidate) => candidate.adw_id === done)
    assert.ok(run)
    assert.equal(run.state, 'recorded')
    assert.equal(run.failures, 2)
    const timeout = run.seats.find((seat) => seat.role === 'planner' && seat.kind === 'timeout')
    const died = run.seats.find((seat) => seat.role === 'builder' && seat.kind === 'seat-died')
    assert.ok(timeout); assert.ok(died)
    for (const seat of [timeout, died]) {
      assert.equal(seat.provider, 'anthropic')
      assert.equal(seat.model_id, 'viz-cell-a')
      assert.equal(seat.agent, 'claude')
      assert.equal(seat.effort, 'high')
      assert.match(seat.key, /^anthropic\/viz-cell-a/)
    }
  } finally {
    await stopInProcess(server)
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a run with no cell failure is a measured zero', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-clean-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { pane } = fixture(ledgerDb)
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const response = await json(started.base, '/api/cell-attribution')
    assert.equal(response.status, 200)
    const run = response.json.runs.find((candidate) => candidate.adw_id === pane)
    assert.ok(run)
    assert.equal(run.measured, true)
    assert.equal(run.state, 'clean')
    assert.equal(run.failures, 0)
    assert.deepEqual(run.seats, [])
    assert.ok(run.why)
    assert.notDeepEqual({ measured: run.measured, state: run.state, failures: run.failures, seats: run.seats }, { measured: false, state: 'undetermined', failures: null, seats: [] })
  } finally {
    await stopInProcess(server)
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run-less and unregistered-run failures are surfaced, never reassigned', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-orphans-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const ledger = openLedger({ dbPath: ledgerDb })
  const ghost = 'test-ghost-0000-0000-000000000009'
  ledger.recordCellFailure({ provider: 'anthropic', model_id: 'orphan-cell', agent: 'claude', effort: 'high', role: 'reviewer', kind: 'no-envelope', dispatch_id: 'ghost-d1', adw_id: ghost, created_at: new Date().toISOString() })
  ledger.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const response = await json(started.base, '/api/cell-attribution')
    assert.equal(response.status, 200)
    const rows = response.json.unattributable
    const runless = rows.filter((row) => row.adw_id == null)
    assert.equal(runless.length, 2)
    assert.ok(runless.every((row) => row.why.includes('no adw_id')))
    const orphan = rows.find((row) => row.adw_id === ghost)
    assert.ok(orphan)
    assert.match(orphan.why, /does not register/)
    const seats = response.json.runs.flatMap((run) => run.seats)
    assert.equal(seats.some((seat) => seat.model_id === 'orphan-cell'), false)
    assert.equal(seats.some((seat) => seat.kind === 'boot-refusal'), false)
  } finally {
    await stopInProcess(server)
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mirror without cell_failures answers unanswerable, not zero', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-absent-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('DROP TABLE cell_failures')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const response = await json(started.base, '/api/cell-attribution')
    assert.equal(response.status, 200)
    assert.ok(response.json.absent)
    for (const run of response.json.runs) {
      assert.equal(run.measured, false)
      assert.equal(run.state, 'undetermined')
      assert.equal(run.failures, null)
      assert.deepEqual(run.seats, [])
    }
    assert.deepEqual(response.json.unattributable, [])
    assert.deepEqual(response.json.totals, { runs: null, failures: null, attributed: null, unattributable: null })
    assert.doesNotMatch(JSON.stringify(response.json), /"(failures|attributed|unattributable)":\s*0/)
  } finally {
    await stopInProcess(server)
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the window-wide cell readout is unchanged', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-health-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const response = await json(started.base, '/api/cell-health')
    assert.equal(response.status, 200)
    const cellA = response.json.cells.find((cell) => cell.model_id === 'viz-cell-a')
    assert.ok(cellA)
    assert.equal(cellA.failures, 2)
    assert.equal(cellA.run_less, 1)
    const cellB = response.json.cells.find((cell) => cell.model_id === 'viz-cell-b')
    assert.equal(cellB.state, 'run-less-only')
  } finally {
    await stopInProcess(server)
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the cell attribution route refuses a non-GET and a bad window', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cell-attribution-window-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  let server
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    assert.equal((await json(started.base, '/api/cell-attribution', { method: 'POST' })).status, 405)
    assert.equal((await json(started.base, '/api/cell-attribution?since=not-a-date')).status, 400)
    const since = encodeURIComponent('2024-01-02T00:00:00.000Z'), until = encodeURIComponent('2024-01-01T00:00:00.000Z')
    assert.equal((await json(started.base, `/api/cell-attribution?since=${since}&until=${until}`)).status, 400)
  } finally {
    await stopInProcess(server)
    feed.close()
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

test('viz-run-set-latch — a transient fault degrades only the request it broke', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-latch-transient-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const { done } = fixture(ledgerDb)
  let calls = 0, server
  const feed = {
    runSet() {
      calls += 1
      return calls === 1
        ? { rows: null, absent: 'database is locked' }
        : { rows: [{ adw_id: done, status: 'ok' }], absent: null }
    },
    health: () => ({ degraded: false }),
    _reason: () => 'database is locked',
    close: () => {},
  }
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const during = await json(started.base, '/api/run-set')
    assert.equal(during.status, 200)
    assert.equal(during.json.degraded, true)
    assert.equal(during.json.runs, null)
    assert.match(during.json.degraded_reason, /database is locked/)
    const after = [await json(started.base, '/api/run-set'), await json(started.base, '/api/run-set')]
    for (const response of after) {
      assert.equal(response.status, 200)
      assert.equal(response.json.degraded, false)
      assert.equal(response.json.degraded_reason, null)
      assert.equal(response.json.absent, null)
      assert.ok(response.json.runs >= 1)
    }
    assert.equal(calls, 3)
  } finally {
    await stopInProcess(server)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('viz-run-set-latch — a sustained fault stays unanswerable while it lasts', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-run-set-latch-sustained-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  let server
  const feed = {
    runSet: () => ({ rows: null, absent: 'database is locked' }),
    health: () => ({ degraded: false }),
    _reason: () => 'database is locked',
    close: () => {},
  }
  try {
    const started = await startInProcess(feed, { ledgerDb, triageDb, crewRoot: dir, checkout: dir })
    server = started.server
    const responses = [await json(started.base, '/api/run-set'), await json(started.base, '/api/run-set'), await json(started.base, '/api/run-set')]
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.equal(response.json.degraded, true)
      assert.equal(response.json.runs, null)
      assert.ok(typeof response.json.absent === 'string' && response.json.absent.length > 0)
      assert.doesNotMatch(JSON.stringify(response.json), /"runs":0/)
    }
  } finally {
    await stopInProcess(server)
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

test('the feed reads sweeps, refusals and the un-windowed sweep probe', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-feed-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const ledger = openLedger({ dbPath: ledgerDb })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 1, pages: 1, created_at: '2023-12-31T00:00:00.000Z' })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 2, pages: 1, created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'picked', picked_issue: 7, considered: 2, pages: 1, created_at: '2024-01-01T01:00:00.000Z' })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'parked', reason: 'stop-switch', considered: 2, pages: 1, created_at: '2024-01-01T02:00:00.000Z' })
  ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 8, reason: 'intake-block-missing', created_at: '2024-01-01T00:30:00.000Z' })
  ledger.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb })
  try {
    const result = feed.intake({ since: '2024-01-01T00:00:00.000Z', until: null })
    assert.equal(result.absent, null)
    assert.equal(result.sweeps.length, 3)
    assert.equal(result.sweeps.find((row) => row.outcome === 'none').count, 1)
    assert.equal(result.sweeps.find((row) => row.outcome === 'parked').reason, 'stop-switch')
    assert.equal(result.refusals[0].reason, 'intake-block-missing')
    assert.equal(result.ever.sweeps, 4)
    assert.equal(result.picks[0].picked_issue, 7)
    const view = shapeIntake({ ...result, since: '2024-01-01T00:00:00.000Z', until: null, label: 'last 24 hours' })
    assert.equal(view.refusals.groups[1].reasons.find((row) => row.reason === 'stop-switch').count, 1)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mirror without intake tables is unanswerable, not empty', { skip: SKIP }, () => {
  const makeLedger = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix)), ledgerDb = join(dir, 'ledger.db')
    const ledger = openLedger({ dbPath: ledgerDb })
    ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 1, pages: 1, created_at: '2024-01-01T00:00:00.000Z' })
    ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 8, reason: 'stop-switch', created_at: '2024-01-01T00:00:01.000Z' })
    ledger.close()
    return { dir, ledgerDb }
  }
  const absentDir = makeLedger('visualizer-intake-absent-')
  const absentDb = new (require('node:sqlite').DatabaseSync)(absentDir.ledgerDb)
  absentDb.exec('DROP TABLE intake_sweeps')
  absentDb.close()
  const absentFeed = createLedgerFeed({ ledgerDb: absentDir.ledgerDb, triageDb: join(absentDir.dir, 'visualizer.db') })
  try {
    const result = absentFeed.intake({ since: new Date(0).toISOString() })
    assert.equal(result.sweeps, null)
    assert.ok(result.absent)
    assert.doesNotMatch(JSON.stringify(result), /"swept":\s*0/)
  } finally {
    absentFeed.close()
    rmSync(absentDir.dir, { recursive: true, force: true })
  }
  const refusalDir = makeLedger('visualizer-intake-refusal-absent-')
  const refusalDb = new (require('node:sqlite').DatabaseSync)(refusalDir.ledgerDb)
  refusalDb.exec('DROP TABLE intake_refusals')
  refusalDb.close()
  const refusalFeed = createLedgerFeed({ ledgerDb: refusalDir.ledgerDb, triageDb: join(refusalDir.dir, 'visualizer.db') })
  try {
    const result = refusalFeed.intake({ since: new Date(0).toISOString() })
    assert.ok(Array.isArray(result.sweeps))
    assert.equal(result.refusals, null)
    assert.ok(result.refusals_absent)
  } finally {
    refusalFeed.close()
    rmSync(refusalDir.dir, { recursive: true, force: true })
  }
})

test('an additively added intake column does not break the view', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-column-'))
  const ledgerDb = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath: ledgerDb })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 1, pages: 1, created_at: '2024-01-01T00:00:00.000Z' })
  ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 8, reason: 'stop-switch', created_at: '2024-01-01T00:00:01.000Z' })
  ledger.close()
  const writable = new (require('node:sqlite').DatabaseSync)(ledgerDb)
  writable.exec('ALTER TABLE intake_sweeps ADD COLUMN future_note TEXT')
  writable.exec('ALTER TABLE intake_refusals ADD COLUMN future_note TEXT')
  writable.close()
  const feed = createLedgerFeed({ ledgerDb, triageDb: join(dir, 'visualizer.db') })
  try {
    const result = feed.intake({ since: new Date(0).toISOString() })
    assert.equal(result.absent, null)
    assert.ok(result.sweeps.length)
    assert.ok(result.refusals.length)
  } finally {
    feed.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/intake serves the loop read-only', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-http-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const ledger = openLedger({ dbPath: ledgerDb })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'none', considered: 1, pages: 1, created_at: '2024-01-01T00:00:00.000Z' })
  ledger.close()
  const before = digest(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const response = await json(base, '/api/intake')
    assert.equal(response.status, 200)
    assert.ok(response.json.loop.state)
    assert.ok(response.json.window.label)
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await json(base, '/api/intake', { method })).status, 405)
    assert.equal((await json(base, '/api/intake?since=not-a-date')).status, 400)
    const since = encodeURIComponent('2024-01-02T00:00:00.000Z'), until = encodeURIComponent('2024-01-01T00:00:00.000Z')
    assert.equal((await json(base, `/api/intake?since=${since}&until=${until}`)).status, 400)
    await stopServer(child); child = null
    assert.equal(digest(ledgerDb), before)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/intake exposes latest per-issue verdicts from the ledger feed', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-candidates-http-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const ledger = openLedger({ dbPath: ledgerDb })
  // Newest first deliberately: a last-inserted read would choose tier-judge.
  ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 7, reason: 'protected-path', detail: 'newer', priority: 'P1', created_at: '2026-01-02T00:00:00.000Z' })
  ledger.recordIntakeRefusal({ board_owner: 'owner', board_project: 1, issue: 7, reason: 'tier-judge', detail: 'older', priority: 'P1', created_at: '2026-01-01T00:00:00.000Z' })
  ledger.recordIntakeSweep({ board_owner: 'owner', board_project: 1, outcome: 'picked', considered: 2, pages: 1, picked_issue: 9, created_at: '2026-01-02T00:00:30.000Z' })
  ledger.close()
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const response = await json(base, '/api/intake?since=2026-01-01T00:00:00.000Z')
    assert.equal(response.status, 200)
    const items = response.json.candidates.items
    assert.deepEqual(items.map((item) => item.issue), [7, 9])
    assert.equal(items[0].verdict, 'would-refuse')
    assert.equal(items[0].reason, 'protected-path')
    assert.equal(items[1].verdict, 'would-take')
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/intake/brake writes and re-reads the stop switch without touching a run', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-brake-http-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db'), checkout = join(dir, 'checkout'), crewRoot = join(dir, 'crew')
  mkdirSync(crewRoot, { recursive: true }); writeFileSync(join(crewRoot, 'session.txt'), 'in flight\n')
  const ledger = openLedger({ dbPath: ledgerDb })
  ledger.startSession({ adw_id: 'run-in-flight', repo_slug: 'repo', task_slug: 'task' })
  ledger.close()
  const beforeLedger = openLedger({ dbPath: ledgerDb })
  const beforeSessions = beforeLedger.dumpTable('sessions')
  beforeLedger.close()
  const crewBefore = treeDigest(crewRoot)
  const switchPath = join(checkout, '.factory', 'STOP')
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, crewRoot, null, { DEVTEAM_INTAKE_CHECKOUT: checkout }))
    const engaged = await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: true, actor: 'ops' }) })
    assert.equal(engaged.status, 200); assert.equal(engaged.json.ok, true); assert.equal(engaged.json.state, 'engaged')
    assert.equal(engaged.json.path, switchPath); assert.equal(engaged.json.checkout, checkout); assert.equal(existsSync(switchPath), true)
    const readEngaged = await json(base, '/api/intake/brake')
    assert.equal(readEngaged.json.state, 'engaged')
    let boardCalls = 0
    const { intakeSweep } = await import('../scripts/factory/intake.mjs')
    const parked = intakeSweep({
      board: { owner: 'owner', projectNumber: 1 }, checkout, dbPath: null, config: {},
      deps: { now: () => Date.parse('2026-01-02T00:01:00.000Z'), runsInWindow: () => 0, github: () => { boardCalls += 1; return { data: {}, rateLimit: null } } },
    })
    assert.equal(parked.outcome, 'parked'); assert.equal(parked.reason, 'stop-switch'); assert.equal(boardCalls, 0)
    rmSync(switchPath, { force: true })
    const readClear = await json(base, '/api/intake/brake')
    assert.equal(readClear.json.state, 'clear')
    const cleared = await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: false, actor: 'ops' }) })
    assert.equal(cleared.status, 200); assert.equal(cleared.json.ok, true); assert.equal(cleared.json.state, 'clear')
    await stopServer(child); child = null
    const after = openLedger({ dbPath: ledgerDb })
    assert.deepEqual(after.dumpTable('sessions'), beforeSessions)
    after.close()
    assert.equal(treeDigest(crewRoot), crewBefore)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/intake/brake attributes successful and failed transitions and its writer replays', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-intake-brake-ledger-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db'), checkout = join(dir, 'checkout')
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, null, null, { DEVTEAM_INTAKE_CHECKOUT: checkout }))
    assert.equal((await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: true, actor: 'ada' }) })).json.ok, true)
    assert.equal((await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: false, actor: 'ada' }) })).json.ok, true)
    await stopServer(child); child = null
    const badCheckout = join(dir, 'bad-checkout')
    mkdirSync(badCheckout, { recursive: true })
    writeFileSync(join(badCheckout, '.factory'), 'not a directory\n');
    ({ child, base } = await startServer(ledgerDb, triageDb, null, null, { DEVTEAM_INTAKE_CHECKOUT: badCheckout }))
    const failed = await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: true, actor: 'ada' }) })
    assert.equal(failed.status, 200); assert.equal(failed.json.ok, false); assert.equal(failed.json.wrote, false); assert.equal(failed.json.state, 'clear')
    assert.match(failed.json.error, /STOP|factory/)
    await stopServer(child); child = null

    const source = openLedger({ dbPath: ledgerDb })
    const rows = source.dumpTable('intake_brakes')
    const jsonlPath = source._jsonlPath
    assert.equal(WRITERS.includes('recordIntakeBrake'), true)
    assert.equal(typeof source.recordIntakeBrake, 'function')
    assert.equal(rows.filter((row) => row.outcome === 'ok').length, 2)
    assert.equal(rows.filter((row) => row.outcome === 'failed').length, 1)
    assert.ok(rows.every((row) => row.actor === 'ada' && /^\d{4}-\d{2}-\d{2}T/.test(row.created_at)))
    source.close()
    const replayed = openLedger({ dbPath: join(dir, 'replayed.db') })
    assert.doesNotThrow(() => replayJsonl(jsonlPath, replayed))
    assert.deepEqual(replayed.dumpTable('intake_brakes').map((row) => ({ checkout: row.checkout, path: row.path, transition: row.transition, actor: row.actor, outcome: row.outcome, detail: row.detail, created_at: row.created_at })), rows.map((row) => ({ checkout: row.checkout, path: row.path, transition: row.transition, actor: row.actor, outcome: row.outcome, detail: row.detail, created_at: row.created_at })))
    replayed.close()

    const markerDb = join(dir, 'marker.db'), marker = openLedger({ dbPath: markerDb, jsonlPath: join(dir, 'marker.jsonl') })
    const markerArgs = marker.recordIntakeBrake({ checkout: 'devteam-done-checkout', path: 'devteam-done-path', transition: 'engaged', actor: 'devteam-done-actor', outcome: 'ok', detail: 'marker', created_at: '2026-01-02T00:00:00.000Z' })
    assert.equal(markerArgs.checkout, 'redacted')
    assert.equal(markerArgs.path, 'redacted')
    assert.equal(markerArgs.actor, 'redacted')
    const markerJsonl = marker._jsonlPath
    marker.close()
    const markerReplay = openLedger({ dbPath: join(dir, 'marker-replayed.db') })
    assert.doesNotThrow(() => replayJsonl(markerJsonl, markerReplay))
    assert.deepEqual(markerReplay.dumpTable('intake_brakes').map((row) => ({ checkout: row.checkout, path: row.path, actor: row.actor })), [{ checkout: 'redacted', path: 'redacted', actor: 'redacted' }])
    markerReplay.close()
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('operator brake chain: engaging through the operator path stops a real sweep, clearing releases it, and a mid-flight arm stops the next tick', { skip: SKIP }, async () => {
  // SEAM: the browser is stubbed, nothing else. This test issues the exact request
  // visualizer/web/src/lib/api.js:21 setIntakeBrake issues, against the real server
  // child on a real socket, so what stays unproven is only the Svelte toggle's own
  // wiring to setIntakeBrake -- not the endpoint, the write, the audit row, or the
  // sweep's read of it. The mid-flight arm is posted from a child process because
  // intakeLoop is synchronous and cannot await inside its sleep dep; the request it
  // makes is byte-identical to the one the in-process halves make.
  const boardField = (name, value) => ({ name: value, field: { name } })
  const readyItem = (number) => ({ id: `ITEM-${number}`, content: { number, title: `Issue ${number}`, url: `https://example.test/issues/${number}`, body: 'ask: Prove the brake chain end to end\nwhere: scripts/factory/intake.mjs\ndone-means: The chain is proven\nout-of-scope: Dispatching policy', createdAt: '2025-12-01T00:00:00Z' }, fieldValues: { nodes: [boardField('Status', 'Ready'), boardField('Priority', 'P1')] } })
  const boardPage = (nodes) => ({ data: { user: { projectV2: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } }, rateLimit: { remaining: 900, resetAt: '2026-01-02T01:00:00Z' } })

  const dir = mkdtempSync(join(tmpdir(), 'visualizer-brake-chain-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  const checkout = join(dir, 'checkout'), crewRoot = join(dir, 'crew')
  mkdirSync(join(checkout, 'scripts', 'factory'), { recursive: true })
  writeFileSync(join(checkout, 'scripts', 'factory', 'intake.mjs'), 'export const marker = 1\n')
  mkdirSync(crewRoot, { recursive: true })
  spawnSync('git', ['init', '-q', checkout], { encoding: 'utf8' })
  const switchPath = join(checkout, '.factory', 'STOP')

  let boardCalls = 0, moveCalls = 0, nowCalls = 0
  const chainDeps = {
    now: () => Date.parse('2026-01-02T00:01:00.000Z') + nowCalls++,
    runsInWindow: () => 0,
    github: () => { boardCalls += 1; return boardPage([readyItem(4440)]) },
    branchFor: () => 'intake-4440',
    // A failed board write refuses the dispatch at intake.mjs:1244 BEFORE crewBoot,
    // so reaching dispatch is measurable without booting anything.
    boardMove: () => { moveCalls += 1; return { ok: false, status: null } },
    crewBoot: () => { throw new Error('the crossing test must never boot a crew') },
    crewRun: () => { throw new Error('the crossing test must never run a crew') },
  }
  const board = { owner: 'example-owner', projectNumber: 7 }
  const config = { windowCap: 99, protectedPaths: [] }

  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, crewRoot, null, { DEVTEAM_INTAKE_CHECKOUT: checkout }))
    const { intakeRun, intakeLoop } = await import('../scripts/factory/intake.mjs')

    // CHAIN-ENGAGE-HOOK
    const engaged = await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: true, actor: 'ops-engage' }) })
    assert.equal(engaged.status, 200)
    assert.equal(engaged.json.ok, true)
    assert.equal(engaged.json.state, 'engaged')
    assert.equal(engaged.json.path, switchPath)
    assert.equal(JSON.parse(readFileSync(switchPath, 'utf8')).actor, 'ops-engage')

    const braked = intakeRun({ board, checkout, dbPath: ledgerDb, config, deps: chainDeps })
    assert.equal(braked.sweep.outcome, 'parked')
    assert.equal(braked.sweep.reason, 'stop-switch')
    assert.equal(braked.dispatch, null)
    assert.equal(braked.promotions.length, 0)
    assert.equal(boardCalls, 0)
    assert.equal(moveCalls, 0)

    const cleared = await json(base, '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: false, actor: 'ops-release' }) })
    assert.equal(cleared.json.ok, true)
    assert.equal(cleared.json.state, 'clear')
    assert.equal(existsSync(switchPath), false)

    const released = intakeRun({ board, checkout, dbPath: ledgerDb, config, deps: chainDeps })
    assert.equal(released.sweep.ok, true)
    assert.notEqual(released.sweep.reason, 'stop-switch')
    assert.equal(released.sweep.outcome, 'picked')
    assert.equal(released.sweep.picked.issue, 4440)
    assert.equal(boardCalls, 1)
    assert.equal(moveCalls, 1)
    assert.equal(released.dispatch.outcome, 'refused')
    assert.equal(released.dispatch.reason, 'board-write-failed')

    // sleep: the injected dep arms the brake between loop ticks.
    let arms = 0
    const sleep = () => {
      arms += 1
      if (arms > 1) return
      const armed = spawnSync(process.execPath, ['-e', `
        (async () => {
          const res = await fetch(process.argv[1] + '/api/intake/brake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engaged: true, actor: 'ops-midflight' }) })
          const value = await res.json()
          if (value.ok !== true || value.state !== 'engaged') { console.error(JSON.stringify(value)); process.exit(1) }
        })().catch((err) => { console.error(err); process.exit(1) })
      `.replace(/^\s*/gm, ''), base], { encoding: 'utf8' })
      assert.equal(armed.status, 0, armed.stderr)
    }
    const loop = intakeLoop({ board, checkout, dbPath: ledgerDb, config, deps: { ...chainDeps, sleep: sleep }, maxTicks: 3 })
    assert.equal(loop.ok, true)
    assert.equal(loop.stopped, true)
    assert.equal(loop.ticks.length, 2)
    assert.equal(loop.ticks[0].swept, true)
    assert.equal(loop.ticks[0].run.sweep.ok, true)
    assert.equal(loop.ticks[0].outcome, 'picked')
    assert.equal(loop.ticks[0].reason, null)
    assert.ok(Number.isFinite(Date.parse(loop.ticks[0].started_at)))
    assert.equal(loop.ticks[1].swept, false)
    assert.equal(loop.ticks[1].outcome, 'parked')
    assert.equal(loop.ticks[1].reason, 'stop-switch')
    assert.equal(loop.ticks[1].run, null)
    assert.equal(boardCalls, 2)

    await stopServer(child); child = null
    let ledger
    try {
      ledger = openLedger({ dbPath: ledgerDb })
      const brakes = ledger.dumpTable('intake_brakes').sort((a, b) => a.id - b.id)
      assert.deepEqual(brakes.map((row) => row.actor), ['ops-engage', 'ops-release', 'ops-midflight'])
      assert.deepEqual(brakes.map((row) => row.transition), ['engaged', 'cleared', 'engaged'])
      assert.ok(brakes.every((row) => row.outcome === 'ok'))
      assert.ok(brakes.every((row) => row.path === switchPath))
      const sweeps = ledger.dumpTable('intake_sweeps')
      assert.ok(sweeps.filter((row) => row.reason === 'stop-switch' && row.outcome === 'parked').length >= 2)
      assert.ok(sweeps.some((row) => row.outcome === 'picked'))
    } finally {
      ledger?.close()
    }
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('viz-cli-unknown-flag-refusal — an unknown flag or a bad flag value refuses with exit 2 and never leaks a stack', () => {
  const cases = [
    { args: ['--port', '0', '--bogus', 'zzz'], error: /unknown flag --bogus/ },
    { args: ['--port', 'definitely-not-a-port'], error: /--port must be an integer/ },
    { args: ['--port', '70000'], error: /--port must be an integer/ },
    { args: ['--host'], error: /--host requires a value/ },
    { args: ['4488'], error: /unexpected argument 4488/ },
  ]
  for (const { args, error } of cases) {
    const result = runServerCli(args)
    assert.equal(result.status, 2, result.stderr || result.error?.message)
    assert.match(result.stderr, error)
    assert.doesNotMatch(result.stderr, /RangeError|ERR_SOCKET_BAD_PORT/)
    assert.doesNotMatch(result.stdout, /"listening":true/)
  }
})

test('the visualizer CLI still accepts every flag it reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cli-flags-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'triage.db'), crewRoot = join(dir, 'crew')
  const checkout = join(dir, 'checkout'), roster = join(dir, 'roster.json'), ladder = join(dir, 'ladder.json'), reference = join(dir, 'reference.json')
  const args = [
    SERVER_SCRIPT, '--port', '0', '--host', '127.0.0.1', '--ledger-db', ledgerDb, '--triage-db', triageDb,
    '--crew-root', crewRoot, '--checkout', checkout, '--roster', roster, '--ladder', ladder, '--model-reference', reference,
  ]
  let child
  try {
    child = spawnProcess(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    const announced = await announceDetails(child)
    assert.equal(announced.listening, true)
    assert.equal(announced.ledger_db, ledgerDb)
    assert.equal(announced.crew_root, crewRoot)
    assert.ok(Number.isInteger(announced.port) && announced.port > 0, `expected an ephemeral port, got ${announced.port}`)
    await stopServer(child); child = null
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('viz-port-env-door — DEVTEAM_VIZ_PORT=0 binds an ephemeral port and an absent value keeps 4488', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-port-env-'))
  const ledgerDb = join(dir, 'ledger.db')
  let child
  try {
    child = spawnProcess(process.execPath, [SERVER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVTEAM_VIZ_PORT: '0', DEVTEAM_LEDGER_DB: ledgerDb },
    })
    children.add(child)
    const announced = await announceDetails(child)
    assert.equal(announced.listening, true)
    assert.ok(Number.isInteger(announced.port) && announced.port > 0)
    assert.notEqual(announced.port, 4488)
    await stopServer(child); child = null

    const env = { ...process.env }
    delete env.DEVTEAM_VIZ_PORT
    const script = `import(${JSON.stringify(new URL('../visualizer/server/server.mjs', import.meta.url).href)}).then((m) => process.stdout.write(String(m.parseCliArgs([]).port)))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 20000, killSignal: 'SIGKILL' })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal(result.stdout.trim(), '4488')
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('viz-port-env-door — a bad DEVTEAM_VIZ_PORT refuses like the flag does', () => {
  const env = { ...process.env }
  delete env.DEVTEAM_VIZ_PORT
  for (const value of ['70000', 'definitely-not-a-port']) {
    const result = runServerCli([], { env: { ...env, DEVTEAM_VIZ_PORT: value }, timeout: 20000, killSignal: 'SIGKILL' })
    assert.equal(result.status, 2, result.stderr || result.error?.message)
    assert.match(result.stderr, new RegExp(`DEVTEAM_VIZ_PORT must be an integer between 0 and 65535, found ${value}`))
    assert.doesNotMatch(result.stderr, /RangeError|ERR_SOCKET_BAD_PORT/)
    assert.doesNotMatch(result.stdout, /"listening":true/)
  }
  for (const value of ['70000', 'definitely-not-a-port', '']) {
    const result = runServerCli(['--port', value], { env, timeout: 20000, killSignal: 'SIGKILL' })
    assert.equal(result.status, 2, result.stderr || result.error?.message)
    assert.match(result.stderr, /--port must be an integer between 0 and 65535, found/)
    assert.doesNotMatch(result.stderr, /RangeError|ERR_SOCKET_BAD_PORT/)
    assert.doesNotMatch(result.stdout, /"listening":true/)
  }
})

test('a genuine internal failure still exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cli-eaddrinuse-'))
  const blocker = createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolve)
  })
  try {
    const port = blocker.address().port
    const result = runServerCli(['--port', String(port), '--ledger-db', join(dir, 'ledger.db'), '--triage-db', join(dir, 'triage.db')])
    assert.equal(result.status, 1, result.stderr || result.error?.message)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseCliArgs maps every visualizer flag and refuses an unknown flag', () => {
  const parsed = parseCliArgs([
    '--port', '1234', '--host', '127.0.0.2', '--ledger-db', 'ledger.db', '--triage-db', 'triage.db',
    '--crew-root', 'crew', '--checkout', 'checkout', '--roster', 'roster.json', '--ladder', 'ladder.json', '--model-reference', 'reference.json',
  ])
  assert.equal(parsed.port, 1234)
  assert.equal(parsed.host, '127.0.0.2')
  assert.equal(parsed.ledgerDb, 'ledger.db')
  assert.equal(parsed.triageDb, 'triage.db')
  assert.equal(parsed.crewRoot, 'crew')
  assert.equal(parsed.checkout, 'checkout')
  assert.equal(parsed.rosterPath, 'roster.json')
  assert.equal(parsed.ladderPath, 'ladder.json')
  assert.equal(parsed.referencePath, 'reference.json')
  assert.throws(() => parseCliArgs(['--bogus', 'value']), (error) => {
    assert.ok(error instanceof ServerUsageError)
    assert.match(error.message, /unknown flag --bogus/)
    return true
  })
})

test('intake console keeps the stop-switch path in lockstep and has no boot or git-write surface', async () => {
  const { STOP_SWITCH_PATH } = await import('../visualizer/server/server.mjs')
  const { DEFAULT_INTAKE_CONFIG } = await import('../scripts/factory/intake.mjs')
  assert.equal(STOP_SWITCH_PATH, DEFAULT_INTAKE_CONFIG.stopSwitchPath)
  const files = [
    'visualizer/server/server.mjs', 'visualizer/server/shape.mjs', 'visualizer/server/ledger-feed.mjs',
    'visualizer/web/src/lib/IntakePanel.svelte', 'visualizer/web/src/lib/panels.js', 'visualizer/web/src/lib/api.js',
  ]
  const banned = [/node:child_process/, /\bspawnSync\b|\bspawn\(/, /['"`]\/api\/(boot|launch|merge|push)/, /\bgit (push|merge|commit)\b/, /\bgh (pr|api|issue) /, /crewBoot|crewRun/, /scripts\/factory\/intake\.mjs/]
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    for (const pattern of banned) assert.doesNotMatch(source, pattern, file)
  }
})

test('roster ladder routes stage and compose read-only bundles', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-roster-ladder-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db')
  fixture(ledgerDb)
  const rosterPath = join(process.cwd(), 'crew', 'roster.json')
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))
  const before = digest(rosterPath)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb))
    const view = await json(base, '/api/roster/ladder')
    assert.equal(view.status, 200); assert.equal(view.json.degraded, false); assert.ok(view.json.bands.length); assert.ok(view.json.rail.length)
    for (const method of ['POST', 'PUT']) assert.equal((await json(base, '/api/roster/ladder', { method })).status, 405)
    assert.equal((await json(base, '/api/roster/ladder/stage')).status, 405)
    assert.equal((await json(base, '/api/roster/ladder/stage', { method: 'POST', body: '{ not json' })).status, 400)
    assert.equal((await json(base, '/api/roster/ladder/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
    const legal = await json(base, '/api/roster/ladder/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves: [{ tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: 'high' } }] }) })
    assert.equal(legal.status, 200); assert.equal(legal.json.ok, true); assert.match(legal.json.diff, /^--- a\/crew\/roster\.json/m); assert.equal(legal.json.checks.length, 4)
    const illegal = await json(base, '/api/roster/ladder/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves: [{ tier: 'build', role: 'builder', cell: { provider: 'anthropic', id: 'claude-haiku-4-5', agent: 'claude', effort: 'medium' } }] }) })
    assert.equal(illegal.status, 200); assert.equal(illegal.json.ok, false); assert.equal(illegal.json.diff, null); assert.equal(illegal.json.checks.find((check) => check.check === 'band_floor').ok, false)
    const composed = await json(base, '/api/roster/ladder/compose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves: [{ tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: 'high' } }] }) })
    assert.equal(composed.status, 200); assert.equal(composed.json.ok, true); assert.ok(composed.json.branch); assert.ok(composed.json.commit_subject); assert.match(composed.json.patch, /^--- a\/crew\/roster\.json/m); assert.equal(composed.json.applyable_with, 'git apply / patch -p1')
    await stopServer(child); child = null
    assert.equal(digest(rosterPath), before)
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ladder HTTP requests degrade honestly for missing ladder and reference files', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-roster-ladder-degraded-'))
  const ledgerDb = join(dir, 'ledger.db'), triageDb = join(dir, 'visualizer.db'), missingLadder = join(dir, 'missing-ladder.json'), missingReference = join(dir, 'missing-reference.json')
  fixture(ledgerDb)
  let child, base
  try {
    ({ child, base } = await startServer(ledgerDb, triageDb, null, null, null, missingLadder, missingReference))
    const response = await json(base, '/api/roster/ladder')
    assert.equal(response.status, 200); assert.equal(response.json.degraded, true); assert.equal(response.json.bands, null); assert.equal(response.json.chips, null); assert.match(response.json.error, /missing-ladder/)
    await stopServer(child); child = null
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ladder source and API calls carry the required drag surface', () => {
  const panel = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/RosterPanel.svelte'), 'utf8')
  const api = readFileSync(join(process.cwd(), 'visualizer/web/src/lib/api.js'), 'utf8')
  for (const needle of ['draggable', 'ondragstart', 'ondragover', 'ondrop', 'reference_pending', 'measured_pending', 'drift', 'band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling']) assert.match(panel, new RegExp(needle))
  assert.doesNotMatch(panel, /blended|composite|overall_score|combined_score/); assert.doesNotMatch(panel, /--role-|--lane-\d/); assert.match(api, /getRosterLadder|stageRosterLadder|composeRosterLadder/); assert.match(api, /\/api\/roster\/ladder/)
})
