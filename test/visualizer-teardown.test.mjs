import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { openLedger, NODE_FLOOR, SEAT_TEARDOWN_OUTCOMES as LEDGER_OUTCOMES } from '../scripts/factory/ledger.mjs'
import { createLedgerFeed } from '../visualizer/server/ledger-feed.mjs'
import { defaultTeardownWindow, SEAT_TEARDOWN_OUTCOMES, shapeSeatTeardowns } from '../visualizer/server/shape.mjs'
import { teardownPanel } from '../visualizer/web/src/lib/panels.js'
import { sqliteAvailable } from './helpers.mjs'

const SKIP = sqliteAvailable() ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`
const children = new Set()
after(() => { for (const child of children) { try { child.kill('SIGKILL') } catch {} } })

function windowForNow() {
  return defaultTeardownWindow(Date.now())
}

function openFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-teardown-'))
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  return { dir, dbPath, ledger }
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
        try {
          const value = JSON.parse(line)
          if (value.listening) {
            clearTimeout(timer)
            resolve(`http://127.0.0.1:${value.port}`)
            return
          }
        } catch {}
      }
    })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('exit', (code) => {
      children.delete(child)
      clearTimeout(timer)
      reject(new Error(`server exited ${code}: ${error}`))
    })
  })
}

function startServer(ledgerDb, triageDb) {
  const child = spawn(process.execPath, ['visualizer/server/server.mjs', '--port', '0', '--ledger-db', ledgerDb, '--triage-db', triageDb], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  return announce(child).then((base) => ({ child, base }))
}

async function stopServer(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}

test('empty table is not measured', { skip: SKIP }, () => {
  const { dir, dbPath, ledger } = openFixture()
  const adw_id = 'empty-0000-0000-0000-000000000001'
  try {
    ledger.startSession({ adw_id, repo_slug: 'repo', task_slug: 'empty', started_at: new Date().toISOString() })
    ledger.close()
    const feed = createLedgerFeed({ ledgerDb: dbPath, triageDb: join(dir, 'visualizer.db') })
    const window = windowForNow()
    const result = feed.seatTeardowns(window)
    assert.deepEqual(result.rows, [])
    assert.equal(result.absent, null)
    const payload = shapeSeatTeardowns({ ...result, ...window })
    assert.equal(payload.measured, false)
    const run = payload.runs.find((row) => row.adw_id === adw_id)
    assert.ok(run)
    assert.equal(run.state, 'not-measured')
    for (const value of Object.values(run.tally)) assert.equal(value, null)
    assert.doesNotMatch(JSON.stringify(run), /:\s*0\b/)
    feed.close()
  } finally {
    try { ledger.close() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mixed run renders all three outcomes', { skip: SKIP }, () => {
  const { dir, dbPath, ledger } = openFixture()
  const adw_id = 'mixed-0000-0000-0000-000000000001'
  try {
    ledger.startSession({ adw_id, repo_slug: 'repo', task_slug: 'mixed', started_at: new Date().toISOString() })
    ledger.recordSeatTeardown({ adw_id, role: 'planner', transport: 'pane', outcome: 'proven', reason: 'probe-dead', evidence_kind: 'probe' })
    ledger.recordSeatTeardown({ adw_id, role: 'builder', transport: 'pane', outcome: 'failed', reason: 'probe-alive', evidence_kind: 'probe' })
    ledger.recordSeatTeardown({ adw_id, role: 'reviewer', transport: 'pane', outcome: 'unproven', reason: 'probe-unknown', evidence_kind: 'probe' })
    ledger.close()
    const feed = createLedgerFeed({ ledgerDb: dbPath, triageDb: join(dir, 'visualizer.db') })
    const window = windowForNow()
    const result = feed.seatTeardowns(window)
    const payload = shapeSeatTeardowns({ ...result, ...window })
    const run = payload.runs.find((row) => row.adw_id === adw_id)
    assert.deepEqual(run.seats.map((seat) => seat.outcome), ['proven', 'failed', 'unproven'])
    assert.deepEqual(run.seats.map((seat) => seat.role), ['planner', 'builder', 'reviewer'])
    assert.deepEqual(run.tally, { seats: 3, proven: 1, failed: 1, unproven: 1, unrecognised: 0 })
    const panel = teardownPanel(payload)
    const viewRun = panel.rows.find((row) => row.adw_id === adw_id)
    assert.equal(viewRun.tone, 'leak')
    assert.equal(new Set(viewRun.seats.map((seat) => seat.tone)).size, 3)
    feed.close()
  } finally {
    try { ledger.close() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('absent is undetermined, not clean', () => {
  const payload = shapeSeatTeardowns({ runs: null, rows: null, absent: 'seat_teardowns predates this ledger mirror', since: 'window-start', until: null, label: 'window' })
  assert.equal(payload.measured, false)
  assert.deepEqual(payload.totals, { runs: null, seats: null, proven: null, failed: null, unproven: null, unrecognised: null })
  assert.equal(teardownPanel(payload).headline, 'Seat teardown is unavailable')
  assert.doesNotMatch(JSON.stringify(payload), /0/)
})

test('unknown outcome is never counted as clean', () => {
  const payload = shapeSeatTeardowns({
    runs: [{ adw_id: 'unknown', task_slug: 'task', repo_slug: 'repo', status: 'ok', started_at: 'window-start', ended_at: 'window-end' }],
    rows: [
      { adw_id: 'unknown', role: 'planner', outcome: 'gone', reason: 'future-word', forced: 0 },
      { adw_id: 'unknown', role: 'builder', outcome: 'proven', reason: 'probe-dead', forced: 1 },
    ],
    absent: null,
    since: 'window-start', until: null, label: 'window',
  })
  const run = payload.runs[0]
  const unknown = run.seats.find((seat) => seat.role === 'planner')
  assert.equal(unknown.outcome, 'gone')
  assert.equal(unknown.known, false)
  assert.equal(run.tally.unrecognised, 1)
  assert.deepEqual([run.tally.proven, run.tally.failed, run.tally.unproven], [1, 0, 0])
})

test('vocabulary is locked to the ledger', () => {
  assert.deepEqual([...SEAT_TEARDOWN_OUTCOMES], [...LEDGER_OUTCOMES])
})

test('HTTP route returns a read-only, unmeasured run', { skip: SKIP }, async () => {
  const { dir, dbPath, ledger } = openFixture()
  const adw_id = 'http-0000-0000-0000-000000000001'
  let child = null
  try {
    ledger.startSession({ adw_id, repo_slug: 'repo', task_slug: 'http', started_at: new Date().toISOString() })
    ledger.close()
    const started = await startServer(dbPath, join(dir, 'visualizer.db'))
    child = started.child
    const get = await json(started.base, '/api/seat-teardowns')
    assert.equal(get.status, 200)
    // The API schema is ONE shared constant for every route (visualizer/server/server.mjs:27).
    // It went 1 -> 2 when run_configurations joined the shape, and this is the only
    // route test that pinned the old number by hand.
    assert.equal(get.json.schema, 2)
    assert.ok(Array.isArray(get.json.runs))
    assert.equal(get.json.runs.find((row) => row.adw_id === adw_id)?.state, 'not-measured')
    assert.doesNotMatch(get.body, /"proven":0/)
    assert.equal((await json(started.base, '/api/seat-teardowns', { method: 'POST' })).status, 405)
    assert.equal((await json(started.base, '/api/seat-teardowns?since=nonsense')).status, 400)
    assert.equal((await json(started.base, '/api/seat-teardowns?since=2024-01-02T00:00:00.000Z&until=2024-01-01T00:00:00.000Z')).status, 400)
  } finally {
    if (child) await stopServer(child)
    try { ledger.close() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read-only surface has no control verbs', () => {
  const banned = [/node:child_process/, /spawn\(/, /process\.kill/, /SIGKILL/, /\/api\/(boot|launch|merge|push)/, /git (push|merge|commit)/, /closeSurface|closeWorkspace/]
  for (const path of ['visualizer/server/shape.mjs', 'visualizer/server/ledger-feed.mjs', 'visualizer/web/src/lib/panels.js', 'visualizer/web/src/lib/TeardownPanel.svelte']) {
    const source = readFileSync(path, 'utf8')
    for (const pattern of banned) assert.doesNotMatch(source, pattern, `${path} matches ${pattern}`)
  }
})

test('API and visualizer mount the teardown panel', () => {
  const api = readFileSync('visualizer/web/src/lib/api.js', 'utf8')
  const app = readFileSync('visualizer/web/src/App.svelte', 'utf8')
  const component = readFileSync('visualizer/web/src/lib/TeardownPanel.svelte', 'utf8')
  assert.match(api, /getSeatTeardowns/)
  assert.match(api, /\/api\/seat-teardowns/)
  assert.match(app, /<TeardownPanel\s*\/>/)
  assert.match(component, /\.proven\b/)
  assert.match(component, /\.failed\b/)
  assert.match(component, /\.unproven\b/)
  assert.doesNotMatch(component, /--role-|--lane-/)
})
