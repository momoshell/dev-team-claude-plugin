import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawn as spawnProcess } from 'node:child_process'
import { openLedger, NODE_FLOOR } from '../scripts/factory/ledger.mjs'

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
function startServer(ledgerDb, triageDb, crewRoot) {
  const args = ['visualizer/server/server.mjs', '--port', '0', '--ledger-db', ledgerDb, '--triage-db', triageDb]
  if (crewRoot) args.push('--crew-root', crewRoot)
  const child = spawnProcess(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  ledger.startSession({ adw_id: done, repo_slug: 'repo', task_slug: 'finished' })
  for (const [seq, name] of ['plan', 'build', 'review'].entries()) { ledger.startPhase({ adw_id: done, seq: seq + 1, name }); ledger.endPhase({ adw_id: done, seq: seq + 1, status: 'ok' }) }
  ledger.recordEvent({ adw_id: done, type: 'agent_start', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_end', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1', outcome: 'done' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_start', phase_id: 2, payload: { role: 'builder', dispatch_id: 'd2' } })
  ledger.recordEvent({ adw_id: done, type: 'agent_end', phase_id: 2, payload: { role: 'builder', dispatch_id: 'd2', outcome: 'done' } })
  for (let i = 0; i < filler; i += 1) ledger.recordEvent({ adw_id: done, type: 'log', payload: { level: 'info', message: `filler ${i}` } })
  ledger.endSession({ adw_id: done, status: 'ok' })
  ledger.startSession({ adw_id: live, repo_slug: 'repo', task_slug: 'live' })
  ledger.startPhase({ adw_id: live, seq: 1, name: 'plan' })
  ledger.recordEvent({ adw_id: live, type: 'agent_start', payload: { role: 'planner', dispatch_id: 'l1' } })
  ledger.close()
  return { done, live }
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
