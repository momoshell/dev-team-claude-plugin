import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { connect } from 'node:net'
import { spawn, spawn as spawnProcess, spawnSync } from 'node:child_process'
import { pluginWriteMode, pluginWriteTargetMode, hostGuard, ROUTE_PARAMS, ServerUsageError, startServer as startVisualizerServer, writeGuard } from '../visualizer/server/server.mjs'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import * as webApi from '../visualizer/web/src/lib/api.js'
import { ROOT, rawRequest, scratchDir } from './helpers.mjs'
const children = new Set()
after(() => { for (const child of children) { try { child.kill('SIGKILL') } catch {} } })
async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  return { status: response.status, body: text, json: JSON.parse(text), allow: response.headers.get('allow') }
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
const SERVER_SCRIPT = join(ROOT, 'visualizer', 'server', 'server.mjs')

function runServerCli(args, opts = {}) {
  return spawnSync(process.execPath, [SERVER_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', ...opts })
}
function startServer(ledgerDb, triageDb, crewRoot, rosterPath, environment = null) {
  // The ledger, triage, roster and ladder flags are gone with the old path; the leading arguments are accepted and ignored.
  const args = [SERVER_SCRIPT, '--port', '0']
  if (crewRoot) args.push('--crew-root', crewRoot)
  const child = spawnProcess(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEVTEAM_GITHUB_API_URL: TEST_GITHUB_API_URL, ...(environment || {}) } })
  children.add(child)
  return announce(child).then((base) => ({ child, base }))
}
async function stopServer(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}
async function startInProcess(feed, options = {}) {
  const handles = startVisualizerServer({ port: 0, host: '127.0.0.1', feed, checkout: ROOT, ...options, env: { ...process.env, DEVTEAM_GITHUB_API_URL: TEST_GITHUB_API_URL, ...(options.env || {}) } })
  await new Promise((resolve, reject) => {
    handles.server.once('error', reject)
    handles.server.once('listening', resolve)
  })
  return { ...handles, base: `http://127.0.0.1:${handles.server.address().port}` }
}
async function stopInProcess(server) {
  const target = server?.server ?? server
  if (target?.listening) {
    target.closeIdleConnections?.()
    target.closeAllConnections?.()
    await new Promise((resolve) => target.close(resolve))
  }
}
function rawStatus(response) {
  return Number((response.text.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0)
}
function fixture(path, { filler = 0 } = {}) {
  const ledger = openLedger({ dbPath: path })
  const done = 'test-done-0000-0000-000000000001'
  const live = 'test-live-0000-0000-000000000002'
  const pane = 'test-pane-0000-0000-000000000003'
  ledger.startSession({ adw_id: done, repo_slug: 'repo', task_slug: 'finished' })
  ledger.recordRunConfiguration({
    adw_id: done, schema_version: 1,
    task_profile: 'implementation', task_profile_source: 'explicit',
    requested_execution: null, effective_execution: 'full', execution_source: 'profile_recommendation',
    requested_assurance: 'standard', effective_assurance: 'standard', assurance_source: 'explicit',
    legacy_variant: null, legacy_tier: 'build',
  })
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

test('raw request targets are refused without killing the visualizer', async () => {
  for (const target of ['//', '///', '//?x=1']) {
    const dir = mkdtempSync(join(tmpdir(), 'visualizer-raw-target-'))
    let server
    try {
      server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'))
      const host = new URL(server.base).host
      const hostile = await rawRequest({ port: Number(new URL(server.base).port), requestLine: `GET ${target} HTTP/1.1`, headers: [`Host: ${host}`, 'connection: close'] })
      assert.equal(rawStatus(hostile), 400)
      const after = await rawRequest({ port: Number(new URL(server.base).port), requestLine: 'GET /api/health HTTP/1.1', headers: [`Host: ${host}`, 'connection: close'] })
      assert.equal(rawStatus(after), 200)
      assert.equal(server.child.exitCode, null)
    } finally {
      if (server) await stopServer(server.child)
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const WRITE_ROUTES = [
  { path: '/api/agents/propose', body: JSON.stringify({ role: 'builder', field: 'model', value: 'example/model' }) },
]

test('state-writing routes refuse CORS simple requests before reading the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cors-simple-'))
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  let server
  try {
    server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'), null, null, { DEVTEAM_VIZ_CHECKOUT: checkout })
    const port = Number(new URL(server.base).port)
    for (const route of WRITE_ROUTES) {
      const response = await rawRequest({
        port,
        requestLine: `POST ${route.path} HTTP/1.1`,
        headers: [`Host: 127.0.0.1:${port}`, 'content-type: text/plain;charset=UTF-8', 'Origin: https://evil.example', `content-length: ${Buffer.byteLength(route.body)}`, 'connection: close'],
        body: route.body,
      })
      assert.equal(rawStatus(response), 415)
    }
    assert.equal(existsSync(join(checkout, '.factory', 'STOP')), false)
  } finally {
    if (server) await stopServer(server.child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the visualizer CLI announces a port through a symlinked repository path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-symlink-'))
  const link = join(dir, 'repo-link')
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  symlinkSync(ROOT, link)
  const child = spawnProcess(process.execPath, [join(link, 'visualizer/server/server.mjs'), '--port', '0', '--checkout', checkout], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  try {
    const base = await announce(child)
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(child.exitCode, null)
  } finally {
    if (child.exitCode === null) await stopServer(child)
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

test('viz-port-env-door — DEVTEAM_VIZ_PORT=0 binds an ephemeral port and an absent value keeps 4488', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-port-env-'))
  const ledgerDb = join(dir, 'ledger.db')
  let child
  try {
    child = spawnProcess(process.execPath, [SERVER_SCRIPT], { cwd: ROOT,
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
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', env, timeout: 20000, killSignal: 'SIGKILL' })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal(result.stdout.trim(), '4488')
  } finally {
    if (child) await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('static responses refuse symlinks that leave web/dist', async () => {
  const dir = scratchDir('visualizer-static-outside-')
  const outside = join(dir, 'outside.txt')
  const dist = join(ROOT, 'visualizer', 'web', 'dist')
  const madeDist = !existsSync(dist)
  const leakPath = join(dist, `b288-symlink-${process.pid}-${Date.now()}.txt`)
  writeFileSync(outside, 'B288-SYMLINK-ESCAPED-CONTENT')
  let child, base
  if (madeDist) mkdirSync(dist, { recursive: true })
  try {
    symlinkSync(outside, leakPath);
    ({ child, base } = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db')))
    const response = await fetch(`${base}/${leakPath.slice(dist.length + 1)}`)
    const text = await response.text()
    assert.equal(response.status, 404)
    assert.doesNotMatch(text, /B288-SYMLINK-ESCAPED-CONTENT/)
  } finally {
    if (child) await stopServer(child)
    rmSync(leakPath, { force: true })
    if (madeDist) rmSync(dist, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

const TEST_GITHUB_API_URL = process.env.TEST_GITHUB_API_URL || 'fixture-invalid://github'
// MUTATION: add a `pluginWriteRefusal` 409 to the propose, stage or compose route; proposals write
// nothing, so an installed plugin must still answer 200 there and this test reddens.
test('RO1 link-mode install target refuses writes', () => {
  const home = '/tmp/link-home'
  const cache = join(home, '.claude', 'plugins', 'cache')
  const dirs = new Map([[cache, ['m']], [join(cache, 'm'), ['p']], [join(cache, 'm', 'p'), ['1.0.0']], [join(cache, 'm', 'p', '1.0.0'), ['.claude-plugin-link']]])
  const marker = JSON.stringify({target: '/tmp/checkout'})
  const fakeReaddir = (p) => { if (dirs.has(p)) return dirs.get(p); const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return marker; throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => p
  assert.deepEqual(pluginWriteMode({pluginRoot: '/tmp/checkout', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead}), {
    writable: false, reason: 'installed-plugin-read-only', basis: 'link-mode-install-target', plugin_root: '/tmp/checkout'
  })
})

test('pluginWriteTargetMode refuses plugin cache and link targets', () => {
  const home = '/tmp/target-home'
  const cache = join(home, '.claude', 'plugins', 'cache')
  const dirs = new Map([[cache, ['m']], [join(cache, 'm'), ['p']], [join(cache, 'm', 'p'), ['1.0.0']], [join(cache, 'm', 'p', '1.0.0'), ['.claude-plugin-link']]])
  const marker = JSON.stringify({target: '/tmp/link-target'})
  const fakeReaddir = (p) => { if (dirs.has(p)) return dirs.get(p); const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return marker; throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => p
  const cached = pluginWriteTargetMode({target: join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0', '.env.local'), home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead})
  assert.equal(cached.writable, false)
  assert.equal(cached.basis, 'under-claude-plugins-dir')
  const linked = pluginWriteTargetMode({target: '/tmp/link-target/crew/roster.json', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead})
  assert.equal(linked.writable, false)
  assert.equal(linked.basis, 'link-mode-install-target')
  const ordinary = pluginWriteTargetMode({target: '/tmp/ordinary-checkout/crew/roster.json', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead})
  assert.equal(ordinary.writable, true)
  assert.equal(ordinary.basis, null)
  const badMarker = '{bad json'
  const badRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return badMarker; throw new Error('ENOENT ' + p) }
  const malformed = pluginWriteTargetMode({target: '/tmp/ordinary-checkout/crew/roster.json', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: badRead})
  assert.equal(malformed.writable, false)
  assert.equal(malformed.basis, 'link-mode-marker-unreadable')
  const symlinkRealpath = (p) => { if (p === '/tmp/checkout') return join(home, '.claude', 'plugins', 'store'); if (String(p).startsWith('/tmp/checkout/')) return String(p).replace('/tmp/checkout', join(home, '.claude', 'plugins', 'store')); return p }
  const emptyReaddir = (p) => { const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const emptyRead = (p) => { throw new Error('ENOENT ' + p) }
  const symlinked = pluginWriteTargetMode({target: '/tmp/checkout/crew/roster.json', home, existsSync: fakeExists, realpathSync: symlinkRealpath, readdirSync: emptyReaddir, readFileSync: emptyRead})
  assert.equal(symlinked.writable, false)
  assert.equal(symlinked.basis, 'under-claude-plugins-dir')
})

test('VL6 writeGuard refuses non-loopback peers and admits loopback spellings', () => {
  const req = (remoteAddress, host = '127.0.0.1:4488') => ({ headers: { 'content-type': 'application/json', host }, socket: { localPort: 4488, ...(remoteAddress === undefined ? {} : { remoteAddress }) } })
  const lan = writeGuard(req('192.168.1.9'))
  assert.equal(lan.status, 403)
  assert.match(String(lan.error), /peer/)
  assert.equal(String(lan.error).includes('192.168.1.9'), true)
  assert.equal(writeGuard(req(undefined)).status, 403)
  assert.equal(writeGuard(req('not-an-ip')).status, 403)
  for (const [addr, host] of [['127.0.0.1', '127.0.0.1:4488'], ['127.5.6.7', '127.0.0.1:4488'], ['::1', '[::1]:4488'], ['::ffff:127.0.0.1', '127.0.0.1:4488']]) {
    assert.equal(writeGuard(req(addr, host)), null)
  }
})

test('GR2 host guard accepts loopback on the matching port', () => {
  // MUTATION GR2: removing loopback membership accepts evil.example on the matching port.
  const accepted = ['127.0.0.1:4488', 'localhost:4488', '[::1]:4488']
  for (const host of accepted) {
    assert.equal(hostGuard({ headers: { host }, socket: { localPort: 4488 } }, 'read'), null, host)
  }
  const refused = [
    ['evil.example:4488', 4488],
    ['localhost:9999', 4488],
    [undefined, 4488],
    ['', 4488],
    ['a:b:c', 4488],
    ['localhost', 4488],
  ]
  for (const [host, localPort] of refused) {
    const actual = hostGuard({ headers: { host }, socket: { localPort } }, 'read')
    assert.deepEqual(actual, { status: 403, error: `read host refused: ${host}` }, String(host))
  }
  assert.equal(hostGuard({ headers: { host: 'localhost' }, socket: { localPort: 80 } }, 'read'), null)
})

test('GR3 API HEAD requests enforce the host guard without bodies', async () => {
  // MUTATION GR3: bypassing the shared guard for HEAD lets a hostile HEAD request escape.
  const dir = scratchDir('visualizer-api-host-head-')
  let server
  try {
    server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'))
    const port = Number(new URL(server.base).port)
    const hostile = await rawRequest({ port, requestLine: 'HEAD /api/journal HTTP/1.1', headers: [`Host: evil.example:${port}`, 'connection: close'] })
    assert.equal(rawStatus(hostile), 403)
    assert.equal(hostile.text.split('\r\n\r\n', 2)[1] || '', '')

    const legitimate = await rawRequest({ port, requestLine: 'HEAD /api/journal HTTP/1.1', headers: [`Host: 127.0.0.1:${port}`, 'connection: close'] })
    assert.notEqual(rawStatus(legitimate), 403)
    assert.equal(legitimate.text.split('\r\n\r\n', 2)[1] || '', '')

    const asset = await rawRequest({ port, requestLine: 'GET /not-a-real-asset HTTP/1.1', headers: [`Host: evil.example:${port}`, 'connection: close'] })
    assert.notEqual(rawStatus(asset), 403)
  } finally {
    if (server) await stopServer(server.child)
  }
})

// MUTATION LH3: neutralize the final refusal decision across the complete matrix.
test('LH3 read host guard refuses foreign malformed or unavailable interfaces', () => {
  const source = () => ({ ethernet: [{ address: '192.0.2.23' }, { address: '2001:db8::23' }] })
  const hosts = [
    '192.0.2.99:4488', '[2001:db8::99]:4488',
    '192.0.2.23:9999', '[2001:db8::23]:9999', '192.0.2.23',
    'mac.local:4488', 'evil.example:4488',
    '0xc0000217:4488', '3221226007:4488',
    'user@192.0.2.23:4488', '192.0.2.23:4488/path',
  ]
  const refusal = host => ({ status: 403, error: `read host refused: ${host}` })
  const actual = hosts.map(host => hostGuard({ headers: { host }, socket: { localPort: 4488 } }, 'read', source))
  const expected = hosts.map(refusal)
  for (const source of [() => ({}), () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }]) {
    actual.push(hostGuard({ headers: { host: '192.0.2.23:4488' }, socket: { localPort: 4488 } }, 'read', source))
    expected.push(refusal('192.0.2.23:4488'))
  }
  assert.deepEqual(actual, expected)
})

const DROPPED_ROUTES = ['/api/agents', '/api/returns', '/api/roster', '/api/roster/pick', '/api/roster/propose', '/api/roster/agent/propose', '/api/roster/ladder', '/api/roster/ladder/stage', '/api/roster/ladder/compose', '/api/roster/ladder/apply',
  '/api/workflows', '/api/workflows/propose', '/api/workflows/editor', '/api/workflows/save', '/api/workflows/library', '/api/workflows/preview', '/api/prepared-tasks', '/api/assurances', '/api/assurances/preview', '/api/assurances/propose',
  '/api/model-catalog', '/api/model-catalog/key', '/api/skills/propose', '/api/prompts/propose', '/api/prompt-library', '/api/prompt-library/preview', '/api/prompt-library/save', '/api/cell-health', '/api/run-set', '/api/intake', '/api/intake/brake', '/api/seat-teardowns', '/api/cell-attribution', '/api/triage']

function leanLane(crewRoot, id, rows = [{ event: 'run-start', at: Date.now() }, { event: 'stage-start', stage: 'plan' }]) {
  const laneDir = join(crewRoot, `dt-${id}`, id)
  mkdirSync(join(laneDir, 'task'), { recursive: true })
  writeFileSync(join(laneDir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' }, builder: { agent: 'pi' } } }))
  writeFileSync(join(laneDir, 'task', 'lean.json'), JSON.stringify({ id, tier: 'build' }))
  writeFileSync(join(laneDir, 'task', 'journal.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

// MUTATION: re-add '/api/prompts/propose': [] to ROUTE_PARAMS
test('route tombstones: every removed server.mjs route is unregistered and has no handler', async () => {
  for (const route of DROPPED_ROUTES) assert.equal(Object.hasOwn(ROUTE_PARAMS, route), false, `${route} must not be in ROUTE_PARAMS`)
  for (const name of ['model-catalog.mjs', 'openrouter-catalog.mjs', 'model-directory.mjs', 'local-env.mjs']) assert.equal(existsSync(join(ROOT, 'visualizer/server', name)), false, name)
  for (const route of ['/api/sessions', '/api/events', '/api/journal', '/api/seat-sessions', '/api/agents/propose', '/api/agent-library', '/api/skill-library', '/api/health', '/api/plugin-write-mode']) assert.ok(Object.hasOwn(ROUTE_PARAMS, route), `${route} stays`)
  const crewRoot = scratchDir('visualizer-dropped-routes-')
  let started
  try {
    started = await startInProcess({}, { crewRoot })
    const returnsWithIdentity = await json(started.base, '/api/returns?repo_slug=repo&task_slug=task&adw_id=old')
    assert.equal(returnsWithIdentity.status, 404)
    for (const route of DROPPED_ROUTES) {
      const get = await json(started.base, route)
      assert.equal(get.status, 404, `GET ${route}`)
      const post = await json(started.base, route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(post.status, 405, `POST ${route}`)
      assert.equal(post.allow, 'GET', `POST ${route} allow`)
    }
  } finally {
    await stopInProcess(started?.server)
    rmSync(crewRoot, { recursive: true, force: true })
  }
})

test('/api/sessions validates and canonicalises its optional window', async () => {
  let started
  try {
    started = await startInProcess({}, { lean: { listRuns: (filters) => [{ adw_id: 'lean:w', filters }] } })
    const ok = await json(started.base, '/api/sessions?since=2026-01-01T00:00:00%2B01:00&until=')
    assert.equal(ok.status, 200)
    assert.equal(ok.json.runs[0].filters.since, '2025-12-31T23:00:00.000Z')
    assert.equal((await json(started.base, '/api/sessions?since=2026')).status, 400)
    assert.equal((await json(started.base, '/api/sessions?since=2026-02-01T00:00:00.000Z&until=2026-01-01T00:00:00.000Z')).status, 400)
    assert.equal((await json(started.base, '/api/sessions?bogus=1')).status, 400)
  } finally {
    await stopInProcess(started?.server)
  }
})

test('/api/events serves a lean lane from its journal and states absence for a non-lean lane', async () => {
  const crewRoot = scratchDir('visualizer-lean-events-')
  let started
  try {
    leanLane(crewRoot, 'evlane')
    started = await startInProcess({}, { crewRoot })
    const lean = await json(started.base, '/api/events?adw_id=lean:evlane')
    assert.equal(lean.status, 200)
    assert.equal(lean.json.degraded, false)
    assert.deepEqual(lean.json.events.map((event) => event.type), ['run-start', 'stage-start'])
    const ledger = await json(started.base, '/api/events?adw_id=0123-ledger-run')
    assert.equal(ledger.status, 200)
    assert.deepEqual(ledger.json.events, [])
    assert.equal(ledger.json.degraded, true)
    assert.match(ledger.json.absent, /ledger event source removed/)
    assert.equal((await json(started.base, '/api/events?adw_id=lean:evlane&after=99999999999999999999')).status, 400)
  } finally {
    await stopInProcess(started?.server)
    rmSync(crewRoot, { recursive: true, force: true })
  }
})

test('VC1 visualizer server imports only admitted crew modules and pins run-pid dependencies', () => {
  const allowed = new Set(['crew/protocols.mjs', 'crew/agents.mjs', 'crew/lean-source.mjs'])
  const bad = []
  for (const name of readdirSync(join(ROOT, 'visualizer/server')).filter((file) => file.endsWith('.mjs'))) {
    const source = readFileSync(join(ROOT, 'visualizer/server', name), 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = join('visualizer/server', match[1]).split('\\').join('/')
      if ((target.startsWith('crew/') || target.startsWith('scripts/')) && !allowed.has(target)) bad.push(`${name} -> ${match[1]}`)
    }
  }
  assert.deepEqual(bad, [])
  const imports = (path) => [...readFileSync(join(ROOT, path), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  const pidImports = imports('crew/run-pid.mjs')
  assert.ok(pidImports.includes('./lean-journal-order.mjs'))
  assert.deepEqual(pidImports.filter((path) => !path.startsWith('node:')), ['./lean-journal-order.mjs'])
  assert.deepEqual(imports('crew/lean-journal-order.mjs'), [])
})

test('VC2 nothing under crew/ or bin/ imports from visualizer/ and the lean modules live in crew/', () => {
  function walk(dir) {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = posix.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return entry.isFile() && path.endsWith('.mjs') ? [path] : []
    })
  }
  const bad = []
  for (const path of [...walk('crew'), ...walk('bin')]) {
    const source = readFileSync(join(ROOT, path), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)) {
      if (posix.join(dirname(path), match[1]).startsWith('visualizer/')) bad.push(`${path} -> ${match[1]}`)
    }
  }
  assert.deepEqual(bad, [])
  for (const name of ['lean-source.mjs', 'lean-journal-order.mjs']) {
    assert.equal(existsSync(join(ROOT, 'visualizer/server', name)), false)
    assert.equal(existsSync(join(ROOT, 'crew', name)), true)
  }
  const source = readFileSync(join(ROOT, 'crew/lean-source.mjs'), 'utf8')
  assert.match(source, /import\s*\{[^}]*\bwithin\b[^}]*\}\s*from\s*'\.\/lane-core\.mjs'/)
  assert.match(source, /import\s*\{[^}]*\bisObject\b[^}]*\}\s*from\s*'\.\/lane-core\.mjs'/)
  assert.doesNotMatch(source, /function\s+within\s*\(/)
  assert.doesNotMatch(source, /const\s+isObject\s*=/)
})

test('AE1 /api/agents/propose proposes a crew/agents frontmatter edit over HTTP and writes nothing', async () => {
  const dir = scratchDir('visualizer-agent-edit-')
  const checkout = join(dir, 'checkout')
  mkdirSync(join(checkout, 'crew', 'agents'), { recursive: true })
  const agentText = readFileSync(join(ROOT, 'crew/agents/builder.md'), 'utf8')
  const agentFile = join(checkout, 'crew/agents/builder.md')
  writeFileSync(agentFile, agentText)
  let server
  try {
    server = await startInProcess({}, { checkout })
    const post = (body) => json(server.base, '/api/agents/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const base = await post({ role: 'builder', field: 'effort', value: 'max' })
    assert.equal(base.status, 200)
    assert.equal(base.json.proposal, 'agent-edit'); assert.equal(base.json.ok, true); assert.equal(base.json.agent_path, 'crew/agents/builder.md')
    assert.match(base.json.diff, /^-effort: high$/m); assert.match(base.json.diff, /^\+effort: max$/m)
    assert.equal(Object.hasOwn(base.json, 'afterText'), false)
    const tier = await post({ role: 'builder', tier: 'judge', field: 'model', value: 'anthropic/claude-opus-5' })
    assert.equal(tier.json.ok, true); assert.match(tier.json.diff, /^\+tiers: .*"model":"anthropic\/claude-opus-5"/m)
    const cleared = await post({ role: 'builder', tier: 'judge', field: 'effort', value: null })
    assert.equal(cleared.json.ok, true); assert.match(cleared.json.diff, /^-tiers: /m)
    const refused = await post({ role: 'nobody', field: 'effort', value: 'max' })
    assert.equal(refused.status, 200); assert.equal(refused.json.ok, false); assert.equal(refused.json.diff, null); assert.equal(refused.json.refusals[0].code, 'unknown_role')
    assert.equal((await post({ role: 'builder', field: 'name', value: 'x' })).json.refusals[0].code, 'unknown_field')
    assert.equal((await post({ role: 'builder', field: 'effort' })).status, 400)
    assert.equal((await post({ role: 'builder', field: 'effort', value: 'max', name: 'x' })).status, 400)
    assert.equal((await post({ role: 'builder', field: 'effort', value: 7 })).status, 400)
    assert.equal((await post({ name: 'future-agent', entry: { providers: ['openai'], transports: ['acp'], adapter: 'crew/adapters/adapter-future-agent.mjs', refuses: [], availability: 'proposal-stub' } })).status, 400)
    assert.equal(readFileSync(agentFile, 'utf8'), agentText)
  } finally {
    await stopInProcess(server)
    rmSync(dir, { recursive: true, force: true })
  }
})
